/**
 * The User-Agent names the MCP host, and cannot be made invalid by what the host calls itself.
 */

import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { afterEach, describe, expect, it } from 'vitest'

import { SERVER_VERSION } from '../src/config.js'
import { HOST_TOKEN_MAX, userAgent } from '../src/http/client.js'
import { createServerFactory } from '../src/server.js'
import { baseRoutes, fakeApi, TEST_CONFIG } from './harness.js'

const previousFetch = globalThis.fetch
afterEach(() => {
    globalThis.fetch = previousFetch
})

describe('the User-Agent', () => {
    it('names the host in the User-Agent', async () => {
        const api = fakeApi(baseRoutes())
        globalThis.fetch = api.fetch

        // The shipped entry keeps one server per connection, so it is the one that sees `initialize`.
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
        const handle = serveStdio(createServerFactory(TEST_CONFIG), { transport: serverSide })
        const client = new Client({ name: 'harness', version: '0.0.0' })
        try {
            await client.connect(clientSide)
            await client.callTool({ name: 'list_projects', arguments: {} })
        } finally {
            await client.close()
            await handle.close()
        }

        expect(api.calls[0]?.headers['user-agent']).toBe(`skeletiq-mcp/${SERVER_VERSION} (harness/0.0.0)`)
    })

    it('without a host', () => {
        expect(userAgent(undefined)).toBe(`skeletiq-mcp/${SERVER_VERSION}`)
    })

    it('sanitizes host fields', () => {
        expect(userAgent({ name: 'Claude Code\r\nX: (y)', version: '2.1' })).toBe(
            `skeletiq-mcp/${SERVER_VERSION} (Claude-Code--X---y-/2.1)`,
        )
    })

    it('cuts long host fields', () => {
        const ua = userAgent({ name: 'a'.repeat(100), version: '1' })
        expect(ua).toBe(`skeletiq-mcp/${SERVER_VERSION} (${'a'.repeat(HOST_TOKEN_MAX)}/1)`)
        expect(HOST_TOKEN_MAX).toBe(64)
    })
})
