/**
 * The read surface, collapsed into one tool with seven modes.
 *
 * Seven tools that each read one endpoint would be seven things for a model to choose between when the
 * answer is nearly always "read the design". The mode is the choice, and it is a closed set the
 * agent can see in the schema.
 *
 * `get_design(mode: "brief")` is **a shipped contract, not a naming preference**: the fence the
 * server writes into a repo's AGENTS.md names this exact call as the way to refresh it. Renaming
 * the tool or the mode breaks every brief already sitting in someone's repository.
 */

import * as z from 'zod/v4'

import type { McpServer } from '@modelcontextprotocol/server'

import type { SkeletiqClient } from '../http/client.js'
import { factsFrom, factsFromRelease, type DesignResolver } from '../lib/resolve.js'
import { failure, guard, ok, versionLine } from '../lib/result.js'
import {
    isCitedRequirement,
    isUnconfirmedRequirement,
    orderRequirementRows,
    overview,
    requirementVerdict,
    sliceComponent,
    UNCONFIRMED_ADVICE,
} from '../lib/slice.js'
import {
    BriefSchema,
    BuildOrderSchema,
    DesignGapListSchema,
    ReadinessSchema,
    TodoSchema,
    type RequirementLedger,
    type RequirementLedgerRow,
    type TodoGroup,
    type TodoItem,
} from '../wire/schemas.js'

const MODES = ['overview', 'component', 'brief', 'todo', 'readiness', 'build_order', 'gaps'] as const

const input = z.object({
    project_id: z.string().describe('A SkeletIQ project id, or its exact name.'),
    mode: z
        .enum(MODES)
        .describe(
            'overview: the whole design and, where the version records them, the requirements it was built ' +
                'from with what became of each. ' +
                'component: one component, its connections in both directions (the source calls the target), ' +
                'the decisions that mention it, and the requirements the design cites it for. ' +
                'brief: the fenced markdown block to write into AGENTS.md. ' +
                'todo: everything still to do on this version, one card per problem — what blocks a ' +
                'handoff, what is recommended, and what is waiting to be accepted. ' +
                'readiness: the verdict, gate by gate, on whether this design is worth building yet. ' +
                'build_order: the order to build components in, and why. ' +
                'gaps: the open questions and unconfirmed assumptions in the design.',
        ),
    component_id: z.string().optional().describe('Required for mode "component". The component id, or its name.'),
    version: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('A specific version. Defaults to the latest released version, or the latest version if none is released.'),
})

const output = z.object({
    project_id: z.string(),
    architecture_id: z.string(),
    version: z.number(),
    is_released: z.boolean(),
    newer_release_exists: z.boolean(),
    resolved_by: z.string(),
    mode: z.string(),
    /** Mode-shaped. Deliberately loose: six modes cannot share one strict schema honestly. */
    data: z.unknown(),
})

/**
 * The heading over a list of decisions. Byte-identical to what it always was when nothing in the
 * list is an assumption, so a design with fully sourced decisions reads exactly as before; otherwise
 * it says what the mark means where the mark first appears.
 */
function decisionsHeading(assumed: string[], settled: string, withAssumptions: string): string {
    return assumed.length > 0 ? withAssumptions : settled
}

/**
 * One bullet per decision, with ` (assumption)` on those the design could cite nothing for. Calling
 * every decision settled told an agent to build to a guess the design had already flagged.
 */
function decisionLines(decisions: string[], assumed: string[]): string[] {
    const marked = new Set(assumed)
    return decisions.map((decision) => `- ${decision}${marked.has(decision) ? ' (assumption)' : ''}`)
}

