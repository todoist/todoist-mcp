import { type ColorKey, createCommand } from '@todoist/sdk'
import { z } from 'zod'
import type { TodoistTool } from '../todoist-tool.js'
import { logBatchFailures, partitionSettled } from '../utils/batch-failures.js'
import { ColorOutputSchema, ColorSchema } from '../utils/colors.js'
import { BatchLimits } from '../utils/constants.js'
import { FailureSchema } from '../utils/output-schemas.js'
import { appendFailureSummary } from '../utils/response-builders.js'
import { optionalString } from '../utils/schema-helpers.js'
import { settleSyncCommands } from '../utils/sync-commands.js'
import { ToolNames } from '../utils/tool-names.js'
import { FilterOutputSchema } from './find-filters.js'

const FilterSchema = z.object({
    name: z.string().min(1).describe('The name of the filter.'),
    query: z
        .string()
        .min(1)
        .describe(
            'The filter query string. Examples: "today & p1", "#Work & overdue", "@email & today", "(p1 | p2) & !assigned". ' +
                'Operators: | (OR), & (AND), ! (NOT), () grouping, , (multiple queries).',
        ),
    description: optionalString('A markdown description explaining what the filter is for.'),
    color: ColorSchema,
    isFavorite: z
        .boolean()
        .optional()
        .describe('Whether to mark the filter as a favorite. Defaults to false.'),
})

const ArgsSchema = {
    filters: z
        .array(FilterSchema)
        .min(1)
        .max(BatchLimits.ITEMS_PER_OPERATION)
        .describe('The array of filters to add.'),
}

const OutputSchema = {
    filters: z.array(FilterOutputSchema).describe('The created filters.'),
    totalCount: z.number().describe('The total number of filters created.'),
    failures: z
        .array(FailureSchema)
        .describe('Filters that could not be created, with the reason for each.'),
    totalRequested: z.number(),
    successCount: z.number(),
    failureCount: z.number(),
}

const addFilters = {
    name: ToolNames.ADD_FILTERS,
    description:
        'Add one or more new personal filters. Filters are saved custom views using query syntax to organize tasks.',
    parameters: ArgsSchema,
    outputSchema: OutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    async execute({ filters }, client) {
        const ts = Date.now()
        const tempIds = filters.map((_, i) => `tempFilterAdd${i}${ts}`)

        const commands = filters.map((filter, i) => {
            return createCommand(
                'filter_add',
                {
                    name: filter.name,
                    query: filter.query,
                    ...(filter.description !== undefined
                        ? { description: filter.description }
                        : {}),
                    ...(filter.color !== undefined ? { color: filter.color as ColorKey } : {}),
                    ...(filter.isFavorite !== undefined ? { isFavorite: filter.isFavorite } : {}),
                },
                tempIds[i],
            )
        })

        // Send commands only — combining resourceTypes + syncToken:'*' with commands
        // causes tempIdMapping to not be returned in the response.
        const { outcomes, tempIdMapping } = await settleSyncCommands(client, commands, {
            created: { noun: 'filter', findWith: ToolNames.FIND_FILTERS },
        })

        // A filter counts as created only once Todoist has given it an ID.
        const created = filters.map((_, i): PromiseSettledResult<string> => {
            const outcome = outcomes[i]
            if (outcome?.status === 'rejected') {
                return outcome
            }
            const tempId = tempIds[i]
            const realId = outcome && tempId !== undefined ? tempIdMapping[tempId] : undefined
            return realId
                ? { status: 'fulfilled', value: realId }
                : {
                      status: 'rejected',
                      reason: new Error('Todoist did not return an ID for the created filter'),
                  }
        })

        const { succeeded, failures } = partitionSettled(filters, created, (filter) => filter.name)

        // Reconstruct created filters from input args + server-assigned IDs
        const createdFilters = succeeded.map(
            ({ item: filter, value: id }): z.infer<typeof FilterOutputSchema> => ({
                id,
                name: filter.name,
                query: filter.query,
                // Omitted rather than null when absent: structured content is sanitised
                // with `removeNullFields`, so a null would be stripped and then fail
                // validation against the declared output schema.
                ...(filter.description ? { description: filter.description } : {}),
                color:
                    filter.color !== undefined ? ColorOutputSchema.parse(filter.color) : undefined,
                isFavorite: filter.isFavorite ?? false,
                itemOrder: 0,
            }),
        )

        logBatchFailures(ToolNames.ADD_FILTERS, filters.length, failures, { redactItems: true })

        const count = createdFilters.length
        const filterList = createdFilters.map((f) => `• ${f.name} (id=${f.id})`).join('\n')
        const summary =
            count > 0
                ? `Added ${count} filter${count === 1 ? '' : 's'}:\n${filterList}`
                : 'Added 0 filters'

        return {
            textContent: appendFailureSummary(summary, failures),
            structuredContent: {
                filters: createdFilters,
                totalCount: createdFilters.length,
                failures,
                totalRequested: filters.length,
                successCount: createdFilters.length,
                failureCount: failures.length,
            },
        }
    },
} satisfies TodoistTool<typeof ArgsSchema, typeof OutputSchema>

export { addFilters }
