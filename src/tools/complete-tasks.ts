import { z } from 'zod'
import type { TodoistTool } from '../todoist-tool.js'
import { logBatchFailures, partitionSettled } from '../utils/batch-failures.js'
import { getWriteLimiter } from '../utils/concurrency.js'
import { BatchLimits } from '../utils/constants.js'
import { FailureSchema } from '../utils/output-schemas.js'
import { summarizeBatch } from '../utils/response-builders.js'
import { executeCreateWithRetry } from '../utils/retry.js'
import { ToolNames } from '../utils/tool-names.js'

const ArgsSchema = {
    ids: z
        .array(z.string().min(1))
        .min(1)
        .max(BatchLimits.BULK_ACTIONS_PER_OPERATION)
        .describe('The IDs of the tasks to complete.'),
}

const OutputSchema = {
    completed: z.array(z.string()).describe('The IDs of successfully completed tasks.'),
    failures: z.array(FailureSchema).describe('Failed task completions with error details.'),
    totalRequested: z.number().describe('The total number of tasks requested to complete.'),
    successCount: z.number().describe('The number of successfully completed tasks.'),
    failureCount: z.number().describe('The number of failed task completions.'),
}

const completeTasks = {
    name: ToolNames.COMPLETE_TASKS,
    description: 'Complete one or more tasks by their IDs.',
    parameters: ArgsSchema,
    outputSchema: OutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    async execute(args, client) {
        // Up to the write limit at once: one request per task, one after another,
        // takes a large batch past the time a client waits for a tool call. Each
        // attempt takes its own slot, so a task waiting to retry holds none.
        const writeLimiter = getWriteLimiter(client)
        const outcomes = await Promise.allSettled(
            args.ids.map((id) =>
                // Closing a recurring task moves it to its next occurrence, so a
                // repeat after a 502/504 that had already landed would skip one.
                // Only a 503, where the API turned the request away, is retried.
                executeCreateWithRetry(() => writeLimiter(() => client.closeTask(id))),
            ),
        )

        const { succeeded, failures } = partitionSettled(args.ids, outcomes, (id) => id)
        const completed = succeeded.map(({ item }) => item)

        logBatchFailures(ToolNames.COMPLETE_TASKS, args.ids.length, failures)

        const textContent = generateTextContent({
            completed,
            failures,
            args,
        })

        return {
            textContent,
            structuredContent: {
                completed,
                failures,
                totalRequested: args.ids.length,
                successCount: completed.length,
                failureCount: failures.length,
            },
        }
    },
} satisfies TodoistTool<typeof ArgsSchema, typeof OutputSchema>

function generateTextContent({
    completed,
    failures,
    args,
}: {
    completed: string[]
    failures: Array<{ item: string; error: string; code?: string }>
    args: z.infer<z.ZodObject<typeof ArgsSchema>>
}) {
    return summarizeBatch({
        action: 'Completed tasks',
        success: completed.length,
        total: args.ids.length,
        successItems: completed,
        failures,
    })
}

export { completeTasks }
