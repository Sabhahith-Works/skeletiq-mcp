/**
 * Narrowing a design down to what the agent is about to build.
 *
 * The slicing happens **here, in this process**, not on the server — and that is the point rather
 * than an implementation convenience. Narrow is about the *model's* context window, not about
 * bytes on a socket: the process fetches one design and caches it, and each slice costs nothing
 * but keeps eleven components the agent is not touching out of its prompt.
 *
 * A component's edges come back in both directions. The design orients an edge from caller to
 * callee — the source calls the target, the same reading `build_order` states — and an agent
 * implementing a service needs to know who calls it just as much as what it calls, so handing it
 * only the outgoing half would be a quiet half-truth.
 */

import type {
    ArchitectureJson,
    Component,
    Connection,
    RequirementLedger,
    RequirementLedgerRow,
} from '../wire/schemas.js'

export interface ComponentSlice {
    component: Component
    /** Edges where this component is the source. */
    outgoing: Connection[]
    /** Edges where this component is the target. */
    incoming: Connection[]
    /** Design decisions that name this component or its technology, best-effort. */
    related_decisions: string[]
    /** The entries of `related_decisions` the design marks as resting on no cited source. */
    assumed_decisions: string[]
    /**
     * Ledger rows whose `cited_by_components` names this component — the server's cited-by, in the
     * order they are printed.
     *
     * Absent, rather than empty, when the version carries no ledger. "This version records no
     * requirements" and "the requirements it records name other components" are different answers,
     * and a caller that cannot tell them apart reports the first as the second.
     */
    cited_requirements?: RequirementLedgerRow[]
    /**
     * Rows this component still cites that are **no longer requirements** — a person removed one,
     * or an older analysis had recorded an instruction as one.
     *
     * The component's own `requirement_ids` keep naming them: nothing rewrites a saved design when
     * a requirement is withdrawn, and nothing should. Without this they would drop out of the
     * answer in silence, and an agent reading the component's raw `requirement_ids` would be back
     * to holding a bare `R7` with nowhere to look it up — the exact gap the ledger closed.
     *
     * Absent, rather than empty, when the version carries no ledger, for the reason above.
     */
    withdrawn_requirements?: RequirementLedgerRow[]
}

/**
 * The ledger arrives as a third argument rather than being read off `design`, because it is not in
 * there: it is a derived block the API computes and hangs on the architecture *record*, beside
 * `architecture_json`. `architecture_json` is echoed back on every canvas save, so a ledger stored
 * inside it would be re-persisted stale by construction.
 *
 * Widening this to take the whole record instead would make a function that slices a payload take a
 * database row, and every caller would have to hold one to ask about a component.
 */
export function sliceComponent(
    design: ArchitectureJson,
    componentId: string,
    ledger?: RequirementLedger | null,
): ComponentSlice | null {
    const components = design.components ?? []
    const component =
        components.find((c) => c.id === componentId) ??
        components.find((c) => normalize(c.name) === normalize(componentId))
    if (!component) return null

    const connections = design.connections ?? []
    const related = relatedDecisions(design, component)
    return {
        component,
        outgoing: connections.filter((c) => c.source === component.id),
        incoming: connections.filter((c) => c.target === component.id),
        related_decisions: related,
        assumed_decisions: assumedAmong(design, related),
        ...(ledger
            ? {
                cited_requirements: citedRequirements(ledger, component.id),
                withdrawn_requirements: withdrawnRequirements(ledger, component.id),
            }
            : {}),
    }
}

/**
 * The requirements the design cites this component against — the server's answer, never a second one.
 *
 * A component carries its own `requirement_ids`, and reading those would be the obvious shortcut. It
 * would also be a second derivation of the same relationship, free to disagree with the first: the
 * ledger is computed server-side from the saved payload — the components *and* the grounded
 * decisions — so two readers of one version could report different coverage and neither would be
 * wrong about what it read. Where there is an authority, this package reads it.
 */
