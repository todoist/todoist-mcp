import { escapeFilterToken, GetTasksArgs, type TodoistApi } from '@todoist/sdk'
import { z } from 'zod'
import {
    appendToQuery,
    buildResponsibleUserQueryFilter,
    filterTasksByResponsibleUser,
    RESPONSIBLE_USER_FILTERING,
    resolveResponsibleUser,
} from '../filter-helpers.js'
import type { TodoistTool } from '../todoist-tool.js'
import {
    fetchAllLabelNames,
    fetchAllSharedLabels,
    getTasksByFilter,
    type MappedTask,
    mapTask,
    normalizePaginationCursor,
    resolveInboxProjectId,
} from '../tool-helpers.js'
import { ApiLimits } from '../utils/constants.js'
import { filterResolver } from '../utils/filter-resolver.js'
import { collectFilteredPage, readFilteredPageCursor } from '../utils/filtered-pages.js'
import {
    findLabelName,
    formatLabelsForDisplay,
    generateLabelsFilter,
    type LabelsOperator,
    LabelsSchema,
    matchesLabels,
} from '../utils/labels.js'
import { TaskSchema as TaskOutputSchema } from '../utils/output-schemas.js'
import { previewTasks, summarizeList } from '../utils/response-builders.js'
import { ToolNames } from '../utils/tool-names.js'
import { getAssigneeShortNames } from '../utils/user-resolver.js'

const { FIND_COMPLETED_TASKS, ADD_TASKS } = ToolNames

const ArgsSchema = {
    searchText: z.string().optional().describe('The text to search for in tasks.'),
    projectId: z
        .string()
        .optional()
        .describe(
            'Find tasks in this project. Project ID should be an ID string, or the text "inbox", for inbox tasks.',
        ),
    sectionId: z.string().optional().describe('Find tasks in this section.'),
    parentId: z.string().optional().describe('Find subtasks of this parent task.'),
    responsibleUser: z
        .string()
        .optional()
        .describe(
            'Find tasks assigned to this user. Can be a user ID, name, or email address. The current user also includes unassigned tasks.',
        ),
    responsibleUserFiltering: z
        .enum(RESPONSIBLE_USER_FILTERING)
        .optional()
        .describe(
            'How to filter by responsible user when responsibleUser is not provided. "assigned" = only tasks assigned to others; "unassignedOrMe" = only unassigned tasks or tasks assigned to me; "all" = all tasks regardless of assignment. Default value will be `unassignedOrMe`.',
        ),
    limit: z
        .number()
        .int()
        .min(1)
        .max(ApiLimits.TASKS_MAX)
        .default(ApiLimits.TASKS_DEFAULT)
        .describe('The maximum number of tasks to return.'),
    cursor: z
        .string()
        .optional()
        .describe(
            'The cursor to get the next page of tasks (cursor is obtained from the previous call to this tool, with the same parameters).',
        ),
    filter: z
        .string()
        .optional()
        .describe(
            'A raw Todoist filter query string (e.g. "today", "p1", "##Work", "(today | overdue) & p1"). ' +
                'Combined with other filters using AND. Cannot be used with projectId, sectionId, parentId, or filterIdOrName.',
        ),
    filterIdOrName: z
        .string()
        .optional()
        .describe(
            "The ID or name of a saved Todoist filter. The filter's query will be fetched and used to find tasks. " +
                'Cannot be used with the `filter` parameter, projectId, sectionId, or parentId.',
        ),
    ...LabelsSchema,
}

const OutputSchema = {
    tasks: z.array(TaskOutputSchema).describe('The found tasks.'),
    nextCursor: z.string().optional(),
    totalCount: z.number().describe('The total number of tasks in this page.'),
    hasMore: z.boolean(),
    appliedFilters: z.record(z.string(), z.unknown()),
}

