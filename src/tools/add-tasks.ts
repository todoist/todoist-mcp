import { randomUUID } from 'node:crypto'
import { createCommand, type SyncCommand, type Task, type TodoistApi } from '@todoist/sdk'
import { z } from 'zod'
import type { TodoistTool } from '../todoist-tool.js'
import {
    DueStringParseError,
    formatBatchItemError,
    formatDueStringParseError,
} from '../tool-execution-error.js'
import { createProjectLookup, isInboxProjectId, mapTask, type Project } from '../tool-helpers.js'
import { assignmentValidator, type ValidationResult } from '../utils/assignment-validator.js'
import { logBatchFailures, partitionSettled } from '../utils/batch-failures.js'
import { BatchLimits } from '../utils/constants.js'
import { DURATION_INPUT_DESCRIPTION, parseItemDuration } from '../utils/duration-parser.js'
import { FailureSchema, TaskSchema as TaskOutputSchema } from '../utils/output-schemas.js'
import {
    convertPriorityToNumber,
    PRIORITY_INPUT_DESCRIPTION,
    PrioritySchema,
} from '../utils/priorities.js'
import { summarizeBatch, summarizeTaskOperation } from '../utils/response-builders.js'
import { executeWithRetry } from '../utils/retry.js'
import { optionalString } from '../utils/schema-helpers.js'
import { settleSyncCommands } from '../utils/sync-commands.js'
import { ToolNames } from '../utils/tool-names.js'

const MAX_TASKS_PER_OPERATION = BatchLimits.TASK_CREATES_PER_OPERATION

const TaskSchema = z.object({
    content: z
        .string()
        .min(1)
        .describe(
            'The task name/title. Should be concise and actionable (e.g., "Review PR #123", "Call dentist"). For longer content, use the description field instead. Supports Markdown.',
        ),
    description: optionalString(
        'Additional details, notes, or context for the task. Use this for longer content rather than putting it in the task name. Supports Markdown.',
    ),
    priority: PrioritySchema.optional().describe(PRIORITY_INPUT_DESCRIPTION),
    dueString: optionalString(
        'The due date for the task, in natural language. Also use natural language for recurrences; do not prefix it with "recurring".',
    ),
    deadlineDate: optionalString(
        'The deadline date for the task in ISO 8601 format (YYYY-MM-DD, e.g., "2025-12-31"). Deadlines are immovable constraints shown with a different indicator than due dates.',
    ),
    duration: optionalString(DURATION_INPUT_DESCRIPTION),
    labels: z
        .array(z.string())
        .max(BatchLimits.LABELS_PER_TASK)
        .optional()
        .describe('The labels to attach to the task.'),
    projectId: optionalString(
        'The project ID to add this task to. Project ID should be an ID string, or the text "inbox", for inbox tasks.',
    ),
    sectionId: optionalString('The section ID to add this task to.'),
    parentId: optionalString('The parent task ID (for subtasks).'),
    order: z
        .number()
        .optional()
        .describe('Position of the task among sibling tasks under the same parent/section.'),
    responsibleUser: optionalString(
        'Assign task to this user. Can be "me" (assigns to current user), a user ID, name, or email address. User must be a collaborator on the target project.',
    ),
    isUncompletable: z
        .boolean()
        .optional()
        .describe(
            'Whether this task should be uncompletable (organizational header). Tasks with isUncompletable: true appear as organizational headers and cannot be completed.',
        ),
})

const ArgsSchema = {
    tasks: z
        .array(TaskSchema)
        .min(1)
        .max(MAX_TASKS_PER_OPERATION)
        .describe(`The array of tasks to add (max ${MAX_TASKS_PER_OPERATION}).`),
}

const OutputSchema = {
    tasks: z.array(TaskOutputSchema).describe('The created tasks.'),
    totalCount: z.number().describe('The total number of tasks created.'),
    failures: z
        .array(FailureSchema)
        .describe('Tasks that could not be created, with the reason for each.'),
    totalRequested: z.number(),
    successCount: z.number(),
    failureCount: z.number(),
}

