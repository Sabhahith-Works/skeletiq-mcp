/**
 * The wire, as zod.
 *
 * These mirror `packages/api/app/schemas/*.py` field for field. They are hand-maintained rather
 * than generated because this package is published separately and must keep working against a
 * server it was not built alongside — which is also why every object is **lenient**: unknown keys
 * pass through, and a field the server adds tomorrow does not break a client shipped today.
 *
 * The strictness that matters is the other direction: what this package *promises* its own tools'
 * `outputSchema`s. Those live in `tools/`, are validated by the SDK on every call, and are the
 * shapes an agent may actually rely on.
 */

import * as z from 'zod/v4'

// ─── Release facts ───────────────────────────────────────────────────

export const ReleaseFactsSchema = z.looseObject({
    is_released: z.boolean(),
    released_at: z.string().nullable().optional(),
    latest_release_version: z.number().nullable().optional(),
    newer_release_exists: z.boolean(),
    newer_draft_exists: z.boolean(),
})
export type ReleaseFacts = z.infer<typeof ReleaseFactsSchema>

// ─── Projects ────────────────────────────────────────────────────────

export const ProjectSchema = z.looseObject({
    id: z.string(),
    title: z.string(),
    description: z.string().nullable().optional(),
    tags: z.array(z.string()).nullable().optional(),
    team_id: z.string().nullable().optional(),
    architecture_count: z.number().optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
})
export type Project = z.infer<typeof ProjectSchema>

/** `GET /projects/` — page/page_size, unlike the architectures list. Not a typo; the API differs. */
export const ProjectListSchema = z.looseObject({
    projects: z.array(ProjectSchema),
    total: z.number(),
    page: z.number().optional(),
    page_size: z.number().optional(),
})

// ─── Architectures ───────────────────────────────────────────────────

export const ComponentSchema = z.looseObject({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    description: z.string().nullable().optional(),
    technology: z.string().nullable().optional(),
    role: z.string().nullable().optional(),
    /** Why the component is in the design (`core`, `security`, …) — see the API's `component_concerns`. */
    concern: z.string().nullable().optional(),
    requirement_ids: z.array(z.string()).nullable().optional(),
})
export type Component = z.infer<typeof ComponentSchema>

export const ConnectionSchema = z.looseObject({
    id: z.string().nullable().optional(),
    source: z.string(),
    target: z.string(),
    label: z.string().nullable().optional(),
    protocol: z.string().nullable().optional(),
    is_async: z.boolean().optional(),
})
export type Connection = z.infer<typeof ConnectionSchema>

/**
 * `architecture_json` as it comes off the wire: a raw dict, never narrowed by the response model.
 * Even `components` is only optional here — a version minted by a canvas save of an empty board
 * is a real row, and a client that throws on it is a client that cannot report the problem.
 */
/**
 * An open question or assumption: a bare string, or an object that also proposes an answer.
 *
 * The union is a read shim and is permanent — every design stored before recommendations existed
 * holds plain strings. `z.array(z.string())` here would have made a newer design a *parse error*
 * rather than a design with richer gaps, which is the sharpest possible version of this package's
 * standing rule: the server is allowed to add things.
 */
const GapEntrySchema = z.union([
    z.string(),
    z.looseObject({
        text: z.string(),
        recommendation: z.string().nullable().optional(),
        options: z.array(z.string()).nullable().optional(),
        impact: z.string().nullable().optional(),
    }),
])

export const ArchitectureJsonSchema = z.looseObject({
    title: z.string().optional(),
    description: z.string().optional(),
    components: z.array(ComponentSchema).optional(),
    connections: z.array(ConnectionSchema).optional(),
    design_decisions: z.array(z.string()).nullable().optional(),
    trade_offs: z.array(z.string()).nullable().optional(),
    scalability_notes: z.string().nullable().optional(),
    assumptions: z.array(GapEntrySchema).nullable().optional(),
    open_questions: z.array(GapEntrySchema).nullable().optional(),
})
export type ArchitectureJson = z.infer<typeof ArchitectureJsonSchema>

