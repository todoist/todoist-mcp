import { TodoistApi } from '@todoist/sdk'
import { createMockWorkspaceProject, toApiPayload, toFetchResponse } from '../utils/test-helpers.js'
import { updateProjects } from './update-projects.js'

describe('Moving a project between folders through the real SDK', () => {
    it.each([
        { folderId: 'folder-123', sent: 'folder-123' },
        // The endpoint reads a null folder_id as the top level of the workspace.
        { folderId: 'remove', sent: null },
    ])('sends folder_id $sent for folderId $folderId', async ({ folderId, sent }) => {
        const bodies: unknown[] = []
        const client = new TodoistApi('unused-test-token', {
            baseUrl: 'https://todoist.invalid',
            customFetch: async (url, init) => {
                if (`${init?.method} ${new URL(url).pathname}` !== 'POST /api/v1/projects/p-1') {
                    throw new Error(`Unexpected request: ${init?.method} ${url}`)
                }
                bodies.push(JSON.parse(String(init?.body)))
                return toFetchResponse(
                    toApiPayload(createMockWorkspaceProject({ id: 'p-1', folderId: sent })),
                )
            },
        })

        const result = await updateProjects.execute({ projects: [{ id: 'p-1', folderId }] }, client)

        expect(bodies).toEqual([{ folder_id: sent }])
        expect(result.structuredContent.failures).toEqual([])
    })
})

describe('Changing a project icon through the real SDK', () => {
    it.each([
        { icon: 'house', sent: 'house' },
        // The endpoint reads a null icon as the default `#` icon.
        { icon: 'remove', sent: null },
    ] as const)('sends icon $sent for icon $icon', async ({ icon, sent }) => {
        const bodies: unknown[] = []
        const client = new TodoistApi('unused-test-token', {
            baseUrl: 'https://todoist.invalid',
            customFetch: async (url, init) => {
                if (`${init?.method} ${new URL(url).pathname}` !== 'POST /api/v1/projects/p-1') {
                    throw new Error(`Unexpected request: ${init?.method} ${url}`)
                }
                bodies.push(JSON.parse(String(init?.body)))
                return toFetchResponse(
                    toApiPayload(createMockWorkspaceProject({ id: 'p-1', icon: sent })),
                )
            },
        })

        const result = await updateProjects.execute({ projects: [{ id: 'p-1', icon }] }, client)

        expect(bodies).toEqual([{ icon: sent }])
        expect(result.structuredContent.failures).toEqual([])
        expect(result.structuredContent.projects).toEqual([
            expect.objectContaining({ id: 'p-1', icon: sent ?? undefined }),
        ])
    })
})
