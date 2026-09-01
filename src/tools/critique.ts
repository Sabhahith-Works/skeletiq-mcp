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
    domain: z
        .string()
        .optional()
        .describe(
            "The design's domain — e-commerce, fintech, healthcare, saas, social, iot, gaming, " +
                'infrastructure, streaming, logistics, ai-ml, search, data-analytics, content-platform, ' +
                'internal-tool. Worth sending: the domain is what ' +
                'selects the compliance frameworks to check against, and without it none apply, so no ' +
                'compliance finding is possible and the score comes back higher than the SkeletIQ app ' +
                'would show for the same design — by up to 15 points.',
        ),
    secondary_domains: z
        .array(z.string())
        .max(8)
        .optional()
        .describe(
            'Further domains the design spans, when it spans more than one — a multi-tenant shop ' +
                'that takes payments is e-commerce plus fintech and saas. These select frameworks on ' +
                "top of the primary domain's, so leaving them off is why a design already checked " +
                'against SOC2 and SOX in the app comes back here checked against neither, and scored ' +
                'higher for it. frameworks_checked says which were actually used.',
        ),
})

/**
 * What this tool's score is, said out loud.
 *
 * The app holds a stored version's headline to a *traceability ceiling* — a score is a claim,
 * and requirement traceability is the evidence for it, so a design tracing 3 of 15 requirements
 * cannot report an A. This tool is handed a design and no requirement set, so there is nothing
 * to trace against and no ceiling to apply: the honest number is the uncapped one.
 *
 * That is fine, and it has to be labelled. One live design answered 99.4 here and 98 in the app,
 * with nothing on either side saying which number was which — an agent reading both will either
 * resolve the contradiction wrongly or report it as a bug.
 */
const SCORE_BASIS_FINDINGS_ONLY = 'findings_only'

const SCORE_BASIS_NOTE =
    'This score is findings only. It is not held to a traceability ceiling, because this tool is ' +
    'given a design and no requirement set to trace it against. The app can show a lower number ' +
    'for the same stored design for exactly that reason.'

const output = z.object({
    architecture_score: z.number(),
    score_basis: z
        .literal(SCORE_BASIS_FINDINGS_ONLY)
        .describe(SCORE_BASIS_NOTE),
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
    compliance_assessed: z
        .boolean()
        .describe('False means no compliance framework was checked, so no compliance finding was possible.'),
    frameworks_checked: z.array(z.string()),
    compliance_note: z.string().nullable(),
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
        async ({ architecture_json, domain, secondary_domains }) =>
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
                        body: { architecture_json, domain, secondary_domains },
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

                // Reported, not inferred from an empty list: "no frameworks" and "no domain to
                // pick frameworks from" are different answers, and only the server knows which.
                const complianceAssessed = critique.compliance_assessed ?? false
                const structured = {
                    architecture_score: critique.architecture_score,
                    score_basis: SCORE_BASIS_FINDINGS_ONLY as typeof SCORE_BASIS_FINDINGS_ONLY,
                    security_score: critique.security_score,
                    performance_score: critique.performance_score,
                    resilience_score: critique.resilience_score,
                    data_score: critique.data_score,
                    findings,
                    finding_count: findings.length,
                    compliance_assessed: complianceAssessed,
                    frameworks_checked: critique.frameworks_checked ?? [],
                    compliance_note: critique.compliance_note ?? null,
                }

                const lines = [
                    `Architecture ${round(critique.architecture_score)}/100 · ` +
                        `security ${round(critique.security_score)} · performance ${round(critique.performance_score)} · ` +
                        `resilience ${round(critique.resilience_score)} · data ${round(critique.data_score)}`,
                    SCORE_BASIS_NOTE,
                    '',
                    // An agent that reads only the text has to see this too. Without it, "the app
                    // said 59 and the tool said 74" is an unexplained contradiction it will either
                    // resolve wrongly or report as a bug.
                    complianceAssessed
                        ? `Compliance checked against ${(critique.frameworks_checked ?? []).join(', ')} — `
                          + 'the frameworks systems in this domain are usually held to, inferred from the '
                          + 'domain you sent rather than from a regime anyone named. Confirm them.'
                        : (critique.compliance_note ?? 'Compliance was not assessed.'),
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
