import type { TodoistApi } from '@todoist/sdk'
import { afterEach, beforeEach, describe, expect, it, type Mocked, vi } from 'vitest'
import { formatToolExecutionError } from '../tool-execution-error.js'
import { filterResolver } from '../utils/filter-resolver.js'
import {
    createMockFilter,
    createMockFolder,
    createMockLabel,
    createMockProject,
    createMockSection,
    createMockTask,
    createMockToolRequest,
    createMockWorkspaceProject,
    mockUnjoinedWorkspaceProject,
} from '../utils/test-helpers.js'
import { ToolNames } from '../utils/tool-names.js'
import { deleteObject } from './delete-object.js'

// Mock the Todoist API
const mockTodoistApi = {
    getProject: vi.fn(),
    getTask: vi.fn(),
    getSection: vi.fn(),
    getComment: vi.fn(),
    getLabel: vi.fn(),
    getFolder: vi.fn(),
    getReminder: vi.fn(),
    getLocationReminder: vi.fn(),
    sync: vi.fn(),
    deleteProject: vi.fn(),
    deleteSection: vi.fn(),
    deleteTask: vi.fn(),
    deleteComment: vi.fn(),
    deleteLabel: vi.fn(),
    deleteReminder: vi.fn(),
    deleteLocationReminder: vi.fn(),
    deleteFilter: vi.fn(),
    deleteFolder: vi.fn(),
    getWorkspaces: vi.fn(),
    getWorkspaceActiveProjects: vi.fn(),
} as unknown as Mocked<TodoistApi>

const { DELETE_OBJECT } = ToolNames