const addTasks = {
    name: ToolNames.ADD_TASKS,
    description:
        'Add one or more tasks to a project, section, or parent. Supports assignment to project collaborators.',
    parameters: ArgsSchema,
    outputSchema: OutputSchema,
    // Open world: assigning a task notifies the new assignee.
    annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
    },
    async execute(args, client) {
        // Parse through the schema to ensure transforms run (e.g., empty string stripping)
        // even when execute() is called directly without MCP server parsing
        const { tasks } = z.object(ArgsSchema).parse(args)
        const lookups = createBatchLookups(client)

        // Every task is checked and turned into a command first. One that fails a check
        // is reported on its own and never sent.
        const prepared = await Promise.allSettled(tasks.map((task) => prepareTask(task, lookups)))
        const ready = prepared.flatMap((outcome, index) => {
            const task = tasks[index]
            return outcome.status === 'fulfilled' && task ? [{ index, task, ...outcome.value }] : []
        })
        const created = await createTasks(client, ready)

        const settled = prepared.map(
            (outcome, index): PromiseSettledResult<Task> =>
                outcome.status === 'rejected'
                    ? outcome
                    : (created.get(index) ?? {
                          status: 'rejected',
                          reason: new Error('Todoist did not report whether this task was created'),
                      }),
        )
        const { succeeded, failures } = partitionSettled(tasks, settled, (task) => task.content)
        const newTasks = succeeded.map(({ value }) => value)

        // Every task is settled on its own, so a batch where all of them failed is still
        // reported as a structured result rather than thrown: each failure keeps its own
        // reason (including due-string recovery guidance) for the caller to act on.
        const mappedTasks = newTasks.map(mapTask)

        logBatchFailures(ToolNames.ADD_TASKS, tasks.length, failures, { redactItems: true })

        const textContent = generateTextContent({
            tasks: mappedTasks,
            failures,
            args: { tasks },
        })

        return {
            textContent,
            structuredContent: {
                tasks: mappedTasks,
                totalCount: mappedTasks.length,
                failures,
                totalRequested: tasks.length,
                successCount: newTasks.length,
                failureCount: failures.length,
            },
        }
    },
} satisfies TodoistTool<typeof ArgsSchema, typeof OutputSchema>

type TaskInput = z.infer<typeof TaskSchema>

type PreparedTask = { command: SyncCommand; tempId: string }

type BatchLookups = {
    lookUpProject: (projectId: string) => Promise<Project>
    /** The section's project, or undefined when the section doesn't exist. */
    lookUpSectionProject: (sectionId: string) => Promise<string | undefined>
    /** The parent task's project. Rejects when the parent can't be read. */
    lookUpParentProject: (parentId: string) => Promise<string>
    /** Whether `responsibleUser` can be assigned tasks in the project, and who that is. */
    checkAssignee: (projectId: string, responsibleUser: string) => Promise<ValidationResult>
}

/**
 * Lookups shared by every task in a batch. The tasks are checked in parallel, so
 * each lookup is kept as a promise: tasks aimed at the same project, section or
 * parent wait on one request instead of each sending their own.
 */
function createBatchLookups(client: TodoistApi): BatchLookups {
    const sectionProjects = new Map<string, Promise<string | undefined>>()
    const parentProjects = new Map<string, Promise<string>>()
    const assignees = new Map<string, Promise<ValidationResult>>()

    function cached<T>(cache: Map<string, Promise<T>>, key: string, look: () => Promise<T>) {
        let lookup = cache.get(key)
        if (!lookup) {
            lookup = look()
            cache.set(key, lookup)
        }
        return lookup
    }

    // Look each project up at most once, so a batch aimed at projects the
    // user can't read scans their workspaces once to explain why
    const lookUpProject = createProjectLookup(client)

    return {
        lookUpProject,
        lookUpSectionProject: (sectionId) =>
            cached(sectionProjects, sectionId, async () => {
                const section = await executeWithRetry(() => client.getSection(sectionId))
                return section?.projectId
            }),
        lookUpParentProject: (parentId) =>
            cached(parentProjects, parentId, async () => {
                const parent = await executeWithRetry(() => client.getTask(parentId))
                return parent.projectId
            }),
        // Keyed by project and the reference as given: a batch assigned to "me" checks once.
        checkAssignee: (projectId, responsibleUser) =>
            cached(assignees, JSON.stringify([projectId, responsibleUser]), () =>
                assignmentValidator.validateTaskCreationAssignment(
                    client,
                    projectId,
                    responsibleUser,
                    { lookUpProject },
                ),
            ),
    }
}

