import type { TodoistApi } from '@todoist/sdk'
import { type Mocked, vi } from 'vitest'
import {
    createApiError,
    createMockFolder,
    createMockWorkspace,
    TEST_IDS,
} from '../utils/test-helpers.js'
import { ToolNames } from '../utils/tool-names.js'
import { workspaceResolver } from '../utils/workspace-resolver.js'
import { addFolders } from './add-folders.js'

const mockTodoistApi = {
    getWorkspaces: vi.fn(),
    addFolder: vi.fn(),
} as unknown as Mocked<TodoistApi>

const { ADD_FOLDERS } = ToolNames

describe(`${ADD_FOLDERS} tool`, () => {
    beforeEach(() => {
        vi.clearAllMocks()
        workspaceResolver.clearCache()
        mockTodoistApi.getWorkspaces.mockResolvedValue([
            createMockWorkspace({ id: TEST_IDS.WORKSPACE_1, name: 'Acme' }),
            createMockWorkspace({ id: TEST_IDS.WORKSPACE_2, name: 'Studio' }),
        ])
        mockTodoistApi.addFolder.mockImplementation(async ({ name, workspaceId }) =>
            createMockFolder({ id: `${name.toLowerCase()}-id`, name, workspaceId }),
        )
    })

    it('should create each folder in the workspace it names', async () => {
        const result = await addFolders.execute(
            {
                folders: [
                    { name: 'Marketing', workspace: 'acme' },
                    { name: 'Clients', workspace: TEST_IDS.WORKSPACE_2 },
                    { name: 'Sales', workspace: 'Acme' },
                ],
            },
            mockTodoistApi,
        )

        expect(mockTodoistApi.addFolder.mock.calls).toEqual([
            [{ name: 'Marketing', workspaceId: TEST_IDS.WORKSPACE_1 }],
            [{ name: 'Clients', workspaceId: TEST_IDS.WORKSPACE_2 }],
            [{ name: 'Sales', workspaceId: TEST_IDS.WORKSPACE_1 }],
        ])
        // The workspaces are read once for the whole batch.
        expect(mockTodoistApi.getWorkspaces).toHaveBeenCalledTimes(1)
        expect(result.structuredContent).toEqual({
            folders: [
                { id: 'marketing-id', name: 'Marketing', workspaceId: TEST_IDS.WORKSPACE_1 },
                { id: 'clients-id', name: 'Clients', workspaceId: TEST_IDS.WORKSPACE_2 },
                { id: 'sales-id', name: 'Sales', workspaceId: TEST_IDS.WORKSPACE_1 },
            ],
            failures: [],
            successCount: 3,
            failureCount: 0,
        })
        expect(result.textContent).toMatchSnapshot()
    })

    it('should keep the folders that were created when one is rejected', async () => {
        mockTodoistApi.addFolder
            .mockResolvedValueOnce(createMockFolder({ id: 'marketing-id', name: 'Marketing' }))
            .mockRejectedValueOnce(createApiError({ status: 403, error: 'Forbidden' }))

        const result = await addFolders.execute(
            {
                folders: [
                    { name: 'Marketing', workspace: 'Acme' },
                    { name: 'Sales', workspace: 'Acme' },
                ],
            },
            mockTodoistApi,
        )

        expect(result.structuredContent.folders.map((folder) => folder.id)).toEqual([
            'marketing-id',
        ])
        expect(result.structuredContent.failures).toEqual([
            { item: 'Sales', error: 'Todoist API request failed (HTTP 403)' },
        ])
        expect(result.structuredContent.failureCount).toBe(1)
        expect(result.textContent).toMatchSnapshot()
    })

    it('should fail only the folders whose workspace cannot be found', async () => {
        const result = await addFolders.execute(
            {
                folders: [
                    { name: 'Marketing', workspace: 'Acme' },
                    { name: 'Lost', workspace: 'Nowhere' },
                ],
            },
            mockTodoistApi,
        )

        expect(mockTodoistApi.addFolder).toHaveBeenCalledExactlyOnceWith({
            name: 'Marketing',
            workspaceId: TEST_IDS.WORKSPACE_1,
        })
        expect(result.structuredContent.failures).toEqual([
            { item: 'Lost', error: expect.stringContaining('Nowhere') },
        ])
    })

    it('should not retry a create that may have gone through', async () => {
        mockTodoistApi.addFolder.mockRejectedValueOnce(
            createApiError({ status: 502, error: 'Bad Gateway' }),
        )

        const result = await addFolders.execute(
            { folders: [{ name: 'Marketing', workspace: 'Acme' }] },
            mockTodoistApi,
        )

        expect(mockTodoistApi.addFolder).toHaveBeenCalledTimes(1)
        expect(result.structuredContent.failures).toEqual([
            { item: 'Marketing', error: expect.any(String) },
        ])
    })

    describe('with retries', () => {
        beforeEach(() => {
            vi.useFakeTimers()
        })

        afterEach(() => {
            vi.useRealTimers()
        })

        it('should retry a create the server turned away', async () => {
            mockTodoistApi.addFolder.mockRejectedValueOnce(
                createApiError({ status: 503, error: 'Service Unavailable' }),
            )

            const promise = addFolders.execute(
                { folders: [{ name: 'Marketing', workspace: 'Acme' }] },
                mockTodoistApi,
            )
            await vi.runAllTimersAsync()
            const result = await promise

            expect(mockTodoistApi.addFolder).toHaveBeenCalledTimes(2)
            expect(result.structuredContent.successCount).toBe(1)
            expect(result.structuredContent.failureCount).toBe(0)
        })

        it('should share one workspace lookup, retries included, between folders naming it', async () => {
            mockTodoistApi.getWorkspaces.mockRejectedValue(
                createApiError({ status: 503, error: 'Service Unavailable' }),
            )

            const promise = addFolders.execute(
                {
                    folders: [
                        { name: 'Marketing', workspace: 'Acme' },
                        { name: 'Sales', workspace: 'Acme' },
                    ],
                },
                mockTodoistApi,
            )
            await vi.runAllTimersAsync()
            const result = await promise

            // One first attempt and two retries, however many folders name the workspace.
            expect(mockTodoistApi.getWorkspaces).toHaveBeenCalledTimes(3)
            expect(mockTodoistApi.addFolder).not.toHaveBeenCalled()
            expect(result.structuredContent.failures.map((failure) => failure.item)).toEqual([
                'Marketing',
                'Sales',
            ])
        })
    })
})