const findTasks = {
    name: ToolNames.FIND_TASKS,
    description:
        'Find active tasks by text, project/section/parent, responsible user, labels, raw filter, or saved filter (filterIdOrName). Without filters, list a page. Default scope: unassigned + mine; responsibleUserFiltering="all" includes others.',
    parameters: ArgsSchema,
    outputSchema: OutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async execute(args, client) {
        const {
            searchText,
            projectId,
            sectionId,
            parentId,
            responsibleUser,
            responsibleUserFiltering,
            limit,
            cursor,
            labels,
            labelsOperator,
            filter,
            filterIdOrName,
        } = args
        const normalizedCursor = normalizePaginationCursor(cursor)

        if (filter && filterIdOrName) {
            throw new Error(
                'The `filter` and `filterIdOrName` parameters cannot be used together. Provide only one.',
            )
        }

        const isContainerSearch = Boolean(projectId || sectionId || parentId)
        if ((filter || filterIdOrName) && isContainerSearch) {
            throw new Error(
                'The `filter`/`filterIdOrName` parameter cannot be combined with projectId, sectionId, or parentId. Use filter syntax instead (e.g. "##ProjectName").',
            )
        }

        // A container search resumes from where its cursor says, with the API label it
        // started with; only a new search looks the label up, alongside the user.
        const resumeFrom = isContainerSearch ? readFilteredPageCursor(normalizedCursor) : undefined
        const apiLabelLookup = !isContainerSearch
            ? Promise.resolve(undefined)
            : resumeFrom
              ? Promise.resolve(readApiLabel(resumeFrom.state))
              : resolveApiLabel(client, labels, labelsOperator)

        const todoistUser = await client.getUser()

        const hasLabels = labels && labels.length > 0

        // Resolve filterIdOrName to a filter query string
        let resolvedFilter = filter
        if (filterIdOrName) {
            const resolved = await filterResolver.resolveFilter(client, filterIdOrName)
            resolvedFilter = resolved.filterQuery
        }

        // Resolve assignee name to user ID if provided
        const resolved = await resolveResponsibleUser(client, responsibleUser)
        const resolvedAssigneeId = resolved?.userId
        const assigneeEmail = resolved?.email

        // If using container-based filtering, use direct API
        if (isContainerSearch) {
            const taskParams: Omit<GetTasksArgs, 'cursor' | 'limit'> = {}

            if (projectId) {
                taskParams.projectId = await resolveInboxProjectId({ projectId, user: todoistUser })
            }
            if (sectionId) taskParams.sectionId = sectionId
            if (parentId) taskParams.parentId = parentId

            const apiLabel = await apiLabelLookup
            if (apiLabel) taskParams.label = apiLabel

            const lowerSearchText = searchText?.toLowerCase()
            const { items: filteredTasks, nextCursor } = await collectFilteredPage({
                fetchPage: async (page) => {
                    const { results, nextCursor } = await client.getTasks({
                        ...taskParams,
                        ...page,
                    })
                    return { results: results.map(mapTask), nextCursor }
                },
                matches: (task) =>
                    (!lowerSearchText ||
                        task.content.toLowerCase().includes(lowerSearchText) ||
                        Boolean(task.description?.toLowerCase().includes(lowerSearchText))) &&
                    filterTasksByResponsibleUser({
                        tasks: [task],
                        resolvedAssigneeId,
                        currentUserId: todoistUser.id,
                        responsibleUserFiltering,
                    }).length === 1 &&
                    (!labels?.length || matchesLabels(task.labels, labels, labelsOperator)),
                limit,
                maxPageSize: ApiLimits.TASKS_PAGE_MAX,
                from: resumeFrom,
                state: apiLabel ? ({ apiLabel } satisfies ContainerCursorState) : undefined,
            })

            const textContent = generateTextContent({
                tasks: filteredTasks,
                args,
                nextCursor,
                isContainerSearch: true,
                assigneeEmail,
                assigneeNames: await getAssigneeShortNames(client, filteredTasks, todoistUser.id),
            })

            return {
                textContent,
                structuredContent: {
                    tasks: filteredTasks,
                    nextCursor: nextCursor ?? undefined,
                    totalCount: filteredTasks.length,
                    hasMore: Boolean(nextCursor),
                    appliedFilters: args,
                },
            }
        }

        // If only responsibleUid is provided (without containers or raw filter), use responsible user filtering
        if (resolvedAssigneeId && !searchText && !hasLabels && !resolvedFilter) {
            const responsibleUserFilter = buildResponsibleUserQueryFilter({
                resolvedAssigneeId,
                assigneeEmail,
                currentUserId: todoistUser.id,
                responsibleUserFiltering,
            })
            const { results: tasks, nextCursor } = await client.getTasksByFilter({
                query: responsibleUserFilter,
                lang: 'en',
                limit,
                cursor: normalizedCursor ?? null,
            })

            const mappedTasks = tasks.map(mapTask)

            const textContent = generateTextContent({
                tasks: mappedTasks,
                args,
                nextCursor,
                isContainerSearch: false,
                assigneeEmail,
                assigneeNames: await getAssigneeShortNames(client, mappedTasks, todoistUser.id),
            })

            return {
                textContent,
                structuredContent: {
                    tasks: mappedTasks,
                    nextCursor: nextCursor ?? undefined,
                    totalCount: mappedTasks.length,
                    hasMore: Boolean(nextCursor),
                    appliedFilters: args,
                },
            }
        }

        // Handle search text and/or labels using filter query
        let query = resolvedFilter ? `(${resolvedFilter})` : ''

        // Add search text component
        if (searchText) {
            query = appendToQuery(query, `search: ${escapeFilterToken(searchText)}`)
        }

        // Add labels component
        const labelsFilter = generateLabelsFilter(labels, labelsOperator)
        query = appendToQuery(query, labelsFilter)

        // Add responsible user filtering to the query (server-side)
        // When using a saved filter (filterIdOrName), skip the default assignee filtering
        // unless the caller explicitly provided responsibleUser or responsibleUserFiltering,
        // since the saved filter may already include its own assignment logic.
        const skipDefaultAssigneeFilter =
            filterIdOrName && !responsibleUser && !responsibleUserFiltering
        if (!skipDefaultAssigneeFilter) {
            const responsibleUserFilter = buildResponsibleUserQueryFilter({
                resolvedAssigneeId,
                assigneeEmail,
                currentUserId: todoistUser.id,
                responsibleUserFiltering,
            })
            query = appendToQuery(query, responsibleUserFilter)
        }

        // Execute filter query
        const { tasks: filteredTasks, nextCursor } = await getTasksByFilter({
            client,
            query: query || 'all',
            cursor: normalizedCursor,
            limit: args.limit,
        })

        const textContent = generateTextContent({
            tasks: filteredTasks,
            args,
            nextCursor,
            isContainerSearch: false,
            assigneeEmail,
            assigneeNames: await getAssigneeShortNames(client, filteredTasks, todoistUser.id),
        })

        return {
            textContent,
            structuredContent: {
                tasks: filteredTasks,
                nextCursor: nextCursor ?? undefined,
                totalCount: filteredTasks.length,
                hasMore: Boolean(nextCursor),
                appliedFilters: args,
            },
        }
    },
} satisfies TodoistTool<typeof ArgsSchema, typeof OutputSchema>

