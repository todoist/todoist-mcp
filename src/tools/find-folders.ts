import type { Folder, GetFoldersArgs, GetFoldersResponse, TodoistApi } from '@todoist/sdk'
import { z } from 'zod'
import type { TodoistTool } from '../todoist-tool.js'
import { fetchAllPages } from '../tool-helpers.js'
import { ApiLimits } from '../utils/constants.js'
import { FolderSchema, type FolderSummary, toFolderSummary } from '../utils/output-schemas.js'
import { summarizeList } from '../utils/response-builders.js'
import { executeWithRetry } from '../utils/retry.js'
import { ToolNames } from '../utils/tool-names.js'
import { type ResolvedWorkspace, workspaceResolver } from '../utils/workspace-resolver.js'

const { ADD_FOLDERS, FIND_PROJECTS, LIST_WORKSPACES } = ToolNames

const ArgsSchema = {
    workspace: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe(
            `The workspace to list folders for, by name or ID (see ${LIST_WORKSPACES}). Omit to list the folders of every workspace.`,
        ),
}

const OutputSchema = {
    folders: z.array(FolderSchema).describe('In sidebar order within each workspace.'),
    totalCount: z.number(),
}

type WorkspaceFolders = ResolvedWorkspace & { folders: FolderSummary[] }

const findFolders = {
    name: ToolNames.FIND_FOLDERS,
    description: `List the folders that group a workspace's projects. Only workspace projects go in folders; personal projects nest under a parent project instead. To see a folder's projects, use ${FIND_PROJECTS} with folderId.`,
    parameters: ArgsSchema,
    outputSchema: OutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async execute({ workspace }, client) {
        const workspaces = workspace
            ? [await workspaceResolver.resolveWorkspace(client, workspace)]
            : await workspaceResolver.listWorkspaces(client)

        const listings: WorkspaceFolders[] = await Promise.all(
            workspaces.map(async (resolved) => ({
                ...resolved,
                folders: await fetchWorkspaceFolders(client, resolved.workspaceId),
            })),
        )
        const folders = listings.flatMap((listing) => listing.folders)

        return {
            textContent: generateTextContent(listings),
            structuredContent: { folders, totalCount: folders.length },
        }
    },
} satisfies TodoistTool<typeof ArgsSchema, typeof OutputSchema>

/**
 * Reads every folder in a workspace, in the order the sidebar shows them. The
 * API lists folders by ID; `defaultOrder` follows the workspace's shared order.
 */
async function fetchWorkspaceFolders(
    client: TodoistApi,
    workspaceId: string,
): Promise<FolderSummary[]> {
    const folders = await fetchAllPages<GetFoldersArgs, GetFoldersResponse, Folder>({
        apiMethod: (args) => executeWithRetry(() => client.getFolders(args)),
        args: { workspaceId },
        limit: ApiLimits.FOLDERS_MAX,
    })
    return folders.sort((a, b) => a.defaultOrder - b.defaultOrder).map(toFolderSummary)
}

function generateTextContent(listings: WorkspaceFolders[]): string {
    if (listings.length === 0) {
        return 'The user is not in any workspace. Folders exist only in workspaces; personal projects nest under a parent project instead.'
    }

    return listings
        .map(({ workspaceId, workspaceName, folders }) =>
            summarizeList({
                subject: `Folders in ${workspaceName} (id=${workspaceId})`,
                count: folders.length,
                previewLines: folders
                    .map((folder) => `    ${folder.name} • id=${folder.id}`)
                    .join('\n'),
                zeroReasonHints: [
                    'No folders in this workspace',
                    `Use ${ADD_FOLDERS} to create one`,
                ],
            }),
        )
        .join('\n')
}

export { findFolders }
