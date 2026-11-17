import type { Template } from '@todoist/sdk'
import { z } from 'zod'
import type { TodoistTool } from '../todoist-tool.js'
import { ApiLimits } from '../utils/constants.js'
import { TemplateOriginFields } from '../utils/output-schemas.js'
import { formatNextSteps } from '../utils/response-builders.js'
import { ToolNames } from '../utils/tool-names.js'

const TEMPLATE_SOURCES = ['all', 'todoist', 'user', 'workspace'] as const

const ArgsSchema = {
    query: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe('Words to search template names and descriptions for, e.g. "launch".'),
    source: z
        .enum(TEMPLATE_SOURCES)
        .optional()
        .describe(
            'todoist for the Todoist gallery, user for the user\'s personal templates, workspace for templates saved to their workspaces. Defaults to "all".',
        ),
    locale: z
        .string()
        .optional()
        .describe('Language of gallery template content, e.g. "de". Defaults to "en".'),
    limit: z
        .number()
        .int()
        .min(1)
        .max(ApiLimits.TEMPLATES_MAX)
        .optional()
        .describe(`Defaults to ${ApiLimits.TEMPLATES_DEFAULT}.`),
    cursor: z.string().optional().describe("A previous result's `nextCursor`, for the next page."),
}

const OutputSchema = {
    templates: z.array(
        z.object({
            templateId: z.string(),
            name: z.string(),
            description: z.string(),
            ...TemplateOriginFields,
        }),
    ),
    nextCursor: z.string().optional().describe('Absent on the last page.'),
}

const findTemplates = {
    name: ToolNames.FIND_TEMPLATES,
    description:
        "Search the Todoist gallery's project templates and the user's personal and workspace ones, to find a template's ID for add-projects, import-into-project, fetch-object or update-template.",
    parameters: ArgsSchema,
    outputSchema: OutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async execute(
        { query, source = 'all', locale, limit = ApiLimits.TEMPLATES_DEFAULT, cursor },
        client,
    ) {
        const { results, nextCursor } = await client.getTemplates({
            query,
            templateSource: source,
            // Setup templates are out of scope: they configure a whole account.
            templateType: 'project',
            locale,
            cursor,
            limit,
        })

        return {
            textContent: generateTextContent({ templates: results, query, nextCursor }),
            structuredContent: {
                templates: results.map((template) => ({
                    templateId: template.id,
                    name: template.name,
                    description: template.shortDescription,
                    source: template.templateSource,
                    workspaceId: template.workspaceId ?? undefined,
                })),
                nextCursor: nextCursor ?? undefined,
            },
        }
    },
} satisfies TodoistTool<typeof ArgsSchema, typeof OutputSchema>

function generateTextContent({
    templates,
    query,
    nextCursor,
}: {
    templates: Template[]
    query: string | undefined
    nextCursor: string | null
}) {
    const matching = query ? ` matching "${query}"` : ''
    if (templates.length === 0) {
        return `No templates found${matching}.`
    }

    const lines = templates.map(
        (template) =>
            `- ${template.name} (id=${template.id}, ${describeSource(template)}): ${template.shortDescription}`,
    )
    const more = nextCursor ? `\n${formatNextSteps([], nextCursor)}` : ''

    return `Found ${templates.length} template${templates.length === 1 ? '' : 's'}${matching}:\n${lines.join('\n')}${more}`
}

function describeSource(template: Template): string {
    if (template.templateSource === 'todoist') return 'gallery'
    return template.workspaceId ? `workspace ${template.workspaceId}` : 'personal'
}

export { findTemplates }
