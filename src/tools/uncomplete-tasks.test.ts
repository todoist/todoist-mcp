import type { TodoistApi } from '@todoist/sdk'
import { type Mocked, vi } from 'vitest'
import { resetLimitersForTesting } from '../utils/concurrency.js'
import { ConcurrencyLimits } from '../utils/constants.js'
import {
    allApplied,
    answerTaskReopens,
    createApiError,
    sentSyncCommands,
} from '../utils/test-helpers.js'
import { ToolNames } from '../utils/tool-names.js'
import { uncompleteTasks } from './uncomplete-tasks.js'

// Mock the Todoist API
const mockTodoistApi = {
    sync: vi.fn(),
} as unknown as Mocked<TodoistApi>

// Answers each task the Sync request reopens, like the REST reopen would
const reopenTask = vi.fn<(id: string) => Promise<unknown>>()

// The errors the Sync API gives a command, as the real API returned them
function itemNotFound() {
    return createApiError({ status: 400, error: 'Item not found', tag: 'ITEM_NOT_FOUND', code: 22 })
}
function forbidden() {
    return createApiError({
        status: 403,
        error: 'Insufficient permissions',
        tag: 'FORBIDDEN',
        code: 39,
    })
}

const { UNCOMPLETE_TASKS } = ToolNames

