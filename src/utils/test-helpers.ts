import type {
    CurrentUser,
    CustomFetchResponse,
    Filter,
    Folder,
    Label,
    PersonalProject,
    Section,
    SyncCommand,
    SyncError,
    SyncResponse,
    Task,
    TodoistApi,
    Workspace,
    WorkspaceProject,
    WorkspaceProjectSummary,
} from '@todoist/sdk'
import type { Mocked } from 'vitest'
import { z } from 'zod'
import { type MappedTask } from '../tool-helpers'
import { convertPriorityToNumber, type Priority } from './priorities'

type TaskWithUserFacingPriority = Omit<Task, 'priority'> & {
    priority: Priority
}

/**
 * Creates a mock Task with all required properties and sensible defaults.
 * Pass only the properties you want to override for your specific test.
 */
export function createMockTask({
    priority = 'p4',
    ...overrides
}: Partial<TaskWithUserFacingPriority> = {}): Task {
    return {
        id: '8485093748',
        content: 'Test task content',
        description: '',
        completedAt: null,
        labels: [],
        childOrder: 1,
        projectId: '6cfCcrrCFg2xP94Q',
        sectionId: null,
        parentId: null,
        url: 'https://todoist.com/showTask?id=8485093748',
        addedByUid: '713437',
        addedAt: new Date('2025-08-13T22:09:56.123456Z'),
        deadline: null,
        responsibleUid: null,
        assignedByUid: null,
        isCollapsed: false,
        isDeleted: false,
        duration: null,
        checked: false,
        updatedAt: new Date('2025-08-13T22:09:56.123456Z'),
        due: null,
        dayOrder: 0,
        userId: '713437',
        priority: convertPriorityToNumber(priority),
        isUncompletable: false,
        ...overrides,
    }
}

/**
 * Creates a mock Section with all required properties and sensible defaults.
 * Pass only the properties you want to override for your specific test.
 */
export function createMockSection(overrides: Partial<Section> = {}): Section {
    return {
        id: 'section-123',
        projectId: '6cfCcrrCFg2xP94Q',
        sectionOrder: 1,
        userId: 'test-user',
        addedAt: new Date('2024-01-01T00:00:00Z'),
        updatedAt: new Date('2024-01-01T00:00:00Z'),
        archivedAt: null,
        isArchived: false,
        isDeleted: false,
        isCollapsed: false,
        name: 'Test Section',
        description: null,
        url: 'https://todoist.com/sections/section-123',
        ...overrides,
    }
}

/**
 * Creates a mock PersonalProject with all required properties and sensible defaults.
 * Pass only the properties you want to override for your specific test.
 */
export function createMockProject(overrides: Partial<PersonalProject> = {}): PersonalProject {
    return {
        id: '6cfCcrrCFg2xP94Q',
        name: 'Test Project',
        color: 'charcoal',
        isFavorite: false,
        isShared: false,
        parentId: null,
        inboxProject: false,
        viewStyle: 'list',
        url: 'https://todoist.com/projects/6cfCcrrCFg2xP94Q',
        isDeleted: false,
        updatedAt: new Date('2025-08-13T22:09:55.841800Z'),
        createdAt: new Date('2025-08-13T22:09:55.841785Z'),
        childOrder: 1,
        defaultOrder: 0,
        description: '',
        isCollapsed: false,
        canAssignTasks: false,
        isFrozen: false,
        isArchived: false,
        ...overrides,
    }
}

/**
 * Creates a mock WorkspaceProject with all required properties and sensible defaults.
 * Pass only the properties you want to override for your specific test.
 */
