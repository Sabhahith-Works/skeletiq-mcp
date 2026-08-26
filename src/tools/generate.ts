/**
 * Making a design, and asking after one that is still being made.
 *
 * Two things shape this file.
 *
 * **A generation takes minutes** — around 217 seconds typically, up to 450 at the entry deadline.
 * So the inline path streams, and every pipeline frame becomes a `notifications/progress` when the
 * host asked for one. Without that the agent sits in silence for four minutes, and silence is what
 * a hung tool looks like.
 *
 * **Nothing here names a runtime.** Which model serves an agent-originated generation is a setting
 * the account holder chose in SkeletIQ, resolved server-side. Handing the model a runtime argument
 * would let it pick what a run costs somebody else.
 */

import { randomUUID } from 'node:crypto'

import * as z from 'zod/v4'

import type { McpServer, ServerContext } from '@modelcontextprotocol/server'

import type { SkeletiqClient } from '../http/client.js'
import { SkeletiqApiError } from '../http/errors.js'
import { readSseFrames, type SseFrame } from '../http/sse.js'
import type { DesignResolver } from '../lib/resolve.js'
import { failure, guard, ok } from '../lib/result.js'
import {
    GenerateAsyncSchema,
    DecisionRefusalSchema,
    IntentDecisionSchema,
    JobProgressSchema,
    JobSchema,
    type ClarifyingQuestion,
    type DecisionRefusal,
} from '../wire/schemas.js'

/** Frames worth telling the host about; the rest are noise at this granularity. */
const PROGRESS_LABELS: Record<string, string> = {
    analysis: 'Analysing requirements',
    patterns: 'Selecting architecture patterns',
    generating: 'Generating the design',
    validation: 'Validating the design',
    refining: 'Refining the design',
}
const PROGRESS_TOTAL = Object.keys(PROGRESS_LABELS).length + 1

/**
 * Where a figure in a progress line came from.
 *
 * The vocabulary is the server's `rps_source`, mirrored the way everything in `wire/` is
 * mirrored, and the words match the ones the app prints beside the same numbers. The one
 * deliberate difference is `user_supplied`: the app renders nothing for it, because in a panel
 * an unannotated figure already reads as the user's own. A progress line has no such context,
 * and an agent that cannot tell a stated figure from an invented one will treat both as fact —
 * which is the entire failure this labelling exists to prevent. An unrecognised value passes
 * through verbatim rather than being dropped, so a value added server-side is visible here the
 * day it ships.
 */
const PROVENANCE_LABELS: Record<string, string> = {
    user_supplied: 'stated',
    llm_inferred: 'inferred',
    tier_default: 'assumed',
    guardrail_clamped: 'adjusted',
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined
}

function asText(value: unknown): string | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    return typeof value === 'string' && value.trim() && value !== 'unknown' ? value.trim() : undefined
}

/**
 * What the pipeline says it understood, appended to the stage label.
 *
 * The figure is read the way the server's own caption reads it — the RPS when there is one and
 * the user count otherwise — because `scale_source` describes *that* figure and no other.
 * Labelling the wrong one would be worse than labelling neither.
 */
function frameDetail(frame: SseFrame): string | undefined {
    const data = asRecord(frame.pipeline_step)
    if (!data) return undefined

    const parts: string[] = []
    const domain = asText(data.domain)
    if (domain) parts.push(domain)

    const rps = asText(data.requests_per_second)
    const figure = rps ? `${rps} rps` : asText(data.scale)
    if (figure) {
        const source = asText(data.scale_source)
        const label = source ? (PROVENANCE_LABELS[source] ?? source) : undefined
        parts.push(label ? `${figure} (${label})` : figure)
    }

    return parts.length > 0 ? parts.join(', ') : undefined
}

/**
 * The design facts a caller may state, rather than leave to be inferred or assumed.
 *
 * These are exactly `ALLOWED_CONSTRAINT_KEYS` in `prompt_sanitizer.py`, which is the server's
 * contract for what a client may assert about a design — anything outside it is dropped there
 * with a log line and no error, so an agent that invented a key would never learn it was
 * ignored. Strict here on purpose: a misspelled key is a validation error the agent can read
 * and fix, which is the opposite of that silence. The enum members mirror `UserConstraints`.
 */
