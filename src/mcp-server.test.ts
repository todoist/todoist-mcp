import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { TodoistApi } from '@todoist/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getMcpServer } from './mcp-server.js'
import { createMockUser } from './utils/test-helpers.js'

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
