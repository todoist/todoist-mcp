import type { ImportTemplateResponse, TodoistApi } from '@todoist/sdk'
import { z } from 'zod'
import type { TodoistTool } from '../todoist-tool.js'
import { ErrorWithContext, logFailedLookup, ProjectAccessError } from '../tool-execution-error.js'
import { getProjectOrExplain, mapComment, mapTask } from '../tool-helpers.js'
import {
    CommentSchema,
    SectionSchema,
    TaskSchema,
    toSectionSummary,
} from '../utils/output-schemas.js'
import { extractTemplateId, TEMPLATE_ID_ERROR, TEMPLATE_ID_PATTERN } from '../utils/template-ids.js'
import { ToolNames } from '../utils/tool-names.js'

const ArgsSchema = {
    projectId: z.string().min(1).describe('The ID of the existing project to import into.'),
    templateId: z
        .string()
        .regex(TEMPLATE_ID_PATTERN, { error: TEMPLATE_ID_ERROR })
        .optional()
        .describe(
            'The template to import — either a gallery slug ("product-launch"), a personal template ID ("UT_28Ex..."), or a full Todoist template URL, which is reduced to the ID automatically. Gallery templates work for anyone; personal templates only for the account that owns them. Find one with find-templates. Not with `csvFileContent`.',
        ),
    csvFileContent: z
        .string()
        .min(1)
        .optional()
        .describe(
            'CSV content to import, e.g. from export-project or a file the user shared. Not with `templateId`.',
        ),
    locale: z.string().optional().describe('Locale for a template\'s content. Defaults to "en".'),
}

// The API also returns a `projects` array, but it stays empty when importing into an
// existing project — the create-project-from-file endpoint is what populates it. Its
// count still feeds totalCount so nothing goes unreported.
const OutputSchema = {
    sections: z.array(SectionSchema).describe('Sections created by the import.'),
    tasks: z.array(TaskSchema).describe('Tasks created by the import.'),
    comments: z.array(CommentSchema).describe('Comments created by the import.'),
    totalCount: z.number().describe('The total number of objects created by the import.'),
}

/** The tool result for an import into a project, from a template (`source`) or a CSV. */
function toProjectImportResult({
    projectId,
    source,
    result,
}: {
    projectId: string
    source: 'template' | 'CSV'
    result: ImportTemplateResponse
}) {
    const sections = result.sections.map(toSectionSummary)
    const tasks = result.tasks.map(mapTask)
    const comments = result.comments.map(mapComment)
    const totalCount = result.projects.length + sections.length + tasks.length + comments.length

    return {
        textContent: generateTextContent({
            projectId,
            source,
            counts: {
                projects: result.projects.length,
                sections: sections.length,
                tasks: tasks.length,
                comments: comments.length,
            },
            totalCount,
        }),
        structuredContent: { sections, tasks, comments, totalCount },
    }
}

function generateTextContent({
    projectId,
    source,
    counts,
    totalCount,
}: {
    projectId: string
    source: 'template' | 'CSV'
    counts: { projects: number; sections: number; tasks: number; comments: number }
    totalCount: number
}) {
    if (totalCount === 0) {
        return `Imported ${source} into project (id=${projectId}), but it created nothing.`
    }

    const parts = Object.entries(counts)
        .filter(([, count]) => count > 0)
        .map(([kind, count]) => `${count} ${count === 1 ? kind.replace(/s$/, '') : kind}`)

    return `Imported ${source} into project (id=${projectId}): ${parts.join(', ')}.`
}

/**
 * The question put to the user before an import, naming the template and the project. The names
 * only make the question clearer, so a lookup that fails is logged and the question names the
 * item by its ID instead. A project the user cannot reach still fails here, before asking: the
 * import would fail on it anyway, and `getProjectOrExplain` says why.
 */
async function describeImport(
    client: TodoistApi,
    { projectId, templateId, locale }: { projectId: string; templateId?: string; locale?: string },
): Promise<string> {
    const [projectName, templateName] = await Promise.all([
        getProjectOrExplain(client, projectId).then(
            (project) => project.name,
            (error: unknown) => {
                if (error instanceof ProjectAccessError) throw error
                return logFailedLookup(ToolNames.IMPORT_INTO_PROJECT, 'project', projectId)(error)
            },
        ),
        templateId
            ? client
                  .getTemplate(extractTemplateId(templateId), locale ? { locale } : undefined)
                  .then(
                      (template) => template.name,
                      logFailedLookup(
                          ToolNames.IMPORT_INTO_PROJECT,
                          'template',
                          extractTemplateId(templateId),
                      ),
                  )
            : undefined,
    ])
    const source = templateId
        ? `the template "${templateName ?? extractTemplateId(templateId)}"`
        : 'the CSV'
    const project = projectName ? `the project "${projectName}"` : `the project (id=${projectId})`
    return `Import ${source} into ${project}? Its sections, tasks and comments are added to what's already there. This can't be undone.`
}

const importIntoProject = {
    name: ToolNames.IMPORT_INTO_PROJECT,
    description:
        'Import a template (by ID or URL) or CSV content into an existing project, like the app\'s "Import from CSV", adding its tasks, sections and comments to whatever is already there. To start a new project from a template, use add-projects with templateId instead. This writes immediately and cannot be undone, so only run it against a project the user named.',
    parameters: ArgsSchema,
    outputSchema: OutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    async execute({ projectId, templateId, csvFileContent, locale }, client, request?) {
        if (Boolean(templateId) === Boolean(csvFileContent)) {
            throw new Error(
                'Provide exactly one source: either `templateId` or `csvFileContent`. Find template IDs with find-templates.',
            )
        }

        const confirmation = (await request?.confirm({
            key: 'import',
            message: () => describeImport(client, { projectId, templateId, locale }),
        })) ?? { status: 'unavailable' }
        if (confirmation.status === 'asking') return confirmation.result
        if (confirmation.status === 'declined') {
            return {
                textContent: `Nothing imported: the user declined the import into project (id=${projectId}). Don't try again unless they ask.`,
                structuredContent: { sections: [], tasks: [], comments: [], totalCount: 0 },
            }
        }

        // A model that just created the project with add-projects needs to know which
        // project a failed import has left empty.
        const failedInto = (error: unknown) =>
            new ErrorWithContext(
                error,
                `The import into project (id=${projectId}) did not complete. If you created that project for this import, it may be empty.`,
            )

        if (templateId) {
            const result = await client
                .importTemplateFromId({
                    projectId,
                    templateId: extractTemplateId(templateId),
                    locale,
                })
                .catch((error: unknown) => {
                    throw failedInto(error)
                })
            return toProjectImportResult({ projectId, source: 'template', result })
        }

        const result = await client
            .importCsvIntoProject({
                projectId,
                // The SDK treats strings as filesystem paths, not file content.
                file: new Blob([csvFileContent ?? ''], { type: 'text/csv' }),
                fileName: 'template.csv',
            })
            .catch((error: unknown) => {
                throw failedInto(error)
            })
        return toProjectImportResult({ projectId, source: 'CSV', result })
    },
} satisfies TodoistTool<typeof ArgsSchema, typeof OutputSchema>

export { importIntoProject }
