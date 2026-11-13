/**
 * The User-Agent names the MCP host, and cannot be made invalid by what the host calls itself.
 */

import { Client } from '@modelcontextprotocol/client'
import {
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    InMemoryTransport,
    type JSONRPCMessage,
    PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { afterEach, describe, expect, it } from 'vitest'

import { SERVER_VERSION } from '../src/config.js'
import { HOST_TOKEN_MAX, userAgent } from '../src/http/client.js'
import { createServerFactory, envelopeHostOf } from '../src/server.js'
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

    it('names a 2026-era host that sends no initialize', async () => {
        const api = fakeApi(baseRoutes())
        globalThis.fetch = api.fetch

        // Claude Code on protocol 2026-07-28 skips the handshake and names itself on every
        // request's `_meta` envelope, so getClientVersion() never fills in on the stdio entry.
        const meta = {
            [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
            [CLIENT_INFO_META_KEY]: { name: 'claude-code', version: '2.1.323' },
            [CLIENT_CAPABILITIES_META_KEY]: {},
        }
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
        const replies = new Map<number, (message: JSONRPCMessage) => void>()
        clientSide.onmessage = (message) => {
            if ('id' in message && typeof message.id === 'number') replies.get(message.id)?.(message)
        }
        const handle = serveStdio(createServerFactory(TEST_CONFIG), { transport: serverSide })
        await clientSide.start()
        const request = (id: number, method: string, params: Record<string, unknown>) =>
            new Promise<JSONRPCMessage>((resolve) => {
                replies.set(id, resolve)
                void clientSide.send({ jsonrpc: '2.0', id, method, params: { ...params, _meta: meta } })
            })
        try {
            await request(1, 'server/discover', {})
            const reply = await request(2, 'tools/call', { name: 'list_projects', arguments: {} })
            expect('error' in reply).toBe(false)
        } finally {
            await clientSide.close()
            await handle.close()
        }

        expect(api.calls[0]?.headers['user-agent']).toBe(`skeletiq-mcp/${SERVER_VERSION} (claude-code/2.1.323)`)
    })

    it('reads the host from a request envelope', () => {
        const ctx = (info: unknown) => ({ mcpReq: { envelope: { [CLIENT_INFO_META_KEY]: info } } })
        expect(envelopeHostOf(ctx({ name: 'claude-code', version: '2.1.323' }))).toEqual({
            name: 'claude-code',
            version: '2.1.323',
        })
        expect(envelopeHostOf(ctx({ name: 'cursor' }))).toEqual({ name: 'cursor', version: '' })
        expect(envelopeHostOf(ctx({ name: '' }))).toBeUndefined()
        expect(envelopeHostOf(ctx('claude-code'))).toBeUndefined()
        expect(envelopeHostOf({ mcpReq: {} })).toBeUndefined()
        expect(envelopeHostOf(undefined)).toBeUndefined()
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
