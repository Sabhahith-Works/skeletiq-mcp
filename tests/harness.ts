/**
 * Driving the real server through a real client, in one process.
 *
 * No mock transport and no direct handler calls: tools are exercised the way a host exercises
 * them, so tool registration, input validation and — the part worth the trouble — `outputSchema`
 * validation of `structuredContent` all run for real. A handler returning a shape it promised not
 * to fails here rather than in somebody's editor.
 *
 * Only the HTTP layer is faked, by a `fetch` the tests supply.
 */

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createMcpHandler } from '@modelcontextprotocol/server'

import type { Config } from '../src/config.js'
import { createServerFactory } from '../src/server.js'

export interface ToolCallResult {
    content: { type: string; text?: string }[]
    structuredContent?: Record<string, unknown>
    isError?: boolean
}

export interface Progress {
    progress: number
    total?: number
    message?: string
}

export interface Harness {
    call(name: string, args: Record<string, unknown>): Promise<ToolCallResult>
    /** Call while listening for `notifications/progress`, as a host that sent a token would. */
    callWithProgress(
        name: string,
        args: Record<string, unknown>,
    ): Promise<{ result: ToolCallResult; progress: Progress[] }>
    listTools(): Promise<{ name: string; description?: string }[]>
    instructions(): string | undefined
    close(): Promise<void>
}

export const TEST_CONFIG: Config = { apiUrl: 'https://api.test.invalid', apiKey: 'skq_test' }

export async function startHarness(fetchImpl: typeof fetch, config: Config = TEST_CONFIG): Promise<Harness> {
    const previousFetch = globalThis.fetch
    globalThis.fetch = fetchImpl

    const handler = createMcpHandler(createServerFactory(config))
    const transport = new StreamableHTTPClientTransport(new URL('http://harness.local/mcp'), {
        // The transport's own traffic must reach the handler, not the stubbed API fetch.
        fetch: (url, init) => handler.fetch(new Request(url, init)),
    })
    const client = new Client({ name: 'harness', version: '0.0.0' })
    await client.connect(transport)

    return {
        async call(name, args) {
            return (await client.callTool({ name, arguments: args })) as unknown as ToolCallResult
        },
        async callWithProgress(name, args) {
            const progress: Progress[] = []
            // `callTool(params, options)` — two arguments in SDK v2. A third is silently
            // dropped, which looks exactly like a server that never sends progress.
            const result = (await client.callTool(
                { name, arguments: args },
                { onprogress: (event) => progress.push(event as Progress) },
            )) as unknown as ToolCallResult
            return { result, progress }
        },
        async listTools() {
            const listed = await client.listTools()
            return listed.tools.map((tool) => ({ name: tool.name, description: tool.description }))
        },
        instructions() {
            return client.getInstructions()
        },
        async close() {
            globalThis.fetch = previousFetch
            await client.close()
            await handler.close()
        },
    }
}

// ─── The fake API ────────────────────────────────────────────────────

export interface Route {
    /** Matched against `${method} ${pathname}` as a substring; the longest matching route wins. */
    match: string
    status?: number
    body?: unknown
    /** For the SSE path: the raw frames, joined and served as a stream. */
    sse?: string[]
    headers?: Record<string, string>
}

export interface FakeApi {
    fetch: typeof fetch
    /** Every request made, in order — so a test can assert what was *not* sent. */
    calls: { method: string; url: string; body: unknown; headers: Record<string, string> }[]
}

