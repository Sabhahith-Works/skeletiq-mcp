/**
 * Critiquing a payload: what the agent sends decides what gets checked.
 *
 * The compliance frameworks a design is measured against are picked from the domains the
 * caller declares — and from *both* fields, not just the primary. A multi-tenant shop that
 * takes payments is `e-commerce` plus `fintech` and `saas`, and the second half is what adds
 * SOC2 and SOX on top of GDPR and PCI-DSS.
 *
 * That matters more here than in the app, because an agent's whole reason to call this is to
 * get a number it can compare against what SkeletIQ shows. A tool that silently checks fewer
 * frameworks returns a systematically higher score for the same design, and nothing in the
 * answer explains the gap.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { baseRoutes, fakeApi, startHarness, type FakeApi, type Harness, type Route } from './harness.js'

let harness: Harness | undefined
afterEach(async () => {
    await harness?.close()
    harness = undefined
})

const ARCHITECTURE = {
    title: 'Shop',
    description: 'A storefront',
    components: [
        { id: 'gw', name: 'API Gateway', type: 'gateway' },
        { id: 'svc', name: 'Order Service', type: 'service' },
    ],
    connections: [{ source: 'gw', target: 'svc' }],
}

function critiqueBody(overrides: Record<string, unknown> = {}) {
    return {
        architecture_score: 61.5,
        security_score: 50,
        performance_score: 70,
        resilience_score: 60,
        data_score: 55,
        findings: [
            {
                severity: 'high',
                pattern_id: 'missing_waf',
                category: 'security',
                message: 'No WAF in front of the gateway',
                affected_components: ['gw'],
                remediation: 'Put a WAF in front of it',
            },
        ],
        compliance_assessed: true,
        frameworks_checked: ['GDPR', 'PCI-DSS'],
        compliance_note: null,
        ...overrides,
    }
}

async function open(body: unknown = critiqueBody()): Promise<FakeApi> {
    const routes: Route[] = [{ match: 'POST /api/v1/handoff/critique', body }]
    const api = fakeApi(baseRoutes(routes))
    harness = await startHarness(api.fetch)
    return api
}

describe('the domain profile the agent declares', () => {
    it('sends both halves of the profile, not just the primary', async () => {
        const api = await open()

        const call = await harness!.call('critique_architecture', {
            architecture_json: ARCHITECTURE,
            domain: 'e-commerce',
            secondary_domains: ['fintech', 'saas'],
        })
        // Without this, a call that failed schema parsing would still satisfy the wire
        // assertion below — the request was made either way.
        expect(call.isError).toBeFalsy()

        const result = api.calls.find((call) => call.url.includes('/handoff/critique'))
        expect(result).toBeDefined()
        expect(result!.body).toMatchObject({
            domain: 'e-commerce',
            secondary_domains: ['fintech', 'saas'],
        })
    })

    it('sends nothing extra when the caller declares only a primary domain', async () => {
        const api = await open()

        const call = await harness!.call('critique_architecture', {
            architecture_json: ARCHITECTURE,
            domain: 'e-commerce',
        })
        expect(call.isError).toBeFalsy()

        const sent = api.calls.find((call) => call.url.includes('/handoff/critique'))
        const body = sent!.body as Record<string, unknown>
        // Absent, not `[]` — the server treats "no secondary domains" and "none declared" the
        // same way, but a caller reading the wire should not see a claim that was never made.
        expect(body.secondary_domains).toBeUndefined()
    })

    it('reports the frameworks the server actually used, rather than the ones asked for', async () => {
        // The two can differ — an unrecognised label is dropped server-side rather than 422'd —
        // and the returned list is the only thing that reconciles this score with the app's.
        await open(critiqueBody({ frameworks_checked: ['GDPR', 'PCI-DSS', 'SOC2', 'SOX'] }))

        const result = await harness!.call('critique_architecture', {
            architecture_json: ARCHITECTURE,
            domain: 'e-commerce',
            secondary_domains: ['fintech', 'saas'],
        })

        expect(result.structuredContent?.frameworks_checked).toEqual(['GDPR', 'PCI-DSS', 'SOC2', 'SOX'])
        expect(result.structuredContent?.compliance_assessed).toBe(true)
    })

    it('says so when nothing was assessed, instead of implying a clean bill', async () => {
        await open(
            critiqueBody({
                compliance_assessed: false,
                frameworks_checked: [],
                compliance_note: 'Not assessed — no domain was supplied, so no framework applied.',
            }),
        )

        const result = await harness!.call('critique_architecture', { architecture_json: ARCHITECTURE })

        expect(result.structuredContent?.compliance_assessed).toBe(false)
        expect(result.structuredContent?.frameworks_checked).toEqual([])
        expect(result.structuredContent?.compliance_note).toMatch(/not assessed/i)
    })
})

describe('what the tool refuses', () => {
    it('asks for a design rather than inventing one', async () => {
        await open()

        const result = await harness!.call('critique_architecture', {})

        expect(result.isError).toBe(true)
        expect(result.content?.[0]?.text).toMatch(/needs an architecture_json/)
    })
})