const constraintsInput = z.strictObject({
    budget: z.enum(['low', 'medium', 'high', 'unlimited']).optional(),
    max_latency_ms: z.number().int().positive().optional(),
    compliance: z.array(z.string()).optional().describe('e.g. HIPAA, SOC2, PCI-DSS, GDPR'),
    preferred_cloud: z.enum(['aws', 'gcp', 'azure', 'any']).optional(),
    preferred_technologies: z.array(z.string()).optional(),
    max_components: z.number().int().positive().optional(),
    read_write_mix: z
        .enum(['read_heavy', 'balanced', 'write_heavy'])
        .optional()
        .describe('Nothing reads this from the prompt. Unset, the design assumes 80% reads.'),
    burstiness: z
        .enum(['steady', 'daily_peaks', 'spiky'])
        .optional()
        .describe('Nothing reads this from the prompt. Unset, the design assumes the tier default peak.'),
    data_retention: z.enum(['days', 'months', 'years', 'indefinite']).optional(),
    consistency: z.enum(['strict', 'eventual', 'mixed']).optional(),
    data_residency: z.enum(['any', 'us', 'eu']).optional(),
})

const generateInput = z.object({
    prompt: z
        .string()
        .min(1)
        .max(20_000)
        .describe('What to design. Describe the system, its scale and its constraints in prose.'),
    project_id: z
        .string()
        .optional()
        .describe('An existing SkeletIQ project id to add a version to. Omit to start a new project.'),
    wait: z
        .boolean()
        .optional()
        .describe(
            'Default true: run inline and return the finished design (this takes several minutes). ' +
                'False queues it as a background job and returns a job_id to poll — not available on every deployment.',
        ),
    clarification_answers: z
        .record(z.string(), z.string())
        .optional()
        .describe(
            'Answers to the questions a previous call returned with status "clarification_required", ' +
                'keyed by their ids. Treated as authoritative requirements, so send what the user told ' +
                'you — ask them rather than guessing.',
        ),
    constraints: constraintsInput
        .optional()
        .describe(
            'Facts about the design that the prose does not have to carry. Anything omitted is ' +
                'assumed by SkeletIQ, and the design says which values were assumed.',
        ),
})

const generateOutput = z.object({
    status: z.string().describe('completed | clarification_required, or the queue state on wait: false'),
    project_id: z.string().nullable(),
    architecture_id: z.string().nullable(),
    version: z.number().nullable(),
    job_id: z.string().nullable(),
    title: z.string().nullable(),
    component_count: z.number().nullable(),
    assistant_message: z.string().nullable(),
    degradations: z.array(z.string()),
    /**
     * Present, and non-empty, only on `status: "clarification_required"`. A refusal is a
     * *result* here rather than an error: an error result may carry no `structuredContent` at
     * all (the SDK validates it against the success shape), so reporting it that way would
     * hand the agent the one thing it cannot act on — a sentence saying detail is missing,
     * without saying which.
     */
    clarifying_questions: z.array(
        z.object({
            id: z.string(),
            question: z.string(),
            why: z.string(),
            options: z.array(z.string()),
        }),
    ),
})

const statusInput = z.object({
    job_id: z.string().describe('The job_id returned by generate_architecture with wait: false.'),
})

const statusOutput = z.object({
    job_id: z.string(),
    status: z.string(),
    project_id: z.string().nullable(),
    architecture_id: z.string().nullable(),
    error: z.string().nullable(),
    queue_state: z.string().nullable(),
    /**
     * Set when the run was *declined* rather than broken — the same three refusals the inline
     * path answers with a 409. Nothing ran and nothing was charged, so the next call is a
     * normal one, not a retry.
     */
    refusal_code: z.string().nullable(),
    /** Non-empty only for a `CLARIFICATION_REQUIRED` refusal. */
    clarifying_questions: z.array(
        z.object({
            id: z.string(),
            question: z.string(),
            why: z.string(),
            options: z.array(z.string()),
        }),
    ),
})

