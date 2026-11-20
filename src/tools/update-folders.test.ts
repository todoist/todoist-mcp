import type { TodoistApi } from '@todoist/sdk'
import { type Mocked, vi } from 'vitest'
import { createApiError, createMockFolder, TEST_IDS } from '../utils/test-helpers.js'
import { ToolNames } from '../utils/tool-names.js'
import { updateFolders } from './update-folders.js'

const mockTodoistApi = {
    updateFolder: vi.fn(),
} as unknown as Mocked<TodoistApi>

const { UPDATE_FOLDERS } = ToolNames

describe(`${UPDATE_FOLDERS} tool`, () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('should rename each folder', async () => {
        mockTodoistApi.updateFolder.mockImplementation(async (id, { name }) =>
            createMockFolder({ id, name: name ?? undefined }),
        )

        const result = await updateFolders.execute(
            {
                folders: [
                    { id: TEST_IDS.FOLDER_1, name: 'Growth' },
                    { id: TEST_IDS.FOLDER_2, name: 'Partners' },
                ],
            },
            mockTodoistApi,
        )

        expect(mockTodoistApi.updateFolder.mock.calls).toEqual([
            [TEST_IDS.FOLDER_1, { name: 'Growth' }],
            [TEST_IDS.FOLDER_2, { name: 'Partners' }],
        ])
        expect(result.structuredContent).toEqual({
            folders: [
                { id: TEST_IDS.FOLDER_1, name: 'Growth', workspaceId: TEST_IDS.WORKSPACE_1 },
                { id: TEST_IDS.FOLDER_2, name: 'Partners', workspaceId: TEST_IDS.WORKSPACE_1 },
            ],
            failures: [],
            successCount: 2,
            failureCount: 0,
        })
        expect(result.textContent).toMatchSnapshot()
    })

    it('should keep the folders that were renamed when one is rejected', async () => {
        mockTodoistApi.updateFolder
            .mockResolvedValueOnce(createMockFolder({ id: TEST_IDS.FOLDER_1, name: 'Growth' }))
            .mockRejectedValueOnce(createApiError({ status: 404, error: 'Folder not found' }))

        const result = await updateFolders.execute(
            {
                folders: [
                    { id: TEST_IDS.FOLDER_1, name: 'Growth' },
                    { id: 'missing-folder', name: 'Partners' },
                ],
            },
            mockTodoistApi,
        )

        expect(result.structuredContent.folders.map((folder) => folder.id)).toEqual([
            TEST_IDS.FOLDER_1,
        ])
        expect(result.structuredContent.failures).toEqual([
            { item: 'missing-folder', error: expect.stringContaining('Folder not found') },
        ])
        expect(result.textContent).toMatchSnapshot()
    })
})
