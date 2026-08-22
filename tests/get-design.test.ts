/**
 * Reading a design: which version, which slice, and what the answer says about itself.
 */

import { afterEach, describe, expect, it } from 'vitest'

import {
    ARCH_V2,
    ARCH_V3,
    DESIGN,
    PROJECT_ID,
    RELEASE_FACTS,
    baseRoutes,
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
        // The list already carries `architecture_json`, so the slices never re-read the design.
        expect(api.calls.filter((call) => call.url.endsWith(`/architectures/${ARCH_V2}`))).toHaveLength(0)
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

describe('the brief', () => {
    it('tells the agent to replace the fence rather than append to it', async () => {
        await open([{ match: `GET /api/v1/architectures/${ARCH_V2}/brief`, body: brief() }])

        const result = await harness!.call('get_design', { project_id: PROJECT_ID, mode: 'brief' })

        expect(text(result)).toMatch(/REPLACE it whole/)
        expect(text(result)).toMatch(/Never append a second one/)
        expect(text(result)).toContain('skeletiq:brief:start')
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

describe('a design whose gaps carry a recommendation', () => {
    it('parses rather than erroring, because the server is allowed to add things', async () => {
        const api = fakeApi([
            {
                match: `GET /api/v1/projects/${PROJECT_ID}/architectures`,
                body: {
                    items: [
                        {
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
                        },
                    ],
                    total: 1,
                },
            },
            { match: `GET /api/v1/projects/${PROJECT_ID}`, body: { id: PROJECT_ID, title: 'Shortener' } },
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

        expect(text(result)).toMatch(/not from\s+traffic direction/i)
        expect(text(result)).toMatch(/1\. Links Database \(db\)/)
        expect(text(result)).toMatch(/\[after: db\]/)
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
