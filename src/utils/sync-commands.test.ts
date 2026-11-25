import {
    createCommand,
    type SyncError,
    type TodoistApi,
    TodoistRequestError,
    TodoistSyncError,
} from '@todoist/sdk'
import { type Mocked, vi } from 'vitest'
import { type CreatedItem, UnconfirmedCreateError } from '../tool-execution-error.js'
import { createLimiter } from './concurrency.js'
import { settleSyncCommands } from './sync-commands.js'
import { allApplied, createApiError } from './test-helpers.js'

const mockTodoistApi = {
    sync: vi.fn(),
} as unknown as Mocked<TodoistApi>

const COMMAND_ERROR: SyncError = {
    error: 'Invalid argument value',
    errorCode: 20,
    errorExtra: { argument: 'query' },
    errorTag: 'INVALID_ARGUMENT_VALUE',
    httpCode: 400,
}

function createCommands() {
    return [
        createCommand('filter_add', { name: 'A', query: 'today' }, 'tempA'),
        createCommand('filter_add', { name: 'B', query: '((' }, 'tempB'),
    ]
}

describe('settleSyncCommands', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('reports every command as applied when the request succeeds', async () => {
        const commands = createCommands()
        mockTodoistApi.sync.mockResolvedValue({
            syncStatus: { [commands[0]?.uuid ?? '']: 'ok', [commands[1]?.uuid ?? '']: 'ok' },
            tempIdMapping: { tempA: 'filter-a', tempB: 'filter-b' },
        })

        const result = await settleSyncCommands(mockTodoistApi, commands)

        expect(result.outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled'])
        expect(result.tempIdMapping).toEqual({ tempA: 'filter-a', tempB: 'filter-b' })
    })

    it('settles each command on its own when some of them fail', async () => {
        const commands = createCommands()
        mockTodoistApi.sync.mockRejectedValue(
            new TodoistSyncError(COMMAND_ERROR, {
                syncStatus: {
                    [commands[0]?.uuid ?? '']: 'ok',
                    [commands[1]?.uuid ?? '']: COMMAND_ERROR,
                },
                tempIdMapping: { tempA: 'filter-a' },
            }),
        )

        const result = await settleSyncCommands(mockTodoistApi, commands)

        expect(result.outcomes[0]?.status).toBe('fulfilled')
        const failed = result.outcomes[1]
        expect(failed?.status).toBe('rejected')
        const reason = failed?.status === 'rejected' ? failed.reason : undefined
        expect(reason).toBeInstanceOf(TodoistRequestError)
        expect(reason).toMatchObject({
            message: 'Invalid argument value',
            httpStatusCode: 400,
            responseData: COMMAND_ERROR,
        })
        expect(result.tempIdMapping).toEqual({ tempA: 'filter-a' })
    })

    it('fails a command that Todoist reported no status for', async () => {
        const commands = createCommands()
        mockTodoistApi.sync.mockResolvedValue({
            syncStatus: { [commands[0]?.uuid ?? '']: 'ok' },
        })

        const result = await settleSyncCommands(mockTodoistApi, commands)

        expect(result.outcomes[0]?.status).toBe('fulfilled')
        expect(result.outcomes[1]).toEqual({
            status: 'rejected',
            reason: new Error('Todoist did not report whether this change was applied'),
        })
    })

    it('fails every command when the request itself fails', async () => {
        const requestError = new Error('Network down')
        mockTodoistApi.sync.mockRejectedValue(requestError)

        const result = await settleSyncCommands(mockTodoistApi, createCommands())

        expect(result.outcomes).toEqual([
            { status: 'rejected', reason: requestError },
            { status: 'rejected', reason: requestError },
        ])
        expect(result.tempIdMapping).toEqual({})
    })

    describe('when the commands create items', () => {
        const created: CreatedItem = { noun: 'filter', findWith: 'find-filters' }

        async function settleAfterRetries() {
            vi.useFakeTimers()
            try {
                const settling = settleSyncCommands(mockTodoistApi, createCommands(), { created })
                await vi.runAllTimersAsync()
                const { outcomes } = await settling
                return outcomes.map((outcome) =>
                    outcome.status === 'rejected' ? outcome.reason : undefined,
                )
            } finally {
                vi.useRealTimers()
            }
        }

        it('says each item may exist when an earlier attempt may have applied the commands', async () => {
            // A 504 can come after Todoist applied the commands; the 503s that follow only
            // say the retries were turned away, not that the first attempt did nothing.
            const lastError = createApiError({ status: 503, error: 'Service Unavailable' })
            mockTodoistApi.sync
                .mockRejectedValueOnce(createApiError({ status: 504, error: 'Gateway Timeout' }))
                .mockRejectedValue(lastError)

            const reasons = await settleAfterRetries()

            expect(mockTodoistApi.sync).toHaveBeenCalledTimes(3)
            expect(reasons).toEqual([
                expect.any(UnconfirmedCreateError),
                expect.any(UnconfirmedCreateError),
            ])
            expect(reasons.map((reason: UnconfirmedCreateError) => reason.cause)).toEqual([
                lastError,
                lastError,
            ])
        })

        it('reports the error as it is when every attempt was turned away', async () => {
            const turnedAway = createApiError({ status: 503, error: 'Service Unavailable' })
            mockTodoistApi.sync.mockRejectedValue(turnedAway)

            const reasons = await settleAfterRetries()

            expect(mockTodoistApi.sync).toHaveBeenCalledTimes(3)
            expect(reasons).toEqual([turnedAway, turnedAway])
        })
    })

    it('holds no limiter slot while waiting to retry, so other requests can go', async () => {
        vi.useFakeTimers()
        try {
            const limit = createLimiter(1)
            mockTodoistApi.sync
                .mockRejectedValueOnce(
                    Object.assign(new Error('Service Unavailable'), { httpStatusCode: 503 }),
                )
                .mockImplementation(async ({ commands = [] }) => ({
                    syncStatus: allApplied(commands),
                    tempIdMapping: {},
                }))

            const retrying = settleSyncCommands(mockTodoistApi, createCommands(), { limit })
            const queued = settleSyncCommands(mockTodoistApi, createCommands(), { limit })
            // Shorter than any retry delay: the first request is still waiting to retry.
            await vi.advanceTimersByTimeAsync(10)

            expect(mockTodoistApi.sync).toHaveBeenCalledTimes(2)

            await vi.runAllTimersAsync()
            const results = await Promise.all([retrying, queued])
            expect(mockTodoistApi.sync).toHaveBeenCalledTimes(3)
            expect(results.map(({ requestFailed }) => requestFailed)).toEqual([false, false])
        } finally {
            vi.useRealTimers()
        }
    })
})