function citedRequirements(ledger: RequirementLedger, componentId: string): RequirementLedgerRow[] {
    return orderRequirementRows(
        (ledger.rows ?? []).filter((row) => (row.cited_by_components ?? []).includes(componentId)),
    )
}

/**
 * The ids this component cites that the version no longer holds as requirements.
 *
 * Both lists, and kept in one: `removed` is a person saying "that is not a requirement" and
 * `superseded` is an older analysis having recorded an instruction as one. From this component's
 * side they are the same fact — the id is on the box and it is not a requirement — and the row
 * itself carries which. Read off the server's lists for the reason `citedRequirements` gives: the
 * component's own `requirement_ids` would be a second derivation, free to disagree.
 *
 * Not sorted by verdict: these rank on nothing a reader has to act on, and the server's R-order is
 * the one a person reading the design already has in their head.
 */
function withdrawnRequirements(ledger: RequirementLedger, componentId: string): RequirementLedgerRow[] {
    return [...(ledger.removed ?? []), ...(ledger.superseded ?? [])].filter((row) =>
        (row.cited_by_components ?? []).includes(componentId),
    )
}

/**
 * What needs doing first: a check measured the design as not meeting it, then a model check doubts
 * it, then nothing cites it, then nobody checked. Those are the four that ask the reader to do
 * something.
 *
 * Ordered on `verdict` since 0.3.0, which is what the row is actually printed with. A server that
 * predates the verdict still sends `status`, and its word is ranked through the same table — the
 * two vocabularies rank to the same three tiers, so an older server sorts exactly as it always did.
 *
 * Inside a group the server's own order is kept, which is R-number order — a stable sort gives that
 * for free, and re-deriving the number from the id would mean guessing at a format the server owns.
 *
 * A value this package does not recognise sorts last and is printed as it arrived. `verdict` is
 * typed as a string precisely so a value added server-side does not stop an older connector parsing
 * the row; folding an unrecognised one in with the settled ones would turn that leniency into a
 * false all-clear.
 */
const VERDICT_ORDER = ['fails', 'unmet', 'not_checked', 'not_checkable', 'unchecked', 'no_gap_found', 'passes', 'cited']

/** Whether anything in the design — a component or a decision — claims to address this row. */
export function isCitedRequirement(row: RequirementLedgerRow): boolean {
    return (row.cited_by_components?.length ?? 0) > 0 || (row.cited_by_decisions?.length ?? 0) > 0
}

/**
 * The check whose `fails` only says nothing cites the line: "Nothing in the design cites it."
 *
 * Not a measurement of the design. The server stopped counting it as a failure in the handoff
 * gate (`requirement_blocks_handoff`, `services/handoff/blocking.py`), so printing it as `fails`
 * here told an agent a check had measured a gap that readiness and To do do not count -- and an
 * agent told a line fails adds a part for it.
 */
const CITATION_ONLY_METHOD = 'structure'

/**
 * The checks whose `fails` is a measurement — capacity, cost, the review's rules — and so the only
 * ones that hold a handoff back. Read only for a server that predates `blocks_handoff`; the server's
 * own set is the authority, and SkeletIQ's API tests pin this copy to it.
 */
const MEASURED_METHODS = ['simulation', 'cost', 'rules']

/**
 * The word for a `fails` that does not block because nothing measured it, keyed by the server's
 * `unconfirmed_reason`. A reason this package does not know prints as plain `unconfirmed`, never as
 * a `fails` — the server has already said it does not block.
 */
const UNCONFIRMED_WORDS: Record<string, string> = {
    model_check: 'unconfirmed (model check)',
    unstated_input: 'unconfirmed (unstated split)',
}

/**
 * The clause an `unstated_input` row carries when the input nobody gave is the load itself: nobody
 * said how much traffic to expect, so the design was sized and priced on a typical one. The server
 * writes it verbatim, and SkeletIQ's API tests pin this copy to it; any other clause is a split.
 */
export const ASSUMED_LOAD_INPUT = 'the load, which was assumed'
const ASSUMED_LOAD_WORD = 'unconfirmed (assumed load)'

