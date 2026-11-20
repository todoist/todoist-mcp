import {
    DURATION_UNITS,
    PROJECT_VIEW_STYLES,
    type TemplateContent,
    type TemplateContentDate,
} from '@todoist/sdk'
import { z } from 'zod'
import { BatchLimits, TemplateContentLimits } from './constants.js'
import { convertNumberToPriority, convertPriorityToNumber, PrioritySchema } from './priorities.js'

// fetch-object returns a template's complete dates; a new date can be just `string`. Send dates back as
// received so their type, time and timezone are kept.
const ContentDateSchema = z.object({
    date: z.string().optional().describe('ISO date or datetime.'),
    string: z.string().optional().describe('e.g. "every monday at 9am".'),
    lang: z.string().optional(),
    isRecurring: z.boolean().optional(),
    timezone: z.string().optional(),
})

const ContentCommentFields = {
    content: z.string(),
    postedUid: z.string().optional(),
    postedAt: z.string().optional(),
    fileAttachment: z.record(z.string(), z.unknown()).optional(),
}

/**
 * A template's full content, as fetch-object returns it and update-template takes it back.
 * IDs are references within the content only.
 */
const TemplateContentSchema = z.object({
    projects: z
        .array(
            z.object({
                viewStyle: z.enum(PROJECT_VIEW_STYLES),
                description: z.string().optional(),
                icon: z.string().optional(),
            }),
        )
        .min(1)
        .max(TemplateContentLimits.PROJECTS)
        .describe('The project the template creates. Always one.'),
    sections: z
        .array(z.object({ id: z.string(), name: z.string(), description: z.string().optional() }))
        .max(TemplateContentLimits.ITEMS),
    tasks: z
        .array(
            z.object({
                id: z.string(),
                content: z.string(),
                description: z.string().optional(),
                sectionId: z.string().optional(),
                parentId: z.string().optional(),
                priority: PrioritySchema.optional().describe('p1 is the highest.'),
                labels: z.array(z.string()).max(BatchLimits.LABELS_PER_TASK).optional(),
                due: ContentDateSchema.optional(),
                deadline: ContentDateSchema.optional(),
                duration: z.object({ amount: z.number(), unit: z.enum(DURATION_UNITS) }).optional(),
                responsibleUid: z.string().optional().describe('Assignee user ID.'),
                assignedByUid: z.string().optional(),
            }),
        )
        .max(TemplateContentLimits.ITEMS)
        .describe('In order. New tasks can use any ID that is unique in the content.'),
    comments: z
        .array(z.object({ taskId: z.string(), ...ContentCommentFields }))
        .max(TemplateContentLimits.ITEMS),
    projectComments: z.array(z.object(ContentCommentFields)).max(TemplateContentLimits.ITEMS),
    projectViewOptionsDefaults: z
        .array(z.record(z.string(), z.unknown()))
        .max(TemplateContentLimits.PROJECT_VIEW_OPTIONS)
        .describe('Calendar settings. Send back as received.'),
})

type ToolTemplateContent = z.infer<typeof TemplateContentSchema>

/** Turns the SDK's template content into the tools' shape: "p1"–"p4" priorities, no nulls. */
function toToolTemplateContent(content: TemplateContent): ToolTemplateContent {
    return {
        projects: content.projects.map((project) => ({
            viewStyle: project.viewStyle,
            description: project.description ?? undefined,
            icon: project.icon ?? undefined,
        })),
        sections: content.sections.map((section) => ({
            id: section.id,
            name: section.name,
            description: section.description ?? undefined,
        })),
        tasks: content.tasks.map((task) => ({
            id: task.id,
            content: task.content,
            description: task.description ?? undefined,
            sectionId: task.sectionId ?? undefined,
            parentId: task.parentId ?? undefined,
            priority:
                task.priority === undefined ? undefined : convertNumberToPriority(task.priority),
            labels: task.labels,
            due: toToolDate(task.due),
            deadline: toToolDate(task.deadline),
            duration: task.duration ?? undefined,
            responsibleUid: task.responsibleUid ?? undefined,
            assignedByUid: task.assignedByUid ?? undefined,
        })),
        comments: content.comments.map(({ taskId, ...comment }) => ({
            taskId,
            ...toToolComment(comment),
        })),
        projectComments: content.projectComments.map(toToolComment),
        projectViewOptionsDefaults: content.projectViewOptionsDefaults,
    }
}

