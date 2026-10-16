/**
 * Reading a design: which version, which slice, and what the answer says about itself.
 */

import { afterEach, describe, expect, it } from 'vitest'

import {
    ARCH_V2,
    ARCH_V3,
    DESIGN,
    GROUNDED_DESIGN,
    LEDGER,
    MIXED_DESIGN,
    PROJECT_ID,
    RELEASE_FACTS,
    architecturePage,
    baseRoutes,
    designRoutes,
    fakeApi,
    startHarness,
    type FakeApi,
    type Harness,
    type Route,
} from './harness.js'

let harness: Harness | undefined
afterEach(async () => {
    await harness?.close()
    harness = undefined
})

async function open(extra: Route[] = []): Promise<FakeApi> {
    const api = fakeApi(baseRoutes(extra))
    harness = await startHarness(api.fetch)
    return api
}

describe('the version rule', () => {
    it('prefers the released version over a newer draft', async () => {
        await open()

        const result = await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'overview' })

        // v3 exists and is newer. It is also a draft nobody approved, and an agent that follows
        // the newest thing it can find follows edits made while it was working.
        expect(result.structuredContent?.version).toBe(2)
        expect(result.structuredContent?.resolved_by).toBe('latest_release')
        expect(result.structuredContent?.architecture_id).toBe(ARCH_V2)
    })

    it('honours an explicit version, and says the answer came from a draft', async () => {
        await open()

        const result = await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'overview', version: 3 })

        expect(result.structuredContent?.version).toBe(3)
        expect(result.structuredContent?.is_released).toBe(false)
        expect(result.structuredContent?.resolved_by).toBe('requested')
        expect(text(result)).toMatch(/DRAFT/)
    })

    it('falls back to the latest version when nothing has been released', async () => {
        const api = fakeApi([
            {
                match: `GET /api/v1/projects/${PROJECT_ID}/architectures`,
                body: {
                    items: [
                        { id: ARCH_V2, project_id: PROJECT_ID, version: 1, architecture_json: DESIGN, is_released: false },
                        { id: ARCH_V3, project_id: PROJECT_ID, version: 2, architecture_json: DESIGN, is_released: false },
                    ],
                    total: 2,
                },
            },
            { match: `GET /api/v1/projects/${PROJECT_ID}`, body: { id: PROJECT_ID, title: 'Shortener' } },
            {
                match: `GET /api/v1/architectures/${ARCH_V3}`,
                body: { id: ARCH_V3, project_id: PROJECT_ID, version: 2, architecture_json: DESIGN, is_released: false },
            },
        ])
        harness = await startHarness(api.fetch)

        const result = await harness.call('get_design', { project_id: PROJECT_ID, mode: 'overview' })

        expect(result.structuredContent?.version).toBe(2)
        expect(result.structuredContent?.resolved_by).toBe('latest_version')
    })

    it('names the versions that do exist when asked for one that does not', async () => {
        await open()

        const result = await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'overview', version: 9 })

        expect(result.isError).toBe(true)
        expect(text(result)).toMatch(/no version 9/i)
        expect(text(result)).toMatch(/2, 3/)
    })

    it('fetches the version list once and reuses it across modes', async () => {
        const api = await open([
            { match: `GET /api/v1/architectures/${ARCH_V2}/brief`, body: brief() },
        ])

        await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'overview' })
        await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'component', component_id: 'api' })
        await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'brief' })

        const listCalls = api.calls.filter((call) => call.url.includes('/architectures?'))
        expect(listCalls).toHaveLength(1)
        // The version being described is read on its own exactly once — the list item lacks the
        // ledger — and that one read serves the overview and every slice after it. Nothing reads
        // the draft nobody asked about.
        expect(api.calls.filter((call) => call.url.endsWith(`/architectures/${ARCH_V2}`))).toHaveLength(1)
        expect(api.calls.filter((call) => call.url.endsWith(`/architectures/${ARCH_V3}`))).toHaveLength(0)
    })
})

describe('the component slice', () => {
    it('returns the edges in both directions, not just the outgoing half', async () => {
        await open()

        const result = await harness!.call('get_design', {
            project_id: PROJECT_ID,
            mode: 'component',
            component_id: 'db',
        })

        const slice = result.structuredContent?.data as {
            component: { id: string }
            incoming: unknown[]
            outgoing: unknown[]
        }
        expect(slice.component.id).toBe('db')
        // The database calls nothing and is called by the API. An agent implementing it needs to
        // know who its caller is quite as much as the API needs to know what it calls.
        expect(slice.outgoing).toHaveLength(0)
        expect(slice.incoming).toHaveLength(1)
        expect(text(result)).toMatch(/Called by: api/)
    })

    it('surfaces the decisions that mention the component', async () => {
        await open()

        const result = await harness!.call('get_design', {
            project_id: PROJECT_ID,
            mode: 'component',
            component_id: 'db',
        })

        const slice = result.structuredContent?.data as { related_decisions: string[] }
        expect(slice.related_decisions).toHaveLength(1)
        expect(slice.related_decisions[0]).toMatch(/Postgres/)
    })

    it('explains that an unknown id may be an id from another version', async () => {
        await open()

        const result = await harness!.call('get_design', {
            project_id: PROJECT_ID,
            mode: 'component',
            component_id: 'worker',
        })

        expect(result.isError).toBe(true)
        expect(text(result)).toMatch(/only valid within one version/i)
        expect(text(result)).toMatch(/api, db, cache/)
    })

    it('refuses without a component_id rather than guessing one', async () => {
        await open()

        const result = await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'component' })

        expect(result.isError).toBe(true)
        expect(text(result)).toMatch(/needs a component_id/)
    })
})

describe('the decisions a design states', () => {
    // The server keeps two lists. `design_decisions` is the original, plain strings; the design
    // itself is now usually written with `grounded_decisions`, the same statements carrying the
    // requirements behind them — and the legacy list left empty. The connector read only the first,
    // so the most common design in the product answered "no reasoning here" to the agent about to
    // implement it. The wire schema is lenient, so the data arrived and was discarded in silence.

    it('reads decisions a design keeps only in its grounded list', async () => {
        await open(designRoutes(GROUNDED_DESIGN))

        const result = await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'overview' })

        const data = result.structuredContent?.data as { design_decisions: string[] }
        expect(data.design_decisions).toHaveLength(2)
        expect(data.design_decisions[0]).toMatch(/Postgres/)
        expect(data.design_decisions[1]).toMatch(/Redis fronts reads/)
    })

    it('shows them in the overview an agent actually reads', async () => {
        await open(designRoutes(GROUNDED_DESIGN))

        const result = await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'overview' })

        // The structured half was never the problem on its own — the text is what a model is shown,
        // and it named the components and then stopped, so every choice looked open again.
        expect(text(result)).toMatch(/Decisions taken/)
        expect(text(result)).toMatch(/Postgres was chosen/)
        expect(text(result)).toMatch(/Redis fronts reads/)
    })

    it('carries them into the component slice', async () => {
        await open(designRoutes(GROUNDED_DESIGN))

        const result = await harness!.call('get_design', {
            project_id: PROJECT_ID,
            mode: 'component',
            component_id: 'db',
        })

        const slice = result.structuredContent?.data as { related_decisions: string[] }
        expect(slice.related_decisions).toHaveLength(1)
        expect(slice.related_decisions[0]).toMatch(/Postgres/)
        expect(text(result)).toMatch(/Decisions that mention it:/)
        expect(text(result)).toMatch(/- Postgres was chosen/)
    })

    it('keeps both lists when a design carries both, because they do not say the same thing', async () => {
        await open(designRoutes(MIXED_DESIGN))

        const result = await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'overview' })

        // Preferring either list drops real content: on designs carrying both, their text sets were
        // measured and never coincide. Three distinct statements across the two lists, all three
        // kept, legacy first and each list in the order the design states it.
        const data = result.structuredContent?.data as { design_decisions: string[] }
        expect(data.design_decisions).toEqual([
            'Postgres was chosen for the Links Database because the data is relational.',
            'Short codes are generated in the API Service, not the database.',
            'Redis fronts reads because the hot set is small.',
        ])
    })

    it('states a decision once when both lists carry the same sentence', async () => {
        await open(designRoutes(MIXED_DESIGN))

        const result = await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'overview' })

        const data = result.structuredContent?.data as { design_decisions: string[] }
        // Three statements across the two lists, not four: the shared sentence is one decision the
        // server happens to keep twice, and repeating it would read as emphasis the design never put
        // there. The length is asserted alongside the count so this fails on a tree that reads one
        // list, where the duplicate is trivially absent.
        expect(data.design_decisions).toHaveLength(3)
        const postgres = data.design_decisions.filter((decision) => decision.includes('Postgres was chosen'))
        expect(postgres).toHaveLength(1)
    })

    it('says so plainly when no decision names the component', async () => {
        await open(designRoutes(GROUNDED_DESIGN))

        const result = await harness!.call('get_design', {
            project_id: PROJECT_ID,
            mode: 'component',
            component_id: 'api',
        })

        // Silence here reads as "this component has no reasoning behind it". It does not: the
        // decisions name other boxes. The difference is worth a sentence, and the sentence has to
        // point somewhere useful.
        expect(text(result)).toMatch(/No decision in this design names this component/)
        expect(text(result)).toMatch(/mode "overview"/)
    })

    it('still reads a design that predates grounded decisions entirely', async () => {
        // `DESIGN` is the legacy anchor: strings only, no `grounded_decisions` key at all. An older
        // server, an OSS build and the fallback engine all still send exactly this.
        await open()

        const result = await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'overview' })

        const data = result.structuredContent?.data as { design_decisions: string[] }
        expect(data.design_decisions).toEqual([DESIGN.design_decisions[0]])
        expect(text(result)).toMatch(/Decisions taken/)
    })

    it('says nothing about decisions when the design states none', async () => {
        await open(designRoutes({ ...DESIGN, design_decisions: [], trade_offs: [] }))

        const result = await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'overview' })

        // An empty heading is worse than no heading: it asserts the design was examined and found
        // to have no reasoning, which is not what an absent list means. Alone among the tests in
        // this block, this one also passes against the tree before the fix — there was no heading
        // there to be empty. It guards the new rendering, not the old defect.
        expect(text(result)).not.toMatch(/Decisions taken/)
        expect(text(result)).not.toMatch(/Trade-offs/)
    })
})

