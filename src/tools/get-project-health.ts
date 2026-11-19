import {
    HEALTH_STATUSES,
    type GetCompletedTasksByCompletionDateArgs,
    type GetTasksArgs,
    type GetTasksResponse,
    type ProjectHealth,
    type ProjectProgress,
    type Task,
    type TodoistApi,
} from '@todoist/sdk'
import { z } from 'zod'
import type { TodoistTool } from '../todoist-tool.js'
import { fetchAllPages, getProjectOrExplain } from '../tool-helpers.js'
import { ApiLimits, ONE_HOUR_MS } from '../utils/constants.js'
import { convertNumberToPriority } from '../utils/priorities.js'
import { ToolNames } from '../utils/tool-names.js'

const ArgsSchema = {
    projectId: z.string().min(1).describe('The ID of the project to check health for.'),
    includeContext: z
        .boolean()
        .default(false)
        .describe(
            'Include detailed health context with project metrics and task-level data. May produce large output for projects with many tasks.',
        ),
}

const TaskContextOutputSchema = z.object({
    id: z.string().describe('The task ID.'),
    content: z.string().describe('The task content/title.'),
    priority: z.string().describe('The task priority (P1-P4).'),
    due: z.string().optional().describe('The due date string, if set.'),
    deadline: z.string().optional().describe('The deadline date string, if set.'),
    isCompleted: z.boolean().describe('Whether the task is completed.'),
    labels: z.array(z.string()).describe('Labels applied to this task.'),
})

const OutputSchema = {
    projectId: z.string().describe('The project ID.'),
    projectName: z.string().describe('The project name.'),
    progress: z
        .object({
            completedCount: z.number().describe('Number of completed tasks.'),
            activeCount: z.number().describe('Number of active (incomplete) tasks.'),
            progressPercent: z.number().describe('Completion percentage (0-100).'),
        })
        .describe('Project completion progress.'),
    health: z
        .object({
            status: z.enum(HEALTH_STATUSES).describe('The overall health status of the project.'),
            description: z
                .string()
                .optional()
                .describe('Detailed description of the health assessment.'),
            descriptionSummary: z
                .string()
                .optional()
                .describe('Brief summary of the health assessment.'),
            isStale: z
                .boolean()
                .describe('Whether the health data is stale and may need refreshing.'),
            updateInProgress: z
                .boolean()
                .describe('Whether a health analysis update is currently in progress.'),
            updatedAt: z
                .string()
                .optional()
                .describe('When the health assessment was last updated.'),
        })
        .describe('Project health assessment.'),
    context: z
        .object({
            projectDescription: z.string().optional().describe('The project description, if any.'),
            projectMetrics: z
                .object({
                    totalTasks: z.number().describe('Total number of tasks in the project.'),
                    completedTasks: z.number().describe('Number of completed tasks.'),
                    overdueTasks: z
                        .number()
                        .describe('Overdue tasks (UTC for floating dates and times).'),
                    tasksCreatedThisWeek: z
                        .number()
                        .describe('Tasks created in the last seven days.'),
                    tasksCompletedThisWeek: z
                        .number()
                        .describe('Tasks completed in the last seven days.'),
                    averageCompletionTime: z
                        .number()
                        .optional()
                        .describe(
                            'Lifetime average in days when all completions fall in the seven-day window.',
                        ),
                })
                .describe('Aggregated project metrics.'),
            tasks: z.array(TaskContextOutputSchema).describe('Active project tasks.'),
        })
        .optional()
        .describe(
            'Detailed project context with metrics and task data. Only included when includeContext is true.',
        ),
}

type HealthData = {
    progress: ProjectProgress
    health: ProjectHealth
    context?: z.infer<typeof OutputSchema.context>
}

const DAY_MS = 24 * ONE_HOUR_MS

function isOverdue(due: string, now: Date): boolean {
    // The health report evaluates floating times in UTC and all-day tasks at day's end.
    if (due.length === 10) return Date.parse(`${due}T23:59:59Z`) < now.getTime()
    const instant = /(?:Z|[+-]\d{2}:\d{2})$/i.test(due) ? due : `${due}Z`
    return Date.parse(instant) < now.getTime()
}

function lifetimeAverageDays(completed: Task[], totalCompleted: number): number | undefined {
    // A seven-day sample only gives a lifetime average when it covers every completion.
    if (completed.length === 0 || completed.length !== totalCompleted) return undefined
    let elapsed = 0
    for (const task of completed) {
        if (!task.addedAt || !task.completedAt) return undefined
        elapsed += task.completedAt.getTime() - task.addedAt.getTime()
    }
    return Number((elapsed / completed.length / DAY_MS).toFixed(2))
}