/**
 * Saved in a container search's cursor. The cursor counts tasks of the pages the API
 * returned, so a resumed search must ask for the same pages.
 */
const ContainerCursorStateSchema = z.object({ apiLabel: z.string().optional() })
type ContainerCursorState = z.infer<typeof ContainerCursorStateSchema>

/**
 * The API label a container search started with. None for a cursor the API issued
 * directly, since that search did not filter on one.
 */
function readApiLabel(state: unknown): string | undefined {
    if (state === undefined) return undefined
    const parsed = ContainerCursorStateSchema.safeParse(state)
    if (!parsed.success) {
        throw new Error(
            'Invalid cursor. Pass the nextCursor from the previous call unchanged, with the same parameters.',
        )
    }
    return parsed.data.apiLabel
}

/**
 * A label the API can filter a container search on itself, so fewer pages need
 * fetching: the only label requested, or one of several that must all be present.
 * The API compares names exactly, so the label is first matched to the user's own
 * spelling of it, ignoring case and accents. Undefined when the API cannot filter
 * on the labels requested, or no label name matches.
 */
async function resolveApiLabel(
    client: TodoistApi,
    labels: string[] | undefined,
    labelsOperator: LabelsOperator | undefined,
): Promise<string | undefined> {
    if (!labels?.length || (labels.length > 1 && labelsOperator !== 'and')) return undefined

    try {
        const [personalLabels, sharedLabels] = await Promise.all([
            fetchAllLabelNames(client),
            fetchAllSharedLabels(client),
        ])
        const names = [...personalLabels, ...sharedLabels]
        for (const label of labels) {
            const name = findLabelName(label, names)
            if (name) return name
        }
        return undefined
    } catch (error) {
        console.error(
            `${ToolNames.FIND_TASKS}: could not look up label names, filtering labels after fetching`,
            error,
        )
        return undefined
    }
}

function getContainerZeroReasonHints(args: z.infer<z.ZodObject<typeof ArgsSchema>>): string[] {
    if (args.projectId) {
        const hints = [
            args.searchText ? 'No tasks in project match search' : 'Project has no tasks yet',
        ]
        if (!args.searchText) {
            hints.push(`Use ${ADD_TASKS} to create tasks`)
        }
        return hints
    }

    if (args.sectionId) {
        const hints = [args.searchText ? 'No tasks in section match search' : 'Section is empty']
        if (!args.searchText) {
            hints.push('Tasks may be in other sections of the project')
        }
        return hints
    }

    if (args.parentId) {
        const hints = [args.searchText ? 'No subtasks match search' : 'No subtasks created yet']
        if (!args.searchText) {
            hints.push(`Use ${ADD_TASKS} with parentId to add subtasks`)
        }
        return hints
    }

    return []
}

