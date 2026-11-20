import { type PersonalProject, TodoistApi, type WorkspaceProject } from '@todoist/sdk'
import {
    createMockProject,
    createMockWorkspaceProject,
    toFetchResponse,
} from '../utils/test-helpers.js'
import { addProjects } from './add-projects.js'

function toApiProject(project: PersonalProject | WorkspaceProject) {
    return Object.fromEntries(
        Object.entries(project).map(([key, value]) => [
            key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
            value,
        ]),
    )
}

describe('Personal project limits through the real SDK', () => {
    it.each([
        {
            plan: 'Free',
            current: { max_projects: 5, activity_log: true, activity_log_limit: 7 },
            next: { max_projects: 300, activity_log: true, activity_log_limit: -1 },
            successCount: 1,
            failedProjects: ['Second', 'Third'],
        },
        {
            plan: 'Pro',
            current: { max_projects: 300, activity_log: true, activity_log_limit: -1 },
            next: null,
            successCount: 3,
            failedProjects: [],
        },
    ])(
        'respects the $plan plan project limit with Boolean activity logs',
        async ({ current, next, successCount, failedProjects }) => {
            const existingProjects = Array.from({ length: 4 }, (_, index) =>
                toApiProject(createMockProject({ id: `existing-${index}` })),
            )
            let creationRequests = 0
            const client = new TodoistApi('unused-test-token', {
                baseUrl: 'https://todoist.invalid',
                customFetch: async (url, init) => {
                    let payload: unknown
                    switch (`${init?.method} ${new URL(url).pathname}`) {
                        case 'POST /api/v1/sync':
                            payload = {
                                sync_token: 'test-token',
                                full_sync: true,
                                user_plan_limits: { current, next },
                            }
                            break
                        case 'GET /api/v1/projects':
                            payload = { results: existingProjects, next_cursor: null }
                            break
                        case 'POST /api/v1/projects':
                            // Accept every write: enforcement must come from the tool,
                            // not an API rejection beyond the advertised limit.
                            creationRequests++
                            payload = toApiProject(
                                createMockProject({ id: 'created', name: 'First' }),
                            )
                            break
                        default:
                            throw new Error(`Unexpected request: ${init?.method} ${url}`)
                    }
                    return toFetchResponse(payload)
                },
            })

            const result = await addProjects.execute(
                { projects: [{ name: 'First' }, { name: 'Second' }, { name: 'Third' }] },
                client,
            )

            expect(creationRequests).toBe(successCount)
            expect(result.structuredContent.successCount).toBe(successCount)
            expect(result.structuredContent.failures).toEqual(
                failedProjects.map((item) => ({
                    item,
                    error: expect.stringContaining(
                        `limit of ${current.max_projects} active personal projects`,
                    ),
                })),
            )
        },
    )
})

describe('Creating a project in a folder through the real SDK', () => {
    it('sends one project_add carrying the folder and its workspace, then reads the project', async () => {
        const syncBodies: unknown[] = []
        const client = new TodoistApi('unused-test-token', {
            baseUrl: 'https://todoist.invalid',
            customFetch: async (url, init) => {
                let payload: unknown
                switch (`${init?.method} ${new URL(url).pathname}`) {
                    case 'GET /api/v1/folders/folder-123':
                        payload = {
                            id: 'folder-123',
                            name: 'Marketing',
                            workspace_id: 'workspace-123',
                            is_deleted: false,
                            default_order: 1,
                            child_order: 1,
                        }
                        break
                    case 'POST /api/v1/sync': {
                        const body = JSON.parse(String(init?.body))
                        syncBodies.push(body)
                        const [command] = body.commands
                        payload = {
                            sync_token: 'test-token',
                            full_sync: false,
                            sync_status: { [command.uuid]: 'ok' },
                            temp_id_mapping: { [command.temp_id]: 'campaigns-id' },
                        }
                        break
                    }
                    case 'GET /api/v1/projects/campaigns-id':
                        payload = toApiProject(
                            createMockWorkspaceProject({
                                id: 'campaigns-id',
                                name: 'Campaigns',
                                folderId: 'folder-123',
                            }),
                        )
                        break
                    default:
                        throw new Error(`Unexpected request: ${init?.method} ${url}`)
                }
                return toFetchResponse(payload)
            },
        })

        const result = await addProjects.execute(
            { projects: [{ name: 'Campaigns', folderId: 'folder-123' }] },
            client,
        )

        expect(syncBodies).toEqual([
            {
                commands: [
                    {
                        type: 'project_add',
                        uuid: expect.any(String),
                        temp_id: expect.any(String),
                        args: {
                            name: 'Campaigns',
                            workspace_id: 'workspace-123',
                            folder_id: 'folder-123',
                        },
                    },
                ],
            },
        ])
        expect(result.structuredContent.failures).toEqual([])
        expect(result.structuredContent.projects).toEqual([
            expect.objectContaining({
                id: 'campaigns-id',
                workspaceId: 'workspace-123',
                folderId: 'folder-123',
            }),
        ])
    })
})
