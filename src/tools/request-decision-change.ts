/**
 * Asking a person to change a design decision, and hearing their answer.
 *
 * The agent proposes; it never decides. A request is filed against one version of the design and
 * waits for a person on the project to accept or dismiss it in To-do. Nothing in the design changes
 * until they accept, and this tool has no way to change it.
 *
 * Two shapes share one tool: file a request (`project_id`, `decision_id`, `proposed`, `why`), or poll
 * one already filed (`request_id` alone). Evidence is checked on this machine, and only the path and
 * the outcome are sent — never the quote.
 */

import * as z from 'zod/v4'

import type { McpServer } from '@modelcontextprotocol/server'

import { SkeletiqApiError, describeApiError } from '../http/errors.js'
import type { SkeletiqClient } from '../http/client.js'
import { MAX_REFS_PER_CLAIM, evidenceRef, resolveRepoRoot, verifyEvidence } from '../lib/evidence.js'
import type { DesignResolver } from '../lib/resolve.js'
import { failure, guard, ok } from '../lib/result.js'
import { DecisionRequestSchema } from '../wire/schemas.js'

const REVIEW_LINE = 'A person on the project reviews this in To-do; nothing changes until they accept.'
const UNSUPPORTED_LINE = 'This SkeletIQ server does not take decision requests yet.'

const input = z.object({
    request_id: z
        .string()
        .optional()
        .describe('A request you filed earlier. Give this alone to read where it stands.'),
    project_id: z.string().optional().describe('A SkeletIQ project id, or its exact name. Needed to file a request.'),
    version: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('The version you built from. Defaults to the latest released version.'),
    decision_id: z.string().max(64).optional().describe('The decision\'s topic id, e.g. database.primary. Needed to file a request.'),
    proposed: z.string().min(1).max(500).optional().describe('What you propose instead. Needed to file a request.'),
    why: z.string().min(1).max(2000).optional().describe('Why the code needs the change. Needed to file a request.'),
    evidence: z
        .array(evidenceRef)
        .max(MAX_REFS_PER_CLAIM)
        .optional()
        .describe('Where in the code the need shows. Verified on this machine; only the path and outcome are sent.'),
    repo_root: z
        .string()
        .optional()
        .describe('The repository root that evidence paths are relative to. Defaults to the current directory.'),
})

const output = z.object({
    request_id: z.string(),
    status: z.enum(['pending', 'accepted', 'dismissed']),
    decision_id: z.string(),
    decision_title: z.string(),
    proposed: z.string(),
    version: z.number(),
    latest_version: z.number(),
    accepted_in_version: z.number().nullable(),
    resolution_note: z.string().nullable(),
})

export function registerRequestDecisionChange(
    server: McpServer,
    client: SkeletiqClient,
    resolver: DesignResolver,
): void {
    server.registerTool(
        'request_decision_change',
        {
            title: 'Ask a person to change a design decision',
            description:
                'Ask for one of the design\'s decisions to change, with what you propose and why the code needs it. ' +
                `${REVIEW_LINE} Call again with only \`request_id\` to see the answer. This never changes the design.`,
            inputSchema: input,
            outputSchema: output,
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        },
        async ({ request_id, project_id, version, decision_id, proposed, why, evidence, repo_root }) =>
            guard(async () => {
                if (request_id !== undefined) return poll(client, request_id)

                if (!project_id || !decision_id || !proposed || !why) {
                    return failure(
                        'To file a request give project_id, decision_id, proposed and why. ' +
                            'To read an answer, give only request_id.',
                    )
                }

                let checked: Awaited<ReturnType<typeof verifyEvidence>>[] = []
                if (evidence?.length) {
                    const requested = repo_root ?? process.cwd()
                    const root = await resolveRepoRoot(requested)
                    if (root === null) return failure(`repo_root ${requested} cannot be read`)
                    checked = await Promise.all(evidence.map((ref) => verifyEvidence(root, ref)))
                }

                const project = await resolver.resolveProject(project_id)
                const resolved = await resolver.resolveVersion(project.id, version)

                let raw: unknown
                try {
                    raw = await client.request<unknown>(`/architectures/${resolved.architectureId}/decision-requests`, {
                        method: 'POST',
                        body: { decision_id, proposed, why, evidence: checked },
                    })
                } catch (error) {
                    return refused(error)
                }
                return answer(DecisionRequestSchema.parse(raw), true)
            }),
    )
}

async function poll(client: SkeletiqClient, requestId: string) {
    let raw: unknown
    try {
        raw = await client.request<unknown>(`/decision-requests/${encodeURIComponent(requestId)}`)
    } catch (error) {
        return refused(error)
    }
    return answer(DecisionRequestSchema.parse(raw), false)
}

function refused(error: unknown) {
    if (error instanceof SkeletiqApiError) {
        if (error.status === 404) return failure(UNSUPPORTED_LINE)
        if (error.status === 409) return failure(error.message)
        return failure(describeApiError(error))
    }
    throw error
}

function answer(request: z.infer<typeof DecisionRequestSchema>, filed: boolean) {
    const structured = {
        request_id: request.id,
        status: request.status,
        decision_id: request.decision_id,
        decision_title: request.decision_title,
        proposed: request.proposed,
        version: request.version,
        latest_version: request.latest_version,
        accepted_in_version: request.accepted_in_version,
        resolution_note: request.resolution_note,
    }

    const lines: string[] = []
    const subject = `"${request.decision_title}" (${request.decision_id}, version ${request.version}) → ${request.proposed}`
    if (request.status === 'pending') {
        lines.push(`${filed ? 'Request filed' : 'Request pending'} (${request.id}): ${subject}`)
        lines.push(REVIEW_LINE)
        lines.push(`Poll it with request_decision_change(request_id: "${request.id}").`)
    } else if (request.status === 'accepted') {
        lines.push(`Request ${request.id} accepted: ${subject}`)
        lines.push(
            request.accepted_in_version === null
                ? `accepted; the server did not say which version it landed in (latest is v${request.latest_version})`
                : `accepted at v${request.accepted_in_version}; the design changes when the follow-up turn ` +
                      `completes (latest is v${request.latest_version})`,
        )
    } else {
        lines.push(`Request ${request.id} dismissed: ${subject}`)
        lines.push('The design stays as it is.')
    }
    if (request.resolution_note) lines.push(`Note from the reviewer: ${request.resolution_note}`)
    return ok(structured, lines.join('\n'))
}
