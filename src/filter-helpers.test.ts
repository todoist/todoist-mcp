import type { TodoistApi } from '@todoist/sdk'
import { describe, expect, it, vi } from 'vitest'
import {
    buildResponsibleUserQueryFilter,
    filterTasksByResponsibleUser,
    resolveResponsibleUser,
} from './filter-helpers.js'
import { userResolver } from './utils/user-resolver.js'

describe('filter helpers', () => {
    describe('resolveResponsibleUser', () => {
        it('names the people a partial name fits rather than saying nobody was found', async () => {
            userResolver.clearCache()
            const client = {
                getUser: vi
                    .fn()
                    .mockResolvedValue({ id: '999', fullName: 'Me', email: 'me@example.com' }),
                getProjects: vi.fn().mockResolvedValue({
                    results: [{ id: 'p1', isShared: true }],
                    nextCursor: null,
                }),
                getProjectCollaborators: vi.fn().mockResolvedValue({
                    results: [
                        { id: 'u1', name: 'Joanne Smith', email: 'joanne@example.com' },
                        { id: 'u2', name: 'Ann Lee', email: 'ann@example.com' },
                    ],
                    nextCursor: null,
                }),
            } as unknown as TodoistApi

            await expect(resolveResponsibleUser(client, 'Ann')).rejects.toThrow(
                '"Ann" matches 2 people: "Joanne Smith" (ID u1), "Ann Lee" (ID u2). Retry with the ID of the one you mean.',
            )
        })
    })

    describe('buildResponsibleUserQueryFilter', () => {
        it('includes unassigned tasks when the resolved user is the current user', () => {
            expect(
                buildResponsibleUserQueryFilter({
                    resolvedAssigneeId: 'current-user',
                    assigneeEmail: 'avery.inboxworthy@example.com',
                    currentUserId: 'current-user',
                    responsibleUserFiltering: 'all',
                }),
            ).toBe('!assigned to: others')
        })

        it('keeps a resolved user filter strict when the current user is unavailable', () => {
            expect(
                buildResponsibleUserQueryFilter({
                    resolvedAssigneeId: 'current-user',
                    assigneeEmail: 'avery.inboxworthy@example.com',
                }),
            ).toBe('assigned to: avery.inboxworthy@example.com')
        })
    })

    describe('filterTasksByResponsibleUser', () => {
        it('includes unassigned tasks when the resolved user is the current user', () => {
            const tasks = [
                { id: 'mine', responsibleUid: 'current-user' },
                { id: 'unassigned' },
                { id: 'someone-else', responsibleUid: 'other-user' },
            ]

            expect(
                filterTasksByResponsibleUser({
                    tasks,
                    resolvedAssigneeId: 'current-user',
                    currentUserId: 'current-user',
                    responsibleUserFiltering: 'all',
                }),
            ).toEqual([tasks[0], tasks[1]])
        })
    })
})
