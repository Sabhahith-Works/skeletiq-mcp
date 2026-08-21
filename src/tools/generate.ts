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
import { readSseFrames, type SseFrame } from '../http/sse.js'
import type { DesignResolver } from '../lib/resolve.js'
import { failure, guard, ok } from '../lib/result.js'
import { GenerateAsyncSchema, JobSchema } from '../wire/schemas.js'

/** Frames worth telling the host about; the rest are noise at this granularity. */
const PROGRESS_LABELS: Record<string, string> = {
    analysis: 'Analysing requirements',
    patterns: 'Selecting architecture patterns',
    generating: 'Generating the design',
    validation: 'Validating the design',
    refining: 'Refining the design',
}
const PROGRESS_TOTAL = Object.keys(PROGRESS_LABELS).length + 1

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
})

const generateOutput = z.object({
    status: z.string(),
    project_id: z.string().nullable(),
    architecture_id: z.string().nullable(),
    version: z.number().nullable(),
    job_id: z.string().nullable(),
    title: z.string().nullable(),
    component_count: z.number().nullable(),
    assistant_message: z.string().nullable(),
    degradations: z.array(z.string()),
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
                'setting; you do not choose it.',
            inputSchema: generateInput,
            outputSchema: generateOutput,
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        },
        async ({ prompt, project_id, wait }, ctx) =>
            guard(async () => {
                const projectId = project_id ? (await resolver.resolveProject(project_id)).id : undefined
                const body = { prompt, ...(projectId ? { project_id: projectId } : {}) }

                if (wait === false) return await queueGeneration(client, body)
                return await streamGeneration(client, body, ctx)
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
                const structured = {
                    job_id: job.job_id,
                    status: job.status,
                    project_id: job.project_id ?? null,
                    architecture_id: job.architecture_id ?? null,
                    error: job.error ?? null,
                    queue_state: job.queue_state ?? null,
                }
                const lines = [`Generation ${job.job_id} is ${job.status}.`]
                if (job.status === 'completed' && job.project_id) {
                    lines.push(`Read it with get_design(project_id: "${job.project_id}").`)
                }
                if (job.error) lines.push(job.error)
                return ok(structured, lines.join('\n'))
            }),
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
            await ctx.mcpReq.notify({
                method: 'notifications/progress',
                params: { progressToken, progress: step, total: PROGRESS_TOTAL, message: label },
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
