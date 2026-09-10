/**
 * What the server needs from its environment, and nothing more.
 *
 * Two variables. A coding agent's MCP config is a JSON blob a person edits by hand once, so every
 * knob added here is a knob that gets set wrong somewhere.
 */

export const SERVER_NAME = 'skeletiq'
export const SERVER_VERSION = '0.1.1'

/** The hosted API. Overridden only for self-hosted installs and local development. */
export const DEFAULT_API_URL = 'https://api.skeletiq.com'

/** Personal API tokens are prefixed so they are recognisable in a log or a paste. */
const TOKEN_PREFIX = 'skq_'

export interface Config {
    /** Base origin, no trailing slash and no `/api/v1` — the client adds the prefix. */
    apiUrl: string
    apiKey: string
}

export class ConfigError extends Error {}

/**
 * Read the configuration, or explain precisely what is missing.
 *
 * This throws before the transport opens, so the message lands in the host's startup log rather
 * than in a tool result nobody sees. That is the only chance to be helpful: an MCP server that
 * fails after connecting looks to the user like a broken tool, not a missing key.
 */
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
    const apiKey = (env.SKELETIQ_API_KEY ?? '').trim()
    if (!apiKey) {
        throw new ConfigError(
            'SKELETIQ_API_KEY is not set. Create a token in SkeletIQ under Settings → Agent access ' +
                'and put it in this server\'s env. It needs the "read" scope at minimum; add "generate" ' +
                'to let the agent create designs and "report" to let it check drift.',
        )
    }
    if (!apiKey.startsWith(TOKEN_PREFIX)) {
        // Worth catching early: the most common mistake is pasting a session token out of the
        // browser, which will authenticate against nothing and 401 on every single call.
        throw new ConfigError(
            `SKELETIQ_API_KEY does not look like a SkeletIQ API token (they start with "${TOKEN_PREFIX}"). ` +
                'Personal API tokens are created under Settings → Agent access.',
        )
    }

    return { apiUrl: normalizeApiUrl(env.SKELETIQ_API_URL), apiKey }
}

/**
 * Tolerate the URL forms people actually type.
 *
 * A trailing slash, or a base that already ends in `/api/v1`, are both things a careful person
 * writes on purpose after reading a curl example. Neither should produce a 404 with no explanation.
 */
export function normalizeApiUrl(raw: string | undefined): string {
    const value = (raw ?? '').trim()
    if (!value) return DEFAULT_API_URL

    let url: URL
    try {
        url = new URL(value)
    } catch {
        throw new ConfigError(`SKELETIQ_API_URL is not a valid URL: ${value}`)
    }

    const path = url.pathname.replace(/\/+$/, '').replace(/\/api\/v1$/, '')
    return `${url.origin}${path}`
}