/** What an agent is told to do with an unconfirmed line, printed beside it. */
export const UNCONFIRMED_ADVICE = 'verify before building for it'

/**
 * Whether this row holds a handoff back: the server's `blocks_handoff` when it sends one, otherwise
 * a `fails` from a measured check. A model check's `fails`, a citation-only one, and one with no
 * method recorded do not block — an older server counted them, and the product no longer does.
 */
export function requirementBlocksHandoff(row: RequirementLedgerRow): boolean {
    if (typeof row.blocks_handoff === 'boolean') return row.blocks_handoff
    return (row.verdict ?? '').trim() === 'fails' && MEASURED_METHODS.includes((row.check_method ?? '').trim())
}

/**
 * The verdict a row is printed and counted with: the server's word, with two exceptions for a
 * `fails` that does not block a handoff. One whose only finding is the missing citation reads as no
 * verdict at all — that row is `cited by nothing`, which the listing already says. One only a model
 * check reached reads `unconfirmed (model check)`: a model's opinion, not a measurement. A server
 * older than `verdict` sends `status`, read as it always was.
 */
export function requirementVerdict(row: RequirementLedgerRow): string {
    const verdict = (row.verdict ?? row.status ?? '').trim()
    if (verdict !== 'fails' || requirementBlocksHandoff(row)) return verdict
    const method = (row.check_method ?? '').trim()
    if (method === CITATION_ONLY_METHOD) return ''
    // An older server sends no reason; its non-blocking `fails` can only be the model check's.
    const reason = row.unconfirmed_reason ?? 'model_check'
    if (reason === 'unstated_input' && row.unstated_input?.trim() === ASSUMED_LOAD_INPUT) return ASSUMED_LOAD_WORD
    return UNCONFIRMED_WORDS[reason] ?? 'unconfirmed'
}

/** Whether the row is a `fails` that nothing measured — see `requirementVerdict`. */
export function isUnconfirmedRequirement(row: RequirementLedgerRow): boolean {
    return requirementVerdict(row).startsWith('unconfirmed')
}

export function orderRequirementRows(rows: RequirementLedgerRow[]): RequirementLedgerRow[] {
    return [...rows].sort((a, b) => verdictRank(a) - verdictRank(b))
}

function verdictRank(row: RequirementLedgerRow): number {
    const verdict = requirementVerdict(row)
    if (verdict === 'fails' || verdict === 'unmet') return 0
    // Next, a line a model check doubts: nothing measured it, but it is the next thing to verify.
    if (isUnconfirmedRequirement(row)) return 1
    // Ranked here rather than in the table: "nothing cites it" is not a verdict, and since 0.3.0
    // it is read off the citations instead of borrowing the `uncited` status word. It still sorts
    // early — a requirement nothing claims to address is the next thing worth looking at.
    if (!isCitedRequirement(row)) return 2
    const index = VERDICT_ORDER.indexOf(verdict)
    return index === -1 ? VERDICT_ORDER.length + 2 : index + 3
}

/**
 * Every decision in the design, as text, from both of the lists the server keeps.
 *
 * A design carries `design_decisions` (plain strings) and `grounded_decisions` (the same statement
 * with the requirements and sources behind it), and which one is populated depends on when and how
 * the design was generated. Most designs stored today hold *only* the grounded list, so reading the
 * legacy one alone reports a design built for no stated reason — the design's own reasoning, thrown
 * away in front of the agent about to implement it.
 *
 * Union rather than preference, because on the designs that carry both the two lists say different
 * things: their text sets were measured and never coincide. Taking one would drop real content;
 * taking both, deduped, cannot. Order is legacy-first, then grounded, each in the order the design
 * states them — the design's own sequence is the only ordering anyone has a claim on.
 */
export function decisionTexts(design: ArchitectureJson): string[] {
    return decisionEntries(design).map((entry) => entry.text)
}

/** One decision the design states, and whether the design marks it as resting on no cited source. */
export interface DecisionEntry {
    text: string
    assumption: boolean
}