export function registerGetDesign(server: McpServer, client: SkeletiqClient, resolver: DesignResolver): void {
    server.registerTool(
        'get_design',
        {
            title: 'Read a SkeletIQ design',
            description:
                'Read a SkeletIQ architecture. Start with mode "brief" to orient — it returns a fenced ' +
                'block to write into AGENTS.md — then "todo" for what the design still needs, ' +
                '"build_order" for the sequence and "component" for each piece as you build it. Where a version records its requirements, "overview" and ' +
                '"component" also resolve the R-ids the design carries to the requirements they name, and ' +
                'say what became of each. Every answer states ' +
                'which version it came from and whether that version is a release.',
            inputSchema: input,
            outputSchema: output,
            annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
        },
        async ({ project_id, mode, component_id, version }) =>
            guard(async () => {
                const project = await resolver.resolveProject(project_id)
                const resolved = await resolver.resolveVersion(project.id, version)
                const base = {
                    project_id: project.id,
                    architecture_id: resolved.architectureId,
                    mode,
                }

                switch (mode) {
                    case 'overview': {
                        const design = await resolver.design(resolved.architectureId)
                        const data = overview(design.architecture_json, design.requirement_ledger)
                        const facts = factsFrom(resolved)
                        return ok({ ...base, ...facts, data }, [
                            `# ${data.title}`,
                            data.description,
                            '',
                            `${data.components.length} component(s), ${data.connections.length} connection(s).`,
                            ...data.components.map(
                                (c) => `- ${c.id} — ${c.name} (${c.type}${c.technology ? `, ${c.technology}` : ''})`,
                            ),
                            // Above the decisions because the two answer different questions, in
                            // this order: requirements are what was asked for, decisions are how
                            // the design answered.
                            ...requirementBlock(data.requirement_ledger),
                            // The design's own reasoning, which this text used to omit entirely
                            // while carrying it in the structured half — so an agent working from
                            // what it was shown rebuilt every choice from scratch, and could
                            // silently undo one. Said here because it is the answer to "why is it
                            // like this", and the overview is where that gets asked.
                            ...(data.design_decisions.length
                                ? ['', decisionsHeading(data.assumed_decisions,
                                       'Decisions taken — these are settled, build to them:',
                                       'Decisions taken — build to them; confirm the ones marked (assumption) first, they rest on no cited source:'),
                                   ...decisionLines(data.design_decisions, data.assumed_decisions)]
                                : []),
                            ...(data.trade_offs.length
                                ? ['', 'Trade-offs the design accepts:',
                                   ...data.trade_offs.map((tradeOff) => `- ${tradeOff}`)]
                                : []),
                            '',
                            versionLine(facts),
                        ].join('\n'))
                    }

                    case 'component': {
                        if (!component_id) {
                            return failure('mode "component" needs a component_id. Use mode "overview" or "build_order" to see the ids.')
                        }
                        const design = await resolver.design(resolved.architectureId)
                        const slice = sliceComponent(design.architecture_json, component_id, design.requirement_ledger)
                        if (!slice) {
                            const known = (design.architecture_json.components ?? []).map((c) => c.id).join(', ')
                            return failure(
                                `Version ${resolved.version} has no component "${component_id}". ` +
                                    `Component ids are only valid within one version. Known ids: ${known || 'none'}.`,
                            )
                        }
                        const facts = factsFrom(resolved)
                        const { component, incoming, outgoing } = slice
                        return ok({ ...base, ...facts, data: slice }, [
                            `## ${component.name} (${component.id})`,
                            `Type: ${component.type}${component.technology ? ` · ${component.technology}` : ''}`,
                            component.description ?? '',
                            '',
                            outgoing.length
                                ? `Calls: ${outgoing.map((c) => `${c.target}${c.protocol ? ` (${c.protocol})` : ''}`).join(', ')}`
                                : 'Calls nothing.',
                            incoming.length
                                ? `Called by: ${incoming.map((c) => c.source).join(', ')}`
                                : 'Called by nothing in the design.',
                            // Same order as the overview: what was asked for, then how the design
                            // answered.
                            ...requirementsServed(slice.cited_requirements),
                            // Said only when the design still carries the id. A component's
                            // `requirement_ids` are never rewritten when a requirement is
                            // withdrawn, so without this the row would leave the answer in
                            // silence and the id on the box would resolve to nothing again.
                            ...requirementsWithdrawn(slice.withdrawn_requirements),
                            // Labelled, and only when there are any. These bullets used to be
                            // printed bare under "Called by:", so a decision about the component
                            // read as a continuation of its edge list — and a design with no
                            // matching decision printed nothing at all, which reads as a design
                            // with no reasoning rather than as a decision that names other boxes.
                            ...(slice.related_decisions.length
                                ? ['', decisionsHeading(slice.assumed_decisions,
                                       'Decisions that mention it:',
                                       'Decisions that mention it — confirm the ones marked (assumption) first, they rest on no cited source:'),
                                   ...decisionLines(slice.related_decisions, slice.assumed_decisions)]
                                : ['', 'No decision in this design names this component. That is not the same as',
                                   'no reason — use mode "overview" for the design\'s decisions in full.']),
                            '',
                            versionLine(facts),
                        ].join('\n'))
                    }

                    case 'brief': {
                        const body = await client.request<unknown>(`/architectures/${resolved.architectureId}/brief`)
                        const brief = BriefSchema.parse(body)
                        const facts = factsFromRelease(resolved, brief.release)
                        return ok({ ...base, ...facts, data: { markdown: brief.markdown, is_draft: brief.is_draft } }, [
                            'Write the block below into this repository\'s AGENTS.md.',
                            'If a `skeletiq:brief` fence is already there, REPLACE it whole — opening fence to',
                            'closing fence. Never append a second one, and never edit inside it: a refresh',
                            'overwrites the block, so changes made there are lost silently.',
                            brief.is_draft
                                ? 'This design is a DRAFT. It has not been released and can change without notice.'
                                : '',
                            // Said here as well as inside the block, because a model that acts on
                            // this tool response without re-reading the markdown it just wrote to
                            // disk would otherwise never learn it. `check_drift` defaults to "this
                            // repo is the whole design", and a repo implementing part of one gets
                            // every component built elsewhere reported as missing.
                            'If this repository implements only PART of the design, pass `covers` to',
                            'check_drift with just the component ids you are responsible for. The block',
                            'below lists every id under "What this repo covers".',
                            '',
                            brief.markdown,
                            '',
                            versionLine(facts),
                        ].filter(Boolean).join('\n'))
                    }

                    case 'todo': {
                        const body = await client.request<unknown>(`/architectures/${resolved.architectureId}/todo`)
                        const todo = TodoSchema.parse(body)
                        const facts = factsFrom(resolved)
                        const groups = todo.groups ?? []
                        const blocking = groups.find((group) => group.key === 'blocks_handoff')
                        const total = groups.reduce((count, group) => count + group.items.length, 0)
                        return ok({ ...base, ...facts, data: todo }, [
                            total === 0
                                ? 'Nothing is outstanding on this version.'
                                : `${total} thing(s) still to do on this version` +
                                  (blocking?.items.length
                                      ? `, ${blocking.items.length} of which block a handoff:`
                                      : ', none of which block a handoff:'),
                            ...groups.flatMap(todoGroupBlock),
                            // A source that could not be read is stated, never left to look like a
                            // shorter list. An agent acting on "nothing is outstanding" when the
                            // simulation results failed to load is the exact harm this prevents.
                            ...(todo.unavailable_sources?.length
                                ? ['',
                                   'Some of this version could not be read, so the list above is incomplete:',
                                   ...todo.unavailable_sources.map((entry) => `- ${entry.source}: ${entry.reason}`)]
                                : []),
                            '',
                            // The actions are the person's. An agent that "accepts" an assumption
                            // has decided something on their behalf, which is the one thing this
                            // surface must never do — and the server refuses it anyway, because an
                            // agent token reaches no write route.
                            'Fix what you can in the design. Answering, accepting and dismissing are the ' +
                                "person's to do — ask, do not decide for them.",
                            versionLine(facts),
                        ].join('\n'))
                    }

                    case 'readiness': {
                        const body = await client.request<unknown>(`/architectures/${resolved.architectureId}/readiness`)
                        const readiness = ReadinessSchema.parse(body)
                        const facts = factsFromRelease(resolved, readiness.release)
                        // Split on `category`, which is what a row *is* and never changes — not on
                        // `gating`, which is what a row is *doing right now* and goes false the
                        // moment a gate clears. Filing a cleared gate under "advisory" would tell
                        // an agent that the thing blocking a release never blocked one.
                        const gates = readiness.rows.filter((row) => row.category === 'gate')
                        const open = gates.filter((row) => row.gating)
                        // A gate whose check could not be answered reports `gating: false` — it is
                        // not evidence of a problem — so it never appears in `open`. Keyed on
                        // `gating` alone this block said "0 of 6 gate(s) still open" and listed
                        // nothing, on a design that reports `ready: false`. The verdict is what
                        // separates the two reasons a design is not ready.
                        const unanswered = gates.filter((row) => row.state === 'unknown')
                        // A gate that measured a shortfall resting on an input nobody stated (an even
                        // split between entrances, traffic weights that do not add up). It never
                        // blocks, so it is in neither list above — and it is not "not checked".
                        const unconfirmedGates = gates.filter((row) => row.state === 'unconfirmed')
                        // Three categories, not two. An `accept` row is something a person agrees
                        // to — an assumption the design made, a decision waiting to be written
                        // down — and filing it under "some need a paid plan to clear" was wrong
                        // twice: accepting is free, and it is not a check anybody failed.
                        const accepts = readiness.rows.filter((row) => row.category === 'accept')
                        const advisories = readiness.rows.filter(
                            (row) => row.category !== 'gate' && row.category !== 'accept',
                        )
                        const unrun = new Set(readiness.unrun_checks ?? [])
                        const verdict =
                            readiness.verdict ?? (readiness.ready ? 'ready' : 'outstanding')
                        const headline =
                            verdict === 'ready'
                                ? 'Every gate is clear — this design is ready to build.'
                                : verdict === 'unanswered'
                                  ? `Nothing is undecided, but ${unanswered.length} check(s) could not be answered for this version:`
                                  : `${open.length} of ${gates.length} gate(s) still open:`
                        const listed = verdict === 'unanswered' ? unanswered : open
                        return ok({ ...base, ...facts, data: readiness }, [
                            headline,
                            ...listed.map((row) => `- ${row.label}: ${describeRow(row)}`),
                            ...(unconfirmedGates.length
                                ? ['',
                                   'Unconfirmed (the check ran, but its answer turns on an input nobody stated; never blocks):',
                                   ...unconfirmedGates.map((row) => `- ${row.label}: ${describeRow(row)}`)]
                                : []),
                            ...(accepts.length
                                ? ['',
                                   'To accept (the person agrees to these rather than fixing them; accepting is free ' +
                                       'and never blocks):',
                                   ...accepts.map((row) => `- ${row.label}: ${describeRow(row)}`)]
                                : []),
                            '',
                            'Advisory checks (they never block, and some need a paid plan to clear):',
                            // An advisory with no result is marked, not counted — "nothing to count
                            // here" is a fact an agent being handed work is entitled to, and it is
                            // invisible in a bare count of open items. The mark claims no more than
                            // that: an advisory can be unanswered because no result is *stored* for
                            // this version (the advisor row since the server stopped writing on
                            // read), not only because nothing ever ran, and the server's own
                            // sentence, when it sends one, says which.
                            ...advisories.map(
                                (row) =>
                                    `- ${row.label}: ${describeRow(row)}${unrun.has(row.key) && !row.detail ? ' (no result for this version)' : ''}`,
                            ),
                            // The same list, under the same heading, as the app shows beside its
                            // Release button. A person clicking Release is told what the release
                            // takes with it; an agent asking the same question of the same version
                            // was told nothing at all. A warning, never a refusal — it does not
                            // move the verdict and it does not stop anyone.
                            ...(readiness.release_warnings?.length
                                ? ['', 'It will carry:',
                                   ...readiness.release_warnings.map((warning) => `- ${warning}`)]
                                : []),
                            '',
                            'Only a person can clear a gate. Ask; do not decide on their behalf. ' +
                                'Use mode "todo" for the same work item by item.',
                            versionLine(facts),
                        ].join('\n'))
                    }

                    case 'build_order': {
                        const body = await client.request<unknown>(`/architectures/${resolved.architectureId}/build-order`)
                        const buildOrder = BuildOrderSchema.parse(body)
                        const facts = factsFromRelease(resolved, buildOrder.release)
                        return ok({ ...base, ...facts, data: { steps: buildOrder.steps } }, [
                            'Build in this order. It follows the dependency graph — an arrow means the',
                            'source calls the target, so the target is built first — and falls back to what',
                            'each component *is* wherever the graph is silent.',
                            ...buildOrder.steps.map((step) => {
                                // `depends_on` holds every dependency, including any the order could
                                // not honour. Rendering all of them as "after" would tell an agent to
                                // wait for something built later, so the two are said separately.
                                const blocked = new Set(step.blocked_by ?? [])
                                const after = (step.depends_on ?? []).filter((id) => !blocked.has(id))
                                return (
                                    `${step.order}. ${step.name} (${step.component_id}) — ${step.reason}` +
                                    (after.length ? ` [after: ${after.join(', ')}]` : '') +
                                    (blocked.size
                                        ? ` [cycle: it calls ${[...blocked].join(', ')}, built later — stub or defer that edge]`
                                        : '')
                                )
                            }),
                            '',
                            versionLine(facts),
                        ].join('\n'))
                    }

                    case 'gaps': {
                        const body = await client.request<unknown>(`/projects/${project.id}/design-gaps`, {
                            query: { architecture_id: resolved.architectureId },
                        })
                        const gaps = DesignGapListSchema.parse(body)
                        const facts = factsFrom(resolved)
                        const unresolved = gaps.gaps.filter((gap) => !gap.resolved)
                        // A settled gap is an answer, and an answer is the most useful thing on
                        // this list. Reporting only what is still open told an agent less the
                        // more work the team had done — the one case where the summary must
                        // grow, not shrink.
                        const settled = gaps.gaps.filter((gap) => gap.resolved && gap.action !== 'dismissed')
                        const orphaned = gaps.orphaned_answers ?? []
                        return ok({ ...base, ...facts, data: gaps }, [
                            unresolved.length === 0
                                ? 'Every open question and assumption in this design has been dealt with.'
                                : `${unresolved.length} unresolved:`,
                            ...unresolved.map((gap) => `- [${gap.kind}] ${gap.text}`),
                            ...(settled.length > 0
                                ? ['', `${settled.length} settled during review — treat these as decided:`,
                                   ...settled.map((gap) => `- [${gap.kind}] ${gap.text} → ${settledAnswer(gap)}`)]
                                : []),
                            // A gap is identified by a hash of its own text, so a regeneration that
                            // re-words a question strands the answer that settled it. The server
                            // reports those rather than dropping them, and then this dropped them.
                            // A count and a sentence, not rows: the stored answer has no text to
                            // show, and it is not work anyone can pick up.
                            ...(orphaned.length
                                ? ['',
                                   `${orphaned.length} earlier answer(s) do not match any question in this version` +
                                       ' — re-worded or dropped when it was generated, or asked only in a different' +
                                       ' version. Any Decision they minted still stands.',
                                   ...orphaned
                                       .filter((answer) => answer.adr_id)
                                       .map((answer) => `- [${answer.kind}] ${answer.action} → Decision ${answer.adr_id}`)]
                                : []),
                            '',
                            'The unresolved ones are questions for a person, not for you to answer. Raise',
                            'them; do not guess and build on the guess. An API token cannot resolve them —',
                            'that is done in the SkeletIQ app, on purpose.',
                            versionLine(facts),
                        ].join('\n'))
                    }
                }
            }),
    )
}

