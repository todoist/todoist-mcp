import { randomUUID } from 'node:crypto'
import {
    createCommand,
    type Folder,
    PROJECT_ICONS,
    PROJECT_VIEW_STYLES,
    type PersonalProject,
    type ProjectAddArgs,
    type SyncCommand,
    type TodoistApi,
    type WorkspaceProject,
} from '@todoist/sdk'
import { z } from 'zod'
import type { TodoistTool } from '../todoist-tool.js'
import type { CreatedItem } from '../tool-execution-error.js'
import { mapProject } from '../tool-helpers.js'
import { logBatchFailures, partitionSettled } from '../utils/batch-failures.js'
import { ColorSchema } from '../utils/colors.js'
import { BatchLimits } from '../utils/constants.js'
import { FailureSchema, ProjectSchema as ProjectOutputSchema } from '../utils/output-schemas.js'
import {
    assertPersonalProjectCapacity,
    loadPersonalProjectCapacity,
    type PersonalProjectCapacity,
} from '../utils/personal-project-limit.js'
import { appendFailureSummary } from '../utils/response-builders.js'
import { executeCreateWithRetry, executeWithRetry, mayHaveCreated } from '../utils/retry.js'
import { settleSyncCommands } from '../utils/sync-commands.js'
import { ToolNames } from '../utils/tool-names.js'
import { workspaceResolver } from '../utils/workspace-resolver.js'

const { FIND_FOLDERS, FIND_PROJECTS } = ToolNames

const CREATED_PROJECT: CreatedItem = { noun: 'project', findWith: FIND_PROJECTS }

const ProjectSchema = z.object({
    name: z.string().min(1).describe('The name of the project.'),
    parentId: z
        .string()
        .optional()
        .describe('The ID of the parent project. If provided, creates this as a sub-project.'),
    isFavorite: z
        .boolean()
        .optional()
        .describe('Whether the project is a favorite. Defaults to false.'),
    viewStyle: z
        .enum(PROJECT_VIEW_STYLES)
        .optional()
        .describe('The project view style. Defaults to "list".'),
    description: z
        .string()
        .optional()
        .describe('The description of the project. Supports Markdown.'),
    color: ColorSchema,
    icon: z
        .enum(PROJECT_ICONS)
        .optional()
        .describe('The project icon. Omit for the default # icon.'),
    workspace: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe(
            'The workspace to create the project in. Accepts a workspace name or workspace ID. ' +
                'If not provided, creates a personal project. Use list-workspaces to see available workspaces.',
        ),
    folderId: z
        .string()
        .min(1)
        .optional()
        .describe(
            `Create it in this workspace folder (see ${FIND_FOLDERS}). The folder sets the workspace, so workspace can be omitted.`,
        ),
})

const ArgsSchema = {
    projects: z
        .array(ProjectSchema)
        .min(1)
        .max(BatchLimits.ITEMS_PER_OPERATION)
        .describe('The array of projects to add.'),
}

const OutputSchema = {
    projects: z.array(ProjectOutputSchema).describe('The created projects.'),
    totalCount: z.number().describe('The total number of projects created.'),
    failures: z
        .array(FailureSchema)
        .describe('Projects that could not be created, with the reason for each.'),
    totalRequested: z.number(),
    successCount: z.number(),
    failureCount: z.number(),
}

