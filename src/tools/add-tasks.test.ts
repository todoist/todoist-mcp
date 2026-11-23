import type { Task, TodoistApi } from '@todoist/sdk'
import { type Mocked, vi } from 'vitest'
import { z } from 'zod'
import { assignmentValidator } from '../utils/assignment-validator.js'
import { convertPriorityToNumber } from '../utils/priorities.js'
import {
    allApplied,
    answerTaskCreates,
    sentSyncCommands,
    createApiError,
    createMockProject,
    createMockSection,
    createMockTask,
    createMockUser,
    mockUnjoinedWorkspaceProject,
    TEST_IDS,
    type TaskCreateArgs,
    TODAY,
} from '../utils/test-helpers.js'
import { ToolNames } from '../utils/tool-names.js'
import { userResolver } from '../utils/user-resolver.js'
import { addTasks, MAX_TASKS_PER_OPERATION } from './add-tasks.js'

// Mock the Todoist API
const mockTodoistApi = {
    sync: vi.fn(),
    getTasks: vi.fn(),
    getTask: vi.fn(),
    getProject: vi.fn(),
    getSection: vi.fn(),
    getUser: vi.fn(),
    getWorkspaces: vi.fn(),
    getWorkspaceActiveProjects: vi.fn(),
    getProjects: vi.fn(),
    getProjectCollaborators: vi.fn(),
} as unknown as Mocked<TodoistApi>

// Answers each task the Sync request creates, like a create endpoint would
const createTask = vi.fn<(args: TaskCreateArgs) => Promise<Task>>()

const { ADD_TASKS } = ToolNames