export function registerGenerate(server: McpServer, client: SkeletiqClient, resolver: DesignResolver): void {
    server.registerTool(
        'generate_architecture',
        {
            title: 'Generate a SkeletIQ architecture',
            description:
                'Design a system architecture from a prompt. This spends the account holder\'s credits ' +
                'and takes several minutes, so do not call it speculatively — if a design already exists, ' +
                'read it with get_design instead. Which model runs it is the account holder\'s stored ' +
                'setting; you do not choose it. Describe the system, what it must do, and the scale and ' +
                'constraints it runs under: whatever the prompt leaves out is assumed, and a prompt that ' +
                'names no system at all comes back as clarification_required with the questions to answer.',
            inputSchema: generateInput,
            outputSchema: generateOutput,
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        },
        async ({ prompt, project_id, wait, clarification_answers, constraints }, ctx) =>
            guard(async () => {
                const projectId = project_id ? (await resolver.resolveProject(project_id)).id : undefined
                const body = {
                    prompt,
                    ...(projectId ? { project_id: projectId } : {}),
                    ...(clarification_answers ? { clarification_answers } : {}),
                    ...(constraints ? { constraints } : {}),
                }

                // One catch around both transports, not one per transport. `/chat/generate/stream`
                // and `/chat/generate-async` take the same request and refuse it the same way, and
                // a recovery path that existed on only one of them is precisely how a background
                // run comes to lose what the inline run honours.
                try {
                    if (wait === false) return await queueGeneration(client, body)
                    return await streamGeneration(client, body, ctx)
                } catch (error) {
                    const questions = clarifyingQuestions(error)
                    if (!questions) throw error
                    return clarificationResult(questions)
                }
            }),
    )

    server.registerTool(
        'get_generation_status',
        {
            title: 'Check a queued SkeletIQ generation',
            description:
                'Check a background generation started with wait: false. When status is "completed", ' +
                'read the result with get_design.',
            inputSchema: statusInput,
            outputSchema: statusOutput,
            annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
        },
        async ({ job_id }) =>
            guard(async () => {
                const job = JobSchema.parse(await client.request<unknown>(`/chat/jobs/${job_id}`))
                const refusal = decisionRefusal(job.progress)
                const questions = refusalQuestions(refusal)
                const structured = {
                    job_id: job.job_id,
                    status: job.status,
                    project_id: job.project_id ?? null,
                    architecture_id: job.architecture_id ?? null,
                    error: job.error ?? null,
                    queue_state: job.queue_state ?? null,
                    refusal_code: refusal?.code ?? null,
                    clarifying_questions: questions,
                }
                // A declined run is not a failed one, and saying "failed" without saying what to
                // do next is what made this tool a dead end for the agent as well as the browser.
                const lines = refusal
                    ? refusalLines(job.job_id, refusal, questions)
                    : [`Generation ${job.job_id} is ${job.status}.`]
                if (job.status === 'completed' && job.project_id) {
                    lines.push(`Read it with get_design(project_id: "${job.project_id}").`)
                }
                if (job.error && !refusal) lines.push(job.error)
                return ok(structured, lines.join('\n'))
            }),
    )
}

/**
 * The refusal behind a failed job, or `undefined` if the job simply broke.
 *
 * Read from the job's terminal progress event rather than from `error`, which is one sentence
 * written for a log. Anything unrecognised falls through to `undefined` — a malformed payload
 * must degrade to the ordinary failure report, never replace it with a crash.
 */
function decisionRefusal(progress: unknown): DecisionRefusal | undefined {
    const parsed = JobProgressSchema.safeParse(progress)
    if (!parsed.success) return undefined
    const refusal = DecisionRefusalSchema.safeParse(parsed.data.data?.failure_detail)
    return refusal.success ? refusal.data : undefined
}