export function createMockWorkspaceProject(
    overrides: Partial<WorkspaceProject> = {},
): WorkspaceProject {
    return {
        id: TEST_IDS.PROJECT_WORKSPACE,
        name: 'Workspace Project',
        color: 'blue',
        isFavorite: false,
        isShared: true,
        viewStyle: 'list',
        url: 'https://todoist.com/projects/workspace-project-id',
        isDeleted: false,
        updatedAt: new Date('2025-08-13T22:09:55.841800Z'),
        createdAt: new Date('2025-08-13T22:09:55.841785Z'),
        childOrder: 1,
        defaultOrder: 0,
        description: '',
        isCollapsed: false,
        canAssignTasks: true,
        isFrozen: false,
        isArchived: false,
        workspaceId: TEST_IDS.WORKSPACE_1,
        folderId: null,
        collaboratorRoleDefault: 'member',
        role: 'admin',
        status: 'active',
        isInviteOnly: false,
        isLinkSharingEnabled: true,
        ...overrides,
    }
}

/**
 * Creates a mock workspace project as the workspace project listing returns it.
 * Defaults to one the user can see but hasn't joined (`role: null`).
 */
export function createMockWorkspaceProjectSummary(
    overrides: Partial<WorkspaceProjectSummary> = {},
): WorkspaceProjectSummary {
    return {
        id: 'unjoined-project-id',
        workspaceId: TEST_IDS.WORKSPACE_1,
        name: 'Sales Pipeline',
        folderId: null,
        color: 'blue',
        icon: null,
        viewStyle: 'list',
        description: '',
        status: 'IN_PROGRESS',
        role: null,
        isInviteOnly: false,
        isFrozen: false,
        canAssignTasks: true,
        defaultOrder: 1,
        defaultOrderKey: null,
        publicAccess: false,
        publicKey: 'public-key',
        access: { visibility: 'team' },
        isPendingDefaultCollaboratorInvites: false,
        url: 'https://app.todoist.com/app/project/sales-pipeline-unjoined-project-id',
        ...overrides,
    }
}

/** Converts top-level SDK fixture keys to the REST API's snake_case wire format. */
export function toApiPayload(payload: object) {
    return Object.fromEntries(
        Object.entries(payload).map(([key, value]) => [
            key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
            value,
        ]),
    )
}

/**
 * Answers a `customFetch` call with `payload` as its JSON body, in the shape the
 * SDK reads. For `*.sdk.test.ts`, which run the real `TodoistApi`.
 */
export function toFetchResponse(payload: unknown): CustomFetchResponse {
    const response = Response.json(payload)
    return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers),
        text: () => response.text(),
        json: () => response.json(),
    }
}

/**
 * Creates a mock workspace Folder with all required properties and sensible defaults.
 */
export function createMockFolder(overrides: Partial<Folder> = {}): Folder {
    return {
        id: TEST_IDS.FOLDER_1,
        name: 'Marketing',
        workspaceId: TEST_IDS.WORKSPACE_1,
        isDeleted: false,
        defaultOrder: 1,
        defaultOrderKey: null,
        childOrder: 1,
        ...overrides,
    }
}

/**
 * Creates a mock Workspace with all required properties and sensible defaults.
 */
export function createMockWorkspace(overrides: Partial<Workspace> = {}): Workspace {
    return {
        id: TEST_IDS.WORKSPACE_1,
        name: 'Test Workspace',
        plan: 'BUSINESS',
        role: 'MEMBER',
        inviteCode: 'abc123',
        isLinkSharingEnabled: true,
        isGuestAllowed: true,
        limits: { current: null, next: null },
        createdAt: new Date('2024-01-15T10:00:00Z'),
        creatorId: 'user-456',
        properties: {},
        ...overrides,
    }
}

/**
 * Creates a mock Label with all required properties and sensible defaults.
 * Pass only the properties you want to override for your specific test.
 */
export function createMockLabel(overrides: Partial<Label> = {}): Label {
    return {
        id: 'label-123',
        name: 'Test Label',
        color: 'red',
        order: 1,
        isFavorite: false,
        ...overrides,
    }
}

/**
 * Creates a mock Filter with all required properties and sensible defaults.
 */
