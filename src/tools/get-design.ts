/**
 * The read surface, collapsed into one tool with six modes.
 *
 * Six tools that each read one endpoint would be six things for a model to choose between when the
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
import { overview, sliceComponent } from '../lib/slice.js'
import {
    BriefSchema,
    BuildOrderSchema,
    DesignGapListSchema,
    ReadinessSchema,
} from '../wire/schemas.js'

const MODES = ['overview', 'component', 'brief', 'readiness', 'build_order', 'gaps'] as const

const input = z.object({
    project_id: z.string().describe('A SkeletIQ project id, or its exact name.'),
    mode: z
        .enum(MODES)
        .describe(
            'overview: the whole design. ' +
                'component: one component, its connections in both directions, and the decisions that mention it. ' +
                'brief: the fenced markdown block to write into AGENTS.md. ' +
                'readiness: what still has to be decided before this design is worth building. ' +
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

export function registerGetDesign(server: McpServer, client: SkeletiqClient, resolver: DesignResolver): void {
    server.registerTool(
        'get_design',
        {
            title: 'Read a SkeletIQ design',
            description:
                'Read a SkeletIQ architecture. Start with mode "brief" to orient — it returns a fenced ' +
                'block to write into AGENTS.md — then "build_order" for the sequence and "component" for ' +
                'each piece as you build it. Every answer states which version it came from and whether ' +
                'that version is a release.',
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
                        const data = overview(design.architecture_json)
                        const facts = factsFrom(resolved)
                        return ok({ ...base, ...facts, data }, [
                            `# ${data.title}`,
                            data.description,
                            '',
                            `${data.components.length} component(s), ${data.connections.length} connection(s).`,
                            ...data.components.map(
                                (c) => `- ${c.id} — ${c.name} (${c.type}${c.technology ? `, ${c.technology}` : ''})`,
                            ),
                            '',
                            versionLine(facts),
                        ].join('\n'))
                    }

                    case 'component': {
                        if (!component_id) {
                            return failure('mode "component" needs a component_id. Use mode "overview" or "build_order" to see the ids.')
                        }
                        const design = await resolver.design(resolved.architectureId)
                        const slice = sliceComponent(design.architecture_json, component_id)
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
                            ...slice.related_decisions.map((decision) => `- ${decision}`),
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
                            '',
                            brief.markdown,
                            '',
                            versionLine(facts),
                        ].filter(Boolean).join('\n'))
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
                        const advisories = readiness.rows.filter((row) => row.category !== 'gate')
                        return ok({ ...base, ...facts, data: readiness }, [
                            readiness.ready
                                ? 'Every gate is clear — this design is ready to build.'
                                : `${open.length} of ${gates.length} gate(s) still open:`,
                            ...open.map((row) => `- ${row.label}: ${describeRow(row)}`),
                            '',
                            'Advisory checks (they never block, and some need a paid plan to clear):',
                            ...advisories.map((row) => `- ${row.label}: ${describeRow(row)}`),
                            '',
                            'Only a person can clear a gate. Ask; do not decide on their behalf.',
                            versionLine(facts),
                        ].join('\n'))
                    }

                    case 'build_order': {
                        const body = await client.request<unknown>(`/architectures/${resolved.architectureId}/build-order`)
                        const buildOrder = BuildOrderSchema.parse(body)
                        const facts = factsFromRelease(resolved, buildOrder.release)
                        return ok({ ...base, ...facts, data: { steps: buildOrder.steps } }, [
                            'Build in this order. It is derived from what each component *is*, not from',
                            'traffic direction — stores and queues exist before the things that use them.',
                            ...buildOrder.steps.map((step) => {
                                const deps = (step.depends_on ?? []).join(', ')
                                return (
                                    `${step.order}. ${step.name} (${step.component_id}) — ${step.reason}` +
                                    (deps ? ` [after: ${deps}]` : '')
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
                        return ok({ ...base, ...facts, data: gaps }, [
                            unresolved.length === 0
                                ? 'Every open question and assumption in this design has been dealt with.'
                                : `${unresolved.length} unresolved:`,
                            ...unresolved.map((gap) => `- [${gap.kind}] ${gap.text}`),
                            ...(settled.length > 0
                                ? ['', `${settled.length} settled during review — treat these as decided:`,
                                   ...settled.map((gap) => `- [${gap.kind}] ${gap.text} → ${settledAnswer(gap)}`)]
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

function describeRow(row: { count: number; state: string; detail?: string | null }): string {
    if (row.state === 'unknown') return 'not checked'
    return `${row.count}${row.detail ? ` — ${row.detail}` : ''}`
}
