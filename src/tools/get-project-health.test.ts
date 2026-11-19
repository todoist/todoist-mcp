import {
    HEALTH_STATUSES,
    type ProjectHealth,
    type ProjectProgress,
    type TodoistApi,
} from '@todoist/sdk'
import { type Mocked, vi } from 'vitest'
import { createMockTask, createMockWorkspaceProject, TEST_ERRORS } from '../utils/test-helpers.js'
import { ToolNames } from '../utils/tool-names.js'
import { getProjectHealth } from './get-project-health.js'

const mockTodoistApi = {
    getProjectProgress: vi.fn(),
    getProjectHealth: vi.fn(),
    getProjectHealthContext: vi.fn(),
    getProject: vi.fn(),
    getTasks: vi.fn(),
    getCompletedTasksByCompletionDate: vi.fn(),
} as unknown as Mocked<TodoistApi>

const { GET_PROJECT_HEALTH } = ToolNames

function createMockProgress(overrides: Partial<ProjectProgress> = {}): ProjectProgress {
    return {
        projectId: 'proj-123',
        completedCount: 15,
        activeCount: 10,
        progressPercent: 60,
        ...overrides,
    }
}

function createMockHealth(overrides: Partial<ProjectHealth> = {}): ProjectHealth {
    return {
        status: 'ON_TRACK',
        description: 'Project is progressing well.',
        descriptionSummary: 'On track',
        projectId: 'proj-123',
        updatedAt: new Date('2026-03-28T10:00:00Z'),
        isStale: false,
        updateInProgress: false,
        ...overrides,
    }
}

