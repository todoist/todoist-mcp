import { createCommand, type TodoistApi } from '@todoist/sdk'
import { z } from 'zod'
import type { TodoistTool } from '../todoist-tool.js'
import { logBatchFailures, partitionSettled } from '../utils/batch-failures.js'
import { getWriteLimiter } from '../utils/concurrency.js'
import { BatchLimits } from '../utils/constants.js'
import { FailureSchema } from '../utils/output-schemas.js'
import { summarizeBatch } from '../utils/response-builders.js'
import { settleSyncCommands } from '../utils/sync-commands.js'
import { ToolNames } from '../utils/tool-names.js'

const ArgsSchema = {
    ids: z
        .array(z.string().min(1))
        .min(1)
        .max(BatchLimits.BULK_ACTIONS_PER_OPERATION)
        .describe('The IDs of the tasks to uncomplete.'),
}

const OutputSchema = {
    uncompleted: z.array(z.string()).describe('The IDs of successfully uncompleted tasks.'),
    failures: z.array(FailureSchema).describe('Failed task uncompletion with error details.'),
    totalRequested: z.number().describe('The total number of tasks requested to uncomplete.'),
    successCount: z.number().describe('The number of successfully uncompleted tasks.'),
    failureCount: z.number().describe('The number of failed task uncompletions.'),
}

const uncompleteTasks = {
    name: ToolNames.UNCOMPLETE_TASKS,
    description: 'Uncomplete (reopen) one or more completed tasks by their IDs.',
    parameters: ArgsSchema,
    outputSchema: OutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    async execute(args, client) {
        const outcomes = await reopenTasks(client, args.ids)

        const { succeeded, failures } = partitionSettled(args.ids, outcomes, (id) => id)
        const uncompleted = succeeded.map(({ item }) => item)

        logBatchFailures(ToolNames.UNCOMPLETE_TASKS, args.ids.length, failures)

        const textContent = generateTextContent({
            uncompleted,
            failures,
            args,
        })

        return {
            textContent,
            structuredContent: {
                uncompleted,
                failures,
                totalRequested: args.ids.length,
                successCount: uncompleted.length,
                failureCount: failures.length,
            },
        }
    },
} satisfies TodoistTool<typeof ArgsSchema, typeof OutputSchema>

/**
 * Reopens the tasks in one Sync request. `item_uncomplete` does what the REST reopen
 * does, restoring a task along with any completed tasks above it, and reports a task
 * it can't find as not found. A task listed twice is sent once. Retrying the
 * request is safe: Todoist skips a command whose `uuid` it has already applied.
 */
async function reopenTasks(
    client: TodoistApi,
    ids: string[],
): Promise<PromiseSettledResult<void>[]> {
    const uniqueIds = [...new Set(ids)]
    // Counted against the account's write limit, as each REST reopen was.
    const { outcomes } = await settleSyncCommands(
        client,
        uniqueIds.map((id) => createCommand('item_uncomplete', { id })),
        { limit: getWriteLimiter(client) },
    )
    const byId = new Map(uniqueIds.map((id, position) => [id, outcomes[position]]))
    return ids.map(
        (id): PromiseSettledResult<void> =>
            byId.get(id) ?? {
                status: 'rejected',
                reason: new Error('Todoist did not report whether this task was reopened'),
            },
    )
}

function generateTextContent({
    uncompleted,
    failures,
    args,
}: {
    uncompleted: string[]
    failures: Array<{ item: string; error: string; code?: string }>
    args: z.infer<z.ZodObject<typeof ArgsSchema>>
}) {
    return summarizeBatch({
        action: 'Uncompleted tasks',
        success: uncompleted.length,
        total: args.ids.length,
        successItems: uncompleted,
        successLabel: 'Reopened',
        failures,
    })
}

export { uncompleteTasks }
