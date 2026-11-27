import { type TodoistApi, TodoistSyncError } from '@todoist/sdk'
import { type Mocked, vi } from 'vitest'
import { createMockTask } from '../utils/test-helpers.js'
import { ToolNames } from '../utils/tool-names.js'
import { buildRescheduleDate, rescheduleTasks } from './reschedule-tasks.js'

const mockTodoistApi = {
    getTask: vi.fn(),
    sync: vi.fn(),
} as unknown as Mocked<TodoistApi>

const { RESCHEDULE_TASKS } = ToolNames

describe(`${RESCHEDULE_TASKS} tool`, () => {
    beforeEach(() => {
        vi.clearAllMocks()
        // Todoist reports each applied command as 'ok' under its uuid.
        mockTodoistApi.sync.mockImplementation(async ({ commands }) => ({
            syncStatus: Object.fromEntries(
                (commands ?? []).map((command) => [command.uuid, 'ok' as const]),
            ),
        }))
    })

    describe('rescheduling non-recurring tasks', () => {
        it('sends the new date without the old due string', async () => {
            const task = createMockTask({
                id: 'task-1',
                due: {
                    date: '2026-03-15',
                    string: 'Mar 15',
                    isRecurring: false,
                },
            })
            mockTodoistApi.getTask.mockResolvedValue(task)

            await rescheduleTasks.execute(
                { tasks: [{ id: 'task-1', date: '2026-03-20' }] },
                mockTodoistApi,
            )

            expect(mockTodoistApi.sync).toHaveBeenCalledWith({
                commands: [
                    expect.objectContaining({
                        type: 'item_update',
                        args: {
                            id: 'task-1',
                            due: {
                                date: '2026-03-20',
                                isRecurring: false,
                            },
                        },
                    }),
                ],
            })
        })
    })

    describe('rescheduling recurring tasks', () => {
        it('should preserve recurrence pattern when rescheduling', async () => {
            const task = createMockTask({
                id: 'task-1',
                due: {
                    date: '2026-03-15',
                    string: 'every day',
                    isRecurring: true,
                },
            })
            mockTodoistApi.getTask.mockResolvedValue(task)

            await rescheduleTasks.execute(
                { tasks: [{ id: 'task-1', date: '2026-03-20' }] },
                mockTodoistApi,
            )

            expect(mockTodoistApi.sync).toHaveBeenCalledWith({
                commands: [
                    expect.objectContaining({
                        type: 'item_update',
                        args: {
                            id: 'task-1',
                            due: {
                                date: '2026-03-20',
                                string: 'every day',
                                isRecurring: true,
                            },
                        },
                    }),
                ],
            })
        })
    })

    describe('time preservation', () => {
        it('keeps the time that API v1 sends in due.date when input is date-only', async () => {
            const task = createMockTask({
                id: 'task-1',
                due: {
                    date: '2026-12-10T15:00:00',
                    string: 'Dec 10 2026 at 3pm',
                    isRecurring: false,
                },
            })
            mockTodoistApi.getTask.mockResolvedValue(task)

            await rescheduleTasks.execute(
                { tasks: [{ id: 'task-1', date: '2026-12-11' }] },
                mockTodoistApi,
            )

            expect(mockTodoistApi.sync).toHaveBeenCalledWith({
                commands: [
                    expect.objectContaining({
                        args: {
                            id: 'task-1',
                            due: {
                                date: '2026-12-11T15:00:00',
                                isRecurring: false,
                            },
                        },
                    }),
                ],
            })
        })

        it('keeps the time and the rule of a recurring task when input is date-only', async () => {
            const task = createMockTask({
                id: 'task-1',
                due: {
                    date: '2026-03-15T10:00:00',
                    string: 'every day at 10am',
                    isRecurring: true,
                },
            })
            mockTodoistApi.getTask.mockResolvedValue(task)

            await rescheduleTasks.execute(
                { tasks: [{ id: 'task-1', date: '2026-03-20' }] },
                mockTodoistApi,
            )

            expect(mockTodoistApi.sync).toHaveBeenCalledWith({
                commands: [
                    expect.objectContaining({
                        args: {
                            id: 'task-1',
                            due: {
                                date: '2026-03-20T10:00:00',
                                string: 'every day at 10am',
                                isRecurring: true,
                            },
                        },
                    }),
                ],
            })
        })

        it('should use explicit datetime when provided', async () => {
            const task = createMockTask({
                id: 'task-1',
                due: {
                    date: '2026-03-15T10:00:00',
                    string: 'every day at 10am',
                    isRecurring: true,
                },
            })
            mockTodoistApi.getTask.mockResolvedValue(task)

            await rescheduleTasks.execute(
                { tasks: [{ id: 'task-1', date: '2026-03-20T14:00:00' }] },
                mockTodoistApi,
            )

            expect(mockTodoistApi.sync).toHaveBeenCalledWith({
                commands: [
                    expect.objectContaining({
                        args: expect.objectContaining({
                            due: expect.objectContaining({
                                date: '2026-03-20T14:00:00',
                            }),
                        }),
                    }),
                ],
            })
        })
    })

    describe('timezone preservation', () => {
        it('should preserve timezone in sync command', async () => {
            const task = createMockTask({
                id: 'task-1',
                due: {
                    date: '2026-03-15T14:00:00Z',
                    string: 'every day at 10am',
                    isRecurring: true,
                    timezone: 'America/New_York',
                },
            })
            mockTodoistApi.getTask.mockResolvedValue(task)

            await rescheduleTasks.execute(
                { tasks: [{ id: 'task-1', date: '2026-03-20' }] },
                mockTodoistApi,
            )

            expect(mockTodoistApi.sync).toHaveBeenCalledWith({
                commands: [
                    expect.objectContaining({
                        args: expect.objectContaining({
                            due: expect.objectContaining({
                                timezone: 'America/New_York',
                            }),
                        }),
                    }),
                ],
            })
        })
    })

    describe('per-task failures', () => {
        const dated = (id: string) =>
            createMockTask({
                id,
                content: `Task ${id}`,
                due: { date: '2026-03-15', string: 'Mar 15', isRecurring: false },
            })

        it('moves only the due date of a task that has both a due date and a deadline', async () => {
            mockTodoistApi.getTask.mockResolvedValue(
                createMockTask({
                    id: 'task-1',
                    due: { date: '2026-03-15', string: 'Mar 15', isRecurring: false },
                    deadline: { date: '2026-03-10', lang: 'en' },
                }),
            )

            await rescheduleTasks.execute(
                { tasks: [{ id: 'task-1', date: '2026-03-20' }] },
                mockTodoistApi,
            )

            const args = mockTodoistApi.sync.mock.calls[0]?.[0].commands?.[0]?.args
            expect(args).toMatchObject({ id: 'task-1', due: { date: '2026-03-20' } })
            expect(args).not.toHaveProperty('deadline')
        })

        it('moves the deadline of a task that has a deadline but no due date', async () => {
            const undated = createMockTask({
                id: 'task-2',
                content: 'Deadline only',
                due: null,
                deadline: { date: '2026-03-10', lang: 'en' },
            })
            mockTodoistApi.getTask.mockImplementation(async (id: string) =>
                id === 'task-2' ? undated : dated(id),
            )

            const result = await rescheduleTasks.execute(
                {
                    tasks: [
                        { id: 'task-1', date: '2026-03-20' },
                        { id: 'task-2', date: '2026-03-20' },
                    ],
                },
                mockTodoistApi,
            )

            const syncCall = mockTodoistApi.sync.mock.calls[0]
            if (!syncCall) throw new Error('Expected sync to have been called')
            expect(syncCall[0].commands?.map((command) => command.args)).toEqual([
                expect.objectContaining({ id: 'task-1' }),
                { id: 'task-2', deadline: { date: '2026-03-20' } },
            ])
            expect(result.structuredContent).toEqual(
                expect.objectContaining({
                    totalCount: 2,
                    rescheduledTaskIds: ['task-1', 'task-2'],
                    failures: [],
                }),
            )
        })

        it('leaves a task with neither a due date nor a deadline unchanged', async () => {
            mockTodoistApi.getTask.mockResolvedValue(
                createMockTask({ id: 'task-1', due: null, deadline: null }),
            )

            const result = await rescheduleTasks.execute(
                { tasks: [{ id: 'task-1', date: '2026-03-20' }] },
                mockTodoistApi,
            )

            expect(mockTodoistApi.sync).not.toHaveBeenCalled()
            expect(result.structuredContent.totalCount).toBe(0)
            expect(result.structuredContent.failures).toEqual([])
        })

        it('keeps a deadline date-only when given a datetime', async () => {
            mockTodoistApi.getTask.mockResolvedValue(
                createMockTask({
                    id: 'task-1',
                    due: null,
                    deadline: { date: '2026-03-10', lang: 'en' },
                }),
            )

            await rescheduleTasks.execute(
                { tasks: [{ id: 'task-1', date: '2026-03-20T09:00:00' }] },
                mockTodoistApi,
            )

            const syncCall = mockTodoistApi.sync.mock.calls[0]
            if (!syncCall) throw new Error('Expected sync to have been called')
            expect(syncCall[0].commands?.[0]?.args).toEqual({
                id: 'task-1',
                deadline: { date: '2026-03-20' },
            })
        })

        it('reports a task that cannot be read, and reschedules the rest', async () => {
            mockTodoistApi.getTask.mockImplementation(async (id: string) => {
                if (id === 'missing') throw new Error('Task not found')
                return dated(id)
            })

            const result = await rescheduleTasks.execute(
                {
                    tasks: [
                        { id: 'missing', date: '2026-03-20' },
                        { id: 'task-1', date: '2026-03-20' },
                    ],
                },
                mockTodoistApi,
            )

            expect(result.structuredContent.rescheduledTaskIds).toEqual(['task-1'])
            expect(result.structuredContent.failures).toEqual([
                { item: 'missing', error: expect.stringContaining('Task not found') },
            ])
        })

        it('reports the rejected commands and keeps the applied ones', async () => {
            // `skipped` sends no command, so command positions differ from input positions.
            mockTodoistApi.getTask.mockImplementation(async (id: string) =>
                id === 'skipped' ? createMockTask({ id, due: null, deadline: null }) : dated(id),
            )
            const rejection = {
                error: 'Invalid argument value',
                errorCode: 20,
                errorExtra: { argument: 'due' },
                errorTag: 'INVALID_ARGUMENT_VALUE',
                httpCode: 400,
            }
            mockTodoistApi.sync.mockImplementation(async ({ commands = [] }) => {
                const [first, applied, last] = commands
                throw new TodoistSyncError(rejection, {
                    syncStatus: {
                        [first?.uuid ?? '']: rejection,
                        [applied?.uuid ?? '']: 'ok',
                        [last?.uuid ?? '']: rejection,
                    },
                    tempIdMapping: {},
                })
            })

            const result = await rescheduleTasks.execute(
                {
                    tasks: [
                        { id: 'skipped', date: '2026-03-20' },
                        { id: 'task-1', date: '2026-03-20' },
                        { id: 'task-2', date: '2026-03-20' },
                        { id: 'task-3', date: '2026-03-20' },
                    ],
                },
                mockTodoistApi,
            )

            const error = 'Invalid argument value (HTTP 400, code 20, tag INVALID_ARGUMENT_VALUE)'
            expect(result.structuredContent).toEqual(
                expect.objectContaining({
                    totalCount: 1,
                    rescheduledTaskIds: ['task-2'],
                    failures: [
                        { item: 'task-1', error },
                        { item: 'task-3', error },
                    ],
                }),
            )
            expect(result.textContent).toContain('Failed (2)')
        })

        it('reports the tasks it could not read back, keeping the ones it could', async () => {
            const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
            try {
                // Both initial reads succeed; only task-2's read after the update fails.
                mockTodoistApi.getTask
                    .mockResolvedValueOnce(dated('task-1'))
                    .mockResolvedValueOnce(dated('task-2'))
                    .mockResolvedValueOnce(dated('task-1'))
                    .mockRejectedValueOnce(new Error('Connection reset'))

                const result = await rescheduleTasks.execute(
                    {
                        tasks: [
                            { id: 'task-1', date: '2026-03-20' },
                            { id: 'task-2', date: '2026-03-20' },
                        ],
                    },
                    mockTodoistApi,
                )

                expect(result.structuredContent).toEqual(
                    expect.objectContaining({
                        totalCount: 2,
                        rescheduledTaskIds: ['task-1', 'task-2'],
                        tasks: [expect.objectContaining({ id: 'task-1' })],
                        failures: [],
                    }),
                )
                expect(result.textContent).toContain('Rescheduled 2 tasks: task-1, task-2')
                expect(result.textContent).toContain('Could not read back task-2: Connection reset')
                expect(consoleErrorSpy).toHaveBeenCalledWith('reschedule-tasks: read-back failed', {
                    updated: 2,
                    unread: 1,
                    error: expect.stringContaining('Connection reset'),
                })
            } finally {
                consoleErrorSpy.mockRestore()
            }
        })

        it('reports every task when the sync request fails', async () => {
            mockTodoistApi.getTask.mockResolvedValue(dated('task-1'))
            mockTodoistApi.sync.mockRejectedValue(new Error('Sync API error'))

            const result = await rescheduleTasks.execute(
                { tasks: [{ id: 'task-1', date: '2026-03-20' }] },
                mockTodoistApi,
            )

            expect(result.structuredContent).toEqual(
                expect.objectContaining({
                    totalCount: 0,
                    rescheduledTaskIds: [],
                    failures: [
                        { item: 'task-1', error: expect.stringContaining('Sync API error') },
                    ],
                }),
            )
        })
    })

    describe('batch operations', () => {
        it('should batch multiple tasks into a single sync call', async () => {
            const task1 = createMockTask({
                id: 'task-1',
                content: 'Task 1',
                due: {
                    date: '2026-03-15',
                    string: 'every day',
                    isRecurring: true,
                },
            })
            const task2 = createMockTask({
                id: 'task-2',
                content: 'Task 2',
                due: {
                    date: '2026-03-16',
                    string: 'every week',
                    isRecurring: true,
                },
            })

            const updatedTask1 = createMockTask({
                id: 'task-1',
                content: 'Task 1',
                due: { date: '2026-03-20', string: 'every day', isRecurring: true },
            })
            const updatedTask2 = createMockTask({
                id: 'task-2',
                content: 'Task 2',
                due: { date: '2026-03-21', string: 'every week', isRecurring: true },
            })

            mockTodoistApi.getTask
                .mockResolvedValueOnce(task1)
                .mockResolvedValueOnce(task2)
                // Re-fetch after sync
                .mockResolvedValueOnce(updatedTask1)
                .mockResolvedValueOnce(updatedTask2)

            await rescheduleTasks.execute(
                {
                    tasks: [
                        { id: 'task-1', date: '2026-03-20' },
                        { id: 'task-2', date: '2026-03-21' },
                    ],
                },
                mockTodoistApi,
            )

            // Single sync call with two commands
            expect(mockTodoistApi.sync).toHaveBeenCalledTimes(1)
            const syncCall = mockTodoistApi.sync.mock.calls[0]
            if (!syncCall) throw new Error('Expected sync to have been called')
            expect(syncCall[0].commands).toHaveLength(2)
        })
    })

    describe('output format', () => {
        it('should re-fetch tasks and return mapped output', async () => {
            const task = createMockTask({
                id: 'task-1',
                content: 'Recurring task',
                due: {
                    date: '2026-03-15',
                    string: 'every day',
                    isRecurring: true,
                },
            })
            const updatedTask = createMockTask({
                id: 'task-1',
                content: 'Recurring task',
                due: {
                    date: '2026-03-20',
                    string: 'every day',
                    isRecurring: true,
                },
            })

            mockTodoistApi.getTask
                .mockResolvedValueOnce(task) // initial fetch
                .mockResolvedValueOnce(updatedTask) // re-fetch after sync

            const result = await rescheduleTasks.execute(
                { tasks: [{ id: 'task-1', date: '2026-03-20' }] },
                mockTodoistApi,
            )

            expect(result.textContent).toContain('Rescheduled 1 task')
            expect(result.structuredContent).toEqual(
                expect.objectContaining({
                    totalCount: 1,
                    rescheduledTaskIds: ['task-1'],
                    tasks: expect.arrayContaining([
                        expect.objectContaining({
                            id: 'task-1',
                            dueDate: '2026-03-20',
                            recurring: 'every day',
                        }),
                    ]),
                }),
            )

            // Verify getTask called twice: once for reading, once for re-fetch
            expect(mockTodoistApi.getTask).toHaveBeenCalledTimes(2)
        })
    })

    describe('duration', () => {
        it('sets the duration in the same command and keeps the recurrence', async () => {
            const task = createMockTask({
                id: 'task-1',
                due: {
                    date: '2026-10-29T09:00:00',
                    string: 'every day at 9:00',
                    isRecurring: true,
                },
            })
            mockTodoistApi.getTask.mockResolvedValue(task)

            await rescheduleTasks.execute(
                { tasks: [{ id: 'task-1', date: '2026-10-29T10:00:00', duration: '15m' }] },
                mockTodoistApi,
            )

            expect(mockTodoistApi.sync).toHaveBeenCalledWith({
                commands: [
                    expect.objectContaining({
                        type: 'item_update',
                        args: {
                            id: 'task-1',
                            due: {
                                date: '2026-10-29T10:00:00',
                                string: 'every day at 9:00',
                                isRecurring: true,
                            },
                            duration: { amount: 15, unit: 'minute' },
                        },
                    }),
                ],
            })
        })

        it('rejects an invalid duration before any request', async () => {
            await expect(
                rescheduleTasks.execute(
                    { tasks: [{ id: 'task-1', date: '2026-10-29', duration: 'soon' }] },
                    mockTodoistApi,
                ),
            ).rejects.toThrow('Task task-1: Invalid duration format "soon"')

            expect(mockTodoistApi.getTask).not.toHaveBeenCalled()
            expect(mockTodoistApi.sync).not.toHaveBeenCalled()
        })
    })
})