async function getTaskContext(client: TodoistApi, projectId: string, progress: ProjectProgress) {
    const now = new Date()
    const since = new Date(now.getTime() - 7 * DAY_MS)
    const [project, active, recent] = await Promise.all([
        getProjectOrExplain(client, projectId),
        fetchAllPages<GetTasksArgs, GetTasksResponse, Task>({
            apiMethod: (args) => client.getTasks(args),
            args: { projectId },
            limit: ApiLimits.TASKS_MAX,
        }),
        fetchAllPages<GetCompletedTasksByCompletionDateArgs, GetTasksResponse, Task>({
            apiMethod: async (args) => {
                const { items, nextCursor } = await client.getCompletedTasksByCompletionDate(args)
                return { results: items, nextCursor }
            },
            args: { projectId, since: since.toISOString(), until: now.toISOString() },
            limit: ApiLimits.COMPLETED_TASKS_MAX,
        }),
    ])

    const tasks = active.map((task) => ({
        id: task.id,
        content: task.content,
        priority: (convertNumberToPriority(task.priority) ?? 'p4').toUpperCase(),
        due: task.due?.datetime ?? task.due?.date,
        deadline: task.deadline?.date,
        isCompleted: task.checked,
        labels: task.labels,
    }))
    // An open recurring or reopened task must not also count as a completed task.
    const activeIds = new Set(tasks.map((task) => task.id))
    const completedById = new Map<string, Task>()
    for (const task of recent) {
        if (task.checked && !activeIds.has(task.id)) completedById.set(task.id, task)
    }
    const completed = [...completedById.values()]
    const createdThisWeek = (task: Task) =>
        task.addedAt != null && task.addedAt >= since && task.addedAt <= now
    const context = {
        projectDescription: project.description ?? undefined,
        projectMetrics: {
            totalTasks: progress.activeCount + progress.completedCount,
            completedTasks: progress.completedCount,
            overdueTasks: tasks.filter((task) => task.due && isOverdue(task.due, now)).length,
            tasksCreatedThisWeek:
                active.filter(createdThisWeek).length + completed.filter(createdThisWeek).length,
            tasksCompletedThisWeek: completed.length,
            averageCompletionTime: lifetimeAverageDays(completed, progress.completedCount),
        },
        tasks,
    }
    return { projectName: project.name, context }
}

function generateTextContent(
    projectName: string,
    { progress, health, context }: HealthData,
): string {
    const lines: string[] = [`# Project Health: ${projectName}`, '']

    // Health status
    lines.push(`**Status:** ${health.status}`)
    if (health.isStale) {
        lines.push('**Note:** Health data is stale and may not reflect recent changes.')
    }
    if (health.updateInProgress) {
        lines.push('**Note:** A health analysis update is currently in progress.')
    }
    if (health.updatedAt) {
        lines.push(`**Last Updated:** ${health.updatedAt.toISOString()}`)
    }

    // Progress
    lines.push('')
    lines.push('## Progress')
    lines.push(
        `**Completed:** ${progress.completedCount} | **Active:** ${progress.activeCount} | **Progress:** ${progress.progressPercent}%`,
    )

    // Description
    if (health.description) {
        lines.push('')
        lines.push('## Health Description')
        lines.push(health.description)
    }

    // Context (if included)
    if (context) {
        lines.push('')
        lines.push('## Project Metrics')
        const m = context.projectMetrics
        lines.push(`- **Total Tasks:** ${m.totalTasks}`)
        lines.push(`- **Completed:** ${m.completedTasks}`)
        lines.push(`- **Overdue:** ${m.overdueTasks}`)
        lines.push(`- **Created This Week:** ${m.tasksCreatedThisWeek}`)
        lines.push(`- **Completed This Week:** ${m.tasksCompletedThisWeek}`)
        if (m.averageCompletionTime !== undefined) {
            lines.push(`- **Avg Completion Time:** ${m.averageCompletionTime} days`)
        }

        if (context.tasks.length > 0) {
            lines.push('')
            lines.push(`## Tasks (${context.tasks.length})`)
            for (const task of context.tasks) {
                const parts = [`id=${task.id}`, task.content]
                if (task.due) parts.push(`due=${task.due}`)
                if (task.deadline) parts.push(`deadline=${task.deadline}`)
                if (task.isCompleted) parts.push('(completed)')
                lines.push(`- ${parts.join('; ')}`)
            }
        }
    }

    return lines.join('\n')
}

const getProjectHealth = {
    name: ToolNames.GET_PROJECT_HEALTH,
    description:
        'Get a comprehensive health assessment for a project including completion progress, health status (EXCELLENT, ON_TRACK, AT_RISK, CRITICAL), and optional detailed context with project metrics and task-level data. Use includeContext=true for that full detail.',
    parameters: ArgsSchema,
    outputSchema: OutputSchema,
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
    },
    async execute(args, client) {
        const { projectId, includeContext } = args

        const [progress, health] = await Promise.all([
            client.getProjectProgress(projectId),
            client.getProjectHealth(projectId),
        ])
        const detail = includeContext
            ? await getTaskContext(client, projectId, progress)
            : undefined
        const projectName = detail?.projectName ?? `Project ${projectId}`
        const context = detail?.context
        const textContent = generateTextContent(projectName, { progress, health, context })

        return {
            textContent,
            structuredContent: {
                projectId,
                projectName,
                progress: {
                    completedCount: progress.completedCount,
                    activeCount: progress.activeCount,
                    progressPercent: progress.progressPercent,
                },
                health: {
                    status: health.status,
                    description: health.description ?? undefined,
                    descriptionSummary: health.descriptionSummary ?? undefined,
                    isStale: health.isStale,
                    updateInProgress: health.updateInProgress,
                    updatedAt: health.updatedAt?.toISOString(),
                },
                context,
            },
        }
    },
} satisfies TodoistTool<typeof ArgsSchema, typeof OutputSchema>

export { getProjectHealth }
