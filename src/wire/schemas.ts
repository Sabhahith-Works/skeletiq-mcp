/**
 * The wire, as zod.
 *
 * These mirror the SkeletIQ API's response schemas field for field. They are hand-maintained rather
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
    /** Ids of the decision records this component realizes, e.g. `database.primary`. */
    decision_ids: z.array(z.string()).nullable().optional(),
    /** `domain` | `platform`. Left as a string: a value this package has not seen is still shown. */
    layer: z.string().nullish(),
    /** What a platform part is (`waf`, `api_gateway`, …). Left as a string for the same reason. */
    platform_role: z.string().nullish(),
    /** `realized` (the platform added it) | `adopted` (the design drew it and the platform kept it). */
    platform_origin: z.string().nullish(),
    /** Ids of the platform obligations this part meets. */
    satisfies: z.array(z.string()).nullish(),
    /** Cross-cutting settings realized on the component (encryption, backup, rate limit, …). */
    policies: z.record(z.string(), z.unknown()).nullish(),
    /**
     * `existing` (the user already runs it) | `retiring` (this design replaces it). Absent means
     * `new`: the API never sends `new`, and no design stored before the field existed carries it.
     * Left as a string: a value this package has not seen is still shown.
     */
    lifecycle: z.string().nullish(),
})
export type Component = z.infer<typeof ComponentSchema>

