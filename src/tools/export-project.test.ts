import type { TodoistApi } from '@todoist/sdk'
import { type Mocked, vi } from 'vitest'
import { TEST_IDS } from '../utils/test-helpers.js'
import { ToolNames } from '../utils/tool-names.js'
import { exportProject } from './export-project.js'

const mockTodoistApi = {
    exportProjectAsCsv: vi.fn(),
    exportTemplateAsUrl: vi.fn(),
} as unknown as Mocked<TodoistApi>

const { EXPORT_PROJECT } = ToolNames

const CSV_HEADER = 'TYPE,CONTENT,DESCRIPTION,PRIORITY'

describe(`${EXPORT_PROJECT} tool`, () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('returns the CSV content and row count', async () => {
        const csv = `${CSV_HEADER}\ntask,Buy milk,,4`
        mockTodoistApi.exportProjectAsCsv.mockResolvedValue(csv)

        const result = await exportProject.execute(
            { projectId: TEST_IDS.PROJECT_TEST, useRelativeDates: true },
            mockTodoistApi,
        )

        expect(mockTodoistApi.exportProjectAsCsv).toHaveBeenCalledWith({
            projectId: TEST_IDS.PROJECT_TEST,
            useRelativeDates: true,
        })
        expect(result.structuredContent).toEqual({ content: csv, lineCount: 2 })
        expect(result.textContent).toBe(
            `Exported project (id=${TEST_IDS.PROJECT_TEST}) as CSV (2 rows).\n\n${csv}`,
        )
    })

    it('never creates a shareable link', async () => {
        const csv = `${CSV_HEADER}\ntask,Buy milk,,4`
        mockTodoistApi.exportProjectAsCsv.mockResolvedValue(csv)

        // A caller still sending the old tool's `format: "url"` gets the CSV, not a public link.
        const result = await exportProject.execute(
            { projectId: TEST_IDS.PROJECT_TEST, format: 'url' } as Parameters<
                typeof exportProject.execute
            >[0],
            mockTodoistApi,
        )

        expect(mockTodoistApi.exportTemplateAsUrl).not.toHaveBeenCalled()
        expect(mockTodoistApi.exportProjectAsCsv).toHaveBeenCalledTimes(1)
        expect(result.structuredContent).toEqual({ content: csv, lineCount: 2 })
    })

    it('previews only the first rows of a long export', async () => {
        const rows = Array.from({ length: 12 }, (_, index) => `task,Task ${index + 1},,4`)
        mockTodoistApi.exportProjectAsCsv.mockResolvedValue([CSV_HEADER, ...rows].join('\n'))

        const result = await exportProject.execute(
            { projectId: TEST_IDS.PROJECT_TEST },
            mockTodoistApi,
        )

        expect(result.structuredContent?.lineCount).toBe(13)
        // Preview stops at 5 rows so a large project is not spelled out twice.
        expect(result.textContent).toContain('Task 4')
        expect(result.textContent).not.toContain('Task 12')
        expect(result.textContent).toContain('8 more rows')
    })

    it('ignores blank lines when counting rows', async () => {
        mockTodoistApi.exportProjectAsCsv.mockResolvedValue(`${CSV_HEADER}\n\ntask,Buy milk,,4\n\n`)

        const result = await exportProject.execute(
            { projectId: TEST_IDS.PROJECT_TEST },
            mockTodoistApi,
        )

        expect(result.structuredContent?.lineCount).toBe(2)
    })

    it('propagates export errors', async () => {
        mockTodoistApi.exportProjectAsCsv.mockRejectedValue(
            new Error('API Error: Project not found'),
        )

        await expect(
            exportProject.execute({ projectId: 'non-existent' }, mockTodoistApi),
        ).rejects.toThrow('API Error: Project not found')
    })
})
