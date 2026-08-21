import * as z from 'zod/v4'

import type { McpServer } from '@modelcontextprotocol/server'

import type { DesignResolver } from '../lib/resolve.js'
import { guard, ok } from '../lib/result.js'

const input = z.object({
    query: z
        .string()
        .optional()
        .describe('Filter by name or description. Omit to list everything the token can see.'),
})

const output = z.object({
    projects: z.array(
        z.object({
            id: z.string(),
            title: z.string(),
            description: z.string().nullable(),
            architecture_count: z.number(),
            updated_at: z.string().nullable(),
        }),
    ),
    total: z.number(),
})

export function registerListProjects(server: McpServer, resolver: DesignResolver): void {
    server.registerTool(
        'list_projects',
        {
            title: 'List SkeletIQ projects',
            description:
                'List the SkeletIQ projects this token can see, optionally filtered by name. ' +
                'Use this first to turn a project a person named in conversation into an id. ' +
                'If more than one project matches, ask which — do not pick one.',
            inputSchema: input,
            outputSchema: output,
            annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
        },
        async ({ query }) =>
            guard(async () => {
                const projects = await resolver.listProjects(query)
                const structured = {
                    projects: projects.map((project) => ({
                        id: project.id,
                        title: project.title,
                        description: project.description ?? null,
                        architecture_count: project.architecture_count ?? 0,
                        updated_at: project.updated_at ?? null,
                    })),
                    total: projects.length,
                }

                if (projects.length === 0) {
                    return ok(
                        structured,
                        query
                            ? `No SkeletIQ project matches "${query}".`
                            : 'This token can see no SkeletIQ projects.',
                    )
                }

                const lines = projects.map(
                    (project) =>
                        `- ${project.title} (${project.id}) — ${project.architecture_count ?? 0} version(s)`,
                )
                return ok(structured, [`${projects.length} project(s):`, ...lines].join('\n'))
            }),
    )
}