function refusalQuestions(refusal: DecisionRefusal | undefined) {
    return (refusal?.clarifying_questions ?? []).map((question) => ({
        id: question.id,
        question: question.question,
        why: question.why ?? '',
        options: (question.options ?? []).filter(
            (option) => !(question.decline_options ?? []).includes(option),
        ),
    }))
}

/**
 * What the agent should do next, per refusal.
 *
 * Each of the three is a different next call, and naming the wrong one wastes a turn:
 * clarification wants the same call with answers, an unsupported response mode wants a
 * different *tool*, and a new-project recommendation wants a different project.
 */
function refusalLines(
    jobId: string,
    refusal: DecisionRefusal,
    questions: ReturnType<typeof refusalQuestions>,
): string[] {
    const preamble = `Generation ${jobId} was declined before it ran. Nothing was generated and nothing was charged.`
    switch (refusal.code) {
        case 'CLARIFICATION_REQUIRED':
            return [
                preamble,
                '',
                ...questions.flatMap((question) => [
                    `${question.id}: ${question.question}`,
                    ...(question.why ? [`  Why it matters: ${question.why}`] : []),
                    ...(question.options.length > 0 ? [`  For example: ${question.options.join(' · ')}`] : []),
                ]),
                '',
                'Call generate_architecture again with the same prompt and clarification_answers keyed by ' +
                    'those ids. Take the answers from the user rather than inventing them.',
            ]
        case 'ASYNC_RESPONSE_MODE_UNSUPPORTED':
            return [
                preamble,
                'That prompt reads as a question about a design rather than a request to build one, and a ' +
                    'queued run can only produce a design. Ask it again with wait: true, or read the existing ' +
                    'design with get_design and answer from it.',
            ]
        case 'NEW_PROJECT_RECOMMENDED':
            return [
                preamble,
                'That prompt describes a different system from the one in this project. Create a new project ' +
                    'for it rather than adding a version here.',
            ]
        default:
            // A code this build does not know is still worth reporting as a refusal: the
            // "nothing was charged" half is true of all of them, and inventing advice for
            // one we cannot interpret would be worse than naming it.
            return [preamble, `Refused as: ${refusal.code}.`]
    }
}

/**
 * The questions behind a refusal, or `undefined` if this error is not one.
 *
 * Recognised by the questions being *there*, never by the error code. The code on this 409 is
 * the generic `CONFLICT` — the literal `CLARIFICATION_REQUIRED` belongs to the runner's own
 * backstop, which fires inside a worker where no HTTP status is left to send — and the same
 * body carries a new-project recommendation, which is a different refusal with no questions in
 * it. Keying off the payload rather than the code is the rule the web client already follows.
 */
function clarifyingQuestions(error: unknown): ClarifyingQuestion[] | undefined {
    if (!(error instanceof SkeletiqApiError) || error.status !== 409) return undefined
    const decision = IntentDecisionSchema.safeParse(error.detail)
    const questions = decision.success ? decision.data.clarifying_questions : undefined
    return questions && questions.length > 0 ? questions : undefined
}

/**
 * A refusal the agent can act on: the questions, and what to do with the answers.
 *
 * Not `isError`. Nothing failed and nothing was charged — the run was declined before it
 * started, and the next call is a normal one carrying answers. Marking it an error would put
 * the questions in the one half of a tool result that cannot carry structure.
 */
function clarificationResult(questions: ClarifyingQuestion[]) {
    const structured = questions.map((question) => ({
        id: question.id,
        question: question.question,
        why: question.why ?? '',
        options: (question.options ?? []).filter((option) => !(question.decline_options ?? []).includes(option)),
    }))

    const lines = [
        'SkeletIQ will not design from this prompt yet — it names no system to design. ' +
            'Nothing was generated and nothing was charged.',
        '',
        ...structured.flatMap((question) => [
            `${question.id}: ${question.question}`,
            ...(question.why ? [`  Why it matters: ${question.why}`] : []),
            ...(question.options.length > 0 ? [`  For example: ${question.options.join(' · ')}`] : []),
        ]),
        '',
        'Call generate_architecture again with the same prompt and clarification_answers keyed by ' +
            'those ids. The answers are used as authoritative requirements, so take them from the ' +
            'user rather than inventing them — and put anything you already know into constraints ' +
            'instead, where it is used as a fact rather than as prose to interpret.',
    ]

    return ok(
        {
            status: 'clarification_required',
            project_id: null,
            architecture_id: null,
            version: null,
            job_id: null,
            title: null,
            component_count: null,
            assistant_message: null,
            degradations: [],
            clarifying_questions: structured,
        },
        lines.join('\n'),
    )
}