function toToolDate(date: TemplateContentDate | null | undefined) {
    if (!date) {
        return undefined
    }
    return {
        date: date.date,
        string: date.string,
        lang: date.lang ?? undefined,
        isRecurring: date.isRecurring,
        timezone: date.timezone ?? undefined,
    }
}

function toToolComment(comment: TemplateContent['projectComments'][number]) {
    return {
        content: comment.content,
        postedUid: comment.postedUid ?? undefined,
        postedAt: comment.postedAt ?? undefined,
        fileAttachment: comment.fileAttachment ?? undefined,
    }
}

/** Turns the tools' template content back into the SDK's shape. */
function toSdkTemplateContent(content: ToolTemplateContent): TemplateContent {
    return {
        ...content,
        tasks: content.tasks.map(({ priority, ...task }) => ({
            ...task,
            ...(priority ? { priority: convertPriorityToNumber(priority) } : {}),
        })),
    }
}

/** The counts a template edit can change, in the order replies list them. */
function countContent(content: TemplateContent): Array<[label: string, count: number]> {
    return [
        ['sections', content.sections.length],
        ['tasks', content.tasks.length],
        ['assigned tasks', content.tasks.filter((task) => task.responsibleUid).length],
        ['comments', content.comments.length + content.projectComments.length],
    ]
}

/**
 * One line comparing two contents, e.g. "layout list → board, sections 0 → 1, tasks 1 → 2,
 * assigned tasks 0 → 0, comments 0 → 0".
 */
function describeContentChange(before: TemplateContent, after: TemplateContent): string {
    const layout = (content: TemplateContent) => content.projects[0]?.viewStyle ?? 'none'
    const afterCounts = countContent(after)
    return [
        `layout ${layout(before)} → ${layout(after)}`,
        ...countContent(before).map(
            ([label, count], index) => `${label} ${count} → ${afterCounts[index]?.[1]}`,
        ),
    ].join(', ')
}

/**
 * What the backend didn't keep of the content sent, e.g. "assigned tasks sent 2, saved 1",
 * or undefined when it kept everything. It drops assignees who are not workspace members,
 * which an addition in the same edit would hide in {@link describeContentChange}.
 */
function describeDroppedContent(sent: TemplateContent, saved: TemplateContent): string | undefined {
    const savedCounts = countContent(saved)
    const dropped = countContent(sent).flatMap(([label, count], index) => {
        const kept = savedCounts[index]?.[1] ?? 0
        return kept < count ? [`${label} sent ${count}, saved ${kept}`] : []
    })
    return dropped.length > 0 ? dropped.join('; ') : undefined
}

const MAX_OUTLINED_TASKS = 20

/**
 * A short text outline of template content for a tool's reply: layout, counts and the first
 * tasks, with their section, nesting and due date.
 */
function outlineTemplateContent(content: ToolTemplateContent): string {
    const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`
    const layout = content.projects[0]?.viewStyle ?? 'list'
    const sectionNames = new Map(content.sections.map((section) => [section.id, section.name]))
    const lines = [
        `${layout} layout, ${plural(content.sections.length, 'section')}, ${plural(content.tasks.length, 'task')}.`,
        ...content.tasks.slice(0, MAX_OUTLINED_TASKS).map((task) => {
            const indent = task.parentId ? '    ' : ''
            const section = task.sectionId
                ? ` [${sectionNames.get(task.sectionId) ?? task.sectionId}]`
                : ''
            const due = task.due?.string ? ` (due ${task.due.string})` : ''
            return `${indent}- ${task.content}${section}${due}`
        }),
    ]
    const remaining = content.tasks.length - MAX_OUTLINED_TASKS
    if (remaining > 0) {
        lines.push(`… ${plural(remaining, 'more task')} in the full content.`)
    }
    return lines.join('\n')
}

export {
    describeContentChange,
    describeDroppedContent,
    outlineTemplateContent,
    TemplateContentSchema,
    toSdkTemplateContent,
    toToolTemplateContent,
    type ToolTemplateContent,
}
