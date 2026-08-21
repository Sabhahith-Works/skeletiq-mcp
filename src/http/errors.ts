/**
 * Turning a SkeletIQ error into something an agent can act on.
 *
 * Every non-2xx from the API has the same envelope:
 *
 *     { "error": { "code": "...", "message": "...", "request_id": "...", "detail": ... } }
 *
 * Two things about it decide everything in this file.
 *
 * **The top-level `code` often cannot discriminate.** `SERVICE_UNAVAILABLE` covers a deployment
 * with no worker, a Redis blip during the idempotency check, and a full job queue — three
 * different situations with three different next steps. The real discriminator lives in
 * `error.detail.code`, so that is read first and the top-level code is the fallback.
 *
 * **`error.message` is not always a sentence.** The server promotes `detail["message"]` into
 * `message` only when the detail dict has one; the call sites that do not leave `message` as a
 * Python `str()` of a dict. So the message is read from the detail first too.
 */

/** The `detail` payload, when the server sent a structured one. */
export type ErrorDetail = Record<string, unknown> | unknown[] | undefined

export class SkeletiqApiError extends Error {
    readonly status: number
    readonly code: string
    readonly detail: ErrorDetail
    readonly requestId: string | undefined
    /** From the `Retry-After` header, in seconds, when the server set one. */
    readonly retryAfterSeconds: number | undefined

    constructor(args: {
        status: number
        code: string
        message: string
        detail?: ErrorDetail
        requestId?: string
        retryAfterSeconds?: number
    }) {
        super(args.message)
        this.name = 'SkeletiqApiError'
        this.status = args.status
        this.code = args.code
        this.detail = args.detail
        this.requestId = args.requestId
        this.retryAfterSeconds = args.retryAfterSeconds
    }

    /** A `GET` may be retried after a 429; a `POST` that may have spent credits may not. */
    get isRetryable(): boolean {
        return this.status === 429 || this.code === 'IDEMPOTENCY_UNAVAILABLE'
    }
}

/** A transport-level failure — DNS, TLS, connection refused. Never a server answer. */
export class SkeletiqNetworkError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options)
        this.name = 'SkeletiqNetworkError'
    }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value : undefined
}

/** Parse the envelope, tolerating every shape a proxy or a 500 page might put in its place. */
export function parseApiError(status: number, body: unknown, retryAfterSeconds?: number): SkeletiqApiError {
    const envelope = asRecord(asRecord(body)?.error)
    const detailRecord = asRecord(envelope?.detail)
    const detail = (detailRecord ?? (Array.isArray(envelope?.detail) ? envelope.detail : undefined)) as ErrorDetail

    const code =
        asString(detailRecord?.code) ?? asString(envelope?.code) ?? `HTTP_${status}`
    const message =
        asString(detailRecord?.message) ??
        asString(detailRecord?.error) ??
        asString(envelope?.message) ??
        `SkeletIQ returned HTTP ${status}.`

    return new SkeletiqApiError({
        status,
        code,
        message,
        detail,
        requestId: asString(envelope?.request_id),
        retryAfterSeconds,
    })
}

/**
 * What to tell the agent, and what it should do next.
 *
 * The upsell and credit texts are passed through as the product wrote them. Rewording a paywall
 * message here would mean maintaining the product's pricing copy in a published npm package, and
 * getting it wrong is worse than saying nothing.
 */
export function describeApiError(error: SkeletiqApiError): string {
    const lines: string[] = []
    const detail = asRecord(error.detail)

    switch (error.code) {
        case 'SESSION_AUTH_REQUIRED':
            lines.push(
                'That operation is not available to API tokens at all — it needs a signed-in browser session. ' +
                    'A wider token will not help; ask the user to do it in the SkeletIQ app.',
            )
            break

        case 'INSUFFICIENT_SCOPE': {
            const required = asString(detail?.required_scope)
            lines.push(
                required
                    ? `This API token does not carry the "${required}" scope.`
                    : 'This API token is not wide enough for that operation.',
            )
            lines.push(
                'Ask the user to mint a new token under Settings → Agent access with that scope ticked, ' +
                    'and update SKELETIQ_API_KEY.',
            )
            break
        }

        case 'INSUFFICIENT_CREDITS': {
            lines.push(error.message)
            const balance = detail?.balance
            const required = detail?.required
            if (typeof balance === 'number' && typeof required === 'number') {
                lines.push(`Balance ${balance}, this run needs up to ${required}.`)
            }
            const solutions = detail?.solutions
            if (Array.isArray(solutions)) {
                for (const solution of solutions) {
                    if (typeof solution === 'string') lines.push(`- ${solution}`)
                }
            }
            break
        }

        case 'PLAN_LIMIT_EXCEEDED':
        case 'FEATURE_NOT_AVAILABLE':
        case 'VERSION_LOCKED': {
            lines.push(error.message)
            const upgradeUrl = asString(detail?.upgrade_url)
            if (upgradeUrl) lines.push(`Upgrade: ${upgradeUrl}`)
            break
        }

        case 'BACKGROUND_JOBS_UNAVAILABLE':
            lines.push(
                'This SkeletIQ deployment runs no background worker, so a generation cannot be queued. ' +
                    'Call generate_architecture again with wait: true and it will run inline.',
            )
            break

        case 'IDEMPOTENCY_UNAVAILABLE':
            lines.push(
                'SkeletIQ could not confirm this was not a duplicate request, so it refused it. ' +
                    'Nothing was started and nothing was charged — retrying is safe.',
            )
            break

        case 'JOB_QUEUE_FULL': {
            const wait = detail?.retry_after_seconds
            lines.push('SkeletIQ\'s generation queue is full.')
            if (typeof wait === 'number') lines.push(`Try again in about ${wait} seconds.`)
            break
        }

        case 'ACTIVE_GENERATION_EXISTS':
            lines.push(
                'A generation is already running for this account. Wait for it to finish — ' +
                    'get_generation_status will tell you when — before starting another.',
            )
            break

        case 'RATE_LIMITED':
            lines.push(error.message)
            if (error.retryAfterSeconds !== undefined) {
                lines.push(`Retry after ${error.retryAfterSeconds} seconds.`)
            }
            break

        default:
            if (error.status === 401) {
                lines.push(
                    'SkeletIQ rejected the API token. It may be wrong, revoked or expired — SkeletIQ ' +
                        'answers all three identically, so there is nothing more specific to report. ' +
                        'Check SKELETIQ_API_KEY, or mint a new token under Settings → Agent access.',
                )
            } else {
                lines.push(error.message)
            }
    }

    if (error.requestId) lines.push(`(SkeletIQ request id: ${error.requestId})`)
    return lines.join('\n')
}