describe('a decision that rests on an assumption says so', () => {
    // A grounded decision carries `assumption: true` when the design could cite nothing for it. The
    // overview called every decision "settled", so an agent built to a guess the design had already
    // flagged — and on stored designs most decisions carry that flag.

    it('marks it in the overview and says what the mark means', async () => {
        await open(designRoutes(GROUNDED_DESIGN))

        const result = await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'overview' })

        const lines = text(result).split('\n')
        expect(lines).toContain(
            'Decisions taken — build to them; confirm the ones marked (assumption) first, they rest on no cited source:',
        )
        expect(lines).toContain(
            '- Redis fronts reads because the hot set is small and the read:write ratio is high. (assumption)',
        )
        expect(lines).toContain('- Postgres was chosen for the Links Database because the data is relational.')
        expect(text(result)).not.toMatch(/these are settled/)
    })

    it('lists the marked decisions in the structured half, leaving design_decisions as plain strings', async () => {
        await open(designRoutes(GROUNDED_DESIGN))

        const result = await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'overview' })

        const data = result.structuredContent?.data as { design_decisions: string[]; assumed_decisions: string[] }
        expect(data.design_decisions).toHaveLength(2)
        expect(data.assumed_decisions).toEqual([
            'Redis fronts reads because the hot set is small and the read:write ratio is high.',
        ])
    })

    it('marks a decision both lists carry when its grounded copy is an assumption', async () => {
        // The legacy list carries no flag, so its silence is not a claim the decision is sourced.
        const shared = 'Postgres was chosen for the Links Database because the data is relational.'
        await open(
            designRoutes({
                ...DESIGN,
                design_decisions: [shared],
                grounded_decisions: [{ text: shared, requirement_ids: ['R1'], assumption: true }],
            }),
        )

        const result = await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'overview' })

        expect(text(result).split('\n')).toContain(`- ${shared} (assumption)`)
    })

    it('marks it in the component slice too', async () => {
        await open(designRoutes(GROUNDED_DESIGN))

        const result = await harness!.call('get_design', {
            project_id: PROJECT_ID,
            mode: 'component',
            component_id: 'cache',
        })

        const slice = result.structuredContent?.data as { assumed_decisions: string[] }
        expect(slice.assumed_decisions).toHaveLength(1)
        const lines = text(result).split('\n')
        expect(lines).toContain(
            'Decisions that mention it — confirm the ones marked (assumption) first, they rest on no cited source:',
        )
        expect(lines).toContain(
            '- Redis fronts reads because the hot set is small and the read:write ratio is high. (assumption)',
        )
    })

    it('keeps the settled heading, byte for byte, when no decision is an assumption', async () => {
        await open(designRoutes(GROUNDED_DESIGN))

        const result = await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'component', component_id: 'db' })

        const lines = text(result).split('\n')
        expect(lines).toContain('Decisions that mention it:')
        expect(lines).toContain('- Postgres was chosen for the Links Database because the data is relational.')
    })
})