/**
 * What the design was asked to do, line by line, and what became of each line.
 *
 * `R7` appears inside the design itself — on components, and on the decisions that carry their
 * requirements — so until this block existed an agent reading `requirement_ids: ["R7"]` had the id
 * and nowhere to look up what R7 said.
 *
 * **Nothing here is ever rendered as "met" or "satisfied".** The strongest thing the product knows
 * about a requirement is that something in the design cites it and no check flagged a gap, and an
 * agent told a requirement is met stops looking at it. The four status words say exactly how far
 * each claim goes, and the sentence under the list says what each of them means, because the words
 * alone are only obvious to whoever chose them.
 *
 * A version carrying no ledger prints none of this. A template, a reverse-engineered design, a
 * version from before the analysis ran, and a server that predates the field all send nothing here
 * — and "0 requirements" would report every one of them as a design that was asked for nothing.
 */
function requirementBlock(ledger: RequirementLedger | undefined): string[] {
    const rows = orderRequirementRows(ledger?.rows ?? [])
    if (!ledger || rows.length === 0) return []

    // Counted off the rows being printed rather than read from the ledger's own `counts`, which is
    // optional on the wire and computed over a set this response may not be showing in full. A
    // heading that disagrees with the list under it is worse than one that ignores a field.
    // `failing` is what holds a handoff back, the same count readiness gates on; a model check's
    // doubt is counted beside it, never in it.
    const unconfirmed = rows.filter(isUnconfirmedRequirement).length
    const attention = [
        [rows.filter((row) => requirementVerdict(row) === 'fails').length, 'failing'],
        [unconfirmed, 'unconfirmed'],
        [rows.filter((row) => !isCitedRequirement(row)).length, 'cited by nothing'],
        [rows.filter((row) => requirementVerdict(row) === 'not_checked' || requirementVerdict(row) === 'not_checkable').length, 'unchecked'],
    ]
        .filter(([count]) => (count as number) > 0)
        .map(([count, word]) => `${count} ${word}`)

    return [
        '',
        `Requirements — ${rows.length} total${attention.length ? `; ${attention.join(', ')}` : ''}:`,
        ...rows.map(requirementLine),
        'Verdicts: `fails` — a named check measured the design as not meeting it, and says which and why;',
        '`passes` — a check measured it against a figure the person stated; `no_gap_found` — nothing',
        'contradicted it, which is not the same as proven; `not_checked` / `not_checkable` — nobody',
        'established either way, and neither is fine. `cited by nothing` means no component and no',
        'decision in the design claims to address it.',
        ...unconfirmedLegend(rows),
        // Two facts about how far the statuses can be trusted, said only when the server states
        // them. An absent `verification_state` is an older server, not a verifier that did not run,
        // and claiming the second would be this package inventing a fact about someone's design.
        ...(ledger.grounding_state === 'not_grounded'
            ? ['This version records no citations at all, so `uncited` here means nothing recorded what',
               'addresses the requirement — not that nothing in the design does.']
            : []),
        ...(ledger.verification_state === 'partial'
            ? ['The verifier did not check every requirement in this set, so an `unchecked` row is',
               'neither confirmed nor flagged.']
            : ledger.verification_state === 'not_run'
              ? ['The verifier did not run on this version, so an `unchecked` row is neither confirmed',
                 'nor flagged.']
              : []),
        ...(ledger.analysis_degraded
            ? ['The requirements analysis for this version ran degraded. Treat the list as incomplete.']
            : []),
    ]
}

