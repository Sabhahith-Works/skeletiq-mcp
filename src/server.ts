/**
 * The server: six tools, and the paragraph that tells a host what they are for.
 *
 * `instructions` is the discovery surface. Most hosts prepend it to the system prompt, so it is
 * the one place to state the rules that are not visible from any single tool's description — the
 * fence semantics, what a draft means, and where the boundary between deciding and building sits.
 * It deliberately does not restate what the tool descriptions already say.
 */

import { McpServer } from '@modelcontextprotocol/server'

import { SERVER_NAME, SERVER_VERSION, type Config } from './config.js'
import { SkeletiqClient } from './http/client.js'
import { DesignResolver } from './lib/resolve.js'
import { registerCheckDrift } from './tools/check-drift.js'
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

    registerListProjects(server, resolver)
    registerGetDesign(server, client, resolver)
    registerGenerate(server, client, resolver)
    registerCritique(server, client)
    registerCheckDrift(server, client, resolver)

    return server
}