/**
 * Checks one task and builds the `item_add` command that creates it. Throws when the
 * task can't be created as asked, so it is reported without being sent.
 */
async function prepareTask(task: TaskInput, lookups: BatchLookups): Promise<PreparedTask> {
    const {
        content,
        description,
        duration: durationStr,
        projectId,
        sectionId,
        parentId,
        order,
        responsibleUser,
        priority,
        labels,
        dueString,
        deadlineDate,
        isUncompletable,
    } = task

    // Strip "inbox" — the API defaults to inbox when no projectId is provided
    const resolvedProjectId = isInboxProjectId(projectId) ? undefined : projectId

    // Validate project is not archived
    if (resolvedProjectId) {
        const project = await lookups.lookUpProject(resolvedProjectId)
        if (project.isArchived) {
            throw new Error(
                `Task "${content}": Cannot create task in archived project "${project.name}"`,
            )
        }
    }

    // Only prevent assignment (not task creation) without sufficient project context
    if (responsibleUser && !resolvedProjectId && !sectionId && !parentId) {
        throw new Error(
            `Task "${content}": Cannot assign tasks without specifying project context. Please specify a projectId, sectionId, or parentId.`,
        )
    }

    const duration = durationStr ? parseItemDuration(`Task "${content}"`, durationStr) : undefined

    let responsibleUid: string | undefined
    if (responsibleUser) {
        responsibleUid = await resolveAssignee(task, lookups, resolvedProjectId)
    }

    const tempId = randomUUID()
    const command = createCommand(
        'item_add',
        {
            content: isUncompletable ? withUncompletablePrefix(content) : content,
            description,
            projectId: resolvedProjectId,
            sectionId,
            parentId,
            childOrder: order,
            labels,
            priority: priority ? convertPriorityToNumber(priority) : undefined,
            due: dueString ? { string: dueString } : undefined,
            deadline: deadlineDate ? { date: deadlineDate } : undefined,
            duration,
            responsibleUid,
            // The REST create adds the user's default reminder to a task with a due
            // time; Sync only does when asked.
            autoReminder: true,
        },
        tempId,
    )
    return { command, tempId }
}

/** Resolves who a task is assigned to, checking they collaborate on its project. */
async function resolveAssignee(
    task: TaskInput,
    lookups: BatchLookups,
    resolvedProjectId: string | undefined,
): Promise<string | undefined> {
    const { content, sectionId, parentId, responsibleUser } = task
    if (!responsibleUser) {
        return undefined
    }

    // A subtask's project comes from its parent, a section task's from its section.
    let targetProjectId = resolvedProjectId
    if (!targetProjectId && parentId) {
        try {
            targetProjectId = await lookups.lookUpParentProject(parentId)
        } catch {
            throw new Error(`Task "${content}": Parent task "${parentId}" not found`)
        }
    } else if (!targetProjectId && sectionId) {
        // Real API and network errors propagate; only a missing section is "not found".
        targetProjectId = await lookups.lookUpSectionProject(sectionId)
        if (!targetProjectId) {
            throw new Error(`Task "${content}": Section "${sectionId}" not found`)
        }
    }

    if (!targetProjectId) {
        throw new Error(
            `Task "${content}": Cannot determine target project for assignment validation`,
        )
    }

    const validation = await lookups.checkAssignee(targetProjectId, responsibleUser)

    if (!validation.isValid) {
        const errorMsg = validation.error?.message || 'Assignment validation failed'
        const suggestions = validation.error?.suggestions?.join('. ') || ''
        throw new Error(`Task "${content}": ${errorMsg}${suggestions ? `. ${suggestions}` : ''}`)
    }

    return validation.resolvedUser?.userId
}

/**
 * Creates the checked tasks in one Sync request, then reads them back in one request.
 *
 * Commands are applied in the order they are sent, so sibling tasks keep the order
 * they were given in without being created one at a time. Retrying the request is
 * safe: Todoist skips a command whose `uuid` it has already applied.
 */
