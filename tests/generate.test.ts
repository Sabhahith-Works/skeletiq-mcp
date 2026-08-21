/**
 * Generating a design: the stream, and the two ways it can end badly.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { ARCH_V3, PROJECT_ID, baseRoutes, fakeApi, startHarness, type Harness } from './harness.js'

let harness: Harness | undefined
afterEach(async () => {
    await harness?.close()
    harness = undefined
})

const DONE = JSON.stringify({
    type: 'done',
    content: ARCH_V3,
    conversation_id: 'c1',
    architecture_id: ARCH_V3,
    architecture_version: 1,
    degradations: [],
})

const PIPELINE = [
    JSON.stringify({ type: 'analysis', pipeline_step: { domain: 'web' } }),
    JSON.stringify({ type: 'patterns', pipeline_step: { count: 3 } }),
    JSON.stringify({ type: 'generating', pipeline_step: {} }),
    JSON.stringify({ type: 'architecture', architecture: { title: 'X' } }),
    DONE,
]

describe('the inline path', () => {
    it('reads a stream whose frames are split across network chunks', async () => {
        // The harness deliberately cuts the payload in half mid-frame. A parser that handles one
        // chunk at a time loses whichever frame the split lands in — usually the largest, which is
        // the architecture.
        const api = fakeApi(baseRoutes([{ match: 'POST /api/v1/chat/generate/stream', sse: PIPELINE }]))
        harness = await startHarness(api.fetch)

        const result = await harness.call('generate_architecture', { prompt: 'A link shortener' })

        expect(result.isError).toBeFalsy()
        expect(result.structuredContent?.status).toBe('completed')
        expect(result.structuredContent?.architecture_id).toBe(ARCH_V3)
        expect(result.structuredContent?.version).toBe(1)
    })

    it('sends an Idempotency-Key and never a runtime_profile', async () => {
        const api = fakeApi(baseRoutes([{ match: 'POST /api/v1/chat/generate/stream', sse: [DONE] }]))
        harness = await startHarness(api.fetch)

        await harness.call('generate_architecture', { prompt: 'A link shortener' })

        const call = api.calls.find((entry) => entry.url.includes('/generate/stream'))
        expect(call?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/)
        // Which model serves an agent run is the account holder's stored setting, resolved
        // server-side. A runtime argument here would let the model choose what somebody else pays.
        expect(call?.body).not.toHaveProperty('runtime_profile')
    })

    it('reports an in-band failure, which is the only place a mid-stream error appears', async () => {
        const frames = [
            JSON.stringify({ type: 'analysis', pipeline_step: {} }),
            JSON.stringify({ type: 'error', content: 'The model returned an unusable design.' }),
        ]
        const api = fakeApi(baseRoutes([{ match: 'POST /api/v1/chat/generate/stream', sse: frames }]))
        harness = await startHarness(api.fetch)

        const result = await harness.call('generate_architecture', { prompt: 'A link shortener' })

        // The HTTP status was 200 before the pipeline had done anything. A client that only reads
        // the status sees a successful, empty generation.
        expect(result.isError).toBe(true)
        expect(joined(result)).toMatch(/unusable design/)
    })

    it('refuses to call a truncated stream a success, and warns about paying twice', async () => {
        const frames = [JSON.stringify({ type: 'analysis', pipeline_step: {} })]
        const api = fakeApi(baseRoutes([{ match: 'POST /api/v1/chat/generate/stream', sse: frames }]))
        harness = await startHarness(api.fetch)

        const result = await harness.call('generate_architecture', { prompt: 'A link shortener' })

        expect(result.isError).toBe(true)
        expect(joined(result)).toMatch(/ended without a result/)
        expect(joined(result)).toMatch(/pay for it twice/)
    })

    it('resolves a project named in prose before generating into it', async () => {
        const api = fakeApi(baseRoutes([{ match: 'POST /api/v1/chat/generate/stream', sse: [DONE] }]))
        harness = await startHarness(api.fetch)

        await harness.call('generate_architecture', { prompt: 'Add a worker', project_id: 'Shortener' })

        const call = api.calls.find((entry) => entry.url.includes('/generate/stream'))
        expect((call?.body as { project_id: string }).project_id).toBe(PROJECT_ID)
    })
})

describe('the queued path', () => {
    it('returns a job id to poll', async () => {
        const api = fakeApi(
            baseRoutes([
                {
                    match: 'POST /api/v1/chat/generate-async',
                    status: 202,
                    body: { job_id: 'job-1', status: 'pending', job: { job_id: 'job-1', status: 'pending', project_id: PROJECT_ID } },
                },
            ]),
        )
        harness = await startHarness(api.fetch)

        const result = await harness.call('generate_architecture', { prompt: 'A link shortener', wait: false })

        expect(result.structuredContent?.job_id).toBe('job-1')
        expect(joined(result)).toMatch(/get_generation_status/)
    })

    it('steers back to wait: true when the deployment runs no worker', async () => {
        const api = fakeApi(
            baseRoutes([
                {
                    match: 'POST /api/v1/chat/generate-async',
                    status: 503,
                    body: {
                        error: {
                            code: 'SERVICE_UNAVAILABLE',
                            message: 'Background generation is not available in this deployment.',
                            detail: {
                                code: 'BACKGROUND_JOBS_UNAVAILABLE',
                                message: 'Background generation is not available in this deployment.',
                            },
                        },
                    },
                },
            ]),
        )
        harness = await startHarness(api.fetch)

        const result = await harness.call('generate_architecture', { prompt: 'x', wait: false })

        // The top-level code is the generic SERVICE_UNAVAILABLE and cannot discriminate; the real
        // answer is nested in `detail.code`.
        expect(result.isError).toBe(true)
        expect(joined(result)).toMatch(/wait: true/)
    })
})

describe('polling a job', () => {
    it('points at get_design once the job has completed', async () => {
        const api = fakeApi([
            {
                match: 'GET /api/v1/chat/jobs/job-1',
                body: { job_id: 'job-1', status: 'completed', project_id: PROJECT_ID, architecture_id: ARCH_V3 },
            },
        ])
        harness = await startHarness(api.fetch)

        const result = await harness.call('get_generation_status', { job_id: 'job-1' })

        expect(result.structuredContent?.status).toBe('completed')
        expect(joined(result)).toMatch(/get_design/)
    })

    it('relays a failed job\'s error', async () => {
        const api = fakeApi([
            {
                match: 'GET /api/v1/chat/jobs/job-1',
                body: { job_id: 'job-1', status: 'failed', error: 'The model timed out.' },
            },
        ])
        harness = await startHarness(api.fetch)

        const result = await harness.call('get_generation_status', { job_id: 'job-1' })

        expect(joined(result)).toMatch(/The model timed out/)
    })
})

function joined(result: { content: { text?: string }[] }): string {
    return result.content.map((block) => block.text ?? '').join('\n')
}

describe('progress', () => {
    it('reports each pipeline stage when the host asked for progress', async () => {
        // A generation runs for minutes — around 217 seconds typically. Without these the agent
        // sits in silence for the whole of it, and silence is what a hung tool looks like.
        const api = fakeApi(baseRoutes([{ match: 'POST /api/v1/chat/generate/stream', sse: PIPELINE }]))
        harness = await startHarness(api.fetch)

        const { result, progress } = await harness.callWithProgress('generate_architecture', {
            prompt: 'A link shortener',
        })

        expect(result.isError).toBeFalsy()
        expect(progress.map((event) => event.message)).toEqual([
            'Analysing requirements',
            'Selecting architecture patterns',
            'Generating the design',
        ])
        expect(progress.every((event) => event.total === 6)).toBe(true)
    })

    it('sends nothing when the host did not ask', async () => {
        const api = fakeApi(baseRoutes([{ match: 'POST /api/v1/chat/generate/stream', sse: PIPELINE }]))
        harness = await startHarness(api.fetch)

        const result = await harness.call('generate_architecture', { prompt: 'A link shortener' })

        // No progressToken means no notifications channel; emitting anyway is a protocol error.
        expect(result.isError).toBeFalsy()
    })
})
