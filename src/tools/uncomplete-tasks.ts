import { z } from 'zod'
import type { TodoistTool } from '../todoist-tool.js'
import { logBatchFailures, partitionSettled } from '../utils/batch-failures.js'
import { getWriteLimiter } from '../utils/concurrency.js'
import { BatchLimits } from '../utils/constants.js'
import { FailureSchema } from '../utils/output-schemas.js'
import { summarizeBatch } from '../utils/response-builders.js'
import { executeWithRetry } from '../utils/retry.js'
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
        // Up to the write limit at once: one request per task, one after another,
        // takes a large batch past the time a client waits for a tool call. Each
        // attempt takes its own slot, so a task waiting to retry holds none.
        const writeLimiter = getWriteLimiter(client)
        const outcomes = await Promise.allSettled(
            args.ids.map((id) =>
                // Reopening a task that is already open changes nothing, so any
                // transient failure is safe to retry.
                executeWithRetry(() => writeLimiter(() => client.reopenTask(id))),
            ),
        )

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