/**
 * Said under a list only when a row in it is unconfirmed, one entry per reason present, so the word
 * never goes unexplained.
 */
function unconfirmedLegend(rows: RequirementLedgerRow[]): string[] {
    const reasons = new Set(rows.filter(isUnconfirmedRequirement).map((row) => row.unconfirmed_reason ?? 'model_check'))
    return [
        ...(reasons.has('model_check')
            ? ['`unconfirmed (model check)` — only a model check says the design may not meet it. Nothing',
               `measured it, so it does not block handoff: ${UNCONFIRMED_ADVICE} rather than adding a part.`]
            : []),
        ...(reasons.has('unstated_input')
            ? ['`unconfirmed (unstated split)` — capacity falls short only under an assumption nobody stated',
               '(the rate split evenly between entrances, or traffic weights that do not add up); split the',
               'most favourable way it would hold. It does not block handoff: ask how the traffic divides.']
            : []),
    ]
}

/**
 * The requirements the design cites this component against.
 *
 * `uncited` cannot appear here — a row nothing cites names no component — so the three statuses
 * that can reach this list are the three explained. Nothing is printed when no row names the
 * component: unlike a decision, where silence reads as "this component has no reasoning behind it"
 * and is worth a sentence, a requirement that names other boxes says nothing about this one.
 */
