import type { Folder } from '@todoist/sdk'
import { z } from 'zod'
import type { TodoistTool } from '../todoist-tool.js'
import { logBatchFailures, partitionSettled } from '../utils/batch-failures.js'
import { BatchLimits } from '../utils/constants.js'
import {
    FailureSchema,
    FolderSchema as FolderOutputSchema,
    toFolderSummary,
} from '../utils/output-schemas.js'
import { appendFailureSummary } from '../utils/response-builders.js'
import { executeWithRetry } from '../utils/retry.js'
import { ToolNames } from '../utils/tool-names.js'

const FolderUpdateSchema = z.object({
    id: z.string().min(1).describe('The ID of the folder to rename.'),
    name: z.string().min(1).describe('The new name of the folder.'),
})

const ArgsSchema = {
    folders: z
        .array(FolderUpdateSchema)
        .min(1)
        .max(BatchLimits.ITEMS_PER_OPERATION)
        .describe('The folders to rename.'),
}

const OutputSchema = {
    folders: z.array(FolderOutputSchema).describe('The renamed folders.'),
    failures: z
        .array(FailureSchema)
        .describe('Folders that could not be renamed, with the reason for each.'),
    successCount: z.number(),
    failureCount: z.number(),
}

type Failure = { item: string; error: string }

const updateFolders = {
    name: ToolNames.UPDATE_FOLDERS,
    description: 'Rename one or more workspace folders.',
    parameters: ArgsSchema,
    outputSchema: OutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    async execute({ folders }, client) {
        // Each folder is renamed on its own, so one rejection neither discards the
        // folders that were renamed nor hides them behind one error.
        const settled = await Promise.allSettled(
            folders.map(({ id, name }) =>
                executeWithRetry(() => client.updateFolder(id, { name })),
            ),
        )

        const { succeeded, failures } = partitionSettled(folders, settled, (folder) => folder.id)
        const updated = succeeded.map(({ value }) => value)

        logBatchFailures(ToolNames.UPDATE_FOLDERS, folders.length, failures)

        return {
            textContent: generateTextContent(updated, failures),
            structuredContent: {
                folders: updated.map(toFolderSummary),
                failures,
                successCount: updated.length,
                failureCount: failures.length,
            },
        }
    },
} satisfies TodoistTool<typeof ArgsSchema, typeof OutputSchema>

function generateTextContent(folders: Folder[], failures: Failure[]): string {
    const count = folders.length
    const lines = folders.map((folder) => `• ${folder.name} (id=${folder.id})`)
    const summary =
        count > 0
            ? `Renamed ${count} folder${count === 1 ? '' : 's'}:\n${lines.join('\n')}`
            : 'Renamed 0 folders'
    return appendFailureSummary(summary, failures)
}

export { updateFolders }
