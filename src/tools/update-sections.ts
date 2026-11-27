import type { Section, TodoistApi } from '@todoist/sdk'
import { z } from 'zod'
import type { TodoistTool } from '../todoist-tool.js'
import { formatBatchItemError, getRateLimitDetails } from '../tool-execution-error.js'
import { logBatchFailures, partitionSettled } from '../utils/batch-failures.js'
import { BatchLimits } from '../utils/constants.js'
import {
    FailureSchema,
    SectionSchema as SectionOutputSchema,
    toSectionSummary,
} from '../utils/output-schemas.js'
import { appendFailureSummary } from '../utils/response-builders.js'
import { executeWithRetry } from '../utils/retry.js'
import { ToolNames } from '../utils/tool-names.js'

const SectionUpdateSchema = z
    .object({
        id: z.string().min(1).describe('The ID of the section to update.'),
        name: z.string().min(1).optional().describe('The new name of the section.'),
        description: z
            .preprocess(
                // `null` is the advertised clear value; the param schema stays a
                // plain string (Gemini forbids nullable schemas, not preprocessing),
                // so `null` is normalised to "" and then mapped to the section
                // wire clear (`null`) at execute.
                (value) => (value === null ? '' : value),
                z
                    .string()
                    .describe(
                        'The description of the section (Markdown). Pass null (or an empty string) to clear it.',
                    ),
            )
            .optional(),
        isArchived: z
            .boolean()
            .optional()
            .describe(
                `true archives (keeping its tasks, unlike ${ToolNames.DELETE_OBJECT}), false unarchives.`,
            ),
    })
    .refine(
        (data) =>
            data.name !== undefined ||
            data.description !== undefined ||
            data.isArchived !== undefined,
        { message: 'Provide at least one of "name", "description" or "isArchived" to update.' },
    )

const ArgsSchema = {
    sections: z
        .array(SectionUpdateSchema)
        .min(1)
        .max(BatchLimits.ITEMS_PER_OPERATION)
        .describe('The sections to update.'),
}

const OutputSchema = {
    sections: z.array(SectionOutputSchema).describe('The updated sections.'),
    totalCount: z.number().describe('The total number of sections updated.'),
    updatedSectionIds: z.array(z.string()).describe('The IDs of the updated sections.'),
    failures: z
        .array(FailureSchema)
        .describe('Sections that could not be updated, with the reason for each.'),
    appliedOperations: z.object({
        updateCount: z.number(),
        failureCount: z.number(),
    }),
}

const updateSections = {
    name: ToolNames.UPDATE_SECTIONS,
    description: 'Update, archive or unarchive multiple existing sections.',
    parameters: ArgsSchema,
    outputSchema: OutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    async execute({ sections }, client) {
        // Each section is updated independently, so one rejection neither discards the
        // sections that were updated nor hides them behind one error.
        const settled = await Promise.allSettled(
            sections.map((section) => updateSection(section, client)),
        )

        const partitioned = partitionSettled(sections, settled, (section) => section.id)
        const succeeded = partitioned.succeeded.map(({ item, value }) => ({
            id: item.id,
            ...value,
        }))
        // A section whose first call worked but a later one failed is reported in both
        // lists: as updated, since what was applied stays applied, and as a failure
        // naming the step that did not happen.
        const failures = [
            ...partitioned.failures,
            ...succeeded.flatMap(({ id, partial }) =>
                partial ? [{ item: id, ...partial, code: PARTIAL_UPDATE_APPLIED }] : [],
            ),
        ]
        const updatedSections = succeeded.map(({ section }) => section)

        logBatchFailures(ToolNames.UPDATE_SECTIONS, sections.length, failures)

        const textContent = generateTextContent({
            updated: succeeded.map(({ section, archiveChange }) => ({
                section,
                isArchived: archiveChange,
            })),
            failures,
        })

        return {
            textContent,
            structuredContent: {
                sections: updatedSections.map(toSectionSummary),
                totalCount: updatedSections.length,
                updatedSectionIds: updatedSections.map((section) => section.id),
                failures,
                appliedOperations: {
                    updateCount: updatedSections.length,
                    failureCount: failures.length,
                },
            },
        }
    },
} satisfies TodoistTool<typeof ArgsSchema, typeof OutputSchema>