export function fakeApi(routes: Route[]): FakeApi {
    const calls: FakeApi['calls'] = []

    const impl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
        const method = (init?.method ?? 'GET').toUpperCase()
        const key = `${method} ${url.pathname}`

        const headers: Record<string, string> = {}
        for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
            headers[name.toLowerCase()] = value
        }
        calls.push({
            method,
            url: url.toString(),
            body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
            headers,
        })

        // Longest match wins. `GET /api/v1/projects/` is a prefix of the architectures path, so
        // declaration order would otherwise decide which route answers — a fixture bug that looks
        // exactly like a client bug.
        const route = [...routes]
            .sort((a, b) => b.match.length - a.match.length)
            .find((candidate) => key.includes(candidate.match))
        if (!route) {
            return jsonResponse(404, { error: { code: 'NOT_FOUND', message: `No fake route for ${key}` } })
        }

        if (route.sse) {
            return new Response(sseStream(route.sse), {
                status: route.status ?? 200,
                headers: { 'Content-Type': 'text/event-stream', ...route.headers },
            })
        }
        return jsonResponse(route.status ?? 200, route.body, route.headers)
    }) as typeof fetch

    return { fetch: impl, calls }
}

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
    return new Response(body === undefined ? '' : JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', ...headers },
    })
}

/**
 * Emit the frames in several chunks with the split landing mid-frame, which is what the network
 * does and what a per-chunk parser gets wrong.
 */
function sseStream(frames: string[]): ReadableStream<Uint8Array> {
    const payload = frames.map((frame) => `data: ${frame}\n\n`).join('')
    const bytes = new TextEncoder().encode(payload)
    const cut = Math.floor(bytes.length / 2)

    return new ReadableStream({
        start(controller) {
            controller.enqueue(bytes.slice(0, cut))
            controller.enqueue(bytes.slice(cut))
            controller.close()
        },
    })
}

// ─── Fixtures ────────────────────────────────────────────────────────

export const PROJECT_ID = '11111111-1111-1111-1111-111111111111'
export const ARCH_V2 = '22222222-2222-2222-2222-222222222222'
export const ARCH_V3 = '33333333-3333-3333-3333-333333333333'

export const DESIGN = {
    title: 'Link shortener',
    description: 'Shortens links.',
    components: [
        { id: 'api', name: 'API Service', type: 'service', technology: 'FastAPI', description: 'Public API.' },
        { id: 'db', name: 'Links Database', type: 'database', technology: 'Postgres' },
        { id: 'cache', name: 'Hot Links Cache', type: 'cache', technology: 'Redis' },
    ],
    connections: [
        { source: 'api', target: 'db', protocol: 'tcp' },
        { source: 'api', target: 'cache', protocol: 'tcp' },
    ],
    design_decisions: ['Postgres was chosen for the Links Database because the data is relational.'],
    trade_offs: ['Redis adds an eviction problem.'],
}

export const RELEASE_FACTS = {
    is_released: true,
    released_at: '2026-08-20T00:00:00Z',
    latest_release_version: 2,
    newer_release_exists: false,
    newer_draft_exists: true,
}

/** v2 released, v3 an unreleased draft — the state the version rule exists to disambiguate. */
export function architecturePage() {
    return {
        items: [
            { id: ARCH_V2, project_id: PROJECT_ID, version: 2, architecture_json: DESIGN, is_released: true },
            { id: ARCH_V3, project_id: PROJECT_ID, version: 3, architecture_json: DESIGN, is_released: false },
        ],
        total: 2,
        limit: 100,
        offset: 0,
    }
}

export function projectList(projects = [{ id: PROJECT_ID, title: 'Shortener', architecture_count: 2 }]) {
    return { projects, total: projects.length, page: 1, page_size: 50 }
}

/**
 * `GET /architectures/{id}` — one version on its own.
 *
 * Only the inline generate path reads this: every other tool arrives with a project id and is
 * served from the version list. It is in `baseRoutes` so that path's happy case is the default,
 * and a test that wants the lookup to fail overrides it explicitly.
 */
export function architectureDetail(id = ARCH_V3, version = 3) {
    return { id, project_id: PROJECT_ID, version, architecture_json: DESIGN, is_released: false }
}

export function baseRoutes(extra: Route[] = []): Route[] {
    return [
        ...extra,
        { match: 'GET /api/v1/projects/', body: projectList() },
        { match: `GET /api/v1/projects/${PROJECT_ID}/architectures`, body: architecturePage() },
        { match: `GET /api/v1/projects/${PROJECT_ID}`, body: { id: PROJECT_ID, title: 'Shortener' } },
        { match: 'GET /api/v1/architectures/', body: architectureDetail() },
    ]
}