function requirementsServed(rows: RequirementLedgerRow[] | undefined): string[] {
    if (!rows?.length) return []
    return [
        '',
        'Requirements the design cites this component for:',
        ...rows.map(requirementLine),
        '`fails` — a named check measured the design as not meeting it; `not_checked` — nobody',
        'established either way; `no_gap_found` — nothing contradicted it, which is not the same as proven.',
        ...unconfirmedLegend(rows),
    ]
}

/**
 * Ids the component still names that the version no longer holds as requirements.
 *
 * Two ways that happens and the row says which: a person read the line and said it is not a
 * requirement, or an older analysis recorded an instruction ("remove Kafka") as one. Either way
 * the design is **not** held to it, and the sentence says so rather than leaving an agent to infer
 * it from a heading — an agent that read these as requirements would build to something the person
 * has explicitly withdrawn.
 */
function requirementsWithdrawn(rows: RequirementLedgerRow[] | undefined): string[] {
    if (!rows?.length) return []
    return [
        '',
        'This component still cites these ids, and they are no longer requirements — do not build to them:',
        ...rows.map(
            (row) =>
                `- ${row.id} ${(row.text ?? '').replace(/\s+/g, ' ').trim() || '(no text recorded)'}` +
                ` [${row.decision === 'removed' ? 'removed by a person' : `was an instruction, now ${row.superseded_by_change_request ?? 'a change request'}`}]`,
        ),
    ]
}

