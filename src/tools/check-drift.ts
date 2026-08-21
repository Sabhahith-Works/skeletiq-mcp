/**
 * Reporting what got built, and hearing what did not.
 *
 * Two contracts decide whether an agent keeps using this tool or learns to ignore it.
 *
 * **`covers` declares this repository's scope.** A design that spans several repositories is
 * SkeletIQ's home ground. Without `covers`, a repo implementing three of twelve components reports
 * nine failures on a perfectly green build — and the second time that happens the agent stops
 * believing the tool. Anything outside `covers` comes back as *elsewhere*, which is a fact, not a
 * finding.
 *
 * **A stale id gets suggestions, never a silent remap.** Component ids are minted per version and
 * a regeneration re-mints all of them, so the first regeneration after a handoff leaves a repo
 * holding ids that point at nothing. Guessing which new component an old id meant, and then
 * reporting against that guess, is a wrong answer wearing a right answer's clothes.
 */

import * as z from 'zod/v4'

import type { McpServer } from '@modelcontextprotocol/server'

import type { SkeletiqClient } from '../http/client.js'
import { factsFromRelease, type DesignResolver } from '../lib/resolve.js'
import { guard, ok, versionLine } from '../lib/result.js'
import { DriftSchema } from '../wire/schemas.js'

const input = z.object({
    project_id: z.string().describe('A SkeletIQ project id, or its exact name.'),
    version: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
            'The version you built from — the `version=` stamped in the AGENTS.md fence. ' +
                'Defaults to the latest released version. Component ids are only meaningful within one version.',
        ),
    covers: z
        .array(z.string())
        .max(500)
        .optional()
        .describe(
            'The component ids this repository is responsible for. Omit only when this repo implements ' +
                'the whole design — otherwise everything you leave out is reported as missing.',
        ),
    components: z
        .array(
            z.object({
                id: z.string().max(200).describe('The component id from the design.'),
                name: z.string().max(255).optional().describe('The component name, which survives a regeneration when the id does not.'),
                status: z.enum(['implemented', 'partial', 'not_started']),
                note: z.string().max(2000).optional(),
            }),
        )
        .max(500)
        .describe('What you built. Report every component in `covers`, including the ones not started.'),
    extra_components: z
        .array(
            z.object({
                name: z.string().max(255),
                type: z.string().max(64).optional(),
                technology: z.string().max(255).optional(),
            }),
        )
        .max(200)
        .optional()
        .describe('Things in the code that the design does not contain.'),
    extra_connections: z
        .array(
            z.object({
                source: z.string().max(255),
                target: z.string().max(255),
                protocol: z.string().max(64).optional(),
            }),
        )
        .max(500)
        .optional()
        .describe('Edges in the code the design does not have. Endpoints may be component ids or names.'),
})

const refs = z.array(z.object({ id: z.string(), name: z.string(), type: z.string() }))

const output = z.object({
    architecture_id: z.string(),
    version: z.number(),
    is_released: z.boolean(),
    newer_release_exists: z.boolean(),
    resolved_by: z.string(),
    in_sync: z.boolean(),
    missing: refs,
    unreported: refs,
    partial: refs,
    elsewhere: refs,
    unknown_ids: z.array(z.object({ id: z.string(), suggestions: refs })),
    counts: z.record(z.string(), z.number()),
})

export function registerCheckDrift(server: McpServer, client: SkeletiqClient, resolver: DesignResolver): void {
    server.registerTool(
        'check_drift',
        {
            title: 'Report build progress and check drift',
            description:
                'Tell SkeletIQ which components you have built and get back what is missing, what is only ' +
                'half done, and what exists in the code but not in the design. Declare `covers` when this ' +
                'repository implements only part of the design. This changes nothing in SkeletIQ — an agent ' +
                'never writes back to a design.',
            inputSchema: input,
            outputSchema: output,
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        },
        async ({ project_id, version, covers, components, extra_components, extra_connections }) =>
            guard(async () => {
                const project = await resolver.resolveProject(project_id)
                const resolved = await resolver.resolveVersion(project.id, version)

                const report = DriftSchema.parse(
                    await client.request<unknown>(`/architectures/${resolved.architectureId}/drift-check`, {
                        method: 'POST',
                        body: {
                            covers: covers ?? null,
                            components,
                            extra_components: extra_components ?? null,
                            extra_connections: extra_connections ?? null,
                        },
                    }),
                )

                const facts = factsFromRelease(resolved, report.release)
                const structured = {
                    architecture_id: report.architecture_id,
                    ...facts,
                    in_sync: report.in_sync,
                    missing: report.missing,
                    unreported: report.unreported,
                    partial: report.partial,
                    elsewhere: report.elsewhere,
                    unknown_ids: report.unknown_ids.map((entry) => ({
                        id: entry.id,
                        suggestions: entry.suggestions ?? [],
                    })),
                    counts: report.counts,
                }

                const lines: string[] = []
                lines.push(
                    report.in_sync
                        ? 'In sync — everything this repository covers is built as designed.'
                        : 'Drift found:',
                )
                push(lines, 'Not started', report.missing, report.counts.missing)
                push(lines, 'Half built', report.partial, report.counts.partial)
                push(lines, 'You did not mention', report.unreported, report.counts.unreported)

                if (report.extra_components.length) {
                    lines.push(`In the code but not the design: ${report.extra_components.map((c) => c.name).join(', ')}`)
                }
                if (report.extra_connections.length) {
                    lines.push(
                        `Connections the design does not have: ${report.extra_connections
                            .map((c) => `${c.source} → ${c.target}`)
                            .join(', ')}`,
                    )
                }

                if (report.unknown_ids.length) {
                    lines.push('')
                    lines.push(
                        `${report.unknown_ids.length} id(s) are not in version ${report.version}. Ids are minted per ` +
                            'version, so a regeneration voids them. These are suggestions — confirm with a person ' +
                            'before treating any of them as the same component:',
                    )
                    for (const entry of report.unknown_ids) {
                        const suggestions = (entry.suggestions ?? [])
                            .map((s) => `${s.name} (${s.id})`)
                            .join(', ')
                        lines.push(`- ${entry.id} → ${suggestions || 'nothing similar in this version'}`)
                    }
                }

                if (report.elsewhere.length) {
                    lines.push('')
                    lines.push(
                        `${report.elsewhere.length} component(s) are outside this repository's declared scope. ` +
                            'That is not drift — they are built elsewhere, or not yet.',
                    )
                }

                lines.push('')
                lines.push(versionLine(facts))
                return ok(structured, lines.join('\n'))
            }),
    )
}

/**
 * Every list the server sends is capped at fifty and reported alongside its true count. Printing
 * the list without the count would let a truncated inventory read as a complete one.
 */
function push(lines: string[], label: string, refs: { id: string; name: string }[], total: number | undefined): void {
    if (refs.length === 0) return
    const shown = refs.map((ref) => `${ref.name} (${ref.id})`).join(', ')
    const more = total !== undefined && total > refs.length ? ` — and ${total - refs.length} more` : ''
    lines.push(`${label} (${total ?? refs.length}): ${shown}${more}`)
}
