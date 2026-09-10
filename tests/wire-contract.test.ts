/**
 * The connector, checked against a written statement of what the API sends.
 *
 * `src/wire/schemas.ts` mirrors the SkeletIQ API's response models by hand, and every object in it
 * is **lenient on purpose** — a published package has to keep working against a server it was not
 * built alongside. The cost of that leniency is invisible: a field the connector does not name
 * arrives, parses cleanly, and is thrown away. No error, no warning, no failing test. Three fields
 * were being discarded that way while the rest of this suite was green, one of them the list a
 * person sees on screen headed "It will carry:".
 *
 * So the API writes down what it sends — `tests/contract/api-wire-contract.json`, generated from
 * the live pydantic models — and this file asks one question of it: **does the connector name
 * everything in there?** A field it does not name is either mirrored, or written down here with a
 * reason. Nothing gets to be an oversight twice.
 *
 * The split is deliberate. This half needs Node and nothing else: the contract lives inside this
 * package, so it travels with the package and runs in the standalone repo too. The other half —
 * "is that file still a true statement about the API?" — needs Python and lives with the Python
 * (`packages/api/tests/test_wire_contract.py`). The file is the seam.
 *
 * The check is one-directional. **The API stays free to add fields**; adding one turns nothing red
 * there. It makes this file stale, and regenerating it turns *this* suite red, in front of the
 * person who maintains the connector — which is the only place the decision can actually be taken.
 *
 * **What this cannot catch: naming is not reading.** Adding a key to a schema satisfies every
 * assertion below while `lib/slice.ts` still ignores it. This closes the silent *discard*; whether
 * the agent is shown the value is a question for the tests that read the rendered text. It is also
 * blind to untyped payloads, to a `Literal` gaining a value, to fields a handler injects after the
 * model, and to a field whose meaning changed under a stable name.
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'
import * as z from 'zod/v4'

import * as wire from '../src/wire/schemas.js'

// ─── The contract ────────────────────────────────────────────────────

interface ContractField {
    required: boolean
    nullable: boolean
    kind: 'scalar' | 'list' | 'map' | 'object' | 'union' | 'any'
    item: string | null
}

interface ContractSchema {
    python_model: string
    authority: string
    endpoints: string[]
    fields: Record<string, ContractField>
}

interface Contract {
    contract_version: number
    schemas: Record<string, ContractSchema>
    no_authority: Record<string, string>
}

/**
 * `readFileSync`, not `import`: the tsconfig has no `resolveJsonModule`, and — more to the point —
 * a missing contract must be an **error**, never a silent skip. A suite that quietly stops checking
 * when its input goes missing is how the drift this file exists to catch got shipped in the first
 * place.
 */
const contract = JSON.parse(
    readFileSync(new URL('./contract/api-wire-contract.json', import.meta.url), 'utf8'),
) as Contract

// ─── The two exemption tables ────────────────────────────────────────

/**
 * Fields the API sends and the connector deliberately does not mirror, each with the reason.
 *
 * A warning would have been ignored for exactly the reason the original defect shipped past a green
 * suite, so an unnamed field **fails**. This table is the only way out, and it is a decision rather
 * than a shrug: one entry per field, a written reason, and a test below that deletes-by-failing any
 * entry naming a field the API no longer has, so it cannot rot into a blanket.
 */
/**
 * Reasons shared by a whole group of fields, named rather than repeated. A field pointing at one of
 * these carries the same real reason as the rest of its group — the alternative, an entry reading
 * "same as above", is how a table of decisions turns into a table of shrugs.
 */
const RUN_PROVENANCE =
    'Provenance of the generation run — which model, how it was routed, what it kept. An agent is ' +
    'building the design, not auditing how it was produced.'
const RENDERED_ARTEFACT =
    'A rendered artefact for the canvas. The agent is handed the components and connections it is ' +
    'drawn from, which is strictly more than the picture.'
const REVIEW_OUTPUT =
    'Review output rather than design. An agent gets a critique from `critique_architecture`, on ' +
    'demand and against the version it actually holds.'
const PERSON_FEEDBACK =
    "The person's own feedback on the design, recorded so the product can learn from it. It says " +
    'nothing about what to build.'