async function createTasks(
    client: TodoistApi,
    ready: Array<{ index: number; task: TaskInput } & PreparedTask>,
): Promise<Map<number, PromiseSettledResult<Task>>> {
    const results = new Map<number, PromiseSettledResult<Task>>()
    if (ready.length === 0) {
        return results
    }

    const { outcomes, tempIdMapping, requestFailed } = await settleSyncCommands(
        client,
        ready.map(({ command }) => command),
    )

    const createdIds = new Map<number, string>()
    ready.forEach(({ index, task, tempId }, position) => {
        const outcome = outcomes[position]
        if (outcome?.status !== 'fulfilled') {
            results.set(index, {
                status: 'rejected',
                // Only Todoist's answer about this task's own command can blame its
                // due string; a failed request says nothing about any one task.
                reason: requestFailed
                    ? outcome?.reason
                    : explainRejectedCreate(outcome?.reason, task),
            })
            return
        }
        const id = tempIdMapping[tempId]
        if (!id) {
            results.set(index, {
                status: 'rejected',
                reason: new Error(
                    'Todoist reported the task as created but did not return its ID. Check before creating it again.',
                ),
            })
            return
        }
        createdIds.set(index, id)
    })

    if (createdIds.size === 0) {
        return results
    }

    const ids = [...createdIds.values()]
    const readBack = new Map<string, Task>()
    try {
        const { results: found } = await executeWithRetry(() =>
            client.getTasks({ ids, limit: ids.length }),
        )
        for (const task of found) {
            readBack.set(task.id, task)
        }
    } catch (error) {
        // Reported per task below without the reason: each one was created, and an
        // HTTP status in that message would be read as the API rejecting the create.
        console.error(`${ToolNames.ADD_TASKS}: read-back failed`, {
            created: createdIds.size,
            error: formatBatchItemError(error),
        })
    }

    for (const [index, id] of createdIds) {
        const created = readBack.get(id)
        results.set(
            index,
            created
                ? { status: 'fulfilled', value: created }
                : {
                      status: 'rejected',
                      // The reason is left out: an HTTP status in this message would be
                      // read as the API rejecting the create.
                      reason: new Error(
                          `Created as id=${id}, but reading it back failed. Do not create it again.`,
                      ),
                  },
        )
    }
    return results
}

/** Turns a rejected create into recovery guidance where the due string was the cause. */
function explainRejectedCreate(reason: unknown, task: TaskInput): unknown {
    const recovery = formatDueStringParseError(reason, {
        taskContent: task.content,
        dueString: task.dueString,
        deadlineDate: task.deadlineDate,
    })
    return recovery ? new DueStringParseError(recovery) : reason
}

const UNCOMPLETABLE_PREFIX = '* '

/** Todoist shows a task whose content starts with "* " as an uncompletable header. */
function withUncompletablePrefix(content: string): string {
    return content.startsWith(UNCOMPLETABLE_PREFIX) ? content : `${UNCOMPLETABLE_PREFIX}${content}`
}

function generateTextContent({
    tasks,
    failures,
    args,
}: {
    tasks: ReturnType<typeof mapTask>[]
    failures: Array<{ item: string; error: string }>
    args: z.infer<z.ZodObject<typeof ArgsSchema>>
}) {
    // Generate context description for mixed contexts
    const contextTypes = new Set<string>()
    for (const task of args.tasks) {
        if (task.projectId && !isInboxProjectId(task.projectId)) contextTypes.add('projects')
        else if (task.sectionId) contextTypes.add('sections')
        else if (task.parentId) contextTypes.add('subtasks')
        else contextTypes.add('inbox')
    }

    let projectContext = ''
    if (contextTypes.size === 1) {
        const contextType = Array.from(contextTypes)[0]
        projectContext = contextType === 'inbox' ? '' : `to ${contextType}`
    } else if (contextTypes.size > 1) {
        projectContext = 'to multiple contexts'
    }

    // Use batch summary when there are failures, task summary when all succeeded
    if (failures.length > 0) {
        return summarizeBatch({
            action: `Added tasks${projectContext ? ` ${projectContext}` : ''}`,
            success: tasks.length,
            total: args.tasks.length,
            successItems: tasks.map((t) => t.content ?? 'Untitled'),
            successLabel: 'Created',
            failures,
        })
    }

    return summarizeTaskOperation('Added', tasks, {
        context: projectContext,
        showDetails: true,
    })
}

export { addTasks, MAX_TASKS_PER_OPERATION }