describe('the requirements a design was built from', () => {
    // `R7` appears inside the design itself — on components, and on grounded decisions — and an
    // agent reading `requirement_ids: ["R7"]` had the id and nowhere to look up what R7 said. The
    // ledger is that lookup, and it is also the only place the design says what became of a line
    // it was asked to satisfy.

    async function withLedger(ledger: unknown = LEDGER): Promise<void> {
        await open(designRoutes(DESIGN, { requirement_ledger: ledger }))
    }

    it('reaches overview and component although the version list never carries the ledger', async () => {
        // The regression 0.2.0 shipped: the resolver cached list items as full designs, and the
        // list endpoint omits `requirement_ledger` on purpose, so in production no answer ever
        // listed a requirement. Served in exactly the real shape — the ledger on the single-version
        // read and nowhere else — both views must still show it, and it must come from that read.
        const api = await open([
            {
                match: `GET /api/v1/projects/${PROJECT_ID}/architectures`,
                body: architecturePage(),
            },
            {
                match: `GET /api/v1/architectures/${ARCH_V2}`,
                body: { id: ARCH_V2, project_id: PROJECT_ID, version: 2, architecture_json: DESIGN, is_released: true, requirement_ledger: LEDGER },
            },
        ])

        const overviewText = text(await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'overview' }))
        const componentText = text(
            await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'component', component_id: 'db' }),
        )

        expect(overviewText).toContain('- R2 [fails] Every write to a link is recorded in an audit trail. — No component in the design records writes.')
        expect(componentText).toContain('- R2 [fails] Every write to a link is recorded in an audit trail. — No component in the design records writes.')
        const listed = api.calls.find((call) => call.url.includes('/architectures?'))
        expect(listed).toBeDefined()
        expect(api.calls.filter((call) => call.url.endsWith(`/architectures/${ARCH_V2}`))).toHaveLength(1)
    })

    it('lists them in the overview, resolved to text, with what became of each', async () => {
        await withLedger()

        const result = await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'overview' })

        expect(text(result)).toContain(
            [
                'Requirements — 3 total; 1 failing, 1 cited by nothing:',
                '- R2 [fails] Every write to a link is recorded in an audit trail. — No component in the design records writes.',
                '- R3 [no_gap_found · cited by nothing] The service stays available when one region is lost.',
                '- R1 [no_gap_found] A shortened link resolves in under 50 ms at the 99th percentile. — The design records a cache in front of the store, and nothing contradicts the target.',
            ].join('\n'),
        )
    })

    it('does not call a line failing when its only finding is that nothing cites it', async () => {
        // The shape of a real version: a line a model check failed, and a line whose `fails` came
        // from the structure check alone. The server's handoff gate counts only the first
        // (`requirement_blocks_handoff`), so a heading of "2 failing" told an agent a check had
        // measured a gap readiness does not count -- and an agent told a line fails builds a part.
        await withLedger({
            rows: [
                {
                    id: 'R3',
                    text: 'Perform KYC verification for borrowers.',
                    verdict: 'fails',
                    check_method: 'verifier',
                    verdict_reason: 'No part is dedicated to KYC.',
                    checked_by: 'gpt-4o-mini',
                    cited_by_components: ['db'],
                },
                {
                    id: 'R18',
                    text: 'Borrowers apply for loans of up to 5 lakh.',
                    verdict: 'fails',
                    check_method: 'structure',
                    verdict_reason: 'Nothing in the design cites it.',
                    cited_by_components: [],
                    cited_by_decisions: [],
                },
            ],
        })

        const body = text(await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'overview' }))

        // A server this old sends no `blocks_handoff`, so the method decides: neither the model
        // check's `fails` nor the citation-only one is a measurement, and neither is counted failing.
        expect(body).toContain(
            [
                'Requirements — 2 total; 1 unconfirmed, 1 cited by nothing:',
                '- R3 [unconfirmed (model check) — verify before building for it] Perform KYC verification for borrowers. — No part is dedicated to KYC. (checked by gpt-4o-mini)',
                '- R18 [cited by nothing] Borrowers apply for loans of up to 5 lakh. — Nothing in the design cites it.',
            ].join('\n'),
        )
    })

    it('counts only what holds a handoff back as failing, and says what a model check\'s doubt is', async () => {
        // A current server says per row whether it blocks. A measured `fails` does; the model
        // check's does not, and reads as unconfirmed with the advice beside it.
        await withLedger({
            rows: [
                {
                    id: 'R1',
                    text: 'Send a receipt by email.',
                    verdict: 'fails',
                    check_method: 'verifier',
                    verdict_reason: 'No part sends email.',
                    checked_by: 'gpt-4.1-mini',
                    blocks_handoff: false,
                    unconfirmed_reason: 'model_check',
                    cited_by_components: ['api'],
                },
                {
                    id: 'R2',
                    text: 'Handle 5,000 requests per second.',
                    verdict: 'fails',
                    check_method: 'simulation',
                    verdict_reason: 'Sized for 1,200/s.',
                    blocks_handoff: true,
                    unconfirmed_reason: null,
                    cited_by_components: ['api'],
                },
            ],
        })

        const body = text(await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'overview' }))

        expect(body).toContain(
            [
                'Requirements — 2 total; 1 failing, 1 unconfirmed:',
                '- R2 [fails] Handle 5,000 requests per second. — Sized for 1,200/s.',
                '- R1 [unconfirmed (model check) — verify before building for it] Send a receipt by email. — No part sends email. (checked by gpt-4.1-mini)',
            ].join('\n'),
        )
        expect(body).toMatch(/`unconfirmed \(model check\)` — only a model check says the design may not meet it/)

        const component = text(
            await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'component', component_id: 'api' }),
        )
        expect(component).toContain('- R1 [unconfirmed (model check) — verify before building for it] Send a receipt by email.')
        expect(component).toMatch(/Nothing\nmeasured it, so it does not block handoff/)
    })

    it('reads a capacity line that turns on an unstated split as unconfirmed, and says what that means', async () => {
        await withLedger({
            rows: [
                {
                    id: 'R2',
                    text: 'Ingest 50,000 clicks per second.',
                    verdict: 'fails',
                    check_method: 'simulation',
                    verdict_reason: 'Holds 40,600/s, short of the 50,000/s this asks for.',
                    blocks_handoff: false,
                    unconfirmed_reason: 'unstated_input',
                    unstated_input: 'the rate is split evenly between Ad Servers and Advertiser Users',
                    cited_by_components: ['api'],
                },
            ],
        })

        const body = text(await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'overview' }))

        expect(body).toContain('Requirements — 1 total; 1 unconfirmed:')
        expect(body).toContain(
            '- R2 [unconfirmed (unstated split) — verify before building for it] Ingest 50,000 clicks per second.',
        )
        expect(body).toMatch(/`unconfirmed \(unstated split\)` — capacity falls short only under an assumption nobody stated/)
        expect(body).toMatch(/names the split the design would need — judge whether that is realistic/)
        expect(body).not.toMatch(/most favourable/)
        expect(body).not.toMatch(/`unconfirmed \(model check\)`/)
    })

    it('reads a line only review advice fails as unconfirmed, and says why', async () => {
        await withLedger({
            rows: [
                {
                    id: 'R11',
                    text: 'Compliance with PCI DSS standards.',
                    verdict: 'fails',
                    check_method: 'rules',
                    verdict_reason: 'The review advises log monitoring for the cardholder data flow.',
                    blocks_handoff: false,
                    unconfirmed_reason: 'advisory_finding',
                    advisory_only: true,
                    cited_by_components: ['api'],
                },
            ],
        })

        const body = text(await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'overview' }))

        expect(body).toContain('- R11 [unconfirmed (review advice) — verify before building for it] Compliance with PCI DSS standards.')
        expect(body).toMatch(/`unconfirmed \(review advice\)` — only advice from the design review fails it/)
        expect(body).not.toMatch(/`unconfirmed \(unstated split\)`/)
    })

    it('reads a budget line that rests on an assumed load as its own kind of unconfirmed', async () => {
        await withLedger({
            rows: [
                {
                    id: 'R6',
                    text: 'Operate under a budget of $150 per month.',
                    verdict: 'fails',
                    check_method: 'cost',
                    verdict_reason: 'About $7,791/mo, over the $150 this allows.',
                    blocks_handoff: false,
                    unconfirmed_reason: 'unstated_input',
                    unstated_input: 'the load, which was assumed',
                    cited_by_components: ['api'],
                },
            ],
        })

        const body = text(await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'overview' }))

        expect(body).toContain('- R6 [unconfirmed (assumed load) — verify before building for it] Operate under a budget of $150 per month.')
        expect(body).toMatch(/`unconfirmed \(assumed load\)` — the verdict rests on the load, which was assumed/)
        expect(body).toMatch(/ask your human for their load rather than guessing one/)
        // The split's legend is for a different cause and is not printed for this one.
        expect(body).not.toMatch(/`unconfirmed \(unstated split\)`/)
    })

    it('takes the server\'s word on what blocks over its own reading of the method', async () => {
        await withLedger({
            rows: [
                {
                    id: 'R1',
                    text: 'Send a receipt by email.',
                    verdict: 'fails',
                    check_method: 'verifier',
                    verdict_reason: 'No part sends email.',
                    blocks_handoff: true,
                    cited_by_components: ['api'],
                },
            ],
        })

        const body = text(await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'overview' }))

        expect(body).toContain('Requirements — 1 total; 1 failing:')
        expect(body).not.toMatch(/unconfirmed/)
    })

    it('still counts a measured fail as failing on a server that predates `blocks_handoff`', async () => {
        await withLedger({
            rows: [
                {
                    id: 'R1',
                    text: 'Back up the orders database.',
                    verdict: 'fails',
                    check_method: 'rules',
                    verdict_reason: 'No backup is declared.',
                    cited_by_components: ['db'],
                },
                {
                    id: 'R2',
                    text: 'Retain orders for seven years.',
                    verdict: 'fails',
                    check_method: null,
                    verdict_reason: 'Nothing stores orders that long.',
                    cited_by_components: ['db'],
                },
            ],
        })

        const body = text(await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'overview' }))

        // No method recorded is a row from before methods existed, and its `fails` was the model
        // check's — unconfirmed, never a blocker.
        expect(body).toContain(
            [
                'Requirements — 2 total; 1 failing, 1 unconfirmed:',
                '- R1 [fails] Back up the orders database. — No backup is declared.',
                '- R2 [unconfirmed (model check) — verify before building for it] Retain orders for seven years. — Nothing stores orders that long.',
            ].join('\n'),
        )
    })

    it('puts what needs doing first, and never calls a requirement met', async () => {
        await withLedger()

        const body = text(await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'overview' }))

        // A failing verdict and a requirement nothing cites are the two that ask the agent to do
        // something, so they come first; R-number order survives inside each group. The rows arrive
        // R1, R2, R3, so a renderer that does no grouping at all fails this and passes a looser one.
        expect(body.indexOf('- R2 [fails]')).toBeLessThan(body.indexOf('- R3 [no_gap_found · cited by nothing]'))
        expect(body.indexOf('- R3 [no_gap_found · cited by nothing]')).toBeLessThan(
            body.indexOf('- R1 [no_gap_found]'),
        )
        // The strongest thing the product knows about a requirement is that something in the design
        // cites it and no check flagged a gap. "Met" and "satisfied" claim the other thing, and an
        // agent told a requirement is met stops looking at it.
        expect(body).not.toMatch(/\bmet\b/)
        expect(body).not.toMatch(/\bsatisfied\b/)
    })

    it('says what the verdicts mean, once', async () => {
        await withLedger()

        const body = text(await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'overview' }))

        expect(body).toMatch(/`no_gap_found` — nothing\ncontradicted it, which is not the same as proven/)
        expect(body.match(/a named check measured the design as not meeting it/g)).toHaveLength(1)
        // The four status words are what 0.3.0 dropped. A row that still printed one would be
        // handing the agent a summary of the verdict beside the verdict it summarises.
        expect(body).not.toMatch(/\[unmet\]|\[uncited\]|\[unchecked\]|\[cited\]/)
    })

    it('carries the ledger into the structured half verbatim', async () => {
        await withLedger()

        const result = await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'overview' })

        // The overview payload is rebuilt from named keys, so anything not named is dropped — which
        // is how `grounded_decisions` went missing for two releases. Verbatim, and in the server's
        // own row order: a block this package says it passes through must not be re-sorted on the
        // way past.
        const data = result.structuredContent?.data as { requirement_ledger: typeof LEDGER }
        expect(data.requirement_ledger).toEqual(LEDGER)
    })

    it('says a version with no citations recorded none, rather than leaving `uncited` to be read as absence', async () => {
        await withLedger({
            ...LEDGER,
            grounding_state: 'not_grounded',
            rows: LEDGER.rows.map((row) => ({ ...row, status: 'uncited', cited_by_components: [] })),
        })

        const body = text(await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'overview' }))

        // Every row `uncited` because the generation path recorded no citations at all is a
        // different fact from a design that genuinely addresses none of its requirements, and an
        // agent shown the second when the first is true rebuilds work that is already there.
        expect(body).toMatch(/records no citations at all/)
        expect(body).toMatch(/not that nothing in the design does/)
    })

    it('says when the verifier did not check every row', async () => {
        await withLedger({
            ...LEDGER,
            verification_state: 'partial',
            rows: LEDGER.rows.map((row) =>
                row.id === 'R1'
                    ? { ...row, status: 'unchecked', verdict: 'not_checked', verdict_reason: null, verifier_checked: false }
                    : row,
            ),
        })

        const body = text(await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'overview' }))

        expect(body).toMatch(/Requirements — 3 total; 1 failing, 1 cited by nothing, 1 unchecked:/)
        expect(body).toMatch(/- R1 \[not_checked\] A shortened link resolves/)
        expect(body).toMatch(/did not check every requirement in this set/)
        expect(body).toMatch(/neither confirmed nor flagged/)
    })

    it('says the verifier never ran, rather than leaving `unchecked` to read as a finding', async () => {
        await withLedger({
            ...LEDGER,
            verification_state: 'not_run',
            verified_version: null,
            rows: LEDGER.rows.map((row) =>
                row.status === 'uncited'
                    ? row
                    : { ...row, status: 'unchecked', verdict: 'not_checked', verdict_reason: null, checked_by: null, verifier_checked: false },
            ),
        })

        const body = text(await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'overview' }))

        // A set of `unchecked` rows has two causes an agent must not confuse: a verifier that looked
        // at part of the set, and one that never looked at all. Only the server can tell them apart,
        // and it says which — so the sentence is different, and neither is invented when it is silent.
        expect(body).toBe(
            overviewWith([
                'Requirements — 3 total; 1 cited by nothing, 2 unchecked:',
                '- R3 [no_gap_found · cited by nothing] The service stays available when one region is lost.',
                '- R1 [not_checked] A shortened link resolves in under 50 ms at the 99th percentile.',
                '- R2 [not_checked] Every write to a link is recorded in an audit trail.',
                ...VERDICT_LEGEND,
                'The verifier did not run on this version, so an `unchecked` row is neither confirmed',
                'nor flagged.',
            ]),
        )
    })

    it('says the analysis ran degraded, because the list may be missing rows entirely', async () => {
        await withLedger({ ...LEDGER, analysis_degraded: true })

        const body = text(await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'overview' }))

        // Every other caveat here is about a row's status. This one is about the set: a degraded run
        // may have recorded fewer requirements than the prompt stated, so "3 total" is a floor. An
        // agent that reads the list as complete builds to a brief that is short of lines.
        expect(body).toBe(
            overviewWith([
                'Requirements — 3 total; 1 failing, 1 cited by nothing:',
                '- R2 [fails] Every write to a link is recorded in an audit trail. — No component in the design records writes.',
                '- R3 [no_gap_found · cited by nothing] The service stays available when one region is lost.',
                '- R1 [no_gap_found] A shortened link resolves in under 50 ms at the 99th percentile. — The design records a cache in front of the store, and nothing contradicts the target.',
                ...VERDICT_LEGEND,
                'The requirements analysis for this version ran degraded. Treat the list as incomplete.',
            ]),
        )
    })

    it('claims nothing about the verifier when the server does not say', async () => {
        // A ledger from a server that predates `verification_state`. `undefined` here is absent on
        // the wire — the fake API serialises the body, and JSON drops the key. Absent is an older
        // server, not a verifier that did not run, and printing either sentence would be this
        // package inventing a fact about somebody's design.
        await withLedger({ ...LEDGER, verification_state: undefined })

        const body = text(await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'overview' }))

        expect(body).toBe(
            overviewWith([
                'Requirements — 3 total; 1 failing, 1 cited by nothing:',
                '- R2 [fails] Every write to a link is recorded in an audit trail. — No component in the design records writes.',
                '- R3 [no_gap_found · cited by nothing] The service stays available when one region is lost.',
                '- R1 [no_gap_found] A shortened link resolves in under 50 ms at the 99th percentile. — The design records a cache in front of the store, and nothing contradicts the target.',
                ...VERDICT_LEGEND,
            ]),
        )
    })

    it('sorts a verdict it does not know last, and prints it as the server sent it', async () => {
        await withLedger({
            ...LEDGER,
            rows: [
                ...LEDGER.rows,
                {
                    id: 'R4',
                    text: 'Link analytics retention is out of scope for v1.',
                    kind: 'functional',
                    source: 'user_supplied',
                    status: 'waived',
                    verdict: 'waived',
                    check_method: null,
                    verdict_reason: null,
                    checked_by: null,
                    verifier_checked: false,
                    cited_by_components: ['db'],
                    cited_by_decisions: [],
                    added_in_version: 2,
                },
            ],
        })

        const body = text(await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'overview' }))

        // `verdict` is a string so that a word added server-side reaches the agent instead of
        // stopping an older connector from parsing the row. That leniency has to end in the
        // rendering too: a verdict nobody here has heard of sorts below every settled one and keeps
        // its own word, because folding it in with the recognised ones would turn an unknown into a
        // false all-clear. It is also not counted in the heading — a count is a claim about verdicts
        // this package can explain.
        expect(body).toBe(
            overviewWith([
                'Requirements — 4 total; 1 failing, 1 cited by nothing:',
                '- R2 [fails] Every write to a link is recorded in an audit trail. — No component in the design records writes.',
                '- R3 [no_gap_found · cited by nothing] The service stays available when one region is lost.',
                '- R1 [no_gap_found] A shortened link resolves in under 50 ms at the 99th percentile. — The design records a cache in front of the store, and nothing contradicts the target.',
                '- R4 [waived] Link analytics retention is out of scope for v1.',
                ...VERDICT_LEGEND,
            ]),
        )
    })

    it('keeps one requirement on one line, whatever its text contains', async () => {
        await withLedger({
            ...LEDGER,
            rows: [
                {
                    ...LEDGER.rows[0],
                    text: 'A shortened link resolves in under 50 ms.\n- R9 [cited] Anyone may read any link.',
                },
            ],
        })

        const body = text(await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'overview' }))

        // Requirement text is written by a person or by a model, and this list is newline-delimited.
        // A line break inside one requirement opened a second row under the same heading — with an
        // id, a verdict and a sentence no server ever sent, and nothing to tell it from the real ones.
        expect(body).toBe(
            overviewWith([
                'Requirements — 1 total:',
                '- R1 [no_gap_found] A shortened link resolves in under 50 ms. - R9 [cited] Anyone may read any link.' +
                    ' — The design records a cache in front of the store, and nothing contradicts the target.',
                ...VERDICT_LEGEND,
            ]),
        )
        // One printed row per row the server sent, counted the way a reader counts them.
        expect(body.match(/^- R\d+ \[/gm)).toHaveLength(1)
    })

    it('lists the requirements the design cites a component for', async () => {
        await withLedger()

        const result = await harness!.call('get_design', {
            project_id: PROJECT_ID,
            mode: 'component',
            component_id: 'db',
        })

        expect(text(result)).toContain(
            [
                'Requirements the design cites this component for:',
                '- R2 [fails] Every write to a link is recorded in an audit trail. — No component in the design records writes.',
                '- R1 [no_gap_found] A shortened link resolves in under 50 ms at the 99th percentile. — The design records a cache in front of the store, and nothing contradicts the target.',
            ].join('\n'),
        )
        // Cited-by is the server's, computed from the saved payload — components *and* grounded
        // decisions. The component's own `requirement_ids` would be a second derivation of the same
        // relationship, free to disagree with the first.
        const slice = result.structuredContent?.data as { cited_requirements: { id: string }[] }
        expect(slice.cited_requirements.map((row) => row.id)).toEqual(['R2', 'R1'])
        // `R3` is cited by nothing, so it belongs to no component's slice.
        expect(text(result)).not.toMatch(/R3/)
    })

    it('names the ids a component cites that are no longer requirements', async () => {
        await withLedger({
            ...LEDGER,
            rows: LEDGER.rows.filter((row) => row.id !== 'R2'),
            removed: [{ ...LEDGER.rows[1], decision: 'removed', decided_in_version: 2 }],
            superseded: [
                {
                    id: 'R9',
                    text: 'Remove the Kafka cluster',
                    cited_by_components: ['db'],
                    cited_by_decisions: [],
                    superseded_by_change_request: 'CR2',
                },
            ],
        })

        const result = await harness!.call('get_design', {
            project_id: PROJECT_ID,
            mode: 'component',
            component_id: 'db',
        })

        // Nothing rewrites a saved design when a requirement is withdrawn, so the component still
        // carries the id. Dropping the row in silence would put an agent back where the ledger
        // found it: holding a bare `R2` with nowhere to look it up.
        expect(text(result)).toContain(
            [
                'This component still cites these ids, and they are no longer requirements — do not build to them:',
                '- R2 Every write to a link is recorded in an audit trail. [removed by a person]',
                '- R9 Remove the Kafka cluster [was an instruction, now CR2]',
            ].join('\n'),
        )
        // And it is not printed as something to build to.
        expect(text(result)).not.toContain('- R2 [fails]')
        const slice = result.structuredContent?.data as { withdrawn_requirements: { id: string }[] }
        expect(slice.withdrawn_requirements.map((row) => row.id)).toEqual(['R2', 'R9'])
    })

    it('says nothing about requirements on a component the ledger cites for none', async () => {
        await withLedger()

        const result = await harness!.call('get_design', {
            project_id: PROJECT_ID,
            mode: 'component',
            component_id: 'cache',
        })

        // A heading over an empty list would say the opposite of the empty list under it. Unlike a
        // decision — where silence reads as "this component has no reasoning behind it" and is
        // worth a sentence — a requirement naming other boxes says nothing about this one.
        expect(text(result)).not.toMatch(/Requirements/)
        const slice = result.structuredContent?.data as {
            cited_requirements: { id: string }[]
            withdrawn_requirements: { id: string }[]
        }
        expect(slice.cited_requirements).toEqual([])
        expect(slice.withdrawn_requirements).toEqual([])
    })

    it('prints nothing at all about requirements when the version carries no ledger', async () => {
        // An older server, a template, a reverse-engineered design and a version from before the
        // analysis ran all send no field. "0 requirements" would report every one of them as a
        // design that was asked for nothing.
        await open()

        const result = await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'overview' })
        const slice = await harness!.call('get_design', {
            project_id: PROJECT_ID,
            mode: 'component',
            component_id: 'db',
        })

        expect(text(result)).toBe(OVERVIEW_WITHOUT_LEDGER)
        expect(text(slice)).toBe(COMPONENT_WITHOUT_LEDGER)
        expect(result.structuredContent?.data).not.toHaveProperty('requirement_ledger')
        expect(slice.structuredContent?.data).not.toHaveProperty('cited_requirements')
        expect(slice.structuredContent?.data).not.toHaveProperty('withdrawn_requirements')
    })

    it('treats an explicit null the same way', async () => {
        // The field is nullable, not merely optional: a version the API looked at and could not
        // build a ledger for answers `null`, and it is the same silence as the field being absent.
        await withLedger(null)

        const result = await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'overview' })
        const slice = await harness!.call('get_design', {
            project_id: PROJECT_ID,
            mode: 'component',
            component_id: 'db',
        })

        expect(text(result)).toBe(OVERVIEW_WITHOUT_LEDGER)
        expect(text(slice)).toBe(COMPONENT_WITHOUT_LEDGER)
    })
})

