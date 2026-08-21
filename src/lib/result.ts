/**
 * How a tool answers, and how it fails.
 *
 * Every tool returns `structuredContent` against its declared `outputSchema` *and* a compact text
 * block. Both, always: the structured half is what a client can compute on, and the text half is
 * what actually reaches the model in most hosts today.
 *
 * Failures come back as `isError: true` tool results rather than protocol errors. A protocol error
 * is invisible to the model — the host reports "the tool failed" and the agent has nothing to act
 * on. "Your token lacks the generate scope" is only useful if the model can read it.
 */

import type { CallToolResult } from '@modelcontextprotocol/server'

import { AmbiguousProjectError } from './resolve.js'
import { describeApiError, SkeletiqApiError, SkeletiqNetworkError } from '../http/errors.js'

/** The SDK's own result type. Hand-rolling a narrower one makes every handler fail to typecheck. */
export type ToolResult = CallToolResult

export function ok(structured: Record<string, unknown>, text: string): ToolResult {
    return { content: [{ type: 'text', text }], structuredContent: structured }
}

export function failure(text: string): ToolResult {
    return { content: [{ type: 'text', text }], isError: true }
}

/**
 * Run a tool body, turning anything it throws into words the agent can use.
 *
 * A tool with an `outputSchema` may not return `structuredContent` on the error path — the SDK
 * validates it against the success shape — so failures are text-only by construction.
 */
export async function guard(run: () => Promise<ToolResult>): Promise<ToolResult> {
    try {
        return await run()
    } catch (error) {
        if (error instanceof SkeletiqApiError) return failure(describeApiError(error))
        if (error instanceof SkeletiqNetworkError) return failure(error.message)
        if (error instanceof AmbiguousProjectError) {
            const lines = [
                error.message,
                'Ask which one, and call again with the id:',
                ...error.candidates.map((project) => `- ${project.title} (${project.id})`),
            ]
            return failure(lines.join('\n'))
        }
        return failure(error instanceof Error ? error.message : String(error))
    }
}

/** The one-line version stamp appended to every read. */
export function versionLine(facts: {
    version: number
    is_released: boolean
    newer_release_exists: boolean
    resolved_by: string
}): string {
    const state = facts.is_released ? 'released' : 'DRAFT — not released, and may change without notice'
    const line = `Version ${facts.version} (${state}).`
    return facts.newer_release_exists
        ? `${line} A newer version has since been released — re-read the design before relying on this.`
        : line
}
