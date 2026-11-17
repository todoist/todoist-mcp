import { listAdvertisedTools } from '@todoist/mcp-core/testing'
import { describe, expect, it } from 'vitest'
import { getMcpServer } from '../mcp-server.js'
import { registeredTools } from '../tool-registry.js'

type JsonSchemaNode = {
    type?: unknown
    maxItems?: unknown
    properties?: Record<string, JsonSchemaNode>
    items?: JsonSchemaNode
    anyOf?: JsonSchemaNode[]
    oneOf?: JsonSchemaNode[]
    allOf?: JsonSchemaNode[]
}

const UNION_KEYWORDS = ['anyOf', 'oneOf', 'allOf'] as const

/**
 * Visits every schema node reachable through properties, array items and
 * unions, with a readable path such as `add-tasks.tasks[].labels`.
 */
function walkSchema(
    node: JsonSchemaNode,
    path: string,
    visit: (node: JsonSchemaNode, path: string) => void,
): void {
    visit(node, path)
    for (const [key, child] of Object.entries(node.properties ?? {})) {
        walkSchema(child, `${path}.${key}`, visit)
    }
    if (node.items) {
        walkSchema(node.items, `${path}[]`, visit)
    }
    for (const keyword of UNION_KEYWORDS) {
        node[keyword]?.forEach((branch, index) => {
            walkSchema(branch, `${path}<${keyword}[${index}]>`, visit)
        })
    }
}

async function collectInputSchemaPaths(
    matches: (node: JsonSchemaNode) => boolean,
): Promise<string[]> {
    const tools = await listAdvertisedTools(getMcpServer({ token: 'test-token' }))
    // An empty or partial surface would leave nothing to flag and pass vacuously.
    expect(tools).toHaveLength(registeredTools.length)
    const paths: string[] = []
    for (const tool of tools) {
        walkSchema(tool.inputSchema as JsonSchemaNode, tool.name, (node, path) => {
            if (matches(node)) {
                paths.push(path)
            }
        })
    }
    return paths
}

// Directory reviews (Gemini Connected Apps) read the advertised input schemas, and so does every
// model deciding how to fill a call. These pin the two properties those reviews check.
describe('advertised input schemas', () => {
    // An uncapped list lets one runaway call create, notify or fetch without limit. A cap also
    // tells the model up front how much one call takes, instead of finding out from an API error.
    it('cap every array with maxItems', async () => {
        const uncapped = await collectInputSchemaPaths(
            (node) => node.type === 'array' && node.maxItems === undefined,
        )

        expect(uncapped).toEqual([])
    })

    // A union branch without a type reads as an untyped parameter to clients that validate
    // arguments against the schema. Stacking two string checks that each carry a regex (such as
    // `.date()` followed by `.regex()`) emits exactly that: an `allOf` of bare patterns.
    it('give every union branch a type', async () => {
        const untyped = await collectInputSchemaPaths((node) =>
            UNION_KEYWORDS.some((keyword) => node[keyword]?.some((branch) => !branch.type)),
        )

        expect(untyped).toEqual([])
    })
})
