import type { Folder } from '@todoist/sdk'
import { z } from 'zod'
import type { TodoistTool } from '../todoist-tool.js'
import { formatBatchItemError } from '../tool-execution-error.js'
import { logBatchFailures } from '../utils/batch-failures.js'
import { BatchLimits } from '../utils/constants.js'
import {
    FailureSchema,
    FolderSchema as FolderOutputSchema,
    toFolderSummary,
} from '../utils/output-schemas.js'
import { appendFailureSummary } from '../utils/response-builders.js'
import { executeCreateWithRetry, executeWithRetry } from '../utils/retry.js'
import { ToolNames } from '../utils/tool-names.js'
import { workspaceResolver } from '../utils/workspace-resolver.js'

const { ADD_PROJECTS, LIST_WORKSPACES, UPDATE_PROJECTS } = ToolNames

const FolderSchema = z.object({
    name: z.string().min(1).describe('The name of the folder.'),
    workspace: z
        .string()
        .trim()
        .min(1)
        .describe(`The workspace to create the folder in, by name or ID (see ${LIST_WORKSPACES}).`),
})

const ArgsSchema = {
    folders: z
        .array(FolderSchema)
        .min(1)
        .max(BatchLimits.ITEMS_PER_OPERATION)
        .describe('The folders to add.'),
}

const OutputSchema = {
    folders: z.array(FolderOutputSchema).describe('The created folders.'),
    failures: z
        .array(FailureSchema)
        .describe('Folders that could not be created, with the reason for each.'),
    successCount: z.number(),
    failureCount: z.number(),
}

type Failure = { item: string; error: string }

const addFolders = {
    name: ToolNames.ADD_FOLDERS,
    description: `Add one or more folders to group a workspace's projects. Put projects in one with ${ADD_PROJECTS} or ${UPDATE_PROJECTS} folderId.`,
    parameters: ArgsSchema,
    outputSchema: OutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    async execute({ folders }, client) {
        // Each folder is created on its own, so one rejection neither discards the
        // folders that were created nor hides them behind one error. A create retries
        // only a 503: after a 502/504 the folder may already exist.
        // Folders naming the same workspace share one lookup, retries included.
        const workspaceResolutions = new Map<string, Promise<string>>()
        const resolveWorkspaceId = (workspace: string) => {
            let resolution = workspaceResolutions.get(workspace)
            if (!resolution) {
                resolution = executeWithRetry(() =>
                    workspaceResolver.resolveWorkspace(client, workspace),
                ).then(({ workspaceId }) => workspaceId)
                workspaceResolutions.set(workspace, resolution)
            }
            return resolution
        }

        const settled = await Promise.allSettled(
            folders.map(async ({ name, workspace }) => {
                const workspaceId = await resolveWorkspaceId(workspace)
                return executeCreateWithRetry(() => client.addFolder({ name, workspaceId }))
            }),
        )

        const created: Folder[] = []
        const failures: Failure[] = []
        settled.forEach((result, index) => {
            if (result.status === 'fulfilled') {
                created.push(result.value)
            } else {
                failures.push({
                    item: folders[index]?.name ?? `Folder ${index + 1}`,
                    error: formatBatchItemError(result.reason),
                })
            }
        })

        logBatchFailures(ToolNames.ADD_FOLDERS, folders.length, failures, { redactItems: true })

        return {
            textContent: generateTextContent(created, failures),
            structuredContent: {
                folders: created.map(toFolderSummary),
                failures,
                successCount: created.length,
                failureCount: failures.length,
            },
        }
    },
} satisfies TodoistTool<typeof ArgsSchema, typeof OutputSchema>

function generateTextContent(folders: Folder[], failures: Failure[]): string {
    const count = folders.length
    const lines = folders.map(
        (folder) => `• ${folder.name} (id=${folder.id}, workspaceId=${folder.workspaceId})`,
    )
    const summary =
        count > 0
            ? `Added ${count} folder${count === 1 ? '' : 's'}:\n${lines.join('\n')}`
            : 'Added 0 folders'
    return appendFailureSummary(summary, failures)
}

export { addFolders }
