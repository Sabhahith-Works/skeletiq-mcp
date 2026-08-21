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
 * Decisions are free text with no component linkage on the wire, so this is a name match and is
 * labelled as *related*, never as *the* decisions for this component. Matching on the name and the
 * technology catches the two ways a decision actually refers to a box ("the API gateway will…",
 * "we chose Redis because…") without inventing a relationship the design never stated.
 */
function relatedDecisions(design: ArchitectureJson, component: Component): string[] {
    const needles = [component.name, component.technology]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 2)
        .map((value) => value.toLowerCase())
    if (needles.length === 0) return []

    return (design.design_decisions ?? []).filter((decision) => {
        const haystack = decision.toLowerCase()
        return needles.some((needle) => haystack.includes(needle))
    })
}

/** The whole design, minus the analysis blocks an agent has no use for. */
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
        design_decisions: design.design_decisions ?? [],
        trade_offs: design.trade_offs ?? [],
    }
}

function normalize(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}