describe(`${DELETE_OBJECT} tool`, () => {
    beforeEach(() => {
        vi.clearAllMocks()
        filterResolver.clearCache()
    })

    describe('deleting projects', () => {
        it('should delete a project by ID', async () => {
            mockTodoistApi.getProject.mockResolvedValue(createMockProject())
            mockTodoistApi.deleteProject.mockResolvedValue(true)

            const result = await deleteObject.execute(
                { type: 'project', id: '6cfCcrrCFg2xP94Q' },
                mockTodoistApi,
            )

            expect(mockTodoistApi.deleteProject).toHaveBeenCalledWith('6cfCcrrCFg2xP94Q')
            expect(mockTodoistApi.deleteSection).not.toHaveBeenCalled()
            expect(mockTodoistApi.deleteTask).not.toHaveBeenCalled()

            const textContent = result.textContent
            expect(textContent).toContain('Deleted project: id=6cfCcrrCFg2xP94Q')
            expect(result.structuredContent).toEqual({
                deletedEntity: {
                    type: 'project',
                    id: '6cfCcrrCFg2xP94Q',
                },
                success: true,
            })
        })

        it('should propagate project deletion errors', async () => {
            mockTodoistApi.getProject.mockResolvedValue(createMockProject())
            const apiError = new Error('API Error: Cannot delete project with tasks')
            mockTodoistApi.deleteProject.mockRejectedValue(apiError)

            await expect(
                deleteObject.execute({ type: 'project', id: 'project-with-tasks' }, mockTodoistApi),
            ).rejects.toThrow('API Error: Cannot delete project with tasks')
        })

        it('should prevent deletion of unarchived workspace projects', async () => {
            mockTodoistApi.getProject.mockResolvedValue(
                createMockWorkspaceProject({ name: 'Team Project' }),
            )

            await expect(
                deleteObject.execute({ type: 'project', id: 'workspace-proj' }, mockTodoistApi),
            ).rejects.toThrow(
                'Workspace project "Team Project" must be archived before it can be deleted',
            )
            expect(mockTodoistApi.deleteProject).not.toHaveBeenCalled()
        })

        it('should allow deletion of archived workspace projects', async () => {
            mockTodoistApi.getProject.mockResolvedValue(
                createMockWorkspaceProject({ isArchived: true }),
            )
            mockTodoistApi.deleteProject.mockResolvedValue(true)

            const result = await deleteObject.execute(
                { type: 'project', id: 'archived-ws-proj' },
                mockTodoistApi,
            )

            expect(mockTodoistApi.deleteProject).toHaveBeenCalledWith('archived-ws-proj')
            expect(result.structuredContent?.success).toBe(true)
        })

        it('should explain a 404 for a workspace project the user has not joined', async () => {
            const expected = mockUnjoinedWorkspaceProject(mockTodoistApi)

            const error = await deleteObject
                .execute({ type: 'project', id: 'unjoined-project-id' }, mockTodoistApi)
                .catch((caught: unknown) => caught)

            expect(formatToolExecutionError(error)).toBe(expected)
            expect(mockTodoistApi.deleteProject).not.toHaveBeenCalled()
        })
    })

    describe('deleting sections', () => {
        it('should delete a section by ID', async () => {
            mockTodoistApi.deleteSection.mockResolvedValue(true)

            const result = await deleteObject.execute(
                { type: 'section', id: 'section-123' },
                mockTodoistApi,
            )

            expect(mockTodoistApi.deleteSection).toHaveBeenCalledWith('section-123')
            expect(mockTodoistApi.deleteProject).not.toHaveBeenCalled()
            expect(mockTodoistApi.deleteTask).not.toHaveBeenCalled()

            const textContent = result.textContent
            expect(textContent).toMatchSnapshot()
            expect(textContent).toContain('Deleted section: id=section-123')
            expect(result.structuredContent).toEqual({
                deletedEntity: { type: 'section', id: 'section-123' },
                success: true,
            })
        })

        it('should propagate section deletion errors', async () => {
            const apiError = new Error('API Error: Section not found')
            mockTodoistApi.deleteSection.mockRejectedValue(apiError)

            await expect(
                deleteObject.execute(
                    { type: 'section', id: 'non-existent-section' },
                    mockTodoistApi,
                ),
            ).rejects.toThrow('API Error: Section not found')
        })
    })

    describe('deleting tasks', () => {
        it('should delete a task by ID', async () => {
            mockTodoistApi.deleteTask.mockResolvedValue(true)

            const result = await deleteObject.execute(
                { type: 'task', id: '8485093748' },
                mockTodoistApi,
            )

            expect(mockTodoistApi.deleteTask).toHaveBeenCalledWith('8485093748')
            expect(mockTodoistApi.deleteProject).not.toHaveBeenCalled()
            expect(mockTodoistApi.deleteSection).not.toHaveBeenCalled()

            const textContent = result.textContent
            expect(textContent).toMatchSnapshot()
            expect(textContent).toContain('Deleted task: id=8485093748')
            expect(result.structuredContent).toEqual({
                deletedEntity: { type: 'task', id: '8485093748' },
                success: true,
            })
        })

        it('should propagate task deletion errors', async () => {
            const apiError = new Error('API Error: Task not found')
            mockTodoistApi.deleteTask.mockRejectedValue(apiError)

            await expect(
                deleteObject.execute({ type: 'task', id: 'non-existent-task' }, mockTodoistApi),
            ).rejects.toThrow('API Error: Task not found')
        })

        it('should handle permission errors', async () => {
            const apiError = new Error('API Error: Insufficient permissions to delete task')
            mockTodoistApi.deleteTask.mockRejectedValue(apiError)

            await expect(
                deleteObject.execute({ type: 'task', id: 'restricted-task' }, mockTodoistApi),
            ).rejects.toThrow('API Error: Insufficient permissions to delete task')
        })
    })

    describe('deleting comments', () => {
        it('should delete a comment by ID', async () => {
            mockTodoistApi.deleteComment.mockResolvedValue(true)

            const result = await deleteObject.execute(
                { type: 'comment', id: 'comment-456' },
                mockTodoistApi,
            )

            expect(mockTodoistApi.deleteComment).toHaveBeenCalledWith('comment-456')
            expect(mockTodoistApi.deleteProject).not.toHaveBeenCalled()
            expect(mockTodoistApi.deleteTask).not.toHaveBeenCalled()

            const textContent = result.textContent
            expect(textContent).toMatchSnapshot()
            expect(textContent).toContain('Deleted comment: id=comment-456')
            expect(result.structuredContent).toEqual({
                deletedEntity: { type: 'comment', id: 'comment-456' },
                success: true,
            })
        })

        it('should propagate comment deletion errors', async () => {
            mockTodoistApi.deleteComment.mockRejectedValue(
                new Error('API Error: Comment not found'),
            )

            await expect(
                deleteObject.execute(
                    { type: 'comment', id: 'non-existent-comment' },
                    mockTodoistApi,
                ),
            ).rejects.toThrow('API Error: Comment not found')
        })
    })

    describe('deleting labels', () => {
        it('should delete a label by ID', async () => {
            mockTodoistApi.deleteLabel.mockResolvedValue(true)

            const result = await deleteObject.execute(
                { type: 'label', id: 'label-123' },
                mockTodoistApi,
            )

            expect(mockTodoistApi.deleteLabel).toHaveBeenCalledWith('label-123')
            expect(mockTodoistApi.deleteProject).not.toHaveBeenCalled()
            expect(mockTodoistApi.deleteTask).not.toHaveBeenCalled()

            const textContent = result.textContent
            expect(textContent).toMatchSnapshot()
            expect(textContent).toContain('Deleted label: id=label-123')
            expect(result.structuredContent).toEqual({
                deletedEntity: { type: 'label', id: 'label-123' },
                success: true,
            })
        })

        it('should propagate label deletion errors', async () => {
            mockTodoistApi.deleteLabel.mockRejectedValue(new Error('API Error: Label not found'))

            await expect(
                deleteObject.execute({ type: 'label', id: 'non-existent-label' }, mockTodoistApi),
            ).rejects.toThrow('API Error: Label not found')
        })
    })

    describe('deleting filters', () => {
        it('should delete a filter by ID', async () => {
            mockTodoistApi.deleteFilter.mockResolvedValue(true)

            const result = await deleteObject.execute(
                { type: 'filter', id: 'filter-123' },
                mockTodoistApi,
            )

            expect(mockTodoistApi.deleteFilter).toHaveBeenCalledWith('filter-123')

            const textContent = result.textContent
            expect(textContent).toContain('Deleted filter: id=filter-123')
            expect(result.structuredContent).toEqual({
                deletedEntity: { type: 'filter', id: 'filter-123' },
                success: true,
            })
        })

        it('should propagate filter deletion errors', async () => {
            mockTodoistApi.deleteFilter.mockRejectedValue(new Error('API Error: Filter not found'))

            await expect(
                deleteObject.execute({ type: 'filter', id: 'non-existent-filter' }, mockTodoistApi),
            ).rejects.toThrow('API Error: Filter not found')
        })
    })

    describe('deleting folders', () => {
        it('should delete a folder by ID and say its projects stay in the workspace', async () => {
            mockTodoistApi.deleteFolder.mockResolvedValue(true)

            const result = await deleteObject.execute(
                { type: 'folder', id: 'folder-123' },
                mockTodoistApi,
            )

            expect(mockTodoistApi.deleteFolder).toHaveBeenCalledWith('folder-123')
            expect(mockTodoistApi.deleteProject).not.toHaveBeenCalled()
            expect(result.textContent).toBe(
                'Deleted folder: id=folder-123. Its projects were kept and moved to the top level of the workspace.',
            )
            expect(result.structuredContent).toEqual({
                deletedEntity: { type: 'folder', id: 'folder-123' },
                success: true,
            })
        })

        it('should propagate folder deletion errors', async () => {
            mockTodoistApi.deleteFolder.mockRejectedValue(new Error('API Error: Forbidden'))

            await expect(
                deleteObject.execute({ type: 'folder', id: 'folder-123' }, mockTodoistApi),
            ).rejects.toThrow('API Error: Forbidden')
        })
    })

    describe('deleting reminders', () => {
        it('should delete a time-based reminder by ID', async () => {
            mockTodoistApi.deleteReminder.mockResolvedValue(true)

            const result = await deleteObject.execute(
                { type: 'reminder', id: 'reminder-123' },
                mockTodoistApi,
            )

            expect(mockTodoistApi.deleteReminder).toHaveBeenCalledWith('reminder-123')
            expect(result.textContent).toContain('Deleted reminder: id=reminder-123')
            expect(result.structuredContent).toEqual({
                deletedEntity: { type: 'reminder', id: 'reminder-123' },
                success: true,
            })
        })

        it('should propagate reminder deletion errors', async () => {
            mockTodoistApi.deleteReminder.mockRejectedValue(
                new Error('API Error: Reminder not found'),
            )

            await expect(
                deleteObject.execute(
                    { type: 'reminder', id: 'non-existent-reminder' },
                    mockTodoistApi,
                ),
            ).rejects.toThrow('API Error: Reminder not found')
        })
    })

    describe('deleting location reminders', () => {
        it('should delete a location reminder by ID', async () => {
            mockTodoistApi.deleteLocationReminder.mockResolvedValue(true)

            const result = await deleteObject.execute(
                { type: 'location_reminder', id: 'loc-reminder-456' },
                mockTodoistApi,
            )

            expect(mockTodoistApi.deleteLocationReminder).toHaveBeenCalledWith('loc-reminder-456')
            expect(result.textContent).toContain('Deleted location_reminder: id=loc-reminder-456')
            expect(result.structuredContent).toEqual({
                deletedEntity: { type: 'location_reminder', id: 'loc-reminder-456' },
                success: true,
            })
        })

        it('should propagate location reminder deletion errors', async () => {
            mockTodoistApi.deleteLocationReminder.mockRejectedValue(
                new Error('API Error: Location reminder not found'),
            )

            await expect(
                deleteObject.execute(
                    { type: 'location_reminder', id: 'non-existent' },
                    mockTodoistApi,
                ),
            ).rejects.toThrow('API Error: Location reminder not found')
        })
    })

    describe('type validation', () => {
        it('should handle all supported entity types', async () => {
            mockTodoistApi.getProject.mockResolvedValue(createMockProject())
            mockTodoistApi.deleteProject.mockResolvedValue(true)
            mockTodoistApi.deleteSection.mockResolvedValue(true)
            mockTodoistApi.deleteTask.mockResolvedValue(true)
            mockTodoistApi.deleteComment.mockResolvedValue(true)
            mockTodoistApi.deleteLabel.mockResolvedValue(true)
            mockTodoistApi.deleteFilter.mockResolvedValue(true)

            await deleteObject.execute({ type: 'project', id: 'proj-1' }, mockTodoistApi)
            expect(mockTodoistApi.deleteProject).toHaveBeenCalledWith('proj-1')

            await deleteObject.execute({ type: 'section', id: 'sect-1' }, mockTodoistApi)
            expect(mockTodoistApi.deleteSection).toHaveBeenCalledWith('sect-1')

            await deleteObject.execute({ type: 'task', id: 'task-1' }, mockTodoistApi)
            expect(mockTodoistApi.deleteTask).toHaveBeenCalledWith('task-1')

            await deleteObject.execute({ type: 'comment', id: 'comment-1' }, mockTodoistApi)
            expect(mockTodoistApi.deleteComment).toHaveBeenCalledWith('comment-1')

            await deleteObject.execute({ type: 'label', id: 'label-1' }, mockTodoistApi)
            expect(mockTodoistApi.deleteLabel).toHaveBeenCalledWith('label-1')

            await deleteObject.execute({ type: 'filter', id: 'filter-1' }, mockTodoistApi)
            expect(mockTodoistApi.deleteFilter).toHaveBeenCalledWith('filter-1')

            expect(mockTodoistApi.deleteProject).toHaveBeenCalledTimes(1)
            expect(mockTodoistApi.deleteSection).toHaveBeenCalledTimes(1)
            expect(mockTodoistApi.deleteTask).toHaveBeenCalledTimes(1)
            expect(mockTodoistApi.deleteComment).toHaveBeenCalledTimes(1)
            expect(mockTodoistApi.deleteLabel).toHaveBeenCalledTimes(1)
            expect(mockTodoistApi.deleteFilter).toHaveBeenCalledTimes(1)
        })
    })

    // Deleting cannot be undone, so a client that can ask the user does, naming what would go.
    describe('asking the user first', () => {
        it('should ask before deleting a task, naming it, and delete nothing yet', async () => {
            mockTodoistApi.getTask.mockResolvedValue(createMockTask({ content: 'Buy milk' }))
            const request = createMockToolRequest('asking')

            const result = await deleteObject.execute(
                { type: 'task', id: '8485093748' },
                mockTodoistApi,
                request,
            )

            expect(request.questions).toEqual([
                { key: 'delete', message: 'Delete the task "Buy milk"? This can\'t be undone.' },
            ])
            expect(result).toEqual({
                inputRequired: expect.objectContaining({ resultType: 'input_required' }),
            })
            expect(mockTodoistApi.deleteTask).not.toHaveBeenCalled()
        })

        it('should delete once the user confirms', async () => {
            mockTodoistApi.deleteTask.mockResolvedValue(true)

            const result = await deleteObject.execute(
                { type: 'task', id: '8485093748' },
                mockTodoistApi,
                createMockToolRequest('confirmed'),
            )

            expect(mockTodoistApi.deleteTask).toHaveBeenCalledWith('8485093748')
            expect(result.structuredContent).toEqual({
                deletedEntity: { type: 'task', id: '8485093748' },
                success: true,
            })
            // The name is looked up only to ask, not again on the call carrying the answer.
            expect(mockTodoistApi.getTask).not.toHaveBeenCalled()
        })

        it('should delete nothing when the user declines, and say not to retry', async () => {
            const result = await deleteObject.execute(
                { type: 'task', id: '8485093748' },
                mockTodoistApi,
                createMockToolRequest('declined'),
            )

            expect(mockTodoistApi.deleteTask).not.toHaveBeenCalled()
            expect(result.structuredContent).toEqual({
                deletedEntity: { type: 'task', id: '8485093748' },
                success: false,
            })
            expect(result.textContent).toBe(
                "Not deleted: the user declined to delete the task (id=8485093748). Don't try again unless they ask.",
            )
        })

        it('should not ask about a workspace project that must be archived first', async () => {
            mockTodoistApi.getProject.mockResolvedValue(
                createMockWorkspaceProject({ name: 'Team Plan', isArchived: false }),
            )
            const request = createMockToolRequest('asking')

            await expect(
                deleteObject.execute({ type: 'project', id: 'wp1' }, mockTodoistApi, request),
            ).rejects.toThrow('must be archived before it can be deleted')
            expect(request.questions).toEqual([])
        })

        it.each([
            {
                type: 'project' as const,
                setUp: () =>
                    mockTodoistApi.getProject.mockResolvedValue(
                        createMockProject({ name: 'Q3 Plan' }),
                    ),
                message:
                    'Delete the project "Q3 Plan" and everything in it? This can\'t be undone.',
            },
            {
                type: 'section' as const,
                setUp: () =>
                    mockTodoistApi.getSection.mockResolvedValue(
                        createMockSection({ name: 'Backlog' }),
                    ),
                message: 'Delete the section "Backlog"? This can\'t be undone.',
            },
            {
                type: 'comment' as const,
                setUp: () =>
                    mockTodoistApi.getComment.mockResolvedValue({
                        content: 'Ship it on Friday',
                    } as never),
                message: 'Delete the comment "Ship it on Friday"? This can\'t be undone.',
            },
            {
                type: 'label' as const,
                setUp: () =>
                    mockTodoistApi.getLabel.mockResolvedValue(createMockLabel({ name: 'urgent' })),
                message: 'Delete the label "urgent"? This can\'t be undone.',
            },
            {
                type: 'filter' as const,
                setUp: () =>
                    mockTodoistApi.sync.mockResolvedValue({
                        filters: [createMockFilter({ id: 'f1', name: 'Work today' })],
                    } as never),
                message: 'Delete the filter "Work today"? This can\'t be undone.',
            },
            {
                type: 'folder' as const,
                setUp: () =>
                    mockTodoistApi.getFolder.mockResolvedValue(
                        createMockFolder({ name: 'Design' }),
                    ),
                message:
                    'Delete the folder "Design"? Its projects are kept and moved to the top level of the workspace.',
            },
            {
                type: 'reminder' as const,
                setUp: () => {
                    mockTodoistApi.getReminder.mockResolvedValue({ itemId: 't1' } as never)
                    mockTodoistApi.getTask.mockResolvedValue(
                        createMockTask({ content: 'Pay rent' }),
                    )
                },
                message: 'Delete the reminder on the task "Pay rent"? This can\'t be undone.',
            },
            {
                type: 'location_reminder' as const,
                setUp: () => {
                    mockTodoistApi.getLocationReminder.mockResolvedValue({ itemId: 't1' } as never)
                    mockTodoistApi.getTask.mockResolvedValue(
                        createMockTask({ content: 'Pay rent' }),
                    )
                },
                message:
                    'Delete the location reminder on the task "Pay rent"? This can\'t be undone.',
            },
        ])('should name the $type it would delete', async ({ type, setUp, message }) => {
            setUp()
            const request = createMockToolRequest('asking')

            await deleteObject.execute({ type, id: 'f1' }, mockTodoistApi, request)

            expect(request.questions).toEqual([{ key: 'delete', message }])
        })

        // A filter named like the ID is not the one being deleted.
        it('should name a filter it cannot find by its ID, without logging a failure', async () => {
            mockTodoistApi.sync.mockResolvedValue({
                filters: [createMockFilter({ id: 'f1', name: 'gone-filter' })],
            } as never)
            const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
            const request = createMockToolRequest('asking')

            await deleteObject.execute(
                { type: 'filter', id: 'gone-filter' },
                mockTodoistApi,
                request,
            )

            expect(request.questions).toEqual([
                {
                    key: 'delete',
                    message: "Delete the filter (id=gone-filter)? This can't be undone.",
                },
            ])
            expect(consoleError).not.toHaveBeenCalled()
            consoleError.mockRestore()
        })

        // The name only makes the question clearer: a lookup that fails must not stop a delete.
        describe('when the lookup behind the name fails', () => {
            let consoleError: ReturnType<typeof vi.spyOn>
            beforeEach(() => {
                consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
            })
            afterEach(() => {
                consoleError.mockRestore()
            })

            it.each([
                {
                    type: 'section' as const,
                    setUp: () =>
                        mockTodoistApi.getSection.mockRejectedValue(new Error('Bad Gateway')),
                    deleteCall: () => mockTodoistApi.deleteSection,
                    message: "Delete the section (id=x1)? This can't be undone.",
                },
                {
                    type: 'task' as const,
                    setUp: () => mockTodoistApi.getTask.mockRejectedValue(new Error('Bad Gateway')),
                    deleteCall: () => mockTodoistApi.deleteTask,
                    message: "Delete the task (id=x1)? This can't be undone.",
                },
                {
                    type: 'comment' as const,
                    setUp: () =>
                        mockTodoistApi.getComment.mockRejectedValue(new Error('Bad Gateway')),
                    deleteCall: () => mockTodoistApi.deleteComment,
                    message: "Delete the comment (id=x1)? This can't be undone.",
                },
                {
                    type: 'label' as const,
                    setUp: () =>
                        mockTodoistApi.getLabel.mockRejectedValue(new Error('Bad Gateway')),
                    deleteCall: () => mockTodoistApi.deleteLabel,
                    message: "Delete the label (id=x1)? This can't be undone.",
                },
                {
                    type: 'filter' as const,
                    setUp: () => mockTodoistApi.sync.mockRejectedValue(new Error('Bad Gateway')),
                    deleteCall: () => mockTodoistApi.deleteFilter,
                    message: "Delete the filter (id=x1)? This can't be undone.",
                },
                {
                    type: 'folder' as const,
                    setUp: () =>
                        mockTodoistApi.getFolder.mockRejectedValue(new Error('Bad Gateway')),
                    deleteCall: () => mockTodoistApi.deleteFolder,
                    message:
                        'Delete the folder (id=x1)? Its projects are kept and moved to the top level of the workspace.',
                },
                {
                    type: 'reminder' as const,
                    setUp: () =>
                        mockTodoistApi.getReminder.mockRejectedValue(new Error('Bad Gateway')),
                    deleteCall: () => mockTodoistApi.deleteReminder,
                    message: "Delete the reminder (id=x1)? This can't be undone.",
                },
                {
                    // The reminder itself is found, but the task it is on cannot be read.
                    type: 'location_reminder' as const,
                    setUp: () => {
                        mockTodoistApi.getLocationReminder.mockResolvedValue({
                            itemId: 't1',
                        } as never)
                        mockTodoistApi.getTask.mockRejectedValue(new Error('Bad Gateway'))
                    },
                    deleteCall: () => mockTodoistApi.deleteLocationReminder,
                    message: "Delete the location reminder (id=x1)? This can't be undone.",
                },
            ])(
                'should name the $type by its ID, then delete it once the user confirms',
                async ({ type, setUp, deleteCall, message }) => {
                    setUp()
                    const request = createMockToolRequest('asking')

                    await deleteObject.execute({ type, id: 'x1' }, mockTodoistApi, request)

                    expect(request.questions).toEqual([{ key: 'delete', message }])
                    expect(consoleError).toHaveBeenCalledWith(
                        `delete-object: could not look up the ${type} to name it`,
                        { id: 'x1', error: expect.stringContaining('Bad Gateway') },
                    )
                    expect(deleteCall()).not.toHaveBeenCalled()

                    deleteCall().mockResolvedValue(true)
                    const result = await deleteObject.execute(
                        { type, id: 'x1' },
                        mockTodoistApi,
                        createMockToolRequest('confirmed'),
                    )

                    expect(deleteCall()).toHaveBeenCalledWith('x1')
                    expect(result.structuredContent).toEqual({
                        deletedEntity: { type, id: 'x1' },
                        success: true,
                    })
                },
            )
        })

        it('should shorten a long comment in the question', async () => {
            mockTodoistApi.getComment.mockResolvedValue({ content: 'a'.repeat(200) } as never)
            const request = createMockToolRequest('asking')

            await deleteObject.execute({ type: 'comment', id: 'c1' }, mockTodoistApi, request)

            expect(request.questions[0]?.message).toBe(
                `Delete the comment "${'a'.repeat(79)}…"? This can't be undone.`,
            )
        })
    })
})