export const ArchitectureSchema = z.looseObject({
    id: z.string(),
    project_id: z.string(),
    prompt: z.string().optional(),
    architecture_json: ArchitectureJsonSchema,
    version: z.number(),
    status: z.string().optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
    is_released: z.boolean().optional(),
    released_at: z.string().nullable().optional(),
})
export type Architecture = z.infer<typeof ArchitectureSchema>

/** `GET /projects/{id}/architectures` — limit/offset, unlike the projects list. */
export const ArchitecturePageSchema = z.looseObject({
    items: z.array(ArchitectureSchema),
    total: z.number(),
    limit: z.number().optional(),
    offset: z.number().optional(),
})

// ─── Handoff ─────────────────────────────────────────────────────────

export const BriefSchema = z.looseObject({
    architecture_id: z.string(),
    version: z.number(),
    is_draft: z.boolean(),
    markdown: z.string(),
    release: ReleaseFactsSchema,
})

export const BuildStepSchema = z.looseObject({
    order: z.number(),
    component_id: z.string(),
    name: z.string(),
    type: z.string(),
    role: z.string().nullable().optional(),
    technology: z.string().nullable().optional(),
    reason: z.string(),
    depends_on: z.array(z.string()).optional(),
    /** The `depends_on` entries built *after* this step — non-empty only where the design cycles. */
    blocked_by: z.array(z.string()).optional(),
})

export const BuildOrderSchema = z.looseObject({
    architecture_id: z.string(),
    version: z.number(),
    steps: z.array(BuildStepSchema),
    release: ReleaseFactsSchema,
})

export const ReadinessRowSchema = z.looseObject({
    key: z.string(),
    label: z.string(),
    count: z.number(),
    // Three states, not two. `unknown` is a *settled* answer meaning the check never ran — never
    // render it as a zero, which would claim a check passed that was never performed.
    state: z.string(),
    category: z.string(),
    gating: z.boolean(),
    detail: z.string().nullable().optional(),
})

export const ReadinessSchema = z.looseObject({
    architecture_id: z.string(),
    version: z.number(),
    /** `verdict === 'ready'`. Kept for callers that only want the boolean. */
    ready: z.boolean(),
    /**
     * Three values, not two. `unanswered` means every gate is clear but at least one
     * could not be answered for this version — a state that reports `ready: false`
     * while no row is `gating`, so a renderer keyed on `gating` alone says "0 of 6
     * gates still open" and means nothing by it.
     *
     * Optional so a server that predates the field parses rather than throwing; the
     * caller falls back to the boolean.
     */
    verdict: z.enum(['ready', 'outstanding', 'unanswered']).optional(),
    unknown_gate_count: z.number().optional(),
    /** Keys of advisory rows whose check never ran. Named, never counted. */
    unrun_checks: z.array(z.string()).optional(),
    rows: z.array(ReadinessRowSchema),
    release: ReleaseFactsSchema,
})

export const DesignGapSchema = z.looseObject({
    gap_id: z.string(),
    kind: z.string(),
    text: z.string(),
    resolved: z.boolean(),
    action: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    adr_id: z.string().nullable().optional(),
})

export const DesignGapListSchema = z.looseObject({
    project_id: z.string(),
    architecture_id: z.string().nullable().optional(),
    version: z.number().nullable().optional(),
    gaps: z.array(DesignGapSchema),
    unresolved_count: z.number(),
})

export const ComponentRefSchema = z.looseObject({
    id: z.string(),
    name: z.string(),
    type: z.string(),
})

export const UnknownIdSchema = z.looseObject({
    id: z.string(),
    suggestions: z.array(ComponentRefSchema).optional(),
})

export const DriftSchema = z.looseObject({
    architecture_id: z.string(),
    version: z.number(),
    in_sync: z.boolean(),
    missing: z.array(ComponentRefSchema),
    unreported: z.array(ComponentRefSchema),
    partial: z.array(ComponentRefSchema),
    elsewhere: z.array(ComponentRefSchema),
    unknown_ids: z.array(UnknownIdSchema),
    extra_components: z.array(z.looseObject({ name: z.string() })),
    extra_connections: z.array(z.looseObject({ source: z.string(), target: z.string() })),
    counts: z.record(z.string(), z.number()),
    release: ReleaseFactsSchema,
})

// ─── Critique ────────────────────────────────────────────────────────

