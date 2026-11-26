import type { TodoistSkill } from './todoist-skill.js'

export const planMyDay: TodoistSkill = {
    name: 'plan-my-day',
    files: {
        'SKILL.md': `---
name: plan-my-day
description: Plan the user's day or week in Todoist by gathering what is overdue, due and waiting in the Inbox, agreeing what fits, then rescheduling, time-blocking and filing tasks. Use when the user asks what to work on today, wants to plan or triage their day or week, or wants to clear overdue tasks or their Inbox.
---

# Plan my day

## 1. See what is waiting

1. **user-info** for the user's ID, local date and time, and daily goal.
2. **find-tasks-by-date** with startDate "today", which also returns overdue tasks. Its default limit is 10, so raise limit or page with cursor until nothing is left.
3. **find-tasks** with projectId "inbox" for tasks not filed into a project yet.

To plan a week, call find-tasks-by-date with daysCount 7 instead.

## 2. Agree the plan

Group what you found: overdue, due today (with any times), high priority (p1 and p2), and the Inbox. Propose what to do today and what to move, and to when. Weigh it against the daily goal and the times already booked.

Ask before changing anything. Moving, completing and filing tasks are the user's calls, and a plan they have not seen is not their plan.

## 3. Apply it

- Move a task that already has a date to another day or time with **reschedule-tasks**, never **update-tasks**: it keeps a recurring task's pattern, where update-tasks would replace it. Send every move in one call.
- Time-block a dated task with reschedule-tasks too: a date and time such as "2026-11-26T14:00:00", plus a duration such as "45m". Keep durations under 24 hours: the Todoist apps do not display longer ones.
- Schedule a task with no date, as most Inbox tasks are, with update-tasks and a dueString such as "today at 14:00", plus a duration to time-block it. Do the same for a task that has only a deadline. reschedule-tasks leaves a task with no date untouched, and for a deadline-only task it moves the deadline and drops the time.
- File Inbox tasks with update-tasks, passing only the projectId or sectionId that changes, and set priority or labels in the same call.
- Complete finished tasks with **complete-tasks**, and capture new ones with **add-tasks**.

Batch tools, reschedule-tasks included, report each item that failed alongside the ones that worked. Re-send only the failed items whose reason you can fix, never the whole batch.

## 4. Confirm

Finish with the day's plan in time order, and list what you moved off today and where it went.
`,
    },
}