describe('buildRescheduleDate', () => {
    it('should return date-only input as-is when task has no time', () => {
        const result = buildRescheduleDate('2026-03-20', {
            date: '2026-03-15',
            string: 'Mar 15',
            isRecurring: false,
        })
        expect(result).toBe('2026-03-20')
    })

    it('should preserve time from the existing due date', () => {
        const result = buildRescheduleDate('2026-03-20', {
            date: '2026-03-15T10:30:00',
            string: 'every day at 10:30am',
            isRecurring: true,
        })
        expect(result).toBe('2026-03-20T10:30:00')
    })

    it('should use explicit datetime as-is', () => {
        const result = buildRescheduleDate('2026-03-20T14:00:00', {
            date: '2026-03-15T10:30:00',
            string: 'every day at 10:30am',
            isRecurring: true,
        })
        expect(result).toBe('2026-03-20T14:00:00')
    })

    it.each([
        {
            local: '9pm Dec 10 in New York',
            date: '2026-12-11T02:00:00Z',
            timezone: 'America/New_York',
            inputDate: '2026-12-12',
            expected: '2026-12-13T02:00:00Z',
        },
        {
            local: '3pm Dec 10 in New York, moved into daylight saving time',
            date: '2026-12-10T20:00:00Z',
            timezone: 'America/New_York',
            inputDate: '2026-06-10',
            expected: '2026-06-10T19:00:00Z',
        },
        {
            local: '2am Dec 10 at GMT +5:00',
            date: '2026-12-09T21:00:00Z',
            timezone: 'GMT +5:00',
            inputDate: '2026-12-12',
            expected: '2026-12-11T21:00:00Z',
        },
    ])('keeps the local time of $local', ({ date, timezone, inputDate, expected }) => {
        const result = buildRescheduleDate(inputDate, {
            date,
            timezone,
            string: 'Dec 10 2026',
            isRecurring: false,
        })
        expect(result).toBe(expected)
    })

    it.each(['2026-02-30', '2026-13-01'])(
        'passes the invalid date %s through for the API to reject',
        (inputDate) => {
            const result = buildRescheduleDate(inputDate, {
                date: '2026-12-11T02:00:00Z',
                timezone: 'America/New_York',
                string: 'Dec 10 2026',
                isRecurring: false,
            })
            expect(result).toBe(`${inputDate}T02:00:00Z`)
        },
    )
})
