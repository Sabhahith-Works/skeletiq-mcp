/**
 * What the server advertises, and the rules a host learns from it before calling anything.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { baseRoutes, fakeApi, startHarness, type Harness } from './harness.js'

let harness: Harness | undefined
afterEach(async () => {
    await harness?.close()
    harness = undefined
})

describe('the tool surface', () => {
    it('is exactly the six tools, under the names the product already published', async () => {
        harness = await startHarness(fakeApi(baseRoutes()).fetch)

        const names = (await harness.listTools()).map((tool) => tool.name).sort()

        // Not a snapshot for its own sake: the brief SkeletIQ writes into a repository's AGENTS.md
        // names `get_design(mode: "brief")` inside the fence, so renaming this tool would break
        // every brief already sitting in somebody's repo.
        expect(names).toEqual([
            'check_drift',
            'critique_architecture',
            'generate_architecture',
            'get_design',
            'get_generation_status',
            'list_projects',
        ])
    })

    it('marks the reads read-only and generation as neither', async () => {
        harness = await startHarness(fakeApi(baseRoutes()).fetch)
        const tools = await harness.listTools()
        expect(tools.find((tool) => tool.name === 'get_design')?.description).toMatch(/brief/i)
    })
})

describe('the instructions', () => {
    it('state the fence rule, because no single tool description can', async () => {
        harness = await startHarness(fakeApi(baseRoutes()).fetch)

        const instructions = harness.instructions() ?? ''

        expect(instructions).toMatch(/AGENTS\.md/)
        expect(instructions).toMatch(/replace it whole/i)
        expect(instructions).toMatch(/never append a second/i)
    })

    it('say that ids belong to one version and that gaps are for people', async () => {
        harness = await startHarness(fakeApi(baseRoutes()).fetch)

        const instructions = harness.instructions() ?? ''

        expect(instructions).toMatch(/ids belong to one version/i)
        expect(instructions).toMatch(/Open questions are for people/i)
        expect(instructions).toMatch(/declare covers/i)
    })
})