/**
 * What the two modes printed before any of this existed, asserted rather than snapshotted.
 *
 * A snapshot updates itself when the output moves, which is the one thing these must not do: they
 * exist so that a design carrying no ledger reads exactly as it did to a connector shipped before
 * ledgers were a thing.
 */
const OVERVIEW_WITHOUT_LEDGER = [
    '# Link shortener',
    'Shortens links.',
    '',
    '3 component(s), 2 connection(s).',
    '- api — API Service (service, FastAPI)',
    '- db — Links Database (database, Postgres)',
    '- cache — Hot Links Cache (cache, Redis)',
    '',
    'Decisions taken — these are settled, build to them:',
    '- Postgres was chosen for the Links Database because the data is relational.',
    '',
    'Trade-offs the design accepts:',
    '- Redis adds an eviction problem.',
    '',
    'Version 2 (released).',
].join('\n')

/**
 * The same overview, around whatever the requirement block prints.
 *
 * Everything outside the block is `OVERVIEW_WITHOUT_LEDGER`'s own text, so a test that varies one
 * ledger field still asserts the whole answer rather than a fragment of it: a sentence that stops
 * being printed fails here even when nothing greps for it, and a sentence that starts being
 * printed twice fails too.
 */
function overviewWith(requirementBlock: string[]): string {
    return [
        '# Link shortener',
        'Shortens links.',
        '',
        '3 component(s), 2 connection(s).',
        '- api — API Service (service, FastAPI)',
        '- db — Links Database (database, Postgres)',
        '- cache — Hot Links Cache (cache, Redis)',
        '',
        ...requirementBlock,
        '',
        'Decisions taken — these are settled, build to them:',
        '- Postgres was chosen for the Links Database because the data is relational.',
        '',
        'Trade-offs the design accepts:',
        '- Redis adds an eviction problem.',
        '',
        'Version 2 (released).',
    ].join('\n')
}