const NARROWED_BY_CRITIQUE_TOOL =
    "Narrowed by the critique tool's own `outputSchema`, which publishes a five-field finding — " +
    'severity, category, message, affected_components, remediation. That is a promise to the agent ' +
    'about what a finding is; mirroring more here would not reach one.'
const QUESTIONS_AND_NOTHING_ELSE =
    'The 409 intent-decision body is read for its clarifying questions and nothing else — the ' +
    'refusal is recognised by their presence, not by anything else in the envelope.'

const ACKNOWLEDGED_UNREAD: Record<string, Record<string, string>> = {
    ArchitectureJsonSchema: {
        grounding:
            'Analysis of how the design was produced, not the design. `lib/slice.ts` states the ' +
            'rule: the overview is the whole design, minus the analysis blocks an agent has no use for.',
        generator_confidence: 'Same rule — a self-report about the generation run.',
        verification: 'Same rule — the post-generation check, reported to the person in the SPA.',
    },
    ArchitectureSchema: {
        critique: REVIEW_OUTPUT,
        critique_depth: REVIEW_OUTPUT,
        compliance: REVIEW_OUTPUT,
        diagrams: RENDERED_ARTEFACT,
        diagram_source: RENDERED_ARTEFACT,
        diagram_errors: RENDERED_ARTEFACT,
        model_used: RUN_PROVENANCE,
        preservation: RUN_PROVENANCE,
        user_rating: PERSON_FEEDBACK,
        user_feedback_tags: PERSON_FEEDBACK,
        user_approved_at: PERSON_FEEDBACK,
    },
    ComponentSchema: {
        source_ids:
            'Retrieved corpus source ids supporting this component — grounding provenance, the same ' +
            'class as `ArchitectureJsonSchema.grounding`.',
        properties:
            'Free-form `dict[str, Any]`. Nothing on the wire says what a key means, so there is ' +
            'nothing an agent could reliably do with it. The API notes it is the field that already ' +
            'makes this schema unusable for strict structured output.',
    },
    ConnectionSchema: {
        traffic_weight: 'A fraction used for cost weighting. Not part of the shape being built.',
    },
    CritiqueFindingSchema: {
        kind: NARROWED_BY_CRITIQUE_TOOL,
        confidence: NARROWED_BY_CRITIQUE_TOOL,
        impact_area: NARROWED_BY_CRITIQUE_TOOL,
        secondary_domain_origin: NARROWED_BY_CRITIQUE_TOOL,
        real_world: NARROWED_BY_CRITIQUE_TOOL,
        references: NARROWED_BY_CRITIQUE_TOOL,
        assessment_basis: NARROWED_BY_CRITIQUE_TOOL,
        root_fact: NARROWED_BY_CRITIQUE_TOOL,
        introduced_by: NARROWED_BY_CRITIQUE_TOOL,
        original_severity: NARROWED_BY_CRITIQUE_TOOL,
        score_if_cleared: NARROWED_BY_CRITIQUE_TOOL,
        score_if_root_fact_cleared: NARROWED_BY_CRITIQUE_TOOL,
    },
    GenerateResponseSchema: {
        critique: REVIEW_OUTPUT,
        diagram_source: RENDERED_ARTEFACT,
        run_summary:
            'What the run did. The connector reports the outcome of a generation through its own ' +
            'tool result, in words it wrote for an agent.',
        runtime_label: RUN_PROVENANCE,
        runtime_kind: RUN_PROVENANCE,
    },
    IntentDecisionSchema: {
        response_mode: QUESTIONS_AND_NOTHING_ELSE,
        classification_source: QUESTIONS_AND_NOTHING_ELSE,
        confidence: QUESTIONS_AND_NOTHING_ELSE,
        can_continue_here: QUESTIONS_AND_NOTHING_ELSE,
        uses_existing_architecture: QUESTIONS_AND_NOTHING_ELSE,
        requested_run_mode: QUESTIONS_AND_NOTHING_ELSE,
        brief_preview: QUESTIONS_AND_NOTHING_ELSE,
        intent_preflight_token: QUESTIONS_AND_NOTHING_ELSE,
    },
}

/**
 * Fields the connector **should** read and does not. Not exemptions — a ratchet.
 *
 * A test below asserts every entry here is still genuinely unnamed, so the moment one is mirrored
 * the entry turns red and has to be deleted. The list can only ever shrink, and it cannot be
 * quietly outlived.
 */
