import type { TodoistApi } from '@todoist/sdk'
import { type Mocked, vi } from 'vitest'
import { AssignmentErrorType, assignmentValidator } from './assignment-validator.js'
import { createMockProject, createMockUser } from './test-helpers.js'
import { userResolver } from './user-resolver.js'

const TARGET_PROJECT_ID = 'target-project'
const OTHER_PROJECT_ID = 'other-project'

const ada = { id: 'ada-id', name: 'Ada Lovelace', email: 'ada@example.com' }
const grace = { id: 'grace-id', name: 'Grace Hopper', email: 'grace@example.com' }

function page<T>(results: T[]) {
    return { results, nextCursor: null }
}

describe('assignmentValidator.validateTaskCreationAssignment', () => {
    let client: Mocked<TodoistApi>

    beforeEach(() => {
        userResolver.clearCache()
        client = {
            getUser: vi.fn().mockResolvedValue(createMockUser()),
            getProject: vi
                .fn()
                .mockResolvedValue(
                    createMockProject({ id: TARGET_PROJECT_ID, name: 'Launch', isShared: true }),
                ),
            getProjects: vi
                .fn()
                .mockResolvedValue(
                    page([
                        createMockProject({ id: TARGET_PROJECT_ID, isShared: true }),
                        createMockProject({ id: OTHER_PROJECT_ID, isShared: true }),
                    ]),
                ),
            getProjectCollaborators: vi.fn(async (projectId: string) =>
                page(projectId === TARGET_PROJECT_ID ? [ada] : [grace]),
            ),
        } as unknown as Mocked<TodoistApi>
    })

    it.each([
        { reference: 'by email', input: 'ada@example.com' },
        { reference: 'by full name, in any case', input: 'ada lovelace' },
        { reference: 'by ID', input: 'ada-id' },
    ])(
        'resolves a collaborator of the target project $reference without reading every shared project',
        async ({ input }) => {
            const result = await assignmentValidator.validateTaskCreationAssignment(
                client,
                TARGET_PROJECT_ID,
                input,
            )

            expect(result).toMatchObject({
                isValid: true,
                resolvedUser: {
                    userId: 'ada-id',
                    displayName: 'Ada Lovelace',
                    email: 'ada@example.com',
                },
            })
            expect(client.getProjects).not.toHaveBeenCalled()
            expect(client.getProjectCollaborators).not.toHaveBeenCalledWith(
                OTHER_PROJECT_ID,
                expect.anything(),
            )
        },
    )

    it('says a person from another shared project is not a collaborator on the target', async () => {
        const result = await assignmentValidator.validateTaskCreationAssignment(
            client,
            TARGET_PROJECT_ID,
            'grace@example.com',
        )

        expect(result).toMatchObject({
            isValid: false,
            resolvedUser: { userId: 'grace-id' },
            error: {
                type: AssignmentErrorType.USER_NOT_COLLABORATOR,
                message: 'User "Grace Hopper" is not a collaborator on project "Launch"',
            },
        })
    })

    it('looks the current user up once for a batch of assignments', async () => {
        await assignmentValidator.validateBulkAssignment(client, [
            { taskId: undefined, projectId: TARGET_PROJECT_ID, responsibleUid: 'ada@example.com' },
            { taskId: undefined, projectId: TARGET_PROJECT_ID, responsibleUid: 'Ada Lovelace' },
            { taskId: undefined, projectId: TARGET_PROJECT_ID, responsibleUid: 'ada-id' },
        ])

        expect(client.getUser).toHaveBeenCalledTimes(1)
    })

    it("reads the target project's collaborators once for a batch validated in parallel", async () => {
        await assignmentValidator.validateBulkAssignment(client, [
            { taskId: undefined, projectId: TARGET_PROJECT_ID, responsibleUid: 'ada@example.com' },
            { taskId: undefined, projectId: TARGET_PROJECT_ID, responsibleUid: 'Ada Lovelace' },
            { taskId: undefined, projectId: TARGET_PROJECT_ID, responsibleUid: 'ada-id' },
        ])

        expect(client.getProjectCollaborators).toHaveBeenCalledTimes(1)
    })

    it('prefers an exact name on another project over a partial match on the target', async () => {
        client.getProjectCollaborators.mockImplementation(async (projectId: string) =>
            page(
                projectId === TARGET_PROJECT_ID
                    ? [{ id: 'annabel-id', name: 'Annabel Lee', email: 'annabel@example.com' }]
                    : [{ id: 'ann-id', name: 'Ann', email: 'ann@example.com' }],
            ),
        )

        const result = await assignmentValidator.validateTaskCreationAssignment(
            client,
            TARGET_PROJECT_ID,
            'Ann',
        )

        expect(result).toMatchObject({
            isValid: false,
            resolvedUser: { userId: 'ann-id' },
            error: { type: AssignmentErrorType.USER_NOT_COLLABORATOR },
        })
    })

    it('says a person nobody in the account knows was not found', async () => {
        const result = await assignmentValidator.validateTaskCreationAssignment(
            client,
            TARGET_PROJECT_ID,
            'nobody@example.com',
        )

        expect(result).toMatchObject({
            isValid: false,
            error: {
                type: AssignmentErrorType.USER_NOT_FOUND,
                message: 'User "nobody@example.com" not found',
            },
        })
    })

    it('resolves "me" to the current user', async () => {
        client.getProjectCollaborators.mockResolvedValue(
            page([ada, { id: createMockUser().id, name: 'Test User', email: 'test@example.com' }]),
        )

        const result = await assignmentValidator.validateTaskCreationAssignment(
            client,
            TARGET_PROJECT_ID,
            'me',
        )

        expect(result).toMatchObject({
            isValid: true,
            resolvedUser: { userId: createMockUser().id, email: 'test@example.com' },
        })
    })
})