const addProjects = {
    name: ToolNames.ADD_PROJECTS,
    description: 'Add one or more new projects.',
    parameters: ArgsSchema,
    outputSchema: OutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    async execute({ projects }, client) {
        const workspaceResolutions = new Map<string, Promise<string>>()
        const folderLookups = new Map<string, Promise<Folder>>()
        const admitPersonalProject = createPersonalProjectGate(() =>
            loadPersonalProjectCapacity(client, ToolNames.ADD_PROJECTS),
        )

        const resolveWorkspaceId = (workspace: string | undefined) => {
            if (!workspace) {
                return Promise.resolve(undefined)
            }

            let resolution = workspaceResolutions.get(workspace)
            if (!resolution) {
                resolution = executeWithRetry(() =>
                    workspaceResolver.resolveWorkspace(client, workspace),
                ).then(({ workspaceId }) => workspaceId)
                workspaceResolutions.set(workspace, resolution)
            }

            return resolution
        }

        const lookupFolder = (folderId: string) => {
            let lookup = folderLookups.get(folderId)
            if (!lookup) {
                lookup = executeWithRetry(() => client.getFolder(folderId))
                folderLookups.set(folderId, lookup)
            }
            return lookup
        }

        // Projects headed for a folder are created together through Sync; the rest
        // each go through the REST create.
        const inFolders = projects.flatMap(({ folderId, ...project }, index) =>
            folderId ? [{ index, project, folderId }] : [],
        )
        const elsewhere = projects.flatMap(({ folderId, ...project }, index) =>
            folderId ? [] : [{ index, project }],
        )

        // Each project is created independently: a failure on one (for example, the API
        // rejecting it with a 403 permission error) must not discard the projects that
        // succeeded nor collapse into one opaque batch error that invites a full retry.
        // Each create goes through executeCreateWithRetry, which retries a 503 but not a
        // 502/504, since the item may already exist and the API cannot dedupe a repeat.
        const indexedOutcomes = await Promise.all([
            createProjectsInFolders(client, inFolders, { lookupFolder, resolveWorkspaceId }),
            ...elsewhere.map(async ({ project: { workspace, ...rest }, index }) => {
                const outcome = await settle(async () => {
                    const workspaceId = await resolveWorkspaceId(workspace)
                    const createProject = () =>
                        executeCreateWithRetry(
                            () =>
                                client.addProject({
                                    ...rest,
                                    ...(workspaceId ? { workspaceId } : {}),
                                }),
                            CREATED_PROJECT,
                        )
                    return workspace
                        ? await createProject()
                        : await admitPersonalProject(createProject)
                })
                return [{ index, outcome }]
            }),
        ])
        const settled = indexedOutcomes
            .flat()
            .sort((a, b) => a.index - b.index)
            .map(({ outcome }) => outcome)

        const { succeeded, failures } = partitionSettled(
            projects,
            settled,
            (project) => project.name,
        )
        const newProjects = succeeded.map(({ value }) => value)

        const mappedProjects = newProjects.map(mapProject)
        logBatchFailures(ToolNames.ADD_PROJECTS, projects.length, failures, { redactItems: true })

        const textContent = generateTextContent({ projects: newProjects, failures })

        return {
            textContent,
            structuredContent: {
                projects: mappedProjects,
                totalCount: mappedProjects.length,
                failures,
                totalRequested: projects.length,
                successCount: mappedProjects.length,
                failureCount: failures.length,
            },
        }
    },
} satisfies TodoistTool<typeof ArgsSchema, typeof OutputSchema>

type CreatedProject = PersonalProject | WorkspaceProject
type IndexedOutcome = { index: number; outcome: PromiseSettledResult<CreatedProject> }
type FolderProject = Omit<ProjectAddArgs, 'workspaceId' | 'folderId'> & { workspace?: string }

async function settle<T>(run: () => Promise<T>): Promise<PromiseSettledResult<T>> {
    try {
        return { status: 'fulfilled', value: await run() }
    } catch (reason) {
        return { status: 'rejected', reason }
    }
}

/**
 * Creates workspace projects inside folders, in one Sync request.
 *
 * The REST create takes no folder, and creating a project first and moving it
 * after would leave it at the top level of the workspace whenever the move fails.
 * Sync's `project_add` places it in the folder in the same write, so a project is
 * either created where it was asked for or not at all. Every folder (and any
 * workspace named alongside it) is checked first, and only the projects that pass
 * are sent. Retrying the Sync request is safe, since Todoist skips a command whose
 * `uuid` it has already applied.
 */