const KNOWN_DEFECTS: Record<string, Record<string, string>> = {
    ArchitectureJsonSchema: {
        grounded_decisions:
            "The design's own reasoning, with the requirements each decision serves. Most designs " +
            'carry these and no plain `design_decisions` at all, so an agent asking for the design ' +
            'is told it was built for no stated reason. Fixed next in this release.',
    },
    ReadinessSchema: {
        release_warnings:
            'What releasing this version would be carrying, one sentence each. A person clicking ' +
            'Release sees exactly this list, headed "It will carry:". An agent asking the same ' +
            'question is told nothing. Fixed in this release.',
    },
    DesignGapListSchema: {
        orphaned_answers:
            'Answers whose question is no longer in this version. The API records them precisely so ' +
            'they are not silently dropped, and the connector then silently drops them. Fixed in ' +
            'this release.',
    },
    CritiqueFindingSchema: {
        advisory_only:
            'A finding reported in full and never charged against the score. An agent handed a ' +
            'high-severity advisory finding treats it as a blocker the product does not consider ' +
            'one. Unlike the three above this is a documented narrowing rather than an accident, so ' +
            'widening the tool output is an owner decision, not yet taken.',
    },
}

// ─── Reading the connector ───────────────────────────────────────────

/** Every runtime export of `wire/schemas.ts` that is an object schema. Types are erased, so this is it. */
const exported: Record<string, z.ZodObject> = Object.fromEntries(
    Object.entries(wire as Record<string, unknown>).filter(
        (entry): entry is [string, z.ZodObject] => entry[1] instanceof z.ZodObject,
    ),
)

/** `looseObject` sets an `unknown` catchall; `strictObject` a `never` one; a plain object has none. */
function isLoose(schema: z.ZodObject): boolean {
    const def = schema.def as { catchall?: { def?: { type?: string } } }
    return def.catchall?.def?.type === 'unknown'
}

/**
 * The connector's schema of that name. A throw, not a fallback: a contract entry naming a schema
 * `wire/schemas.ts` does not export is a mapping that has gone stale, and every assertion below
 * would otherwise pass by having nothing to check.
 */
function connectorSchema(name: string): z.ZodObject {
    const schema = exported[name]
    if (!schema) throw new Error(`the contract names ${name}, which wire/schemas.ts does not export`)
    return schema
}

function exempt(table: Record<string, Record<string, string>>, schema: string, field: string): boolean {
    return Object.prototype.hasOwnProperty.call(table[schema] ?? {}, field)
}

const mapped = Object.entries(contract.schemas)

// ─── The checks ──────────────────────────────────────────────────────

describe('the contract itself', () => {
    it('is the version this file knows how to read', () => {
        expect(contract.contract_version).toBe(1)
    })

    it('covers enough schemas to be worth trusting', () => {
        // A floor, not a count. A generator that broke and emitted two entries would otherwise pass
        // every assertion below by having nothing to check.
        expect(mapped.length).toBeGreaterThanOrEqual(20)
    })

    it.each(mapped)('%s declares at least one field', (_name, spec) => {
        expect(Object.keys(spec.fields).length).toBeGreaterThan(0)
    })

    it('accounts for every schema the connector exports', () => {
        // The completeness catcher: a new export with neither a pydantic authority nor a written
        // reason for having none is a schema nobody has checked.
        const accounted = new Set([...Object.keys(contract.schemas), ...Object.keys(contract.no_authority)])
        const unaccounted = Object.keys(exported).filter((name) => !accounted.has(name))
        expect(unaccounted).toEqual([])
    })

    it('names only schemas that exist', () => {
        const missing = [...Object.keys(contract.schemas), ...Object.keys(contract.no_authority)].filter(
            (name) => !(name in exported),
        )
        expect(missing).toEqual([])
    })

    it('gives a written reason for every schema with no authority', () => {
        for (const [name, reason] of Object.entries(contract.no_authority)) {
            expect(reason.length, `${name} has no reason`).toBeGreaterThan(40)
        }
    })
})

