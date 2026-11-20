import { randomUUID } from 'node:crypto'
import type { SyncCommand, Task, TodoistApi } from '@todoist/sdk'
import { z } from 'zod'
import type { TodoistTool } from '../todoist-tool.js'
import { formatBatchItemError } from '../tool-execution-error.js'
import { logBatchFailures, partitionSettled } from '../utils/batch-failures.js'
import { getWriteLimiter } from '../utils/concurrency.js'
import { BatchLimits } from '../utils/constants.js'
import { FailureSchema } from '../utils/output-schemas.js'
import { summarizeBatch } from '../utils/response-builders.js'
import { executeWithRetry, extractHttpStatusCode } from '../utils/retry.js'
import { settleSyncCommands } from '../utils/sync-commands.js'
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
        const outcomes = await closeTasks(client, args.ids)

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

/**
 * Closes the tasks in one Sync request, as the apps do when a task is ticked off:
 * a recurring task moves to its next occurrence, any other is completed with its
 * subtasks.
 *
 * `item_close` answers "ok" for a task it can't find, so the tasks are read first
 * and only the ones that exist are sent; the rest are reported as not found rather
 * than as completed. Retrying the request is safe: Todoist skips a command whose
 * `uuid` it has already applied, so a recurring task is never closed twice.
 */
async function closeTasks(
    client: TodoistApi,
    ids: string[],
): Promise<PromiseSettledResult<void>[]> {
    const uniqueIds = [...new Set(ids)]
    let lookups: Map<string, PromiseSettledResult<TaskState>>
    try {
        lookups = await findOpenTasks(client, uniqueIds)
    } catch (error) {
        return ids.map(() => ({ status: 'rejected', reason: error }))
    }

    // Only open tasks are sent, and a task listed twice is closed once: closing a
    // recurring task again would skip an occurrence.
    const toClose = uniqueIds.filter((id) => {
        const lookup = lookups.get(id)
        return lookup?.status === 'fulfilled' && lookup.value === 'open'
    })
    const closed = new Map<string, PromiseSettledResult<void>>()
    if (toClose.length > 0) {
        const commands: SyncCommand[] = toClose.map((id) => ({
            type: 'item_close',
            uuid: randomUUID(),
            args: { id },
        }))
        // Counted against the account's write limit, as each REST close was.
        const { outcomes } = await settleSyncCommands(client, commands, {
            limit: getWriteLimiter(client),
        })
        for (const [position, id] of toClose.entries()) {
            const outcome = outcomes[position]
            if (outcome) {
                closed.set(id, outcome)
            }
        }
    }

    return ids.map((id): PromiseSettledResult<void> => {
        const lookup = lookups.get(id)
        if (lookup?.status === 'rejected') {
            return lookup
        }
        return closed.get(id) ?? { status: 'rejected', reason: notClosedReason(lookup?.value) }
    })
}

/** Why a task that was looked up wasn't sent to be closed. */
function notClosedReason(state: TaskState | undefined): Error {
    if (state === 'completed') {
        return new Error('Task is already completed.')
    }
    // Neither listing tool can confirm a task this one couldn't read: find-tasks
    // shows open tasks and find-completed-tasks completed ones.
    return new Error(
        `Task not found, or already completed. Look for it with ${ToolNames.FIND_TASKS}, or ${ToolNames.FIND_COMPLETED_TASKS} if it may be done.`,
    )
}

/**
 * Whether each task is open, read in one request where possible.
 *
 * The API refuses a whole `getTasks({ ids })` when one ID is malformed, so on a 400
 * each task is read on its own instead: a malformed ID then fails alone, with the
 * same error a single read gives, and the rest are still found. A task the batch
 * read leaves out is not open, being unknown or already completed.
 */
async function findOpenTasks(
    client: TodoistApi,
    ids: string[],
): Promise<Map<string, PromiseSettledResult<TaskState>>> {
    try {
        const { results } = await executeWithRetry(() =>
            client.getTasks({ ids, limit: ids.length }),
        )
        const found = new Map(results.map((task) => [task.id, stateOf(task)]))
        return new Map(
            ids.map((id) => [id, { status: 'fulfilled', value: found.get(id) ?? 'missing' }]),
        )
    } catch (error) {
        if (extractHttpStatusCode(error) !== 400) {
            throw error
        }
        console.error(
            `${ToolNames.COMPLETE_TASKS}: batch read refused, reading tasks one at a time`,
            {
                tasks: ids.length,
                error: formatBatchItemError(error),
            },
        )
    }

    const reads = await Promise.allSettled(
        ids.map((id) => executeWithRetry(() => client.getTask(id))),
    )
    return new Map(
        ids.map((id, index): [string, PromiseSettledResult<TaskState>] => {
            const read = reads[index]
            return [
                id,
                read?.status === 'fulfilled'
                    ? { status: 'fulfilled', value: stateOf(read.value) }
                    : { status: 'rejected', reason: read?.reason },
            ]
        }),
    )
}

/**
 * Where a task stands before closing it. `missing` is a task the batch read left
 * out: either unknown, or completed, since that listing only has open tasks.
 */
type TaskState = 'open' | 'completed' | 'missing'

function stateOf(task: Task): TaskState {
    return task.checked ? 'completed' : 'open'
}

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
