/**
 * Checking an agent's citations on its own machine.
 *
 * The quote or symbol an agent cites never leaves this process: only the path and the outcome are
 * sent to SkeletIQ.
 */

import { realpath, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

import * as z from 'zod/v4'

export const MAX_EVIDENCE_BYTES = 1_000_000
export const MAX_REFS_PER_CLAIM = 5

export interface EvidenceRef {
    path: string
    quote?: string | undefined
    symbol?: string | undefined
}

export interface EvidenceResult {
    path: string
    status: 'verified' | 'failed'
    reason?: string
}

/** One citation an agent gives for a claim: a file, and a quote or symbol that must be in it. */
export const evidenceRef = z
    .object({
        path: z.string().min(1).max(512).describe('The file, relative to the repo root.'),
        quote: z.string().min(1).max(2000).optional().describe('Text that must appear in the file. Checked locally, never sent.'),
        symbol: z.string().min(1).max(255).optional().describe('An identifier that must appear in the file. Checked locally, never sent.'),
    })
    .refine((ref) => ref.quote !== undefined || ref.symbol !== undefined, {
        message: 'each evidence entry needs a quote or a symbol',
    })

/** The repository root, resolved; null when it is missing or not a directory. */
export async function resolveRepoRoot(requested: string): Promise<string | null> {
    try {
        const root = await realpath(requested)
        return (await stat(root)).isDirectory() ? root : null
    } catch {
        return null
    }
}

const MAX_PATH = 512
const MAX_REASON = 200

function collapse(text: string): string {
    return text.replace(/\s+/g, ' ').trim()
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function inside(root: string, target: string): boolean {
    const relative = path.relative(root, target)
    return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
}

export async function verifyEvidence(root: string, ref: EvidenceRef): Promise<EvidenceResult> {
    const shown = ref.path.slice(0, MAX_PATH)
    const failed = (reason: string): EvidenceResult => ({
        path: shown,
        status: 'failed',
        reason: reason.slice(0, MAX_REASON),
    })

    try {
        const realRoot = await realpath(root)
        const lexical = path.resolve(realRoot, ref.path)
        if (!inside(realRoot, lexical)) return failed('outside the repository')

        let target: string
        try {
            target = await realpath(lexical)
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return failed('file not found')
            throw error
        }
        if (!inside(realRoot, target)) return failed('outside the repository')

        const info = await stat(target)
        if (!info.isFile()) return failed('not a regular file')
        if (info.size > MAX_EVIDENCE_BYTES) return failed(`file too large (over ${MAX_EVIDENCE_BYTES} bytes)`)

        // Whitespace alone collapses to '', which every file contains: it cites nothing.
        const quote = ref.quote === undefined ? '' : collapse(ref.quote)
        const symbol = ref.symbol?.trim() ?? ''
        if (!quote && !symbol) return failed('nothing cited to look for')
        const content = await readFile(target, 'utf8')

        if (quote && !collapse(content).includes(quote)) {
            return failed('cited text not found in file')
        }
        if (symbol) {
            const pattern = new RegExp(`(?<![\\w$])${escapeRegExp(symbol)}(?![\\w$])`)
            if (!pattern.test(content)) return failed('symbol not found in file')
        }
        return { path: shown, status: 'verified' }
    } catch (error) {
        // Only the error code: a Node fs message carries the absolute local path, which must not leave the machine.
        const code = (error as NodeJS.ErrnoException | undefined)?.code
        return failed(typeof code === 'string' ? `file could not be read (${code})` : 'file could not be read')
    }
}