describe('coverage — nothing the API sends is dropped in silence', () => {
    it.each(mapped)('%s names every field the API sends', (name, spec) => {
        const named = new Set(Object.keys(connectorSchema(name).shape))
        const unnamed = Object.keys(spec.fields).filter(
            (field) =>
                !named.has(field) &&
                !exempt(ACKNOWLEDGED_UNREAD, name, field) &&
                !exempt(KNOWN_DEFECTS, name, field),
        )
        expect(
            unnamed,
            `${spec.python_model} sends these and ${name} does not name them. Mirror them, or add ` +
                'an ACKNOWLEDGED_UNREAD entry saying why an agent has no use for them.',
        ).toEqual([])
    })

    it.each(mapped)('%s reads nothing the API has stopped sending', (name, spec) => {
        const orphans = Object.keys(connectorSchema(name).shape).filter((field) => !(field in spec.fields))
        expect(
            orphans,
            `${name} reads these and ${spec.python_model} no longer declares them. Either the API ` +
                'dropped a field the connector still depends on, or the mapping needs updating.',
        ).toEqual([])
    })
})

describe('leniency — the connector stays the forgiving side', () => {
    it.each(mapped)('%s is still a loose object', (name) => {
        // The package's promise, as a test: unknown keys pass through, so a server that adds a field
        // does not break a client shipped a year earlier. Nobody gets to close a coverage failure by
        // tightening a schema.
        expect(isLoose(connectorSchema(name)), `${name} stopped accepting unknown keys`).toBe(true)
    })

    it.each(mapped)('%s is at least as forgiving as the API is loose', (name, spec) => {
        const shape = connectorSchema(name).shape as Record<string, z.ZodType>
        for (const [field, info] of Object.entries(spec.fields)) {
            const zod = shape[field]
            if (!zod) continue

            // The asymmetry is the point. Python-nullable must be zod-nullable and python-optional
            // must be zod-optional — those are things the server really does send. The reverse,
            // python-required read as zod-optional, is *allowed*: it is how a client keeps parsing
            // against a server that predates a field. `ReadinessSchema.verdict` is exactly that.
            if (info.nullable) {
                expect(zod.safeParse(null).success, `${name}.${field} is nullable on the wire`).toBe(true)
            }
            if (!info.required) {
                expect(zod.safeParse(undefined).success, `${name}.${field} may be absent`).toBe(true)
            }
            // Container kind only. A scalar's exact type is the API's business — narrowing `str` to
            // an enum is a legitimate connector judgement — but reading a list as a string is a bug
            // no leniency argument covers.
            if (info.kind === 'list') {
                expect(zod.safeParse([]).success, `${name}.${field} is a list on the wire`).toBe(true)
            }
            if (info.kind === 'map') {
                expect(zod.safeParse({}).success, `${name}.${field} is a map on the wire`).toBe(true)
            }
        }
    })
})

describe('the exemption tables cannot rot', () => {
    it('exempts only fields the API still sends', () => {
        const stale: string[] = []
        for (const table of [ACKNOWLEDGED_UNREAD, KNOWN_DEFECTS]) {
            for (const [name, fields] of Object.entries(table)) {
                for (const field of Object.keys(fields)) {
                    if (!contract.schemas[name]?.fields[field]) stale.push(`${name}.${field}`)
                }
            }
        }
        expect(stale, 'these are exempted from a check that no longer applies — delete them').toEqual([])
    })

    it('gives every exemption a real reason', () => {
        for (const table of [ACKNOWLEDGED_UNREAD, KNOWN_DEFECTS]) {
            for (const [name, fields] of Object.entries(table)) {
                for (const [field, reason] of Object.entries(fields)) {
                    expect(reason.length, `${name}.${field} is exempted with no reason`).toBeGreaterThan(20)
                }
            }
        }
    })

    it('keeps the known defects genuinely unfixed', () => {
        // The ratchet. Mirroring one of these turns its entry red, so the fix and the bookkeeping
        // land together or not at all. This list may only ever shrink.
        const fixed: string[] = []
        for (const [name, fields] of Object.entries(KNOWN_DEFECTS)) {
            for (const field of Object.keys(fields)) {
                if (field in connectorSchema(name).shape) fixed.push(`${name}.${field}`)
            }
        }
        expect(fixed, 'now mirrored — delete the KNOWN_DEFECTS entry').toEqual([])
    })

    it('does not carry an entry for a schema it does not check', () => {
        for (const table of [ACKNOWLEDGED_UNREAD, KNOWN_DEFECTS]) {
            for (const name of Object.keys(table)) {
                expect(contract.schemas, `${name} is exempted but not in the contract`).toHaveProperty(name)
            }
        }
    })
})
