import {
    type SyncCommand,
    type SyncResponse,
    type TodoistApi,
    TodoistRequestError,
    TodoistSyncError,
} from '@todoist/sdk'
import type { Limiter } from './concurrency.js'
import { executeWithRetry } from './retry.js'

type SyncCommandResults = {
    /** One entry per command, in the order they were sent. */
    outcomes: PromiseSettledResult<void>[]
    /** Server IDs of the resources the request created, keyed by command `tempId`. */
    tempIdMapping: Record<string, string>
    /**
     * Whether the request itself failed, so every outcome carries the same
     * request-level error rather than anything Todoist said about one command.
     */
    requestFailed: boolean
}

const APPLIED: PromiseFulfilledResult<void> = { status: 'fulfilled', value: undefined }

/**
 * Sends Sync commands in one request and reports whether each was applied.
 *
 * The Sync API applies commands independently, so a failed command does not undo
 * the ones before it. Settling them per command lets a batch tool report each item
 * the way its REST-backed siblings do, instead of failing the whole batch over the
 * first bad item and hiding the changes that were made.
 *
 * Retrying the request is safe: the Sync API skips commands whose `uuid` it has
 * already processed.
 *
 * Pass `limit` to count the request against a concurrency lane, such as the
 * account's write limiter. Each attempt takes a slot of its own, so a request
 * waiting to retry holds none.
 */
export async function settleSyncCommands(
    client: TodoistApi,
    commands: SyncCommand[],
    { limit = (send) => send() }: { limit?: Limiter } = {},
): Promise<SyncCommandResults> {
    let syncStatus: NonNullable<SyncResponse['syncStatus']>
    let tempIdMapping: Record<string, string>

    try {
        const response = await executeWithRetry(() => limit(() => client.sync({ commands })))
        syncStatus = response.syncStatus ?? {}
        tempIdMapping = response.tempIdMapping ?? {}
    } catch (error) {
        if (!(error instanceof TodoistSyncError)) {
            // The request itself failed, so Todoist reported no command as applied.
            return {
                outcomes: commands.map(() => ({ status: 'rejected', reason: error })),
                tempIdMapping: {},
                requestFailed: true,
            }
        }
        syncStatus = error.syncStatus
        tempIdMapping = error.tempIdMapping
    }

    const outcomes = commands.map((command): PromiseSettledResult<void> => {
        const status = syncStatus[command.uuid]
        if (status === 'ok') {
            return APPLIED
        }
        if (status === undefined) {
            return {
                status: 'rejected',
                reason: new Error('Todoist did not report whether this change was applied'),
            }
        }
        // The whole Sync error goes in `responseData` so its code and tag survive
        // into the per-item failure message.
        return {
            status: 'rejected',
            reason: new TodoistRequestError(status.error, status.httpCode, status),
        }
    })

    return { outcomes, tempIdMapping, requestFailed: false }
}
