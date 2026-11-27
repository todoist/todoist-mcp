import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { TodoistApi } from '@todoist/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getMcpServer } from './mcp-server.js'
import { createMockUser } from './utils/test-helpers.js'

async function readPromptsAndInstructions() {
    const server = getMcpServer({ token: 'test-token' })
    const client = new Client({ name: 'mcp-server-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    try {
        const { prompts } = await client.listPrompts()
        return {
            promptNames: prompts.map((prompt) => prompt.name),
            instructions: client.getInstructions(),
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
        const { promptNames, instructions } = await readPromptsAndInstructions()

        expect(promptNames).toEqual(['productivity-analysis'])
        expect(promptNames.filter((name) => instructions?.includes(name))).toEqual([])
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