const PARTIAL_UPDATE_APPLIED = 'PARTIAL_UPDATE_APPLIED'

type SectionOutcome = {
    section: Section
    /** The archive state this item changed, when that call was applied. */
    archiveChange?: boolean
    /** Set when an earlier call was applied and a later one failed. */
    partial?: { error: string; retryAfterSeconds?: number }
}

/**
 * Apply one section's changes. A section is unarchived before it is renamed and
 * archived after, so the field update never lands on an archived section, and the
 * section returned is the one from the last call that worked.
 *
 * A failure on the first call rejects, so nothing was applied. A failure on a later
 * call resolves with what was applied and the step that failed, so the caller does
 * not retry a change that already happened.
 */
async function updateSection(
    { id, name, description, isArchived }: z.infer<typeof SectionUpdateSchema>,
    client: TodoistApi,
): Promise<SectionOutcome> {
    const steps: Array<{
        label: string
        archiveChange?: boolean
        run: () => Promise<Section>
    }> = []

    if (isArchived === false) {
        steps.push({
            label: 'unarchive',
            archiveChange: false,
            run: () => client.unarchiveSection(id),
        })
    }

    if (name !== undefined || description !== undefined) {
        // The SDK's UpdateSectionArgs is RequireAtLeastOne, which a
        // dynamically-built partial can't satisfy statically; the check above
        // guarantees at least one field. An empty `description` clears it, which
        // the section wire represents as `null` (backend NULL_CLEARS).
        const updateArgs = {
            ...(name !== undefined ? { name } : {}),
            ...(description !== undefined
                ? { description: description === '' ? null : description }
                : {}),
        } as Parameters<typeof client.updateSection>[1]
        steps.push({ label: 'update', run: () => client.updateSection(id, updateArgs) })
    }

    if (isArchived === true) {
        steps.push({
            label: 'archive',
            archiveChange: true,
            run: () => client.archiveSection(id),
        })
    }

    let outcome: SectionOutcome | undefined
    let applied: string | undefined

    for (const step of steps) {
        try {
            const section = await executeWithRetry(step.run)
            outcome = {
                section,
                archiveChange: step.archiveChange ?? outcome?.archiveChange,
            }
            applied = step.label
        } catch (error) {
            // The schema refine guarantees at least one step, so a first-step
            // failure always rejects here.
            if (!outcome || !applied) throw error
            const capitalised = applied.charAt(0).toUpperCase() + applied.slice(1)
            return {
                ...outcome,
                partial: {
                    error: `${capitalised} applied; ${step.label} failed: ${formatBatchItemError(error)}`,
                    ...getRateLimitDetails(error),
                },
            }
        }
    }

    // The schema refine guarantees at least one step ran.
    return outcome as SectionOutcome
}

const ARCHIVE_NOTE = { true: ' - archived', false: ' - unarchived' } as const

function generateTextContent({
    updated,
    failures,
}: {
    updated: Array<{ section: Section; isArchived: boolean | undefined }>
    failures: Array<{ item: string; error: string }>
}) {
    const count = updated.length
    const sectionList = updated
        .map(({ section, isArchived }) => {
            const note = isArchived === undefined ? '' : ARCHIVE_NOTE[`${isArchived}`]
            return `• ${section.name} (id=${section.id}, projectId=${section.projectId})${note}`
        })
        .join('\n')

    const summary =
        count > 0
            ? `Updated ${count} section${count === 1 ? '' : 's'}:\n${sectionList}`
            : 'Updated 0 sections'

    return appendFailureSummary(summary, failures)
}

export { updateSections }
