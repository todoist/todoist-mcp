import type { TodoistApi } from '@todoist/sdk'
import { type Mocked, vi } from 'vitest'
import { z } from 'zod'
import {
    createMockTemplate,
    createMockWorkspace,
    getAdvertisedPattern,
} from '../utils/test-helpers.js'
import { ToolNames } from '../utils/tool-names.js'
import { workspaceResolver } from '../utils/workspace-resolver.js'
import { updateTemplate } from './update-template.js'

const mockTodoistApi = {
    updateTemplate: vi.fn(),
    getWorkspaces: vi.fn(),
    getTemplateContent: vi.fn(),
} as unknown as Mocked<TodoistApi>

const { UPDATE_TEMPLATE } = ToolNames

// Content as the SDK returns it: numeric priorities, complete dates.
function sdkContent(
    tasks: Array<{ id: string; content: string; priority?: number; responsibleUid?: string }>,
) {
    return {
        templateType: 'project' as const,
        workspaceId: null,
        content: {
            projects: [{ viewStyle: 'list' as const }],
            sections: [],
            tasks,
            comments: [],
            projectComments: [],
            projectViewOptionsDefaults: [],
        },
    }
}

// The same content as a tool takes it: p1–p4 priorities.
const EDITED = {
    projects: [{ viewStyle: 'board' as const }],
    sections: [],
    tasks: [
        { id: 't1', content: 'Plan', priority: 'p1' as const },
        { id: 't2', content: 'Ship' },
    ],
    comments: [],
    projectComments: [],
    projectViewOptionsDefaults: [],
}

