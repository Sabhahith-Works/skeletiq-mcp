/**
 * The server: six tools, and the paragraph that tells a host what they are for.
 *
 * `instructions` is the discovery surface. Most hosts prepend it to the system prompt, so it is
 * the one place to state the rules that are not visible from any single tool's description — the
 * fence semantics, what a draft means, and where the boundary between deciding and building sits.
 * It deliberately does not restate what the tool descriptions already say.
 */

import { CLIENT_INFO_META_KEY, type Implementation, McpServer } from '@modelcontextprotocol/server'

import { SERVER_NAME, SERVER_VERSION, type Config } from './config.js'
import { SkeletiqClient } from './http/client.js'
import { DesignResolver } from './lib/resolve.js'
import { registerCheckDrift } from './tools/check-drift.js'
import { registerRequestDecisionChange } from './tools/request-decision-change.js'
import { registerCritique } from './tools/critique.js'
import { registerGenerate } from './tools/generate.js'
import { registerGetDesign } from './tools/get-design.js'
import { registerListProjects } from './tools/list-projects.js'

const INSTRUCTIONS = `SkeletIQ holds the system architecture this codebase is meant to implement: its components, \
how they connect, what was decided and why, and what is still an open question. It is the design's \
source of truth, and this server is how you read it.

Orient before you build. Call get_design with mode "brief" and write the block it returns into this \
repository's AGENTS.md. The block is fenced with an HTML comment (skeletiq:brief). If one is already \
there, replace it whole — opening fence to closing fence. Never append a second, and never edit \
inside it: a refresh overwrites the block, so anything written there is lost without warning.

Then build in the order get_design(mode: "build_order") gives you, reading each component with \
mode "component" as you reach it.

Four things that are easy to get wrong:

A DRAFT design has not been approved by anyone and can change under you on any edit. Prefer a \
released version, and if a tool tells you newer_release_exists, refresh the brief before going \
further.

Component ids belong to one version. A regeneration mints new ones, so an id from an older brief \
may name nothing. When check_drift returns unknown ids with suggestions, they are suggestions — put \
them to a person rather than assuming the mapping.

Open questions are for people. get_design(mode: "gaps") lists what the design has not settled. Raise \
them; do not answer them yourself and build on the answer. You cannot resolve them through this \
server, and that is deliberate.

Report what you build with check_drift, and declare covers when this repository implements only part \
of the design — otherwise every component built elsewhere is reported to you as missing.

Designing costs the account holder credits and takes minutes. Read before you generate.`

/**
 * One factory per process, holding one client and one resolver.
 *
 * The factory shape is what both entry points want — `serveStdio` pins one instance per
 * connection, `createMcpHandler` builds one per request — and the closure is what makes the
 * resolver's cache *survive* either choice. Building the resolver inside the server would tie the
 * cache to whatever the entry point happened to do with instances, which is not a property this
 * package should depend on: the credential is per-process, so the cache is too.
 */
export function createServerFactory(config: Config): () => McpServer {
    const client = new SkeletiqClient(config)
    const resolver = new DesignResolver(client)
    return () => buildServer(client, resolver)
}

/** A single server. Exported for tests that do not need a second instance. */
export function createServer(config: Config): McpServer {
    return createServerFactory(config)()
}

function buildServer(client: SkeletiqClient, resolver: DesignResolver): McpServer {
    const server = new McpServer(
        { name: SERVER_NAME, version: SERVER_VERSION },
        { instructions: INSTRUCTIONS, capabilities: { tools: {} } },
    )

    // One host per stdio process, so the most recently built server is the live one and the
    // client reads its host from there. A 2026-07-28 host sends no `initialize`: it names itself
    // on every request's `_meta` envelope, and the stdio entry does not copy that into
    // getClientVersion(). So the envelope of the latest tool call wins, and the handshake value
    // covers 2025-era hosts.
    let envelopeHost: Implementation | undefined
    recordEnvelopeHost(server, (host) => {
        envelopeHost = host
    })
    client.setHostSource(() => envelopeHost ?? server.server.getClientVersion())

    registerListProjects(server, resolver)
    registerGetDesign(server, client, resolver)
    registerGenerate(server, client, resolver)
    registerCritique(server, client)
    registerCheckDrift(server, client, resolver)
    registerRequestDecisionChange(server, client, resolver)

    return server
}

type ToolHandler = (...args: unknown[]) => unknown

/**
 * Wraps `registerTool` so every tool call reports the host named in its request envelope before the
 * tool runs. The SDK passes the request context as the handler's last argument, with or without an
 * input schema.
 */
function recordEnvelopeHost(server: McpServer, record: (host: Implementation) => void): void {
    const register = server.registerTool.bind(server) as unknown as (
        name: string,
        config: unknown,
        handler: ToolHandler,
    ) => unknown
    const registerRecording = (name: string, config: unknown, handler: ToolHandler): unknown =>
        register(name, config, (...args: unknown[]) => {
            const host = envelopeHostOf(args.at(-1))
            if (host) record(host)
            return handler(...args)
        })
    server.registerTool = registerRecording as unknown as typeof server.registerTool
}

/** The host's name and version from a request context's `_meta` envelope, when it carries them. */
export function envelopeHostOf(ctx: unknown): Implementation | undefined {
    const envelope = (ctx as { mcpReq?: { envelope?: Record<string, unknown> } } | undefined)?.mcpReq?.envelope
    const info = envelope?.[CLIENT_INFO_META_KEY]
    if (typeof info !== 'object' || info === null) return undefined
    const { name, version } = info as { name?: unknown; version?: unknown }
    if (typeof name !== 'string' || !name) return undefined
    return { name, version: typeof version === 'string' ? version : '' }
}
