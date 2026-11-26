import type { TodoistSkill } from './todoist-skill.js'

export const productivityReview: TodoistSkill = {
    name: 'productivity-review',
    files: {
        'SKILL.md': `---
name: productivity-review
description: Review the user's Todoist productivity over a period, covering what they completed, goal streaks, karma, which projects got attention, and concrete suggestions. Use when the user asks how productive they have been, for a weekly or monthly review, or how they are tracking against their goals.
---

# Productivity review

## 1. Pin down the period

Call **user-info** first. It gives the user's ID, their timezone and current local time, the day their week starts on, and their daily and weekly goals.

Work out the start and end dates on the user's calendar, not in UTC: "this week" starts on their week start day, and "the last 7 days" ends today in their timezone. When the user does not name a period, review the last 7 days.

## 2. Gather the data

1. **get-productivity-stats** for completions per day and per week (with counts per project), goal streaks, and karma with its trend. It reports counts only, never the tasks.
2. **find-activity** for what the user actually completed: objectType "task", eventType "completed", initiatorId set to the user's ID, dateFrom at the start of the first day and dateTo at the start of the day after the last, both with the user's UTC offset (for example "2026-11-16T00:00:00+01:00"). Without initiatorId the results include every collaborator's completions. Page through with cursor until there are no more.
3. **find-projects** for the list of projects, paging with cursor, to spot ones with nothing completed.

Use find-activity rather than **find-completed-tasks** for completions: find-completed-tasks leaves out each occurrence of a recurring task that is still active, so it undercounts.

To review one project, pass its projectId to find-activity, and call **get-overview** with that projectId for its sections and open tasks.

## 3. Analyse

Cover what the user asked about. For a general review, cover all of these:

- **Goals**: today's and this week's completions against the daily and weekly goals, current streaks against the best ones, and any streak that breaks unless something is completed today.
- **Trends**: completions per day across the period, the busiest and quietest days, weekdays against weekends, and week-on-week totals when the period spans more than one week.
- **Projects**: which projects got the most and the least done, and active projects with nothing completed.
- **Karma**: the current score, its trend, and the reasons for recent changes.
- **Recommendations**: three to five specific next steps drawn from the numbers, such as a neglected project to pick up again, or a goal to raise or lower to match what the user actually completes.

## 4. Report

Open with the period and two or three headline numbers. Give each section its own heading. Quote real numbers and comparisons rather than impressions, and end with the recommendations.
`,
    },
}
