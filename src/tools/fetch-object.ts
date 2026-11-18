import { z } from 'zod'
import type { TodoistTool } from '../todoist-tool.js'
import { ProjectAccessError } from '../tool-execution-error.js'
import { getProjectOrExplain, mapComment, mapProject, mapTask } from '../tool-helpers.js'
import {
    ChildrenOutputSchema,
    formatChildrenSummary,
    getProjectChildren,
    getTaskChildren,
    resolveChildren,
} from '../utils/children.js'
import { ColorOutputSchema } from '../utils/colors.js'
import {
    CommentSchema,
    ProjectSchema,
    SectionSchema,
    TaskSchema,
    TemplateOriginFields,
    toSectionSummary,
} from '../utils/output-schemas.js'
import { outlineTemplateContent, toToolTemplateContent } from '../utils/template-content.js'
import { ToolNames } from '../utils/tool-names.js'
import { extractTemplateId, TEMPLATE_ID_PATTERN } from './import-project-template.js'

const ObjectTypes = ['task', 'project', 'comment', 'section', 'template'] as const

const ArgsSchema = {
    type: z.enum(ObjectTypes).describe('The type of object to fetch.'),
    id: z
        .string()
        .regex(TEMPLATE_ID_PATTERN)
        .describe(
            'The unique ID of the object to fetch. For a template, also a gallery slug ("product-launch") or a Todoist template URL.',
        ),
    includeChildren: z
        .boolean()
        .optional()
        .describe(
            'Also return the direct children of the object: subtasks for a task, sub-projects for a project. Returns childCount plus a compact list, flagging each child that has children of its own. Use this to check whether a task hides subtasks instead of a speculative find-tasks lookup. Ignored for comments, sections and templates.',
        ),
}

const TemplateSchema = z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    color: ColorOutputSchema,
    ...TemplateOriginFields,
    sharedWithWorkspaceMembers: z.boolean().optional(),
    canEdit: z.boolean().optional().describe('Whether update-template can change it.'),
    // Declared loosely to keep the tool surface small; update-template's `content` input
    // documents the full shape, which is what this returns.
    content: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
            "The template's content, in the shape update-template's `content` takes. Absent for setup templates.",
        ),
})

const OutputSchema = {
    type: z.enum(ObjectTypes).describe('The type of object fetched.'),
    id: z.string().describe('The ID of the fetched object.'),
    object: z
        .union([TaskSchema, ProjectSchema, CommentSchema, SectionSchema, TemplateSchema])
        .describe('The fetched object data.'),
    ...ChildrenOutputSchema,
}

const fetchObject = {
    name: ToolNames.FETCH_OBJECT,
    description:
        "Fetch a single task, project, comment, section, or template by its ID. Use this when you have a specific object ID and want to retrieve its full details. Set includeChildren to also get its direct subtasks or sub-projects. A template comes with its full content (layout, sections, tasks, comments): to edit a saved template's content, change it and send all of it back to update-template as `content`.",
    parameters: ArgsSchema,
    outputSchema: OutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async execute(args, client) {
        const { type, id, includeChildren } = args

        try {
            switch (type) {
                case 'task': {
                    // Subtasks are looked up by parent id alone, so both requests
                    // can go out at once rather than one after the other.
                    const [task, children] = await Promise.all([
                        client.getTask(id),
                        includeChildren
                            ? resolveChildren(() => getTaskChildren(client, id))
                            : Promise.resolve({}),
                    ])
                    const mappedTask = mapTask(task)
                    return {
                        textContent: `Found task: ${mappedTask.content} • id=${mappedTask.id} • priority=${mappedTask.priority} • project=${mappedTask.projectId}${formatChildrenSummary('subtasks', children)}`,
                        structuredContent: {
                            type,
                            id,
                            object: mappedTask,
                            ...children,
                        },
                    }
                }
                case 'project': {
                    const project = await getProjectOrExplain(client, id)
                    const mappedProject = mapProject(project)
                    const children = includeChildren
                        ? await resolveChildren(() => getProjectChildren(client, project))
                        : {}
                    return {
                        textContent: `Found project: ${mappedProject.name} • id=${mappedProject.id} • color=${mappedProject.color}${mappedProject.icon ? ` • icon=${mappedProject.icon}` : ''} • viewStyle=${mappedProject.viewStyle}${formatChildrenSummary('subProjects', children)}`,
                        structuredContent: {
                            type,
                            id,
                            object: mappedProject,
                            ...children,
                        },
                    }
                }
                case 'comment': {
                    const comment = await client.getComment(id)
                    const mappedComment = mapComment(comment)
                    const truncatedContent =
                        mappedComment.content.length > 50
                            ? `${mappedComment.content.substring(0, 50)}...`
                            : mappedComment.content
                    return {
                        textContent: `Found comment • id=${mappedComment.id} • content="${truncatedContent}" • posted=${mappedComment.postedAt}`,
                        structuredContent: {
                            type,
                            id,
                            object: mappedComment,
                        },
                    }
                }
                case 'section': {
                    const section = await client.getSection(id)

                    if (!section) {
                        throw new Error(`Section ${id} not found.`)
                    }

                    const mappedSection = toSectionSummary(section)
                    return {
                        textContent: `Found section: ${mappedSection.name} • id=${mappedSection.id}`,
                        structuredContent: {
                            type,
                            id,
                            object: mappedSection,
                        },
                    }
                }
                case 'template': {
                    const templateId = extractTemplateId(id)
                    const [template, contentRead] = await Promise.all([
                        client.getTemplate(templateId),
                        settle(() => client.getTemplateContent(templateId)),
                    ])
                    // A setup template creates several projects and labels, which template
                    // content can't describe, so the SDK refuses to read it. Its details
                    // are still worth returning.
                    const isSetup = template.templateType === 'setup'
                    if (!isSetup && contentRead.status === 'rejected') {
                        throw contentRead.reason
                    }
                    const toolContent =
                        !isSetup && contentRead.status === 'fulfilled'
                            ? toToolTemplateContent(contentRead.value.content)
                            : undefined
                    return {
                        textContent: `Found template: ${template.name} • id=${template.id} • ${toolContent ? outlineTemplateContent(toolContent) : 'a setup template, which creates several projects and labels; its content cannot be read'}`,
                        structuredContent: {
                            type,
                            id: template.id,
                            object: {
                                id: template.id,
                                name: template.name,
                                description: template.longDescription,
                                color: ColorOutputSchema.parse(template.templateColor),
                                source: template.templateSource,
                                workspaceId: template.workspaceId ?? undefined,
                                sharedWithWorkspaceMembers: template.sharedWithWorkspaceMembers,
                                canEdit: template.canEdit,
                                content: toolContent,
                            },
                        },
                    }
                }
            }
        } catch (error) {
            if (error instanceof ProjectAccessError) {
                throw error
            }
            throw new Error(
                `Failed to fetch ${type} with id ${id}: ${error instanceof Error ? error.message : String(error)}`,
            )
        }
    },
} satisfies TodoistTool<typeof ArgsSchema, typeof OutputSchema>

async function settle<T>(run: () => Promise<T>): Promise<PromiseSettledResult<T>> {
    try {
        return { status: 'fulfilled', value: await run() }
    } catch (reason) {
        return { status: 'rejected', reason }
    }
}

export { fetchObject }
