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
    JSON.stringify({
        type: 'analysis',
        pipeline_step: { domain: 'web', requests_per_second: 4000, scale_source: 'llm_inferred' },
    }),
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

    it('reports the project it wrote to, so the agent can open what it just paid for', async () => {
        const api = fakeApi(baseRoutes([{ match: 'POST /api/v1/chat/generate/stream', sse: [DONE] }]))
        harness = await startHarness(api.fetch)

        const result = await harness.call('generate_architecture', { prompt: 'A link shortener' })

        // The `done` frame names an architecture and no project, and `get_design` takes a project
        // and nothing else. Without this the agent is left holding an id it cannot spend.
        expect(result.structuredContent?.project_id).toBe(PROJECT_ID)
        expect(result.structuredContent?.title).toBe('Link shortener')
        expect(result.structuredContent?.component_count).toBe(3)
        expect(joined(result)).toContain(`get_design(project_id: "${PROJECT_ID}")`)

        // Through the resolver, so the read that follows is cached rather than fetched again.
        expect(api.calls.filter((entry) => entry.url.endsWith(`/architectures/${ARCH_V3}`))).toHaveLength(1)
    })

    it('keeps a completed run completed when the token cannot read the design back', async () => {
        const api = fakeApi(
            baseRoutes([
                { match: 'POST /api/v1/chat/generate/stream', sse: [DONE] },
                {
                    match: `GET /api/v1/architectures/${ARCH_V3}`,
                    status: 403,
                    body: { error: { code: 'INSUFFICIENT_SCOPE', message: 'Needs the read scope.' } },
                },
            ]),
        )
        harness = await startHarness(api.fetch)

        const result = await harness.call('generate_architecture', { prompt: 'A link shortener' })

        // A token with `generate` but not `read` is refused this lookup. The design exists and has
        // been charged for; calling that a failed generation is what makes an agent pay twice.
        expect(result.isError).toBeFalsy()
        expect(result.structuredContent?.status).toBe('completed')
        expect(result.structuredContent?.architecture_id).toBe(ARCH_V3)
        expect(result.structuredContent?.project_id).toBeNull()
        expect(joined(result)).toMatch(/list_projects/)
    })

    it('does not go looking for a project when the run produced no design', async () => {
        const prose = JSON.stringify({ type: 'done', content: '', conversation_id: 'c1', architecture_id: null })
        const api = fakeApi(baseRoutes([{ match: 'POST /api/v1/chat/generate/stream', sse: [prose] }]))
        harness = await startHarness(api.fetch)

        const result = await harness.call('generate_architecture', { prompt: 'A link shortener' })

        expect(result.structuredContent?.architecture_id).toBeNull()
        expect(api.calls.some((entry) => entry.url.includes('/api/v1/architectures/'))).toBe(false)
        // Pointing an agent at a design that was never written is the same dead end in reverse.
        expect(joined(result)).not.toMatch(/get_design/)
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

/**
 * The honesty gate, from the far side of the wire.
 *
 * A prompt that names no system is refused before anything runs. What matters here is that the
 * refusal arrives as *questions* rather than as a sentence: an agent that is told "this needs
 * more detail" and not which detail has nothing to do but call again identically.
 */
const CLARIFY_409 = {
    error: {
        code: 'CONFLICT',
        message: 'This prompt needs a few details before we can design it well.',
        request_id: 'req-1',
        detail: {
            intent: 'new_architecture',
            confidence: 0.9,
            new_project_recommended: false,
            can_continue_here: true,
            reason: 'This prompt needs a few details before we can design it well.',
            uses_existing_architecture: false,
            response_mode: 'architecture',
            clarifying_questions: [
                {
                    id: 'domain',
                    question: "What are you building? Describe the system's core purpose in a sentence.",
                    why: 'Grounding the design in a concrete domain lets it reflect real requirements.',
                    kind: 'domain',
                    options: ['A marketplace', 'Not sure yet'],
                    decline_options: ['Not sure yet'],
                },
                {
                    id: 'scale',
                    question: 'Roughly how many users or requests should it handle?',
                    why: 'Scale decides the tier.',
                    kind: 'scale',
                },
            ],
        },
    },
}

describe('a prompt too vague to design from', () => {
    it('returns the questions as data rather than as a failure', async () => {
        const api = fakeApi(
            baseRoutes([{ match: 'POST /api/v1/chat/generate/stream', status: 409, body: CLARIFY_409 }]),
        )
        harness = await startHarness(api.fetch)

        const result = await harness.call('generate_architecture', { prompt: 'build me an app' })

        // Not an error: nothing failed and nothing was charged. And an error result may carry no
        // structuredContent at all, which is where the questions live.
        expect(result.isError).toBeFalsy()
        expect(result.structuredContent?.status).toBe('clarification_required')
        const questions = result.structuredContent?.clarifying_questions as { id: string }[]
        expect(questions.map((question) => question.id)).toEqual(['domain', 'scale'])
        expect(joined(result)).toMatch(/clarification_answers/)
    })

    it('leaves the decline options out of the examples it offers', async () => {
        const api = fakeApi(
            baseRoutes([{ match: 'POST /api/v1/chat/generate/stream', status: 409, body: CLARIFY_409 }]),
        )
        harness = await startHarness(api.fetch)

        const result = await harness.call('generate_architecture', { prompt: 'build me an app' })

        // "Not sure yet" is how a *person* says the dimension is unknown. Offered to an agent it
        // reads as a permitted answer, and the answers block is headed "treat as authoritative
        // requirements" — so sending it would design the system around the words "not sure yet".
        const questions = result.structuredContent?.clarifying_questions as { options: string[] }[]
        expect(questions[0]?.options).toEqual(['A marketplace'])
        expect(joined(result)).not.toMatch(/Not sure yet/)
    })

    it('refuses the queued path the same way it refuses the inline one', async () => {
        // The two endpoints take the same request and refuse it the same way. A recovery path
        // present on one and missing on the other is how a background run comes to lose what the
        // inline run honours.
        const api = fakeApi(
            baseRoutes([{ match: 'POST /api/v1/chat/generate-async', status: 409, body: CLARIFY_409 }]),
        )
        harness = await startHarness(api.fetch)

        const result = await harness.call('generate_architecture', { prompt: 'build me an app', wait: false })

        expect(result.isError).toBeFalsy()
        expect(result.structuredContent?.status).toBe('clarification_required')
        expect(result.structuredContent?.job_id).toBeNull()
    })

    it('still reports a 409 that carries no questions as the failure it is', async () => {
        // The same body carries a new-project recommendation, which is a different refusal with
        // nothing to answer. Reporting it as clarification_required would send the agent looking
        // for questions that are not there.
        const body = { error: { code: 'CONFLICT', message: 'Start a new project for this.', detail: { intent: 'new_architecture', new_project_recommended: true } } }
        const api = fakeApi(baseRoutes([{ match: 'POST /api/v1/chat/generate/stream', status: 409, body }]))
        harness = await startHarness(api.fetch)

        const result = await harness.call('generate_architecture', { prompt: 'A different system' })

        expect(result.isError).toBe(true)
        expect(joined(result)).toMatch(/Start a new project/)
    })

    it('carries the answers and the constraints on both transports', async () => {
        const api = fakeApi(
            baseRoutes([
                { match: 'POST /api/v1/chat/generate/stream', sse: [DONE] },
                {
                    match: 'POST /api/v1/chat/generate-async',
                    status: 202,
                    body: { job_id: 'job-2', status: 'pending' },
                },
            ]),
        )
        harness = await startHarness(api.fetch)

        const args = {
            prompt: 'A link shortener',
            clarification_answers: { domain: 'A URL shortener for a marketing team' },
            constraints: { read_write_mix: 'write_heavy', compliance: ['SOC2'] },
        }
        await harness.call('generate_architecture', args)
        await harness.call('generate_architecture', { ...args, wait: false })

        for (const path of ['/generate/stream', '/generate-async']) {
            const call = api.calls.find((entry) => entry.url.includes(path))
            expect(call?.body).toMatchObject({
                clarification_answers: { domain: 'A URL shortener for a marketing team' },
                constraints: { read_write_mix: 'write_heavy', compliance: ['SOC2'] },
            })
        }
    })

    it('sends neither key when the caller gave neither', async () => {
        // A caller that says nothing sends the body it sent before these two fields existed.
        // `sanitize_constraints` treats `{}` and absent alike, so nothing breaks either way —
        // but a request that grows keys nobody set is how a diff stops being readable.
        const api = fakeApi(baseRoutes([{ match: 'POST /api/v1/chat/generate/stream', sse: [DONE] }]))
        harness = await startHarness(api.fetch)

        await harness.call('generate_architecture', { prompt: 'A link shortener' })

        const call = api.calls.find((entry) => entry.url.includes('/generate/stream'))
        expect(call?.body).not.toHaveProperty('clarification_answers')
        expect(call?.body).not.toHaveProperty('constraints')
    })

    it('rejects a constraint key the server would silently drop', async () => {
        // `ALLOWED_CONSTRAINT_KEYS` is a whitelist and everything outside it is dropped with a log
        // line and no error. A validation failure the agent can read beats a constraint that
        // vanishes.
        const api = fakeApi(baseRoutes([{ match: 'POST /api/v1/chat/generate/stream', sse: [DONE] }]))
        harness = await startHarness(api.fetch)

        const result = await harness.call('generate_architecture', {
            prompt: 'A link shortener',
            constraints: { availability: '99.99%' },
        })

        expect(result.isError).toBe(true)
        expect(api.calls.some((entry) => entry.url.includes('/generate/stream'))).toBe(false)
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

/**
 * `POST /chat/generate-async` answers 202, so a refusal raised inside the worker arrives here
 * as a failed job rather than as the 409 the inline path throws. The two transports have to
 * agree: the same three refusals, the same next call, and never "failed" on its own — an agent
 * that is told a job failed retries it, and a declined run does not become acceptable on a
 * second attempt.
 */
describe('a job that was declined rather than broken', () => {
    const failedJob = (failureDetail: Record<string, unknown>, error: string) => [
        {
            match: 'GET /api/v1/chat/jobs/job-1',
            body: {
                job_id: 'job-1',
                status: 'failed',
                error,
                progress: { type: 'done', status: 'failed', data: { error, failure_detail: failureDetail } },
            },
        },
    ]

    it('hands back the questions instead of the log sentence', async () => {
        const api = fakeApi(
            failedJob(
                {
                    kind: 'decision_refusal',
                    code: 'CLARIFICATION_REQUIRED',
                    clarifying_questions: [
                        { id: 'q1', question: 'Roughly how many users?', why: 'It sets the scale.', options: ['~1k', '~1M'] },
                    ],
                },
                'This prompt needs a few details before we can design it well.',
            ),
        )
        harness = await startHarness(api.fetch)

        const result = await harness.call('get_generation_status', { job_id: 'job-1' })

        expect(result.structuredContent?.refusal_code).toBe('CLARIFICATION_REQUIRED')
        expect(result.structuredContent?.clarifying_questions).toEqual([
            { id: 'q1', question: 'Roughly how many users?', why: 'It sets the scale.', options: ['~1k', '~1M'] },
        ])
        expect(joined(result)).toMatch(/clarification_answers/)
        expect(joined(result)).toMatch(/nothing was charged/i)
    })

    it('names a different tool when the prompt was a question, not a design', async () => {
        const api = fakeApi(
            failedJob(
                { kind: 'decision_refusal', code: 'ASYNC_RESPONSE_MODE_UNSUPPORTED', response_mode: 'text', intent: 'explain' },
                'Background generation only supports architecture responses.',
            ),
        )
        harness = await startHarness(api.fetch)

        const result = await harness.call('get_generation_status', { job_id: 'job-1' })

        expect(result.structuredContent?.refusal_code).toBe('ASYNC_RESPONSE_MODE_UNSUPPORTED')
        expect(joined(result)).toMatch(/wait: true|get_design/)
    })

    it('leaves an ordinary failure reported as an ordinary failure', async () => {
        // The load-bearing negative. A malformed or absent detail must degrade to the old
        // report, never swallow it: a broken run dressed as a refusal would tell the agent
        // nothing was charged when something was.
        const api = fakeApi(
            failedJob({ kind: 'architecture_acceptance', graph_errors: ['orphan c3'] }, 'The model timed out.'),
        )
        harness = await startHarness(api.fetch)

        const result = await harness.call('get_generation_status', { job_id: 'job-1' })

        expect(result.structuredContent?.refusal_code).toBeNull()
        expect(result.structuredContent?.clarifying_questions).toEqual([])
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
            'Analysing requirements — web, 4000 rps (inferred)',
            'Selecting architecture patterns',
            'Generating the design',
        ])
        expect(progress.every((event) => event.total === 6)).toBe(true)
    })

    it('says which figures the run was given and which it made up', async () => {
        // The agent reads these lines and nothing else while the run is going. An unlabelled
        // "4000 rps" is indistinguishable from one the user asked for, and an agent that builds
        // against an invented figure has no way to discover it was invented.
        const frames = [
            JSON.stringify({
                type: 'analysis',
                pipeline_step: { domain: 'fintech', requests_per_second: 5000, scale_source: 'user_supplied' },
            }),
            JSON.stringify({
                type: 'generating',
                pipeline_step: { domain: 'fintech', requests_per_second: 5000, scale_source: 'user_supplied' },
            }),
            DONE,
        ]
        const api = fakeApi(baseRoutes([{ match: 'POST /api/v1/chat/generate/stream', sse: frames }]))
        harness = await startHarness(api.fetch)

        const { progress } = await harness.callWithProgress('generate_architecture', { prompt: 'x' })

        expect(progress.map((event) => event.message)).toEqual([
            'Analysing requirements — fintech, 5000 rps (stated)',
            // Repeated on the generation frame on purpose: that is the frame live for the whole
            // long stretch of the run, and a label that appears once early is a label the agent
            // has to remember rather than read.
            'Generating the design — fintech, 5000 rps (stated)',
        ])
    })

    it('prints a provenance value it does not recognise rather than dropping it', async () => {
        // A word added server-side should be visible the day it ships. Dropping it would show a
        // figure with no label, which is exactly what an unlabelled figure must never look like.
        const frames = [
            JSON.stringify({ type: 'analysis', pipeline_step: { scale: '1M users', scale_source: 'measured' } }),
            DONE,
        ]
        const api = fakeApi(baseRoutes([{ match: 'POST /api/v1/chat/generate/stream', sse: frames }]))
        harness = await startHarness(api.fetch)

        const { progress } = await harness.callWithProgress('generate_architecture', { prompt: 'x' })

        expect(progress[0]?.message).toBe('Analysing requirements — 1M users (measured)')
    })

    it('falls back to the bare stage label when the frame says nothing', async () => {
        const frames = [JSON.stringify({ type: 'analysis', pipeline_step: { domain: 'unknown' } }), DONE]
        const api = fakeApi(baseRoutes([{ match: 'POST /api/v1/chat/generate/stream', sse: frames }]))
        harness = await startHarness(api.fetch)

        const { progress } = await harness.callWithProgress('generate_architecture', { prompt: 'x' })

        // `unknown` is the server's own placeholder for a domain it could not classify, not a
        // domain called "unknown".
        expect(progress[0]?.message).toBe('Analysing requirements')
    })

    it('sends nothing when the host did not ask', async () => {
        const api = fakeApi(baseRoutes([{ match: 'POST /api/v1/chat/generate/stream', sse: PIPELINE }]))
        harness = await startHarness(api.fetch)

        const result = await harness.call('generate_architecture', { prompt: 'A link shortener' })

        // No progressToken means no notifications channel; emitting anyway is a protocol error.
        expect(result.isError).toBeFalsy()
    })
})
