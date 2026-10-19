/**
 * Drift on a seeded repository: the evidence step flags the seeded gaps and nothing else.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { PROJECT_ID, baseRoutes, driftRoute, fakeApi, startHarness, type Harness } from './harness.js'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'drift-repo')

let harness: Harness | undefined
afterEach(async () => {
    await harness?.close()
    harness = undefined
})

interface SentComponent {
    id: string
    status: string
    evidence?: { path: string; status: string; reason?: string }[]
}

describe('seeded drift repository', () => {
    it('sends evidence checks that fail only the seeded gaps', async () => {
        const api = fakeApi(baseRoutes([driftRoute({ evidence_checked: true })]))
        harness = await startHarness(api.fetch)

        await harness.call('check_drift', {
            project_id: PROJECT_ID,
            repo_root: REPO,
            components: [
                {
                    id: 'orders',
                    status: 'implemented',
                    evidence: [{ path: 'src/orders/api.ts', quote: 'requireAuth(token)' }],
                },
                {
                    id: 'payments',
                    status: 'implemented',
                    evidence: [{ path: 'src/payments/charge.ts', symbol: 'charge' }],
                },
                {
                    id: 'auth',
                    status: 'implemented',
                    evidence: [{ path: 'src/auth/middleware.ts', quote: 'verifyJwtSignature(token)' }],
                },
                { id: 'notifications', status: 'not_started' },
            ],
            fitness: [
                {
                    test_id: 'auth-401',
                    status: 'pass',
                    test_path: 'tests/orders.test.ts',
                    quote: 'returns 401 without a token',
                },
                { test_id: 'audit-log', status: 'pass' },
            ],
        })

        const call = api.calls.find((entry) => entry.url.includes('drift-check'))
        const body = call?.body as { components: SentComponent[]; fitness: { test_id: string; status: string; evidence: unknown[] }[] }

        expect(body.components).toEqual([
            { id: 'orders', status: 'implemented', evidence: [{ path: 'src/orders/api.ts', status: 'verified' }] },
            {
                id: 'payments',
                status: 'implemented',
                evidence: [{ path: 'src/payments/charge.ts', status: 'failed', reason: 'file not found' }],
            },
            {
                id: 'auth',
                status: 'implemented',
                evidence: [{ path: 'src/auth/middleware.ts', status: 'failed', reason: 'cited text not found in file' }],
            },
            { id: 'notifications', status: 'not_started' },
        ])
        expect(body.fitness).toEqual([
            { test_id: 'auth-401', status: 'pass', evidence: [{ path: 'tests/orders.test.ts', status: 'verified' }] },
            { test_id: 'audit-log', status: 'pass', evidence: [] },
        ])

        const failed = [
            ...body.components.flatMap((component) =>
                (component.evidence ?? []).filter((ref) => ref.status === 'failed').map(() => component.id),
            ),
            ...body.fitness
                .filter((entry) => (entry.evidence as { status: string }[]).some((ref) => ref.status === 'failed'))
                .map((entry) => entry.test_id),
        ]
        expect(failed).toEqual(['payments', 'auth'])
    })
})
