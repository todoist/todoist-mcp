import { TodoistApi, type WorkspaceProject } from '@todoist/sdk'
import { createMockWorkspaceProject, toFetchResponse } from '../utils/test-helpers.js'
import { updateProjects } from './update-projects.js'

function toApiProject(project: WorkspaceProject) {
    return Object.fromEntries(
        Object.entries(project).map(([key, value]) => [
            key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
            value,
        ]),
    )
}

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
                    toApiProject(createMockWorkspaceProject({ id: 'p-1', folderId: sent })),
                )
            },
        })

        const result = await updateProjects.execute({ projects: [{ id: 'p-1', folderId }] }, client)

        expect(bodies).toEqual([{ folder_id: sent }])
        expect(result.structuredContent.failures).toEqual([])
    })
})
