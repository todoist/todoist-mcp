import type { TodoistApi } from '@todoist/sdk'
import { type Mocked, onTestFinished, vi } from 'vitest'
import { resetLimitersForTesting } from '../utils/concurrency.js'
import { ConcurrencyLimits } from '../utils/constants.js'
import {
    allApplied,
    answerTaskCloses,
    sentSyncCommands,
    createApiError,
    createMockTask,
} from '../utils/test-helpers.js'
import { ToolNames } from '../utils/tool-names.js'
import { completeTasks } from './complete-tasks.js'

// Mock the Todoist API
const mockTodoistApi = {
    sync: vi.fn(),
    getTasks: vi.fn(),
    getTask: vi.fn(),
} as unknown as Mocked<TodoistApi>

// Answers each task the Sync request closes, like the REST close would
const closeTask = vi.fn<(id: string) => Promise<unknown>>()

const { COMPLETE_TASKS } = ToolNames

describe(`${COMPLETE_TASKS} tool`, () => {
    beforeEach(() => {
        vi.clearAllMocks()
        closeTask.mockReset()
        mockTodoistApi.getTask.mockReset()
        resetLimitersForTesting()
        answerTaskCloses(mockTodoistApi, closeTask)
    })

    describe('completing multiple tasks', () => {
        it('should complete all tasks successfully', async () => {
            closeTask.mockResolvedValue(true)

            const result = await completeTasks.execute(
                { ids: ['task-1', 'task-2', 'task-3'] },
                mockTodoistApi,
            )

            // Verify API was called for each task
            expect(closeTask).toHaveBeenCalledTimes(3)
            expect(closeTask).toHaveBeenNthCalledWith(1, 'task-1')
            expect(closeTask).toHaveBeenNthCalledWith(2, 'task-2')
            expect(closeTask).toHaveBeenNthCalledWith(3, 'task-3')

            // Verify result is a concise summary
            expect(result.textContent).toMatchSnapshot()

            // Verify structured content
            const { structuredContent } = result
            expect(structuredContent).toEqual({
                completed: ['task-1', 'task-2', 'task-3'],
                failures: [], // failures array is now kept as empty array
                totalRequested: 3,
                successCount: 3,
                failureCount: 0,
            })
        })

        it('should complete single task', async () => {
            closeTask.mockResolvedValue(true)

            const result = await completeTasks.execute({ ids: ['8485093748'] }, mockTodoistApi)

            expect(closeTask).toHaveBeenCalledTimes(1)
            expect(closeTask).toHaveBeenCalledWith('8485093748')

            expect(result.textContent).toMatchSnapshot()

            // Verify structured content
            const { structuredContent } = result
            expect(structuredContent).toEqual({
                completed: ['8485093748'],
                failures: [], // failures array is now kept as empty array
                totalRequested: 1,
                successCount: 1,
                failureCount: 0,
            })
        })

        it('should handle partial failures gracefully', async () => {
            // Mock first and third tasks to succeed, second to fail
            closeTask
                .mockResolvedValueOnce(true) // task-1 succeeds
                .mockRejectedValueOnce(new Error('Task not found')) // task-2 fails
                .mockResolvedValueOnce(true) // task-3 succeeds

            const result = await completeTasks.execute(
                { ids: ['task-1', 'task-2', 'task-3'] },
                mockTodoistApi,
            )

            // Verify API was called for all tasks despite failure
            expect(closeTask).toHaveBeenCalledTimes(3)
            expect(closeTask).toHaveBeenNthCalledWith(1, 'task-1')
            expect(closeTask).toHaveBeenNthCalledWith(2, 'task-2')
            expect(closeTask).toHaveBeenNthCalledWith(3, 'task-3')

            // Verify only successful completions are reported
            expect(result.textContent).toMatchSnapshot()

            // Verify structured content with partial failures
            const { structuredContent } = result
            expect(structuredContent).toEqual(
                expect.objectContaining({
                    completed: ['task-1', 'task-3'],
                    failures: [
                        expect.objectContaining({
                            item: 'task-2',
                            error: 'Task not found (HTTP 400, code 0)',
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

            const result = await completeTasks.execute(
                { ids: ['task-1', 'task-2'] },
                mockTodoistApi,
            )

            expect(mockTodoistApi.sync).toHaveBeenCalledOnce()
            expect(closeTask).not.toHaveBeenCalled()
            expect(result.textContent).toMatchSnapshot()
        })

        it('should continue processing remaining tasks after failures', async () => {
            // Mock various failure scenarios
            closeTask
                .mockRejectedValueOnce(new Error('Task already completed'))
                .mockRejectedValueOnce(new Error('Task not found'))
                .mockResolvedValueOnce(true) // task-3 succeeds
                .mockRejectedValueOnce(
                    createApiError({ status: 403, error: 'Permission denied', tag: 'FORBIDDEN' }),
                )
                .mockResolvedValueOnce(true) // task-5 succeeds

            const result = await completeTasks.execute(
                { ids: ['task-1', 'task-2', 'task-3', 'task-4', 'task-5'] },
                mockTodoistApi,
            )

            expect(closeTask).toHaveBeenCalledTimes(5)

            // Only tasks 3 and 5 should be in completed list
            expect(result.textContent).toMatchSnapshot()
        })

        it('should handle different types of API errors', async () => {
            closeTask
                .mockRejectedValueOnce(new Error('Task not found'))
                .mockRejectedValueOnce(new Error('Task already completed'))
                .mockRejectedValueOnce(
                    createApiError({ status: 403, error: 'Permission denied', tag: 'FORBIDDEN' }),
                )
                .mockRejectedValueOnce(new Error('Rate limit exceeded'))

            const result = await completeTasks.execute(
                { ids: ['not-found', 'already-done', 'no-permission', 'rate-limited'] },
                mockTodoistApi,
            )

            expect(closeTask).toHaveBeenCalledTimes(4)

            // All should fail, but the tool should handle it gracefully
            expect(result.textContent).toMatchSnapshot()
        })
    })

    describe('mixed success and failure scenarios', () => {
        it('should handle realistic mixed scenario', async () => {
            // Simulate a realistic scenario with some tasks completing and others failing
            closeTask
                .mockResolvedValueOnce(true) // regular task completion
                .mockResolvedValueOnce(true) // another successful completion
                .mockRejectedValueOnce(new Error('Task already completed')) // duplicate completion
                .mockResolvedValueOnce(true) // successful completion
                .mockRejectedValueOnce(new Error('Task not found')) // deleted task

            const result = await completeTasks.execute(
                {
                    ids: [
                        '8485093748', // regular task
                        '8485093749', // regular task
                        '8485093750', // already completed
                        '8485093751', // regular task
                        '8485093752', // deleted task
                    ],
                },
                mockTodoistApi,
            )

            expect(closeTask).toHaveBeenCalledTimes(5)

            expect(result.textContent).toMatchSnapshot()
        })
    })

    describe('next steps logic validation', () => {
        it('should suggest overdue tasks when all tasks complete successfully', async () => {
            closeTask.mockResolvedValue(true)

            const result = await completeTasks.execute(
                { ids: ['task-1', 'task-2'] },
                mockTodoistApi,
            )

            const { textContent } = result
            expect(textContent).toMatchSnapshot()
        })

        it('should suggest reviewing failures when mixed results', async () => {
            closeTask.mockResolvedValueOnce(true).mockRejectedValueOnce(new Error('Task not found'))

            const result = await completeTasks.execute(
                { ids: ['task-1', 'task-2'] },
                mockTodoistApi,
            )

            const { textContent } = result
            expect(textContent).toMatchSnapshot()
        })

        it('should suggest checking IDs when all tasks fail', async () => {
            closeTask.mockRejectedValue(new Error('Task not found'))

            const result = await completeTasks.execute(
                { ids: ['bad-id-1', 'bad-id-2'] },
                mockTodoistApi,
            )

            const { textContent } = result
            expect(textContent).toMatchSnapshot()
        })
    })

    describe('error message truncation', () => {
        it('should truncate failure messages after 3 errors', async () => {
            closeTask
                .mockRejectedValueOnce(new Error('Error 1'))
                .mockRejectedValueOnce(new Error('Error 2'))
                .mockRejectedValueOnce(new Error('Error 3'))
                .mockRejectedValueOnce(new Error('Error 4'))
                .mockRejectedValueOnce(new Error('Error 5'))

            const result = await completeTasks.execute(
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
            closeTask
                .mockRejectedValueOnce(new Error('Error 1'))
                .mockRejectedValueOnce(new Error('Error 2'))
                .mockRejectedValueOnce(new Error('Error 3'))

            const result = await completeTasks.execute(
                { ids: ['task-1', 'task-2', 'task-3'] },
                mockTodoistApi,
            )

            const { textContent } = result
            expect(textContent).toMatchSnapshot()
            expect(textContent).not.toContain('more') // Should not show truncation
        })
    })

    describe('one Sync request per batch', () => {
        it('closes the whole batch in one request, in input order', async () => {
            closeTask.mockResolvedValue(true)

            const result = await completeTasks.execute(
                { ids: ['task-1', 'task-2', 'task-3'] },
                mockTodoistApi,
            )

            expect(mockTodoistApi.sync).toHaveBeenCalledOnce()
            expect(sentSyncCommands(mockTodoistApi)).toEqual(
                ['task-1', 'task-2', 'task-3'].map((id) =>
                    expect.objectContaining({ type: 'item_close', args: { id } }),
                ),
            )
            expect(result.structuredContent.completed).toEqual(['task-1', 'task-2', 'task-3'])
        })

        it('reports a task it cannot find as not found instead of sending it', async () => {
            // item_close answers "ok" for an ID it can't find, so without the read
            // first a wrong ID would be reported as completed.
            answerTaskCloses(mockTodoistApi, closeTask.mockResolvedValue(true), {
                missing: ['wrong-id'],
            })

            const result = await completeTasks.execute(
                { ids: ['task-1', 'wrong-id'] },
                mockTodoistApi,
            )

            expect(sentSyncCommands(mockTodoistApi).map((command) => command.args)).toEqual([
                { id: 'task-1' },
            ])
            expect(result.structuredContent.completed).toEqual(['task-1'])
            expect(result.structuredContent.failures).toEqual([
                {
                    item: 'wrong-id',
                    error: 'Task not found, or already completed. Look for it with find-tasks, or find-completed-tasks if it may be done.',
                },
            ])
        })

        it('does not close a completed task the batch read returns', async () => {
            closeTask.mockResolvedValue(true)
            mockTodoistApi.getTasks.mockResolvedValueOnce({
                results: [
                    createMockTask({ id: 'task-1' }),
                    createMockTask({ id: 'done-1', checked: true }),
                ],
                nextCursor: null,
            })

            const result = await completeTasks.execute(
                { ids: ['task-1', 'done-1'] },
                mockTodoistApi,
            )

            expect(sentSyncCommands(mockTodoistApi).map((command) => command.args)).toEqual([
                { id: 'task-1' },
            ])
            expect(result.structuredContent.failures).toEqual([
                { item: 'done-1', error: 'Task is already completed.' },
            ])
        })

        it('closes a task listed twice only once, so a recurring task does not skip ahead', async () => {
            closeTask.mockResolvedValue(true)

            const result = await completeTasks.execute(
                { ids: ['task-1', 'task-1'] },
                mockTodoistApi,
            )

            expect(closeTask).toHaveBeenCalledOnce()
            expect(result.structuredContent.completed).toEqual(['task-1', 'task-1'])
        })

        it('sends nothing when none of the tasks can be found', async () => {
            answerTaskCloses(mockTodoistApi, closeTask, { missing: ['gone-1', 'gone-2'] })

            const result = await completeTasks.execute(
                { ids: ['gone-1', 'gone-2'] },
                mockTodoistApi,
            )

            expect(mockTodoistApi.sync).not.toHaveBeenCalled()
            expect(result.structuredContent.failureCount).toBe(2)
        })

        it('still closes the other tasks when one ID is malformed, and logs the slower path', async () => {
            const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
            onTestFinished(() => consoleErrorSpy.mockRestore())
            // The API refuses a whole getTasks({ ids }) over one malformed ID, as the
            // real API showed, so the tasks are then read one at a time.
            closeTask.mockResolvedValue(true)
            const malformed = createApiError({
                status: 400,
                error: 'Invalid argument value',
                tag: 'INVALID_ARGUMENT_VALUE',
            })
            mockTodoistApi.getTasks.mockRejectedValueOnce(malformed)
            mockTodoistApi.getTask.mockImplementation(async (id: string) => {
                if (id === 'not-an-id') throw malformed
                return createMockTask({ id })
            })

            const result = await completeTasks.execute(
                { ids: ['task-1', 'not-an-id', 'task-2'] },
                mockTodoistApi,
            )

            expect(sentSyncCommands(mockTodoistApi).map((command) => command.args)).toEqual([
                { id: 'task-1' },
                { id: 'task-2' },
            ])
            expect(result.structuredContent.completed).toEqual(['task-1', 'task-2'])
            expect(result.structuredContent.failures).toEqual([
                {
                    item: 'not-an-id',
                    error: 'Invalid argument value (HTTP 400, tag INVALID_ARGUMENT_VALUE)',
                },
            ])
            expect(consoleErrorSpy).toHaveBeenCalledWith(
                'complete-tasks: batch read refused, reading tasks one at a time',
                {
                    tasks: 3,
                    error: 'Invalid argument value (HTTP 400, tag INVALID_ARGUMENT_VALUE)',
                },
            )
        })

        it('does not close a task again when it is already completed', async () => {
            mockTodoistApi.getTasks.mockRejectedValueOnce(
                createApiError({ status: 400, error: 'Invalid argument value' }),
            )
            mockTodoistApi.getTask.mockImplementation(async (id: string) =>
                createMockTask({ id, checked: id === 'done-1' }),
            )
            closeTask.mockResolvedValue(true)

            const result = await completeTasks.execute(
                { ids: ['done-1', 'task-1'] },
                mockTodoistApi,
            )

            expect(sentSyncCommands(mockTodoistApi).map((command) => command.args)).toEqual([
                { id: 'task-1' },
            ])
            expect(result.structuredContent.failures).toEqual([
                { item: 'done-1', error: 'Task is already completed.' },
            ])
        })

        it('reports every task when the tasks cannot be read', async () => {
            mockTodoistApi.getTasks.mockRejectedValue(
                createApiError({ status: 403, error: 'Forbidden' }),
            )

            const result = await completeTasks.execute(
                { ids: ['task-1', 'task-2'] },
                mockTodoistApi,
            )

            expect(mockTodoistApi.sync).not.toHaveBeenCalled()
            expect(result.structuredContent.failures.map((failure) => failure.item)).toEqual([
                'task-1',
                'task-2',
            ])
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
                    completeTasks.execute({ ids: [`task-${index}`] }, mockTodoistApi),
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
                    closeTask.mockResolvedValue(true)
                    mockTodoistApi.sync.mockRejectedValueOnce(
                        Object.assign(new Error('Gateway trouble'), { httpStatusCode: status }),
                    )

                    const promise = completeTasks.execute({ ids: ['task-1'] }, mockTodoistApi)
                    await vi.runAllTimersAsync()
                    const result = await promise

                    expect(mockTodoistApi.sync).toHaveBeenCalledTimes(2)
                    // The retry carries the same command, so Todoist applies it once.
                    const [first, second] = mockTodoistApi.sync.mock.calls
                    expect(second?.[0].commands?.[0]?.uuid).toBe(first?.[0].commands?.[0]?.uuid)
                    expect(result.structuredContent.completed).toEqual(['task-1'])
                } finally {
                    vi.useRealTimers()
                }
            },
        )
    })

    describe('edge cases', () => {
        it('should handle empty task completion (minimum one task required by schema)', async () => {
            // Note: This test documents that the schema requires at least one task,
            // so this scenario shouldn't occur in practice due to validation
            closeTask.mockResolvedValue(true)

            const result = await completeTasks.execute({ ids: ['single-task'] }, mockTodoistApi)

            expect(result.textContent).toMatchSnapshot()
        })

        it('should handle tasks with special ID formats', async () => {
            closeTask.mockResolvedValue(true)

            const result = await completeTasks.execute(
                { ids: ['proj_123_task_456', 'task-with-dashes', '1234567890'] },
                mockTodoistApi,
            )

            expect(closeTask).toHaveBeenCalledTimes(3)
            expect(closeTask).toHaveBeenCalledWith('proj_123_task_456')
            expect(closeTask).toHaveBeenCalledWith('task-with-dashes')
            expect(closeTask).toHaveBeenCalledWith('1234567890')

            expect(result.textContent).toMatchSnapshot()
        })
    })
})