/**
 * One row: the id, what a named check said about it, why, and what it actually says.
 *
 * The verdict is printed as the server sent it (`requirementVerdict`) rather than mapped through a
 * table of five, so a value added server-side arrives intact instead of being flattened into the
 * nearest word this package happens to know. `no reason given` is never printed as an answer: the reason is the
 * whole value of the verdict, and a row without one is a row nobody can act on.
 *
 * A row with no text at all says so — the whole point of the block is that an agent should not be
 * left holding a bare `R7`, and printing one silently would look exactly like the behaviour this
 * replaced.
 *
 * The text is a requirement as a person or a model wrote it, and this list is newline-delimited, so
 * a line break inside one requirement would open a second row under the same heading — a row with
 * an id and a verdict that no server ever sent, indistinguishable from the real ones. Internal
 * whitespace is collapsed to keep one requirement on one line. Nothing is capped or truncated:
 * every requirement the version records is a requirement the agent has to build to.
 */
function requirementLine(row: RequirementLedgerRow): string {
    const verdict = requirementVerdict(row)
    const shown = isUnconfirmedRequirement(row) ? `${verdict} — ${UNCONFIRMED_ADVICE}` : verdict
    const marks = [shown, ...(isCitedRequirement(row) ? [] : ['cited by nothing'])].filter(Boolean)
    const label = marks.length > 0 ? ` [${marks.join(' · ')}]` : ''
    const text = (row.text ?? '').replace(/\s+/g, ' ').trim()
    const reason = (row.verdict_reason ?? '').replace(/\s+/g, ' ').trim()
    const by = (row.checked_by ?? '').trim()
    const because = reason ? ` — ${reason}${by ? ` (checked by ${by})` : ''}` : by ? ` — checked by ${by}` : ''
    return `- ${row.id}${label} ${text || '(no text recorded for this requirement)'}${because}`
}

