import { TodoistApi } from '@todoist/sdk'
import { toFetchResponse } from '../utils/test-helpers.js'
import { getProductivityStats } from './get-productivity-stats.js'

// Todoist project IDs mix upper and lower case, so camel-casing them as field names
// rewrites them (`6Jf8VQXxpwv56VQ7` → `6Jf8VqXxpwv56Vq7`).
const PROJECT_ID = '6Jf8VQXxpwv56VQ7'
const STREAK = { count: 1, start: '2026-03-17', end: '2026-03-17' }

// The stats as the API sends them, in snake_case.
const API_STATS = {
    completed_count: 12,
    days_items: [
        { date: '2026-03-17', total_completed: 12, items: [{ id: PROJECT_ID, completed: 12 }] },
    ],
    week_items: [
        {
            from: '2026-03-11',
            to: '2026-03-17',
            total_completed: 12,
            items: [{ id: PROJECT_ID, completed: 12 }],
        },
    ],
    goals: {
        daily_goal: 5,
        weekly_goal: 25,
        current_daily_streak: STREAK,
        current_weekly_streak: STREAK,
        last_daily_streak: STREAK,
        last_weekly_streak: STREAK,
        max_daily_streak: STREAK,
        max_weekly_streak: STREAK,
        user: 'user-1',
        user_id: 'user-1',
        vacation_mode: 0,
        karma_disabled: 0,
        ignore_days: [],
    },
    karma: 1000,
    karma_trend: 'up',
    karma_last_update: 5,
    karma_graph_data: [{ date: '2026-03-17', karma_avg: 1000 }],
    karma_update_reasons: [],
    project_colors: { [PROJECT_ID]: 'berry_red' },
}

describe('Reading productivity stats through the real SDK', () => {
    it('keys projectColors by the project IDs the API sent', async () => {
        const client = new TodoistApi('unused-test-token', {
            baseUrl: 'https://todoist.invalid',
            customFetch: async (url, init) => {
                const request = `${init?.method} ${new URL(url).pathname}`
                if (request !== 'GET /api/v1/tasks/completed/stats') {
                    throw new Error(`Unexpected request: ${init?.method} ${url}`)
                }
                return toFetchResponse(API_STATS)
            },
        })

        const result = await getProductivityStats.execute({}, client)

        expect(result.structuredContent.projectColors).toEqual({ [PROJECT_ID]: 'berry_red' })
    })
})
