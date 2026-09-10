/**
 * Narrowing a design down to what the agent is about to build.
 *
 * The slicing happens **here, in this process**, not on the server — and that is the point rather
 * than an implementation convenience. Narrow is about the *model's* context window, not about
 * bytes on a socket: the process fetches one design and caches it, and each slice costs nothing
 * but keeps eleven components the agent is not touching out of its prompt.
 *
 * A component's edges come back in both directions. The design orients an edge by data flow; an
 * agent implementing a service needs to know who calls it just as much as what it calls, and
 * handing it only the outgoing half would be a quiet half-truth.
 */

import type { ArchitectureJson, Component, Connection } from '../wire/schemas.js'

export interface ComponentSlice {
    component: Component
    /** Edges where this component is the source. */
    outgoing: Connection[]
    /** Edges where this component is the target. */
    incoming: Connection[]
    /** Design decisions that name this component or its technology, best-effort. */
    related_decisions: string[]
}

export function sliceComponent(design: ArchitectureJson, componentId: string): ComponentSlice | null {
    const components = design.components ?? []
    const component =
        components.find((c) => c.id === componentId) ??
        components.find((c) => normalize(c.name) === normalize(componentId))
    if (!component) return null

    const connections = design.connections ?? []
    return {
        component,
        outgoing: connections.filter((c) => c.source === component.id),
        incoming: connections.filter((c) => c.target === component.id),
        related_decisions: relatedDecisions(design, component),
    }
}

/**
 * Every decision in the design, as text, from both of the lists the server keeps.
 *
 * A design carries `design_decisions` (plain strings) and `grounded_decisions` (the same statement
 * with the requirements and sources behind it), and which one is populated depends on when and how
 * the design was generated. Most designs stored today hold *only* the grounded list, so reading the
 * legacy one alone reports a design built for no stated reason — the design's own reasoning, thrown
 * away in front of the agent about to implement it.
 *
 * Union rather than preference, because on the designs that carry both the two lists say different
 * things: their text sets were measured and never coincide. Taking one would drop real content;
 * taking both, deduped, cannot. Order is legacy-first, then grounded, each in the order the design
 * states them — the design's own sequence is the only ordering anyone has a claim on.
 */
export function decisionTexts(design: ArchitectureJson): string[] {
    const seen = new Set<string>()
    const out: string[] = []
    const push = (text: string | undefined): void => {
        if (typeof text !== 'string') return
        const trimmed = text.trim()
        // Deduped on the exact text, which is the only identity two lists of free-form sentences
        // share. Two decisions phrased differently are two decisions, and merging them would be a
        // judgement this package has no standing to make.
        if (trimmed.length === 0 || seen.has(trimmed)) return
        seen.add(trimmed)
        out.push(trimmed)
    }

    for (const decision of design.design_decisions ?? []) push(decision)
    for (const decision of design.grounded_decisions ?? []) push(decision?.text)
    return out
}

/**
 * Decisions arrive as free text and, on the wire, name no component: `grounded_decisions` links a
 * decision to the *requirements* it serves, which is not the same relationship. So this stays a name
 * match, and stays labelled as *related* rather than as *the* decisions for this component. Matching
 * on the name and the technology catches the two ways a decision actually refers to a box ("the API
 * gateway will…", "we chose Redis because…") without inventing a relationship the design never
 * stated.
 */
function relatedDecisions(design: ArchitectureJson, component: Component): string[] {
    const needles = [component.name, component.technology]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 2)
        .map((value) => value.toLowerCase())
    if (needles.length === 0) return []

    return decisionTexts(design).filter((decision) => {
        const haystack = decision.toLowerCase()
        return needles.some((needle) => haystack.includes(needle))
    })
}

/**
 * The whole design, minus the analysis blocks an agent has no use for.
 *
 * `design_decisions` here is every decision the design states, from both of the server's lists —
 * see `decisionTexts`. The key keeps its name because it is what the design's decisions *are* to a
 * caller, and renaming it would break every reader for a distinction only the server makes.
 */
export function overview(design: ArchitectureJson): {
    title: string
    description: string
    components: Component[]
    connections: Connection[]
    design_decisions: string[]
    trade_offs: string[]
} {
    return {
        title: design.title ?? 'Untitled design',
        description: design.description ?? '',
        components: design.components ?? [],
        connections: design.connections ?? [],
        design_decisions: decisionTexts(design),
        trade_offs: design.trade_offs ?? [],
    }
}

function normalize(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}
