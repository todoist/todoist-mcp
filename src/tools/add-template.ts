import type { ColorKey, Template, TodoistApi } from '@todoist/sdk'
import { z } from 'zod'
import type { TodoistTool } from '../todoist-tool.js'
import { formatBatchItemError } from '../tool-execution-error.js'
import { getProjectOrExplain, isWorkspaceProject } from '../tool-helpers.js'
import { ColorOutputSchema, colorSchemaWithDefault } from '../utils/colors.js'
import { executeWithRetry, extractHttpStatusCode } from '../utils/retry.js'
import {
    outlineTemplateContent,
    type ToolTemplateContent,
    TemplateContentSchema,
    toSdkTemplateContent,
    toToolTemplateContent,
} from '../utils/template-content.js'
import { ToolNames } from '../utils/tool-names.js'
import { workspaceResolver } from '../utils/workspace-resolver.js'

const ArgsSchema = {
    projectId: z
        .string()
        .min(1)
        .optional()
        .describe(
            'Start from this project, like the app\'s "Save as template". It is copied, not changed.',
        ),
    csvFileContent: z
        .string()
        .min(1)
        .optional()
        .describe(
            'Start from this CSV, e.g. from export-project-template or a file the user shared. Not with projectId.',
        ),
    preview: z
        .boolean()
        .optional()
        .describe(
            'Defaults to true: return the draft without saving (blank, or from the project or CSV), to show the user and edit it first. Pass false only once the user has seen the draft, or asked to save as is.',
        ),
    content: TemplateContentSchema.optional().describe(
        "The draft to save with preview: false, all of it: a draft with your edits, or one written from scratch. Anything left out isn't saved. With projectId, it replaces the project's content.",
    ),
    name: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe('The name of the template. Required to save.'),
    description: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe(
            'Required to save. If the user gave none, write a one-sentence summary of the content.',
        ),
    color: colorSchemaWithDefault(
        "Unrecognized colors are omitted. Defaults to the project's color, or charcoal.",
    ),
    workspace: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe(
            "Workspace name or ID to save the template to, instead of the user's personal templates. Assignees are kept only when saving a project to its own workspace.",
        ),
    sharedWithWorkspaceMembers: z
        .boolean()
        .optional()
        .describe("Share a workspace template with the workspace's members. Defaults to false."),
}

const OutputSchema = {
    templateId: z.string().optional().describe('Absent for a draft.'),
    name: z.string().optional(),
    workspaceId: z.string().optional().describe('Absent for personal templates.'),
    workspaceError: z
        .string()
        .optional()
        .describe('Set when the template was created but moving or sharing it failed.'),
    // Declared loosely to keep the tool surface small: it has the shape of the `content` input.
    content: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('The draft. Edit it and send it back as `content` to save it.'),
}

const BLANK_CONTENT: ToolTemplateContent = {
    projects: [{ viewStyle: 'list' }],
    sections: [],
    tasks: [],
    comments: [],
    projectComments: [],
    projectViewOptionsDefaults: [],
}

const ASK_BEFORE_SAVING =
    'Before saving, show the user the draft and ask whether to change anything. Then call add-template again with preview: false, a name and description,'

const addTemplate = {
    name: ToolNames.ADD_TEMPLATE,
    description:
        'Create a reusable template in the user\'s Todoist: from a project, like the app\'s "Save as template"; from CSV content; or from scratch, starting from a blank draft. By default it only returns the draft. Show it to the user and ask whether to change anything, even when they described the whole template, unless they asked to save as is. Then save with preview: false, and `content` if it was edited. Each save creates a new template, which cannot be deleted here.',
    parameters: ArgsSchema,
    outputSchema: OutputSchema,
    // Open world: sharing a workspace template makes it visible to the workspace's members.
    annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
    },
    async execute(args, client) {
        const { projectId, csvFileContent, preview, content } = args

        if (projectId && csvFileContent) {
            throw new Error('Start from a project or from a CSV, not both. Nothing was saved.')
        }

        // The SDK treats strings as filesystem paths, not file content.
        const file = csvFileContent ? new Blob([csvFileContent], { type: 'text/csv' }) : undefined

        if (preview !== false) {
            return getDraft({ client, projectId, file, content })
        }

        if (file && content) {
            throw new Error(
                'Send either `csvFileContent` or the edited `content`, not both: the content replaces the CSV. Nothing was saved.',
            )
        }
        if (!projectId && !file && !content) {
            throw new Error(
                'Nothing to save: pass `content`, or start from a `projectId` or `csvFileContent`.',
            )
        }
        if (args.sharedWithWorkspaceMembers && !args.workspace) {
            throw new Error(
                'Sharing needs `workspace`: only a workspace template can be shared with its members. Nothing was saved.',
            )
        }
        if (!args.name || !args.description) {
            throw new Error(
                'A name and a description are required to save the template. Leave out `preview` to see the draft first.',
            )
        }

        return save(client, { ...args, name: args.name, description: args.description, file })
    },
} satisfies TodoistTool<typeof ArgsSchema, typeof OutputSchema>

