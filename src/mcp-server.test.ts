import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { TodoistApi } from '@todoist/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getMcpServer } from './mcp-server.js'
import { createMockTask, createMockUser } from './utils/test-helpers.js'

// Claude Code cuts server instructions, and the description of any tool it loads upfront, at this
// many characters, and the model sees only the text before the cut:
// https://code.claude.com/docs/en/mcp#scale-with-mcp-tool-search
const CLAUDE_CODE_DESCRIPTION_LIMIT = 4_096

async function readServerCatalogue() {
    const server = getMcpServer({ token: 'test-token' })
    const client = new Client({ name: 'mcp-server-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    try {
        const [{ prompts }, { tools }] = await Promise.all([
            client.listPrompts(),
            client.listTools(),
        ])
        return {
            promptNames: prompts.map((prompt) => prompt.name),
            tools,
            instructions: client.getInstructions() ?? '',
        }
    } finally {
        await client.close()
        await server.close()
    }
}

describe('server instructions', () => {
    // Some clients only ever call tools; Gemini Connected Apps never invoke MCP prompts. An
    // instruction that routes the model to a prompt leaves it planning around a step it cannot
    // take, so routing guidance has to name tools.
    it('should not route the model to an MCP prompt', async () => {
        const { promptNames, instructions } = await readServerCatalogue()

        expect(promptNames).toEqual(['productivity-analysis'])
        expect(promptNames.filter((name) => instructions.includes(name))).toEqual([])
    })

    // Past the limit the end of the instructions is silently dropped, along with whatever
    // guidance happened to sit there.
    it("should fit within Claude Code's instructions limit", async () => {
        const { instructions } = await readServerCatalogue()

        expect(instructions.length).toBeGreaterThan(0)
        expect(instructions.length).toBeLessThanOrEqual(CLAUDE_CODE_DESCRIPTION_LIMIT)
    })
})

describe('tool descriptions', () => {
    it("should each fit within Claude Code's upfront description limit", async () => {
        const { tools } = await readServerCatalogue()

        const tooLong = tools
            .filter((tool) => (tool.description ?? '').length > CLAUDE_CODE_DESCRIPTION_LIMIT)
            .map((tool) => `${tool.name} (${tool.description?.length})`)

        expect(tooLong).toEqual([])
    })
})

describe('productivity-analysis prompt', () => {
    afterEach(() => {
        vi.useRealTimers()
        vi.restoreAllMocks()
    })

    // The prompt needs the user's timezone to know which day is today, so the server has to
    // hand it the Todoist client.
    it("should date the analysis on the user's calendar", async () => {
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(new Date('2026-11-25T02:00:00Z')) // 8 PM Nov 24 in Chicago
        vi.spyOn(TodoistApi.prototype, 'getUser').mockResolvedValue(
            createMockUser({
                tzInfo: {
                    timezone: 'America/Chicago',
                    gmtString: '-06:00',
                    hours: -6,
                    minutes: 0,
                    isDst: 0,
                },
            }),
        )

        const server = getMcpServer({ token: 'test-token' })
        const client = new Client({ name: 'mcp-server-test', version: '1.0.0' })
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
        try {
            const result = await client.getPrompt({
                name: 'productivity-analysis',
                arguments: { period: 'today' },
            })
            const content = result.messages[0]?.content

            expect(content?.type === 'text' ? content.text : '').toContain(
                '(2026-11-24 to 2026-11-24)',
            )
        } finally {
            await client.close()
            await server.close()
        }
    })
})

describe('server info', () => {
    // The description tells the people using a client what the server is for, in a server list
    // or a connector directory, before any tool is listed or called.
    it('should describe what the server does', async () => {
        const server = getMcpServer({ token: 'test-token' })
        const client = new Client({ name: 'mcp-server-test', version: '1.0.0' })
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
        try {
            expect(client.getServerVersion()).toEqual(
                expect.objectContaining({
                    name: 'todoist-mcp-server',
                    description:
                        'The official Todoist MCP server. Add, update, schedule, complete and search tasks, with priorities, due dates, deadlines, durations, labels and assignees. Organise projects, sections and folders, personal or in a workspace. Add, edit and read comments and view their attachments, and manage labels, saved filters, reminders and templates. Find collaborators, check or set your status, and review activity, project health and productivity stats.',
                }),
            )
        } finally {
            await client.close()
            await server.close()
        }
    })
})

// A client that can show a form gets asked before a delete, through the same retry, usage tracking
// and result rewriting every Todoist tool call goes through.
describe('confirming a delete over MCP', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    /** Deletes a task over MCP with a client that confirms, declines, or cannot show a form. */
    async function deleteTaskAnswering(answer: 'confirm' | 'decline' | 'cannot ask') {
        vi.spyOn(TodoistApi.prototype, 'getTask').mockResolvedValue(
            createMockTask({ content: 'Buy milk' }),
        )
        const deleteTask = vi.spyOn(TodoistApi.prototype, 'deleteTask').mockResolvedValue(true)
        const questions: string[] = []

        const server = getMcpServer({ token: 'test-token' })
        const client = new Client(
            { name: 'mcp-server-test', version: '1.0.0' },
            answer === 'cannot ask' ? {} : { capabilities: { elicitation: {} } },
        )
        if (answer !== 'cannot ask') {
            client.setRequestHandler('elicitation/create', async (request) => {
                questions.push(request.params.message)
                return answer === 'confirm'
                    ? { action: 'accept', content: { confirm: true } }
                    : { action: 'decline' }
            })
        }
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
        try {
            const result = await client.callTool({
                name: 'delete-object',
                arguments: { type: 'task', id: '8485093748' },
            })
            return { questions, deleteTask, structuredContent: result.structuredContent }
        } finally {
            await client.close()
            await server.close()
        }
    }

    it('should delete the task once the user confirms', async () => {
        const { questions, deleteTask, structuredContent } = await deleteTaskAnswering('confirm')

        expect(questions).toEqual(['Delete the task "Buy milk"? This can\'t be undone.'])
        expect(deleteTask).toHaveBeenCalledTimes(1)
        expect(structuredContent).toEqual({
            deletedEntity: { type: 'task', id: '8485093748' },
            success: true,
        })
    })

    it('should delete nothing when the user declines', async () => {
        const { deleteTask, structuredContent } = await deleteTaskAnswering('decline')

        expect(deleteTask).not.toHaveBeenCalled()
        expect(structuredContent).toEqual({
            deletedEntity: { type: 'task', id: '8485093748' },
            success: false,
        })
    })

    // A client that cannot show a form must still be able to delete, as it could before.
    it('should delete without asking when the client cannot ask', async () => {
        const { questions, deleteTask, structuredContent } = await deleteTaskAnswering('cannot ask')

        expect(questions).toEqual([])
        expect(deleteTask).toHaveBeenCalledTimes(1)
        expect(structuredContent).toEqual({
            deletedEntity: { type: 'task', id: '8485093748' },
            success: true,
        })
    })
})
