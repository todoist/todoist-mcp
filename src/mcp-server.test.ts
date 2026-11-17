import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { describe, expect, it } from 'vitest'
import { getMcpServer } from './mcp-server.js'

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