async function getDraft({
    client,
    projectId,
    file,
    content,
}: {
    client: TodoistApi
    projectId: string | undefined
    file: Blob | undefined
    content: ToolTemplateContent | undefined
}) {
    if (content) {
        return {
            textContent: `Template draft, not saved: ${outlineTemplateContent(content)}\n${ASK_BEFORE_SAVING} and this \`content\`.`,
            structuredContent: { content },
        }
    }

    if (projectId) {
        const draft = toToolTemplateContent(
            (await client.previewProjectAsTemplate(projectId)).content,
        )
        return {
            textContent: `Draft of project (id=${projectId}) as a template, not saved: ${outlineTemplateContent(draft)}\n${ASK_BEFORE_SAVING} and the edited \`content\` if it changed.`,
            structuredContent: { content: draft },
        }
    }

    if (file) {
        const draft = toToolTemplateContent(
            (await client.previewTemplateFromCsv({ file, fileName: 'template.csv' })).content,
        )
        return {
            textContent: `Draft of the CSV as a template, not saved: ${outlineTemplateContent(draft)}\n${ASK_BEFORE_SAVING} and either the CSV or the edited \`content\`.`,
            structuredContent: { content: draft },
        }
    }

    return {
        textContent: `Blank template draft, not saved: ${outlineTemplateContent(BLANK_CONTENT)}\nAdd sections and tasks to its \`content\`. ${ASK_BEFORE_SAVING} and the \`content\`.`,
        structuredContent: { content: BLANK_CONTENT },
    }
}

async function save(
    client: TodoistApi,
    {
        projectId,
        file,
        content,
        name,
        description,
        color,
        workspace,
        sharedWithWorkspaceMembers,
    }: {
        projectId?: string
        file?: Blob
        content?: ToolTemplateContent
        name: string
        description: string
        color?: ColorKey
        workspace?: string
        sharedWithWorkspaceMembers?: boolean
    },
) {
    const [workspaceId, project] = await Promise.all([
        workspace
            ? workspaceResolver
                  .resolveWorkspace(client, workspace)
                  .then((resolved) => resolved.workspaceId)
            : undefined,
        // Read for its color, and to tell whether it is already in the target workspace.
        projectId && (!color || workspace) ? getProjectOrExplain(client, projectId) : undefined,
    ])
    const sdkContent = content ? toSdkTemplateContent(content) : undefined

    let template: Template
    if (projectId) {
        const projectWorkspaceId =
            project && isWorkspaceProject(project) ? project.workspaceId : undefined

        template = await saveOnce(() =>
            client.saveProjectAsTemplate({
                projectId,
                name,
                description,
                color: color ?? ColorOutputSchema.parse(project?.color) ?? 'charcoal',
                // Saving straight into the project's own workspace keeps its assignees.
                forWorkspace: workspaceId && workspaceId === projectWorkspaceId ? true : undefined,
                content: sdkContent,
            }),
        )
    } else {
        const source = sdkContent
            ? { content: sdkContent }
            : file
              ? { file, fileName: 'template.csv' }
              : undefined
        if (!source) {
            // execute() already rejects a call with nothing to save; this narrows the type.
            throw new Error(
                'Nothing to save: pass `content`, or start from a `projectId` or `csvFileContent`.',
            )
        }
        template = await saveOnce(() =>
            client.addTemplate({ ...source, name, description, color: color ?? 'charcoal' }),
        )
    }

    // As in the app, a new template's workspace and sharing are set after it is created.
    const move = workspaceId !== undefined && template.workspaceId !== workspaceId
    const share = sharedWithWorkspaceMembers === true && !template.sharedWithWorkspaceMembers
    let workspaceError: string | undefined
    if (move || share) {
        try {
            // Its errors are caught below, so the registrar never retries it: retry here.
            template = await executeWithRetry(() =>
                client.updateTemplate(template.id, {
                    workspaceId: move ? workspaceId : undefined,
                    sharedWithWorkspaceMembers: share ? true : undefined,
                }),
            )
        } catch (error) {
            workspaceError = formatBatchItemError(error)
        }
    }

    const savedWorkspaceId = template.workspaceId ?? undefined
    const source = projectId ? `project (id=${projectId})` : content ? 'the draft' : 'CSV content'

    return {
        textContent: generateTextContent({
            source,
            template,
            workspaceId: savedWorkspaceId,
            workspaceError,
        }),
        structuredContent: {
            templateId: template.id,
            name: template.name,
            workspaceId: savedWorkspaceId,
            workspaceError,
        },
    }
}

function generateTextContent({
    source,
    template,
    workspaceId,
    workspaceError,
}: {
    source: string
    template: Template
    workspaceId: string | undefined
    workspaceError: string | undefined
}) {
    const created = `Created template "${template.name}" (id=${template.id}) from ${source}.`
    const sharing = template.sharedWithWorkspaceMembers
        ? 'shared with members'
        : 'not yet shared with members'
    const where = workspaceId
        ? ` It is in the workspace's templates (workspace id=${workspaceId}), ${sharing}.`
        : ' It is in your personal templates.'
    const failed = workspaceError
        ? ` Moving it into the workspace or sharing it failed: ${workspaceError}. Ask the user to move or share it in Todoist.`
        : ''

    return `${created}${where}${failed} Use add-projects with this templateId to start a new project from it.`
}

/**
 * Saves a template once. The registrar re-runs a whole tool call after a 502, 503 or
 * 504. A 503 means nothing was saved, so that retry is safe. After a 502 or 504 the
 * template may already exist and the API can't dedupe a repeat, so the error is
 * replaced by one the registrar won't retry. It has no `cause`, so the error formatter
 * passes its message on as it is, instead of the API's message and "Retry shortly".
 */
async function saveOnce(save: () => Promise<Template>): Promise<Template> {
    try {
        return await save()
    } catch (error) {
        const statusCode = extractHttpStatusCode(error)
        if (statusCode === 502 || statusCode === 504) {
            console.error(`${ToolNames.ADD_TEMPLATE}: the save may have gone through`, {
                error: formatBatchItemError(error),
            })
            throw new Error(
                'The template may have been saved: the server failed after receiving it. Do not retry. Ask the user to check their templates before saving again.',
            )
        }
        throw error
    }
}

export { addTemplate }
