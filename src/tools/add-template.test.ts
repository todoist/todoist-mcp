import type { TodoistApi } from '@todoist/sdk'
import { type Mocked, vi } from 'vitest'
import { z } from 'zod'
import { formatToolExecutionError } from '../tool-execution-error.js'
import { executeWithRetry } from '../utils/retry.js'
import {
    createApiError,
    createMockProject,
    createMockTemplate,
    createMockWorkspace,
    createMockWorkspaceProject,
    TEST_IDS,
} from '../utils/test-helpers.js'
import { ToolNames } from '../utils/tool-names.js'
import { workspaceResolver } from '../utils/workspace-resolver.js'
import { addTemplate } from './add-template.js'

const mockTodoistApi = {
    saveProjectAsTemplate: vi.fn(),
    previewProjectAsTemplate: vi.fn(),
    previewTemplateFromCsv: vi.fn(),
    addTemplate: vi.fn(),
    updateTemplate: vi.fn(),
    getProject: vi.fn(),
    getWorkspaces: vi.fn(),
    getWorkspaceActiveProjects: vi.fn(),
} as unknown as Mocked<TodoistApi>

const { ADD_TEMPLATE } = ToolNames

const EDITED = {
    projects: [{ viewStyle: 'list' as const }],
    sections: [],
    tasks: [{ id: 't1', content: 'Plan', priority: 'p1' as const }],
    comments: [],
    projectComments: [],
    projectViewOptionsDefaults: [],
}

const SAVE = { preview: false, name: 'Launch plan', description: 'A launch' }

