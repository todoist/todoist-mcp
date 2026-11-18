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
} as unknown as Mocked<TodoistApi>

const { UPDATE_TEMPLATE } = ToolNames

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
    // import-project-template's does. Clients read the advertised pattern.
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