describe('get-project-health tool', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('should have correct tool metadata', () => {
        expect(getProjectHealth.name).toBe(GET_PROJECT_HEALTH)
        expect(getProjectHealth.annotations).toEqual({
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
        })
    })

    it('should return combined progress and health data', async () => {
        const mockProgress = createMockProgress()
        const mockHealth = createMockHealth()

        mockTodoistApi.getProjectProgress.mockResolvedValue(mockProgress)
        mockTodoistApi.getProjectHealth.mockResolvedValue(mockHealth)

        const result = await getProjectHealth.execute(
            { projectId: 'proj-123', includeContext: false },
            mockTodoistApi,
        )

        expect(mockTodoistApi.getProjectProgress).toHaveBeenCalledWith('proj-123')
        expect(mockTodoistApi.getProjectHealth).toHaveBeenCalledWith('proj-123')
        expect(mockTodoistApi.getProject).not.toHaveBeenCalled()
        expect(mockTodoistApi.getTasks).not.toHaveBeenCalled()
        expect(mockTodoistApi.getCompletedTasksByCompletionDate).not.toHaveBeenCalled()

        expect(result.structuredContent).toMatchObject({
            projectId: 'proj-123',
            progress: {
                completedCount: 15,
                activeCount: 10,
                progressPercent: 60,
            },
            health: {
                status: 'ON_TRACK',
                description: 'Project is progressing well.',
                isStale: false,
                updateInProgress: false,
            },
        })

        const structured = result.structuredContent as Record<string, unknown>
        expect(structured.context).toBeUndefined()
    })

    it('returns task context from paginated project data when the old health-context route is gone', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-04-08T12:00:00Z'))
        try {
            mockTodoistApi.getProjectHealthContext.mockRejectedValue(
                new Error('HTTP 404: Not found'),
            )
            mockTodoistApi.getProjectProgress.mockResolvedValue(
                createMockProgress({ activeCount: 2, completedCount: 3 }),
            )
            mockTodoistApi.getProjectHealth.mockResolvedValue(createMockHealth())
            mockTodoistApi.getProject.mockResolvedValue(
                createMockWorkspaceProject({
                    id: 'proj-123',
                    name: 'Launch',
                    description: 'Launch checklist',
                }),
            )
            const first = createMockTask({
                id: 'first',
                content: 'Review outline',
                priority: 'p1',
                labels: ['team'],
                addedAt: new Date('2026-04-01T12:00:00Z'),
                due: { date: '2026-04-08', string: 'today', isRecurring: false },
                deadline: { date: '2026-04-10', lang: 'en' },
            })
            const second = createMockTask({
                id: 'second',
                addedAt: new Date('2026-04-01T11:59:59Z'),
                due: { date: '2026-04-08T11:59:00', string: 'at 11:59', isRecurring: false },
            })
            mockTodoistApi.getTasks
                .mockResolvedValueOnce({ results: [first], nextCursor: 'active-page' })
                .mockResolvedValueOnce({ results: [second], nextCursor: null })
            const completed = createMockTask({
                id: 'done',
                checked: true,
                addedAt: new Date('2026-04-03T12:00:00Z'),
                completedAt: new Date('2026-04-04T12:00:00Z'),
            })
            mockTodoistApi.getCompletedTasksByCompletionDate
                .mockResolvedValueOnce({ items: [completed], nextCursor: 'completed-page' })
                .mockResolvedValueOnce({
                    items: [
                        completed,
                        { ...first, checked: true, completedAt: new Date('2026-04-08T09:00:00Z') },
                    ],
                    nextCursor: null,
                })

            const result = await getProjectHealth.execute(
                { projectId: 'proj-123', includeContext: true },
                mockTodoistApi,
            )

            expect(mockTodoistApi.getProjectHealthContext).not.toHaveBeenCalled()
            expect(mockTodoistApi.getTasks).toHaveBeenLastCalledWith(
                expect.objectContaining({ projectId: 'proj-123', cursor: 'active-page' }),
            )
            expect(mockTodoistApi.getCompletedTasksByCompletionDate).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    projectId: 'proj-123',
                    since: '2026-04-01T12:00:00.000Z',
                    until: '2026-04-08T12:00:00.000Z',
                    cursor: 'completed-page',
                }),
            )
            expect(result.structuredContent).toMatchObject({
                projectName: 'Launch',
                health: { status: 'ON_TRACK' },
                context: {
                    projectDescription: 'Launch checklist',
                    projectMetrics: {
                        totalTasks: 5,
                        completedTasks: 3,
                        overdueTasks: 1,
                        tasksCreatedThisWeek: 2,
                        tasksCompletedThisWeek: 1,
                    },
                    tasks: [
                        {
                            id: 'first',
                            content: 'Review outline',
                            priority: 'P1',
                            isCompleted: false,
                            labels: ['team'],
                            due: '2026-04-08',
                            deadline: '2026-04-10',
                        },
                        { id: 'second', due: '2026-04-08T11:59:00' },
                    ],
                },
            })
            expect(
                result.structuredContent.context?.projectMetrics.averageCompletionTime,
            ).toBeUndefined()
            expect(result.textContent).toContain('Review outline')
            expect(result.textContent).not.toContain('Avg Completion Time')
        } finally {
            vi.useRealTimers()
        }
    })

    it.each([
        ['2026-04-07', '2026-04-08T02:00:00Z', 1],
        ['2026-04-08', '2026-04-08T02:00:00Z', 0],
        ['2026-04-07T21:00:00', '2026-04-08T02:00:00Z', 1],
        ['2026-04-07T21:00:00-07:00', '2026-04-08T02:00:00Z', 0],
        ['2026-04-08T02:00:00Z', '2026-04-08T02:00:00Z', 0],
        ['2026-04-08', '2026-04-08T23:59:59.001Z', 1],
    ] as const)(
        'counts a task due %s at %s as %i overdue in Project Health',
        async (due, now, overdue) => {
            vi.useFakeTimers()
            vi.setSystemTime(new Date(now))
            try {
                mockTodoistApi.getProject.mockResolvedValue(createMockWorkspaceProject())
                mockTodoistApi.getProjectProgress.mockResolvedValue(
                    createMockProgress({ activeCount: 1, completedCount: 0 }),
                )
                mockTodoistApi.getProjectHealth.mockResolvedValue(createMockHealth())
                mockTodoistApi.getTasks.mockResolvedValue({
                    results: [
                        createMockTask({ due: { date: due, string: due, isRecurring: false } }),
                    ],
                    nextCursor: null,
                })
                mockTodoistApi.getCompletedTasksByCompletionDate.mockResolvedValue({
                    items: [],
                    nextCursor: null,
                })

                const result = await getProjectHealth.execute(
                    { projectId: 'proj-123', includeContext: true },
                    mockTodoistApi,
                )
                expect(result.structuredContent.context?.projectMetrics.overdueTasks).toBe(overdue)
            } finally {
                vi.useRealTimers()
            }
        },
    )

    it('includes the lifetime average when the window contains every completed task', async () => {
        mockTodoistApi.getProject.mockResolvedValue(
            createMockWorkspaceProject({ name: 'My Named Project' }),
        )
        mockTodoistApi.getTasks.mockResolvedValue({ results: [], nextCursor: null })
        mockTodoistApi.getProjectHealth.mockResolvedValue(createMockHealth())
        mockTodoistApi.getProjectProgress.mockResolvedValue(
            createMockProgress({ activeCount: 0, completedCount: 1 }),
        )
        const completedAt = new Date()
        const addedAt = new Date(completedAt.getTime() - 2.5 * 24 * 60 * 60 * 1000)
        mockTodoistApi.getCompletedTasksByCompletionDate.mockResolvedValue({
            items: [createMockTask({ checked: true, addedAt, completedAt })],
            nextCursor: null,
        })
        const result = await getProjectHealth.execute(
            { projectId: 'proj-123', includeContext: true },
            mockTodoistApi,
        )
        expect(result.structuredContent).toMatchObject({
            projectName: 'My Named Project',
            context: {
                projectMetrics: {
                    totalTasks: 1,
                    completedTasks: 1,
                    overdueTasks: 0,
                    tasksCreatedThisWeek: 1,
                    tasksCompletedThisWeek: 1,
                    averageCompletionTime: 2.5,
                },
                tasks: [],
            },
        })
        expect(result.textContent).toContain('My Named Project')
        expect(result.textContent).toContain('Avg Completion Time:** 2.5 days')
    })

    it('should fall back to project ID when context is not included', async () => {
        const mockProgress = createMockProgress()
        const mockHealth = createMockHealth()

        mockTodoistApi.getProjectProgress.mockResolvedValue(mockProgress)
        mockTodoistApi.getProjectHealth.mockResolvedValue(mockHealth)

        const result = await getProjectHealth.execute(
            { projectId: 'proj-123', includeContext: false },
            mockTodoistApi,
        )

        expect(result.structuredContent).toMatchObject({ projectName: 'Project proj-123' })
    })

    it.each(HEALTH_STATUSES)('should handle %s health status in text output', async (status) => {
        mockTodoistApi.getProjectProgress.mockResolvedValue(createMockProgress())
        mockTodoistApi.getProjectHealth.mockResolvedValue(createMockHealth({ status }))

        const result = await getProjectHealth.execute(
            { projectId: 'proj-123', includeContext: false },
            mockTodoistApi,
        )

        expect(result.textContent).toContain(`**Status:** ${status}`)
        expect(result.structuredContent).toMatchObject({
            health: { status },
        })
    })

    it('should indicate stale health data in text output', async () => {
        mockTodoistApi.getProjectProgress.mockResolvedValue(createMockProgress())
        mockTodoistApi.getProjectHealth.mockResolvedValue(createMockHealth({ isStale: true }))

        const result = await getProjectHealth.execute(
            { projectId: 'proj-123', includeContext: false },
            mockTodoistApi,
        )

        expect(result.textContent).toContain('Health data is stale')
        expect(result.structuredContent).toMatchObject({
            health: { isStale: true },
        })
    })

    it('should indicate update in progress in text output', async () => {
        mockTodoistApi.getProjectProgress.mockResolvedValue(createMockProgress())
        mockTodoistApi.getProjectHealth.mockResolvedValue(
            createMockHealth({ updateInProgress: true }),
        )

        const result = await getProjectHealth.execute(
            { projectId: 'proj-123', includeContext: false },
            mockTodoistApi,
        )

        expect(result.textContent).toContain('update is currently in progress')
        expect(result.structuredContent).toMatchObject({
            health: { updateInProgress: true },
        })
    })

    it('omits average completion time for an empty team project', async () => {
        mockTodoistApi.getProject.mockResolvedValue(createMockWorkspaceProject())
        mockTodoistApi.getTasks.mockResolvedValue({ results: [], nextCursor: null })
        mockTodoistApi.getCompletedTasksByCompletionDate.mockResolvedValue({
            items: [],
            nextCursor: null,
        })
        mockTodoistApi.getProjectProgress.mockResolvedValue(
            createMockProgress({ completedCount: 0, activeCount: 0, progressPercent: 0 }),
        )
        mockTodoistApi.getProjectHealth.mockResolvedValue(createMockHealth())

        const result = await getProjectHealth.execute(
            { projectId: 'proj-123', includeContext: true },
            mockTodoistApi,
        )
        expect(
            result.structuredContent.context?.projectMetrics.averageCompletionTime,
        ).toBeUndefined()
        expect(result.textContent).not.toContain('Avg Completion Time')
    })

    it('should propagate API errors', async () => {
        mockTodoistApi.getProjectProgress.mockRejectedValue(new Error(TEST_ERRORS.API_RATE_LIMIT))
        mockTodoistApi.getProjectHealth.mockResolvedValue(createMockHealth())

        await expect(
            getProjectHealth.execute(
                { projectId: 'proj-123', includeContext: false },
                mockTodoistApi,
            ),
        ).rejects.toThrow(TEST_ERRORS.API_RATE_LIMIT)
    })
})
