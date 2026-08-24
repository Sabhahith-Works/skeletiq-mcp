/**
 * The error relay — one case per row of the table in `http/errors.ts`.
 *
 * Every assertion here is on the *discriminator* and the next step, never on the exact prose. A
 * test that pins the wording turns every copy edit into a failure and stops testing anything.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { parseApiError } from '../src/http/errors.js'
import { normalizeApiUrl, readConfig, ConfigError, DEFAULT_API_URL } from '../src/config.js'
import { baseRoutes, fakeApi, startHarness, type Harness } from './harness.js'

let harness: Harness | undefined
afterEach(async () => {
    await harness?.close()
    harness = undefined
})

async function callWith(status: number, body: unknown, headers?: Record<string, string>): Promise<string> {
    const api = fakeApi([{ match: 'GET /api/v1/projects/', status, body, ...(headers ? { headers } : {}) }])
    harness = await startHarness(api.fetch)
    const result = await harness.call('list_projects', {})
    expect(result.isError).toBe(true)
    return result.content.map((block) => block.text ?? '').join('\n')
}

function envelope(code: string, message: string, detail?: unknown) {
    return { error: { code, message, request_id: 'req-1', ...(detail === undefined ? {} : { detail }) } }
}

describe('authentication and scope', () => {
    it('does not guess why a 401 happened, because the server does not say', async () => {
        const text = await callWith(401, envelope('UNAUTHORIZED', 'Invalid or expired token'))

        // Unknown, revoked and expired are one answer by design — there is nothing more specific
        // to report, and inventing a reason would send the user looking in the wrong place.
        expect(text).toMatch(/SKELETIQ_API_KEY/)
        expect(text).toMatch(/wrong, revoked or expired/)
    })

    it('names the scope to mint on an INSUFFICIENT_SCOPE', async () => {
        const text = await callWith(
            403,
            envelope('INSUFFICIENT_SCOPE', "This API token does not carry the 'generate' scope.", {
                message: "This API token does not carry the 'generate' scope.",
                required_scope: 'generate',
                token_scopes: ['read'],
            }),
        )

        expect(text).toMatch(/"generate" scope/)
        expect(text).toMatch(/mint a new token/)
    })

    it('says a wider token will not help on SESSION_AUTH_REQUIRED', async () => {
        const text = await callWith(
            403,
            envelope('SESSION_AUTH_REQUIRED', 'not available', {
                message: 'This endpoint is not available to API tokens. Sign in to use it.',
                route: '/api/v1/auth/api-tokens',
            }),
        )

        // The two 403s are different codes precisely so a client can tell a fixable problem from a
        // permanent one. Telling the user to mint a wider token here wastes their time.
        expect(text).toMatch(/A wider token will not help/)
        expect(text).not.toMatch(/mint a new token/)
    })
})

describe('money', () => {
    it('reads a 402 out of the detail, never out of the message', async () => {
        // Some 402 sites send a detail dict with no `message` key, and the server then leaves
        // `error.message` as a Python str() of that dict.
        const text = await callWith(
            402,
            envelope('INSUFFICIENT_CREDITS', "{'error': 'Insufficient credits', 'balance': 3}", {
                error: 'Insufficient credits',
                balance: 3,
                required: 10,
                shortfall: 7,
                solutions: ['Buy a credit pack at /pricing'],
            }),
        )

        expect(text).toMatch(/Balance 3, this run needs up to 10/)
        expect(text).toMatch(/Buy a credit pack/)
        expect(text).not.toMatch(/\{'error'/)
    })

    it('passes an upsell through as the product wrote it', async () => {
        const text = await callWith(
            403,
            envelope('PLAN_LIMIT_EXCEEDED', 'limit', {
                code: 'PLAN_LIMIT_EXCEEDED',
                message: 'Free plan projects are limited to 3.',
                upgrade_url: '/settings#billing',
            }),
        )

        // Rewording a paywall here would mean maintaining the product's pricing copy inside a
        // published npm package.
        expect(text).toContain('Free plan projects are limited to 3.')
        expect(text).toContain('/settings#billing')
    })
})

describe('the daily generation allowance', () => {
    it('reports the refusal as prose, never as the payload it arrived in', async () => {
        // The regression this pins: the gate's detail carried its sentence under `error` and no
        // `message`, so `error.message` was the dict's Python repr and an agent was handed
        // `{'error': 'Rate limit exceeded', 'action': 'generate', ...}` to reason about.
        const text = await callWith(
            429,
            envelope('DAILY_LIMIT_REACHED', "You've used all 5 of today's design generations on the free plan.", {
                code: 'DAILY_LIMIT_REACHED',
                message: "You've used all 5 of today's design generations on the free plan.",
                limit: 5,
                current: 5,
                plan: 'free',
                reset_at: '2026-08-25T00:00:00+00:00',
                upgrade_url: '/settings#billing',
            }),
        )

        expect(text).toContain("You've used all 5 of today's design generations on the free plan.")
        expect(text).toContain('2026-08-25T00:00:00+00:00')
        expect(text).toContain('/settings#billing')
        expect(text).not.toMatch(/\{'error'/)
    })

    it('is not retryable, unlike every other 429', async () => {
        // An allowance that refills in hours cannot be waited out inside a session; a caller
        // backing off and retrying would spend its budget on a call that cannot succeed today.
        const spent = parseApiError(429, { error: { code: 'DAILY_LIMIT_REACHED', message: 'spent' } }, undefined)
        const burst = parseApiError(429, { error: { code: 'RATE_LIMITED', message: 'slow down' } }, undefined)

        expect(spent.isRetryable).toBe(false)
        expect(burst.isRetryable).toBe(true)
    })
})

describe('availability', () => {
    it('says a refused idempotency check cost nothing', async () => {
        const text = await callWith(
            503,
            envelope('SERVICE_UNAVAILABLE', 'could not verify', {
                code: 'IDEMPOTENCY_UNAVAILABLE',
                message: 'We could not verify this is not a duplicate request.',
            }),
        )

        expect(text).toMatch(/Nothing was started and nothing was charged/)
        expect(text).toMatch(/retrying is safe/i)
    })

    it('honours Retry-After on a 429', async () => {
        const text = await callWith(
            429,
            envelope('RATE_LIMITED', 'Too many requests', { error: 'Too many requests', limit: 60, retry_after: 37 }),
            { 'Retry-After': '37' },
        )

        expect(text).toMatch(/Retry after 37 seconds/)
    })

    it('tells the agent to wait for the generation already running', async () => {
        const text = await callWith(
            409,
            envelope('CONFLICT', 'conflict', {
                code: 'ACTIVE_GENERATION_EXISTS',
                message: 'A generation is already in progress.',
            }),
        )

        expect(text).toMatch(/already running/)
        expect(text).toMatch(/get_generation_status/)
    })
})

describe('the envelope parser', () => {
    it('prefers detail.code, because the top-level code often cannot discriminate', () => {
        const error = parseApiError(503, envelope('SERVICE_UNAVAILABLE', 'x', { code: 'JOB_QUEUE_FULL' }))
        expect(error.code).toBe('JOB_QUEUE_FULL')
    })

    it('survives a body that is not the envelope at all', () => {
        const error = parseApiError(502, '<html>Bad Gateway</html>')
        expect(error.status).toBe(502)
        expect(error.code).toBe('HTTP_502')
        expect(error.message).toMatch(/HTTP 502/)
    })

    it('carries the request id so a report can be traced', () => {
        const error = parseApiError(500, envelope('INTERNAL_ERROR', 'boom'))
        expect(error.requestId).toBe('req-1')
    })
})

describe('unreachable server', () => {
    it('names the URL it could not reach', async () => {
        const failing = (async () => {
            throw new TypeError('fetch failed')
        }) as unknown as typeof fetch
        harness = await startHarness(failing)

        const result = await harness.call('list_projects', {})

        expect(result.isError).toBe(true)
        expect(result.content.map((b) => b.text).join('\n')).toMatch(/api\.test\.invalid/)
    })
})

describe('configuration', () => {
    it('refuses a browser session token before the transport opens', () => {
        expect(() => readConfig({ SKELETIQ_API_KEY: 'eyJhbGciOi' } as NodeJS.ProcessEnv)).toThrow(ConfigError)
    })

    it('explains what to do when the key is missing', () => {
        expect(() => readConfig({} as NodeJS.ProcessEnv)).toThrow(/Settings → Agent access/)
    })

    it('tolerates the URL forms people actually type', () => {
        expect(normalizeApiUrl(undefined)).toBe(DEFAULT_API_URL)
        expect(normalizeApiUrl('https://api.example.com/')).toBe('https://api.example.com')
        // A careful person copies the base out of a curl example, prefix and all.
        expect(normalizeApiUrl('https://api.example.com/api/v1')).toBe('https://api.example.com')
        expect(normalizeApiUrl('http://localhost:8000')).toBe('http://localhost:8000')
    })

    it('rejects a URL that is not one', () => {
        expect(() => normalizeApiUrl('api.example.com')).toThrow(ConfigError)
    })
})

describe('the free critique', () => {
    it('says what to do when only a prose plan is on offer', async () => {
        const api = fakeApi(baseRoutes())
        harness = await startHarness(api.fetch)

        const result = await harness.call('critique_architecture', {})

        expect(result.isError).toBe(true)
        expect(result.content.map((b) => b.text).join('\n')).toMatch(/generate_architecture first/)
    })

    it('sorts findings by severity and never bills', async () => {
        const api = fakeApi([
            {
                match: 'POST /api/v1/handoff/critique',
                body: {
                    architecture_score: 72.5,
                    security_score: 60,
                    performance_score: 80,
                    resilience_score: 70,
                    data_score: 90,
                    findings: [
                        { message: 'Minor thing', pattern_id: 'p1', category: 'risk', severity: 'low' },
                        { message: 'No auth on the gateway', pattern_id: 'p2', category: 'risk', severity: 'critical', remediation: 'Add auth.' },
                    ],
                },
            },
        ])
        harness = await startHarness(api.fetch)

        const result = await harness.call('critique_architecture', {
            architecture_json: {
                title: 'X',
                description: 'Y',
                components: [{ id: 'a', name: 'A', type: 'service' }],
                connections: [],
            },
        })

        const findings = result.structuredContent?.findings as { severity: string }[]
        expect(findings.map((f) => f.severity)).toEqual(['critical', 'low'])
        expect(result.content.map((b) => b.text).join('\n')).toMatch(/Fix: Add auth\./)
        // The deterministic critique is the free floor; it must not reach a paid route.
        expect(api.calls.every((call) => !call.url.includes('/architectures/'))).toBe(true)
    })
})
