import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { McpServer } from '@modelcontextprotocol/server'
import {
    HEALTH_STATUSES,
    type ProjectHealth,
    type ProjectProgress,
    type TodoistApi,
} from '@todoist/sdk'
import { type Mocked, vi } from 'vitest'
import { registerTools } from '../mcp-helpers.js'
import { TEST_ERRORS } from '../utils/test-helpers.js'
import { ToolNames } from '../utils/tool-names.js'
import { getProjectHealth } from './get-project-health.js'

const mockTodoistApi = {
    getProjectProgress: vi.fn(),
    getProjectHealth: vi.fn(),
} as unknown as Mocked<TodoistApi>

const { GET_PROJECT_HEALTH } = ToolNames

function createMockProgress(overrides: Partial<ProjectProgress> = {}): ProjectProgress {
    return {
        projectId: 'proj-123',
        completedCount: 15,
        activeCount: 10,
        progressPercent: 60,
        ...overrides,
    }
}

function createMockHealth(overrides: Partial<ProjectHealth> = {}): ProjectHealth {
    return {
        status: 'ON_TRACK',
        description: 'Project is progressing well.',
        descriptionSummary: 'On track',
        projectId: 'proj-123',
        updatedAt: new Date('2026-03-28T10:00:00Z'),
        isStale: false,
        updateInProgress: false,
        ...overrides,
    }
}

describe('get-project-health tool', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('ignores the removed includeContext argument from clients on the old schema', async () => {
        mockTodoistApi.getProjectProgress.mockResolvedValue(createMockProgress())
        mockTodoistApi.getProjectHealth.mockResolvedValue(createMockHealth())
        const server = new McpServer({ name: 'test', version: '0.0.0' })
        registerTools({ tools: [getProjectHealth], server, client: mockTodoistApi })
        const client = new Client({ name: 'test-client', version: '0.0.0' })
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
        try {
            const result = await client.callTool({
                name: GET_PROJECT_HEALTH,
                arguments: { projectId: 'proj-123', includeContext: true },
            })

            expect(result.isError).toBeFalsy()
            expect(result.structuredContent).toMatchObject({ health: { status: 'ON_TRACK' } })
            expect(result.structuredContent).not.toHaveProperty('context')
        } finally {
            await client.close()
            await server.close()
        }
    })

    it('should have correct tool metadata', () => {
        expect(getProjectHealth.name).toBe(GET_PROJECT_HEALTH)
        expect(getProjectHealth.annotations).toEqual({
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
        })
    })

    it('should return combined progress and health data', async () => {
        const mockProgress = createMockProgress()
        const mockHealth = createMockHealth()

        mockTodoistApi.getProjectProgress.mockResolvedValue(mockProgress)
        mockTodoistApi.getProjectHealth.mockResolvedValue(mockHealth)

        const result = await getProjectHealth.execute({ projectId: 'proj-123' }, mockTodoistApi)

        expect(mockTodoistApi.getProjectProgress).toHaveBeenCalledWith('proj-123')
        expect(mockTodoistApi.getProjectHealth).toHaveBeenCalledWith('proj-123')

        expect(result.structuredContent).toMatchObject({
            projectId: 'proj-123',
            progress: {
                completedCount: 15,
                activeCount: 10,
                progressPercent: 60,
            },
            health: {
                status: 'ON_TRACK',
                description: 'Project is progressing well.',
                isStale: false,
                updateInProgress: false,
            },
        })
    })

    it('should name the project by its ID', async () => {
        const mockProgress = createMockProgress()
        const mockHealth = createMockHealth()

        mockTodoistApi.getProjectProgress.mockResolvedValue(mockProgress)
        mockTodoistApi.getProjectHealth.mockResolvedValue(mockHealth)

        const result = await getProjectHealth.execute({ projectId: 'proj-123' }, mockTodoistApi)

        expect(result.structuredContent).toMatchObject({
            projectName: 'Project proj-123',
        })
    })

    it.each(HEALTH_STATUSES)('should handle %s health status in text output', async (status) => {
        mockTodoistApi.getProjectProgress.mockResolvedValue(createMockProgress())
        mockTodoistApi.getProjectHealth.mockResolvedValue(createMockHealth({ status }))

        const result = await getProjectHealth.execute({ projectId: 'proj-123' }, mockTodoistApi)

        expect(result.textContent).toContain(`**Status:** ${status}`)
        expect(result.structuredContent).toMatchObject({
            health: { status },
        })
    })

    it('should indicate stale health data in text output', async () => {
        mockTodoistApi.getProjectProgress.mockResolvedValue(createMockProgress())
        mockTodoistApi.getProjectHealth.mockResolvedValue(createMockHealth({ isStale: true }))

        const result = await getProjectHealth.execute({ projectId: 'proj-123' }, mockTodoistApi)

        expect(result.textContent).toContain('Health data is stale')
        expect(result.structuredContent).toMatchObject({
            health: { isStale: true },
        })
    })

    it('should indicate update in progress in text output', async () => {
        mockTodoistApi.getProjectProgress.mockResolvedValue(createMockProgress())
        mockTodoistApi.getProjectHealth.mockResolvedValue(
            createMockHealth({ updateInProgress: true }),
        )

        const result = await getProjectHealth.execute({ projectId: 'proj-123' }, mockTodoistApi)

        expect(result.textContent).toContain('update is currently in progress')
        expect(result.structuredContent).toMatchObject({
            health: { updateInProgress: true },
        })
    })

    it('should propagate API errors', async () => {
        mockTodoistApi.getProjectProgress.mockRejectedValue(new Error(TEST_ERRORS.API_RATE_LIMIT))
        mockTodoistApi.getProjectHealth.mockResolvedValue(createMockHealth())

        await expect(
            getProjectHealth.execute({ projectId: 'proj-123' }, mockTodoistApi),
        ).rejects.toThrow(TEST_ERRORS.API_RATE_LIMIT)
    })
})
