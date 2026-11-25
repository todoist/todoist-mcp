import { TodoistApi } from '@todoist/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FailureSchema } from '../utils/output-schemas.js'
import { createMockTask, toApiPayload, toFetchResponse } from '../utils/test-helpers.js'
import { addTasks } from './add-tasks.js'

describe('add-tasks rate-limit metadata through the SDK', () => {
    afterEach(() => vi.restoreAllMocks())

    it('preserves an HTTP 429 retry instruction without retrying the batch', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const send = vi.fn(async () => ({
            ...toFetchResponse({
                error: 'Too many requests',
                error_code: 35,
                error_tag: 'LIMITS_REACHED',
                http_code: 429,
                error_extra: { retry_after: 1280 },
            }),
            ok: false,
            status: 429,
            statusText: 'Too Many Requests',
        }))
        const client = new TodoistApi('unused-test-token', { customFetch: send })

        const result = await addTasks.execute({ tasks: [{ content: 'Test task' }] }, client)

        expect(send).toHaveBeenCalledTimes(1)
        expect(result.structuredContent).toMatchObject({
            successCount: 0,
            failureCount: 1,
            failures: [
                {
                    item: 'Test task',
                    code: 'RATE_LIMITED',
                    retryAfterSeconds: 1280,
                },
            ],
        })
        expect(FailureSchema.parse(result.structuredContent.failures[0])).toMatchObject({
            code: 'RATE_LIMITED',
            retryAfterSeconds: 1280,
        })
    })

    it('keeps an applied command when another command is rate limited', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const send = vi.fn(async (url: string, init?: { body?: unknown }) => {
            if (new URL(url).pathname.endsWith('/sync')) {
                const { commands } = JSON.parse(String(init?.body))
                return toFetchResponse({
                    sync_status: {
                        [commands[0].uuid]: 'ok',
                        [commands[1].uuid]: {
                            error: 'Too many requests',
                            error_code: 35,
                            error_tag: 'LIMITS_REACHED',
                            http_code: 429,
                            error_extra: { retry_after: 90 },
                        },
                    },
                    temp_id_mapping: { [commands[0].temp_id]: 'task-created' },
                })
            }
            return toFetchResponse({
                results: [
                    toApiPayload(
                        createMockTask({ id: 'task-created', projectId: 'project-applied' }),
                    ),
                ],
            })
        })
        const client = new TodoistApi('unused-test-token', { customFetch: send })

        const result = await addTasks.execute(
            { tasks: [{ content: 'Applied' }, { content: 'Rejected' }] },
            client,
        )

        expect(send).toHaveBeenCalledTimes(2)
        expect(result.structuredContent).toMatchObject({
            successCount: 1,
            failureCount: 1,
            tasks: [{ id: 'task-created', projectId: 'project-applied' }],
            failures: [
                {
                    item: 'Rejected',
                    code: 'RATE_LIMITED',
                    retryAfterSeconds: 90,
                },
            ],
        })
    })
})
