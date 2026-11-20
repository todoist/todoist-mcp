import type { z } from 'zod'
import { formatBatchItemError } from '../tool-execution-error.js'
import { LogLimits } from './constants.js'
import type { FailureSchema } from './output-schemas.js'
import type { ToolName } from './tool-names.js'

type BatchFailure = z.infer<typeof FailureSchema>

type SettledBatch<Item, Value> = {
    /** The items that worked, each with the value it settled to and its input index. */
    succeeded: Array<{ item: Item; index: number; value: Value }>
    /** One failure for each item that didn't, in input order. */
    failures: BatchFailure[]
}

/**
 * Splits a batch's settled results into the items that worked and a failure for
 * each one that didn't. `settled` lines up with `items`, as `Promise.allSettled`
 * over them returns it. Each failure names its item with `describe` and explains
 * it with `formatBatchItemError`, which keeps the API's status and error tag.
 */
export function partitionSettled<Item, Value>(
    items: ReadonlyArray<Item>,
    settled: ReadonlyArray<PromiseSettledResult<Value>>,
    describe: (item: Item, index: number) => string,
): SettledBatch<Item, Value> {
    const succeeded: SettledBatch<Item, Value>['succeeded'] = []
    const failures: BatchFailure[] = []

    items.forEach((item, index) => {
        const result = settled[index]
        if (result?.status === 'fulfilled') {
            succeeded.push({ item, index, value: result.value })
        } else {
            failures.push({
                item: describe(item, index),
                error: formatBatchItemError(result?.reason),
            })
        }
    })

    return { succeeded, failures }
}

/** Stands in for caller text that must not reach the logs. */
const REDACTED = '[redacted]'

/**
 * Error messages quote the caller's input they could not act on, such as
 * `Could not find user(s): "ana@example.com"` or `Task "Call the dentist": …`.
 */
const QUOTED_TEXT = /"[^"]*"/g

/**
 * Records the items a batch tool could not act on.
 *
 * These failures are reported in the tool result rather than thrown, so the
 * server answers 200 and logs nothing while the caller's items stay untouched.
 * A whole batch can fail on an expired token or a dropped connection with no
 * trace on this side, which leaves nothing to diagnose from afterwards.
 *
 * @param toolName - The tool that ran the batch, for the log prefix.
 * @param total - How many items the caller asked for.
 * @param failures - The items that failed, as reported in the result.
 * @param options.redactItems - Set where `item` is the caller's own text rather
 * than an identifier, e.g. a task title. That text can carry personal data and
 * must not reach server logs; the error and its code carry the diagnosis anyway.
 * Quoted text inside each error is always redacted, for the same reason.
 */
export function logBatchFailures(
    toolName: ToolName,
    total: number,
    failures: ReadonlyArray<BatchFailure>,
    options: { redactItems?: boolean } = {},
): void {
    if (failures.length === 0) {
        return
    }

    // A batch is as large as the caller's input, so one outage must not put an
    // unbounded array into a log line.
    const sample = failures.slice(0, LogLimits.MAX_FAILURES_LOGGED)

    console.error(`${toolName}: items failed`, {
        failed: failures.length,
        of: total,
        sample: sample.map((failure) => ({
            ...failure,
            item: options.redactItems ? REDACTED : failure.item,
            error: failure.error.replace(QUOTED_TEXT, `"${REDACTED}"`),
        })),
    })
}
