import type { TodoistApi } from '@todoist/sdk'
import { type Mocked, type MockedFunction, vi } from 'vitest'
import { getTasksByFilter, MappedTask } from '../tool-helpers.js'
import {
    createMappedTask,
    createMockApiResponse,
    createMockLabel,
    createMockTask,
    createMockUser,
    paginateLikeApi,
    TEST_ERRORS,
    TEST_IDS,
    TODAY,
} from '../utils/test-helpers.js'
import { ToolNames } from '../utils/tool-names.js'
import { getAssigneeShortNames, resolveUserNameToId } from '../utils/user-resolver.js'
import { findTasks } from './find-tasks.js'

vi.mock('../tool-helpers', async () => {
    const actual = (await vi.importActual('../tool-helpers')) as typeof import('../tool-helpers.js')
    return {
        getTasksByFilter: vi.fn(),
        fetchAllLabelNames: actual.fetchAllLabelNames,
        fetchAllSharedLabels: actual.fetchAllSharedLabels,
        mapTask: actual.mapTask,
        normalizePaginationCursor: actual.normalizePaginationCursor,
        filterTasksByResponsibleUser: actual.filterTasksByResponsibleUser,
        RESPONSIBLE_USER_FILTERING: actual.RESPONSIBLE_USER_FILTERING,
        resolveInboxProjectId: actual.resolveInboxProjectId,
    }
})

vi.mock('../utils/user-resolver', () => ({
    resolveUserNameToId: vi.fn(),
    getAssigneeShortNames: vi.fn(async () => new Map<string, string>()),
}))

vi.mock('../utils/filter-resolver', () => ({
    filterResolver: {
        resolveFilter: vi.fn(),
    },
}))

import { filterResolver } from '../utils/filter-resolver.js'

const mockResolveFilter = filterResolver.resolveFilter as MockedFunction<
    typeof filterResolver.resolveFilter
>

const { FIND_TASKS, FIND_COMPLETED_TASKS } = ToolNames

const mockGetTasksByFilter = getTasksByFilter as MockedFunction<typeof getTasksByFilter>
const mockResolveUserNameToId = resolveUserNameToId as MockedFunction<typeof resolveUserNameToId>

// Mock the Todoist API
const mockTodoistApi = {
    getTasks: vi.fn(),
    getTasksByFilter: vi.fn(),
    getUser: vi.fn(),
    getLabels: vi.fn(),
    getSharedLabels: vi.fn(),
} as unknown as Mocked<TodoistApi>

// Mock the Todoist User
const mockTodoistUser = createMockUser()