describe(`${ADD_TASKS} tool`, () => {
    beforeEach(() => {
        vi.clearAllMocks()
        createTask.mockReset()
        mockTodoistApi.getProject.mockResolvedValue(createMockProject())
        answerTaskCreates(mockTodoistApi, createTask)
    })

    describe('adding multiple tasks', () => {
        it('should add multiple tasks and return mapped results', async () => {
            // Mock API responses extracted from recordings (Task type)
            const mockApiResponse1: Task = createMockTask({
                id: '8485093748',
                content: 'First task content',
                url: 'https://todoist.com/showTask?id=8485093748',
                addedAt: new Date('2025-08-13T22:09:56.123456Z'),
            })

            const mockApiResponse2: Task = createMockTask({
                id: '8485093749',
                content: 'Second task content',
                description: 'Task description',
                labels: ['work', 'urgent'],
                childOrder: 2,
                priority: 'p3',
                url: 'https://todoist.com/showTask?id=8485093749',
                addedAt: new Date('2025-08-13T22:09:57.123456Z'),
                due: {
                    date: '2025-08-15',
                    isRecurring: false,
                    lang: 'en',
                    string: 'Aug 15',
                    timezone: null,
                },
            })

            createTask
                .mockResolvedValueOnce(mockApiResponse1)
                .mockResolvedValueOnce(mockApiResponse2)

            const result = await addTasks.execute(
                {
                    tasks: [
                        {
                            content: 'First task content',
                            projectId: '6cfCcrrCFg2xP94Q',
                        },
                        {
                            content: 'Second task content',
                            description: 'Task description',
                            priority: 'p2',
                            dueString: 'Aug 15',
                            projectId: '6cfCcrrCFg2xP94Q',
                        },
                    ],
                },
                mockTodoistApi,
            )

            // Verify API was called correctly for each task
            expect(createTask).toHaveBeenCalledTimes(2)

            // Verify result is a concise summary
            expect(result.textContent).toMatchSnapshot()

            // Verify structured content
            const structuredContent = result.structuredContent
            expect(structuredContent.tasks).toHaveLength(2)
            expect(structuredContent).toEqual(
                expect.objectContaining({
                    totalCount: 2,
                    totalRequested: 2,
                    successCount: 2,
                    failureCount: 0,
                    failures: [],
                    tasks: expect.arrayContaining([
                        expect.objectContaining({ id: '8485093748' }),
                        expect.objectContaining({ id: '8485093749' }),
                    ]),
                }),
            )
        })

        it('should handle tasks with section and parent IDs', async () => {
            const mockApiResponse: Task = createMockTask({
                id: '8485093750',
                content: 'Subtask content',
                description: 'Subtask description',
                priority: 'p2',
                sectionId: 'section-123',
                parentId: 'parent-task-456',
                url: 'https://todoist.com/showTask?id=8485093750',
                addedAt: new Date('2025-08-13T22:09:58.123456Z'),
            })

            createTask.mockResolvedValue(mockApiResponse)

            const result = await addTasks.execute(
                {
                    tasks: [
                        {
                            content: 'Subtask content',
                            description: 'Subtask description',
                            priority: 'p3',
                            projectId: '6cfCcrrCFg2xP94Q',
                            sectionId: 'section-123',
                            parentId: 'parent-task-456',
                        },
                    ],
                },
                mockTodoistApi,
            )

            expect(createTask).toHaveBeenCalledWith({
                content: 'Subtask content',
                description: 'Subtask description',
                priority: convertPriorityToNumber('p3'),
                projectId: '6cfCcrrCFg2xP94Q',
                sectionId: 'section-123',
                parentId: 'parent-task-456',
                autoReminder: true,
            })

            // Verify result is a concise summary
            expect(result.textContent).toMatchSnapshot()

            // Verify structured content
            const structuredContent = result.structuredContent
            expect(structuredContent).toEqual(
                expect.objectContaining({
                    totalCount: 1,
                    successCount: 1,
                    failureCount: 0,
                    failures: [],
                    tasks: expect.arrayContaining([expect.objectContaining({ id: '8485093750' })]),
                }),
            )
        })

        it('should add tasks with duration', async () => {
            const mockApiResponse1: Task = createMockTask({
                id: '8485093752',
                content: 'Task with 2 hour duration',
                duration: { amount: 120, unit: 'minute' },
                url: 'https://todoist.com/showTask?id=8485093752',
                addedAt: new Date('2025-08-13T22:09:56.123456Z'),
            })

            const mockApiResponse2: Task = createMockTask({
                id: '8485093753',
                content: 'Task with 45 minute duration',
                duration: { amount: 45, unit: 'minute' },
                url: 'https://todoist.com/showTask?id=8485093753',
                addedAt: new Date('2025-08-13T22:09:57.123456Z'),
            })

            createTask
                .mockResolvedValueOnce(mockApiResponse1)
                .mockResolvedValueOnce(mockApiResponse2)

            const result = await addTasks.execute(
                {
                    tasks: [
                        {
                            content: 'Task with 2 hour duration',
                            duration: '2h',
                            projectId: '6cfCcrrCFg2xP94Q',
                        },
                        {
                            content: 'Task with 45 minute duration',
                            duration: '45m',
                            projectId: '6cfCcrrCFg2xP94Q',
                        },
                    ],
                },
                mockTodoistApi,
            )

            // Verify result is a concise summary
            expect(result.textContent).toMatchSnapshot()

            // Verify structured content
            const structuredContent = result.structuredContent
            expect(structuredContent.tasks).toHaveLength(2)
            expect(structuredContent).toEqual(
                expect.objectContaining({
                    totalCount: 2,
                    successCount: 2,
                    failureCount: 0,
                    tasks: expect.arrayContaining([
                        expect.objectContaining({ id: '8485093752' }),
                        expect.objectContaining({ id: '8485093753' }),
                    ]),
                }),
            )
        })

        it('should handle various duration formats', async () => {
            const mockApiResponse: Task = createMockTask({
                id: '8485093754',
                content: 'Task with combined duration',
                duration: { amount: 150, unit: 'minute' },
                url: 'https://todoist.com/showTask?id=8485093754',
                addedAt: new Date('2025-08-13T22:09:56.123456Z'),
            })

            createTask.mockResolvedValue(mockApiResponse)

            // Test different duration formats
            const testCases = [
                { input: '2h30m', expectedAmount: 150, expectedUnit: 'minute' },
                { input: '1.5h', expectedAmount: 90, expectedUnit: 'minute' },
                { input: ' 90m ', expectedAmount: 90, expectedUnit: 'minute' },
                { input: '2H30M', expectedAmount: 150, expectedUnit: 'minute' },
                // The API accepts durations of 24 hours or longer; the apps just do not display them
                { input: '25h', expectedAmount: 1500, expectedUnit: 'minute' },
            ]

            for (const testCase of testCases) {
                createTask.mockClear()

                await addTasks.execute(
                    {
                        tasks: [
                            {
                                content: 'Test task',
                                duration: testCase.input,
                                projectId: '6cfCcrrCFg2xP94Q',
                            },
                        ],
                    },
                    mockTodoistApi,
                )

                expect(createTask).toHaveBeenCalledWith(
                    expect.objectContaining({
                        duration: { amount: testCase.expectedAmount, unit: testCase.expectedUnit },
                    }),
                )
            }
        })

        it('should add a task with a day-based duration', async () => {
            createTask.mockResolvedValue(
                createMockTask({
                    id: '8485093755',
                    content: 'Four day task',
                    duration: { amount: 4, unit: 'day' },
                }),
            )

            const result = await addTasks.execute(
                {
                    tasks: [
                        { content: 'Four day task', duration: '4d', projectId: '6cfCcrrCFg2xP94Q' },
                    ],
                },
                mockTodoistApi,
            )

            expect(createTask).toHaveBeenCalledWith(
                expect.objectContaining({ duration: { amount: 4, unit: 'day' } }),
            )
            expect(result.structuredContent.tasks[0]?.duration).toBe('4d')
        })

        it('should add task with deadline', async () => {
            const mockApiResponse: Task = createMockTask({
                id: '8485093756',
                content: 'Task with deadline',
                deadline: {
                    date: '2025-12-31',
                    lang: 'en',
                },
                url: 'https://todoist.com/showTask?id=8485093756',
                addedAt: new Date('2025-08-13T22:09:56.123456Z'),
            })

            createTask.mockResolvedValue(mockApiResponse)

            const result = await addTasks.execute(
                {
                    tasks: [
                        {
                            content: 'Task with deadline',
                            projectId: '6cfCcrrCFg2xP94Q',
                            deadlineDate: '2025-12-31',
                        },
                    ],
                },
                mockTodoistApi,
            )

            // Verify API was called with deadline
            expect(createTask).toHaveBeenCalledWith({
                content: 'Task with deadline',
                projectId: '6cfCcrrCFg2xP94Q',
                sectionId: undefined,
                parentId: undefined,
                deadline: { date: '2025-12-31' },
                autoReminder: true,
            })

            // Verify result is a concise summary
            expect(result.textContent).toMatchSnapshot()

            // Verify structured content includes deadline
            const structuredContent = result.structuredContent
            expect(structuredContent.tasks).toHaveLength(1)
            expect(structuredContent).toEqual(
                expect.objectContaining({
                    totalCount: 1,
                    successCount: 1,
                    failureCount: 0,
                    tasks: expect.arrayContaining([
                        expect.objectContaining({
                            id: '8485093756',
                            deadlineDate: '2025-12-31',
                        }),
                    ]),
                }),
            )
        })

        it('should add task with labels', async () => {
            const mockApiResponse: Task = createMockTask({
                id: '8485093755',
                content: 'Task with labels',
                labels: ['urgent', 'work'],
                url: 'https://todoist.com/showTask?id=8485093755',
                addedAt: new Date('2025-08-13T22:09:56.123456Z'),
            })

            createTask.mockResolvedValue(mockApiResponse)

            const result = await addTasks.execute(
                {
                    tasks: [
                        {
                            content: 'Task with labels',
                            labels: ['urgent', 'work'],
                            projectId: '6cfCcrrCFg2xP94Q',
                        },
                    ],
                },
                mockTodoistApi,
            )

            expect(createTask).toHaveBeenCalledWith({
                content: 'Task with labels',
                labels: ['urgent', 'work'],
                projectId: '6cfCcrrCFg2xP94Q',
                sectionId: undefined,
                parentId: undefined,
                autoReminder: true,
            })

            // Verify structured content includes labels
            const structuredContent = result.structuredContent
            expect(structuredContent.tasks).toHaveLength(1)
            expect(structuredContent.tasks).toEqual(
                expect.arrayContaining([expect.objectContaining({ labels: ['urgent', 'work'] })]),
            )
        })

        it('should add task with empty labels array', async () => {
            const mockApiResponse: Task = createMockTask({
                id: '8485093756',
                content: 'Task with empty labels',
                labels: [],
                url: 'https://todoist.com/showTask?id=8485093756',
                addedAt: new Date('2025-08-13T22:09:56.123456Z'),
            })

            createTask.mockResolvedValue(mockApiResponse)

            await addTasks.execute(
                {
                    tasks: [
                        {
                            content: 'Task with empty labels',
                            labels: [],
                            projectId: '6cfCcrrCFg2xP94Q',
                        },
                    ],
                },
                mockTodoistApi,
            )

            expect(createTask).toHaveBeenCalledWith({
                content: 'Task with empty labels',
                labels: [],
                projectId: '6cfCcrrCFg2xP94Q',
                sectionId: undefined,
                parentId: undefined,
                autoReminder: true,
            })
        })

        it('should add task without labels field', async () => {
            const mockApiResponse: Task = createMockTask({
                id: '8485093757',
                content: 'Task without labels',
                url: 'https://todoist.com/showTask?id=8485093757',
                addedAt: new Date('2025-08-13T22:09:56.123456Z'),
            })

            createTask.mockResolvedValue(mockApiResponse)

            await addTasks.execute(
                {
                    tasks: [
                        {
                            content: 'Task without labels',
                            projectId: '6cfCcrrCFg2xP94Q',
                        },
                    ],
                },
                mockTodoistApi,
            )

            expect(createTask).toHaveBeenCalledWith({
                content: 'Task without labels',
                labels: undefined,
                projectId: '6cfCcrrCFg2xP94Q',
                sectionId: undefined,
                parentId: undefined,
                autoReminder: true,
            })
        })

        it('should add multiple tasks with different label configurations', async () => {
            const mockApiResponse1: Task = createMockTask({
                id: '8485093758',
                content: 'Task with labels',
                labels: ['personal'],
            })
            const mockApiResponse2: Task = createMockTask({
                id: '8485093759',
                content: 'Task without labels',
            })
            const mockApiResponse3: Task = createMockTask({
                id: '8485093760',
                content: 'Task with multiple labels',
                labels: ['work', 'urgent', 'review'],
            })

            createTask
                .mockResolvedValueOnce(mockApiResponse1)
                .mockResolvedValueOnce(mockApiResponse2)
                .mockResolvedValueOnce(mockApiResponse3)

            await addTasks.execute(
                {
                    tasks: [
                        {
                            content: 'Task with labels',
                            labels: ['personal'],
                            projectId: '6cfCcrrCFg2xP94Q',
                        },
                        {
                            content: 'Task without labels',
                            projectId: '6cfCcrrCFg2xP94Q',
                        },
                        {
                            content: 'Task with multiple labels',
                            labels: ['work', 'urgent', 'review'],
                            projectId: '6cfCcrrCFg2xP94Q',
                        },
                    ],
                },
                mockTodoistApi,
            )

            expect(createTask).toHaveBeenCalledTimes(3)
        })
    })

    describe('error handling', () => {
        it('should report an invalid duration format as a failure', async () => {
            const result = await addTasks.execute(
                {
                    tasks: [
                        {
                            content: 'Task with invalid duration',
                            duration: 'invalid',
                            projectId: '6cfCcrrCFg2xP94Q',
                        },
                    ],
                },
                mockTodoistApi,
            )
            expect(result.structuredContent.tasks).toEqual([])
            expect(result.structuredContent.failures[0]?.error).toContain(
                'Task "Task with invalid duration": Invalid duration format "invalid"',
            )
        })

        it('should report a single failed task as a failure (all-fail case)', async () => {
            const apiError = new Error('API Error: Bad Request')
            createTask.mockRejectedValue(apiError)

            const result = await addTasks.execute(
                { tasks: [{ content: 'Test task', projectId: '6cfCcrrCFg2xP94Q' }] },
                mockTodoistApi,
            )
            expect(result.structuredContent.tasks).toEqual([])
            expect(result.structuredContent.failures[0]?.error).toContain(apiError.message)
        })

        it('should handle partial failures and return both successes and failures', async () => {
            const mockApiResponse: Task = createMockTask({
                id: '8485093751',
                content: 'First task content',
                url: 'https://todoist.com/showTask?id=8485093751',
                addedAt: new Date('2025-08-13T22:09:59.123456Z'),
            })

            const apiError = new Error('API Error: Second task failed')
            createTask.mockResolvedValueOnce(mockApiResponse).mockRejectedValueOnce(apiError)

            const result = await addTasks.execute(
                {
                    tasks: [
                        { content: 'First task content', projectId: '6cfCcrrCFg2xP94Q' },
                        { content: 'Second task content', projectId: '6cfCcrrCFg2xP94Q' },
                    ],
                },
                mockTodoistApi,
            )

            // Should succeed with partial results
            expect(result.structuredContent.successCount).toBe(1)
            expect(result.structuredContent.failureCount).toBe(1)
            expect(result.structuredContent.totalRequested).toBe(2)
            expect(result.structuredContent.tasks).toHaveLength(1)
            expect(result.structuredContent.tasks[0]).toEqual(
                expect.objectContaining({ id: '8485093751' }),
            )
            expect(result.structuredContent.failures).toHaveLength(1)
            expect(result.structuredContent.failures[0]).toEqual(
                expect.objectContaining({
                    item: 'Second task content',
                    error: 'API Error: Second task failed (HTTP 400, code 0)',
                }),
            )

            // Text content should reflect partial success
            expect(result.textContent).toContain('1/2 successful')
        })

        it('returns structured failures when every task in the batch fails', async () => {
            const apiError1 = new Error('API Error: First task failed')
            const apiError2 = new Error('API Error: Second task failed')
            createTask.mockRejectedValueOnce(apiError1).mockRejectedValueOnce(apiError2)

            const result = await addTasks.execute(
                {
                    tasks: [
                        { content: 'First task', projectId: '6cfCcrrCFg2xP94Q' },
                        { content: 'Second task', projectId: '6cfCcrrCFg2xP94Q' },
                    ],
                },
                mockTodoistApi,
            )

            expect(result.structuredContent.tasks).toEqual([])
            expect(result.structuredContent.successCount).toBe(0)
            expect(result.structuredContent.failureCount).toBe(2)
            expect(result.structuredContent.failures).toEqual([
                { item: 'First task', error: 'API Error: First task failed (HTTP 400, code 0)' },
                { item: 'Second task', error: 'API Error: Second task failed (HTTP 400, code 0)' },
            ])
            expect(result.textContent).toContain('0/2 successful')
        })

        it.each([502, 503, 504])(
            'retries the Sync request after a %i, since Todoist skips commands it already applied',
            async (status) => {
                vi.useFakeTimers()
                try {
                    mockTodoistApi.sync.mockRejectedValueOnce(
                        Object.assign(new Error('Gateway trouble'), { httpStatusCode: status }),
                    )
                    createTask.mockResolvedValueOnce(
                        createMockTask({ id: 'task-retry', content: 'Retry me' }),
                    )

                    const promise = addTasks.execute(
                        { tasks: [{ content: 'Retry me' }] },
                        mockTodoistApi,
                    )
                    await vi.runAllTimersAsync()
                    const result = await promise

                    expect(mockTodoistApi.sync).toHaveBeenCalledTimes(2)
                    // The retry carries the same command, so Todoist can tell it apart
                    // from a second create.
                    const [first, second] = mockTodoistApi.sync.mock.calls
                    expect(second?.[0].commands?.[0]?.uuid).toBe(first?.[0].commands?.[0]?.uuid)
                    expect(result.structuredContent.successCount).toBe(1)
                } finally {
                    vi.useRealTimers()
                }
            },
        )

        it('retries a transient 5xx failure while looking up the project', async () => {
            vi.useFakeTimers()
            try {
                mockTodoistApi.getProject.mockReset()
                mockTodoistApi.getProject
                    .mockRejectedValueOnce(
                        Object.assign(new Error('Bad Gateway'), { httpStatusCode: 502 }),
                    )
                    .mockResolvedValueOnce(createMockProject({ id: '6cfCcrrCFg2xP94Q' }))
                createTask.mockResolvedValueOnce(createMockTask({ content: 'Lookup' }))

                const promise = addTasks.execute(
                    { tasks: [{ content: 'Lookup', projectId: '6cfCcrrCFg2xP94Q' }] },
                    mockTodoistApi,
                )
                await vi.runAllTimersAsync()
                const result = await promise

                expect(mockTodoistApi.getProject).toHaveBeenCalledTimes(2)
                expect(result.structuredContent.successCount).toBe(1)
            } finally {
                vi.useRealTimers()
            }
        })

        it('should preserve the item-limit error tag when a project is full', async () => {
            // Shape thrown by the SDK when the API rejects the add with the
            // item-limit error (project at max active tasks): HTTP 403 plus
            // the raw snake_case body in responseData.
            const itemLimitError = Object.assign(new Error('HTTP 403: Forbidden'), {
                httpStatusCode: 403,
                responseData: {
                    error: 'Maximum number of items exceeded',
                    error_code: 49,
                    error_tag: 'MAX_ITEMS_LIMIT_REACHED',
                    http_code: 403,
                },
            })
            createTask.mockRejectedValue(itemLimitError)

            const result = await addTasks.execute(
                { tasks: [{ content: 'One too many', projectId: '6cfCcrrCFg2xP94Q' }] },
                mockTodoistApi,
            )
            expect(result.structuredContent.tasks).toEqual([])
            expect(result.structuredContent.failures[0]?.error).toContain(
                'Maximum number of items exceeded (HTTP 403, code 49, tag MAX_ITEMS_LIMIT_REACHED)',
            )
        })

        it('should report the item-limit error tag in partial failures', async () => {
            const mockApiResponse: Task = createMockTask({
                id: '8485093752',
                content: 'Fits in project',
            })
            const itemLimitError = Object.assign(new Error('HTTP 403: Forbidden'), {
                httpStatusCode: 403,
                responseData: {
                    error: 'Maximum number of items exceeded',
                    error_code: 49,
                    error_tag: 'MAX_ITEMS_LIMIT_REACHED',
                    http_code: 403,
                },
            })
            createTask.mockResolvedValueOnce(mockApiResponse).mockRejectedValueOnce(itemLimitError)

            const result = await addTasks.execute(
                {
                    tasks: [
                        { content: 'Fits in project', projectId: '6cfCcrrCFg2xP94Q' },
                        { content: 'One too many', projectId: '6cfCcrrCFg2xP94Q' },
                    ],
                },
                mockTodoistApi,
            )

            const failure = result.structuredContent.failures[0]
            expect(failure?.item).toBe('One too many')
            expect(failure?.error).toContain(
                'Maximum number of items exceeded (HTTP 403, code 49, tag MAX_ITEMS_LIMIT_REACHED)',
            )
            expect(failure?.error).toContain('add the task to a different project')
        })

        it('tells a free-plan user once to retry without the deadline', async () => {
            const createdTask = createMockTask({ id: '8485093754', content: 'No deadline' })
            const deadlineRejected = () =>
                createApiError({
                    status: 403,
                    error: 'Premium only feature',
                    tag: 'PREMIUM_ONLY',
                })
            createTask
                .mockResolvedValueOnce(createdTask)
                .mockRejectedValueOnce(deadlineRejected())
                .mockRejectedValueOnce(deadlineRejected())
                .mockRejectedValueOnce(deadlineRejected())

            const result = await addTasks.execute(
                {
                    tasks: [
                        { content: 'No deadline' },
                        { content: 'File taxes', deadlineDate: '2026-12-31' },
                        { content: 'Renew passport', deadlineDate: '2027-01-15' },
                        { content: 'Book flights', deadlineDate: '2027-02-01' },
                    ],
                },
                mockTodoistApi,
            )

            expect(result.structuredContent.tasks).toEqual([
                expect.objectContaining({ id: '8485093754' }),
            ])
            const [first, ...repeats] = result.structuredContent.failures
            expect(first?.item).toBe('File taxes')
            expect(first?.error).toContain('retry without `deadlineDate`')
            // The explanation is given once, however many tasks hit the same restriction.
            expect(repeats).toEqual([
                {
                    item: 'Renew passport',
                    error: 'Premium only feature (HTTP 403, code 0, tag PREMIUM_ONLY). Same cause and fix as the first PREMIUM_ONLY failure in this list.',
                },
                {
                    item: 'Book flights',
                    error: 'Premium only feature (HTTP 403, code 0, tag PREMIUM_ONLY). Same cause and fix as the first PREMIUM_ONLY failure in this list.',
                },
            ])
            expect(result.textContent).toContain('retry without `deadlineDate`')
        })

        it('returns dueString retry guidance for a partial invalid-date failure', async () => {
            const createdTask = createMockTask({ id: '8485093753', content: 'Created task' })
            const invalidDueString = Object.assign(new Error('HTTP 400: Bad Request'), {
                httpStatusCode: 400,
                responseData: { error: 'Invalid date format' },
            })
            createTask.mockResolvedValueOnce(createdTask).mockRejectedValueOnce(invalidDueString)

            const result = await addTasks.execute(
                {
                    tasks: [
                        { content: 'Created task' },
                        {
                            content: 'Lavendel abschneiden',
                            dueString: 'recurring every year on July 1',
                        },
                    ],
                },
                mockTodoistApi,
            )

            const expectedRecovery =
                'Task "Lavendel abschneiden" wasn\'t created because `dueString` could not be parsed. Use Todoist recurrence syntax, for example `every year on July 1`; don\'t prefix it with `recurring`. Change only `dueString` and retry.'
            expect(result.structuredContent.failures).toEqual([
                { item: 'Lavendel abschneiden', error: expectedRecovery },
            ])
            expect(result.textContent).toContain(expectedRecovery)
        })

        it('returns dueString retry guidance for the error Sync gives an unparseable due string', async () => {
            createTask.mockRejectedValueOnce(
                createApiError({ status: 400, error: 'Date is invalid', tag: 'INVALID_DATE' }),
            )

            const result = await addTasks.execute(
                { tasks: [{ content: 'Water plants', dueString: 'every blursday' }] },
                mockTodoistApi,
            )

            expect(result.structuredContent.failures).toEqual([
                {
                    item: 'Water plants',
                    error: 'Task "Water plants" wasn\'t created because `dueString` could not be parsed. A due string must name one specific date or recurrence, such as "tomorrow", "Friday at 3pm", "2026-12-01" or "every weekday"; a period such as "this week" is not a date. Change only `dueString` and retry.',
                },
            ])
        })

        it('returns dueString retry guidance when every task in the batch fails', async () => {
            const invalidDueString = Object.assign(new Error('HTTP 400: Bad Request'), {
                httpStatusCode: 400,
                responseData: { error: 'Invalid date format' },
            })
            createTask.mockRejectedValue(invalidDueString)

            const result = await addTasks.execute(
                {
                    tasks: [
                        {
                            content: 'Lavendel abschneiden',
                            dueString: 'recurring every year on July 1',
                        },
                        {
                            content: 'Frauenmantel abschneiden',
                            dueString: 'recurring every year on July 1',
                        },
                    ],
                },
                mockTodoistApi,
            )
            expect(result.structuredContent.tasks).toEqual([])
            // Each failure keeps the guidance for its own task.
            expect(result.structuredContent.failures.map((failure) => failure.error)).toEqual([
                expect.stringContaining(
                    'Task "Lavendel abschneiden" wasn\'t created because `dueString` could not be parsed',
                ),
                expect.stringContaining(
                    'Task "Frauenmantel abschneiden" wasn\'t created because `dueString` could not be parsed',
                ),
            ])
        })
    })

    describe('next steps logic', () => {
        it('should suggest find-tasks-by-date for today when hasToday is true', async () => {
            // Clear any leftover mocks from previous tests
            createTask.mockClear()

            const mockApiResponse: Task = createMockTask({
                id: '8485093755',
                content: 'Task due today',
                url: 'https://todoist.com/showTask?id=8485093755',
                addedAt: new Date('2025-08-13T22:09:56.123456Z'),
                due: {
                    date: TODAY,
                    isRecurring: false,
                    lang: 'en',
                    string: 'today',
                    timezone: null,
                },
            })

            createTask.mockResolvedValue(mockApiResponse)

            const result = await addTasks.execute(
                {
                    tasks: [
                        {
                            content: 'Task due today',
                            dueString: 'today',
                            projectId: '6cfCcrrCFg2xP94Q',
                        },
                    ],
                },
                mockTodoistApi,
            )

            const textContent = result.textContent
            expect(textContent).toMatchSnapshot()
        })

        it('should suggest overview tool when no hasToday context', async () => {
            // Clear any leftover mocks from previous tests
            createTask.mockClear()

            const mockApiResponse: Task = createMockTask({
                id: '8485093756',
                content: 'Regular task',
                url: 'https://todoist.com/showTask?id=8485093756',
                addedAt: new Date('2025-08-13T22:09:56.123456Z'),
            })

            createTask.mockResolvedValue(mockApiResponse)

            const result = await addTasks.execute(
                {
                    tasks: [{ content: 'Regular task', projectId: '6cfCcrrCFg2xP94Q' }],
                },
                mockTodoistApi,
            )

            const textContent = result.textContent
            expect(textContent).toMatchSnapshot()
        })
    })

    describe('tasks without project context', () => {
        it('should allow creating tasks with only content (goes to Inbox)', async () => {
            const mockApiResponse: Task = createMockTask({
                id: '8485093758',
                content: 'Simple inbox task',
                url: 'https://todoist.com/showTask?id=8485093758',
                addedAt: new Date('2025-08-13T22:09:56.123456Z'),
            })

            createTask.mockResolvedValue(mockApiResponse)

            const result = await addTasks.execute(
                {
                    tasks: [
                        {
                            content: 'Simple inbox task',
                        },
                    ],
                },
                mockTodoistApi,
            )

            expect(createTask).toHaveBeenCalledWith({
                content: 'Simple inbox task',
                labels: undefined,
                projectId: undefined,
                sectionId: undefined,
                parentId: undefined,
                autoReminder: true,
            })

            const textContent = result.textContent
            expect(textContent).toContain('Added 1 task')
            expect(textContent).toContain('Simple inbox task')
        })

        it('should prevent assignment without project context', async () => {
            const result = await addTasks.execute(
                {
                    tasks: [
                        {
                            content: 'Task with assignment but no project',
                            responsibleUser: 'user@example.com',
                        },
                    ],
                },
                mockTodoistApi,
            )
            expect(result.structuredContent.tasks).toEqual([])
            expect(result.structuredContent.failures[0]?.error).toContain(
                'Task "Task with assignment but no project": Cannot assign tasks without specifying project context. Please specify a projectId, sectionId, or parentId.',
            )
        })

        it('should resolve project from section when assigning with sectionId but no projectId', async () => {
            mockTodoistApi.getSection.mockResolvedValue(
                createMockSection({ id: TEST_IDS.SECTION_1, projectId: TEST_IDS.PROJECT_WORK }),
            )
            const validateSpy = vi
                .spyOn(assignmentValidator, 'validateTaskCreationAssignment')
                .mockResolvedValue({
                    isValid: true,
                    resolvedUser: {
                        userId: 'assignee-1',
                        displayName: 'Assignee One',
                        email: 'user@example.com',
                    },
                })
            createTask.mockResolvedValue(
                createMockTask({ id: '8485099001', content: 'Section task' }),
            )

            await addTasks.execute(
                {
                    tasks: [
                        {
                            content: 'Section task',
                            sectionId: TEST_IDS.SECTION_1,
                            responsibleUser: 'user@example.com',
                        },
                    ],
                },
                mockTodoistApi,
            )

            expect(mockTodoistApi.getSection).toHaveBeenCalledWith(TEST_IDS.SECTION_1)
            // Project for assignment validation is taken from the section, not required as input
            expect(validateSpy).toHaveBeenCalledWith(
                mockTodoistApi,
                TEST_IDS.PROJECT_WORK,
                'user@example.com',
                { lookUpProject: expect.any(Function) },
            )
            expect(createTask).toHaveBeenCalledWith(
                expect.objectContaining({
                    responsibleUid: 'assignee-1',
                    sectionId: TEST_IDS.SECTION_1,
                }),
            )
            validateSpy.mockRestore()
        })

        it('should resolve the section only once when batching tasks in the same section', async () => {
            mockTodoistApi.getSection.mockResolvedValue(
                createMockSection({ id: TEST_IDS.SECTION_1, projectId: TEST_IDS.PROJECT_WORK }),
            )
            const validateSpy = vi
                .spyOn(assignmentValidator, 'validateTaskCreationAssignment')
                .mockResolvedValue({
                    isValid: true,
                    resolvedUser: {
                        userId: 'assignee-1',
                        displayName: 'Assignee One',
                        email: 'user@example.com',
                    },
                })
            createTask.mockResolvedValue(
                createMockTask({ id: '8485099002', content: 'Section task' }),
            )

            await addTasks.execute(
                {
                    tasks: [
                        {
                            content: 'Section task 1',
                            sectionId: TEST_IDS.SECTION_1,
                            responsibleUser: 'user@example.com',
                        },
                        {
                            content: 'Section task 2',
                            sectionId: TEST_IDS.SECTION_1,
                            responsibleUser: 'user@example.com',
                        },
                    ],
                },
                mockTodoistApi,
            )

            expect(mockTodoistApi.getSection).toHaveBeenCalledTimes(1)
            validateSpy.mockRestore()
        })

        it('should report a clear failure when the section does not exist', async () => {
            mockTodoistApi.getSection.mockResolvedValue(null as unknown as never)

            const result = await addTasks.execute(
                {
                    tasks: [
                        {
                            content: 'Section task',
                            sectionId: 'missing-section',
                            responsibleUser: 'user@example.com',
                        },
                    ],
                },
                mockTodoistApi,
            )
            expect(result.structuredContent.tasks).toEqual([])
            expect(result.structuredContent.failures[0]?.error).toContain(
                'Task "Section task": Section "missing-section" not found',
            )
        })

        it('should report non-not-found errors from resolving the section', async () => {
            mockTodoistApi.getSection.mockRejectedValue(new Error('Service Unavailable'))

            const result = await addTasks.execute(
                {
                    tasks: [
                        {
                            content: 'Section task',
                            sectionId: TEST_IDS.SECTION_1,
                            responsibleUser: 'user@example.com',
                        },
                    ],
                },
                mockTodoistApi,
            )
            expect(result.structuredContent.tasks).toEqual([])
            expect(result.structuredContent.failures[0]?.error).toContain('Service Unavailable')
        })
    })

    describe('inbox project ID handling', () => {
        it('should strip "inbox" projectId and let the API default to inbox', async () => {
            const mockApiResponse: Task = createMockTask({
                id: '8485093760',
                content: 'Task for inbox',
                projectId: TEST_IDS.PROJECT_INBOX,
                url: 'https://todoist.com/showTask?id=8485093760',
                addedAt: new Date('2025-08-13T22:09:56.123456Z'),
            })

            createTask.mockResolvedValue(mockApiResponse)

            const result = await addTasks.execute(
                {
                    tasks: [
                        {
                            content: 'Task for inbox',
                            projectId: 'inbox',
                        },
                    ],
                },
                mockTodoistApi,
            )

            // Should NOT call getUser — inbox is handled by stripping projectId
            expect(mockTodoistApi.getUser).not.toHaveBeenCalled()

            // Verify the task was sent without projectId (API defaults to inbox)
            expect(createTask).toHaveBeenCalledWith({
                content: 'Task for inbox',
                projectId: undefined,
                sectionId: undefined,
                parentId: undefined,
                labels: undefined,
                autoReminder: true,
            })

            // Verify result contains the task
            const structuredContent = result.structuredContent
            expect(structuredContent.totalCount).toBe(1)
            expect(structuredContent.tasks).toEqual(
                expect.arrayContaining([expect.objectContaining({ id: '8485093760' })]),
            )
        })

        it('should not call getUser for multiple inbox tasks', async () => {
            const mockApiResponse1: Task = createMockTask({
                id: '8485093761',
                content: 'Inbox task 1',
                projectId: TEST_IDS.PROJECT_INBOX,
            })
            const mockApiResponse2: Task = createMockTask({
                id: '8485093762',
                content: 'Inbox task 2',
                projectId: TEST_IDS.PROJECT_INBOX,
            })

            createTask
                .mockResolvedValueOnce(mockApiResponse1)
                .mockResolvedValueOnce(mockApiResponse2)

            await addTasks.execute(
                {
                    tasks: [
                        { content: 'Inbox task 1', projectId: 'inbox' },
                        { content: 'Inbox task 2', projectId: 'inbox' },
                    ],
                },
                mockTodoistApi,
            )

            expect(mockTodoistApi.getUser).not.toHaveBeenCalled()
            expect(createTask).toHaveBeenCalledTimes(2)
        })
    })

    describe('isUncompletable parameter', () => {
        it('should create the task with the uncompletable "* " prefix', async () => {
            // Mock API response - minimal mock just to prevent errors
            const mockApiResponse: Task = createMockTask({
                id: '8485093999',
                content: 'Project Header',
            })

            createTask.mockResolvedValueOnce(mockApiResponse)

            await addTasks.execute(
                {
                    tasks: [
                        {
                            content: 'Project Header',
                            isUncompletable: true,
                        },
                    ],
                },
                mockTodoistApi,
            )

            // Todoist marks a task uncompletable by the "* " prefix on its content
            expect(createTask).toHaveBeenCalledWith({
                content: '* Project Header',
                projectId: undefined,
                sectionId: undefined,
                parentId: undefined,
                labels: undefined,
                autoReminder: true,
            })
        })

        it('does not add the prefix twice to content that already has it', async () => {
            createTask.mockResolvedValueOnce(createMockTask({ content: '* Already a header' }))

            await addTasks.execute(
                { tasks: [{ content: '* Already a header', isUncompletable: true }] },
                mockTodoistApi,
            )

            expect(createTask).toHaveBeenCalledWith(
                expect.objectContaining({ content: '* Already a header' }),
            )
        })
    })

    describe('order parameter', () => {
        it('should send order as the child order', async () => {
            const mockApiResponse: Task = createMockTask({
                id: '8485094000',
                content: 'Task with order',
                childOrder: 5,
            })

            createTask.mockResolvedValueOnce(mockApiResponse)

            await addTasks.execute(
                {
                    tasks: [
                        {
                            content: 'Task with order',
                            order: 5,
                            projectId: '6cfCcrrCFg2xP94Q',
                        },
                    ],
                },
                mockTodoistApi,
            )

            expect(createTask).toHaveBeenCalledWith({
                content: 'Task with order',
                projectId: '6cfCcrrCFg2xP94Q',
                sectionId: undefined,
                parentId: undefined,
                childOrder: 5,
                labels: undefined,
                autoReminder: true,
            })
        })
    })

    describe('archived project validation', () => {
        it('should report a failure when project is archived', async () => {
            mockTodoistApi.getProject.mockResolvedValue(
                createMockProject({ isArchived: true, name: 'Archived Project' }),
            )

            const result = await addTasks.execute(
                {
                    tasks: [
                        {
                            content: 'Task in archived project',
                            projectId: '6cfCcrrCFg2xP94Q',
                        },
                    ],
                },
                mockTodoistApi,
            )
            expect(result.structuredContent.tasks).toEqual([])
            expect(result.structuredContent.failures[0]?.error).toContain(
                'Task "Task in archived project": Cannot create task in archived project "Archived Project"',
            )

            expect(createTask).not.toHaveBeenCalled()
        })

        it('should not check project when projectId is omitted', async () => {
            const mockApiResponse: Task = createMockTask({
                id: '8485094001',
                content: 'Inbox task',
            })
            createTask.mockResolvedValue(mockApiResponse)

            await addTasks.execute({ tasks: [{ content: 'Inbox task' }] }, mockTodoistApi)

            expect(mockTodoistApi.getProject).not.toHaveBeenCalled()
            expect(createTask).toHaveBeenCalled()
        })

        it('should report the error when project is deleted (not found)', async () => {
            mockTodoistApi.getProject.mockRejectedValue(new Error('Project not found'))

            const result = await addTasks.execute(
                {
                    tasks: [
                        {
                            content: 'Task in deleted project',
                            projectId: 'deleted-project-id',
                        },
                    ],
                },
                mockTodoistApi,
            )
            expect(result.structuredContent.tasks).toEqual([])
            expect(result.structuredContent.failures[0]?.error).toContain('Project not found')

            expect(createTask).not.toHaveBeenCalled()
        })

        it('should explain when the project is a workspace project the user has not joined', async () => {
            const expected = mockUnjoinedWorkspaceProject(mockTodoistApi)

            const result = await addTasks.execute(
                { tasks: [{ content: 'Follow up', projectId: 'unjoined-project-id' }] },
                mockTodoistApi,
            )

            expect(result.structuredContent.failures).toEqual([
                { item: 'Follow up', error: expected },
            ])
            expect(createTask).not.toHaveBeenCalled()
        })

        it('should scan workspace projects once per batch, however many projects need explaining', async () => {
            mockUnjoinedWorkspaceProject(mockTodoistApi)

            const result = await addTasks.execute(
                {
                    tasks: [
                        { content: 'Follow up', projectId: 'unjoined-project-id' },
                        { content: 'Send notes', projectId: 'missing-project-id' },
                    ],
                },
                mockTodoistApi,
            )

            expect(result.structuredContent.failures.map((failure) => failure.error)).toEqual([
                expect.stringContaining(
                    '("Sales Pipeline") is a workspace project the user hasn\'t joined',
                ),
                expect.stringContaining('Project missing-project-id was not found.'),
            ])
            expect(mockTodoistApi.getProject).toHaveBeenCalledTimes(2)
            expect(mockTodoistApi.getWorkspaces).toHaveBeenCalledTimes(1)
        })

        it('should look each project up once per batch', async () => {
            mockUnjoinedWorkspaceProject(mockTodoistApi)

            const result = await addTasks.execute(
                {
                    tasks: [
                        { content: 'Follow up', projectId: 'unjoined-project-id' },
                        { content: 'Send notes', projectId: 'unjoined-project-id' },
                    ],
                },
                mockTodoistApi,
            )

            expect(result.structuredContent.failures).toHaveLength(2)
            expect(mockTodoistApi.getProject).toHaveBeenCalledTimes(1)
            expect(mockTodoistApi.getWorkspaces).toHaveBeenCalledTimes(1)
        })

        it('should allow task creation in active project', async () => {
            mockTodoistApi.getProject.mockResolvedValue(createMockProject({ isArchived: false }))
            const mockApiResponse: Task = createMockTask({
                id: '8485094002',
                content: 'Task in active project',
            })
            createTask.mockResolvedValue(mockApiResponse)

            const result = await addTasks.execute(
                {
                    tasks: [
                        {
                            content: 'Task in active project',
                            projectId: '6cfCcrrCFg2xP94Q',
                        },
                    ],
                },
                mockTodoistApi,
            )

            expect(mockTodoistApi.getProject).toHaveBeenCalledWith('6cfCcrrCFg2xP94Q')
            expect(createTask).toHaveBeenCalled()
            expect(result.structuredContent.totalCount).toBe(1)
        })
    })

    describe('empty string sanitization', () => {
        it('should strip empty strings from optional fields before calling the API', async () => {
            const mockApiResponse: Task = createMockTask({
                id: '8485094010',
                content: 'Test',
            })

            createTask.mockResolvedValue(mockApiResponse)

            // This is the exact input shape LLMs often send — empty strings for all optional fields
            const result = await addTasks.execute(
                {
                    tasks: [
                        {
                            content: 'Test',
                            description: '',
                            priority: 'p4',
                            dueString: '',
                            deadlineDate: '',
                            duration: '',
                            labels: [],
                            projectId: '',
                            sectionId: '',
                            parentId: '',
                            order: 0,
                            responsibleUser: '',
                            isUncompletable: false,
                        },
                    ],
                },
                mockTodoistApi,
            )

            // Empty strings should be stripped to undefined, not passed to the API
            // priority 'p4' is valid (not empty) so it gets converted to numeric 1
            expect(createTask).toHaveBeenCalledWith({
                content: 'Test',
                description: undefined,
                priority: convertPriorityToNumber('p4'),
                due: undefined,
                deadline: undefined,
                labels: [],
                projectId: undefined,
                sectionId: undefined,
                parentId: undefined,
                childOrder: 0,
                autoReminder: true,
            })

            expect(result.structuredContent.successCount).toBe(1)
        })
    })

    describe('one Sync request per batch', () => {
        it('creates the whole batch in one request, in input order, and reads it back once', async () => {
            createTask.mockImplementation(async (args) =>
                createMockTask({ id: `id-${args.content}`, content: args.content }),
            )

            const result = await addTasks.execute(
                {
                    tasks: [
                        { content: 'Plan', projectId: '6cfCcrrCFg2xP94Q', dueString: 'tomorrow' },
                        { content: 'Draft', sectionId: TEST_IDS.SECTION_1 },
                        { content: 'Ship', parentId: TEST_IDS.TASK_1 },
                    ],
                },
                mockTodoistApi,
            )

            expect(mockTodoistApi.sync).toHaveBeenCalledOnce()
            expect(sentSyncCommands(mockTodoistApi)).toEqual([
                expect.objectContaining({
                    type: 'item_add',
                    args: expect.objectContaining({
                        content: 'Plan',
                        due: { string: 'tomorrow' },
                    }),
                }),
                expect.objectContaining({ args: expect.objectContaining({ content: 'Draft' }) }),
                expect.objectContaining({ args: expect.objectContaining({ content: 'Ship' }) }),
            ])
            expect(mockTodoistApi.getTasks).toHaveBeenCalledOnce()
            expect(mockTodoistApi.getTasks).toHaveBeenCalledWith({
                ids: ['id-Plan', 'id-Draft', 'id-Ship'],
                limit: 3,
            })
            expect(result.structuredContent.tasks.map((task) => task.id)).toEqual([
                'id-Plan',
                'id-Draft',
                'id-Ship',
            ])
        })

        it('leaves a task that fails its checks out of the request', async () => {
            createTask.mockImplementation(async (args) =>
                createMockTask({ id: `id-${args.content}`, content: args.content }),
            )

            const result = await addTasks.execute(
                {
                    tasks: [
                        { content: 'First' },
                        { content: 'Bad duration', duration: 'whenever' },
                        { content: 'Third' },
                    ],
                },
                mockTodoistApi,
            )

            expect(sentSyncCommands(mockTodoistApi).map((command) => command.args)).toEqual([
                expect.objectContaining({ content: 'First' }),
                expect.objectContaining({ content: 'Third' }),
            ])
            expect(result.structuredContent.tasks.map((task) => task.content)).toEqual([
                'First',
                'Third',
            ])
            expect(result.structuredContent.failures).toEqual([
                {
                    item: 'Bad duration',
                    error: expect.stringContaining('Invalid duration format "whenever"'),
                },
            ])
        })

        it('sends nothing when every task fails its checks', async () => {
            const result = await addTasks.execute(
                { tasks: [{ content: 'Bad duration', duration: 'whenever' }] },
                mockTodoistApi,
            )

            expect(mockTodoistApi.sync).not.toHaveBeenCalled()
            expect(result.structuredContent.failureCount).toBe(1)
        })

        it('says a task was created when it cannot be read back, so it is not created again', async () => {
            const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
            try {
                createTask.mockResolvedValueOnce(
                    createMockTask({ id: 'created-1', content: 'Plan' }),
                )
                mockTodoistApi.getTasks.mockRejectedValue(
                    createApiError({ status: 403, error: 'Forbidden' }),
                )

                const result = await addTasks.execute(
                    { tasks: [{ content: 'Plan' }] },
                    mockTodoistApi,
                )

                expect(result.structuredContent.tasks).toEqual([])
                expect(result.structuredContent.failures).toEqual([
                    {
                        item: 'Plan',
                        error: 'Created as id=created-1, but reading it back failed. Do not create it again.',
                    },
                ])
                // The reason stays out of the per-task message but must reach the logs.
                expect(consoleErrorSpy).toHaveBeenCalledWith('add-tasks: read-back failed', {
                    created: 1,
                    error: expect.stringContaining('HTTP 403'),
                })
            } finally {
                consoleErrorSpy.mockRestore()
            }
        })

        it('does not blame the due string when the request itself is refused', async () => {
            // A request-level error reaches every task, so its date tag says nothing
            // about any one task's due string.
            mockTodoistApi.sync.mockRejectedValueOnce(
                createApiError({ status: 400, error: 'Date is invalid', tag: 'INVALID_DATE' }),
            )

            const result = await addTasks.execute(
                { tasks: [{ content: 'Water plants', dueString: 'every monday' }] },
                mockTodoistApi,
            )

            // The tag's general explanation, not the "`dueString` could not be parsed" verdict.
            expect(result.structuredContent.failures).toEqual([
                {
                    item: 'Water plants',
                    error: 'Date is invalid (HTTP 400, tag INVALID_DATE). Todoist could not parse a date in this request. A due string must name one specific date or recurrence, such as "tomorrow", "Friday at 3pm", "2026-12-01" or "every weekday"; a period such as "this week" is not a date. Where a field asks for YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS, send exactly that, not words such as "today". Change only the date and retry.',
                },
            ])
        })

        it('reports every task when the request itself is refused', async () => {
            mockTodoistApi.sync.mockRejectedValueOnce(
                createApiError({ status: 400, error: 'Bad Request' }),
            )

            const result = await addTasks.execute(
                { tasks: [{ content: 'Plan' }, { content: 'Draft' }] },
                mockTodoistApi,
            )

            expect(mockTodoistApi.sync).toHaveBeenCalledOnce()
            expect(result.structuredContent.failures).toEqual([
                { item: 'Plan', error: 'Todoist API request failed (HTTP 400)' },
                { item: 'Draft', error: 'Todoist API request failed (HTTP 400)' },
            ])
        })

        it('checks each assignee once per project for a batch', async () => {
            const validateSpy = vi
                .spyOn(assignmentValidator, 'validateTaskCreationAssignment')
                .mockResolvedValue({
                    isValid: true,
                    resolvedUser: { userId: 'me-id', displayName: 'Me', email: 'me@example.com' },
                })
            try {
                createTask.mockImplementation(async (args) =>
                    createMockTask({ id: `id-${args.content}`, content: args.content }),
                )

                const result = await addTasks.execute(
                    {
                        tasks: ['One', 'Two', 'Three'].map((content) => ({
                            content,
                            projectId: TEST_IDS.PROJECT_WORK,
                            responsibleUser: 'me',
                        })),
                    },
                    mockTodoistApi,
                )

                expect(result.structuredContent.successCount).toBe(3)
                expect(validateSpy).toHaveBeenCalledOnce()
                expect(sentSyncCommands(mockTodoistApi).map((command) => command.args)).toEqual(
                    Array(3).fill(expect.objectContaining({ responsibleUid: 'me-id' })),
                )
            } finally {
                validateSpy.mockRestore()
            }
        })

        it('reads a shared parent once for a batch of assigned subtasks', async () => {
            const validateSpy = vi
                .spyOn(assignmentValidator, 'validateTaskCreationAssignment')
                .mockResolvedValue({
                    isValid: true,
                    resolvedUser: { userId: 'ada', displayName: 'Ada', email: 'ada@example.com' },
                })
            try {
                mockTodoistApi.getTask.mockResolvedValue(
                    createMockTask({ id: TEST_IDS.TASK_1, projectId: TEST_IDS.PROJECT_WORK }),
                )
                createTask.mockImplementation(async (args) =>
                    createMockTask({ id: `id-${args.content}`, content: args.content }),
                )

                await addTasks.execute(
                    {
                        tasks: ['One', 'Two', 'Three'].map((content) => ({
                            content,
                            parentId: TEST_IDS.TASK_1,
                            responsibleUser: 'ada@example.com',
                        })),
                    },
                    mockTodoistApi,
                )

                expect(mockTodoistApi.getTask).toHaveBeenCalledOnce()
            } finally {
                validateSpy.mockRestore()
            }
        })

        it('reports a task Todoist applied but returned no ID for, so it is checked before a retry', async () => {
            mockTodoistApi.sync.mockImplementation(async ({ commands = [] }) => ({
                syncStatus: allApplied(commands),
                tempIdMapping: {},
            }))

            const result = await addTasks.execute({ tasks: [{ content: 'Plan' }] }, mockTodoistApi)

            expect(mockTodoistApi.getTasks).not.toHaveBeenCalled()
            expect(result.structuredContent.failures).toEqual([
                {
                    item: 'Plan',
                    error: 'Todoist reported the task as created but did not return its ID. Check before creating it again.',
                },
            ])
        })

        it('reads each project once for a batch of assigned tasks', async () => {
            userResolver.clearCache()
            const sharedProject = createMockProject({ id: TEST_IDS.PROJECT_WORK, isShared: true })
            const assignee = { id: 'user-ada', name: 'Ada Lovelace', email: 'ada@example.com' }
            mockTodoistApi.getProject.mockResolvedValue(sharedProject)
            mockTodoistApi.getUser.mockResolvedValue(createMockUser())
            mockTodoistApi.getProjects.mockResolvedValue({
                results: [sharedProject],
                nextCursor: null,
            })
            mockTodoistApi.getProjectCollaborators.mockResolvedValue({
                results: [assignee],
                nextCursor: null,
            })
            createTask.mockImplementation(async (args) =>
                createMockTask({ id: `id-${args.content}`, content: args.content }),
            )

            const result = await addTasks.execute(
                {
                    tasks: ['One', 'Two', 'Three'].map((content) => ({
                        content,
                        projectId: TEST_IDS.PROJECT_WORK,
                        responsibleUser: 'ada@example.com',
                    })),
                },
                mockTodoistApi,
            )

            expect(result.structuredContent.successCount).toBe(3)
            expect(sentSyncCommands(mockTodoistApi).map((command) => command.args)).toEqual(
                Array(3).fill(expect.objectContaining({ responsibleUid: 'user-ada' })),
            )
            expect(mockTodoistApi.getProject).toHaveBeenCalledOnce()
        })
    })

    describe('batch limits', () => {
        it('should export MAX_TASKS_PER_OPERATION constant', () => {
            expect(MAX_TASKS_PER_OPERATION).toBe(100)
        })

        it('accepts 100 tasks in one call and sends them in one request', async () => {
            createTask.mockImplementation(async (args) =>
                createMockTask({ id: `id-${args.content}`, content: args.content }),
            )
            const tasks = Array.from({ length: 100 }, (_, index) => ({ content: `Task ${index}` }))

            const result = await addTasks.execute({ tasks }, mockTodoistApi)

            expect(mockTodoistApi.sync).toHaveBeenCalledOnce()
            expect(result.structuredContent.successCount).toBe(100)
        })

        it('rejects a call with more than 100 tasks', () => {
            const tasks = Array.from({ length: 101 }, (_, index) => ({ content: `Task ${index}` }))

            expect(z.object(addTasks.parameters).safeParse({ tasks }).success).toBe(false)
        })
    })
})
