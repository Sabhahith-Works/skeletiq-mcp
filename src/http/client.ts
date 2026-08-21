/**
 * The one place this package talks to SkeletIQ.
 *
 * Deliberately not a port of the web app's client: that one reaches for `localStorage`, refreshes
 * JWTs, redirects the window on a 401 and reports timings to an analytics module. None of that has
 * any meaning in a process with no browser and one static credential.
 */

import { SERVER_NAME, SERVER_VERSION, type Config } from '../config.js'
import { parseApiError, SkeletiqApiError, SkeletiqNetworkError } from './errors.js'

const API_PREFIX = '/api/v1'

/**
 * A generation can run for the better part of eight minutes (~217 s typical, 450 s at the entry
 * deadline), so the client must not impose a timeout below the server's own. Anything shorter
 * turns a working generation into a failure the agent cannot explain. The host's cancellation
 * signal is the real bound.
 */
const READ_TIMEOUT_MS = 600_000

export interface RequestOptions {
    method?: 'GET' | 'POST'
    query?: Record<string, string | number | undefined>
    body?: unknown
    headers?: Record<string, string>
    signal?: AbortSignal
}

export class SkeletiqClient {
    private readonly config: Config

    constructor(config: Config) {
        this.config = config
    }

    /** A parsed JSON response, or a thrown `SkeletiqApiError` carrying the server's own words. */
    async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
        const response = await this.fetch(path, options)
        const text = await response.text()
        return (text ? JSON.parse(text) : undefined) as T
    }

    /** The raw `Response`, for the one caller that reads a stream rather than a body. */
    async fetch(path: string, options: RequestOptions = {}): Promise<Response> {
        const url = this.url(path, options.query)
        const timeout = AbortSignal.timeout(READ_TIMEOUT_MS)
        const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout

        let response: Response
        try {
            response = await fetch(url, {
                method: options.method ?? 'GET',
                headers: {
                    Authorization: `Bearer ${this.config.apiKey}`,
                    Accept: 'application/json',
                    'User-Agent': `${SERVER_NAME}-mcp/${SERVER_VERSION}`,
                    ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
                    ...options.headers,
                },
                body: options.body === undefined ? undefined : JSON.stringify(options.body),
                signal,
            })
        } catch (cause) {
            // An abort raised by the caller's own signal is a cancellation, not a failure to
            // reach the server, and must surface as itself so the host can tell them apart.
            if (options.signal?.aborted) throw cause
            throw new SkeletiqNetworkError(`Could not reach SkeletIQ at ${this.config.apiUrl}.`, { cause })
        }

        if (!response.ok) throw await this.toError(response)
        return response
    }

    private url(path: string, query?: Record<string, string | number | undefined>): string {
        const url = new URL(`${this.config.apiUrl}${API_PREFIX}${path}`)
        for (const [key, value] of Object.entries(query ?? {})) {
            if (value !== undefined && value !== '') url.searchParams.set(key, String(value))
        }
        return url.toString()
    }

    private async toError(response: Response): Promise<SkeletiqApiError> {
        let body: unknown
        try {
            body = JSON.parse(await response.text())
        } catch {
            body = undefined
        }
        return parseApiError(response.status, body, parseRetryAfter(response))
    }
}

/** `Retry-After` is seconds here — the API never sends the HTTP-date form. */
export function parseRetryAfter(response: Response): number | undefined {
    const header = response.headers.get('retry-after')
    if (!header) return undefined
    const seconds = Number.parseInt(header, 10)
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined
}