describe(`${UPDATE_TEMPLATE} tool`, () => {
    beforeEach(() => {
        vi.clearAllMocks()
        workspaceResolver.clearCache()
        mockTodoistApi.updateTemplate.mockResolvedValue(createMockTemplate({ name: 'Renamed' }))
    })

    it('sends only the fields to change', async () => {
        const result = await updateTemplate.execute(
            { templateId: 'UT_28Ex1', name: 'Renamed', color: 'blue' },
            mockTodoistApi,
        )

        expect(mockTodoistApi.updateTemplate).toHaveBeenCalledWith('UT_28Ex1', {
            name: 'Renamed',
            description: undefined,
            color: 'blue',
            projectId: undefined,
            workspaceId: undefined,
            sharedWithWorkspaceMembers: undefined,
        })
        expect(result.structuredContent).toEqual({
            templateId: 'UT_28Ex1',
            name: 'Renamed',
            sharedWithWorkspaceMembers: false,
        })
        expect(result.textContent).toBe(
            'Updated template "Renamed" (id=UT_28Ex1). It is a personal template.',
        )
    })

    it('resolves the workspace by name and reports sharing', async () => {
        mockTodoistApi.getWorkspaces.mockResolvedValue([
            createMockWorkspace({ id: '111', name: 'Engineering' }),
        ])
        mockTodoistApi.updateTemplate.mockResolvedValue(
            createMockTemplate({ workspaceId: '111', sharedWithWorkspaceMembers: true }),
        )

        const result = await updateTemplate.execute(
            {
                templateId:
                    'https://app.todoist.com/app/templates/category/my-templates/UT_28Ex1/view',
                workspace: 'Engineering',
                sharedWithWorkspaceMembers: true,
            },
            mockTodoistApi,
        )

        expect(mockTodoistApi.updateTemplate).toHaveBeenCalledWith(
            'UT_28Ex1',
            expect.objectContaining({ workspaceId: '111', sharedWithWorkspaceMembers: true }),
        )
        expect(result.textContent).toContain('in workspace (id=111) and shared with its members.')
        expect(result.structuredContent).toEqual(
            expect.objectContaining({ workspaceId: '111', sharedWithWorkspaceMembers: true }),
        )
    })

    it("replaces the template's content from a project", async () => {
        await updateTemplate.execute(
            { templateId: 'UT_28Ex1', projectId: 'project-1' },
            mockTodoistApi,
        )

        expect(mockTodoistApi.updateTemplate).toHaveBeenCalledWith(
            'UT_28Ex1',
            expect.objectContaining({ projectId: 'project-1', name: undefined }),
        )
    })

    it('stops sharing when that is the only change', async () => {
        mockTodoistApi.updateTemplate.mockResolvedValue(
            createMockTemplate({ workspaceId: '111', sharedWithWorkspaceMembers: false }),
        )

        const result = await updateTemplate.execute(
            { templateId: 'UT_28Ex1', sharedWithWorkspaceMembers: false },
            mockTodoistApi,
        )

        expect(mockTodoistApi.updateTemplate).toHaveBeenCalledWith(
            'UT_28Ex1',
            expect.objectContaining({ sharedWithWorkspaceMembers: false }),
        )
        expect(result.textContent).toContain('not shared with its members')
    })

    describe('content', () => {
        let consoleError: ReturnType<typeof vi.spyOn>
        beforeEach(() => {
            consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
        })
        afterEach(() => {
            consoleError.mockRestore()
        })

        it('sends the content with SDK priorities and reports what changed', async () => {
            mockTodoistApi.getTemplateContent
                .mockResolvedValueOnce(sdkContent([{ id: 'a', content: 'Plan', priority: 1 }]))
                .mockResolvedValueOnce({
                    ...sdkContent([
                        { id: 'b', content: 'Plan', priority: 4 },
                        { id: 'c', content: 'Ship', priority: 1 },
                    ]),
                    content: {
                        ...sdkContent([]).content,
                        projects: [{ viewStyle: 'board' as const }],
                        tasks: [
                            { id: 'b', content: 'Plan', priority: 4 },
                            { id: 'c', content: 'Ship', priority: 1 },
                        ],
                    },
                })

            const result = await updateTemplate.execute(
                { templateId: 'UT_28Ex1', content: EDITED },
                mockTodoistApi,
            )

            expect(mockTodoistApi.updateTemplate).toHaveBeenCalledWith(
                'UT_28Ex1',
                expect.objectContaining({
                    content: expect.objectContaining({
                        projects: [{ viewStyle: 'board' }],
                        tasks: [
                            expect.objectContaining({ id: 't1', content: 'Plan', priority: 4 }),
                            expect.objectContaining({ id: 't2', content: 'Ship' }),
                        ],
                    }),
                }),
            )
            expect(result.textContent).toContain(
                'Content: layout list → board, sections 0 → 0, tasks 1 → 2, assigned tasks 0 → 0, comments 0 → 0.',
            )
        })

        it('refuses content together with a project, without reading or saving', async () => {
            await expect(
                updateTemplate.execute(
                    { templateId: 'UT_28Ex1', content: EDITED, projectId: 'project-1' },
                    mockTodoistApi,
                ),
            ).rejects.toThrow('Provide either `content` or `projectId`, not both')
            expect(mockTodoistApi.getTemplateContent).not.toHaveBeenCalled()
            expect(mockTodoistApi.updateTemplate).not.toHaveBeenCalled()
        })

        it('says when the saved content could not be read back, rather than guessing', async () => {
            mockTodoistApi.getTemplateContent
                .mockResolvedValueOnce(sdkContent([{ id: 'a', content: 'Plan', priority: 1 }]))
                .mockRejectedValueOnce(new Error('Network down'))

            const result = await updateTemplate.execute(
                { templateId: 'UT_28Ex1', content: EDITED },
                mockTodoistApi,
            )

            expect(mockTodoistApi.updateTemplate).toHaveBeenCalledTimes(1)
            expect(result.textContent).toContain(
                'The content was saved, but could not be read back to compare.',
            )
            expect(result.textContent).not.toContain('Content: layout')
            expect(consoleError).toHaveBeenCalledWith(
                'update-template: could not read the content after saving',
                { error: expect.stringContaining('Network down') },
            )
        })

        // The backend drops assignees who aren't workspace members. An addition in the same
        // edit must not hide that: compare what was sent with what was saved.
        it('names what the save dropped, even when the edit also added something', async () => {
            const assigned = {
                ...EDITED,
                tasks: [
                    { id: 't1', content: 'Plan', responsibleUid: '42' },
                    { id: 't2', content: 'Ship', responsibleUid: '43' },
                ],
            }
            mockTodoistApi.getTemplateContent
                .mockResolvedValueOnce(
                    sdkContent([{ id: 'a', content: 'Plan', responsibleUid: '42' }]),
                )
                .mockResolvedValueOnce(
                    sdkContent([
                        { id: 'b', content: 'Plan', responsibleUid: '42' },
                        { id: 'c', content: 'Ship' },
                    ]),
                )

            const result = await updateTemplate.execute(
                { templateId: 'UT_28Ex1', content: assigned },
                mockTodoistApi,
            )

            // Previous to saved shows no change in assigned tasks: 1 → 1.
            expect(result.textContent).toContain('assigned tasks 1 → 1')
            expect(result.textContent).toContain(
                'Not everything sent was kept: assigned tasks sent 2, saved 1.',
            )
        })

        it('saves even when the previous content cannot be read, and says so', async () => {
            mockTodoistApi.getTemplateContent
                .mockRejectedValueOnce(new Error('Rate limited'))
                .mockResolvedValueOnce(sdkContent([{ id: 'b', content: 'Plan' }]))

            const result = await updateTemplate.execute(
                { templateId: 'UT_28Ex1', content: EDITED },
                mockTodoistApi,
            )

            expect(mockTodoistApi.updateTemplate).toHaveBeenCalledTimes(1)
            expect(result.textContent).toContain(
                'The previous content could not be read, so the change is not reported.',
            )
            expect(consoleError).toHaveBeenCalledWith(
                'update-template: could not read the content before saving',
                { error: expect.stringContaining('Rate limited') },
            )
        })
    })

    it('refuses to edit a gallery template', async () => {
        await expect(
            updateTemplate.execute({ templateId: 'product-launch', name: 'Mine' }, mockTodoistApi),
        ).rejects.toThrow('is not a saved template ID')
        expect(mockTodoistApi.updateTemplate).not.toHaveBeenCalled()
    })

    it('says an unrecognized color was ignored when it was the only change', async () => {
        const args = z.object(updateTemplate.parameters).parse({
            templateId: 'UT_28Ex1',
            color: 'not-a-color',
        })

        await expect(updateTemplate.execute(args, mockTodoistApi)).rejects.toThrow(
            'An unrecognized color is ignored',
        )
        expect(mockTodoistApi.updateTemplate).not.toHaveBeenCalled()
    })

    it('refuses a call that changes nothing', async () => {
        await expect(
            updateTemplate.execute({ templateId: 'UT_28Ex1' }, mockTodoistApi),
        ).rejects.toThrow('Nothing to update')
        expect(mockTodoistApi.updateTemplate).not.toHaveBeenCalled()
    })

    // templateId is model-supplied, so the schema narrows it to Todoist hosts, as
    // import-into-project's does. Clients read the advertised pattern.
    describe('templateId validation', () => {
        const schema = z.object(updateTemplate.parameters)
        const pattern = getAdvertisedPattern(updateTemplate.parameters, 'templateId')

        it.each([
            'UT_28ExampleTemplateId000001',
            'https://app.todoist.com/app/templates/category/my-templates/UT_28Ex1/view',
        ])('accepts %s', (templateId) => {
            expect(schema.safeParse({ templateId, name: 'Renamed' }).success).toBe(true)
            expect(pattern.test(templateId)).toBe(true)
        })

        it.each([
            'https://attacker.example/templates/UT_28Ex1',
            'https://todoist.com.attacker.example/templates/UT_28Ex1',
            'http://todoist.com/templates/UT_28Ex1',
        ])('rejects %s', (templateId) => {
            expect(schema.safeParse({ templateId, name: 'Renamed' }).success).toBe(false)
            expect(pattern.test(templateId)).toBe(false)
        })
    })
})
