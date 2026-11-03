/**
 * Drift: the two contracts that decide whether an agent keeps using the tool.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { PROJECT_ID, baseRoutes, driftRoute, fakeApi, startHarness, type Harness } from './harness.js'

let harness: Harness | undefined
afterEach(async () => {
    await harness?.close()
    harness = undefined
})

describe('scope', () => {
    it('reports uncovered components as elsewhere, and says that is not drift', async () => {
        const api = fakeApi(
            baseRoutes([
                driftRoute({
                    in_sync: true,
                    elsewhere: [{ id: 'cache', name: 'Hot Links Cache', type: 'cache' }],
                    counts: { elsewhere: 1, missing: 0 },
                }),
            ]),
        )
        harness = await startHarness(api.fetch)

        const result = await harness.call('check_drift', {
            project_id: PROJECT_ID,
            covers: ['api', 'db'],
            components: [
                { id: 'api', status: 'implemented' },
                { id: 'db', status: 'implemented' },
            ],
        })

        // A repo implementing three of twelve components must not report nine failures on a green
        // build. The second time that happens the agent stops believing the tool.
        expect(result.structuredContent?.in_sync).toBe(true)
        expect(joined(result)).toMatch(/In sync/)
        expect(joined(result)).toMatch(/outside this repository's declared scope/)
        expect(joined(result)).toMatch(/That is not drift/)
    })

    it('passes covers through untouched', async () => {
        const api = fakeApi(baseRoutes([driftRoute({ in_sync: true })]))
        harness = await startHarness(api.fetch)

        await harness.call('check_drift', {
            project_id: PROJECT_ID,
            covers: ['api'],
            components: [{ id: 'api', name: 'API Service', status: 'partial', note: 'no auth yet' }],
        })

        const call = api.calls.find((entry) => entry.url.includes('drift-check'))
        expect(call?.body).toMatchObject({
            covers: ['api'],
            components: [{ id: 'api', name: 'API Service', status: 'partial', note: 'no auth yet' }],
        })
    })
})

describe('what the design does not have', () => {
    it('names the extras in the structured half as well as the text', async () => {
        const extraComponent = { name: 'Rate Limit Redis', type: 'cache', technology: 'Redis' }
        const extraConnection = { source: 'api', target: 'Rate Limit Redis', protocol: 'Redis' }
        const api = fakeApi(
            baseRoutes([
                driftRoute({
                    extra_components: [extraComponent],
                    extra_connections: [extraConnection],
                    counts: { extra_components: 1, extra_connections: 1 },
                }),
            ]),
        )
        harness = await startHarness(api.fetch)

        const result = await harness.call('check_drift', {
            project_id: PROJECT_ID,
            components: [{ id: 'api', status: 'partial' }],
            extra_components: [extraComponent],
            extra_connections: [extraConnection],
        })

        // A host may hand the model only the structured half, and a count alone doesn't say what
        // to remove or to add to the design.
        expect(result.structuredContent?.extra_components).toEqual([extraComponent])
        expect(result.structuredContent?.extra_connections).toEqual([extraConnection])
        expect(joined(result)).toMatch(/In the code but not the design: Rate Limit Redis/)
        expect(joined(result)).toMatch(/Connections the design does not have: api → Rate Limit Redis/)
    })
})

describe('stale ids', () => {
    it('offers suggestions and refuses to treat them as a mapping', async () => {
        const api = fakeApi(
            baseRoutes([
                driftRoute({
                    unknown_ids: [
                        {
                            id: 'user_svc',
                            suggestions: [{ id: 'user_service', name: 'User Service', type: 'service' }],
                        },
                    ],
                    counts: { unknown_ids: 1 },
                }),
            ]),
        )
        harness = await startHarness(api.fetch)

        const result = await harness.call('check_drift', {
            project_id: PROJECT_ID,
            components: [{ id: 'user_svc', status: 'implemented' }],
        })

        expect(joined(result)).toMatch(/Ids are minted per version/)
        expect(joined(result)).toMatch(/User Service \(user_service\)/)
        expect(joined(result)).toMatch(/confirm with a person/)
        // The mapping is never applied on the client's behalf.
        const unknown = result.structuredContent?.unknown_ids as { id: string }[]
        expect(unknown[0]?.id).toBe('user_svc')
    })

    it('says so plainly when nothing resembles the dead id', async () => {
        const api = fakeApi(
            baseRoutes([driftRoute({ unknown_ids: [{ id: 'gone', suggestions: [] }], counts: { unknown_ids: 1 } })]),
        )
        harness = await startHarness(api.fetch)

        const result = await harness.call('check_drift', {
            project_id: PROJECT_ID,
            components: [{ id: 'gone', status: 'implemented' }],
        })

        expect(joined(result)).toMatch(/nothing similar in this version/)
    })
})

describe('the report', () => {
    it('keeps missing, half-built and unmentioned as three different claims', async () => {
        const api = fakeApi(
            baseRoutes([
                driftRoute({
                    missing: [{ id: 'db', name: 'Links Database', type: 'database' }],
                    partial: [{ id: 'api', name: 'API Service', type: 'service' }],
                    unreported: [{ id: 'cache', name: 'Hot Links Cache', type: 'cache' }],
                    counts: { missing: 1, partial: 1, unreported: 1 },
                }),
            ]),
        )
        harness = await startHarness(api.fetch)

        const result = await harness.call('check_drift', {
            project_id: PROJECT_ID,
            components: [
                { id: 'api', status: 'partial' },
                { id: 'db', status: 'not_started' },
            ],
        })

        const report = joined(result)
        expect(report).toMatch(/Not started \(1\): Links Database \(db\)/)
        expect(report).toMatch(/Half built \(1\): API Service \(api\)/)
        expect(report).toMatch(/You did not mention \(1\): Hot Links Cache \(cache\)/)
    })

    it('prints the true unverified count beside a capped list', async () => {
        const api = fakeApi(
            baseRoutes([
                driftRoute({
                    unverified: [{ id: 'db', name: 'Links Database', type: 'database' }],
                    counts: { unverified: 3 },
                }),
            ]),
        )
        harness = await startHarness(api.fetch)

        const result = await harness.call('check_drift', {
            project_id: PROJECT_ID,
            components: [{ id: 'db', status: 'implemented' }],
        })

        const report = joined(result)
        expect(report).toContain('Unverified (3)')
        expect(report).toContain('and 2 more')
    })

    it('prints the true count beside a truncated list', async () => {
        // Every list the server sends is capped at fifty. Printing the list without its count is
        // how a truncated inventory comes to read as a complete one.
        const api = fakeApi(
            baseRoutes([
                driftRoute({
                    missing: [{ id: 'a', name: 'A', type: 'service' }],
                    counts: { missing: 63 },
                }),
            ]),
        )
        harness = await startHarness(api.fetch)

        const result = await harness.call('check_drift', {
            project_id: PROJECT_ID,
            components: [{ id: 'a', status: 'not_started' }],
        })

        expect(joined(result)).toMatch(/Not started \(63\)/)
        expect(joined(result)).toMatch(/and 62 more/)
    })

    it('diffs against the version the agent names, not the newest one', async () => {
        const api = fakeApi(
            baseRoutes([
                driftRoute({ in_sync: true }),
                {
                    match: '/api/v1/architectures/33333333-3333-3333-3333-333333333333/drift-check',
                    body: { error: { code: 'BAD', message: 'wrong version' } },
                    status: 400,
                },
            ]),
        )
        harness = await startHarness(api.fetch)

        const result = await harness.call('check_drift', {
            project_id: PROJECT_ID,
            version: 2,
            components: [{ id: 'api', status: 'implemented' }],
        })

        expect(result.isError).toBeFalsy()
        expect(result.structuredContent?.version).toBe(2)
        expect(result.structuredContent?.resolved_by).toBe('requested')
    })
})

function joined(result: { content: { text?: string }[] }): string {
    return result.content.map((block) => block.text ?? '').join('\n')
}

describe('local evidence', () => {
    it('sends the path and outcome of evidence and never the quote', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'drift-'))
        try {
            await writeFile(path.join(dir, 'svc.ts'), 'export function handleLinks() {}')
            const api = fakeApi(baseRoutes([driftRoute({ in_sync: true, evidence_checked: true })]))
            harness = await startHarness(api.fetch)

            const result = await harness.call('check_drift', {
                project_id: PROJECT_ID,
                repo_root: dir,
                components: [
                    {
                        id: 'api',
                        status: 'implemented',
                        evidence: [
                            { path: 'svc.ts', quote: 'SECRET-QUOTE-TEXT' },
                            { path: 'svc.ts', symbol: 'handleLinks' },
                        ],
                    },
                ],
                fitness: [{ test_id: 't1', status: 'pass', test_path: 'svc.ts', quote: 'SECRET-QUOTE-TEXT' }],
            })

            const call = api.calls.find((entry) => entry.url.includes('drift-check'))
            const body = JSON.stringify(call?.body)
            expect(body).not.toContain('quote')
            expect(body).not.toContain('SECRET-QUOTE-TEXT')
            expect(body).not.toContain('handleLinks')
            expect(call?.body).toMatchObject({
                components: [
                    {
                        evidence: [
                            { path: 'svc.ts', status: 'failed' },
                            { path: 'svc.ts', status: 'verified' },
                        ],
                    },
                ],
            })
            expect(joined(result)).toContain('Checked against')
            expect(joined(result)).not.toMatch(/does not check evidence yet/)
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })

    it('says the server does not check evidence when evidence_checked is absent', async () => {
        const api = fakeApi(baseRoutes([driftRoute({ in_sync: true })]))
        harness = await startHarness(api.fetch)

        const result = await harness.call('check_drift', {
            project_id: PROJECT_ID,
            components: [{ id: 'api', status: 'implemented' }],
        })

        expect(joined(result)).toContain(
            'This SkeletIQ server does not check evidence yet; these are unverified claims.',
        )
    })

    it('notes a newer agent schema only when the server reports one', async () => {
        const newer = fakeApi(baseRoutes([driftRoute({ in_sync: true, evidence_checked: true, schema_version: 3 })]))
        harness = await startHarness(newer.fetch)
        const ahead = await harness.call('check_drift', { project_id: PROJECT_ID, components: [] })
        expect(joined(ahead)).toContain('A newer @skeletiq/mcp understands more of this server')
        await harness.close()

        const same = fakeApi(baseRoutes([driftRoute({ in_sync: true, evidence_checked: true, schema_version: 2 })]))
        harness = await startHarness(same.fetch)
        const current = await harness.call('check_drift', { project_id: PROJECT_ID, components: [] })
        expect(joined(current)).not.toContain('A newer @skeletiq/mcp')
    })

    it('errors without sending anything when repo_root cannot be read', async () => {
        const api = fakeApi(baseRoutes([driftRoute({ in_sync: true })]))
        harness = await startHarness(api.fetch)

        const result = await harness.call('check_drift', {
            project_id: PROJECT_ID,
            repo_root: '/nonexistent/skeletiq-root',
            components: [{ id: 'api', status: 'implemented' }],
        })

        expect(result.isError).toBe(true)
        expect(joined(result)).toContain('repo_root /nonexistent/skeletiq-root cannot be read')
        expect(api.calls.some((entry) => entry.url.includes('drift-check'))).toBe(false)
    })
})
