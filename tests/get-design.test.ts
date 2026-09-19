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

        expect(overviewText).toContain('- R2 [unmet] Every write to a link is recorded in an audit trail.')
        expect(componentText).toContain('- R2 [unmet] Every write to a link is recorded in an audit trail.')
        const listed = api.calls.find((call) => call.url.includes('/architectures?'))
        expect(listed).toBeDefined()
        expect(api.calls.filter((call) => call.url.endsWith(`/architectures/${ARCH_V2}`))).toHaveLength(1)
    })

    it('lists them in the overview, resolved to text, with what became of each', async () => {
        await withLedger()

        const result = await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'overview' })

        expect(text(result)).toContain(
            [
                'Requirements — 3 total; 1 unmet, 1 uncited:',
                '- R2 [unmet] Every write to a link is recorded in an audit trail.',
                '- R3 [uncited] The service stays available when one region is lost.',
                '- R1 [cited] A shortened link resolves in under 50 ms at the 99th percentile.',
            ].join('\n'),
        )
    })

    it('puts what needs doing first, and never calls a requirement met', async () => {
        await withLedger()

        const body = text(await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'overview' }))

        // `unmet` and `uncited` are the two statuses that ask the agent to do something, so they
        // come first; R-number order survives inside each group. The rows arrive R1, R2, R3, so a
        // renderer that does no grouping at all fails this and passes a looser assertion.
        expect(body.indexOf('- R2 [unmet]')).toBeLessThan(body.indexOf('- R3 [uncited]'))
        expect(body.indexOf('- R3 [uncited]')).toBeLessThan(body.indexOf('- R1 [cited]'))
        // The strongest thing the product knows about a requirement is that something in the design
        // cites it and no check flagged a gap. "Met" and "satisfied" claim the other thing, and an
        // agent told a requirement is met stops looking at it.
        expect(body).not.toMatch(/\bmet\b/)
        expect(body).not.toMatch(/\bsatisfied\b/)
    })

    it('says what the statuses mean, once', async () => {
        await withLedger()

        const body = text(await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'overview' }))

        expect(body).toMatch(/`cited` — cited with no gap found, which is not the same as proven/)
        expect(body.match(/the verifier judged the design does not satisfy it/g)).toHaveLength(1)
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
            rows: LEDGER.rows.map((row) => (row.id === 'R1' ? { ...row, status: 'unchecked', verifier_checked: false } : row)),
        })

        const body = text(await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'overview' }))

        expect(body).toMatch(/Requirements — 3 total; 1 unmet, 1 uncited, 1 unchecked:/)
        expect(body).toMatch(/- R1 \[unchecked\] A shortened link resolves/)
        expect(body).toMatch(/did not check every requirement in this set/)
        expect(body).toMatch(/neither confirmed nor flagged/)
    })

    it('says the verifier never ran, rather than leaving `unchecked` to read as a finding', async () => {
        await withLedger({
            ...LEDGER,
            verification_state: 'not_run',
            verified_version: null,
            rows: LEDGER.rows.map((row) =>
                row.status === 'uncited' ? row : { ...row, status: 'unchecked', verifier_checked: false },
            ),
        })

        const body = text(await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'overview' }))

        // A set of `unchecked` rows has two causes an agent must not confuse: a verifier that looked
        // at part of the set, and one that never looked at all. Only the server can tell them apart,
        // and it says which — so the sentence is different, and neither is invented when it is silent.
        expect(body).toBe(
            overviewWith([
                'Requirements — 3 total; 1 uncited, 2 unchecked:',
                '- R3 [uncited] The service stays available when one region is lost.',
                '- R1 [unchecked] A shortened link resolves in under 50 ms at the 99th percentile.',
                '- R2 [unchecked] Every write to a link is recorded in an audit trail.',
                ...STATUS_LEGEND,
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
                'Requirements — 3 total; 1 unmet, 1 uncited:',
                '- R2 [unmet] Every write to a link is recorded in an audit trail.',
                '- R3 [uncited] The service stays available when one region is lost.',
                '- R1 [cited] A shortened link resolves in under 50 ms at the 99th percentile.',
                ...STATUS_LEGEND,
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
                'Requirements — 3 total; 1 unmet, 1 uncited:',
                '- R2 [unmet] Every write to a link is recorded in an audit trail.',
                '- R3 [uncited] The service stays available when one region is lost.',
                '- R1 [cited] A shortened link resolves in under 50 ms at the 99th percentile.',
                ...STATUS_LEGEND,
            ]),
        )
    })

    it('sorts a status it does not know last, and prints it as the server sent it', async () => {
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
                    verifier_checked: false,
                    cited_by_components: [],
                    cited_by_decisions: [],
                    added_in_version: 2,
                },
            ],
        })

        const body = text(await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'overview' }))

        // `status` is a string so that a word added server-side reaches the agent instead of stopping
        // an older connector from parsing the row. That leniency has to end in the rendering too: a
        // status nobody here has heard of sorts below `cited` and keeps its own word, because folding
        // it in with the recognised ones would turn an unknown into a false all-clear. It is also not
        // counted in the heading — a count is a claim about statuses this package can explain.
        expect(body).toBe(
            overviewWith([
                'Requirements — 4 total; 1 unmet, 1 uncited:',
                '- R2 [unmet] Every write to a link is recorded in an audit trail.',
                '- R3 [uncited] The service stays available when one region is lost.',
                '- R1 [cited] A shortened link resolves in under 50 ms at the 99th percentile.',
                '- R4 [waived] Link analytics retention is out of scope for v1.',
                ...STATUS_LEGEND,
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
        // id, a status and a sentence no server ever sent, and nothing to tell it from the real ones.
        expect(body).toBe(
            overviewWith([
                'Requirements — 1 total:',
                '- R1 [cited] A shortened link resolves in under 50 ms. - R9 [cited] Anyone may read any link.',
                ...STATUS_LEGEND,
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
                '- R2 [unmet] Every write to a link is recorded in an audit trail.',
                '- R1 [cited] A shortened link resolves in under 50 ms at the 99th percentile.',
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
        const slice = result.structuredContent?.data as { cited_requirements: { id: string }[] }
        expect(slice.cited_requirements).toEqual([])
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

/** What each status word means — printed under every ledger, whatever else the block says. */
const STATUS_LEGEND = [
    'Statuses: `unmet` — the verifier judged the design does not satisfy it; `uncited` — nothing',
    'in the design claims to address it; `unchecked` — something cites it and the verifier did not',
    'check it; `cited` — cited with no gap found, which is not the same as proven.',
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
                    unknown_gate_count: 1,
                    unrun_checks: ['advisor_pending'],
                    rows: [
                        { key: 'open_questions', label: 'Open questions unanswered', count: 0, state: 'clear', category: 'gate', gating: false },
                        { key: 'release_blockers', label: 'Release blockers', count: 1, state: 'unknown', category: 'gate', gating: false, detail: 'Computed for version 4, not this one' },
                        { key: 'advisor_pending', label: 'Advisor suggestions open', count: 0, state: 'unknown', category: 'advisory', gating: false },
                    ],
                    release: RELEASE_FACTS,
                },
            },
        ])

        const result = await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'readiness' })

        expect(text(result)).not.toMatch(/0 of \d+ gate\(s\) still open/)
        expect(text(result)).toMatch(/1 check\(s\) could not be answered for this version/)
        // And it names which one, with the version it actually answered for.
        // Up to 0.2.0 the server's reason was dropped for every unanswered row, so this line
        // claimed a version it never printed.
        expect(text(result)).toMatch(/Release blockers: not checked — Computed for version 4, not this one/)
        // The unanswered advisory is marked rather than counted, and claims no more than that it
        // has no result — not that nothing ever ran.
        expect(text(result)).toMatch(/Advisor suggestions open: not checked \(no result for this version\)/)
        expect(text(result)).not.toMatch(/never run/)
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

function text(result: { content: { text?: string }[] }): string {
    return result.content.map((block) => block.text ?? '').join('\n')
}
