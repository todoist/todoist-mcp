import { HEALTH_STATUSES, type ProjectHealth, type ProjectProgress } from '@todoist/sdk'
import { z } from 'zod'
import type { TodoistTool } from '../todoist-tool.js'
import { ToolNames } from '../utils/tool-names.js'

const ArgsSchema = {
    projectId: z.string().min(1).describe('The ID of the project to check health for.'),
}

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
}

function generateTextContent(
    projectName: string,
    progress: ProjectProgress,
    health: ProjectHealth,
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

    return lines.join('\n')
}

const getProjectHealth = {
    name: ToolNames.GET_PROJECT_HEALTH,
    description:
        'Get a comprehensive health assessment for a project including completion progress, health status (EXCELLENT, ON_TRACK, AT_RISK, CRITICAL), and a written assessment. Use find-tasks and find-completed-tasks for task-level detail.',
    parameters: ArgsSchema,
    outputSchema: OutputSchema,
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
    },
    async execute(args, client) {
        const { projectId } = args

        const [progress, health] = await Promise.all([
            client.getProjectProgress(projectId),
            client.getProjectHealth(projectId),
        ])
        const projectName = `Project ${projectId}`
        const textContent = generateTextContent(projectName, progress, health)

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
            },
        }
    },
} satisfies TodoistTool<typeof ArgsSchema, typeof OutputSchema>

export { getProjectHealth }
