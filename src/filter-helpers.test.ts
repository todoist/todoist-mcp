import type { TodoistApi } from '@todoist/sdk'
import { describe, expect, it, vi } from 'vitest'
import {
    buildResponsibleUserQueryFilter,
    filterTasksByResponsibleUser,
    resolveResponsibleUser,
} from './filter-helpers.js'
import { AmbiguousUserError } from './tool-execution-error.js'
import { createMockUser } from './utils/test-helpers.js'
import { userResolver } from './utils/user-resolver.js'

describe('filter helpers', () => {
    describe('resolveResponsibleUser', () => {
        it('passes an ambiguous partial name on rather than saying nobody was found', async () => {
            userResolver.clearCache()
            const client = {
                getUser: vi.fn().mockResolvedValue(createMockUser()),
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

            // The wording is pinned in user-resolver.test.ts.
            await expect(resolveResponsibleUser(client, 'Ann')).rejects.toThrow(AmbiguousUserError)
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
