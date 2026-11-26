import { type Task, TodoistApi } from '@todoist/sdk'
import { createMockTask, toFetchResponse } from '../utils/test-helpers.js'
import { rescheduleTasks } from './reschedule-tasks.js'

function toApiTask(task: Task) {
    return {
        ...Object.fromEntries(
            Object.entries(task).map(([key, value]) => [
                key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
                value,
            ]),
        ),
        due: task.due && {
            date: task.due.date,
            string: task.due.string,
            is_recurring: task.due.isRecurring,
            timezone: task.due.timezone,
            lang: task.due.lang,
        },
    }
}

describe('Rescheduling API v1 due dates through the real SDK', () => {
    it('keeps times and recurrence metadata in a mixed date-only reschedule batch', async () => {
        const tasks = [
            createMockTask({
                id: 'task-1',
                due: {
                    date: '2026-03-15T14:00:00Z',
                    string: 'every day at 10am',
                    isRecurring: true,
                    timezone: 'America/New_York',
                    lang: 'en',
                },
            }),
            createMockTask({
                id: 'task-2',
                due: {
                    date: '2026-03-16T11:35:00',
                    string: 'Mar 16 at 11:35am',
                    isRecurring: false,
                    timezone: null,
                    lang: 'en',
                },
            }),
            createMockTask({
                id: 'task-3',
                due: {
                    date: '2026-03-17',
                    string: 'Mar 17',
                    isRecurring: false,
                    timezone: null,
                    lang: 'en',
                },
            }),
        ]
        const syncBodies: unknown[] = []
        const client = new TodoistApi('unused-test-token', {
            baseUrl: 'https://todoist.invalid',
            customFetch: async (url, init) => {
                const path = new URL(url).pathname
                const task = tasks.find((task) => path === `/api/v1/tasks/${task.id}`)
                if (init?.method === 'GET' && task) {
                    // Fixed read fixtures: the assertion below checks the write, not persistence.
                    return toFetchResponse(toApiTask(task))
                }
                if (init?.method === 'POST' && path === '/api/v1/sync') {
                    const body = JSON.parse(String(init?.body))
                    syncBodies.push(body)
                    return toFetchResponse({
                        sync_token: 'test-token',
                        full_sync: false,
                        sync_status: Object.fromEntries(
                            body.commands.map((command: { uuid: string }) => [command.uuid, 'ok']),
                        ),
                        temp_id_mapping: {},
                    })
                }
                throw new Error(`Unexpected request: ${init?.method} ${url}`)
            },
        })

        const result = await rescheduleTasks.execute(
            { tasks: tasks.map(({ id }) => ({ id, date: '2026-03-20' })) },
            client,
        )

        expect(syncBodies).toEqual([
            {
                commands: [
                    {
                        type: 'item_update',
                        uuid: expect.any(String),
                        args: {
                            id: 'task-1',
                            due: {
                                date: '2026-03-20T14:00:00Z',
                                string: 'every day at 10am',
                                is_recurring: true,
                                timezone: 'America/New_York',
                                lang: 'en',
                            },
                        },
                    },
                    {
                        type: 'item_update',
                        uuid: expect.any(String),
                        args: {
                            id: 'task-2',
                            due: {
                                date: '2026-03-20T11:35:00',
                                string: 'Mar 16 at 11:35am',
                                is_recurring: false,
                                lang: 'en',
                            },
                        },
                    },
                    {
                        type: 'item_update',
                        uuid: expect.any(String),
                        args: {
                            id: 'task-3',
                            due: {
                                date: '2026-03-20',
                                string: 'Mar 17',
                                is_recurring: false,
                                lang: 'en',
                            },
                        },
                    },
                ],
            },
        ])
        expect(result.structuredContent.failures).toEqual([])
    })
})
