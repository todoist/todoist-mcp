import type { TodoistApi } from '@todoist/sdk'
import { type Mocked, vi } from 'vitest'
import {
    createMockApiResponse,
    createMockFolder,
    createMockWorkspace,
    TEST_IDS,
} from '../utils/test-helpers.js'
import { ToolNames } from '../utils/tool-names.js'
import { workspaceResolver } from '../utils/workspace-resolver.js'
import { findFolders } from './find-folders.js'

const mockTodoistApi = {
    getWorkspaces: vi.fn(),
    getFolders: vi.fn(),
} as unknown as Mocked<TodoistApi>

const { FIND_FOLDERS } = ToolNames

const acme = createMockWorkspace({ id: TEST_IDS.WORKSPACE_1, name: 'Acme' })
const studio = createMockWorkspace({ id: TEST_IDS.WORKSPACE_2, name: 'Studio' })

describe(`${FIND_FOLDERS} tool`, () => {
    beforeEach(() => {
        vi.clearAllMocks()
        workspaceResolver.clearCache()
        mockTodoistApi.getWorkspaces.mockResolvedValue([acme, studio])
    })

    describe('one workspace', () => {
        it('should list the folders of the workspace named, in sidebar order', async () => {
            mockTodoistApi.getFolders.mockResolvedValue(
                createMockApiResponse([
                    createMockFolder({ id: TEST_IDS.FOLDER_2, name: 'Sales', defaultOrder: 2 }),
                    createMockFolder({ id: TEST_IDS.FOLDER_1, name: 'Marketing', defaultOrder: 1 }),
                ]),
            )

            const result = await findFolders.execute({ workspace: 'acme' }, mockTodoistApi)

            expect(mockTodoistApi.getFolders).toHaveBeenCalledTimes(1)
            expect(mockTodoistApi.getFolders).toHaveBeenCalledWith({
                workspaceId: TEST_IDS.WORKSPACE_1,
                cursor: null,
                limit: 200,
            })
            expect(result.structuredContent).toEqual({
                folders: [
                    {
                        id: TEST_IDS.FOLDER_1,
                        name: 'Marketing',
                        workspaceId: TEST_IDS.WORKSPACE_1,
                    },
                    { id: TEST_IDS.FOLDER_2, name: 'Sales', workspaceId: TEST_IDS.WORKSPACE_1 },
                ],
                totalCount: 2,
            })
            expect(result.textContent).toMatchSnapshot()
        })

        it('should read every page of folders', async () => {
            mockTodoistApi.getFolders
                .mockResolvedValueOnce(
                    createMockApiResponse(
                        [createMockFolder({ id: TEST_IDS.FOLDER_1, defaultOrder: 1 })],
                        'page-2',
                    ),
                )
                .mockResolvedValueOnce(
                    createMockApiResponse([
                        createMockFolder({ id: TEST_IDS.FOLDER_2, name: 'Sales', defaultOrder: 2 }),
                    ]),
                )

            const result = await findFolders.execute(
                { workspace: TEST_IDS.WORKSPACE_1 },
                mockTodoistApi,
            )

            expect(mockTodoistApi.getFolders).toHaveBeenNthCalledWith(2, {
                workspaceId: TEST_IDS.WORKSPACE_1,
                cursor: 'page-2',
                limit: 200,
            })
            expect(result.structuredContent.folders.map((folder) => folder.id)).toEqual([
                TEST_IDS.FOLDER_1,
                TEST_IDS.FOLDER_2,
            ])
        })

        it('should say when the workspace has no folders', async () => {
            mockTodoistApi.getFolders.mockResolvedValue(createMockApiResponse([]))

            const result = await findFolders.execute({ workspace: 'Acme' }, mockTodoistApi)

            expect(result.structuredContent).toEqual({ folders: [], totalCount: 0 })
            expect(result.textContent).toMatchSnapshot()
        })
    })

    describe('every workspace', () => {
        it('should list the folders of every workspace when none is named', async () => {
            mockTodoistApi.getFolders.mockImplementation(async ({ workspaceId }) =>
                createMockApiResponse(
                    workspaceId === TEST_IDS.WORKSPACE_1
                        ? [createMockFolder({ id: TEST_IDS.FOLDER_1, name: 'Marketing' })]
                        : [
                              createMockFolder({
                                  id: TEST_IDS.FOLDER_2,
                                  name: 'Clients',
                                  workspaceId: TEST_IDS.WORKSPACE_2,
                              }),
                          ],
                ),
            )

            const result = await findFolders.execute({}, mockTodoistApi)

            expect(mockTodoistApi.getFolders).toHaveBeenCalledWith({
                workspaceId: TEST_IDS.WORKSPACE_1,
                cursor: null,
                limit: 200,
            })
            expect(mockTodoistApi.getFolders).toHaveBeenCalledWith({
                workspaceId: TEST_IDS.WORKSPACE_2,
                cursor: null,
                limit: 200,
            })
            expect(result.structuredContent).toEqual({
                folders: [
                    {
                        id: TEST_IDS.FOLDER_1,
                        name: 'Marketing',
                        workspaceId: TEST_IDS.WORKSPACE_1,
                    },
                    { id: TEST_IDS.FOLDER_2, name: 'Clients', workspaceId: TEST_IDS.WORKSPACE_2 },
                ],
                totalCount: 2,
            })
            expect(result.textContent).toMatchSnapshot()
        })

        it('should explain that folders need a workspace when the user has none', async () => {
            mockTodoistApi.getWorkspaces.mockResolvedValue([])

            const result = await findFolders.execute({}, mockTodoistApi)

            expect(mockTodoistApi.getFolders).not.toHaveBeenCalled()
            expect(result.structuredContent).toEqual({ folders: [], totalCount: 0 })
            expect(result.textContent).toMatchSnapshot()
        })
    })

    it('should fail when the workspace named does not exist', async () => {
        await expect(findFolders.execute({ workspace: 'Nowhere' }, mockTodoistApi)).rejects.toThrow(
            /Nowhere/,
        )
        expect(mockTodoistApi.getFolders).not.toHaveBeenCalled()
    })
})