function generateTextContent({
    tasks,
    args,
    nextCursor,
    isContainerSearch,
    assigneeEmail,
    assigneeNames,
}: {
    tasks: MappedTask[]
    args: z.infer<z.ZodObject<typeof ArgsSchema>>
    nextCursor: string | null
    isContainerSearch: boolean
    assigneeEmail?: string
    assigneeNames: ReadonlyMap<string, string>
}) {
    // Generate subject and filter descriptions based on search type
    let subject = 'Tasks'
    const filterHints: string[] = []
    const zeroReasonHints: string[] = []

    if (isContainerSearch) {
        // Container-based search
        if (args.projectId) {
            subject = 'Tasks in project'
            filterHints.push(`in project ${args.projectId}`)
        } else if (args.sectionId) {
            subject = 'Tasks in section'
            filterHints.push(`in section ${args.sectionId}`)
        } else if (args.parentId) {
            subject = 'Subtasks'
            filterHints.push(`subtasks of ${args.parentId}`)
        } else {
            subject = 'Tasks' // fallback, though this shouldn't happen
        }

        // Add search text filter if present
        if (args.searchText) {
            subject += ` matching "${args.searchText}"`
            filterHints.push(`containing "${args.searchText}"`)
        }

        // Add responsibleUid filter if present
        if (args.responsibleUser) {
            const email = assigneeEmail || args.responsibleUser
            subject += ` assigned to ${email}`
            filterHints.push(`assigned to ${email}`)
        }

        // Add label filter information
        if (args.labels && args.labels.length > 0) {
            const labelText = formatLabelsForDisplay(args.labels, args.labelsOperator)
            filterHints.push(`labels: ${labelText}`)
        }

        // Container-specific zero result hints
        if (tasks.length === 0) {
            zeroReasonHints.push(...getContainerZeroReasonHints(args))
        }
    } else {
        // Text, responsibleUid, or labels search
        const email = assigneeEmail || args.responsibleUser

        // Build subject based on filters
        const subjectParts = []
        if (args.filter) {
            subjectParts.push(`filter: ${args.filter}`)
        }
        if (args.searchText) {
            subjectParts.push(`"${args.searchText}"`)
        }
        if (args.responsibleUser) {
            subjectParts.push(`assigned to ${email}`)
        }
        if (args.labels && args.labels.length > 0) {
            const labelText = formatLabelsForDisplay(args.labels, args.labelsOperator)
            subjectParts.push(`with labels: ${labelText}`)
        }

        if (args.filter && !args.searchText && !args.responsibleUser && !args.labels?.length) {
            subject = `Tasks matching filter: ${args.filter}`
            filterHints.push(`filter: ${args.filter}`)
        } else if (args.searchText) {
            subject = `Search results for ${subjectParts.join(' ')}`
            filterHints.push(`matching "${args.searchText}"`)
            if (args.filter) filterHints.push(`filter: ${args.filter}`)
        } else if (args.responsibleUser && (!args.labels || args.labels.length === 0)) {
            subject = `Tasks assigned to ${email}`
            if (args.filter) filterHints.push(`filter: ${args.filter}`)
        } else if (args.labels && args.labels.length > 0 && !args.responsibleUser) {
            const labelText = formatLabelsForDisplay(args.labels, args.labelsOperator)
            subject = `Tasks with labels: ${labelText}`
            if (args.filter) filterHints.push(`filter: ${args.filter}`)
        } else {
            subject = `Tasks ${subjectParts.join(' ')}`
        }

        // Add filter hints
        if (args.responsibleUser) {
            filterHints.push(`assigned to ${email}`)
        }
        if (args.labels && args.labels.length > 0) {
            const labelText = formatLabelsForDisplay(args.labels, args.labelsOperator)
            filterHints.push(`labels: ${labelText}`)
        }

        if (tasks.length === 0) {
            if (args.responsibleUser) {
                const email = assigneeEmail || args.responsibleUser
                zeroReasonHints.push(`No tasks assigned to ${email}`)
                zeroReasonHints.push('Check if the user name is correct')
                zeroReasonHints.push(`Check completed tasks with ${FIND_COMPLETED_TASKS}`)
            }
            if (args.searchText) {
                zeroReasonHints.push('Try broader search terms')
                zeroReasonHints.push('Verify spelling and try partial words')
                if (!args.responsibleUser) {
                    zeroReasonHints.push(`Check completed tasks with ${FIND_COMPLETED_TASKS}`)
                }
            }
        }
    }

    return summarizeList({
        subject,
        count: tasks.length,
        limit: args.limit,
        nextCursor: nextCursor ?? undefined,
        filterHints,
        previewLines: previewTasks(tasks, Math.min(tasks.length, args.limit), assigneeNames),
        zeroReasonHints,
    })
}

export { findTasks }