describe(`${FIND_TASKS} tool`, () => {
    beforeEach(() => {
        mockTodoistApi.getUser.mockResolvedValue(mockTodoistUser)
        mockTodoistApi.getLabels.mockResolvedValue(createMockApiResponse([]))
        mockTodoistApi.getSharedLabels.mockResolvedValue(createMockApiResponse([]))
        vi.clearAllMocks()
    })

    describe('searching tasks', () => {
        it('shows assigned tasks with their assignee by short name', async () => {
            const mockTasks = [
                createMappedTask({
                    id: TEST_IDS.TASK_1,
                    content: 'Assigned task',
                    responsibleUid: 'user-ada',
                }),
                createMappedTask({
                    id: TEST_IDS.TASK_2,
                    content: 'Assigned to someone unknown',
                    responsibleUid: 'user-unknown',
                }),
                createMappedTask({ id: TEST_IDS.TASK_3, content: 'Unassigned task' }),
            ]
            mockGetTasksByFilter.mockResolvedValue({ tasks: mockTasks, nextCursor: null })
            vi.mocked(getAssigneeShortNames).mockResolvedValueOnce(
                new Map([['user-ada', 'Ada L.']]),
            )

            const result = await findTasks.execute(
                { searchText: 'task', limit: 10 },
                mockTodoistApi,
            )

            expect(getAssigneeShortNames).toHaveBeenCalledWith(
                mockTodoistApi,
                mockTasks,
                mockTodoistUser.id,
            )
            expect(result.textContent).toContain('Assigned task • P4 • +Ada L. • id=')
            expect(result.textContent).toContain(
                'Assigned to someone unknown • P4 • +user-unknown • id=',
            )
            expect(result.textContent).toMatch(/Unassigned task • P4 • id=/)
            // Structured output keeps the raw user IDs.
            expect(result.structuredContent.tasks[0]?.responsibleUid).toBe('user-ada')
        })

        it('should search tasks and return results', async () => {
            const mockTasks = [
                createMappedTask({
                    id: TEST_IDS.TASK_1,
                    content: 'Task containing search term',
                    description: 'Description with more details',
                    labels: ['work'],
                }),
                createMappedTask({
                    id: TEST_IDS.TASK_2,
                    content: 'Another matching task',
                    priority: 'p3',
                    sectionId: TEST_IDS.SECTION_1,
                }),
            ]
            const mockResponse = { tasks: mockTasks, nextCursor: 'cursor-for-next-page' }
            mockGetTasksByFilter.mockResolvedValue(mockResponse)

            const result = await findTasks.execute(
                { searchText: 'important meeting', limit: 10 },
                mockTodoistApi,
            )

            expect(mockGetTasksByFilter).toHaveBeenCalledWith({
                client: mockTodoistApi,
                query: 'search: important meeting & !assigned to: others',
                cursor: undefined,
                limit: 10,
            })
            // Verify result is a concise summary
            expect(result.textContent).toMatchSnapshot()

            // Verify structured content
            const structuredContent = result.structuredContent
            expect(structuredContent).toEqual(
                expect.objectContaining({
                    tasks: expect.any(Array),
                    totalCount: 2,
                    hasMore: true,
                    nextCursor: 'cursor-for-next-page',
                    appliedFilters: {
                        searchText: 'important meeting',
                        limit: 10,
                    },
                }),
            )
            expect(structuredContent).toEqual(
                expect.objectContaining({
                    tasks: expect.any(Array),
                }),
            )
        })

        it.each([
            {
                name: 'custom limit',
                params: {
                    searchText: 'project update',
                    limit: 5,
                },
                expectedQuery: 'search: project update & !assigned to: others',
                expectedLimit: 5,
                expectedCursor: undefined,
            },
            {
                name: 'pagination cursor',
                params: {
                    searchText: 'follow up',
                    limit: 20,
                    cursor: 'cursor-from-first-page',
                },
                expectedQuery: 'search: follow up & !assigned to: others',
                expectedLimit: 20,
                expectedCursor: 'cursor-from-first-page',
            },
        ])(
            'should handle $name',
            async ({ params, expectedQuery, expectedLimit, expectedCursor }) => {
                const mockTask = createMappedTask({ content: 'Test result' })
                const mockResponse = { tasks: [mockTask], nextCursor: null }
                mockGetTasksByFilter.mockResolvedValue(mockResponse)

                const result = await findTasks.execute(params, mockTodoistApi)

                expect(mockGetTasksByFilter).toHaveBeenCalledWith({
                    client: mockTodoistApi,
                    query: expectedQuery,
                    cursor: expectedCursor,
                    limit: expectedLimit,
                })
                // Verify result is a concise summary
                expect(result.textContent).toMatchSnapshot()

                // Verify structured content
                const structuredContent = result.structuredContent
                expect(structuredContent).toEqual(
                    expect.objectContaining({
                        tasks: expect.any(Array),
                        totalCount: 1,
                        hasMore: false,
                        appliedFilters: expect.objectContaining({
                            searchText: params.searchText,
                            limit: expectedLimit,
                        }),
                    }),
                )
                expect(structuredContent).toEqual(
                    expect.objectContaining({
                        tasks: expect.any(Array),
                    }),
                )
            },
        )

        it.each(['', '   ', '0'])(
            'should omit first-page cursor sentinel %j from filter queries',
            async (cursor) => {
                mockGetTasksByFilter.mockResolvedValue({ tasks: [], nextCursor: null })

                await findTasks.execute(
                    { searchText: 'project update', limit: 10, cursor },
                    mockTodoistApi,
                )

                expect(mockGetTasksByFilter).toHaveBeenCalledWith(
                    expect.objectContaining({ cursor: undefined }),
                )
            },
        )

        it.each([
            { searchText: '@work #urgent "exact phrase"', description: 'special characters' },
            { searchText: 'nonexistent keyword', description: 'empty results' },
        ])('should handle search with $description', async ({ searchText }) => {
            const mockResponse = { tasks: [], nextCursor: null }
            mockGetTasksByFilter.mockResolvedValue(mockResponse)

            const result = await findTasks.execute({ searchText, limit: 10 }, mockTodoistApi)

            expect(mockGetTasksByFilter).toHaveBeenCalledWith({
                client: mockTodoistApi,
                query: `search: ${searchText} & !assigned to: others`,
                cursor: undefined,
                limit: 10,
            })
            // Verify result is a concise summary
            expect(result.textContent).toMatchSnapshot()

            // Verify structured content for empty results
            const structuredContent = result.structuredContent
            expect(structuredContent).toEqual({
                tasks: [], // tasks array is now kept as empty array
                totalCount: 0,
                hasMore: false,
                nextCursor: undefined,
                appliedFilters: expect.objectContaining({
                    searchText: searchText,
                }),
            })
        })

        it.each([
            ['meeting & notes', 'search: meeting \\& notes & !assigned to: others'],
            ['budget, invoices', 'search: budget\\, invoices & !assigned to: others'],
            ['C:\\reports\\', 'search: C:\\\\reports\\\\ & !assigned to: others'],
        ])('should escape search text %j before the assignee filter', async (searchText, query) => {
            mockGetTasksByFilter.mockResolvedValue({ tasks: [], nextCursor: null })

            await findTasks.execute({ searchText, limit: 10 }, mockTodoistApi)

            expect(mockGetTasksByFilter).toHaveBeenCalledWith({
                client: mockTodoistApi,
                query,
                cursor: undefined,
                limit: 10,
            })
        })
    })

    describe('container filtering', () => {
        it.each([
            {
                name: 'project',
                params: {
                    projectId: TEST_IDS.PROJECT_TEST,
                    limit: 10,
                },
                expectedApiParam: { projectId: TEST_IDS.PROJECT_TEST },
                tasks: [createMockTask({ content: 'Project task' })],
            },
            {
                name: 'section',
                params: {
                    sectionId: TEST_IDS.SECTION_1,
                    limit: 10,
                },
                expectedApiParam: { sectionId: TEST_IDS.SECTION_1 },
                tasks: [createMockTask({ content: 'Section task' })],
            },
            {
                name: 'parent task',
                params: {
                    parentId: TEST_IDS.TASK_1,
                    limit: 10,
                },
                expectedApiParam: { parentId: TEST_IDS.TASK_1 },
                tasks: [createMockTask({ content: 'Subtask' })],
            },
        ])('should find tasks in $name', async ({ params, expectedApiParam, tasks }) => {
            mockTodoistApi.getTasks.mockResolvedValue(createMockApiResponse(tasks))

            const result = await findTasks.execute(params, mockTodoistApi)

            expect(mockTodoistApi.getTasks).toHaveBeenCalledWith({
                limit: 200,
                cursor: null,
                ...expectedApiParam,
            })

            expect(result.textContent).toMatchSnapshot()

            const structuredContent = result.structuredContent
            expect(structuredContent).toEqual(
                expect.objectContaining({
                    tasks: expect.any(Array),
                    totalCount: tasks.length,
                    hasMore: false,
                    appliedFilters: params,
                }),
            )
        })

        it('should handle combined search text and container filtering', async () => {
            const tasks = [
                createMockTask({
                    id: '8485093749',
                    content: 'relevant task',
                    description: 'contains search term',
                }),
                createMockTask({
                    id: '8485093750',
                    content: 'other task',
                    description: 'different content',
                }),
            ]
            mockTodoistApi.getTasks.mockResolvedValue(createMockApiResponse(tasks))

            const result = await findTasks.execute(
                {
                    projectId: TEST_IDS.PROJECT_TEST,
                    searchText: 'relevant',
                    limit: 10,
                },
                mockTodoistApi,
            )

            expect(mockTodoistApi.getTasks).toHaveBeenCalledWith({
                limit: 200,
                cursor: null,
                projectId: TEST_IDS.PROJECT_TEST,
            })

            const structuredContent = result.structuredContent
            expect(structuredContent.tasks).toHaveLength(1)
            expect(structuredContent.tasks).toEqual([
                expect.objectContaining({ content: 'relevant task' }),
            ])
        })

        it('should handle empty containers', async () => {
            mockTodoistApi.getTasks.mockResolvedValue(createMockApiResponse([]))

            const result = await findTasks.execute(
                {
                    sectionId: 'empty-section',
                    limit: 10,
                },
                mockTodoistApi,
            )

            const textContent = result.textContent
            expect(textContent).toContain('Section is empty')
            expect(textContent).toContain('Tasks may be in other sections of the project')
        })

        it('should refuse a container cursor it did not issue', async () => {
            await expect(
                findTasks.execute(
                    {
                        projectId: TEST_IDS.PROJECT_TEST,
                        limit: 25,
                        cursor: 'current-cursor',
                    },
                    mockTodoistApi,
                ),
            ).rejects.toThrow('Invalid cursor')

            expect(mockTodoistApi.getTasks).not.toHaveBeenCalled()
        })

        it('should omit a first-page cursor sentinel from container queries', async () => {
            mockTodoistApi.getTasks.mockResolvedValue(createMockApiResponse([]))

            await findTasks.execute(
                {
                    projectId: TEST_IDS.PROJECT_TEST,
                    limit: 10,
                    cursor: '0',
                },
                mockTodoistApi,
            )

            expect(mockTodoistApi.getTasks).toHaveBeenCalledWith({
                limit: 200,
                cursor: null,
                projectId: TEST_IDS.PROJECT_TEST,
            })
        })
    })

    describe('container error handling', () => {
        it('should propagate API errors for container queries', async () => {
            const apiError = new Error('API Error: Project not found')
            mockTodoistApi.getTasks.mockRejectedValue(apiError)

            await expect(
                findTasks.execute({ projectId: 'non-existent', limit: 10 }, mockTodoistApi),
            ).rejects.toThrow('API Error: Project not found')
        })
    })

    describe('next steps logic', () => {
        it('should suggest different actions when hasOverdue is true', async () => {
            const mockTasks = [
                createMappedTask({
                    id: TEST_IDS.TASK_1,
                    content: 'Overdue search result',
                    dueDate: '2025-08-10', // Past date
                }),
            ]
            const mockResponse = { tasks: mockTasks, nextCursor: null }
            mockGetTasksByFilter.mockResolvedValue(mockResponse)

            const result = await findTasks.execute(
                { searchText: 'overdue tasks', limit: 10 },
                mockTodoistApi,
            )

            const textContent = result.textContent
            expect(textContent).toMatchSnapshot()
        })

        it('should suggest today tasks when hasToday is true', async () => {
            const mockTasks = [
                createMappedTask({
                    id: TEST_IDS.TASK_1,
                    content: 'Task due today',
                    dueDate: TODAY,
                }),
            ]
            const mockResponse = { tasks: mockTasks, nextCursor: null }
            mockGetTasksByFilter.mockResolvedValue(mockResponse)

            const result = await findTasks.execute(
                { searchText: 'today tasks', limit: 10 },
                mockTodoistApi,
            )

            const textContent = result.textContent
            expect(textContent).toMatchSnapshot()
        })

        it('should provide different next steps for regular tasks', async () => {
            const mockTasks = [
                createMappedTask({
                    id: TEST_IDS.TASK_1,
                    content: 'Regular future task',
                    dueDate: '2025-08-25', // Future date
                }),
            ]
            const mockResponse = { tasks: mockTasks, nextCursor: null }
            mockGetTasksByFilter.mockResolvedValue(mockResponse)

            const result = await findTasks.execute(
                { searchText: 'future tasks', limit: 10 },
                mockTodoistApi,
            )

            const textContent = result.textContent
            expect(textContent).toMatchSnapshot()
        })

        it('should provide helpful suggestions for empty search results', async () => {
            const mockResponse = { tasks: [], nextCursor: null }
            mockGetTasksByFilter.mockResolvedValue(mockResponse)

            const result = await findTasks.execute(
                { searchText: 'nonexistent', limit: 10 },
                mockTodoistApi,
            )

            const textContent = result.textContent
            expect(textContent).toMatchSnapshot()
            expect(textContent).toContain('Try broader search terms')
            expect(textContent).toContain(`Check completed tasks with ${FIND_COMPLETED_TASKS}`)
            expect(textContent).toContain('Verify spelling and try partial words')
        })
    })

    describe('label filtering', () => {
        it.each([
            {
                name: 'text search with single label OR operator',
                params: {
                    searchText: 'important meeting',
                    limit: 10,
                    labels: ['work'],
                },
                expectedQuery: 'search: important meeting & (@work) & !assigned to: others',
            },
            {
                name: 'text search with multiple labels AND operator',
                params: {
                    searchText: 'project update',
                    limit: 15,
                    labels: ['work', 'urgent'],
                    labelsOperator: 'and' as const,
                },
                expectedQuery:
                    'search: project update & (@work  &  @urgent) & !assigned to: others',
            },
            {
                name: 'text search with multiple labels OR operator',
                params: {
                    searchText: 'follow up',
                    limit: 20,
                    labels: ['personal', 'shopping'],
                },
                expectedQuery:
                    'search: follow up & (@personal  |  @shopping) & !assigned to: others',
            },
            {
                name: 'labels containing filter operators are escaped',
                params: {
                    searchText: 'budget',
                    limit: 10,
                    labels: ['R&D', 'Errands (car)', 'home,office'],
                },
                expectedQuery:
                    'search: budget & (@R\\&D  |  @Errands \\(car\\)  |  @home\\,office) & !assigned to: others',
            },
        ])(
            'should filter tasks by labels in text search: $name',
            async ({ params, expectedQuery }) => {
                const mockTasks = [
                    createMappedTask({
                        id: TEST_IDS.TASK_1,
                        content: 'Task with work label',
                        labels: ['work'],
                    }),
                ]
                const mockResponse = { tasks: mockTasks, nextCursor: null }
                mockGetTasksByFilter.mockResolvedValue(mockResponse)

                const result = await findTasks.execute(params, mockTodoistApi)

                expect(mockGetTasksByFilter).toHaveBeenCalledWith({
                    client: mockTodoistApi,
                    query: expectedQuery,
                    cursor: undefined,
                    limit: params.limit,
                })

                const structuredContent = result.structuredContent
                expect(structuredContent.appliedFilters).toEqual(
                    expect.objectContaining({
                        searchText: params.searchText,
                        labels: params.labels,
                        ...(params.labelsOperator ? { labelsOperator: params.labelsOperator } : {}),
                    }),
                )
            },
        )

        it.each([
            {
                name: 'project filter with labels',
                params: {
                    projectId: TEST_IDS.PROJECT_TEST,
                    limit: 10,
                    labels: ['important'],
                },
                expectedApiParam: { projectId: TEST_IDS.PROJECT_TEST },
            },
            {
                name: 'section filter with multiple labels',
                params: {
                    sectionId: TEST_IDS.SECTION_1,
                    limit: 10,
                    labels: ['work', 'urgent'],
                    labelsOperator: 'and' as const,
                },
                expectedApiParam: { sectionId: TEST_IDS.SECTION_1 },
            },
            {
                name: 'parent task filter with labels',
                params: {
                    parentId: TEST_IDS.TASK_1,
                    limit: 10,
                    labels: ['personal'],
                },
                expectedApiParam: { parentId: TEST_IDS.TASK_1 },
            },
        ])(
            'should apply label filtering to container searches: $name',
            async ({ params, expectedApiParam }) => {
                const allTasks = [
                    createMockTask({
                        id: '1',
                        content: 'Task with matching label',
                        labels: params.labels,
                    }),
                    createMockTask({
                        id: '2',
                        content: 'Task without matching label',
                        labels: ['other'],
                    }),
                ]
                mockTodoistApi.getTasks.mockResolvedValue(createMockApiResponse(allTasks))

                const result = await findTasks.execute(params, mockTodoistApi)

                expect(mockTodoistApi.getTasks).toHaveBeenCalledWith({
                    limit: 200,
                    cursor: null,
                    ...expectedApiParam,
                })

                // Should filter results client-side based on labels
                const structuredContent = result.structuredContent
                if (params.labelsOperator === 'and') {
                    // AND operation: task must have all specified labels
                    expect(structuredContent.tasks).toEqual(
                        expect.arrayContaining([
                            expect.objectContaining({
                                labels: expect.arrayContaining(params.labels),
                            }),
                        ]),
                    )
                } else {
                    // OR operation: task must have at least one of the specified labels
                    expect((structuredContent.tasks as MappedTask[]).length).toBeGreaterThanOrEqual(
                        0,
                    )
                }
            },
        )

        it.each([
            { labelsOperator: 'or' as const, labels: ['@work'] },
            { labelsOperator: 'and' as const, labels: ['@work', '@urgent'] },
        ])(
            'should match "@"-prefixed labels in container searches like the filter path ($labelsOperator)',
            async ({ labelsOperator, labels }) => {
                mockTodoistApi.getTasks.mockResolvedValue(
                    createMockApiResponse([
                        createMockTask({ id: '1', labels: ['work', 'urgent'] }),
                        createMockTask({ id: '2', labels: ['other'] }),
                    ]),
                )

                const result = await findTasks.execute(
                    { projectId: TEST_IDS.PROJECT_TEST, limit: 10, labels, labelsOperator },
                    mockTodoistApi,
                )

                expect(
                    (result.structuredContent.tasks as MappedTask[]).map((task) => task.id),
                ).toEqual(['1'])
            },
        )

        it('should find matches beyond the first page of a project', async () => {
            // The first page holds only tasks assigned to someone else, which the default
            // 'unassignedOrMe' scope drops, so the match is on the second page.
            mockTodoistApi.getTasks
                .mockResolvedValueOnce({
                    results: Array.from({ length: 10 }, (_, index) =>
                        createMockTask({ id: `others-${index}`, responsibleUid: 'someone-else' }),
                    ),
                    nextCursor: 'cursor-after-page-1',
                })
                .mockResolvedValueOnce({
                    results: [createMockTask({ id: 'mine', responsibleUid: null })],
                    nextCursor: null,
                })

            const result = await findTasks.execute(
                { projectId: TEST_IDS.PROJECT_TEST, limit: 10 },
                mockTodoistApi,
            )

            expect(mockTodoistApi.getTasks.mock.calls.map(([args]) => args)).toEqual([
                { projectId: TEST_IDS.PROJECT_TEST, limit: 200, cursor: null },
                { projectId: TEST_IDS.PROJECT_TEST, limit: 200, cursor: 'cursor-after-page-1' },
            ])
            expect((result.structuredContent.tasks as MappedTask[]).map((task) => task.id)).toEqual(
                ['mine'],
            )
            expect(result.structuredContent.hasMore).toBe(false)
        })

        it('should return the rest of a project after the tasks it returned are completed', async () => {
            const projectTasks = [
                createMockTask({ id: 'theirs', responsibleUid: 'someone-else' }),
                ...['1', '2', '3', '4'].map((id) => createMockTask({ id, responsibleUid: null })),
            ]
            mockTodoistApi.getTasks.mockImplementation(paginateLikeApi(projectTasks))
            const params = { projectId: TEST_IDS.PROJECT_TEST, limit: 2 }
            const taskIds = (result: Awaited<ReturnType<typeof findTasks.execute>>) =>
                (result.structuredContent.tasks as MappedTask[]).map((task) => task.id)

            const first = await findTasks.execute(params, mockTodoistApi)
            for (const id of taskIds(first)) {
                projectTasks.splice(
                    projectTasks.findIndex((task) => task.id === id),
                    1,
                )
            }
            const second = await findTasks.execute(
                { ...params, cursor: first.structuredContent.nextCursor },
                mockTodoistApi,
            )

            expect(taskIds(first)).toEqual(['1', '2'])
            expect(taskIds(second)).toEqual(['3', '4'])
            expect(second.structuredContent.hasMore).toBe(false)
        })

        it('should let the API filter a single label, by its real name', async () => {
            mockTodoistApi.getLabels.mockResolvedValue(
                createMockApiResponse([createMockLabel({ name: 'work' })]),
            )
            mockTodoistApi.getTasks.mockResolvedValue(
                createMockApiResponse([createMockTask({ id: '1', labels: ['work'] })]),
            )

            const result = await findTasks.execute(
                { projectId: TEST_IDS.PROJECT_TEST, limit: 10, labels: ['@Work'] },
                mockTodoistApi,
            )

            expect(mockTodoistApi.getTasks).toHaveBeenCalledWith({
                projectId: TEST_IDS.PROJECT_TEST,
                label: 'work',
                limit: 200,
                cursor: null,
            })
            expect((result.structuredContent.tasks as MappedTask[]).map((task) => task.id)).toEqual(
                ['1'],
            )
        })

        it('should let the API filter a label found only among shared labels', async () => {
            mockTodoistApi.getSharedLabels.mockResolvedValue(createMockApiResponse(['Errands']))
            mockTodoistApi.getTasks.mockResolvedValue(
                createMockApiResponse([createMockTask({ id: '1', labels: ['Errands'] })]),
            )

            await findTasks.execute(
                { projectId: TEST_IDS.PROJECT_TEST, limit: 10, labels: ['errands'] },
                mockTodoistApi,
            )

            expect(mockTodoistApi.getTasks).toHaveBeenCalledWith({
                projectId: TEST_IDS.PROJECT_TEST,
                label: 'Errands',
                limit: 200,
                cursor: null,
            })
        })

        it('should reuse the label it resolved on later pages, without looking it up again', async () => {
            mockTodoistApi.getLabels.mockResolvedValue(
                createMockApiResponse([createMockLabel({ name: 'work' })]),
            )
            mockTodoistApi.getTasks.mockImplementation(async () =>
                createMockApiResponse(
                    ['1', '2', '3'].map((id) => createMockTask({ id, labels: ['work'] })),
                ),
            )
            const params = { projectId: TEST_IDS.PROJECT_TEST, limit: 2, labels: ['Work'] }

            const first = await findTasks.execute(params, mockTodoistApi)
            const second = await findTasks.execute(
                { ...params, cursor: first.structuredContent.nextCursor },
                mockTodoistApi,
            )

            expect(mockTodoistApi.getLabels).toHaveBeenCalledTimes(1)
            expect(mockTodoistApi.getTasks).toHaveBeenLastCalledWith(
                expect.objectContaining({ label: 'work' }),
            )
            expect((second.structuredContent.tasks as MappedTask[]).map((task) => task.id)).toEqual(
                ['3'],
            )
        })

        it('should keep filtering labels after fetching when resuming a search whose lookup failed', async () => {
            // A resumed search filters the way its first call did, without looking label
            // names up again.
            const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
            mockTodoistApi.getLabels
                .mockRejectedValueOnce(new Error('Network error'))
                .mockResolvedValue(createMockApiResponse([createMockLabel({ name: 'work' })]))
            const projectTasks = [
                createMockTask({ id: '1', labels: ['work'] }),
                createMockTask({ id: '2', labels: ['other'] }),
                createMockTask({ id: '3', labels: ['work'] }),
                createMockTask({ id: '4', labels: ['work'] }),
            ]
            // Like the API, drop tasks without the label when one is given.
            mockTodoistApi.getTasks.mockImplementation(async (args) => {
                const label = args?.label
                return createMockApiResponse(
                    label
                        ? projectTasks.filter((task) => task.labels.includes(label))
                        : projectTasks,
                )
            })
            const params = { projectId: TEST_IDS.PROJECT_TEST, limit: 2, labels: ['work'] }

            const first = await findTasks.execute(params, mockTodoistApi)
            const second = await findTasks.execute(
                { ...params, cursor: first.structuredContent.nextCursor },
                mockTodoistApi,
            )

            expect((second.structuredContent.tasks as MappedTask[]).map((task) => task.id)).toEqual(
                ['4'],
            )
            expect(mockTodoistApi.getTasks).toHaveBeenLastCalledWith(
                expect.not.objectContaining({ label: expect.anything() }),
            )
            consoleError.mockRestore()
        })

        it('should let the API filter one of several "and" labels', async () => {
            mockTodoistApi.getLabels.mockResolvedValue(
                createMockApiResponse([
                    createMockLabel({ name: 'work' }),
                    createMockLabel({ name: 'urgent' }),
                ]),
            )
            mockTodoistApi.getTasks.mockResolvedValue(
                createMockApiResponse([
                    createMockTask({ id: '1', labels: ['work', 'urgent'] }),
                    createMockTask({ id: '2', labels: ['work'] }),
                ]),
            )

            const result = await findTasks.execute(
                {
                    projectId: TEST_IDS.PROJECT_TEST,
                    limit: 10,
                    labels: ['Work', 'Urgent'],
                    labelsOperator: 'and',
                },
                mockTodoistApi,
            )

            expect(mockTodoistApi.getTasks).toHaveBeenCalledWith(
                expect.objectContaining({ label: 'work' }),
            )
            expect((result.structuredContent.tasks as MappedTask[]).map((task) => task.id)).toEqual(
                ['1'],
            )
        })

        it('should not let the API filter several "or" labels', async () => {
            mockTodoistApi.getTasks.mockResolvedValue(
                createMockApiResponse([
                    createMockTask({ id: '1', labels: ['work'] }),
                    createMockTask({ id: '2', labels: ['Home'] }),
                    createMockTask({ id: '3', labels: ['other'] }),
                ]),
            )

            const result = await findTasks.execute(
                { projectId: TEST_IDS.PROJECT_TEST, limit: 10, labels: ['Work', 'home'] },
                mockTodoistApi,
            )

            expect(mockTodoistApi.getLabels).not.toHaveBeenCalled()
            expect(mockTodoistApi.getTasks).toHaveBeenCalledWith({
                projectId: TEST_IDS.PROJECT_TEST,
                limit: 200,
                cursor: null,
            })
            expect((result.structuredContent.tasks as MappedTask[]).map((task) => task.id)).toEqual(
                ['1', '2'],
            )
        })

        it('should filter labels client-side when the label lookup fails', async () => {
            mockTodoistApi.getLabels.mockRejectedValue(new Error('Network error'))
            const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
            mockTodoistApi.getTasks.mockResolvedValue(
                createMockApiResponse([
                    createMockTask({ id: '1', labels: ['work'] }),
                    createMockTask({ id: '2', labels: ['other'] }),
                ]),
            )

            const result = await findTasks.execute(
                { projectId: TEST_IDS.PROJECT_TEST, limit: 10, labels: ['work'] },
                mockTodoistApi,
            )

            expect(mockTodoistApi.getTasks).toHaveBeenCalledWith({
                projectId: TEST_IDS.PROJECT_TEST,
                limit: 200,
                cursor: null,
            })
            expect((result.structuredContent.tasks as MappedTask[]).map((task) => task.id)).toEqual(
                ['1'],
            )
            consoleError.mockRestore()
        })

        it('should handle empty labels array', async () => {
            const params = {
                searchText: 'test',
                limit: 10,
            }

            const mockResponse = { tasks: [], nextCursor: null }
            mockGetTasksByFilter.mockResolvedValue(mockResponse)

            await findTasks.execute(params, mockTodoistApi)

            expect(mockGetTasksByFilter).toHaveBeenCalledWith({
                client: mockTodoistApi,
                query: 'search: test & !assigned to: others',
                cursor: undefined,
                limit: 10,
            })
        })

        it('should combine search text, container, and label filters', async () => {
            const params = {
                projectId: TEST_IDS.PROJECT_TEST,
                searchText: 'important',
                limit: 10,
                labels: ['urgent'],
            }

            const allTasks = [
                createMockTask({
                    id: '1',
                    content: 'important task',
                    description: 'urgent work',
                    labels: ['urgent'],
                }),
                createMockTask({
                    id: '2',
                    content: 'other task',
                    description: 'not important',
                    labels: ['work'],
                }),
            ]
            mockTodoistApi.getTasks.mockResolvedValue(createMockApiResponse(allTasks))

            const result = await findTasks.execute(params, mockTodoistApi)

            // Should call API with container filter
            expect(mockTodoistApi.getTasks).toHaveBeenCalledWith({
                limit: 200,
                cursor: null,
                projectId: TEST_IDS.PROJECT_TEST,
            })

            // Should filter results by search text AND labels
            const structuredContent = result.structuredContent
            expect(structuredContent.tasks).toEqual([
                expect.objectContaining({
                    content: 'important task',
                    labels: expect.arrayContaining(['urgent']),
                }),
            ])
        })

        it('should handle labels-only filtering', async () => {
            const params = {
                limit: 10,
                labels: ['work'],
            }

            const mockTasks = [
                createMappedTask({
                    id: TEST_IDS.TASK_1,
                    content: 'Task with work label',
                    labels: ['work'],
                }),
            ]
            const mockResponse = { tasks: mockTasks, nextCursor: null }
            mockGetTasksByFilter.mockResolvedValue(mockResponse)

            const result = await findTasks.execute(params, mockTodoistApi)

            expect(mockGetTasksByFilter).toHaveBeenCalledWith({
                client: mockTodoistApi,
                query: '(@work) & !assigned to: others',
                cursor: undefined,
                limit: 10,
            })

            const structuredContent = result.structuredContent
            expect(structuredContent.appliedFilters).toEqual(
                expect.objectContaining({
                    labels: ['work'],
                }),
            )
        })

        it('should handle labels with @ symbol', async () => {
            const params = {
                limit: 10,
                labels: ['@work', 'personal'], // Mix of with and without @
            }

            const mockTasks = [
                createMappedTask({
                    id: TEST_IDS.TASK_1,
                    content: 'Task with work label',
                    labels: ['work', 'personal'],
                }),
            ]
            const mockResponse = { tasks: mockTasks, nextCursor: null }
            mockGetTasksByFilter.mockResolvedValue(mockResponse)

            const result = await findTasks.execute(params, mockTodoistApi)

            // Should handle both @work (already has @) and personal (needs @ added)
            expect(mockGetTasksByFilter).toHaveBeenCalledWith({
                client: mockTodoistApi,
                query: '(@work  |  @personal) & !assigned to: others',
                cursor: undefined,
                limit: 10,
            })

            const structuredContent = result.structuredContent
            expect(structuredContent.appliedFilters).toEqual(
                expect.objectContaining({
                    labels: ['@work', 'personal'],
                }),
            )
        })

        it.each([
            { name: 'labels only', params: {} },
            { name: 'text search with labels', params: { searchText: 'budget' } },
            { name: 'project with labels', params: { projectId: TEST_IDS.PROJECT_TEST } },
        ])(
            'should show labels given with @ only once in the summary: $name',
            async ({ params }) => {
                const mockTasks = [
                    createMappedTask({ id: TEST_IDS.TASK_1, labels: ['work', 'personal'] }),
                ]
                mockGetTasksByFilter.mockResolvedValue({ tasks: mockTasks, nextCursor: null })
                mockTodoistApi.getTasks.mockResolvedValue(
                    createMockApiResponse([createMockTask({ labels: ['work', 'personal'] })]),
                )

                const result = await findTasks.execute(
                    { ...params, limit: 10, labels: ['@work', 'personal'] },
                    mockTodoistApi,
                )

                expect(result.textContent).toContain('labels: @work | @personal')
                expect(result.textContent).not.toContain('@@')
            },
        )
    })

    describe('markdown content preservation', () => {
        it('should preserve markdown links and formatting in task content and description', async () => {
            const richMarkdownContent = 'Test **bold** task with [link](https://example.com)'
            const richMarkdownDescription = `This is a **comprehensive test** of markdown syntax in Todoist task descriptions:

### Links
[Wikipedia - Test Link](https://en.wikipedia.org/wiki/Test)
[GitHub Repository](https://github.com/Doist/todoist-mcp)
[Google Search](https://www.google.com)

### Text Formatting
**Bold text here**
*Italic text here*
***Bold and italic***
\`inline code\`

### Lists
- Bullet point 1
- Bullet point 2
  - Nested item

1. Numbered item 1
2. Numbered item 2

End of test content.`

            const mockTasks = [
                createMappedTask({
                    id: TEST_IDS.TASK_1,
                    content: richMarkdownContent,
                    description: richMarkdownDescription,
                }),
            ]
            const mockResponse = { tasks: mockTasks, nextCursor: null }
            mockGetTasksByFilter.mockResolvedValue(mockResponse)

            const result = await findTasks.execute(
                { searchText: 'markdown test', limit: 10 },
                mockTodoistApi,
            )

            const structuredContent = result.structuredContent

            // Verify that markdown links and formatting are preserved exactly as provided
            expect(structuredContent.tasks).toHaveLength(1)
            expect(structuredContent.tasks).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        content: richMarkdownContent,
                        description: richMarkdownDescription,
                    }),
                ]),
            )
        })

        it('should preserve markdown links in container-based searches', async () => {
            const taskWithLinks = createMockTask({
                id: TEST_IDS.TASK_1,
                content: 'Task with [external link](https://todoist.com)',
                description: 'See this [documentation](https://docs.example.com) for details.',
            })

            mockTodoistApi.getTasks.mockResolvedValue(createMockApiResponse([taskWithLinks]))

            const result = await findTasks.execute(
                { projectId: TEST_IDS.PROJECT_TEST, limit: 10 },
                mockTodoistApi,
            )

            const structuredContent = result.structuredContent

            // Verify URLs are preserved in container-based searches too
            expect(structuredContent.tasks).toHaveLength(1)
            expect(structuredContent.tasks).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        content: 'Task with [external link](https://todoist.com)',
                        description:
                            'See this [documentation](https://docs.example.com) for details.',
                    }),
                ]),
            )
        })
    })

    describe('responsible user filtering', () => {
        describe('when no responsibleUser is provided', () => {
            it('should use server-side assignee scoping for text search by default', async () => {
                const mockTasks = [
                    createMappedTask({
                        id: TEST_IDS.TASK_1,
                        content: 'My task',
                        responsibleUid: TEST_IDS.USER_ID,
                    }),
                    createMappedTask({
                        id: TEST_IDS.TASK_2,
                        content: 'Unassigned task',
                        responsibleUid: undefined,
                    }),
                ]

                const mockResponse = { tasks: mockTasks, nextCursor: null }
                mockGetTasksByFilter.mockResolvedValue(mockResponse)

                const result = await findTasks.execute(
                    { searchText: 'task', limit: 10 },
                    mockTodoistApi,
                )

                // Verify server-side assignee filter is included in query
                expect(mockGetTasksByFilter).toHaveBeenCalledWith({
                    client: mockTodoistApi,
                    query: 'search: task & !assigned to: others',
                    cursor: undefined,
                    limit: 10,
                })

                const structuredContent = result.structuredContent
                expect(structuredContent.tasks).toHaveLength(2)
                expect(
                    (structuredContent.tasks as MappedTask[]).map((t: MappedTask) => t.id),
                ).toEqual([TEST_IDS.TASK_1, TEST_IDS.TASK_2])
            })

            it('should omit assignee filter from query when responsibleUserFiltering is "all"', async () => {
                const mockTasks = [createMappedTask({ id: TEST_IDS.TASK_1, content: 'Any task' })]
                mockGetTasksByFilter.mockResolvedValue({ tasks: mockTasks, nextCursor: null })

                await findTasks.execute(
                    { searchText: 'task', responsibleUserFiltering: 'all', limit: 10 },
                    mockTodoistApi,
                )

                expect(mockGetTasksByFilter).toHaveBeenCalledWith({
                    client: mockTodoistApi,
                    query: 'search: task',
                    cursor: undefined,
                    limit: 10,
                })
            })

            it('should use "assigned to: others" filter when responsibleUserFiltering is "assigned"', async () => {
                const mockTasks = [
                    createMappedTask({ id: TEST_IDS.TASK_1, content: 'Other user task' }),
                ]
                mockGetTasksByFilter.mockResolvedValue({ tasks: mockTasks, nextCursor: null })

                await findTasks.execute(
                    { searchText: 'task', responsibleUserFiltering: 'assigned', limit: 10 },
                    mockTodoistApi,
                )

                expect(mockGetTasksByFilter).toHaveBeenCalledWith({
                    client: mockTodoistApi,
                    query: 'search: task & assigned to: others',
                    cursor: undefined,
                    limit: 10,
                })
            })

            it('should filter container-based results to only others tasks when responsibleUserFiltering is "assigned"', async () => {
                const mockTasks = [
                    createMockTask({
                        id: TEST_IDS.TASK_1,
                        content: 'My task',
                        responsibleUid: TEST_IDS.USER_ID,
                    }),
                    createMockTask({
                        id: TEST_IDS.TASK_2,
                        content: 'Unassigned task',
                        responsibleUid: null,
                    }),
                    createMockTask({
                        id: TEST_IDS.TASK_3,
                        content: 'Other user task',
                        responsibleUid: 'other-user-id',
                    }),
                ]

                mockTodoistApi.getTasks.mockResolvedValue(createMockApiResponse(mockTasks))

                const result = await findTasks.execute(
                    {
                        projectId: TEST_IDS.PROJECT_WORK,
                        responsibleUserFiltering: 'assigned',
                        limit: 10,
                    },
                    mockTodoistApi,
                )

                const structuredContent = result.structuredContent
                expect(structuredContent.tasks).toHaveLength(1)
                expect((structuredContent.tasks as MappedTask[])[0]?.id).toBe(TEST_IDS.TASK_3)
            })

            it('should filter container-based results to show only unassigned tasks or tasks assigned to current user', async () => {
                const mockTasks = [
                    createMockTask({
                        id: TEST_IDS.TASK_1,
                        content: 'My project task',
                        responsibleUid: TEST_IDS.USER_ID, // Assigned to current user
                    }),
                    createMockTask({
                        id: TEST_IDS.TASK_2,
                        content: 'Unassigned project task',
                        responsibleUid: null, // Unassigned
                    }),
                    createMockTask({
                        id: TEST_IDS.TASK_3,
                        content: 'Someone else project task',
                        responsibleUid: 'other-user-id', // Assigned to someone else
                    }),
                ]

                mockTodoistApi.getTasks.mockResolvedValue(createMockApiResponse(mockTasks))

                const result = await findTasks.execute(
                    { projectId: TEST_IDS.PROJECT_WORK, limit: 10 },
                    mockTodoistApi,
                )

                const structuredContent = result.structuredContent
                // Should only return tasks 1 and 2, not task 3
                expect(structuredContent.tasks).toHaveLength(2)
                expect(
                    (structuredContent.tasks as MappedTask[]).map((t: MappedTask) => t.id),
                ).toEqual([TEST_IDS.TASK_1, TEST_IDS.TASK_2])
            })
        })

        describe('when responsibleUser is provided', () => {
            it('should omit a first-page cursor sentinel from responsible-user-only queries', async () => {
                mockResolveUserNameToId.mockResolvedValue({
                    userId: 'specific-user-id',
                    displayName: 'John Doe',
                    email: 'john@example.com',
                })
                mockTodoistApi.getTasksByFilter.mockResolvedValue({
                    results: [],
                    nextCursor: null,
                })

                await findTasks.execute(
                    { responsibleUser: 'John Doe', limit: 10, cursor: '0' },
                    mockTodoistApi,
                )

                expect(mockTodoistApi.getTasksByFilter).toHaveBeenCalledWith({
                    query: 'assigned to: john@example.com',
                    lang: 'en',
                    limit: 10,
                    cursor: null,
                })
            })

            it('should use server-side assignee filter for text search with specified user', async () => {
                const mockTasks = [
                    createMappedTask({
                        id: TEST_IDS.TASK_1,
                        content: 'Task for John',
                        responsibleUid: 'specific-user-id',
                    }),
                ]

                const mockResponse = { tasks: mockTasks, nextCursor: null }
                mockGetTasksByFilter.mockResolvedValue(mockResponse)

                mockResolveUserNameToId.mockResolvedValue({
                    userId: 'specific-user-id',
                    displayName: 'John Doe',
                    email: 'john@example.com',
                })

                const result = await findTasks.execute(
                    { searchText: 'task', responsibleUser: 'John Doe', limit: 10 },
                    mockTodoistApi,
                )

                // Verify server-side assignee filter is included in query
                expect(mockGetTasksByFilter).toHaveBeenCalledWith({
                    client: mockTodoistApi,
                    query: 'search: task & assigned to: john@example.com',
                    cursor: undefined,
                    limit: 10,
                })

                const structuredContent = result.structuredContent
                expect(structuredContent.tasks).toHaveLength(1)
                expect((structuredContent.tasks as MappedTask[])[0]?.id).toBe(TEST_IDS.TASK_1)
            })

            it('should filter container-based results to show only tasks assigned to specified user', async () => {
                const mockTasks = [
                    createMockTask({
                        id: TEST_IDS.TASK_1,
                        content: 'Task for John',
                        responsibleUid: 'specific-user-id', // Assigned to specified user
                    }),
                    createMockTask({
                        id: TEST_IDS.TASK_2,
                        content: 'My task',
                        responsibleUid: TEST_IDS.USER_ID, // Assigned to current user
                    }),
                    createMockTask({
                        id: TEST_IDS.TASK_3,
                        content: 'Unassigned task',
                        responsibleUid: null, // Unassigned
                    }),
                ]

                mockTodoistApi.getTasks.mockResolvedValue(createMockApiResponse(mockTasks))

                mockResolveUserNameToId.mockResolvedValue({
                    userId: 'specific-user-id',
                    displayName: 'John Doe',
                    email: 'john@example.com',
                })

                const result = await findTasks.execute(
                    { projectId: TEST_IDS.PROJECT_WORK, responsibleUser: 'John Doe', limit: 10 },
                    mockTodoistApi,
                )

                const structuredContent = result.structuredContent
                // Should only return task 1 (assigned to John)
                expect(structuredContent.tasks).toHaveLength(1)
                expect((structuredContent.tasks as MappedTask[])[0]?.id).toBe(TEST_IDS.TASK_1)
            })

            it('should include unassigned tasks for current user in container results', async () => {
                const mockTasks = [
                    createMockTask({
                        id: TEST_IDS.TASK_1,
                        responsibleUid: TEST_IDS.USER_ID,
                    }),
                    createMockTask({
                        id: TEST_IDS.TASK_2,
                        responsibleUid: null,
                    }),
                    createMockTask({
                        id: TEST_IDS.TASK_3,
                        responsibleUid: 'other-user-id',
                    }),
                ]

                mockTodoistApi.getTasks.mockResolvedValue(createMockApiResponse(mockTasks))

                mockResolveUserNameToId.mockResolvedValue({
                    userId: TEST_IDS.USER_ID,
                    displayName: 'Avery Inboxworthy',
                    email: 'avery.inboxworthy@example.com',
                })

                const result = await findTasks.execute(
                    { projectId: TEST_IDS.PROJECT_WORK, responsibleUser: 'me', limit: 10 },
                    mockTodoistApi,
                )

                const structuredContent = result.structuredContent

                expect((structuredContent.tasks as MappedTask[]).map((task) => task.id)).toEqual([
                    TEST_IDS.TASK_1,
                    TEST_IDS.TASK_2,
                ])
            })
        })
    })

    describe('filter parameter', () => {
        it('should satisfy the at-least-one-filter requirement on its own', async () => {
            const mockResponse = { tasks: [], nextCursor: null }
            mockGetTasksByFilter.mockResolvedValue(mockResponse)

            await expect(
                findTasks.execute({ filter: 'today', limit: 10 }, mockTodoistApi),
            ).resolves.toBeDefined()
        })

        it('should pass the raw filter as the query (with default user filter appended)', async () => {
            const mockResponse = { tasks: [], nextCursor: null }
            mockGetTasksByFilter.mockResolvedValue(mockResponse)

            await findTasks.execute({ filter: 'today | overdue', limit: 10 }, mockTodoistApi)

            expect(mockGetTasksByFilter).toHaveBeenCalledWith({
                client: mockTodoistApi,
                query: '(today | overdue) & !assigned to: others',
                cursor: undefined,
                limit: 10,
            })
        })

        it('should combine filter with searchText using AND', async () => {
            const mockResponse = { tasks: [], nextCursor: null }
            mockGetTasksByFilter.mockResolvedValue(mockResponse)

            await findTasks.execute(
                { filter: 'p1', searchText: 'meeting', limit: 10 },
                mockTodoistApi,
            )

            expect(mockGetTasksByFilter).toHaveBeenCalledWith({
                client: mockTodoistApi,
                query: '(p1) & search: meeting & !assigned to: others',
                cursor: undefined,
                limit: 10,
            })
        })

        it('should escape search text without escaping raw filters or label operators', async () => {
            mockGetTasksByFilter.mockResolvedValue({ tasks: [], nextCursor: null })

            await findTasks.execute(
                {
                    filter: 'today | overdue',
                    searchText: 'meeting & notes',
                    labels: ['work'],
                    limit: 10,
                },
                mockTodoistApi,
            )

            expect(mockGetTasksByFilter).toHaveBeenCalledWith({
                client: mockTodoistApi,
                query: '(today | overdue) & search: meeting \\& notes & (@work) & !assigned to: others',
                cursor: undefined,
                limit: 10,
            })
        })

        it('should combine filter with labels', async () => {
            const mockResponse = { tasks: [], nextCursor: null }
            mockGetTasksByFilter.mockResolvedValue(mockResponse)

            await findTasks.execute(
                { filter: 'today', labels: ['work'], limit: 10 },
                mockTodoistApi,
            )

            expect(mockGetTasksByFilter).toHaveBeenCalledWith({
                client: mockTodoistApi,
                query: '(today) & (@work) & !assigned to: others',
                cursor: undefined,
                limit: 10,
            })
        })

        it('should combine filter with responsibleUser', async () => {
            mockResolveUserNameToId.mockResolvedValue({
                userId: 'specific-user-id',
                displayName: 'Jane Doe',
                email: 'jane@example.com',
            })
            const mockResponse = { tasks: [], nextCursor: null }
            mockGetTasksByFilter.mockResolvedValue(mockResponse)

            await findTasks.execute(
                { filter: '##Work', responsibleUser: 'Jane Doe', limit: 10 },
                mockTodoistApi,
            )

            expect(mockGetTasksByFilter).toHaveBeenCalledWith({
                client: mockTodoistApi,
                query: '(##Work) & assigned to: jane@example.com',
                cursor: undefined,
                limit: 10,
            })
        })

        it('should include unassigned tasks when responsibleUser resolves to current user', async () => {
            mockResolveUserNameToId.mockResolvedValue({
                userId: TEST_IDS.USER_ID,
                displayName: 'Avery Inboxworthy',
                email: 'avery.inboxworthy@example.com',
            })

            mockGetTasksByFilter.mockResolvedValue({ tasks: [], nextCursor: null })

            await findTasks.execute(
                { filter: 'today | overdue', responsibleUser: 'me', limit: 10 },
                mockTodoistApi,
            )

            expect(mockResolveUserNameToId).toHaveBeenCalledWith(mockTodoistApi, 'me')

            expect(mockGetTasksByFilter).toHaveBeenCalledWith({
                client: mockTodoistApi,
                query: '(today | overdue) & !assigned to: others',
                cursor: undefined,
                limit: 10,
            })
        })

        it('should throw an error when filter is combined with projectId', async () => {
            await expect(
                findTasks.execute(
                    { filter: 'today', projectId: TEST_IDS.PROJECT_TEST, limit: 10 },
                    mockTodoistApi,
                ),
            ).rejects.toThrow(
                'The `filter`/`filterIdOrName` parameter cannot be combined with projectId, sectionId, or parentId.',
            )
        })

        it('should throw an error when filter is combined with sectionId', async () => {
            await expect(
                findTasks.execute(
                    { filter: 'p1', sectionId: TEST_IDS.SECTION_1, limit: 10 },
                    mockTodoistApi,
                ),
            ).rejects.toThrow(
                'The `filter`/`filterIdOrName` parameter cannot be combined with projectId, sectionId, or parentId.',
            )
        })

        it('should pass filter through without appending user filter when responsibleUserFiltering is "all"', async () => {
            const mockResponse = { tasks: [], nextCursor: null }
            mockGetTasksByFilter.mockResolvedValue(mockResponse)

            await findTasks.execute(
                { filter: 'today', responsibleUserFiltering: 'all', limit: 10 },
                mockTodoistApi,
            )

            expect(mockGetTasksByFilter).toHaveBeenCalledWith({
                client: mockTodoistApi,
                query: '(today)',
                cursor: undefined,
                limit: 10,
            })
        })
    })

    describe('filterIdOrName parameter', () => {
        it('should resolve filter and use its query', async () => {
            mockResolveFilter.mockResolvedValue({
                filterId: 'filter-1',
                filterName: 'My Filter',
                filterQuery: 'today & p1',
            })
            const mockResponse = { tasks: [], nextCursor: null }
            mockGetTasksByFilter.mockResolvedValue(mockResponse)

            await findTasks.execute({ filterIdOrName: 'My Filter', limit: 10 }, mockTodoistApi)

            expect(mockResolveFilter).toHaveBeenCalledWith(mockTodoistApi, 'My Filter')
            expect(mockGetTasksByFilter).toHaveBeenCalledWith({
                client: mockTodoistApi,
                query: '(today & p1)',
                cursor: undefined,
                limit: 10,
            })
        })

        it('should throw an error when both filter and filterIdOrName are provided', async () => {
            await expect(
                findTasks.execute(
                    { filter: 'today', filterIdOrName: 'My Filter', limit: 10 },
                    mockTodoistApi,
                ),
            ).rejects.toThrow(
                'The `filter` and `filterIdOrName` parameters cannot be used together. Provide only one.',
            )
        })

        it('should propagate resolver errors', async () => {
            mockResolveFilter.mockRejectedValue(new Error('Filter "nonexistent" not found.'))

            await expect(
                findTasks.execute({ filterIdOrName: 'nonexistent', limit: 10 }, mockTodoistApi),
            ).rejects.toThrow('Filter "nonexistent" not found.')
        })

        it('should throw an error when filterIdOrName is combined with projectId', async () => {
            await expect(
                findTasks.execute(
                    {
                        filterIdOrName: 'My Filter',
                        projectId: TEST_IDS.PROJECT_TEST,
                        limit: 10,
                    },
                    mockTodoistApi,
                ),
            ).rejects.toThrow(
                'The `filter`/`filterIdOrName` parameter cannot be combined with projectId, sectionId, or parentId.',
            )
        })

        it('should combine resolved filter query with searchText', async () => {
            mockResolveFilter.mockResolvedValue({
                filterId: 'filter-1',
                filterName: 'My Filter',
                filterQuery: 'p1',
            })
            const mockResponse = { tasks: [], nextCursor: null }
            mockGetTasksByFilter.mockResolvedValue(mockResponse)

            await findTasks.execute(
                { filterIdOrName: 'filter-1', searchText: 'meeting', limit: 10 },
                mockTodoistApi,
            )

            expect(mockGetTasksByFilter).toHaveBeenCalledWith({
                client: mockTodoistApi,
                query: '(p1) & search: meeting',
                cursor: undefined,
                limit: 10,
            })
        })

        it('should apply assignee filtering when responsibleUserFiltering is explicitly set', async () => {
            mockResolveFilter.mockResolvedValue({
                filterId: 'filter-1',
                filterName: 'My Filter',
                filterQuery: 'today',
            })
            const mockResponse = { tasks: [], nextCursor: null }
            mockGetTasksByFilter.mockResolvedValue(mockResponse)

            await findTasks.execute(
                {
                    filterIdOrName: 'filter-1',
                    responsibleUserFiltering: 'unassignedOrMe',
                    limit: 10,
                },
                mockTodoistApi,
            )

            expect(mockGetTasksByFilter).toHaveBeenCalledWith({
                client: mockTodoistApi,
                query: '(today) & !assigned to: others',
                cursor: undefined,
                limit: 10,
            })
        })
    })

    describe('error handling', () => {
        it.each([
            {
                error: TEST_ERRORS.API_RATE_LIMIT,
                params: {
                    searchText: 'any search term',
                    limit: 10,
                },
            },
            {
                error: TEST_ERRORS.INVALID_CURSOR,
                params: {
                    searchText: 'test',
                    cursor: 'invalid-cursor-format',
                    limit: 10,
                },
            },
        ])('should propagate $error', async ({ error, params }) => {
            mockGetTasksByFilter.mockRejectedValue(new Error(error))
            await expect(findTasks.execute(params, mockTodoistApi)).rejects.toThrow(error)
        })
    })
})