/**
 * What a settled gap settled *to*, in the strongest form this endpoint carries.
 *
 * The design-gaps payload holds the disposition and the resolver's note, but not the prose of any
 * Decision the answer minted — that lives on the ADR. So a linked Decision is reported as a
 * pointer rather than paraphrased, and a bare `answered` with nothing written on it is stated as
 * exactly that, because an agent told "answered" with no answer would fill the hole itself.
 *
 * The Decision outranks the note when both exist — the same order the handoff brief uses, which
 * *can* read the prose — but the note is still printed, because it is the only wording this
 * response carries at all.
 */
function settledAnswer(gap: { action?: string | null; note?: string | null; adr_id?: string | null }): string {
    const note = (gap.note ?? '').trim()
    if (gap.adr_id) {
        const pointer = `recorded as a Decision (${gap.adr_id})`
        return note ? `${pointer} — ${note}` : pointer
    }
    if (note) return note
    if (gap.action === 'confirmed') return 'confirmed as it stands'
    return 'answered, but no wording was recorded — ask before relying on it'
}

/**
 * One To do group, as lines an agent can act on.
 *
 * Every source that raised a card is named on it. That is the whole point of the grouping: a card
 * reading "raised by the review, the advisor and a pending decision" is one piece of work, where
 * the same problem listed under three headings in three panels reads as three.
 */
function todoGroupBlock(group: TodoGroup): string[] {
    if (group.items.length === 0) return []
    return ['', `${group.label} (${group.items.length}):`, ...group.items.map(todoLine)]
}

/**
 * One card: what it is, what raised it, and how far back it goes.
 *
 * `carried` is said because it changes what the line means. A problem this version introduced is
 * something the last change did; one carried from three versions back has survived every attempt
 * so far, and an agent handed the two as identical rows has no way to tell them apart.
 */
function todoLine(item: TodoItem): string {
    const severity = item.severity && item.severity !== 'none' ? `[${item.severity}] ` : ''
    const raisedBy = [...new Set((item.sources ?? []).map((source) => source.source))]
    const raised = raisedBy.length > 0 ? ` — raised by ${raisedBy.join(', ')}` : ''
    const carried = item.carried
        ? item.carried_from_version
            ? ` — carried from v${item.carried_from_version}`
            : ' — carried from an earlier version'
        : ''
    const components = item.components?.length ? ` — affects ${item.components.join(', ')}` : ''
    return `- ${severity}${item.title.replace(/\s+/g, ' ').trim()}${components}${raised}${carried}`
}

function describeRow(row: { count: number; state: string; detail?: string | null }): string {
    if (row.state === 'unknown') return `not checked${row.detail ? ` — ${row.detail}` : ''}`
    if (row.state === 'unconfirmed') return `unconfirmed${row.detail ? ` — ${row.detail}` : ''}`
    return `${row.count}${row.detail ? ` — ${row.detail}` : ''}`
}
