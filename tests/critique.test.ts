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

describe('which number this is', () => {
    /**
     * One live design answered 99.4 here and 98 in the app. Both were right: the app holds a
     * stored version's headline to a traceability ceiling — a score is a claim and requirement
     * traceability is the evidence for it — and this tool is handed a design with no requirement
     * set, so there is nothing to trace against and no ceiling to apply.
     *
     * Neither side said which number it was. An agent reading both will either resolve the
     * contradiction wrongly or report it as a bug, and both are worse than a label.
     */

    it('labels the score in the structured result', async () => {
        await open()

        const result = await harness!.call('critique_architecture', {
            architecture_json: ARCHITECTURE,
            domain: 'e-commerce',
        })

        expect(result.structuredContent?.score_basis).toBe('findings_only')
    })

    it('says it in the text an agent reads, not only in the schema', async () => {
        await open()

        const result = await harness!.call('critique_architecture', {
            architecture_json: ARCHITECTURE,
            domain: 'e-commerce',
        })

        const text = result.content?.[0]?.text ?? ''
        expect(text).toMatch(/findings only/i)
        expect(text).toMatch(/traceability ceiling/i)
    })
})

describe('where the framework set came from', () => {
    /**
     * This tool has no parameter for naming a regime, so its scope is *always* inferred from the
     * domain the agent sent. The app labels a domain-derived scope as a guess — an air-gapped
     * plant is assessed for SOC 2 it never named, because the domain map holds `iot` to it — and
     * an agent building from this answer needs the same warning.
     */
    it('says the set was inferred, not named', async () => {
        await open()

        const result = await harness!.call('critique_architecture', {
            architecture_json: ARCHITECTURE,
            domain: 'e-commerce',
        })

        const text = result.content?.[0]?.text ?? ''
        expect(text).toContain('GDPR, PCI-DSS')
        expect(text).toMatch(/inferred from the domain you sent/i)
    })
})

describe('where the design runs', () => {
    /**
     * The four exposure-scoped checks — CDN, WAF, rate limiting and multi-region — ask whether
     * traffic arriving from the public internet is handled safely. The app has resolved that
     * axis since it existed; this tool had no way to say it, so an air-gapped design submitted
     * by an agent was assessed as internet-facing and came back told to add a CDN, in a
     * remediation paragraph that says the check does not run on air-gapped designs.
     */

    it('sends the exposure the agent declared', async () => {
        const api = await open(critiqueBody({ exposure_assessed: 'air_gapped' }))

        const call = await harness!.call('critique_architecture', {
            architecture_json: ARCHITECTURE,
            exposure: 'air_gapped',
        })
        expect(call.isError).toBeFalsy()

        const sent = api.calls.find((call) => call.url.includes('/handoff/critique'))
        expect(sent!.body).toMatchObject({ exposure: 'air_gapped' })
    })

    it('sends nothing when the caller does not say', async () => {
        const api = await open()

        const call = await harness!.call('critique_architecture', { architecture_json: ARCHITECTURE })
        expect(call.isError).toBeFalsy()

        const body = api.calls.find((call) => call.url.includes('/handoff/critique'))!.body as Record<string, unknown>
        // Absent, not `"public_internet"`. The server defaults, and a caller reading the wire
        // should not see a claim about where the system runs that nobody made.
        expect(body.exposure).toBeUndefined()
    })

    it('reports the exposure the server actually used, not the one asked for', async () => {
        await open(critiqueBody({ exposure_assessed: 'air_gapped' }))

        const result = await harness!.call('critique_architecture', {
            architecture_json: ARCHITECTURE,
            exposure: 'air_gapped',
        })

        expect(result.structuredContent?.exposure_assessed).toBe('air_gapped')
    })

    it('warns, in the text, that saying nothing is not neutral', async () => {
        await open()

        const result = await harness!.call('critique_architecture', { architecture_json: ARCHITECTURE })

        const text = result.content?.[0]?.text ?? ''
        expect(text).toMatch(/no exposure was sent/i)
        expect(text).toMatch(/air_gapped/)
    })

    it('says so when the server did not apply the exposure it was given', async () => {
        // A SkeletIQ predating the exposure axis returns no `exposure_assessed`, so the tool
        // falls back to `public_internet` — which is what that server actually did. Silence here
        // would leave the agent believing its air-gapped design was assessed as one.
        await open(critiqueBody())

        const result = await harness!.call('critique_architecture', {
            architecture_json: ARCHITECTURE,
            exposure: 'air_gapped',
        })

        const text = result.content?.[0]?.text ?? ''
        expect(result.structuredContent?.exposure_assessed).toBe('public_internet')
        expect(text).toMatch(/did not apply it/i)
    })

    it('says nothing extra when the exposure was honoured', async () => {
        // The server's own `exposure_scoped_checks` finding names the checks it took off the
        // table. A second copy here is a second thing to keep true.
        await open(critiqueBody({ exposure_assessed: 'private_network' }))

        const result = await harness!.call('critique_architecture', {
            architecture_json: ARCHITECTURE,
            exposure: 'private_network',
        })

        const text = result.content?.[0]?.text ?? ''
        expect(text).not.toMatch(/no exposure was sent/i)
        expect(text).not.toMatch(/did not apply it/i)
    })

    it('refuses a value it cannot mean, rather than defaulting it silently', async () => {
        await open()

        const result = await harness!.call('critique_architecture', {
            architecture_json: ARCHITECTURE,
            exposure: 'airgapped',
        })

        expect(result.isError).toBe(true)
    })
})