async function createProjectsInFolders(
    client: TodoistApi,
    items: Array<{ index: number; project: FolderProject; folderId: string }>,
    {
        lookupFolder,
        resolveWorkspaceId,
    }: {
        lookupFolder: (folderId: string) => Promise<Folder>
        resolveWorkspaceId: (workspace: string) => Promise<string | undefined>
    },
): Promise<IndexedOutcome[]> {
    const placed = await Promise.all(
        items.map(async ({ index, project: { workspace, ...project }, folderId }) => ({
            index,
            project,
            tempId: randomUUID(),
            folder: await settle(async () => {
                const folder = await lookupFolder(folderId)
                if (workspace && (await resolveWorkspaceId(workspace)) !== folder.workspaceId) {
                    throw new Error(
                        `Folder "${folder.name}" (id=${folder.id}) is in workspace id=${folder.workspaceId}, not "${workspace}". Omit workspace to create the project in the folder's workspace.`,
                    )
                }
                return folder
            }),
        })),
    )

    const unplaced: IndexedOutcome[] = []
    const ready: Array<{ index: number; tempId: string; command: SyncCommand }> = []
    for (const { index, project, tempId, folder } of placed) {
        if (folder.status === 'rejected') {
            unplaced.push({ index, outcome: folder })
            continue
        }
        const { workspaceId, id: folderId } = folder.value
        ready.push({
            index,
            tempId,
            command: createCommand('project_add', { ...project, workspaceId, folderId }, tempId),
        })
    }
    if (ready.length === 0) {
        return unplaced
    }

    const { outcomes, tempIdMapping } = await settleSyncCommands(
        client,
        ready.map(({ command }) => command),
        { created: CREATED_PROJECT },
    )
    const created = await Promise.all(
        ready.map(async ({ index, tempId }, position) => ({
            index,
            outcome: await settle(() =>
                readBackCreatedProject(client, outcomes[position], tempIdMapping[tempId]),
            ),
        })),
    )
    return [...unplaced, ...created]
}

/** Reads back a project its `project_add` command created, or explains why it can't. */
async function readBackCreatedProject(
    client: TodoistApi,
    outcome: PromiseSettledResult<void> | undefined,
    id: string | undefined,
): Promise<CreatedProject> {
    if (outcome?.status === 'rejected') {
        throw outcome.reason
    }
    if (!id) {
        throw new Error(
            'Todoist reported the project as created but did not return its ID. Check the folder before creating it again.',
        )
    }
    try {
        return await executeWithRetry(() => client.getProject(id))
    } catch {
        // The reason is left out: an HTTP status in this message would be read as
        // the API rejecting the create.
        throw new Error(
            `Created in the folder as id=${id}, but reading it back failed. Do not create it again.`,
        )
    }
}

/**
 * Admits a batch's personal project creations while the account has room for them.
 *
 * Creates run concurrently while there are free slots. Once every free slot is held
 * by a create still in flight, later items wait for one to settle instead of failing
 * straight away: a create the API definitely rejected frees its slot for them. Other
 * tool calls and clients can still change the count; this only keeps one batch from
 * taking the account past its limit.
 */
function createPersonalProjectGate(
    loadCapacity: () => Promise<PersonalProjectCapacity | undefined>,
) {
    let capacity: Promise<PersonalProjectCapacity | undefined> | undefined
    let inFlight = 0
    let waiting: Array<() => void> = []

    return async function admit<T>(create: () => Promise<T>): Promise<T> {
        capacity ??= loadCapacity()
        const current = await capacity
        while (current && inFlight > 0 && current.activeCount + inFlight >= current.maxProjects) {
            await new Promise<void>((resolve) => waiting.push(resolve))
        }
        assertPersonalProjectCapacity(current, 'This project was not created.')

        inFlight++
        try {
            const project = await create()
            current.activeCount++
            return project
        } catch (error) {
            if (mayHaveCreated(error)) {
                current.activeCount++
            }
            throw error
        } finally {
            inFlight--
            const woken = waiting
            waiting = []
            for (const wake of woken) {
                wake()
            }
        }
    }
}

function generateTextContent({
    projects,
    failures,
}: {
    projects: (PersonalProject | WorkspaceProject)[]
    failures: Array<{ item: string; error: string }>
}) {
    const count = projects.length
    const projectList = projects.map((project) => `• ${project.name} (id=${project.id})`).join('\n')

    const summary =
        count > 0
            ? `Added ${count} project${count === 1 ? '' : 's'}:\n${projectList}`
            : 'Added 0 projects'

    return appendFailureSummary(summary, failures)
}

export { addProjects }
