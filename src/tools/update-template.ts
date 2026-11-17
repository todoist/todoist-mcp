import type { TemplateContent, TodoistApi } from '@todoist/sdk'
import { z } from 'zod'
import type { TodoistTool } from '../todoist-tool.js'
import { formatBatchItemError } from '../tool-execution-error.js'
import { colorSchemaWithDefault } from '../utils/colors.js'
import { executeWithRetry } from '../utils/retry.js'
import {
    describeContentChange,
    describeDroppedContent,
    TemplateContentSchema,
    toSdkTemplateContent,
} from '../utils/template-content.js'
import { extractTemplateId, TEMPLATE_ID_PATTERN } from '../utils/template-ids.js'
import { ToolNames } from '../utils/tool-names.js'
import { workspaceResolver } from '../utils/workspace-resolver.js'

const ArgsSchema = {
    templateId: z
        .string()
        .regex(TEMPLATE_ID_PATTERN)
        .describe('A saved template ID ("UT_28Ex...") or its Todoist URL.'),
    name: z.string().trim().min(1).optional(),
    description: z.string().trim().min(1).optional(),
    color: colorSchemaWithDefault(
        'Unrecognized colors are omitted. Omit to keep the current color.',
    ),
    projectId: z
        .string()
        .min(1)
        .optional()
        .describe("Replace the template's content with this project's current content."),
    content: TemplateContentSchema.optional().describe(
        "Replace the template's content: the `content` fetch-object returns for the template, with your edits, all of it. Anything left out is removed. Task IDs change on every save, so fetch the template again before each edit. Not with `projectId`.",
    ),
    workspace: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe(
            'Workspace name or ID to move a personal template into. A workspace template cannot move again.',
        ),
    sharedWithWorkspaceMembers: z
        .boolean()
        .optional()
        .describe(
            'Share a workspace template with its members, or stop sharing it. Only the author can change this.',
        ),
}

const OutputSchema = {
    templateId: z.string(),
    name: z.string(),
    workspaceId: z.string().optional().describe('Absent for personal templates.'),
    sharedWithWorkspaceMembers: z.boolean(),
}

const updateTemplate = {
    name: ToolNames.UPDATE_TEMPLATE,
    description:
        'Update a saved Todoist template: rename it, change its description or color, edit its content (layout, sections, tasks, comments) or replace it from a project, move it into a workspace, or share it with workspace members. Omitted fields stay unchanged. Gallery templates cannot be edited.',
    parameters: ArgsSchema,
    outputSchema: OutputSchema,
    // Destructive: replacing the content overwrites it, and unsharing removes members' access.
    // Open world: sharing shows the template to other workspace members.
    annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
    },
    async execute(
        {
            templateId,
            name,
            description,
            color,
            projectId,
            content,
            workspace,
            sharedWithWorkspaceMembers,
        },
        client,
    ) {
        const id = extractTemplateId(templateId)
        if (!id.startsWith('UT_')) {
            throw new Error(
                `"${id}" is not a saved template ID. Saved template IDs start with "UT_"; gallery templates cannot be edited.`,
            )
        }

        if (
            [
                name,
                description,
                color,
                projectId,
                content,
                workspace,
                sharedWithWorkspaceMembers,
            ].every((value) => value === undefined)
        ) {
            throw new Error(
                'Nothing to update. Provide at least one field to change. An unrecognized color is ignored, so pass one of the listed colors.',
            )
        }

        if (content && projectId) {
            throw new Error(
                'Provide either `content` or `projectId`, not both: each replaces the whole content.',
            )
        }

        // Read the current content first, so the reply can show what the new content changes.
        // The read is only for the reply, so a failure doesn't stop the edit.
        const newContent = content ? toSdkTemplateContent(content) : undefined
        const [previousContent, workspaceId] = await Promise.all([
            newContent ? readContent(client, id, 'before') : undefined,
            workspace
                ? workspaceResolver
                      .resolveWorkspace(client, workspace)
                      .then((resolved) => resolved.workspaceId)
                : undefined,
        ])

        const template = await client.updateTemplate(id, {
            name,
            description,
            color,
            projectId,
            content: newContent,
            workspaceId,
            sharedWithWorkspaceMembers,
        })

        const resultWorkspaceId = template.workspaceId ?? undefined
        const shared = template.sharedWithWorkspaceMembers ?? false
        const where = resultWorkspaceId
            ? ` It is in workspace (id=${resultWorkspaceId}) and ${shared ? 'shared with' : 'not shared with'} its members.`
            : ' It is a personal template.'

        // Compare against what the backend stored: it can drop assignees who are not workspace
        // members. If that read fails, say so rather than compare against what was sent. Don't
        // throw: the registrar would retry the whole call and save the content a second time.
        let contentChange = ''
        if (newContent) {
            const savedContent = await readContent(client, id, 'after')
            if (!savedContent) {
                contentChange = ' The content was saved, but could not be read back to compare.'
            } else {
                contentChange = previousContent
                    ? ` Content: ${describeContentChange(previousContent, savedContent)}.`
                    : ' The previous content could not be read, so the change is not reported.'
                const dropped = describeDroppedContent(newContent, savedContent)
                if (dropped) {
                    contentChange += ` Not everything sent was kept: ${dropped}.`
                }
            }
        }

        return {
            textContent: `Updated template "${template.name}" (id=${template.id}).${where}${contentChange}`,
            structuredContent: {
                templateId: template.id,
                name: template.name,
                workspaceId: resultWorkspaceId,
                sharedWithWorkspaceMembers: shared,
            },
        }
    },
} satisfies TodoistTool<typeof ArgsSchema, typeof OutputSchema>

/**
 * Reads a template's content for the reply, or undefined when it can't. Its errors are
 * caught, so the registrar never retries it: retry here.
 */
async function readContent(
    client: TodoistApi,
    id: string,
    when: 'before' | 'after',
): Promise<TemplateContent | undefined> {
    try {
        return (await executeWithRetry(() => client.getTemplateContent(id))).content
    } catch (error) {
        console.error(`${ToolNames.UPDATE_TEMPLATE}: could not read the content ${when} saving`, {
            error: formatBatchItemError(error),
        })
        return undefined
    }
}

export { updateTemplate }