export const ConnectionSchema = z.looseObject({
    id: z.string().nullable().optional(),
    source: z.string(),
    target: z.string(),
    label: z.string().nullable().optional(),
    protocol: z.string().nullable().optional(),
    is_async: z.boolean().optional(),
    /** TLS, timeout and breaker settings on the edge. */
    policies: z.record(z.string(), z.unknown()).nullish(),
    /** `realized` on an edge the platform added. */
    platform_origin: z.string().nullish(),
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

/**
 * A design decision that carries its own provenance.
 *
 * The newer of the two shapes a decision arrives in, and by now the usual one: most stored designs
 * hold these and an **empty** `design_decisions`, so a client reading only the legacy list is told
 * the design was built for no stated reason. Both are kept because both are real — an older design,
 * an OSS build, or a fallback generation still writes plain strings, and the two lists carry
 * different text when they are both populated.
 *
 * `assumption` is surfaced without promoting a decision from a string to an object, which would be
 * a breaking change to what this package promises its callers: `get_design` marks those decisions
 * `(assumption)` in its text and lists them in an additive `assumed_decisions`. `confidence` is
 * received and not yet surfaced. Both are named here so the shape is on record.
 */
export const GroundedDecisionSchema = z.looseObject({
    text: z.string(),
    source_ids: z.array(z.string()).nullable().optional(),
    requirement_ids: z.array(z.string()).nullable().optional(),
    assumption: z.boolean().optional(),
    answered: z.boolean().optional(),
    confidence: z.string().optional(),
})
export type GroundedDecision = z.infer<typeof GroundedDecisionSchema>

export const ArchitectureJsonSchema = z.looseObject({
    title: z.string().optional(),
    description: z.string().optional(),
    components: z.array(ComponentSchema).optional(),
    connections: z.array(ConnectionSchema).optional(),
    design_decisions: z.array(z.string()).nullable().optional(),
    grounded_decisions: z.array(GroundedDecisionSchema).nullable().optional(),
    trade_offs: z.array(z.string()).nullable().optional(),
    scalability_notes: z.string().nullable().optional(),
    assumptions: z.array(GapEntrySchema).nullable().optional(),
    open_questions: z.array(GapEntrySchema).nullable().optional(),
    /** Drawn connections the platform layer replaced. */
    bypassed_connections: z.array(ConnectionSchema).nullish(),
    /** The `design_decisions` entries the platform layer appended. */
    platform_decisions: z.array(z.string()).nullish(),
})
export type ArchitectureJson = z.infer<typeof ArchitectureJsonSchema>

/**
 * One requirement the design was asked to satisfy, and what in the saved payload addresses it.
 *
 * `R1…Rn` appear inside the design itself — on components and on grounded decisions — and until
 * this arrived they were unresolvable: an agent reading `requirement_ids: ["R12"]` had the id and
 * nowhere to look up what R12 said. These rows are that lookup, computed by the API from the
 * stored analysis rather than re-derived from the payload, so the connector and the product
 * cannot disagree about which requirement is covered.
 */
export const RequirementLedgerRowSchema = z.looseObject({
    id: z.string(),
    text: z.string().optional(),
    kind: z.string().optional(),
    source: z.string().optional(),
    /** `unmet` | `uncited` | `unchecked` | `cited` — deliberately never `met`. Left as a string: a
     * value added server-side must not stop an older connector parsing the row. */
    status: z.string().optional(),
    verifier_checked: z.boolean().optional(),
    /** Which check answered this line: `simulation` | `cost` | `rules` | `structure` | `verifier`.
     * Four are deterministic; `verifier` is the model check, and it only owns a row when it gave a
     * reason. A string rather than a union, for the reason `status` is one. Absent from older APIs. */
    check_method: z.string().nullable().optional(),
    /** What that check said: `fails` | `passes` | `no_gap_found` | `not_checkable` | `not_checked`.
     * `passes` is only ever a measurement; `no_gap_found` is the weaker "nothing contradicted it".
     * Reported beside `status`, which stays populated. Absent from older APIs. */
    verdict: z.string().nullable().optional(),
    /** Why, in one sentence, with the figure or the finding behind it. */
    verdict_reason: z.string().nullable().optional(),
    /** The model behind a `verifier` verdict. Null on every deterministic row — naming a model
     * beside a number the server computed would be a false attribution. */
    checked_by: z.string().nullable().optional(),
    /** Whether this row holds a handoff back: a `fails` a measurement reached (capacity, cost, the
     * review's rules). A model check's `fails` does not block. Absent from older APIs, where
     * `requirementBlocksHandoff` falls back to the method. */
    blocks_handoff: z.boolean().optional(),
    /** Why a `fails` does not block: `model_check` — only the model check failed it, nothing
     * measured it; `unstated_input` — a shortfall that turns on an input nobody gave (an unstated
     * split, or an assumed load — told apart by `unstated_input`); `advisory_finding` — only review
     * advice failed it. Null on every other row. A string, for the reason `status` is one. Absent
     * from older APIs. */
    unconfirmed_reason: z.string().nullable().optional(),
    /** True on a review-rules `fails` whose every finding is advice (`advisory_finding`). */
    advisory_only: z.boolean().optional(),
    /** The assumption an `unstated_input` row turns on, as a clause. Absent from older APIs. */
    unstated_input: z.string().nullable().optional(),
    cited_by_components: z.array(z.string()).nullable().optional(),
    /** Indices into `architecture_json.grounded_decisions`, the raw array — blanks are not compacted. */
    cited_by_decisions: z.array(z.number()).nullable().optional(),
    /** `stated` in the person's own words, `proposed` by the analysis, or `accepted` — a proposal a
     * person confirmed. Absent from older APIs. Left as a string: a value this package has not seen
     * must not stop the whole design from parsing. */
    origin: z.string().nullish(),
    added_in_version: z.number().nullable().optional(),
    /** Set only on a row under `RequirementLedger.superseded`: an instruction an earlier analysis
     * recorded as a requirement, now the change request it names (`CR5`). Absent from older APIs. */
    superseded_by_change_request: z.string().nullable().optional(),
    superseded_in_version: z.number().nullable().optional(),
    /** What a person said about this line: `confirmed` ("yes, that one is real") or `removed`
     * ("that is not a requirement"). Null or absent means nobody has said, which is neither. A
     * `removed` row is listed under `RequirementLedger.removed` and never in `rows`, so a design
     * is not held to it; it keeps its id so a citation naming it still resolves. `confirmed`
     * changes no count and no verdict. Absent from older APIs. */
    decision: z.string().nullable().optional(),
    /** The version that was on screen when that decision was recorded. */
    decided_in_version: z.number().nullable().optional(),
})
export type RequirementLedgerRow = z.infer<typeof RequirementLedgerRowSchema>

export const RequirementLedgerCountsSchema = z.looseObject({
    total: z.number().optional(),
    user_supplied: z.number().optional(),
    llm_inferred: z.number().optional(),
    unmet: z.number().optional(),
    uncited: z.number().optional(),
    unchecked: z.number().optional(),
    cited: z.number().optional(),
    /** Rows citing no component and no decision (overlaps `unmet`). Absent from older APIs. */
    untraced: z.number().optional(),
    /** The verdict partition, which sums to `total` exactly as the status partition above does —
     * two readings of one set of rows, not two sets. Absent from older APIs. */
    fails: z.number().optional(),
    passes: z.number().optional(),
    no_gap_found: z.number().optional(),
    not_checkable: z.number().optional(),
    not_checked: z.number().optional(),
    /** Rows a person has confirmed are real requirements. In no partition — it overlaps all of
     * them, because confirming a line says nothing about whether the design meets it. */
    confirmed: z.number().optional(),
    /** Ids a person said are **not** requirements. Not part of `total`: those rows are not in
     * `rows` at all. Absent from older APIs. */
    removed: z.number().optional(),
})
export type RequirementLedgerCounts = z.infer<typeof RequirementLedgerCountsSchema>

/**
 * What a stored version was asked to do, line by line.
 *
 * Absent means the row *cannot say* — no requirements analysis was recorded for it — which is not
 * the same as a design with no requirements, and a tool that renders this must keep the two apart.
 * `grounding_state` and `verification_state` say how far the coverage claims can be trusted:
 * `not_grounded` is a design carrying no citations at all, and `partial` a verifier that spoke
 * about some of the set and not the rest.
 */
export const RequirementLedgerSchema = z.looseObject({
    rows: z.array(RequirementLedgerRowSchema).nullable().optional(),
    /** Ids that were instructions, not requirements. Counted nowhere; listed so an id a component
     * or decision still cites resolves to what became of it. Absent from older APIs. */
    superseded: z.array(RequirementLedgerRowSchema).nullable().optional(),
    /** Ids a person said are not requirements, so the design is not held to them. Kept apart from
     * `superseded` because it is a different statement by a different author. Counted nowhere;
     * listed for the same reason, so a citation naming one still resolves. Absent from older
     * APIs. */
    removed: z.array(RequirementLedgerRowSchema).nullable().optional(),
    analysis_version: z.number().nullable().optional(),
    analysis_degraded: z.boolean().optional(),
    /** `grounded` | `not_grounded` | `diverged`. */
    grounding_state: z.string().optional(),
    /** `ran` | `partial` | `not_run`. */
    verification_state: z.string().optional(),
    verified_version: z.number().nullable().optional(),
    counts: RequirementLedgerCountsSchema.nullable().optional(),
})
export type RequirementLedger = z.infer<typeof RequirementLedgerSchema>

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
    requirement_ledger: RequirementLedgerSchema.nullable().optional(),
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

/**
 * A source the server could not answer for, named rather than silently dropped.
 *
 * `kind` separates the two ways that happens, and only one of them is worth acting on.
 * `failed` is a read that broke: the list is genuinely incomplete and asking again may answer
 * differently. `missing` is a check with nothing stored — no review has been run, no simulation
 * exists for this version — where asking again cannot change the answer. Treat a `missing` as a
 * statement about what has not been checked, not as a degraded response.
 *
 * Optional, so a server older than the field still parses; read it as `failed` when absent,
 * which over-reports rather than hiding an outage.
 */
export const UnavailableSourceSchema = z.looseObject({
    source: z.string(),
    reason: z.string(),
    /** `failed` | `missing`. A string, not a union: a value added server-side must still parse. */
    kind: z.string().optional(),
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
    /** On a row that could not be answered: what would answer it ("Saving a change runs the
     * check on the new version."). Absent on a row that has an answer. */
    clears: z.string().nullable().optional(),
    /** True when stating the expected load is what would answer this row — `clears` then says
     * how. Optional so a server that predates the field still parses. */
    clears_by_load: z.boolean().optional(),
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
    /** The verdict-first summary of the rows. Absent from servers that predate it. */
    headline: z
        .looseObject({
            met: z.number(),
            total: z.number(),
            verdict: z.enum(['ready', 'outstanding', 'unanswered']),
            score: z.number(),
            rules_updated: z.boolean().optional(),
        })
        .nullable()
        .optional(),
    unknown_gate_count: z.number().optional(),
    /** Keys of advisory rows whose check never ran. Named, never counted. */
    unrun_checks: z.array(z.string()).optional(),
    rows: z.array(ReadinessRowSchema),
    release: ReleaseFactsSchema,
    /**
     * What releasing this version would be carrying, one sentence each. A warning, never a refusal.
     *
     * The same list the app shows beside its Release button, under the heading "It will carry:".
     * Optional here only so a server that predates the field still parses — it is required on the
     * wire, and an empty array is the server saying it looked and found nothing.
     */
    release_warnings: z.array(z.string()).optional(),
    /**
     * Sources this checklist could not speak for, exactly as `/todo` reports them.
     *
     * A failed read reaches each row builder as that source's own empty value — no questions, no
     * decisions, no ledger — and every one of those empties reads as *clear*, so an outage could
     * answer `ready: true` with `release_warnings: []`. Each one also has a row of its own now;
     * this is the same fact in the shape a caller showing both lists can join on.
     */
    unavailable_sources: z.array(UnavailableSourceSchema).optional(),
})

export const DesignGapSchema = z.looseObject({
    gap_id: z.string(),
    kind: z.string(),
    text: z.string(),
    resolved: z.boolean(),
    action: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    adr_id: z.string().nullable().optional(),
    /** `gap:{gap_id}` — the identity the review, the advisor and the decision suggestions share,
     * and the key a dismissal is recorded against. Absent from servers before 0.3.0. */
    problem_key: z.string().optional(),
    /** An answer is recorded and this version was not built with it, so iterating the design
     * would change something. False once a generation has been handed the answer. */
    answer_pending: z.boolean().optional(),
    /** The read/write mix or peak this assumption states that the design is not sized on. Null when
     * the two agree; absent from older servers. */
    sizing_conflict: z
        .looseObject({
            dimension: z.string(),
            assumed: z.string(),
            sized: z.string(),
            resize_to: z.string().nullable().optional(),
        })
        .nullable()
        .optional(),
})

/**
 * An answer with no matching question in the version being read.
 *
 * A gap is identified by a hash of its own text, so a regeneration that re-words a question mints a
 * new id and leaves the answer filed against wording nobody will see again. The server reports
 * those rather than dropping them. There is no `text`: the stored row holds the id, the kind and
 * the disposition, and `adr_id` is the recovery path — where the answer minted a Decision, that
 * Decision holds what was decided.
 */
export const OrphanedAnswerSchema = z.looseObject({
    gap_id: z.string(),
    kind: z.string(),
    action: z.string(),
    note: z.string().nullable().optional(),
    adr_id: z.string().nullable().optional(),
})

export const DesignGapListSchema = z.looseObject({
    project_id: z.string(),
    architecture_id: z.string().nullable().optional(),
    version: z.number().nullable().optional(),
    gaps: z.array(DesignGapSchema),
    unresolved_count: z.number(),
    /** Answers whose question is not in this version — recorded, not silently dropped. */
    orphaned_answers: z.array(OrphanedAnswerSchema).optional(),
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
    /** Reported in full and never charged against the score — advice, not a problem to fix. */
    advisory_only: z.boolean().optional(),
    /**
     * The problem this finding is about. Stable across rewording, and shared with the advisor
     * suggestion and decision record raised by the same problem — the key a dismissal is recorded
     * against.
     */
    problem_key: z.string().optional(),
    /** The project set this problem aside, with a reason. Still reported; never set on an unsaved payload. */
    dismissed: z.boolean().optional(),
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

// ─── To do ───────────────────────────────────────────────────────────

/**
 * The record a pending decision is asking to have written down.
 *
 * `disposition` is the part worth reading before anything else. `records` means the saved design
 * already does this, so the decision is in force and recording it writes down what is true;
 * `open` means the design has not made that call, so it can only ever become a proposal. An agent
 * that treats the second as settled is building on a choice nobody made.
 */
export const TodoDecisionContextSchema = z.looseObject({
    context: z.string().nullable().optional(),
    consequences: z.string().nullable().optional(),
    alternatives: z.string().nullable().optional(),
    /** `records` | `open` | `tradeoff`. A string, not a union: a value added server-side must still parse. */
    disposition: z.string(),
    supersedes_adr_id: z.string().nullable().optional(),
    source_version: z.number(),
})

/**
 * One raising of a problem, and the words that surface used for it.
 *
 * The reason the list is grouped at all: the review, the advisor and a pending decision routinely
 * describe one problem three times, and before the server grouped them an agent reading the three
 * panels had no way to see that fixing one thing cleared all three rows.
 *
 * `finding` is the review's own object, carried on the card so the analysis behind a problem —
 * why it matters, the fix, the precedent, the references — arrives with it instead of needing a
 * second call. It is the same shape `critique_architecture` returns.
 */
export const TodoSourceSchema = z.looseObject({
    source: z.string(),
    message: z.string(),
    detail: z.string().nullable().optional(),
    /** A handle to act on through that source: a suggestion id, a gap id, an R-id. */
    reference_id: z.string().nullable().optional(),
    /** Present on a `critique` or `compliance` source; null on every other kind. */
    finding: CritiqueFindingSchema.nullable().optional(),
    /** Present on a `decisions` source; null on every other kind. */
    decision: TodoDecisionContextSchema.nullable().optional(),
})

/**
 * Something the person can do about a card, and whether they can do it right now.
 *
 * An action the server would refuse outright for this reader is absent rather than disabled, so a
 * listed action with `available: false` is always temporary or purchasable, and `reason` says which.
 */
export const TodoActionSchema = z.looseObject({
    action: z.string(),
    available: z.boolean(),
    reason: z.string().nullable().optional(),
    reference_id: z.string().nullable().optional(),
})

export const TodoItemSchema = z.looseObject({
    problem_key: z.string(),
    group: z.string(),
    /** `problem` | `question` | `assumption` | `decision` | `verdict`. A string, not a union: a
     * value added server-side must not stop an older connector parsing the card. */
    kind: z.string(),
    title: z.string(),
    severity: z.string(),
    detail: z.string().nullable().optional(),
    components: z.array(z.string()).optional(),
    sources: z.array(TodoSourceSchema).optional(),
    actions: z.array(TodoActionSchema).optional(),
    carried: z.boolean().optional(),
    /** The oldest earlier version known to have had this problem. Null with `carried: true` means
     * it goes back further than the server looked — "an earlier version", never version zero. */
    carried_from_version: z.number().nullable().optional(),
    dismissed: z.boolean().optional(),
    dismissed_reason: z.string().nullable().optional(),
    /** The key of the one readiness row this card is counted on, so the readiness counts can be
     * traced to cards. Null on a card no row counts. */
    counts_toward: z.string().nullable().optional(),
})
export type TodoItem = z.infer<typeof TodoItemSchema>

export const TodoGroupSchema = z.looseObject({
    key: z.string(),
    label: z.string(),
    items: z.array(TodoItemSchema),
    bulk_action: TodoActionSchema.nullable().optional(),
})
export type TodoGroup = z.infer<typeof TodoGroupSchema>

export const TodoSchema = z.looseObject({
    architecture_id: z.string(),
    version: z.number(),
    groups: z.array(TodoGroupSchema),
    dismissed: z.array(TodoItemSchema).optional(),
    counts: z.record(z.string(), z.number()).optional(),
    /** Rows the sources raised before grouping. The gap between this and `counts.total` is the
     * duplication the endpoint removes, reported so the claim stays checkable. */
    raw_row_count: z.number().optional(),
    unavailable_sources: z.array(UnavailableSourceSchema).optional(),
    generation_running: z.boolean().optional(),
    can_edit: z.boolean().optional(),
    /** The project's newest version. Above `version` when this list is for an older one — a
     * release resolved behind newer drafts, or a version asked for by number. Null when unread. */
    latest_version: z.number().nullable().optional(),
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
    /** True when the server read the evidence the connector checked. Absent from older servers. */
    evidence_checked: z.boolean().optional(),
    /** Covered components reported implemented with no verified citation. */
    unverified: z.array(ComponentRefSchema).optional(),
    fitness_failing: z.array(z.string()).optional(),
    fitness_unverified: z.array(z.string()).optional(),
    fitness_unknown: z.array(z.string()).optional(),
    schema_version: z.number().optional(),
})

/** A decision change request: what the agent asked for, and where a person's answer stands. */
export const DecisionRequestSchema = z.looseObject({
    id: z.string(),
    project_id: z.string(),
    architecture_id: z.string().nullable(),
    version: z.number(),
    decision_id: z.string(),
    decision_title: z.string(),
    proposed: z.string(),
    why: z.string(),
    status: z.enum(['pending', 'accepted', 'dismissed']),
    resolution_note: z.string().nullable(),
    accepted_in_version: z.number().nullable(),
    latest_version: z.number(),
    decision_current: z.boolean().optional(),
    schema_version: z.number().optional(),
})

/** One test the agent writes in its own repo; `id` is what it reports back through `check_drift.fitness`. */
export const FitnessTestSchema = z.looseObject({
    id: z.string(),
    source: z.string(),
    obligation_id: z.string().nullable(),
    subject_ids: z.array(z.string()),
    subject_names: z.array(z.string()),
    assertion: z.string(),
    check: z.string(),
    level: z.string(),
    layer: z.string().nullable(),
})

export const FitnessTestsSchema = z.looseObject({
    architecture_id: z.string(),
    version: z.number(),
    schema_version: z.number().optional(),
    tests: z.array(FitnessTestSchema),
    total: z.number(),
    truncated: z.boolean(),
    unavailable: z.string().nullable().optional(),
})

/** One option of a decision; `rejected_because` is null on the chosen one. */
const DecisionOptionSchema = z.looseObject({
    id: z.string(),
    label: z.string(),
    rejected_because: z.string().nullable().optional(),
})

/** A decision as the view reports it. `basis_removed` names cited requirements no longer in the ledger. */
export const DecisionRecordViewSchema = z.looseObject({
    id: z.string(),
    title: z.string(),
    chosen: z.string(),
    why: z.string(),
    options: z.array(DecisionOptionSchema),
    basis_removed: z.array(z.string()).default([]),
})

export const DecisionsViewResponseSchema = z.looseObject({
    architecture_id: z.string(),
    version: z.number(),
    status: z.string(),
    reason: z.string().nullable().optional(),
    records: z.array(DecisionRecordViewSchema).default([]),
})

// ─── Generation ──────────────────────────────────────────────────────

/**
 * One option as a reader sees it: the value to send back, what it reads as, and what picking it
 * means. `value` is always one of the question's `options`, which stay the answer values.
 */
export const ClarifyingOptionDetailSchema = z.looseObject({
    value: z.string(),
    label: z.string(),
    detail: z.string().optional(),
})
export type ClarifyingOptionDetail = z.infer<typeof ClarifyingOptionDetailSchema>

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
    /** Options that withdraw the instruction to be rewritten, not answer it ("I'll name the parts"). */
    dismiss_options: z.array(z.string()).nullable().optional(),
    /** Each option's label and what it means, keyed by the value in `options`. */
    option_details: z.array(ClarifyingOptionDetailSchema).nullable().optional(),
    /** Whether more than one option may be picked at once. */
    multiple: z.boolean().optional(),
    /** What leaving the question unanswered does, in the product's words. */
    skip_effect: z.string().nullable().optional(),
    /** The contract field this question resolves, e.g. `regimes.hipaa`; absent when it is not a fork. */
    fork: z.string().nullish(),
    /** Ask only when `question_id` was answered with one of `values`. */
    asked_if: z.object({ question_id: z.string(), values: z.array(z.string()) }).nullish(),
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
