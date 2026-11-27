import { isWorkspaceProject, type TodoistApi } from '@todoist/sdk'
import { z } from 'zod'
import type { TodoistTool } from '../todoist-tool.js'
import { getProjectOrExplain } from '../tool-helpers.js'
import { filterResolver } from '../utils/filter-resolver.js'
import { ToolNames } from '../utils/tool-names.js'

const entityTypes = [
    'project',
    'section',
    'task',
    'comment',
    'label',
    'filter',
    'folder',
    'reminder',
    'location_reminder',
] as const

const ArgsSchema = {
    type: z.enum(entityTypes).describe('The type of entity to delete.'),
    id: z.string().min(1).describe('The ID of the entity to delete.'),
}

const OutputSchema = {
    deletedEntity: z
        .object({
            type: z.enum(entityTypes).describe('The type of deleted entity.'),
            id: z.string().describe('The ID of the deleted entity.'),
        })
        .describe('Information about the deleted entity.'),
    success: z.boolean().describe('Whether the deletion was successful.'),
}

type EntityType = (typeof entityTypes)[number]

const CANNOT_UNDO = "This can't be undone."
const QUOTE_LIMIT = 80

/** A task title or comment short enough to quote in a question. */
function quote(text: string): string {
    return text.length > QUOTE_LIMIT ? `${text.slice(0, QUOTE_LIMIT - 1)}…` : text
}

/** The question put to the user before a delete, naming what would go. Looked up only to ask. */
async function describeDeletion(
    client: TodoistApi,
    type: Exclude<EntityType, 'project'>,
    id: string,
): Promise<string> {
    switch (type) {
        case 'section':
            return `Delete the section "${(await client.getSection(id)).name}"? ${CANNOT_UNDO}`
        case 'task':
            return `Delete the task "${quote((await client.getTask(id)).content)}"? ${CANNOT_UNDO}`
        case 'comment':
            return `Delete the comment "${quote((await client.getComment(id)).content)}"? ${CANNOT_UNDO}`
        case 'label':
            return `Delete the label "${(await client.getLabel(id)).name}"? ${CANNOT_UNDO}`
        case 'filter': {
            // The resolver also matches by name, so only an exact ID match names the filter.
            const name = await filterResolver.resolveFilter(client, id).then(
                (filter) => (filter.filterId === id ? filter.filterName : undefined),
                () => undefined,
            )
            return name
                ? `Delete the filter "${name}"? ${CANNOT_UNDO}`
                : `Delete the filter (id=${id})? ${CANNOT_UNDO}`
        }
        case 'folder':
            return `Delete the folder "${(await client.getFolder(id)).name}"? Its projects are kept and moved to the top level of the workspace.`
        case 'reminder': {
            const task = await client.getTask((await client.getReminder(id)).itemId)
            return `Delete the reminder on the task "${quote(task.content)}"? ${CANNOT_UNDO}`
        }
        case 'location_reminder': {
            const task = await client.getTask((await client.getLocationReminder(id)).itemId)
            return `Delete the location reminder on the task "${quote(task.content)}"? ${CANNOT_UNDO}`
        }
    }
}

async function deleteEntity(client: TodoistApi, type: EntityType, id: string): Promise<void> {
    switch (type) {
        case 'project':
            await client.deleteProject(id)
            return
        case 'section':
            await client.deleteSection(id)
            return
        case 'task':
            await client.deleteTask(id)
            return
        case 'comment':
            await client.deleteComment(id)
            return
        case 'label':
            await client.deleteLabel(id)
            return
        case 'filter':
            await client.deleteFilter(id)
            return
        case 'folder':
            await client.deleteFolder(id)
            return
        case 'reminder':
            await client.deleteReminder(id)
            return
        case 'location_reminder':
            await client.deleteLocationReminder(id)
            return
    }
}

const deleteObject = {
    name: ToolNames.DELETE_OBJECT,
    description:
        'Delete a project, section, task, comment, label, filter, folder, reminder, or location_reminder by its ID. Projects can be deleted whether active or archived (find archived ones via find-projects with archivedStatus); note a workspace project must be archived before it can be deleted, while personal projects can be deleted regardless. Deleting a folder keeps its projects, moving them to the top level of the workspace.',
    parameters: ArgsSchema,
    outputSchema: OutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    async execute(args, client, request?) {
        let message: string | (() => Promise<string>)
        if (args.type === 'project') {
            // Checked before asking: there is no point confirming a delete the API will refuse.
            const project = await getProjectOrExplain(client, args.id)
            if (isWorkspaceProject(project) && !project.isArchived) {
                throw new Error(
                    `Workspace project "${project.name}" must be archived before it can be deleted. Archive the project first, then delete it.`,
                )
            }
            message = `Delete the project "${project.name}" and everything in it? ${CANNOT_UNDO}`
        } else {
            const type = args.type
            message = () => describeDeletion(client, type, args.id)
        }

        const confirmation = (await request?.confirm({ key: 'delete', message })) ?? {
            status: 'unavailable',
        }
        if (confirmation.status === 'asking') return confirmation.result
        if (confirmation.status === 'declined') {
            return {
                textContent: `Not deleted: the user declined to delete the ${args.type} (id=${args.id}). Don't try again unless they ask.`,
                structuredContent: {
                    deletedEntity: { type: args.type, id: args.id },
                    success: false,
                },
            }
        }

        await deleteEntity(client, args.type, args.id)

        return {
            textContent:
                args.type === 'folder'
                    ? `Deleted folder: id=${args.id}. Its projects were kept and moved to the top level of the workspace.`
                    : `Deleted ${args.type}: id=${args.id}`,
            structuredContent: {
                deletedEntity: { type: args.type, id: args.id },
                success: true,
            },
        }
    },
} satisfies TodoistTool<typeof ArgsSchema, typeof OutputSchema>

export { deleteObject }