export function createMockFilter(overrides: Partial<Filter> = {}): Filter {
    return {
        id: 'filter-1',
        name: 'Test Filter',
        query: 'today',
        color: 'charcoal',
        isDeleted: false,
        isFavorite: false,
        isFrozen: false,
        itemOrder: 0,
        ...overrides,
    }
}

/**
 * A task creation the Sync API would answer: the `item_add` arguments one command
 * carried. See {@link answerTaskCreates}.
 */
export type TaskCreateArgs = Record<string, unknown> & { content: string }

/**
 * Answers `sync` the way the Sync API answers `item_add` commands, and `getTasks`
 * with the tasks it created, for tools that create tasks through Sync.
 *
 * Each command's arguments go to `createTask`, which a test mocks like a create
 * endpoint: the task it resolves to is created, and an error it rejects with becomes
 * that command's error status, keeping its HTTP status, error code and tag.
 */
export function answerTaskCreates(
    client: Mocked<TodoistApi>,
    createTask: (args: TaskCreateArgs) => Promise<Task>,
): void {
    const created = new Map<string, Task>()
    answerSyncCommands(client, async (command) => {
        const task = await createTask(command.args as TaskCreateArgs)
        created.set(task.id, task)
        return task.id
    })
    client.getTasks.mockImplementation(async (args) =>
        createMockApiResponse((args?.ids ?? []).flatMap((id) => created.get(id) ?? [])),
    )
}

/**
 * Answers `sync` the way the Sync API answers `item_close` commands, and `getTasks`
 * with every task asked for except those in `missing`, for tools that close tasks
 * through Sync.
 *
 * Each command's task ID goes to `closeTask`, which a test mocks like the REST
 * close: resolving closes the task, and an error it rejects with becomes that
 * command's error status.
 */
export function answerTaskCloses(
    client: Mocked<TodoistApi>,
    closeTask: (id: string) => Promise<unknown>,
    { missing = [] }: { missing?: string[] } = {},
): void {
    answerSyncCommands(client, async (command) => {
        await closeTask(String(command.args.id))
        return undefined
    })
    client.getTasks.mockImplementation(async (args) =>
        createMockApiResponse(
            (args?.ids ?? [])
                .filter((id) => !missing.includes(id))
                .map((id) => createMockTask({ id })),
        ),
    )
}

/**
 * Answers `sync` the way the Sync API answers `item_uncomplete` commands, for tools
 * that reopen tasks through Sync. Each command's task ID goes to `reopenTask`, which
 * a test mocks like the REST reopen: resolving reopens the task, and an error it
 * rejects with becomes that command's error status.
 */
export function answerTaskReopens(
    client: Mocked<TodoistApi>,
    reopenTask: (id: string) => Promise<unknown>,
): void {
    answerSyncCommands(client, async (command) => {
        await reopenTask(String(command.args.id))
        return undefined
    })
}

/** Every command the `sync` mock was sent, across all its calls, in order. */
export function sentSyncCommands(client: Mocked<TodoistApi>): SyncCommand[] {
    return client.sync.mock.calls.flatMap(([request]) => request.commands ?? [])
}

/**
 * Applies each command a `sync` call carries with `apply`, reporting it as applied
 * or with the error status the API would give. `apply` returns the ID of anything
 * it created, which is mapped from the command's `tempId`.
 */
function answerSyncCommands(
    client: Mocked<TodoistApi>,
    apply: (command: SyncCommand) => Promise<string | undefined>,
): void {
    client.sync.mockImplementation(async ({ commands = [] }) => {
        const syncStatus: NonNullable<SyncResponse['syncStatus']> = {}
        const tempIdMapping: Record<string, string> = {}
        for (const command of commands) {
            try {
                const id = await apply(command)
                syncStatus[command.uuid] = 'ok'
                if (command.tempId && id) {
                    tempIdMapping[command.tempId] = id
                }
            } catch (error) {
                syncStatus[command.uuid] = toSyncCommandError(error)
            }
        }
        return { syncStatus, tempIdMapping }
    })
}

