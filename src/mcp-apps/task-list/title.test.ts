import { describe, expect, it } from 'vitest'

import { getTaskListTitle } from './title.js'

describe('getTaskListTitle', () => {
    it.each([
        {
            name: 'a single specific day',
            args: { startDate: '2025-08-20', daysCount: 1 },
            title: 'Tasks for 2025-08-20',
        },
        {
            name: 'a range from a specific day',
            args: { startDate: '2025-08-20', daysCount: 3 },
            title: 'Tasks for 2025-08-20 to 2025-08-22',
        },
        {
            name: 'a range across the end of a month',
            args: { startDate: '2025-08-30', daysCount: 3 },
            title: 'Tasks for 2025-08-30 to 2025-09-01',
        },
        {
            name: 'today alone',
            args: { startDate: 'today', daysCount: 1 },
            title: 'Tasks for Today',
        },
        {
            name: 'today and tomorrow',
            args: { startDate: 'today', daysCount: 2 },
            title: 'Tasks for Today and Tomorrow',
        },
        {
            name: 'today and the days after it',
            args: { startDate: 'today', daysCount: 7 },
            title: 'Tasks for Today and the next 6 days',
        },
        {
            name: 'overdue tasks only',
            args: { overdueOption: 'overdue-only' as const, daysCount: 1 },
            title: 'Overdue tasks',
        },
        {
            name: 'overdue tasks only, with a start date the search ignores',
            args: { startDate: '2025-08-20', overdueOption: 'overdue-only' as const, daysCount: 3 },
            title: 'Overdue tasks',
        },
        {
            name: 'a search with no arguments',
            args: null,
            title: 'Tasks for Today',
        },
        {
            // Tool input reaches the widget before the server validates it.
            name: 'a malformed start date as given',
            args: { startDate: '20-08', daysCount: 3 },
            title: 'Tasks for 20-08',
        },
    ])('names $name', ({ args, title }) => {
        expect(getTaskListTitle(args)).toBe(title)
    })
})
