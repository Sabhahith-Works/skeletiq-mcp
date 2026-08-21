/**
 * Critiquing a design that is not (yet) in SkeletIQ.
 *
 * Two inputs, two prices, and the difference is stated to the agent rather than hidden. A design
 * payload is checked against SkeletIQ's rules deterministically: no model call, no credits. A
 * plain plan has to be turned into a design first, which is a generation and costs what one costs.
 */

import * as z from 'zod/v4'

import type { McpServer } from '@modelcontextprotocol/server'

import type { SkeletiqClient } from '../http/client.js'
import { guard, ok } from '../lib/result.js'
import { PayloadCritiqueSchema } from '../wire/schemas.js'

const input = z.object({
    architecture_json: z
        .looseObject({
            title: z.string(),
            description: z.string(),
            components: z.array(z.looseObject({ id: z.string(), name: z.string(), type: z.string() })),
            connections: z.array(z.looseObject({ source: z.string(), target: z.string() })),
        })
        .optional()
        .describe(
            'A design to check. Free and deterministic — no model call. The shape SkeletIQ uses: ' +
                'title, description, components[{id,name,type,technology?}], connections[{source,target,protocol?}].',
        ),
})

const output = z.object({
    architecture_score: z.number(),
    security_score: z.number(),
    performance_score: z.number(),
    resilience_score: z.number(),
    data_score: z.number(),
    findings: z.array(
        z.object({
            severity: z.string(),
            category: z.string(),
            message: z.string(),
            affected_components: z.array(z.string()),
            remediation: z.string(),
        }),
    ),
    finding_count: z.number(),
})

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info']

export function registerCritique(server: McpServer, client: SkeletiqClient): void {
    server.registerTool(
        'critique_architecture',
        {
            title: 'Critique an architecture',
            description:
                'Check a design against SkeletIQ\'s architecture rules and get scored findings back. ' +
                'Deterministic and free — no model call, no credits, nothing stored. Useful on a design ' +
                'you drafted yourself before committing to it.',
            inputSchema: input,
            outputSchema: output,
            annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
        },
        async ({ architecture_json }) =>
            guard(async () => {
                if (!architecture_json) {
                    throw new Error(
                        'critique_architecture needs an architecture_json to check. If you only have a plan ' +
                            'in prose, run generate_architecture first — that spends credits, so say so before ' +
                            'you do it.',
                    )
                }

                const critique = PayloadCritiqueSchema.parse(
                    await client.request<unknown>('/handoff/critique', {
                        method: 'POST',
                        body: { architecture_json },
                    }),
                )

                const findings = [...critique.findings]
                    .sort((a, b) => rank(a.severity) - rank(b.severity))
                    .map((finding) => ({
                        severity: finding.severity ?? 'medium',
                        category: finding.category,
                        message: finding.message,
                        affected_components: finding.affected_components ?? [],
                        remediation: finding.remediation ?? '',
                    }))

                const structured = {
                    architecture_score: critique.architecture_score,
                    security_score: critique.security_score,
                    performance_score: critique.performance_score,
                    resilience_score: critique.resilience_score,
                    data_score: critique.data_score,
                    findings,
                    finding_count: findings.length,
                }

                const lines = [
                    `Architecture ${round(critique.architecture_score)}/100 · ` +
                        `security ${round(critique.security_score)} · performance ${round(critique.performance_score)} · ` +
                        `resilience ${round(critique.resilience_score)} · data ${round(critique.data_score)}`,
                    '',
                    findings.length === 0 ? 'No findings.' : `${findings.length} finding(s):`,
                    ...findings.map(
                        (finding) =>
                            `- [${finding.severity}] ${finding.message}` +
                            (finding.affected_components.length ? ` (${finding.affected_components.join(', ')})` : '') +
                            (finding.remediation ? `\n  Fix: ${finding.remediation}` : ''),
                    ),
                ]
                return ok(structured, lines.join('\n'))
            }),
    )
}

function rank(severity: string | undefined): number {
    const index = SEVERITY_ORDER.indexOf((severity ?? 'medium').toLowerCase())
    return index === -1 ? SEVERITY_ORDER.length : index
}

function round(value: number): number {
    return Math.round(value * 10) / 10
}