/** What each verdict means — printed under every ledger, whatever else the block says. */
const VERDICT_LEGEND = [
    'Verdicts: `fails` — a named check measured the design as not meeting it, and says which and why;',
    '`passes` — a check measured it against a figure the person stated; `no_gap_found` — nothing',
    'contradicted it, which is not the same as proven; `not_checked` / `not_checkable` — nobody',
    'established either way, and neither is fine. `cited by nothing` means no component and no',
    'decision in the design claims to address it.',
]

const COMPONENT_WITHOUT_LEDGER = [
    '## Links Database (db)',
    'Type: database · Postgres',
    '',
    '',
    'Calls nothing.',
    'Called by: api',
    '',
    'Decisions that mention it:',
    '- Postgres was chosen for the Links Database because the data is relational.',
    '',
    'Version 2 (released).',
].join('\n')

describe('the brief', () => {
    it('tells the agent to replace the fence rather than append to it', async () => {
        await open([{ match: `GET /api/v1/architectures/${ARCH_V2}/brief`, body: brief() }])

        const result = await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'brief' })

        expect(text(result)).toMatch(/REPLACE it whole/)
        expect(text(result)).toMatch(/Never append a second one/)
        expect(text(result)).toContain('skeletiq:brief:start')
    })

    it('tells a partial repo to declare what it covers', async () => {
        // `check_drift` defaults to "this repo is the whole design", so a repo implementing three
        // of twelve components reports nine failures on a green build. Said in the tool response
        // as well as inside the block, because a model that acts on this response without
        // re-reading the markdown it just wrote to disk would never see the block's own copy.
        await open([{ match: `GET /api/v1/architectures/${ARCH_V2}/brief`, body: brief() }])

        const result = await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'brief' })

        expect(text(result)).toMatch(/implements only PART of the design/)
        expect(text(result)).toMatch(/pass `covers` to/)
    })

    it('labels a draft brief as one', async () => {
        await open([
            {
                match: `GET /api/v1/architectures/${ARCH_V2}/brief`,
                body: { ...brief(), is_draft: true },
            },
        ])

        const result = await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'brief' })

        expect(text(result)).toMatch(/This design is a DRAFT/)
    })

    it('carries the release facts the endpoint computed, not the ones this process inferred', async () => {
        await open([
            {
                match: `GET /api/v1/architectures/${ARCH_V2}/brief`,
                body: { ...brief(), release: { ...RELEASE_FACTS, newer_release_exists: true } },
            },
        ])

        const result = await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'brief' })

        // The server computes this over the whole project; a version list cached a minute ago
        // cannot. Where the endpoint answers, its answer wins.
        expect(result.structuredContent?.newer_release_exists).toBe(true)
        expect(text(result)).toMatch(/newer version has since been released/i)
    })
})

describe('the to do list', () => {
    const TODO = {
        architecture_id: ARCH_V2,
        version: 2,
        groups: [
            {
                key: 'blocks_handoff',
                label: 'Blocks handoff',
                items: [
                    {
                        problem_key: 'pattern:missing_auth_layer|api',
                        group: 'blocks_handoff',
                        kind: 'problem',
                        title: 'No authentication in front of the API',
                        severity: 'critical',
                        detail: 'Put an authenticating gateway in front of it.',
                        components: ['api'],
                        sources: [
                            { source: 'critique', message: 'No authentication in front of the API' },
                            { source: 'advisor', message: 'Add an auth layer', reference_id: 'sug-1' },
                            { source: 'decisions', message: 'Record: we accept an unauthenticated API', reference_id: 'cand-1' },
                        ],
                        actions: [{ action: 'apply', available: true, reference_id: 'sug-1' }],
                        carried: true,
                        carried_from_version: 1,
                    },
                ],
                bulk_action: null,
            },
            {
                key: 'recommended',
                label: 'Recommended',
                items: [
                    {
                        problem_key: 'sim:capacity|db',
                        group: 'recommended',
                        kind: 'problem',
                        title: 'Links Database exceeds capacity at current load',
                        severity: 'high',
                        components: ['db'],
                        sources: [{ source: 'advisor', message: 'Add read replicas', reference_id: 'sug-2' }],
                        actions: [{ action: 'apply', available: false, reason: 'Wait for the current design to finish' }],
                        carried: true,
                        carried_from_version: null,
                    },
                ],
                bulk_action: null,
            },
            { key: 'accept', label: 'Accept these', items: [], bulk_action: null },
        ],
        dismissed: [],
        counts: { blocks_handoff: 1, recommended: 1, accept: 0, dismissed: 0, total: 2 },
        raw_row_count: 4,
        unavailable_sources: [],
        generation_running: false,
        can_edit: true,
    }

    it('shows one entry per problem, naming every surface that raised it', async () => {
        await open([{ match: `GET /api/v1/architectures/${ARCH_V2}/todo`, body: TODO }])

        const body = text(await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'todo' }))

        // The whole reason this endpoint exists: the review, the advisor and a pending decision
        // describe one problem three times, and an agent reading three panels cannot tell that
        // fixing one thing clears all three.
        expect(body).toMatch(/2 thing\(s\) still to do on this version, 1 of which block a handoff:/)
        expect(body).toMatch(/Blocks handoff \(1\):/)
        expect(body).toMatch(/raised by critique, advisor, decisions/)
        expect(body).toMatch(/affects api/)
        expect(body.match(/No authentication in front of the API/g)).toHaveLength(1)
    })

    it('says how far back a problem goes, and says so vaguely when it cannot say exactly', async () => {
        await open([{ match: `GET /api/v1/architectures/${ARCH_V2}/todo`, body: TODO }])

        const body = text(await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'todo' }))

        // A problem this version introduced and one that has survived every attempt so far are not
        // the same news. Where the server looked back as far as it goes, it names the version;
        // where the origin is older than it looked, it says that rather than naming version zero.
        expect(body).toMatch(/carried from v1/)
        expect(body).toMatch(/carried from an earlier version/)
    })

    it('says a source could not be read rather than coming back shorter', async () => {
        await open([
            {
                match: `GET /api/v1/architectures/${ARCH_V2}/todo`,
                body: {
                    ...TODO,
                    groups: TODO.groups.map((group) => ({ ...group, items: [] })),
                    counts: { blocks_handoff: 0, recommended: 0, accept: 0, dismissed: 0, total: 0 },
                    unavailable_sources: [
                        { source: 'simulation', reason: "This version's simulation and cost results could not be read" },
                    ],
                },
            },
        ])

        const body = text(await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'todo' }))

        // "Nothing is outstanding" from a list that half failed to load is the worst answer this
        // surface can give: the agent acts on it, and nothing anywhere says it was incomplete.
        expect(body).toMatch(/Nothing is outstanding on this version\./)
        expect(body).toMatch(/the list above is incomplete/)
        expect(body).toMatch(/- simulation: This version's simulation and cost results could not be read/)
    })
})