/**
 * The union `decisionTexts` describes, with each decision's `assumption` flag carried alongside.
 *
 * A grounded decision says `assumption: true` when the design could cite nothing for it. Reading
 * every decision as settled told an agent to build to a choice the design itself had flagged as a
 * guess. A text is an assumption when **any** grounded copy of it says so: the legacy list carries
 * no flag at all, so its silence is not a claim that the decision is sourced.
 */
export function decisionEntries(design: ArchitectureJson): DecisionEntry[] {
    const byText = new Map<string, DecisionEntry>()
    const out: DecisionEntry[] = []
    const push = (text: string | undefined, assumption: boolean): void => {
        if (typeof text !== 'string') return
        const trimmed = text.trim()
        if (trimmed.length === 0) return
        // Deduped on the exact text, which is the only identity two lists of free-form sentences
        // share. Two decisions phrased differently are two decisions, and merging them would be a
        // judgement this package has no standing to make.
        const existing = byText.get(trimmed)
        if (existing) {
            existing.assumption = existing.assumption || assumption
            return
        }
        const entry = { text: trimmed, assumption }
        byText.set(trimmed, entry)
        out.push(entry)
    }

    for (const decision of design.design_decisions ?? []) push(decision, false)
    for (const decision of design.grounded_decisions ?? []) push(decision?.text, decision?.assumption === true)
    return out
}

/** The members of `texts` the design marks as assumptions, in the order given. */
function assumedAmong(design: ArchitectureJson, texts: string[]): string[] {
    const assumed = new Set(
        decisionEntries(design)
            .filter((entry) => entry.assumption)
            .map((entry) => entry.text),
    )
    return texts.filter((text) => assumed.has(text))
}

/**
 * Decisions arrive as free text and, on the wire, name no component: `grounded_decisions` links a
 * decision to the *requirements* it serves, which is not the same relationship. So this stays a name
 * match, and stays labelled as *related* rather than as *the* decisions for this component. Matching
 * on the name and the technology catches the two ways a decision actually refers to a box ("the API
 * gateway will…", "we chose Redis because…") without inventing a relationship the design never
 * stated.
 */
function relatedDecisions(design: ArchitectureJson, component: Component): string[] {
    const needles = [component.name, component.technology]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 2)
        .map((value) => value.toLowerCase())
    if (needles.length === 0) return []

    return decisionTexts(design).filter((decision) => {
        const haystack = decision.toLowerCase()
        return needles.some((needle) => haystack.includes(needle))
    })
}

/**
 * The whole design, minus the analysis blocks an agent has no use for.
 *
 * `design_decisions` here is every decision the design states, from both of the server's lists —
 * see `decisionTexts`. The key keeps its name because it is what the design's decisions *are* to a
 * caller, and renaming it would break every reader for a distinction only the server makes.
 */
export function overview(
    design: ArchitectureJson,
    ledger?: RequirementLedger | null,
): {
    title: string
    description: string
    components: Component[]
    connections: Connection[]
    design_decisions: string[]
    assumed_decisions: string[]
    trade_offs: string[]
    requirement_ledger?: RequirementLedger
} {
    const decisions = decisionTexts(design)
    return {
        title: design.title ?? 'Untitled design',
        description: design.description ?? '',
        components: design.components ?? [],
        connections: design.connections ?? [],
        design_decisions: decisions,
        // A subset of `design_decisions`, not a second list of decisions: which of them the design
        // marks as resting on no cited source. Additive, so `design_decisions` stays the plain
        // strings every existing caller reads.
        assumed_decisions: assumedAmong(design, decisions),
        trade_offs: design.trade_offs ?? [],
        // Carried verbatim, rows in the server's order, and only when the version has one. This is
        // a rebuild from named keys, so anything not named here is dropped without a trace — which
        // is how `grounded_decisions` went missing for two releases. Re-sorting the rows on the way
        // past would make "verbatim" untrue; the grouping belongs to the text that prints them.
        ...(ledger ? { requirement_ledger: ledger } : {}),
    }
}

function normalize(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}