/** `wait: false` — queue it. Not every deployment runs a worker, and that answer must be legible. */
async function queueGeneration(client: SkeletiqClient, body: Record<string, unknown>) {
    const queued = GenerateAsyncSchema.parse(
        await client.request<unknown>('/chat/generate-async', { method: 'POST', body }),
    )
    return ok(
        {
            status: queued.status,
            project_id: queued.job?.project_id ?? null,
            architecture_id: null,
            version: null,
            job_id: queued.job_id,
            title: null,
            component_count: null,
            assistant_message: null,
            degradations: [],
            clarifying_questions: [],
        },
        `Queued as job ${queued.job_id}. Poll it with get_generation_status.`,
    )
}

/** `wait: true` — the inline SSE path. */
async function streamGeneration(
    client: SkeletiqClient,
    body: Record<string, unknown>,
    ctx: ServerContext,
) {
    const progressToken = ctx.mcpReq._meta?.progressToken
    const response = await client.fetch('/chat/generate/stream', {
        method: 'POST',
        body,
        // One key per logical call. A network-level retry of the same generation replays the
        // first result instead of running — and being charged for — a second one.
        headers: { 'Idempotency-Key': randomUUID(), Accept: 'text/event-stream' },
        signal: ctx.mcpReq.signal,
    })

    let step = 0
    let finished: SseFrame | undefined
    let failed: SseFrame | undefined

    for await (const frame of readSseFrames(response)) {
        const label = PROGRESS_LABELS[frame.type]
        if (label && progressToken !== undefined) {
            step += 1
            const detail = frameDetail(frame)
            await ctx.mcpReq.notify({
                method: 'notifications/progress',
                params: {
                    progressToken,
                    progress: step,
                    total: PROGRESS_TOTAL,
                    message: detail ? `${label} — ${detail}` : label,
                },
            })
        }
        if (frame.type === 'done') finished = frame
        if (frame.type === 'error') failed = frame
    }

    // In-band, and the only place a mid-stream failure shows: the status was 200 before the
    // pipeline had done anything at all.
    if (failed) {
        const message = typeof failed.content === 'string' ? failed.content : 'The generation failed.'
        return failure(`SkeletIQ could not complete the generation: ${message}`)
    }
    if (!finished) {
        return failure(
            'The generation stream ended without a result. Nothing here says whether it completed — ' +
                'check the project in SkeletIQ before generating again, so you do not pay for it twice.',
        )
    }

    const architectureId = typeof finished.architecture_id === 'string' ? finished.architecture_id : null
    const version = typeof finished.architecture_version === 'number' ? finished.architecture_version : null
    const degradations = Array.isArray(finished.degradations)
        ? finished.degradations.filter((d): d is string => typeof d === 'string')
        : []

    return ok(
        {
            status: 'completed',
            project_id: null,
            architecture_id: architectureId,
            version,
            job_id: null,
            title: null,
            component_count: null,
            assistant_message: null,
            degradations,
            clarifying_questions: [],
        },
        [
            architectureId
                ? `Design generated as version ${version ?? '?'}.`
                : 'SkeletIQ answered in prose rather than producing a design.',
            'Read it with get_design, and get_design(mode: "readiness") before building — a fresh',
            'design is a draft, and its open questions are the ones worth asking now.',
            ...degradations.map((d) => `Degraded: ${d}`),
        ].join('\n'),
    )
}