describe('readiness and gaps', () => {
    it('separates the gates from the advisories and says only a person clears a gate', async () => {
        await open([
            {
                match: `GET /api/v1/architectures/${ARCH_V2}/readiness`,
                body: {
                    architecture_id: ARCH_V2,
                    version: 2,
                    ready: false,
                    rows: [
                        { key: 'open_questions', label: 'Open questions unanswered', count: 2, state: 'attention', category: 'gate', gating: true },
                        // A cleared gate reports `gating: false` — it is still a gate.
                        { key: 'adrs_proposed', label: 'Decisions still proposed', count: 0, state: 'clear', category: 'gate', gating: false },
                        { key: 'critique_findings', label: 'Critique findings', count: 4, state: 'attention', category: 'advisory', gating: false },
                        { key: 'fitness_failures', label: 'Fitness rules failing', count: 0, state: 'unknown', category: 'advisory', gating: false },
                    ],
                    release: RELEASE_FACTS,
                },
            },
        ])

        const result = await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'readiness' })

        expect(text(result)).toMatch(/1 of 2 gate\(s\) still open/)
        expect(text(result)).toMatch(/Open questions unanswered: 2/)
        expect(text(result)).toMatch(/Only a person can clear a gate/)

        // `gating` goes false the moment a gate clears, so splitting the display on it would file
        // a cleared gate under "advisory" — telling the agent that the thing blocking a release
        // was never a blocker. A cleared gate is simply not listed; the count line accounts for it.
        const [gateBlock, advisoryBlock] = text(result).split('Advisory checks')
        expect(gateBlock).not.toMatch(/Decisions still proposed/)
        expect(advisoryBlock).not.toMatch(/Decisions still proposed/)
    })

    it('files an accept row under accepting, not under checks that need a paid plan', async () => {
        await open([
            {
                match: `GET /api/v1/architectures/${ARCH_V2}/readiness`,
                body: {
                    architecture_id: ARCH_V2,
                    version: 2,
                    ready: true,
                    verdict: 'ready',
                    rows: [
                        { key: 'assumptions', label: 'Assumptions to accept', count: 3, state: 'attention', category: 'accept', gating: false },
                        { key: 'fitness_failures', label: 'Fitness rules failing', count: 0, state: 'clear', category: 'advisory', gating: false },
                    ],
                    release: RELEASE_FACTS,
                },
            },
        ])

        const body = text(await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'readiness' }))

        // Accepting is free and nothing failed. Printing an assumption under "some need a paid plan
        // to clear" told an agent both of the opposite things.
        const [acceptBlock, advisoryBlock] = body.split('Advisory checks')
        expect(acceptBlock).toMatch(/To accept \(the person agrees to these rather than fixing them/)
        expect(acceptBlock).toMatch(/Assumptions to accept: 3/)
        expect(advisoryBlock).not.toMatch(/Assumptions to accept/)
    })

    it('reports an unchecked row as unchecked, never as a zero', async () => {
        await open([
            {
                match: `GET /api/v1/architectures/${ARCH_V2}/readiness`,
                body: {
                    architecture_id: ARCH_V2,
                    version: 2,
                    ready: true,
                    rows: [
                        { key: 'fitness_failures', label: 'Fitness rules failing', count: 0, state: 'unknown', category: 'advisory', gating: false },
                    ],
                    release: RELEASE_FACTS,
                },
            },
        ])

        const result = await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'readiness' })

        // `unknown` is a settled answer meaning the check never ran. Printing "0" would claim a
        // check passed that was never performed.
        expect(text(result)).toMatch(/Fitness rules failing: not checked/)
        expect(text(result)).not.toMatch(/Fitness rules failing: 0/)
    })

    it('never says "0 gates still open" on a design it also calls not ready', async () => {
        // The `unanswered` verdict: every gate clear, one of them unanswerable for this version.
        // An unknown gate reports `gating: false` — it is not evidence of a problem — so a
        // renderer keyed on `gating` alone finds nothing open and prints "0 of 2 gate(s) still
        // open" beside `ready: false`. Two statements about the same design that cannot both be
        // acted on.
        await open([
            {
                match: `GET /api/v1/architectures/${ARCH_V2}/readiness`,
                body: {
                    architecture_id: ARCH_V2,
                    version: 2,
                    ready: false,
                    verdict: 'unanswered',
                    unknown_gate_count: 2,
                    unrun_checks: ['advisor_pending'],
                    rows: [
                        { key: 'open_questions', label: 'Open questions unanswered', count: 0, state: 'clear', category: 'gate', gating: false },
                        { key: 'release_blockers', label: 'Release blockers', count: 1, state: 'unknown', category: 'gate', gating: false, detail: 'Computed for version 4, not this one' },
                        { key: 'advisor_pending', label: 'Advisor suggestions open', count: 0, state: 'unknown', category: 'advisory', gating: false },
                        { key: 'stated_load', label: 'Load checked', count: 0, state: 'unknown', category: 'gate', gating: false, detail: 'No run for this version', clears: 'Saving a change runs it on the new version.' },
                    ],
                    release: RELEASE_FACTS,
                },
            },
        ])

        const result = await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'readiness' })

        // An unanswered row says what would answer it when the server does.
        expect(text(result)).toMatch(/Load checked: not checked — No run for this version\. Saving a change runs it on the new version\./)
        expect(text(result)).not.toMatch(/0 of \d+ gate\(s\) still open/)
        expect(text(result)).toMatch(/2 check\(s\) could not be answered for this version/)
        // And it names which one, with the version it actually answered for.
        // Up to 0.2.0 the server's reason was dropped for every unanswered row, so this line
        // claimed a version it never printed.
        expect(text(result)).toMatch(/Release blockers: not checked — Computed for version 4, not this one/)
        // The unanswered advisory is marked rather than counted, and claims no more than that it
        // has no result — not that nothing ever ran.
        expect(text(result)).toMatch(/Advisor suggestions open: not checked \(no result for this version\)/)
        expect(text(result)).not.toMatch(/never run/)
    })

    it('lists a load gate that rests on an unstated split as unconfirmed, apart from the open gates', async () => {
        // A stated load the design falls short of only because the rate was split evenly between
        // two entrances nobody said how to divide. It never blocks, and it is not "not checked".
        await open([
            {
                match: `GET /api/v1/architectures/${ARCH_V2}/readiness`,
                body: {
                    architecture_id: ARCH_V2,
                    version: 2,
                    ready: true,
                    verdict: 'ready',
                    unknown_gate_count: 0,
                    unrun_checks: [],
                    rows: [
                        { key: 'open_questions', label: 'Open questions unanswered', count: 0, state: 'clear', category: 'gate', gating: false },
                        {
                            key: 'stated_load',
                            label: 'Short of the stated load',
                            count: 0,
                            state: 'unconfirmed',
                            category: 'gate',
                            gating: false,
                            detail: 'Holds about 40,600/s, short of the 50,000/s you stated. That rests on an input nobody '
                                + 'stated: the rate is split evenly between Ad Servers and Advertiser Users. It would hold '
                                + 'it only if most of the traffic enters through Advertiser Users.',
                        },
                    ],
                    release: RELEASE_FACTS,
                },
            },
        ])

        const body = text(await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'readiness' }))

        expect(body).toMatch(/Every gate is clear/)
        expect(body).toMatch(/Unconfirmed \(the check ran, but its answer turns on an input nobody stated; never blocks\):/)
        expect(body).toMatch(/- Short of the stated load: unconfirmed — Holds about 40,600\/s, short of the 50,000\/s you stated/)
        expect(body).toContain('only if most of the traffic enters through Advertiser Users.')
    })

    it('passes on the server\'s reason for an unanswered advisory instead of guessing one', async () => {
        // The server says *why* the advisor row has no count — since it stopped writing on read,
        // that is usually "none stored", not "never ran". The reason reaches the agent verbatim,
        // and no second, contradicting mark is added after it.
        const reason = 'No advisor suggestions are stored for this version, so they are not counted here'
        await open([
            {
                match: `GET /api/v1/architectures/${ARCH_V2}/readiness`,
                body: {
                    architecture_id: ARCH_V2,
                    version: 2,
                    ready: true,
                    verdict: 'ready',
                    unknown_gate_count: 0,
                    unrun_checks: ['advisor_pending'],
                    rows: [
                        { key: 'open_questions', label: 'Open questions unanswered', count: 0, state: 'clear', category: 'gate', gating: false },
                        { key: 'advisor_pending', label: 'Advisor suggestions open', count: 0, state: 'unknown', category: 'advisory', gating: false, detail: reason },
                    ],
                    release: RELEASE_FACTS,
                },
            },
        ])

        const body = text(await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'readiness' }))

        expect(body).toContain(`- Advisor suggestions open: not checked — ${reason}`)
        expect(body).not.toMatch(/no result for this version|never run/)
    })

    it('says open gaps are questions for a person and that a token cannot resolve them', async () => {
        await open([
            {
                match: `GET /api/v1/projects/${PROJECT_ID}/design-gaps`,
                body: {
                    project_id: PROJECT_ID,
                    architecture_id: ARCH_V2,
                    version: 2,
                    gaps: [
                        { gap_id: 'a1', kind: 'open_question', text: 'Which region?', resolved: false },
                        { gap_id: 'b2', kind: 'assumption', text: 'Traffic is read-heavy.', resolved: true, action: 'confirmed' },
                    ],
                    unresolved_count: 1,
                },
            },
        ])

        const result = await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'gaps' })

        expect(text(result)).toMatch(/1 unresolved/)
        expect(text(result)).toMatch(/Which region\?/)
        expect(text(result)).toMatch(/do not\s+guess/i)
        expect(text(result)).toMatch(/API token cannot resolve them/)
        // The "for a person" instruction covers the open ones. A settled gap is
        // already a person's answer, and telling the agent to go ask again would
        // send it back to the team with a question they have closed.
        expect(text(result)).toMatch(/Traffic is read-heavy\.? → confirmed as it stands/)
    })

    it('says when an assumption is not what the design is sized on', async () => {
        await open([
            {
                match: `GET /api/v1/projects/${PROJECT_ID}/design-gaps`,
                body: {
                    project_id: PROJECT_ID,
                    architecture_id: ARCH_V2,
                    version: 2,
                    gaps: [
                        {
                            gap_id: 'a1',
                            kind: 'assumption',
                            text: 'The read/write mix is approximately 70% reads and 30% writes.',
                            resolved: false,
                            sizing_conflict: { dimension: 'read_write_mix', assumed: '70% reads', sized: '80% reads', resize_to: '70% reads' },
                        },
                        { gap_id: 'b2', kind: 'assumption', text: 'Single tenant.', resolved: false, sizing_conflict: null },
                    ],
                    unresolved_count: 2,
                },
            },
        ])

        const result = await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'gaps' })

        expect(text(result)).toMatch(/30% writes\. \(this design is sized for 80% reads, not 70% reads\)/)
        expect(text(result)).toMatch(/Single tenant\.\n/)
    })

    it('reports what was settled during review, because that is the answer', async () => {
        await open([
            {
                match: `GET /api/v1/projects/${PROJECT_ID}/design-gaps`,
                body: {
                    project_id: PROJECT_ID,
                    architecture_id: ARCH_V2,
                    version: 2,
                    gaps: [
                        { gap_id: 'a1', kind: 'open_question', text: 'Which region?', resolved: true, action: 'answered', note: 'eu-west-1.' },
                        { gap_id: 'b2', kind: 'open_question', text: 'Which queue?', resolved: true, action: 'answered', adr_id: 'adr-7', note: 'SQS.' },
                        { gap_id: 'c3', kind: 'open_question', text: 'Which cache?', resolved: true, action: 'answered' },
                        { gap_id: 'd4', kind: 'assumption', text: 'Single tenant.', resolved: true, action: 'dismissed', note: 'Not this design.' },
                    ],
                    unresolved_count: 0,
                },
            },
        ])

        const result = await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'gaps' })

        expect(text(result)).toMatch(/3 settled during review/)
        expect(text(result)).toMatch(/Which region\? → eu-west-1\./)
        // No prose for the Decision on this endpoint, so it points rather than paraphrases —
        // and keeps the note, which is the only wording this response actually carries.
        expect(text(result)).toMatch(/Which queue\? → recorded as a Decision \(adr-7\) — SQS\./)
        // An "answered" with nothing written on it must not read as an answer.
        expect(text(result)).toMatch(/Which cache\? → answered, but no wording was recorded/)
        // Dismissed means "does not apply here" — re-raising it is the bug, not the fix.
        expect(text(result)).not.toMatch(/Single tenant/)
    })
})

