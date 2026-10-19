import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { MAX_EVIDENCE_BYTES, verifyEvidence } from '../src/lib/evidence.js'

let base: string
let root: string
beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'evidence-'))
    root = path.join(base, 'repo')
    await mkdir(root)
})
afterEach(async () => {
    await rm(base, { recursive: true, force: true })
})

describe('verifyEvidence', () => {
    it('verifies a quote across reflowed whitespace', async () => {
        await writeFile(path.join(root, 'a.ts'), 'function  save(\n    user,\n    db,\n) {}\n')
        const result = await verifyEvidence(root, { path: 'a.ts', quote: 'function save( user, db, ) {}' })
        expect(result).toEqual({ path: 'a.ts', status: 'verified' })
    })

    it('accepts a file inside the root whose name starts with two dots', async () => {
        await writeFile(path.join(root, '..dots.ts'), 'const x = 1\n')
        const result = await verifyEvidence(root, { path: '..dots.ts', quote: 'const x = 1' })
        expect(result).toEqual({ path: '..dots.ts', status: 'verified' })
    })

    it('verifies a symbol on a word boundary only', async () => {
        await writeFile(path.join(root, 'a.ts'), 'const savedUser = 1\n')
        expect((await verifyEvidence(root, { path: 'a.ts', symbol: 'saved' })).status).toBe('failed')
        expect((await verifyEvidence(root, { path: 'a.ts', symbol: 'savedUser' })).status).toBe('verified')
    })

    it('fails a quote that is not in the file', async () => {
        await writeFile(path.join(root, 'a.ts'), 'hello')
        const result = await verifyEvidence(root, { path: 'a.ts', quote: 'Hello' })
        expect(result.status).toBe('failed')
    })

    it('refuses a path that climbs out of the root', async () => {
        const result = await verifyEvidence(root, { path: '../../etc/passwd', quote: 'root' })
        expect(result).toMatchObject({ status: 'failed', reason: 'outside the repository' })
    })

    it('refuses a symlink that leaves the root', async () => {
        await writeFile(path.join(base, 'secret.txt'), 'token')
        await symlink(path.join(base, 'secret.txt'), path.join(root, 'link.txt'))
        const result = await verifyEvidence(root, { path: 'link.txt', quote: 'token' })
        expect(result).toMatchObject({ status: 'failed', reason: 'outside the repository' })
    })

    it('refuses a file over the size limit', async () => {
        await writeFile(path.join(root, 'big.txt'), 'x'.repeat(2 * MAX_EVIDENCE_BYTES))
        const result = await verifyEvidence(root, { path: 'big.txt', quote: 'x' })
        expect(result.status).toBe('failed')
        expect(result.reason).toMatch(/too large/)
    })

    it('reports a missing file and a directory', async () => {
        await mkdir(path.join(root, 'dir'))
        expect(await verifyEvidence(root, { path: 'nope.ts', quote: 'a' })).toMatchObject({ reason: 'file not found' })
        expect(await verifyEvidence(root, { path: 'dir', quote: 'a' })).toMatchObject({ reason: 'not a regular file' })
    })

    it('fails a quote or symbol that is only whitespace', async () => {
        await writeFile(path.join(root, 'a.ts'), 'const x = 1\n')
        expect(await verifyEvidence(root, { path: 'a.ts', quote: ' \n\t' })).toEqual({
            path: 'a.ts',
            status: 'failed',
            reason: 'nothing cited to look for',
        })
        expect(await verifyEvidence(root, { path: 'a.ts', symbol: ' ' })).toEqual({
            path: 'a.ts',
            status: 'failed',
            reason: 'nothing cited to look for',
        })
    })

    it('names a read error without the local path', async () => {
        const file = path.join(root, 'locked.ts')
        await writeFile(file, 'secret')
        await chmod(file, 0o000)
        try {
            const result = await verifyEvidence(root, { path: 'locked.ts', quote: 'secret' })
            expect(result).toEqual({ path: 'locked.ts', status: 'failed', reason: 'file could not be read (EACCES)' })
            expect(JSON.stringify(result)).not.toContain(base)
        } finally {
            await chmod(file, 0o600)
        }
    })
})