export const CritiqueFindingSchema = z.looseObject({
    message: z.string(),
    pattern_id: z.string(),
    category: z.string(),
    severity: z.string().optional(),
    affected_components: z.array(z.string()).optional(),
    evidence: z.string().optional(),
    remediation: z.string().optional(),
})

export const PayloadCritiqueSchema = z.looseObject({
    architecture_score: z.number(),
    security_score: z.number(),
    performance_score: z.number(),
    resilience_score: z.number(),
    data_score: z.number(),
    findings: z.array(CritiqueFindingSchema),
    bottlenecks: z.array(z.string()).optional(),
    risks: z.array(z.string()).optional(),
    recommendations: z.array(z.string()).optional(),
    strengths: z.array(z.string()).optional(),
    compliance_assessed: z.boolean().optional(),
    frameworks_checked: z.array(z.string()).optional(),
    compliance_note: z.string().nullable().optional(),
    exposure_assessed: z.string().optional(),
})

// ─── Generation ──────────────────────────────────────────────────────

/**
 * One question the honesty gate asks before it will design from a vague prompt.
 *
 * Deterministic and template-based server-side — no model writes these — so the `id` is stable
 * and is the key an answer must be sent back under.
 */
export const ClarifyingQuestionSchema = z.looseObject({
    id: z.string(),
    question: z.string(),
    why: z.string().optional(),
    kind: z.string().optional(),
    options: z.array(z.string()).nullable().optional(),
    decline_options: z.array(z.string()).nullable().optional(),
})
export type ClarifyingQuestion = z.infer<typeof ClarifyingQuestionSchema>

/**
 * The 409 body when generation is refused: the intent decision, questions included.
 *
 * Read for the questions and nothing else. The refusal is recognised by their *presence*, not
 * by an error code — the code on this envelope is the generic `CONFLICT`, and the same body is
 * what a new-project recommendation sends. That is the rule the web client already applies.
 */
export const IntentDecisionSchema = z.looseObject({
    intent: z.string().optional(),
    reason: z.string().optional(),
    new_project_recommended: z.boolean().optional(),
    clarifying_questions: z.array(ClarifyingQuestionSchema).nullable().optional(),
})

export const GenerateResponseSchema = z.looseObject({
    response_mode: z.string().optional(),
    model_used: z.string().optional(),
    conversation_id: z.string().optional(),
    architecture: ArchitectureJsonSchema.nullable().optional(),
    architecture_id: z.string().nullable().optional(),
    architecture_version: z.number().nullable().optional(),
    assistant_message: z.string().nullable().optional(),
    degradations: z.array(z.string()).optional(),
})

/**
 * The structured half of a failed job.
 *
 * `POST /chat/generate-async` answers **202**, so a refusal raised inside the worker has no
 * HTTP status left to carry it: it lands as a failed job, and until the worker learned to
 * store this, an agent polling `get_generation_status` got a sentence written for a log and
 * nothing it could act on. The shape mirrors what `_bounded_decision_detail` writes.
 */
export const DecisionRefusalSchema = z.looseObject({
    kind: z.literal('decision_refusal'),
    code: z.string(),
    response_mode: z.string().optional(),
    intent: z.string().optional(),
    new_project_recommended: z.boolean().optional(),
    clarifying_questions: z.array(ClarifyingQuestionSchema).optional(),
})

export type DecisionRefusal = z.infer<typeof DecisionRefusalSchema>

/** Where a job's terminal event keeps that detail. `progress` is otherwise free-form. */
export const JobProgressSchema = z.looseObject({
    data: z.looseObject({ failure_detail: z.unknown().optional() }).optional(),
})

export const JobSchema = z.looseObject({
    job_id: z.string(),
    status: z.string(),
    project_id: z.string().nullable().optional(),
    architecture_id: z.string().nullable().optional(),
    conversation_id: z.string().nullable().optional(),
    prompt: z.string().nullable().optional(),
    created_at: z.string().nullable().optional(),
    started_at: z.string().nullable().optional(),
    completed_at: z.string().nullable().optional(),
    error: z.string().nullable().optional(),
    progress: z.unknown().optional(),
    queue_state: z.string().optional(),
})

export const GenerateAsyncSchema = z.looseObject({
    job_id: z.string(),
    status: z.string(),
    job: JobSchema.optional(),
})