describe(`${UNCOMPLETE_TASKS} tool`, () => {
    beforeEach(() => {
        vi.clearAllMocks()
        reopenTask.mockReset()
        resetLimitersForTesting()
        answerTaskReopens(mockTodoistApi, reopenTask)
    })

    describe('uncompleting multiple tasks', () => {
        it('should uncomplete all tasks successfully', async () => {
            reopenTask.mockResolvedValue(true)

            const result = await uncompleteTasks.execute(
                { ids: ['task-1', 'task-2', 'task-3'] },
                mockTodoistApi,
            )

            // Verify API was called for each task
            expect(reopenTask).toHaveBeenCalledTimes(3)
            expect(reopenTask).toHaveBeenNthCalledWith(1, 'task-1')
            expect(reopenTask).toHaveBeenNthCalledWith(2, 'task-2')
            expect(reopenTask).toHaveBeenNthCalledWith(3, 'task-3')

            // Verify result is a concise summary
            expect(result.textContent).toMatchSnapshot()

            // Verify structured content
            const { structuredContent } = result
            expect(structuredContent).toEqual({
                uncompleted: ['task-1', 'task-2', 'task-3'],
                failures: [],
                totalRequested: 3,
                successCount: 3,
                failureCount: 0,
            })
        })

        it('should uncomplete single task', async () => {
            reopenTask.mockResolvedValue(true)

            const result = await uncompleteTasks.execute({ ids: ['8485093748'] }, mockTodoistApi)

            expect(reopenTask).toHaveBeenCalledTimes(1)
            expect(reopenTask).toHaveBeenCalledWith('8485093748')

            expect(result.textContent).toMatchSnapshot()

            // Verify structured content
            const { structuredContent } = result
            expect(structuredContent).toEqual({
                uncompleted: ['8485093748'],
                failures: [],
                totalRequested: 1,
                successCount: 1,
                failureCount: 0,
            })
        })

        it('should handle partial failures gracefully', async () => {
            // Mock first and third tasks to succeed, second to fail
            reopenTask
                .mockResolvedValueOnce(true) // task-1 succeeds
                .mockRejectedValueOnce(itemNotFound()) // task-2 fails
                .mockResolvedValueOnce(true) // task-3 succeeds

            const result = await uncompleteTasks.execute(
                { ids: ['task-1', 'task-2', 'task-3'] },
                mockTodoistApi,
            )

            // Verify API was called for all tasks despite failure
            expect(reopenTask).toHaveBeenCalledTimes(3)
            expect(reopenTask).toHaveBeenNthCalledWith(1, 'task-1')
            expect(reopenTask).toHaveBeenNthCalledWith(2, 'task-2')
            expect(reopenTask).toHaveBeenNthCalledWith(3, 'task-3')

            // Verify only successful uncompletions are reported
            expect(result.textContent).toMatchSnapshot()

            // Verify structured content with partial failures
            const { structuredContent } = result
            expect(structuredContent).toEqual(
                expect.objectContaining({
                    uncompleted: ['task-1', 'task-3'],
                    failures: [
                        expect.objectContaining({
                            item: 'task-2',
                            error: 'Item not found (HTTP 400, code 22, tag ITEM_NOT_FOUND)',
                        }),
                    ],
                    totalRequested: 3,
                    successCount: 2,
                    failureCount: 1,
                }),
            )
        })

        it('should handle all tasks failing', async () => {
            // A network failure takes down the request itself, so every task shares it.
            mockTodoistApi.sync.mockRejectedValue(new Error('API Error: Network timeout'))

            const result = await uncompleteTasks.execute(
                { ids: ['task-1', 'task-2'] },
                mockTodoistApi,
            )

            expect(mockTodoistApi.sync).toHaveBeenCalledOnce()
            expect(reopenTask).not.toHaveBeenCalled()
            expect(result.textContent).toMatchSnapshot()
        })

        it('should continue processing remaining tasks after failures', async () => {
            // Mock various failure scenarios
            reopenTask
                .mockRejectedValueOnce(forbidden())
                .mockRejectedValueOnce(itemNotFound())
                .mockResolvedValueOnce(true) // task-3 succeeds
                .mockRejectedValueOnce(forbidden())
                .mockResolvedValueOnce(true) // task-5 succeeds

            const result = await uncompleteTasks.execute(
                { ids: ['task-1', 'task-2', 'task-3', 'task-4', 'task-5'] },
                mockTodoistApi,
            )

            expect(reopenTask).toHaveBeenCalledTimes(5)

            // Only tasks 3 and 5 should be in uncompleted list
            expect(result.textContent).toMatchSnapshot()
        })

        it('should handle different types of API errors', async () => {
            reopenTask
                .mockRejectedValueOnce(itemNotFound())
                .mockRejectedValueOnce(forbidden())
                .mockRejectedValueOnce(forbidden())
                .mockRejectedValueOnce(itemNotFound())

            const result = await uncompleteTasks.execute(
                { ids: ['not-found', 'no-permission', 'also-no-permission', 'also-not-found'] },
                mockTodoistApi,
            )

            expect(reopenTask).toHaveBeenCalledTimes(4)

            // All should fail, but the tool should handle it gracefully
            expect(result.textContent).toMatchSnapshot()
        })
    })

    describe('mixed success and failure scenarios', () => {
        it('should handle realistic mixed scenario', async () => {
            // Simulate a realistic scenario with some tasks reopening and others failing
            reopenTask
                .mockResolvedValueOnce(true) // regular task reopen
                .mockResolvedValueOnce(true) // another successful reopen
                .mockRejectedValueOnce(forbidden()) // a project they can't edit
                .mockResolvedValueOnce(true) // successful reopen
                .mockRejectedValueOnce(itemNotFound()) // deleted task

            const result = await uncompleteTasks.execute(
                {
                    ids: [
                        '8485093748', // regular task
                        '8485093749', // regular task
                        '8485093750', // already active
                        '8485093751', // regular task
                        '8485093752', // deleted task
                    ],
                },
                mockTodoistApi,
            )

            expect(reopenTask).toHaveBeenCalledTimes(5)

            expect(result.textContent).toMatchSnapshot()
        })
    })

    describe('next steps logic validation', () => {
        it('should suggest next steps when all tasks uncomplete successfully', async () => {
            reopenTask.mockResolvedValue(true)

            const result = await uncompleteTasks.execute(
                { ids: ['task-1', 'task-2'] },
                mockTodoistApi,
            )

            const { textContent } = result
            expect(textContent).toMatchSnapshot()
        })

        it('should suggest reviewing failures when mixed results', async () => {
            reopenTask.mockResolvedValueOnce(true).mockRejectedValueOnce(itemNotFound())

            const result = await uncompleteTasks.execute(
                { ids: ['task-1', 'task-2'] },
                mockTodoistApi,
            )

            const { textContent } = result
            expect(textContent).toMatchSnapshot()
        })

        it('should suggest checking IDs when all tasks fail', async () => {
            reopenTask.mockRejectedValue(itemNotFound())

            const result = await uncompleteTasks.execute(
                { ids: ['bad-id-1', 'bad-id-2'] },
                mockTodoistApi,
            )

            const { textContent } = result
            expect(textContent).toMatchSnapshot()
        })
    })

    describe('error message truncation', () => {
        it('should truncate failure messages after 3 errors', async () => {
            reopenTask
                .mockRejectedValueOnce(new Error('Error 1'))
                .mockRejectedValueOnce(new Error('Error 2'))
                .mockRejectedValueOnce(new Error('Error 3'))
                .mockRejectedValueOnce(new Error('Error 4'))
                .mockRejectedValueOnce(new Error('Error 5'))

            const result = await uncompleteTasks.execute(
                { ids: ['task-1', 'task-2', 'task-3', 'task-4', 'task-5'] },
                mockTodoistApi,
            )

            const { textContent } = result
            expect(textContent).toMatchSnapshot()
            expect(textContent).toContain('+2 more') // 5 total failures, showing first 3, so +2 more
            expect(textContent).not.toContain('Error 4') // Should not show 4th error
            expect(textContent).not.toContain('Error 5') // Should not show 5th error
        })

        it('should not show truncation message for exactly 3 errors', async () => {
            reopenTask
                .mockRejectedValueOnce(new Error('Error 1'))
                .mockRejectedValueOnce(new Error('Error 2'))
                .mockRejectedValueOnce(new Error('Error 3'))

            const result = await uncompleteTasks.execute(
                { ids: ['task-1', 'task-2', 'task-3'] },
                mockTodoistApi,
            )

            const { textContent } = result
            expect(textContent).toMatchSnapshot()
            expect(textContent).not.toContain('more') // Should not show truncation
        })
    })

    describe('one Sync request per batch', () => {
        it('reopens the whole batch in one request, in input order', async () => {
            reopenTask.mockResolvedValue(true)

            const result = await uncompleteTasks.execute(
                { ids: ['task-1', 'task-2', 'task-3'] },
                mockTodoistApi,
            )

            expect(mockTodoistApi.sync).toHaveBeenCalledOnce()
            expect(sentSyncCommands(mockTodoistApi)).toEqual(
                ['task-1', 'task-2', 'task-3'].map((id) =>
                    expect.objectContaining({ type: 'item_uncomplete', args: { id } }),
                ),
            )
            expect(result.structuredContent.uncompleted).toEqual(['task-1', 'task-2', 'task-3'])
        })

        it('reports a task Todoist cannot find without failing the others', async () => {
            reopenTask.mockImplementation(async (id) => {
                if (id === 'gone') throw itemNotFound()
                return true
            })

            const result = await uncompleteTasks.execute(
                { ids: ['task-1', 'gone', 'task-2'] },
                mockTodoistApi,
            )

            expect(result.structuredContent.uncompleted).toEqual(['task-1', 'task-2'])
            expect(result.structuredContent.failures).toEqual([
                { item: 'gone', error: 'Item not found (HTTP 400, code 22, tag ITEM_NOT_FOUND)' },
            ])
        })

        it('sends a task listed twice once', async () => {
            reopenTask.mockResolvedValue(true)

            const result = await uncompleteTasks.execute(
                { ids: ['task-1', 'task-1'] },
                mockTodoistApi,
            )

            expect(reopenTask).toHaveBeenCalledOnce()
            expect(result.structuredContent.uncompleted).toEqual(['task-1', 'task-1'])
        })

        it('keeps parallel calls for one account within the write limit', async () => {
            let active = 0
            let peak = 0
            mockTodoistApi.sync.mockImplementation(async ({ commands = [] }) => {
                active += 1
                peak = Math.max(peak, active)
                await new Promise((resolve) => setTimeout(resolve, 5))
                active -= 1
                return { syncStatus: allApplied(commands), tempIdMapping: {} }
            })

            await Promise.all(
                Array.from({ length: 6 }, (_, index) =>
                    uncompleteTasks.execute({ ids: [`task-${index}`] }, mockTodoistApi),
                ),
            )

            expect(mockTodoistApi.sync).toHaveBeenCalledTimes(6)
            expect(peak).toBe(ConcurrencyLimits.WRITES)
        })

        it.each([502, 503, 504])(
            'retries the request after a %i, since Todoist skips commands it already applied',
            async (status) => {
                vi.useFakeTimers()
                try {
                    reopenTask.mockResolvedValue(true)
                    mockTodoistApi.sync.mockRejectedValueOnce(
                        Object.assign(new Error('Gateway trouble'), { httpStatusCode: status }),
                    )

                    const promise = uncompleteTasks.execute({ ids: ['task-1'] }, mockTodoistApi)
                    await vi.runAllTimersAsync()
                    const result = await promise

                    expect(mockTodoistApi.sync).toHaveBeenCalledTimes(2)
                    const [first, second] = mockTodoistApi.sync.mock.calls
                    expect(second?.[0].commands?.[0]?.uuid).toBe(first?.[0].commands?.[0]?.uuid)
                    expect(result.structuredContent.uncompleted).toEqual(['task-1'])
                } finally {
                    vi.useRealTimers()
                }
            },
        )
    })

    describe('edge cases', () => {
        it('should handle minimum one task required by schema', async () => {
            reopenTask.mockResolvedValue(true)

            const result = await uncompleteTasks.execute({ ids: ['single-task'] }, mockTodoistApi)

            expect(result.textContent).toMatchSnapshot()
        })

        it('should handle tasks with special ID formats', async () => {
            reopenTask.mockResolvedValue(true)

            const result = await uncompleteTasks.execute(
                { ids: ['proj_123_task_456', 'task-with-dashes', '1234567890'] },
                mockTodoistApi,
            )

            expect(reopenTask).toHaveBeenCalledTimes(3)
            expect(reopenTask).toHaveBeenCalledWith('proj_123_task_456')
            expect(reopenTask).toHaveBeenCalledWith('task-with-dashes')
            expect(reopenTask).toHaveBeenCalledWith('1234567890')

            expect(result.textContent).toMatchSnapshot()
        })
    })
})
