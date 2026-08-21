/**
 * Which project, and which version of it.
 *
 * **The version rule, used identically by every tool:** an explicit `version` wins; otherwise the
 * latest *released* version; otherwise the latest version there is. Every tool result says which
 * of the three happened, because "SkeletIQ says X" means something different when X came from a
 * draft nobody approved.
 *
 * Preferring the release is not a tie-break. A released version is the one a human looked at and
 * said yes to; a draft changes on every canvas save with nothing to tell the repo it moved. An
 * agent building from the newest thing it can find will follow edits made while it was working.
 *
 * The per-process cache exists because a session asks about the same design repeatedly — an
 * overview, then four component slices, then a drift check — and re-fetching a design that cannot
 * change underneath a released id is waste the model pays for in latency.
 */

import type { SkeletiqClient } from '../http/client.js'
import { SkeletiqApiError } from '../http/errors.js'
import {
    ArchitecturePageSchema,
    ArchitectureSchema,
    ProjectListSchema,
    type Architecture,
    type Project,
} from '../wire/schemas.js'

/** How a version was chosen, reported back so the agent can tell a release from a guess. */
export type VersionSource = 'requested' | 'latest_release' | 'latest_version'

export interface ResolvedVersion {
    architectureId: string
    version: number
    isReleased: boolean
    /** A higher version than this one has been released — the signal to refresh the brief. */
    newerReleaseExists: boolean
    resolvedBy: VersionSource
}

/** More than one project matched. Carries the candidates so the agent can ask, not guess. */
export class AmbiguousProjectError extends Error {
    readonly candidates: Project[]

    constructor(query: string, candidates: Project[]) {
        super(`"${query}" matches ${candidates.length} SkeletIQ projects.`)
        this.name = 'AmbiguousProjectError'
        this.candidates = candidates
    }
}

const PROJECT_PAGE_SIZE = 50
const ARCHITECTURE_PAGE_SIZE = 100

export class DesignResolver {
    private readonly client: SkeletiqClient
    private readonly versions = new Map<string, Architecture[]>()
    private readonly designs = new Map<string, Architecture>()

    constructor(client: SkeletiqClient) {
        this.client = client
    }

    async listProjects(query?: string): Promise<Project[]> {
        const body = await this.client.request<unknown>('/projects/', {
            query: { page_size: PROJECT_PAGE_SIZE, search: query },
        })
        return ProjectListSchema.parse(body).projects
    }

    /**
     * A project id, or the candidates that stopped us being sure.
     *
     * An exact (case-insensitive) title match settles it even when other titles contain the same
     * words — "Payments" should not be ambiguous just because "Payments v2" exists.
     */
    async resolveProject(idOrQuery: string): Promise<Project> {
        if (isUuid(idOrQuery)) {
            const body = await this.client.request<unknown>(`/projects/${idOrQuery}`)
            return ProjectListSchema.shape.projects.element.parse(body)
        }

        const candidates = await this.listProjects(idOrQuery)
        if (candidates.length === 0) throw new Error(`No SkeletIQ project matches "${idOrQuery}".`)
        if (candidates.length === 1) return candidates[0] as Project

        const exact = candidates.filter((p) => p.title.toLowerCase() === idOrQuery.toLowerCase())
        if (exact.length === 1) return exact[0] as Project

        throw new AmbiguousProjectError(idOrQuery, candidates)
    }

    /** Every version of a project, newest first. Cached: one call serves a whole session. */
    async versionsFor(projectId: string): Promise<Architecture[]> {
        const cached = this.versions.get(projectId)
        if (cached) return cached

        const body = await this.client.request<unknown>(`/projects/${projectId}/architectures`, {
            query: { limit: ARCHITECTURE_PAGE_SIZE, offset: 0 },
        })
        const items = [...ArchitecturePageSchema.parse(body).items].sort((a, b) => b.version - a.version)

        this.versions.set(projectId, items)
        for (const item of items) this.designs.set(item.id, item)
        return items
    }

    /** The version rule. */
    async resolveVersion(projectId: string, requested?: number): Promise<ResolvedVersion> {
        const versions = await this.versionsFor(projectId)
        if (versions.length === 0) {
            throw new Error(
                'That SkeletIQ project has no architecture versions yet. ' +
                    'Run generate_architecture against it first.',
            )
        }

        const latestReleaseVersion = versions.find((v) => v.is_released)?.version

        let chosen: Architecture | undefined
        let resolvedBy: VersionSource

        if (requested !== undefined) {
            chosen = versions.find((v) => v.version === requested)
            resolvedBy = 'requested'
            if (!chosen) {
                const available = versions.map((v) => v.version).reverse().join(', ')
                throw new Error(
                    `That SkeletIQ project has no version ${requested}. Available versions: ${available}. ` +
                        '(On the free plan older unreleased versions are outside the readable window.)',
                )
            }
        } else if (latestReleaseVersion !== undefined) {
            chosen = versions.find((v) => v.version === latestReleaseVersion)
            resolvedBy = 'latest_release'
        } else {
            chosen = versions[0]
            resolvedBy = 'latest_version'
        }

        const target = chosen as Architecture
        return {
            architectureId: target.id,
            version: target.version,
            isReleased: target.is_released === true,
            newerReleaseExists:
                latestReleaseVersion !== undefined && latestReleaseVersion > target.version,
            resolvedBy,
        }
    }

    /**
     * The full design for one version.
     *
     * The list response already carries `architecture_json`, so the cache seeded by
     * `versionsFor` usually answers this without a second request.
     */
    async design(architectureId: string): Promise<Architecture> {
        const cached = this.designs.get(architectureId)
        if (cached) return cached

        const body = await this.client.request<unknown>(`/architectures/${architectureId}`)
        const design = ArchitectureSchema.parse(body)
        this.designs.set(architectureId, design)
        return design
    }
}

/**
 * Facts every tool result carries.
 *
 * `newer_release_exists` is the load-bearing one: it is how an agent holding a brief in its
 * `AGENTS.md` learns that the fence is stale without having to re-read the document.
 */
export interface VersionFacts {
    version: number
    is_released: boolean
    newer_release_exists: boolean
    resolved_by: VersionSource
}

export function factsFrom(resolved: ResolvedVersion): VersionFacts {
    return {
        version: resolved.version,
        is_released: resolved.isReleased,
        newer_release_exists: resolved.newerReleaseExists,
        resolved_by: resolved.resolvedBy,
    }
}

/**
 * The handoff endpoints answer with full release facts; the plain architecture reads do not.
 * Where they do, prefer them: they are computed server-side over the whole project and cannot be
 * stale against a version list this process cached a minute ago.
 */
export function factsFromRelease(
    resolved: ResolvedVersion,
    release: { is_released: boolean; newer_release_exists: boolean },
): VersionFacts {
    return {
        version: resolved.version,
        is_released: release.is_released,
        newer_release_exists: release.newer_release_exists,
        resolved_by: resolved.resolvedBy,
    }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: string): boolean {
    return UUID.test(value.trim())
}

/** A 404 on a project id is worth restating: "not found" and "not yours" are one answer here. */
export function isNotFound(error: unknown): boolean {
    return error instanceof SkeletiqApiError && error.status === 404
}
