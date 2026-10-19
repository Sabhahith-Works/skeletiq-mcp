/**
 * Checking an agent's citations on its own machine.
 *
 * The quote or symbol an agent cites never leaves this process: only the path and the outcome are
 * sent to SkeletIQ.
 */

import { realpath, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

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

        if (!ref.quote && !ref.symbol) return failed('nothing cited to look for')
        const content = await readFile(target, 'utf8')

        if (ref.quote && !collapse(content).includes(collapse(ref.quote))) {
            return failed('cited text not found in file')
        }
        if (ref.symbol) {
            const pattern = new RegExp(`(?<![\\w$])${escapeRegExp(ref.symbol)}(?![\\w$])`)
            if (!pattern.test(content)) return failed('symbol not found in file')
        }
        return { path: shown, status: 'verified' }
    } catch (error) {
        return failed(error instanceof Error ? error.message : String(error))
    }
}