describe('what a release would carry, and the answers it stranded', () => {
    // Two fields the API takes deliberate care to send and this package silently dropped. Both are
    // on screen in the app already, so the person and the agent were being told different things
    // about the same version.

    it('says what a release will carry, in the words the app uses', async () => {
        await open([
            {
                match: `GET /api/v1/architectures/${ARCH_V2}/readiness`,
                body: {
                    architecture_id: ARCH_V2,
                    version: 2,
                    ready: false,
                    verdict: 'outstanding',
                    unknown_gate_count: 0,
                    unrun_checks: [],
                    rows: [
                        { key: 'open_questions', label: 'Open questions unanswered', count: 1, state: 'attention', category: 'gate', gating: true },
                    ],
                    release: RELEASE_FACTS,
                    release_warnings: [
                        '2 components have no technology chosen.',
                        'The critique has not been run against this version.',
                    ],
                },
            },
        ])

        const result = await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'readiness' })

        // "It will carry:" is the app's own heading, beside its Release button. A person and an
        // agent looking at the same version should hear the same sentence.
        expect(text(result)).toMatch(/It will carry:/)
        expect(text(result)).toMatch(/- 2 components have no technology chosen\./)
        expect(text(result)).toMatch(/- The critique has not been run against this version\./)
        const data = result.structuredContent?.data as { release_warnings: string[] }
        expect(data.release_warnings).toHaveLength(2)
    })

    it('keeps the warnings a warning, not a gate', async () => {
        await open([
            {
                match: `GET /api/v1/architectures/${ARCH_V2}/readiness`,
                body: {
                    architecture_id: ARCH_V2,
                    version: 2,
                    ready: true,
                    verdict: 'ready',
                    unknown_gate_count: 0,
                    unrun_checks: [],
                    rows: [
                        { key: 'open_questions', label: 'Open questions unanswered', count: 0, state: 'clear', category: 'gate', gating: false },
                    ],
                    release: RELEASE_FACTS,
                    release_warnings: ['The critique has not been run against this version.'],
                },
            },
        ])

        const result = await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'readiness' })

        // A design can be ready and still carry something. Rendering these as blockers would make
        // the agent refuse work the product is happy to hand over.
        expect(text(result)).toMatch(/Every gate is clear/)
        expect(text(result)).toMatch(/It will carry:/)
    })

    it('says nothing about warnings when the version carries none', async () => {
        await open([
            {
                match: `GET /api/v1/architectures/${ARCH_V2}/readiness`,
                body: {
                    architecture_id: ARCH_V2,
                    version: 2,
                    ready: true,
                    verdict: 'ready',
                    unknown_gate_count: 0,
                    unrun_checks: [],
                    rows: [],
                    release: RELEASE_FACTS,
                    release_warnings: [],
                },
            },
        ])

        const result = await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'readiness' })

        expect(text(result)).not.toMatch(/It will carry:/)
    })

    it('still parses a readiness response from a server that predates the field', async () => {
        // Required on today's wire, optional here on purpose: a published package outlives the
        // server it was built against, and a missing field must thin the answer, never break it.
        await open([
            {
                match: `GET /api/v1/architectures/${ARCH_V2}/readiness`,
                body: {
                    architecture_id: ARCH_V2,
                    version: 2,
                    ready: true,
                    rows: [],
                    release: RELEASE_FACTS,
                },
            },
        ])

        const result = await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'readiness' })

        expect(result.isError).toBeFalsy()
        expect(text(result)).toMatch(/Every gate is clear/)
        expect(text(result)).not.toMatch(/It will carry:/)
    })

    it('reports the answers a regeneration stranded', async () => {
        await open([
            {
                match: `GET /api/v1/projects/${PROJECT_ID}/design-gaps`,
                body: {
                    project_id: PROJECT_ID,
                    architecture_id: ARCH_V2,
                    version: 2,
                    gaps: [{ gap_id: 'a1', kind: 'open_question', text: 'Which region?', resolved: false }],
                    unresolved_count: 1,
                    orphaned_answers: [
                        { gap_id: 'dead1111beef2222', kind: 'open_question', action: 'answered', note: 'eu-west-1.' },
                        { gap_id: 'feed3333face4444', kind: 'assumption', action: 'confirmed', adr_id: 'adr-9' },
                    ],
                },
            },
        ])

        const result = await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'gaps' })

        // A gap's id is a hash of its own wording, so re-generating a design strands the answers
        // that settled its questions. The server records them precisely so they are not dropped in
        // silence — and then this package dropped them in silence.
        expect(text(result)).toMatch(/2 earlier answer\(s\) do not match any question in this version/)
        expect(text(result)).toMatch(/Any Decision they minted still stands/)
        // Where an answer minted a Decision there is somewhere to look, so it is named. Where it
        // did not, there is no wording stored to show and a row would be an empty promise.
        expect(text(result)).toMatch(/\[assumption\] confirmed → Decision adr-9/)
        expect(text(result)).not.toMatch(/dead1111beef2222/)
        const data = result.structuredContent?.data as { orphaned_answers: unknown[] }
        expect(data.orphaned_answers).toHaveLength(2)
    })

    it('says nothing about stranded answers when there are none', async () => {
        await open([
            {
                match: `GET /api/v1/projects/${PROJECT_ID}/design-gaps`,
                body: {
                    project_id: PROJECT_ID,
                    architecture_id: ARCH_V2,
                    version: 2,
                    gaps: [],
                    unresolved_count: 0,
                    orphaned_answers: [],
                },
            },
        ])

        const result = await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'gaps' })

        expect(text(result)).not.toMatch(/earlier answer/)
    })
})

