import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { SkillsClient } from '@modelcontextprotocol/client/ext/skills'
import { describe, expect, it } from 'vitest'
import { getMcpServer, instructions } from '../mcp-server.js'
import { registeredTools } from '../tool-registry.js'
import { registeredSkills } from './skills.js'

async function withSkillsClient<T>(run: (skills: SkillsClient) => Promise<T>): Promise<T> {
    const server = getMcpServer({ token: 'test-token' })
    const client = new Client({ name: 'skills-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    try {
        return await run(new SkillsClient(client))
    } finally {
        await client.close()
        await server.close()
    }
}

describe('skills', () => {
    it('should serve the Todoist skills to a client that supports them', async () => {
        const names = await withSkillsClient(async (skills) => {
            expect(skills.supported).toBe(true)
            const { skills: entries } = await skills.list()
            return entries.map((entry) => entry.frontmatter.name)
        })

        expect(names.sort()).toEqual([
            'filter-queries',
            'plan-my-day',
            'productivity-review',
            'templates',
        ])
    })

    // A host refuses a file whose bytes differ from the digest and size in the skill's listing,
    // and refuses the whole skill when its SKILL.md frontmatter differs from the listed one.
    it('should serve every listed file exactly as its listing describes', async () => {
        const files = await withSkillsClient(async (skills) => {
            const { skills: entries } = await skills.list()
            const read: { uri: string; verified: boolean }[] = []
            for (const entry of entries) {
                const resources = entry.resources === 'dynamic' ? [] : entry.resources
                for (const resource of resources) {
                    const file = await skills.read(entry, resource.uri)
                    read.push({ uri: file.uri, verified: file.verified })
                }
            }
            return read
        })

        expect(files.map((file) => file.uri)).toContain('skill://templates/SKILL.md')
        expect(files.filter((file) => !file.verified)).toEqual([])
    })

    // Skills tell the model which tools to call. A tool renamed or removed after a skill was
    // written would leave the model calling one that does not exist.
    it('should name only tools the server registers', () => {
        const toolNames = new Set(registeredTools.map((tool) => tool.name))
        const named = registeredSkills.flatMap((skill) =>
            Object.values(skill.files).flatMap((text) =>
                [...text.matchAll(/\*\*([a-z][a-z-]*)\*\*/g)].map((match) => match[1]),
            ),
        )

        expect(named.length).toBeGreaterThan(0)
        expect(named.filter((name) => !toolNames.has(name ?? ''))).toEqual([])
    })

    // Every client reads the instructions, but only clients that support skills can load one,
    // so routing guidance has to name tools, as it does for prompts. A skill named with an
    // ordinary word ("templates") can only be caught by the instructions mentioning skills at all.
    it('should not be routed to from the server instructions', () => {
        const hyphenatedNames = registeredSkills
            .map((skill) => skill.name)
            .filter((name) => name.includes('-'))

        expect(instructions.length).toBeGreaterThan(0)
        expect(instructions).not.toMatch(/\bskills?\b/i)
        expect(hyphenatedNames.filter((name) => instructions.includes(name))).toEqual([])
    })
})