describe(`${ADD_TEMPLATE} tool`, () => {
    beforeEach(() => {
        vi.clearAllMocks()
        workspaceResolver.clearCache()
        mockTodoistApi.saveProjectAsTemplate.mockResolvedValue(createMockTemplate())
        mockTodoistApi.addTemplate.mockResolvedValue(createMockTemplate())
        mockTodoistApi.getProject.mockResolvedValue(
            createMockProject({ id: 'project-1', color: 'berry_red' }),
        )
        mockTodoistApi.getWorkspaces.mockResolvedValue([createMockWorkspace()])
    })

    describe('draft', () => {
        it('returns a blank draft without a project, a CSV or any request', async () => {
            const result = await addTemplate.execute({}, mockTodoistApi)

            expect(mockTodoistApi.previewProjectAsTemplate).not.toHaveBeenCalled()
            expect(mockTodoistApi.previewTemplateFromCsv).not.toHaveBeenCalled()
            expect(result.structuredContent).toEqual({
                content: {
                    projects: [{ viewStyle: 'list' }],
                    sections: [],
                    tasks: [],
                    comments: [],
                    projectComments: [],
                    projectViewOptionsDefaults: [],
                },
            })
            expect(result.textContent).toBe(
                'Blank template draft, not saved: list layout, 0 sections, 0 tasks.\nAdd sections and tasks to its `content`. Before saving, show the user the draft and ask whether to change anything. Then call add-template again with preview: false, a name and description, and the `content`.',
            )
        })

        it("returns a project's draft without saving anything", async () => {
            mockTodoistApi.previewProjectAsTemplate.mockResolvedValue({
                templateType: 'project',
                workspaceId: null,
                content: {
                    projects: [{ viewStyle: 'board', description: null, icon: null }],
                    sections: [{ id: 's1', name: 'Week 1', description: null }],
                    tasks: [
                        { id: 't1', content: 'Plan', sectionId: 's1', priority: 4 },
                        { id: 't2', content: 'Details', parentId: 't1', priority: 1 },
                    ],
                    comments: [],
                    projectComments: [],
                    projectViewOptionsDefaults: [],
                },
            })

            const result = await addTemplate.execute(
                { projectId: 'project-1', name: 'Launch plan', description: 'A launch' },
                mockTodoistApi,
            )

            expect(mockTodoistApi.previewProjectAsTemplate).toHaveBeenCalledWith('project-1')
            expect(mockTodoistApi.saveProjectAsTemplate).not.toHaveBeenCalled()
            expect(result.structuredContent).toEqual({
                content: {
                    projects: [{ viewStyle: 'board' }],
                    sections: [{ id: 's1', name: 'Week 1' }],
                    tasks: [
                        { id: 't1', content: 'Plan', sectionId: 's1', priority: 'p1' },
                        { id: 't2', content: 'Details', parentId: 't1', priority: 'p4' },
                    ],
                    comments: [],
                    projectComments: [],
                    projectViewOptionsDefaults: [],
                },
            })
            expect(result.textContent).toBe(
                'Draft of project (id=project-1) as a template, not saved: board layout, 1 section, 2 tasks.\n- Plan [Week 1]\n    - Details\nBefore saving, show the user the draft and ask whether to change anything. Then call add-template again with preview: false, a name and description, and the edited `content` if it changed.',
            )
        })

        // Dates and comments go back as they came, so a recurring due keeps its time and timezone.
        it('saves a project draft with its dates and comments as they came', async () => {
            const due = {
                date: '2026-11-23T09:00:00',
                string: 'every monday at 9am',
                lang: 'en',
                isRecurring: true,
                timezone: 'Europe/Rome',
            }
            mockTodoistApi.previewProjectAsTemplate.mockResolvedValue({
                templateType: 'project',
                workspaceId: null,
                content: {
                    projects: [{ viewStyle: 'list' }],
                    sections: [],
                    tasks: [{ id: 't1', content: 'Review', priority: 1, due }],
                    comments: [{ taskId: 't1', content: 'Keep it short' }],
                    projectComments: [],
                    projectViewOptionsDefaults: [],
                },
            })

            const draft = await addTemplate.execute({ projectId: 'project-1' }, mockTodoistApi)
            const content = (draft.structuredContent as { content: typeof EDITED }).content
            await addTemplate.execute(
                { projectId: 'project-1', ...SAVE, color: 'blue', content },
                mockTodoistApi,
            )

            expect(content.tasks[0]).toEqual(expect.objectContaining({ due }))
            expect(mockTodoistApi.saveProjectAsTemplate).toHaveBeenCalledWith(
                expect.objectContaining({
                    content: expect.objectContaining({
                        tasks: [expect.objectContaining({ id: 't1', due })],
                        comments: [
                            expect.objectContaining({ taskId: 't1', content: 'Keep it short' }),
                        ],
                    }),
                }),
            )
        })

        it("returns a CSV's draft without creating a template", async () => {
            mockTodoistApi.previewTemplateFromCsv.mockResolvedValue({
                templateType: 'project',
                workspaceId: null,
                uploadedFileName: 'staged.csv',
                content: {
                    projects: [{ viewStyle: 'list', description: null, icon: null }],
                    sections: [],
                    tasks: [{ id: 't1', content: 'Plan', priority: 1 }],
                    comments: [],
                    projectComments: [],
                    projectViewOptionsDefaults: [],
                },
            })

            const result = await addTemplate.execute(
                { csvFileContent: 'TYPE,CONTENT\ntask,Plan' },
                mockTodoistApi,
            )

            const file = mockTodoistApi.previewTemplateFromCsv.mock.calls[0]?.[0].file
            expect(file).toBeInstanceOf(Blob)
            expect(await (file as Blob).text()).toBe('TYPE,CONTENT\ntask,Plan')
            expect(mockTodoistApi.addTemplate).not.toHaveBeenCalled()
            expect(result.textContent).toContain(
                'Draft of the CSV as a template, not saved: list layout, 0 sections, 1 task.',
            )
        })

        it('outlines given content without saving it', async () => {
            const result = await addTemplate.execute({ content: EDITED }, mockTodoistApi)

            expect(mockTodoistApi.addTemplate).not.toHaveBeenCalled()
            expect(mockTodoistApi.saveProjectAsTemplate).not.toHaveBeenCalled()
            expect(result.structuredContent).toEqual({ content: EDITED })
            expect(result.textContent).toContain(
                'Template draft, not saved: list layout, 0 sections, 1 task.\n- Plan',
            )
        })
    })

    describe('saving from a project', () => {
        it("saves a personal template in the project's color", async () => {
            const result = await addTemplate.execute(
                { projectId: 'project-1', ...SAVE },
                mockTodoistApi,
            )

            expect(mockTodoistApi.saveProjectAsTemplate).toHaveBeenCalledWith({
                projectId: 'project-1',
                name: 'Launch plan',
                description: 'A launch',
                color: 'berry_red',
                forWorkspace: undefined,
                content: undefined,
            })
            expect(mockTodoistApi.updateTemplate).not.toHaveBeenCalled()
            expect(result.structuredContent).toEqual({
                templateId: 'UT_28Ex1',
                name: 'Launch plan',
            })
            expect(result.textContent).toBe(
                'Created template "Launch plan" (id=UT_28Ex1) from project (id=project-1). It is in your personal templates. Use add-projects with this templateId to start a new project from it.',
            )
        })

        it('uses the given color without reading the project', async () => {
            await addTemplate.execute(
                { projectId: 'project-1', ...SAVE, color: 'blue' },
                mockTodoistApi,
            )

            expect(mockTodoistApi.getProject).not.toHaveBeenCalled()
            expect(mockTodoistApi.saveProjectAsTemplate).toHaveBeenCalledWith(
                expect.objectContaining({ color: 'blue' }),
            )
        })

        it('falls back to charcoal when the project color is not one it recognizes', async () => {
            mockTodoistApi.getProject.mockResolvedValue(
                createMockProject({ id: 'project-1', color: 'not-a-color' }),
            )

            await addTemplate.execute({ projectId: 'project-1', ...SAVE }, mockTodoistApi)

            expect(mockTodoistApi.saveProjectAsTemplate).toHaveBeenCalledWith(
                expect.objectContaining({ color: 'charcoal' }),
            )
        })

        it('saves an edited draft instead of the project as it is', async () => {
            await addTemplate.execute(
                { projectId: 'project-1', ...SAVE, color: 'blue', content: EDITED },
                mockTodoistApi,
            )

            expect(mockTodoistApi.saveProjectAsTemplate).toHaveBeenCalledWith(
                expect.objectContaining({
                    projectId: 'project-1',
                    content: expect.objectContaining({
                        projects: [{ viewStyle: 'list' }],
                        tasks: [{ id: 't1', content: 'Plan', priority: 4 }],
                    }),
                }),
            )
        })

        it('saves a personal project as a personal template, then moves it into the workspace', async () => {
            mockTodoistApi.getProject.mockResolvedValue(createMockProject({ id: 'project-1' }))
            mockTodoistApi.updateTemplate.mockResolvedValue(
                createMockTemplate({ workspaceId: TEST_IDS.WORKSPACE_1 }),
            )

            const result = await addTemplate.execute(
                { projectId: 'project-1', ...SAVE, workspace: 'Test Workspace' },
                mockTodoistApi,
            )

            expect(mockTodoistApi.saveProjectAsTemplate).toHaveBeenCalledWith(
                expect.objectContaining({ forWorkspace: undefined }),
            )
            expect(mockTodoistApi.updateTemplate).toHaveBeenCalledWith('UT_28Ex1', {
                workspaceId: TEST_IDS.WORKSPACE_1,
                sharedWithWorkspaceMembers: undefined,
            })
            expect(result.structuredContent).toEqual(
                expect.objectContaining({ workspaceId: TEST_IDS.WORKSPACE_1 }),
            )
        })

        it("shares a template saved into the project's own workspace, without moving it", async () => {
            mockTodoistApi.getProject.mockResolvedValue(createMockWorkspaceProject())
            mockTodoistApi.saveProjectAsTemplate.mockResolvedValue(
                createMockTemplate({ workspaceId: TEST_IDS.WORKSPACE_1 }),
            )
            mockTodoistApi.updateTemplate.mockResolvedValue(
                createMockTemplate({
                    workspaceId: TEST_IDS.WORKSPACE_1,
                    sharedWithWorkspaceMembers: true,
                }),
            )

            await addTemplate.execute(
                {
                    projectId: TEST_IDS.PROJECT_WORKSPACE,
                    ...SAVE,
                    workspace: 'Test Workspace',
                    sharedWithWorkspaceMembers: true,
                },
                mockTodoistApi,
            )

            expect(mockTodoistApi.updateTemplate).toHaveBeenCalledWith('UT_28Ex1', {
                workspaceId: undefined,
                sharedWithWorkspaceMembers: true,
            })
        })

        it('saves a project from another workspace as personal, then moves it', async () => {
            mockTodoistApi.getProject.mockResolvedValue(
                createMockWorkspaceProject({ workspaceId: 'other-workspace' }),
            )
            mockTodoistApi.updateTemplate.mockResolvedValue(
                createMockTemplate({ workspaceId: TEST_IDS.WORKSPACE_1 }),
            )

            await addTemplate.execute(
                { projectId: TEST_IDS.PROJECT_WORKSPACE, ...SAVE, workspace: 'Test Workspace' },
                mockTodoistApi,
            )

            expect(mockTodoistApi.saveProjectAsTemplate).toHaveBeenCalledWith(
                expect.objectContaining({ forWorkspace: undefined }),
            )
            expect(mockTodoistApi.updateTemplate).toHaveBeenCalledWith('UT_28Ex1', {
                workspaceId: TEST_IDS.WORKSPACE_1,
                sharedWithWorkspaceMembers: undefined,
            })
        })

        it("saves straight into the project's own workspace, keeping assignees", async () => {
            mockTodoistApi.getProject.mockResolvedValue(createMockWorkspaceProject())
            mockTodoistApi.saveProjectAsTemplate.mockResolvedValue(
                createMockTemplate({ workspaceId: TEST_IDS.WORKSPACE_1 }),
            )

            const result = await addTemplate.execute(
                { projectId: TEST_IDS.PROJECT_WORKSPACE, ...SAVE, workspace: 'Test Workspace' },
                mockTodoistApi,
            )

            expect(mockTodoistApi.saveProjectAsTemplate).toHaveBeenCalledWith(
                expect.objectContaining({ forWorkspace: true }),
            )
            expect(mockTodoistApi.updateTemplate).not.toHaveBeenCalled()
            expect(result.structuredContent).toEqual(
                expect.objectContaining({ workspaceId: TEST_IDS.WORKSPACE_1 }),
            )
            expect(result.textContent).toContain(
                `It is in the workspace's templates (workspace id=${TEST_IDS.WORKSPACE_1}), not yet shared with members.`,
            )
        })

        it('explains a project it cannot find, without saving', async () => {
            mockTodoistApi.getProject.mockRejectedValue(
                createApiError({ status: 404, error: 'Not found' }),
            )
            mockTodoistApi.getWorkspaces.mockResolvedValue([])

            await expect(
                addTemplate.execute({ projectId: 'missing', ...SAVE }, mockTodoistApi),
            ).rejects.toThrow("Project missing was not found. It isn't one of the user's projects")
            expect(mockTodoistApi.saveProjectAsTemplate).not.toHaveBeenCalled()
        })

        it('saves nothing when the project cannot be read for its color', async () => {
            mockTodoistApi.getProject.mockRejectedValue(new Error('Project not found'))

            await expect(
                addTemplate.execute({ projectId: 'missing', ...SAVE }, mockTodoistApi),
            ).rejects.toThrow('Project not found')
            expect(mockTodoistApi.saveProjectAsTemplate).not.toHaveBeenCalled()
        })

        // The registrar retries a whole call after a 503, which is safe: nothing was saved.
        it('saves again when the whole call is retried after a 503', async () => {
            vi.useFakeTimers()
            try {
                mockTodoistApi.saveProjectAsTemplate
                    .mockRejectedValueOnce(
                        createApiError({ status: 503, error: 'Service Unavailable' }),
                    )
                    .mockResolvedValueOnce(createMockTemplate())

                const promise = executeWithRetry(() =>
                    addTemplate.execute(
                        { projectId: 'project-1', ...SAVE, color: 'blue' },
                        mockTodoistApi,
                    ),
                )
                await vi.runAllTimersAsync()
                await promise

                expect(mockTodoistApi.saveProjectAsTemplate).toHaveBeenCalledTimes(2)
            } finally {
                vi.useRealTimers()
            }
        })

        // The registrar runs every tool call inside executeWithRetry, which retries a
        // 502/504. Re-running add-template after a save that went through would create
        // a second template.
        it.each([502, 504])(
            'saves once after a %i even when the whole call is retried, as the registrar does',
            async (status) => {
                vi.useFakeTimers()
                try {
                    mockTodoistApi.saveProjectAsTemplate.mockRejectedValue(
                        createApiError({ status, error: 'Gateway error' }),
                    )
                    vi.spyOn(console, 'error').mockImplementation(() => {})

                    const promise = executeWithRetry(() =>
                        addTemplate.execute(
                            { projectId: 'project-1', ...SAVE, color: 'blue' },
                            mockTodoistApi,
                        ),
                    )
                    const caught = promise.catch((error: unknown) => error)
                    await vi.runAllTimersAsync()
                    const error = await caught

                    expect(mockTodoistApi.saveProjectAsTemplate).toHaveBeenCalledTimes(1)
                    // What the model reads, after the registrar formats the error.
                    const formatted = formatToolExecutionError(error)
                    expect(formatted).toContain('The template may have been saved')
                    expect(formatted).toContain('Do not retry')
                    expect(formatted).not.toContain('Retry shortly')
                } finally {
                    vi.useRealTimers()
                }
            },
        )
    })

    describe('saving without a project', () => {
        it('saves content written from scratch as a personal template, in charcoal', async () => {
            const result = await addTemplate.execute({ ...SAVE, content: EDITED }, mockTodoistApi)

            const [args] = mockTodoistApi.addTemplate.mock.calls[0] ?? []
            expect(args).not.toHaveProperty('file')
            expect(args).toEqual(
                expect.objectContaining({
                    name: 'Launch plan',
                    description: 'A launch',
                    color: 'charcoal',
                    content: expect.objectContaining({
                        tasks: [{ id: 't1', content: 'Plan', priority: 4 }],
                    }),
                }),
            )
            expect(mockTodoistApi.saveProjectAsTemplate).not.toHaveBeenCalled()
            expect(result.textContent).toContain(
                'Created template "Launch plan" (id=UT_28Ex1) from the draft. It is in your personal templates.',
            )
        })

        it('uploads the CSV as a file', async () => {
            const result = await addTemplate.execute(
                { ...SAVE, csvFileContent: 'TYPE,CONTENT\ntask,Plan', color: 'blue' },
                mockTodoistApi,
            )

            const [args] = mockTodoistApi.addTemplate.mock.calls[0] ?? []
            expect(args?.fileName).toBe('template.csv')
            const file = args?.file
            expect(file).toBeInstanceOf(Blob)
            expect(await (file as Blob).text()).toBe('TYPE,CONTENT\ntask,Plan')
            expect(args?.color).toBe('blue')
            expect(result.textContent).toContain('from CSV content')
        })

        it('moves the new template into a workspace and shares it, as the app does', async () => {
            mockTodoistApi.updateTemplate.mockResolvedValue(
                createMockTemplate({
                    workspaceId: TEST_IDS.WORKSPACE_1,
                    sharedWithWorkspaceMembers: true,
                }),
            )

            const result = await addTemplate.execute(
                {
                    ...SAVE,
                    content: EDITED,
                    workspace: 'Test Workspace',
                    sharedWithWorkspaceMembers: true,
                },
                mockTodoistApi,
            )

            expect(mockTodoistApi.updateTemplate).toHaveBeenCalledWith('UT_28Ex1', {
                workspaceId: TEST_IDS.WORKSPACE_1,
                sharedWithWorkspaceMembers: true,
            })
            expect(result.structuredContent).toEqual({
                templateId: 'UT_28Ex1',
                name: 'Launch plan',
                workspaceId: TEST_IDS.WORKSPACE_1,
            })
            expect(result.textContent).toContain(
                `It is in the workspace's templates (workspace id=${TEST_IDS.WORKSPACE_1}), shared with members.`,
            )
        })

        it("keeps the API's status and tag when moving the new template fails", async () => {
            mockTodoistApi.updateTemplate.mockRejectedValue(
                createApiError({ status: 403, error: 'Not allowed', tag: 'FORBIDDEN' }),
            )

            const result = await addTemplate.execute(
                { ...SAVE, content: EDITED, workspace: 'Test Workspace' },
                mockTodoistApi,
            )

            expect(result.structuredContent).toMatchObject({
                workspaceError: expect.stringMatching(/Not allowed.*403.*FORBIDDEN/),
            })
        })

        it('reports a template it created but could not move, instead of failing', async () => {
            mockTodoistApi.updateTemplate.mockRejectedValue(new Error('Forbidden'))

            const result = await addTemplate.execute(
                { ...SAVE, content: EDITED, workspace: 'Test Workspace' },
                mockTodoistApi,
            )

            expect(result.structuredContent).toEqual({
                templateId: 'UT_28Ex1',
                name: 'Launch plan',
                workspaceError: 'Forbidden',
            })
            expect(result.textContent).toBe(
                'Created template "Launch plan" (id=UT_28Ex1) from the draft. It is in your personal templates. Moving it into the workspace or sharing it failed: Forbidden. Ask the user to move or share it in Todoist. Use add-projects with this templateId to start a new project from it.',
            )
        })
    })

    describe('input rules', () => {
        it.each([
            ['nothing', {}, 'Nothing to save'],
            ['a project and a CSV', { projectId: 'p', csvFileContent: 'TYPE' }, 'not both'],
            ['a CSV and content', { csvFileContent: 'TYPE', content: EDITED }, 'not both'],
            [
                'sharing without a workspace',
                { content: EDITED, sharedWithWorkspaceMembers: true },
                'Sharing needs `workspace`',
            ],
        ])('saves nothing when given %s', async (_, source, message) => {
            await expect(
                addTemplate.execute({ ...SAVE, ...source }, mockTodoistApi),
            ).rejects.toThrow(message)
            expect(mockTodoistApi.saveProjectAsTemplate).not.toHaveBeenCalled()
            expect(mockTodoistApi.addTemplate).not.toHaveBeenCalled()
        })

        it.each([
            ['no project', { ...EDITED, projects: [] }],
            ['two projects', { ...EDITED, projects: [...EDITED.projects, ...EDITED.projects] }],
            [
                'a numeric priority',
                { ...EDITED, tasks: [{ id: 't1', content: 'Plan', priority: 4 }] },
            ],
        ])('rejects content with %s before any request', (_, content) => {
            const schema = z.object(addTemplate.parameters)

            expect(schema.safeParse({ ...SAVE, content }).success).toBe(false)
            expect(schema.safeParse({ ...SAVE, content: EDITED }).success).toBe(true)
        })

        it('needs a name and a description to save', async () => {
            await expect(
                addTemplate.execute({ preview: false, projectId: 'project-1' }, mockTodoistApi),
            ).rejects.toThrow('A name and a description are required')
        })
    })
})