function toSyncCommandError(error: unknown): SyncError {
    const { message, httpStatusCode, responseData } = error as {
        message?: string
        httpStatusCode?: number
        responseData?: { error?: string; error_code?: number; error_tag?: string }
    }
    return {
        error: responseData?.error ?? message ?? 'Unknown error',
        errorCode: responseData?.error_code ?? 0,
        errorExtra: {},
        errorTag: responseData?.error_tag ?? '',
        httpCode: httpStatusCode ?? 400,
    }
}

/**
 * The `syncStatus` the Sync API returns when every command was applied.
 */
export function allApplied(commands: SyncCommand[] = []): Record<string, 'ok'> {
    return Object.fromEntries(commands.map((command) => [command.uuid, 'ok' as const]))
}

/**
 * Mocks the personal project limit check: the plan allows `maxProjects` active
 * personal projects and the account has `activeCount` of them.
 */
export function mockPersonalProjectCapacity(
    client: Mocked<TodoistApi>,
    { maxProjects, activeCount }: { maxProjects: number; activeCount: number },
): void {
    client.getPersonalProjectCapacity.mockResolvedValue({
        maxProjects,
        activeCount,
        remaining: Math.max(0, maxProjects - activeCount),
    })
}

/**
 * Creates a mock API response object with results and nextCursor.
 */
export function createMockApiResponse<T>(
    results: T[],
    nextCursor: string | null = null,
): {
    results: T[]
    nextCursor: string | null
} {
    return {
        results,
        nextCursor,
    }
}

/**
 * Answers a paginated list request the way the Todoist API does: the next cursor names
 * the last item returned, any page size works, and nothing comes back after an item
 * that is no longer in the list. It reads `items` on every call, so a test can change
 * the list between calls.
 */
export function paginateLikeApi<T extends { id: string }>(items: T[]) {
    return async (args?: { cursor?: string | null; limit?: number }) => {
        const cursor = args?.cursor ?? null
        const start = cursor === null ? 0 : items.findIndex((item) => item.id === cursor) + 1
        const results =
            cursor !== null && start === 0 ? [] : items.slice(start, start + (args?.limit ?? 50))
        const last = results.at(-1)
        const hasMore = start + results.length < items.length
        return { results, nextCursor: hasMore && last ? last.id : null }
    }
}

/**
 * Creates a simplified mapped task (matches mapTask output) for filter-based query tests.
 */
export function createMappedTask(overrides: Partial<MappedTask> = {}): MappedTask {
    return {
        id: TEST_IDS.TASK_1,
        content: 'Test task content',
        description: '',
        dueDate: undefined,
        recurring: false,
        deadlineDate: undefined,
        priority: 'p4',
        projectId: TEST_IDS.PROJECT_TEST,
        sectionId: undefined,
        parentId: undefined,
        labels: [],
        duration: undefined,
        responsibleUid: undefined,
        assignedByUid: undefined,
        isDeleted: undefined,
        checked: false,
        completedAt: undefined,
        addedAt: undefined,
        ...overrides,
    }
}

/**
 * Common error messages used across tests.
 */
/**
 * The `pattern` a tool advertises for one of its string parameters, as a
 * client reads it from the JSON Schema. Throws when the parameter has none, so
 * a test that relies on the pattern cannot pass by matching everything.
 */
export function getAdvertisedPattern(parameters: z.ZodRawShape, property: string): RegExp {
    const advertised = z.toJSONSchema(z.object(parameters)).properties?.[property]
    if (typeof advertised !== 'object' || typeof advertised.pattern !== 'string') {
        throw new Error(`${property} is advertised without a pattern`)
    }
    return new RegExp(advertised.pattern)
}

export const TEST_ERRORS = {
    API_RATE_LIMIT: 'API Error: Rate limit exceeded',
    API_UNAUTHORIZED: 'API Error: Unauthorized',
    INVALID_CURSOR: 'Invalid cursor format',
    INVALID_FILTER: 'Invalid filter query',
} as const

