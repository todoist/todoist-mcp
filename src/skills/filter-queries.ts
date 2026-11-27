import type { TodoistSkill } from './todoist-skill.js'

export const filterQueries: TodoistSkill = {
    name: 'filter-queries',
    files: {
        'SKILL.md': `---
name: filter-queries
description: Write Todoist filter queries, the syntax behind saved filters and the filter parameter of find-tasks. Covers dates, deadlines, priorities, labels, projects, sections, assignees and how to combine them, plus what filters cannot do. Use before writing or changing a filter query, or when the user wants a saved filter or a custom view of their tasks.
---

# Todoist filter queries

Filter queries go in three places:

- **find-tasks**: the filter parameter, to search active tasks once.
- **add-filters** and **update-filters**: the query of a saved filter the user sees in Todoist. **find-filters** lists the existing ones.

Filters return active tasks only. Use them for open work, never to answer what was completed.

## Combining

- \`&\` and: \`today & p1\`
- \`|\` or: \`today | overdue\`
- \`!\` not: \`!subtask\`
- \`()\` grouping: \`(today | overdue) & #Work\`
- \`,\` separate lists, shown as separate sections: \`date: yesterday, today\`
- \`*\` wildcard in a name: \`@home*\`, \`#*Work\`, \`assigned to: m* smith\`
- \`\\\` makes the next character part of a name: \`#One \\& Two\`, \`#Shopping\\ list\`

Names with spaces are written out in full: \`#Client Work\`, \`assigned to: Steve Gray\`.

## Dates

\`date\` queries match the task's date. \`due\` queries match the date, or the deadline when the task has no date; for a user without deadlines they give the same results.

- \`today\`, \`tomorrow\`, \`yesterday\`, \`overdue\` (also \`od\`)
- \`date: Jan 3\`, \`date before: May 5\`, \`date after: 5/5\`; the same with \`due before:\` and \`due after:\`
- Times: \`date: today & date before: today at 2pm\`, \`date before: +4 hours\`, \`date before: +30 minutes\` (minutes are the smallest unit)
- Relative: \`7 days\` or \`next 7 days\` (due in the next 7 days), \`-3 days\` (the past 3 days), \`date before: next week\`, \`date before: sat\` (the rest of the working week), \`date before: first day\` (the rest of this month)
- \`date before:\` and \`due before:\` include overdue tasks.
- Day names: \`Monday\`; full dates: \`Oct 5th 2022\`, \`10/5/2022 5pm\`
- \`no date\`, \`!no date\` (has a date), \`no time\` (a date without a time), \`!no time\`
- \`recurring\`, \`!recurring\`

## Deadlines

\`no deadline\`, \`!no deadline\`, \`deadline: today\`, \`deadline before: today\` (missed deadlines), \`deadline after: yesterday & deadline before: in 7 days\`.

## Created

\`created: today\`, \`created: Jan 3 2023\`, \`created before: -30 days\` (more than 30 days ago), \`created after: -365 days\`.

## Priority

\`p1\`, \`p2\`, \`p3\`, and \`p4\` or \`no priority\`. Example: \`(p1 | p2) & 14 days\`.

## Labels

\`@email\`, \`@home*\`, \`no labels\`. Todoist's help centre now writes the label prefix as \`%\` (\`%email\`); both work.

## Projects, sections and workspaces

- \`#Work\`: tasks in the project. \`##Work\`: the project and its sub-projects. \`##School & !#Science\`.
- \`##Design team\` also matches the projects in a workspace folder of that name.
- \`/Meetings\`: tasks in a section of that name in any project. \`#Work & /Meetings\`. \`!/*\`: tasks in no section.
- \`workspace: My projects\`, \`(workspace: Acme | workspace: My projects)\`.

A saved filter refers to projects, sections and labels by name, so renaming one breaks the filters that use it. When you rename one, check **find-filters** for queries to update.

## People

- \`assigned to: me\`, \`assigned to: others\`, \`assigned to: Steve Gray\`, using the name the person uses in Todoist
- \`assigned by: me\`, \`assigned\` (to anyone), \`!assigned\` (to nobody), \`!assigned to: others\`
- \`added by: me\`, \`added by: Becky\`
- \`shared\` (tasks in shared projects), \`shared & !assigned\`

## Other

\`subtask\`, \`!subtask\`, \`search: meeting\` (task text; several words match in any order), \`view all\` (every active task), \`uncompletable\`.

## What filters cannot do

Todoist supports only the queries its filter reference lists. In particular:

- \`this week\` is not a range: use \`date before: next week\` or \`7 days\`.
- \`assigned to: nobody\` does not exist: use \`!assigned\`.
- Completed tasks, comments and durations cannot be filtered.
- Keywords follow the user's app language, and relative dates are worked out when the filter is opened.

## Full reference

For anything not covered here, Todoist's full filter reference is https://www.todoist.com/help/todoist/features/introduction-to-filters-V98wIH. Point the user to it too when a query they want is not supported.
`,
    },
}
