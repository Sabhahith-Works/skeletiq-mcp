/**
 * Asking for a decision to change: filing, polling, and the three ways the server can refuse.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ARCH_V2, PROJECT_ID, baseRoutes, fakeApi, startHarness, type Harness, type ToolCallResult } from './harness.js'

let harness: Harness | undefined
afterEach(async () => {
    await harness?.close()
    harness = undefined
})

const REQUEST_ID = '44444444-4444-4444-4444-444444444444'

function requestBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: REQUEST_ID,
        project_id: PROJECT_ID,
        architecture_id: ARCH_V2,
        version: 2,
        decision_id: 'database.primary',
        decision_title: 'Primary database',
        proposed: 'Use DynamoDB',
        why: 'The access pattern is key-value.',
        evidence: [],
        status: 'pending',
        resolution_note: null,
        created_at: '2026-10-19T00:00:00Z',
        resolved_at: null,
        accepted_in_version: null,
        latest_version: 2,
        decision_current: true,
        schema_version: 1,
        ...overrides,
    }
}

const FILE_ARGS = {
    project_id: PROJECT_ID,
    version: 2,
    decision_id: 'database.primary',
    proposed: 'Use DynamoDB',
    why: 'The access pattern is key-value.',
}

function text(result: ToolCallResult): string {
    return result.content.map((block) => block.text ?? '').join('\n')
}

describe('filing a request', () => {
    it('posts the request and says a person decides', async () => {
        const api = fakeApi(
            baseRoutes([{ match: `POST /api/v1/architectures/${ARCH_V2}/decision-requests`, status: 201, body: requestBody() }]),
        )
        harness = await startHarness(api.fetch)

        const result = await harness.call('request_decision_change', FILE_ARGS)

        expect(result.isError).toBeFalsy()
        expect(result.structuredContent?.request_id).toBe(REQUEST_ID)
        expect(result.structuredContent?.status).toBe('pending')
        expect(text(result)).toContain('A person on the project reviews this in To-do; nothing changes until they accept.')
        const post = api.calls.find((call) => call.method === 'POST')
        expect(post?.body).toMatchObject({ decision_id: 'database.primary', proposed: 'Use DynamoDB', evidence: [] })
    })

    it('shows the same request when the server answers a repeat with the pending one', async () => {
        const api = fakeApi(
            baseRoutes([{ match: `POST /api/v1/architectures/${ARCH_V2}/decision-requests`, status: 201, body: requestBody() }]),
        )
        harness = await startHarness(api.fetch)

        const first = await harness.call('request_decision_change', FILE_ARGS)
        const second = await harness.call('request_decision_change', FILE_ARGS)

        expect(second.structuredContent?.request_id).toBe(first.structuredContent?.request_id)
        expect(second.structuredContent?.status).toBe('pending')
    })

    it('sends the path and outcome of evidence, never the quote', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'skq-decision-'))
        try {
            await writeFile(path.join(root, 'store.ts'), 'const table = "single-table-design-marker"\n')
            const api = fakeApi(
                baseRoutes([{ match: `POST /api/v1/architectures/${ARCH_V2}/decision-requests`, status: 201, body: requestBody() }]),
            )
            harness = await startHarness(api.fetch)

            await harness.call('request_decision_change', {
                ...FILE_ARGS,
                repo_root: root,
                evidence: [{ path: 'store.ts', quote: 'single-table-design-marker' }],
            })

            const post = api.calls.find((call) => call.method === 'POST')
            expect(post?.body).toMatchObject({ evidence: [{ path: 'store.ts', status: 'verified' }] })
            expect(JSON.stringify(post?.body)).not.toContain('single-table-design-marker')
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    it('asks for the missing fields rather than posting', async () => {
        const api = fakeApi(baseRoutes())
        harness = await startHarness(api.fetch)

        const result = await harness.call('request_decision_change', { project_id: PROJECT_ID })

        expect(result.isError).toBe(true)
        expect(text(result)).toMatch(/decision_id, proposed and why/)
        expect(api.calls.some((call) => call.method === 'POST')).toBe(false)
    })
})

describe('polling a request', () => {
    it('reports a pending request', async () => {
        const api = fakeApi(baseRoutes([{ match: `GET /api/v1/decision-requests/${REQUEST_ID}`, body: requestBody() }]))
        harness = await startHarness(api.fetch)

        const result = await harness.call('request_decision_change', { request_id: REQUEST_ID })

        expect(result.structuredContent?.status).toBe('pending')
        expect(text(result)).toMatch(/pending/)
        expect(text(result)).toMatch(/nothing changes until they accept/)
    })

    it('says where an accepted request landed and that the design is not changed yet', async () => {
        const api = fakeApi(
            baseRoutes([
                {
                    match: `GET /api/v1/decision-requests/${REQUEST_ID}`,
                    body: requestBody({ status: 'accepted', accepted_in_version: 3, latest_version: 3 }),
                },
            ]),
        )
        harness = await startHarness(api.fetch)

        const result = await harness.call('request_decision_change', { request_id: REQUEST_ID })

        expect(result.structuredContent?.accepted_in_version).toBe(3)
        expect(text(result)).toContain(
            'accepted at v3; the design changes when the follow-up turn completes (latest is v3)',
        )
    })

    it('points at the newer version once one exists rather than saying it is still waiting', async () => {
        const api = fakeApi(
            baseRoutes([
                {
                    match: `GET /api/v1/decision-requests/${REQUEST_ID}`,
                    body: requestBody({ status: 'accepted', accepted_in_version: 3, latest_version: 4 }),
                },
            ]),
        )
        harness = await startHarness(api.fetch)

        const result = await harness.call('request_decision_change', { request_id: REQUEST_ID })

        expect(text(result)).toContain('accepted at v3; v4 is newer — read its decisions with get_design')
        expect(text(result)).not.toMatch(/when the follow-up turn completes/)
    })

    it('does not invent the landing version when the server omits it', async () => {
        const api = fakeApi(
            baseRoutes([
                {
                    match: `GET /api/v1/decision-requests/${REQUEST_ID}`,
                    body: requestBody({ status: 'accepted', accepted_in_version: null, latest_version: 4 }),
                },
            ]),
        )
        harness = await startHarness(api.fetch)

        const result = await harness.call('request_decision_change', { request_id: REQUEST_ID })

        expect(text(result)).toContain('accepted; the server did not say which version it landed in (latest is v4)')
        expect(text(result)).not.toMatch(/accepted at v/)
    })

    it('reports a dismissal with the reviewer note', async () => {
        const api = fakeApi(
            baseRoutes([
                {
                    match: `GET /api/v1/decision-requests/${REQUEST_ID}`,
                    body: requestBody({ status: 'dismissed', resolution_note: 'We keep Postgres.' }),
                },
            ]),
        )
        harness = await startHarness(api.fetch)

        const result = await harness.call('request_decision_change', { request_id: REQUEST_ID })

        expect(text(result)).toMatch(/dismissed/)
        expect(text(result)).toContain('We keep Postgres.')
    })
})

describe('refusals', () => {
    it('says the server does not take decision requests on a 404', async () => {
        const api = fakeApi(
            baseRoutes([
                {
                    match: `POST /api/v1/architectures/${ARCH_V2}/decision-requests`,
                    status: 404,
                    body: { error: { code: 'NOT_FOUND', message: 'Resource not found' } },
                },
            ]),
        )
        harness = await startHarness(api.fetch)

        const result = await harness.call('request_decision_change', FILE_ARGS)

        expect(result.isError).toBe(true)
        expect(text(result)).toBe('This SkeletIQ server does not take decision requests yet.')
    })

    it('says the request is unknown when a poll names an id the server does not have', async () => {
        const api = fakeApi(
            baseRoutes([
                {
                    match: `GET /api/v1/decision-requests/${REQUEST_ID}`,
                    status: 404,
                    body: { error: { code: 'NOT_FOUND', message: 'Decision request not found' } },
                },
            ]),
        )
        harness = await startHarness(api.fetch)

        const result = await harness.call('request_decision_change', { request_id: REQUEST_ID })

        expect(result.isError).toBe(true)
        expect(text(result)).toBe(
            `There is no decision request ${REQUEST_ID} on this server. Check the id; ` +
                'a request is removed when its project is deleted.',
        )
    })

    it('says the server does not take decision requests when a poll 404s for another reason', async () => {
        const api = fakeApi(
            baseRoutes([
                {
                    match: `GET /api/v1/decision-requests/${REQUEST_ID}`,
                    status: 404,
                    body: { error: { code: 'NOT_FOUND', message: 'Resource not found' } },
                },
            ]),
        )
        harness = await startHarness(api.fetch)

        const result = await harness.call('request_decision_change', { request_id: REQUEST_ID })

        expect(text(result)).toBe('This SkeletIQ server does not take decision requests yet.')
    })

    it('passes the server message on a 409', async () => {
        const message = 'This project already has 10 pending agent requests; ask a person to review them in To-do.'
        const api = fakeApi(
            baseRoutes([
                {
                    match: `POST /api/v1/architectures/${ARCH_V2}/decision-requests`,
                    status: 409,
                    body: { error: { code: 'CONFLICT', message } },
                },
            ]),
        )
        harness = await startHarness(api.fetch)

        const result = await harness.call('request_decision_change', FILE_ARGS)

        expect(result.isError).toBe(true)
        expect(text(result)).toBe(message)
    })
})