/**
 * Creates an error shaped like a rejected Todoist API call, so tests exercise the
 * signals `formatBatchItemError` reads (status, `error`, `error_tag`) rather than a
 * bare `Error` whose message collapses to "HTTP 403".
 */
export function createApiError({
    status,
    error,
    tag,
    code,
}: {
    status: number
    error: string
    tag?: string
    code?: number
}): Error {
    return Object.assign(new Error(`Request failed with status code ${status}`), {
        httpStatusCode: status,
        responseData: {
            error,
            ...(tag ? { error_tag: tag } : {}),
            ...(code !== undefined ? { error_code: code } : {}),
            http_code: status,
        },
    })
}

/**
 * Answers for a workspace project the user hasn't joined as the API does:
 * `getProject` 404s, while the workspace's project listing shows it with no
 * role. Returns the error the model should then see.
 */
export function mockUnjoinedWorkspaceProject(api: Mocked<TodoistApi>): string {
    const project = createMockWorkspaceProjectSummary()
    api.getProject.mockRejectedValue(createApiError({ status: 404, error: 'Project not found' }))
    api.getWorkspaces.mockResolvedValue([createMockWorkspace()])
    api.getWorkspaceActiveProjects.mockResolvedValue({
        results: [project],
        nextCursor: null,
        hasMore: false,
    })
    return `Project ${project.id} ("${project.name}") is a workspace project the user hasn't joined, so it can't be read yet. Ask the user whether to join it. If they agree, join it with project-management (action: "join"), then retry.`
}

/**
 * Creates multiple test cases for parameterized testing.
 */
export function createTestCases<T, E = unknown>(
    cases: Array<{ name: string; input: T; expected?: E }>,
) {
    return cases
}

/**
 * Common mock IDs used across tests for consistency.
 */
export const TEST_IDS = {
    TASK_1: '8485093748',
    TASK_2: '8485093749',
    TASK_3: '8485093750',
    PROJECT_INBOX: 'inbox-project-id',
    PROJECT_WORK: 'work-project-id',
    PROJECT_TEST: '6cfCcrrCFg2xP94Q',
    PROJECT_WORKSPACE: 'workspace-project-id',
    SECTION_1: 'section-123',
    SECTION_2: 'section-456',
    USER_ID: '713437',
    WORKSPACE_1: 'workspace-123',
    WORKSPACE_2: 'workspace-456',
    FOLDER_1: 'folder-123',
    FOLDER_2: 'folder-456',
} as const

/**
 * Fixed date for consistent test snapshots.
 * Use this instead of new Date() in tests to avoid snapshot drift.
 */
export const TODAY = '2025-08-17' as const

/**
 * Creates a mock CurrentUser with all required properties and sensible defaults.
 * Pass only the properties you want to override for your specific test.
 */
export function createMockUser(overrides: Partial<CurrentUser> = {}): CurrentUser {
    return {
        id: TEST_IDS.USER_ID,
        email: 'test@example.com',
        fullName: 'Test User',
        businessAccountId: null,
        isPremium: false,
        premiumStatus: 'not_premium',
        dateFormat: 0,
        timeFormat: 0,
        weeklyGoal: 5,
        dailyGoal: 5,
        completedCount: 0,
        completedToday: 0,
        daysOff: [],
        inboxProjectId: TEST_IDS.PROJECT_INBOX,
        karma: 0,
        karmaTrend: 'up' as const,
        lang: 'en',
        nextWeek: 1,
        startDay: 1,
        startPage: 'today',
        weekendStartDay: 6,
        tzInfo: {
            timezone: 'UTC',
            gmtString: '+00:00',
            hours: 0,
            minutes: 0,
            isDst: 0,
        },
        avatarBig: null,
        avatarMedium: null,
        avatarS640: null,
        avatarSmall: null,
        ...overrides,
    }
}
