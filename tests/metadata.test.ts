/**
 * The publish metadata, tied together.
 *
 * Shipping a version means moving the same string through four places that nothing else connects:
 * `package.json`, the `SERVER_VERSION` literal the server reports over MCP, and both version fields
 * in `server.json`. A mismatch between the last two is what `mcp-publisher` rejects — after the npm
 * publish it is validating against has already happened, and npm publishes are not undoable.
 *
 * These read the files rather than importing them: the tsconfig has no `resolveJsonModule`, and a
 * JSON import would be resolved by the bundler rather than by whatever `npm publish` actually reads.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { SERVER_VERSION } from '../src/config.js'

function readJson(name: string): Record<string, unknown> {
    const path = fileURLToPath(new URL(`../${name}`, import.meta.url))
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

const pkg = readJson('package.json')
const server = readJson('server.json')
const npmPackage = (server.packages as Record<string, unknown>[])[0]!

describe('publish metadata', () => {
    it('reports one version everywhere it is written down', () => {
        expect(SERVER_VERSION).toBe(pkg.version)
        expect(server.version).toBe(pkg.version)
        expect(npmPackage.version).toBe(pkg.version)
    })

    it('claims the registry name the published tarball will carry', () => {
        // The registry proves ownership by fetching the tarball and matching its `mcpName` against
        // `server.json`'s `name`. Drift here fails at publish time with a message about validation,
        // not about a typo.
        expect(server.name).toBe(pkg.mcpName)
        expect(npmPackage.identifier).toBe(pkg.name)
        expect(npmPackage.registryType).toBe('npm')
    })

    it('keeps server.json out of the published tarball', () => {
        // It is registry metadata, not something a consumer installs.
        expect(pkg.files).toEqual(['dist', 'LICENSE', 'README.md'])
    })

    it('declares both environment variables the server actually reads', () => {
        const names = (npmPackage.environmentVariables as { name: string; isSecret?: boolean }[]).map((v) => v.name)
        expect(names).toEqual(['SKELETIQ_API_KEY', 'SKELETIQ_API_URL'])
        const key = (npmPackage.environmentVariables as { name: string; isSecret?: boolean }[])[0]!
        expect(key.isSecret).toBe(true)
    })
})
