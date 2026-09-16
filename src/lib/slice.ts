/**
 * Narrowing a design down to what the agent is about to build.
 *
 * The slicing happens **here, in this process**, not on the server — and that is the point rather
 * than an implementation convenience. Narrow is about the *model's* context window, not about
 * bytes on a socket: the process fetches one design and caches it, and each slice costs nothing
 * but keeps eleven components the agent is not touching out of its prompt.
 *
 * A component's edges come back in both directions. The design orients an edge by data flow; an
 * agent implementing a service needs to know who calls it just as much as what it calls, and
 * handing it only the outgoing half would be a quiet half-truth.
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
    /**
     * Ledger rows whose `cited_by_components` names this component — the server's cited-by, in the
     * order they are printed.
     *
     * Absent, rather than empty, when the version carries no ledger. "This version records no
     * requirements" and "the requirements it records name other components" are different answers,
     * and a caller that cannot tell them apart reports the first as the second.
     */
    cited_requirements?: RequirementLedgerRow[]
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
    return {
        component,
        outgoing: connections.filter((c) => c.source === component.id),
        incoming: connections.filter((c) => c.target === component.id),
        related_decisions: relatedDecisions(design, component),
        ...(ledger ? { cited_requirements: citedRequirements(ledger, component.id) } : {}),
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
 * `unmet` and `uncited` first: those are the two that ask the reader to do something.
 *
 * Inside a group the server's own order is kept, which is R-number order — a stable sort gives that
 * for free, and re-deriving the number from the id would mean guessing at a format the server owns.
 *
 * A status this package does not recognise sorts last and is printed as it arrived. `status` is
 * typed as a string precisely so a value added server-side does not stop an older connector parsing
 * the row; folding an unrecognised one in with `cited` would turn that leniency into a false
 * all-clear.
 */
const STATUS_ORDER = ['unmet', 'uncited', 'unchecked', 'cited']

export function orderRequirementRows(rows: RequirementLedgerRow[]): RequirementLedgerRow[] {
    return [...rows].sort((a, b) => statusRank(a) - statusRank(b))
}

function statusRank(row: RequirementLedgerRow): number {
    const index = STATUS_ORDER.indexOf(row.status ?? '')
    return index === -1 ? STATUS_ORDER.length : index
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
    const seen = new Set<string>()
    const out: string[] = []
    const push = (text: string | undefined): void => {
        if (typeof text !== 'string') return
        const trimmed = text.trim()
        // Deduped on the exact text, which is the only identity two lists of free-form sentences
        // share. Two decisions phrased differently are two decisions, and merging them would be a
        // judgement this package has no standing to make.
        if (trimmed.length === 0 || seen.has(trimmed)) return
        seen.add(trimmed)
        out.push(trimmed)
    }

    for (const decision of design.design_decisions ?? []) push(decision)
    for (const decision of design.grounded_decisions ?? []) push(decision?.text)
    return out
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
    trade_offs: string[]
    requirement_ledger?: RequirementLedger
} {
    return {
        title: design.title ?? 'Untitled design',
        description: design.description ?? '',
        components: design.components ?? [],
        connections: design.connections ?? [],
        design_decisions: decisionTexts(design),
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