describe('a design whose gaps carry a recommendation', () => {
    it('parses rather than erroring, because the server is allowed to add things', async () => {
        // One row, served by both reads: the list chooses the version, the single read describes it.
        const row = {
            id: ARCH_V2,
            project_id: PROJECT_ID,
            version: 2,
            is_released: true,
            architecture_json: {
                ...DESIGN,
                // The newer shape, alongside the older one, exactly as a real
                // payload mixes them: `z.array(z.string())` here would have made a
                // richer design a *parse error* rather than a richer design.
                open_questions: [
                    { text: 'Which region?', recommendation: 'eu-west-1', options: ['eu-west-1', 'us-east-1'] },
                ],
                assumptions: ['Traffic is read-heavy.'],
            },
        }
        const api = fakeApi([
            {
                match: `GET /api/v1/projects/${PROJECT_ID}/architectures`,
                body: {
                    items: [row],
                    total: 1,
                },
            },
            { match: `GET /api/v1/projects/${PROJECT_ID}`, body: { id: PROJECT_ID, title: 'Shortener' } },
            { match: `GET /api/v1/architectures/${ARCH_V2}`, body: row },
        ])
        harness = await startHarness(api.fetch)

        const result = await harness.call('get_design', { project_id: PROJECT_ID, mode: 'overview' })

        expect(result.isError).toBeFalsy()
        expect(result.structuredContent?.version).toBe(2)
    })

    it('does not hand the agent the proposal for a question that is still open', async () => {
        await open([
            {
                match: `GET /api/v1/projects/${PROJECT_ID}/design-gaps`,
                body: {
                    project_id: PROJECT_ID,
                    architecture_id: ARCH_V2,
                    version: 2,
                    gaps: [{ gap_id: 'a1', kind: 'open_question', text: 'Which region?', resolved: false }],
                    unresolved_count: 1,
                },
            },
        ])

        const result = await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'gaps' })

        // The recommendation is the design's own guess at a question nobody has answered, and
        // this mode's whole instruction is "raise it, do not guess". Handing the agent a proposal
        // to adopt is that guess, one step removed. It is shown to the people who can decide —
        // the Grounding panel and the exported document — and to nobody who cannot.
        expect(text(result)).toMatch(/1 unresolved/)
        expect(text(result)).toMatch(/questions for a person/)
    })
})

describe('the build order', () => {
    it('says the order is not traffic direction, and shows what waits on what', async () => {
        await open([
            {
                match: `GET /api/v1/architectures/${ARCH_V2}/build-order`,
                body: {
                    architecture_id: ARCH_V2,
                    version: 2,
                    steps: [
                        { order: 1, component_id: 'db', name: 'Links Database', type: 'database', reason: 'State first.', depends_on: [] },
                        { order: 2, component_id: 'api', name: 'API Service', type: 'service', reason: 'Needs its stores.', depends_on: ['db'] },
                    ],
                    release: RELEASE_FACTS,
                },
            },
        ])

        const result = await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'build_order' })

        // The prose no longer disclaims the graph — it explains which way the graph points, which
        // is the thing that was actually wrong. An arrow is a call, so the callee is built first.
        expect(text(result)).toMatch(/follows the dependency graph/i)
        expect(text(result)).toMatch(/source calls the target, so the target is built first/i)
        expect(text(result)).toMatch(/1\. Links Database \(db\)/)
        expect(text(result)).toMatch(/\[after: db\]/)
    })

    it('never tells an agent to wait for something built later', async () => {
        // `depends_on` holds every dependency now, including the one the order could not honour.
        // Rendering all of them as "after" would send an agent to build a component after
        // something that comes later in the very list it is reading.
        await open([
            {
                match: `GET /api/v1/architectures/${ARCH_V2}/build-order`,
                body: {
                    architecture_id: ARCH_V2,
                    version: 2,
                    steps: [
                        { order: 1, component_id: 'payments', name: 'Payment Service', type: 'service', reason: 'Business logic.', depends_on: ['psp'], blocked_by: ['psp'] },
                        { order: 2, component_id: 'psp', name: 'External Payment Gateway', type: 'external', reason: 'Outside your control.', depends_on: ['payments'], blocked_by: [] },
                    ],
                    release: RELEASE_FACTS,
                },
            },
        ])

        const result = await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'build_order' })

        expect(text(result)).not.toMatch(/\[after: psp\]/)
        expect(text(result)).toMatch(/cycle: it calls psp, built later/)
        expect(text(result)).toMatch(/\[after: payments\]/)
    })
})

describe('project resolution', () => {
    it('returns the candidates rather than picking one', async () => {
        const api = fakeApi([
            {
                match: 'GET /api/v1/projects/',
                body: {
                    projects: [
                        { id: PROJECT_ID, title: 'Payments v1', architecture_count: 1 },
                        { id: ARCH_V3, title: 'Payments v2', architecture_count: 1 },
                    ],
                    total: 2,
                },
            },
        ])
        harness = await startHarness(api.fetch)

        const result = await harness.call('get_design', { project_id: 'Payments', mode: 'overview' })

        expect(result.isError).toBe(true)
        expect(text(result)).toMatch(/matches 2 SkeletIQ projects/)
        expect(text(result)).toMatch(/Payments v1/)
        expect(text(result)).toMatch(/Payments v2/)
    })

    it('takes an exact title match even when other titles contain the same words', async () => {
        const api = fakeApi([
            {
                match: 'GET /api/v1/projects/',
                body: {
                    projects: [
                        { id: PROJECT_ID, title: 'Payments', architecture_count: 1 },
                        { id: ARCH_V3, title: 'Payments v2', architecture_count: 1 },
                    ],
                    total: 2,
                },
            },
            { match: `GET /api/v1/projects/${PROJECT_ID}/architectures`, body: { items: [{ id: ARCH_V2, project_id: PROJECT_ID, version: 1, architecture_json: DESIGN, is_released: true }], total: 1 } },
            { match: `GET /api/v1/architectures/${ARCH_V2}`, body: { id: ARCH_V2, project_id: PROJECT_ID, version: 1, architecture_json: DESIGN, is_released: true } },
        ])
        harness = await startHarness(api.fetch)

        const result = await harness.call('get_design', { project_id: 'payments', mode: 'overview' })

        expect(result.isError).toBeFalsy()
        expect(result.structuredContent?.project_id).toBe(PROJECT_ID)
    })
})

function brief() {
    return {
        architecture_id: ARCH_V2,
        version: 2,
        is_draft: false,
        markdown: '<!-- skeletiq:brief:start project=x version=2 -->\n# Link shortener\n<!-- skeletiq:brief:end -->',
        release: RELEASE_FACTS,
    }
}

const PLATFORM_DESIGN = {
    ...DESIGN,
    components: [
        ...DESIGN.components,
        {
            id: 'waf',
            name: 'Edge WAF',
            type: 'service',
            layer: 'platform',
            platform_role: 'waf',
            platform_origin: 'realized',
            satisfies: ['edge.filtering'],
            policies: { rate_limit: true },
        },
    ],
    design_decisions: [...DESIGN.design_decisions, 'A WAF fronts the public API.'],
    platform_decisions: ['A WAF fronts the public API.'],
    bypassed_connections: [{ source: 'api', target: 'cache', protocol: 'tcp' }],
}

describe('the platform layer', () => {
    it('prints the platform part, the replaced connection and the platform decision', async () => {
        await open(designRoutes(PLATFORM_DESIGN))

        const overviewResult = await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'overview' })
        const overviewText = text(overviewResult)
        expect(overviewText).toMatch(/Connections the platform layer replaced:\n- api → cache/)
        expect(overviewText).toMatch(/- A WAF fronts the public API\. \(platform\)/)
        expect(overviewText).not.toMatch(/Postgres was chosen for the Links Database because the data is relational\. \(platform\)/)

        const componentResult = await harness!.call('get_design', {
            project_id: PROJECT_ID,
            mode: 'component',
            component_id: 'waf',
        })
        const componentText = text(componentResult)
        expect(componentText).toMatch(/Platform part \(added for you\): waf; satisfies edge\.filtering/)
        expect(componentText).toMatch(/Policies: rate_limit=true/)
    })

    it('shows an unknown role verbatim and caps the replaced list', async () => {
        const many = Array.from({ length: 12 }, (_, i) => ({ source: `s${i}`, target: `t${i}` }))
        await open(
            designRoutes({
                ...PLATFORM_DESIGN,
                bypassed_connections: many,
                components: [{ id: 'x', name: 'X', type: 'service', platform_role: 'quantum_gate' }],
            }),
        )

        const overviewText = text(await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'overview' }))
        expect(overviewText).toMatch(/- s9 → t9/)
        expect(overviewText).not.toMatch(/s10 → t10/)
        expect(overviewText).toMatch(/and 2 more/)

        const componentText = text(
            await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'component', component_id: 'x' }),
        )
        expect(componentText).toMatch(/Platform part: quantum_gate/)
    })

    it('spells out a nested policy value instead of [object Object]', async () => {
        await open(
            designRoutes({
                ...PLATFORM_DESIGN,
                components: [{ id: 'x', name: 'X', type: 'service', policies: { retention: { days: 30 } } }],
            }),
        )

        const componentText = text(
            await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'component', component_id: 'x' }),
        )
        expect(componentText).toMatch(/Policies: retention=\{"days":30\}/)
    })

    it('renders a design without platform fields as before', async () => {
        await open(designRoutes(DESIGN))

        const overviewText = text(await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'overview' }))
        const componentText = text(
            await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'component', component_id: 'api' }),
        )
        expect(overviewText).not.toMatch(/platform/i)
        expect(componentText).not.toMatch(/platform|Policies:/i)
    })
})

function text(result: { content: { text?: string }[] }): string {
    return result.content.map((block) => block.text ?? '').join('\n')
}
