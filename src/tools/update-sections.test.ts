import type { Section, TodoistApi } from '@todoist/sdk'
import { type Mocked, vi } from 'vitest'
import { z } from 'zod'
import { createMockSection } from '../utils/test-helpers.js'
import { ToolNames } from '../utils/tool-names.js'
import { updateSections } from './update-sections.js'

// Mock the Todoist API
const mockTodoistApi = {
    updateSection: vi.fn(),
    archiveSection: vi.fn(),
    unarchiveSection: vi.fn(),
} as unknown as Mocked<TodoistApi>

const { UPDATE_SECTIONS } = ToolNames

describe(`${UPDATE_SECTIONS} tool`, () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    describe('updating a single section', () => {
        it('should update a section when id and name are provided', async () => {
            const mockApiResponse: Section = {
                id: 'existing-section-123',
                projectId: '6cfCcrrCFg2xP94Q',
                sectionOrder: 1,
                userId: 'test-user',
                addedAt: new Date('2024-01-01T00:00:00Z'),
                updatedAt: new Date('2024-01-01T00:00:00Z'),
                archivedAt: null,
                isArchived: false,
                isDeleted: false,
                isCollapsed: false,
                name: 'Updated Section Name',
                description: null,
                url: 'https://todoist.com/sections/existing-section-123',
            }

            mockTodoistApi.updateSection.mockResolvedValue(mockApiResponse)

            const result = await updateSections.execute(
                { sections: [{ id: 'existing-section-123', name: 'Updated Section Name' }] },
                mockTodoistApi,
            )

            expect(mockTodoistApi.updateSection).toHaveBeenCalledWith('existing-section-123', {
                name: 'Updated Section Name',
            })

            const textContent = result.textContent
            expect(textContent).toMatchSnapshot()
            expect(textContent).toContain('Updated 1 section:')
            expect(textContent).toContain(
                'Updated Section Name (id=existing-section-123, projectId=6cfCcrrCFg2xP94Q)',
            )

            // Verify structured content
            const structuredContent = result.structuredContent
            expect(structuredContent).toEqual(
                expect.objectContaining({
                    sections: expect.arrayContaining([
                        expect.objectContaining({
                            id: 'existing-section-123',
                            name: 'Updated Section Name',
                        }),
                    ]),
                    totalCount: 1,
                    updatedSectionIds: ['existing-section-123'],
                }),
            )
        })

        it('should update description only, without a name change', async () => {
            const mockApiResponse = createMockSection({
                id: 'sec-1',
                name: 'Planning',
            })
            mockTodoistApi.updateSection.mockResolvedValue(mockApiResponse)

            await updateSections.execute(
                { sections: [{ id: 'sec-1', description: 'Sprint backlog' }] },
                mockTodoistApi,
            )

            // No `name` is sent when only the description changes.
            expect(mockTodoistApi.updateSection).toHaveBeenCalledWith('sec-1', {
                description: 'Sprint backlog',
            })
        })

        it('clears the description with an empty string (sends null per NULL_CLEARS)', async () => {
            mockTodoistApi.updateSection.mockResolvedValue(
                createMockSection({ id: 'sec-1', name: 'Planning' }),
            )

            await updateSections.execute(
                { sections: [{ id: 'sec-1', description: '' }] },
                mockTodoistApi,
            )

            // "" is the clear input; the section wire clear value is null.
            expect(mockTodoistApi.updateSection).toHaveBeenCalledWith('sec-1', {
                description: null,
            })
        })

        it('treats legacy null as a clear (preprocessed to "")', async () => {
            mockTodoistApi.updateSection.mockResolvedValue(
                createMockSection({ id: 'sec-1', name: 'Planning' }),
            )

            // Parse through the schema so the null -> "" preprocess runs.
            const parsed = z.object(updateSections.parameters).parse({
                sections: [{ id: 'sec-1', description: null }],
            })
            await updateSections.execute(parsed, mockTodoistApi)

            expect(mockTodoistApi.updateSection).toHaveBeenCalledWith('sec-1', {
                description: null,
            })
        })

        it('saves the literal string "remove" as a description (no sentinel)', async () => {
            mockTodoistApi.updateSection.mockResolvedValue(
                createMockSection({ id: 'sec-1', name: 'Planning' }),
            )

            await updateSections.execute(
                { sections: [{ id: 'sec-1', description: 'remove' }] },
                mockTodoistApi,
            )

            expect(mockTodoistApi.updateSection).toHaveBeenCalledWith('sec-1', {
                description: 'remove',
            })
        })

        it('rejects a no-op update with no name, description or isArchived', () => {
            const result = z.object(updateSections.parameters).safeParse({
                sections: [{ id: 'sec-1' }],
            })
            expect(result.success).toBe(false)
        })
    })

    describe('archiving and unarchiving', () => {
        it('archives a section with isArchived: true, without an update call', async () => {
            mockTodoistApi.archiveSection.mockResolvedValue(
                createMockSection({
                    id: 'sec-done',
                    projectId: 'project-1',
                    name: 'Done',
                    isArchived: true,
                }),
            )

            const result = await updateSections.execute(
                { sections: [{ id: 'sec-done', isArchived: true }] },
                mockTodoistApi,
            )

            expect(mockTodoistApi.archiveSection).toHaveBeenCalledWith('sec-done')
            expect(mockTodoistApi.unarchiveSection).not.toHaveBeenCalled()
            expect(mockTodoistApi.updateSection).not.toHaveBeenCalled()
            expect(result.structuredContent.updatedSectionIds).toEqual(['sec-done'])
            expect(result.structuredContent.failures).toEqual([])
            expect(result.textContent).toContain(
                'Done (id=sec-done, projectId=project-1) - archived',
            )
        })

        it('unarchives a section with isArchived: false, without an update call', async () => {
            mockTodoistApi.unarchiveSection.mockResolvedValue(
                createMockSection({ id: 'sec-q3', projectId: 'project-1', name: 'Q3' }),
            )

            const result = await updateSections.execute(
                { sections: [{ id: 'sec-q3', isArchived: false }] },
                mockTodoistApi,
            )

            expect(mockTodoistApi.unarchiveSection).toHaveBeenCalledWith('sec-q3')
            expect(mockTodoistApi.archiveSection).not.toHaveBeenCalled()
            expect(mockTodoistApi.updateSection).not.toHaveBeenCalled()
            expect(result.structuredContent.updatedSectionIds).toEqual(['sec-q3'])
            expect(result.textContent).toContain('Q3 (id=sec-q3, projectId=project-1) - unarchived')
        })

        it('renames before archiving, and returns the archived section', async () => {
            const calls: string[] = []
            mockTodoistApi.updateSection.mockImplementation(async (id) => {
                calls.push(`update:${id}`)
                return createMockSection({ id, name: 'Sprint 12 (done)' })
            })
            mockTodoistApi.archiveSection.mockImplementation(async (id) => {
                calls.push(`archive:${id}`)
                return createMockSection({ id, name: 'Sprint 12 (done)', isArchived: true })
            })

            const result = await updateSections.execute(
                { sections: [{ id: 'sec-1', name: 'Sprint 12 (done)', isArchived: true }] },
                mockTodoistApi,
            )

            expect(calls).toEqual(['update:sec-1', 'archive:sec-1'])
            expect(mockTodoistApi.updateSection).toHaveBeenCalledWith('sec-1', {
                name: 'Sprint 12 (done)',
            })
            expect(result.textContent).toContain('Sprint 12 (done) (id=sec-1')
            expect(result.textContent).toContain('- archived')
        })

        it('unarchives before renaming, and returns the renamed section', async () => {
            const calls: string[] = []
            mockTodoistApi.unarchiveSection.mockImplementation(async (id) => {
                calls.push(`unarchive:${id}`)
                return createMockSection({ id, name: 'Q3' })
            })
            mockTodoistApi.updateSection.mockImplementation(async (id) => {
                calls.push(`update:${id}`)
                return createMockSection({ id, name: 'Q3 review' })
            })

            const result = await updateSections.execute(
                { sections: [{ id: 'sec-q3', name: 'Q3 review', isArchived: false }] },
                mockTodoistApi,
            )

            expect(calls).toEqual(['unarchive:sec-q3', 'update:sec-q3'])
            expect(result.structuredContent.sections).toEqual([
                expect.objectContaining({ id: 'sec-q3', name: 'Q3 review' }),
            ])
            expect(result.textContent).toContain('Q3 review (id=sec-q3')
            expect(result.textContent).toContain('- unarchived')
        })

        it('reports a section that could not be archived and keeps the others', async () => {
            mockTodoistApi.archiveSection.mockImplementation(async (id) => {
                if (id === 'missing') throw new Error('API Error: Section not found')
                return createMockSection({ id, name: 'Done', isArchived: true })
            })

            const result = await updateSections.execute(
                {
                    sections: [
                        { id: 'sec-done', isArchived: true },
                        { id: 'missing', isArchived: true },
                    ],
                },
                mockTodoistApi,
            )

            expect(result.structuredContent.updatedSectionIds).toEqual(['sec-done'])
            expect(result.structuredContent.failures).toEqual([
                { item: 'missing', error: 'API Error: Section not found' },
            ])
            expect(result.structuredContent.appliedOperations).toEqual({
                updateCount: 1,
                failureCount: 1,
            })
            expect(result.textContent).toContain('Failed (1) - address or drop these items')
        })

        it('keeps a rename that worked when the archive after it fails', async () => {
            mockTodoistApi.updateSection.mockResolvedValue(
                createMockSection({ id: 'sec-1', projectId: 'project-1', name: 'Sprint 12' }),
            )
            mockTodoistApi.archiveSection.mockRejectedValue(
                Object.assign(new Error('Too many requests'), {
                    httpStatusCode: 429,
                    responseData: { error_extra: { retry_after: 30 } },
                }),
            )

            const result = await updateSections.execute(
                { sections: [{ id: 'sec-1', name: 'Sprint 12', isArchived: true }] },
                mockTodoistApi,
            )

            expect(result.structuredContent.updatedSectionIds).toEqual(['sec-1'])
            expect(result.structuredContent.sections).toEqual([
                expect.objectContaining({ id: 'sec-1', name: 'Sprint 12' }),
            ])
            expect(result.structuredContent.failures).toEqual([
                expect.objectContaining({
                    item: 'sec-1',
                    code: 'PARTIAL_UPDATE_APPLIED',
                    error: expect.stringMatching(/^Update applied; archive failed: /),
                    retryAfterSeconds: 30,
                }),
            ])
            expect(result.structuredContent.appliedOperations).toEqual({
                updateCount: 1,
                failureCount: 1,
            })
            // The section was renamed but not archived, so the text must not say archived.
            expect(result.textContent).toContain('Sprint 12 (id=sec-1, projectId=project-1)\n')
            expect(result.textContent).not.toContain('- archived')
            expect(result.textContent).toContain('Update applied; archive failed')
        })

        it('keeps an unarchive that worked when the update after it fails', async () => {
            mockTodoistApi.unarchiveSection.mockResolvedValue(
                createMockSection({ id: 'sec-q3', projectId: 'project-1', name: 'Q3' }),
            )
            mockTodoistApi.updateSection.mockRejectedValue(new Error('API Error: Invalid name'))

            const result = await updateSections.execute(
                { sections: [{ id: 'sec-q3', name: 'Q3 review', isArchived: false }] },
                mockTodoistApi,
            )

            expect(result.structuredContent.updatedSectionIds).toEqual(['sec-q3'])
            expect(result.structuredContent.sections).toEqual([
                expect.objectContaining({ id: 'sec-q3', name: 'Q3' }),
            ])
            expect(result.structuredContent.failures).toEqual([
                {
                    item: 'sec-q3',
                    code: 'PARTIAL_UPDATE_APPLIED',
                    error: 'Unarchive applied; update failed: API Error: Invalid name',
                },
            ])
            expect(result.textContent).toContain('Q3 (id=sec-q3, projectId=project-1) - unarchived')
        })

        it('reports a first-step failure as a plain failure, with nothing applied', async () => {
            mockTodoistApi.updateSection.mockRejectedValue(
                new Error('API Error: Section not found'),
            )

            const result = await updateSections.execute(
                { sections: [{ id: 'missing', name: 'Renamed', isArchived: true }] },
                mockTodoistApi,
            )

            expect(mockTodoistApi.archiveSection).not.toHaveBeenCalled()
            expect(result.structuredContent.updatedSectionIds).toEqual([])
            expect(result.structuredContent.failures).toEqual([
                { item: 'missing', error: 'API Error: Section not found' },
            ])
        })

        it('accepts isArchived as the only field', () => {
            const result = z.object(updateSections.parameters).safeParse({
                sections: [{ id: 'sec-1', isArchived: true }],
            })
            expect(result.success).toBe(true)
        })
    })

    describe('updating multiple sections', () => {
        it('should update multiple sections and return mapped results', async () => {
            const mockSections = [
                createMockSection({
                    id: 'section-1',
                    projectId: 'project-1',
                    name: 'Updated First Section',
                }),
                createMockSection({
                    id: 'section-2',
                    projectId: 'project-1',
                    name: 'Updated Second Section',
                }),
                createMockSection({
                    id: 'section-3',
                    projectId: 'project-2',
                    name: 'Updated Third Section',
                }),
            ]

            const [section1, section2, section3] = mockSections as [Section, Section, Section]
            mockTodoistApi.updateSection
                .mockResolvedValueOnce(section1)
                .mockResolvedValueOnce(section2)
                .mockResolvedValueOnce(section3)

            const result = await updateSections.execute(
                {
                    sections: [
                        { id: 'section-1', name: 'Updated First Section' },
                        { id: 'section-2', name: 'Updated Second Section' },
                        { id: 'section-3', name: 'Updated Third Section' },
                    ],
                },
                mockTodoistApi,
            )

            // Verify API was called correctly for each section
            expect(mockTodoistApi.updateSection).toHaveBeenCalledTimes(3)
            expect(mockTodoistApi.updateSection).toHaveBeenNthCalledWith(1, 'section-1', {
                name: 'Updated First Section',
            })
            expect(mockTodoistApi.updateSection).toHaveBeenNthCalledWith(2, 'section-2', {
                name: 'Updated Second Section',
            })
            expect(mockTodoistApi.updateSection).toHaveBeenNthCalledWith(3, 'section-3', {
                name: 'Updated Third Section',
            })

            const textContent = result.textContent
            expect(textContent).toMatchSnapshot()
            expect(textContent).toContain('Updated 3 sections:')
            expect(textContent).toContain(
                'Updated First Section (id=section-1, projectId=project-1)',
            )
            expect(textContent).toContain(
                'Updated Second Section (id=section-2, projectId=project-1)',
            )
            expect(textContent).toContain(
                'Updated Third Section (id=section-3, projectId=project-2)',
            )

            // Verify structured content
            const structuredContent = result.structuredContent
            expect(structuredContent).toEqual(
                expect.objectContaining({
                    sections: expect.arrayContaining([
                        expect.objectContaining({ id: 'section-1', name: 'Updated First Section' }),
                        expect.objectContaining({
                            id: 'section-2',
                            name: 'Updated Second Section',
                        }),
                        expect.objectContaining({ id: 'section-3', name: 'Updated Third Section' }),
                    ]),
                    totalCount: 3,
                    updatedSectionIds: ['section-1', 'section-2', 'section-3'],
                }),
            )
        })

        it('should handle sections from the same project', async () => {
            const mockSections = [
                createMockSection({
                    id: 'section-1',
                    projectId: 'same-project',
                    name: 'Backlog',
                }),
                createMockSection({
                    id: 'section-2',
                    projectId: 'same-project',
                    name: 'Done',
                }),
            ]

            const [section1, section2] = mockSections as [Section, Section]
            mockTodoistApi.updateSection
                .mockResolvedValueOnce(section1)
                .mockResolvedValueOnce(section2)

            const result = await updateSections.execute(
                {
                    sections: [
                        { id: 'section-1', name: 'Backlog' },
                        { id: 'section-2', name: 'Done' },
                    ],
                },
                mockTodoistApi,
            )

            const textContent = result.textContent
            expect(textContent).toMatchSnapshot()
            expect(textContent).toContain('Updated 2 sections:')
        })
    })

    describe('error handling', () => {
        it('returns structured failures when every section in the batch fails', async () => {
            mockTodoistApi.updateSection.mockRejectedValue(
                new Error('API Error: Section not found'),
            )

            const result = await updateSections.execute(
                { sections: [{ id: 'nonexistent', name: 'New Name' }] },
                mockTodoistApi,
            )

            expect(result.structuredContent.sections).toEqual([])
            expect(result.structuredContent.failures).toEqual([
                { item: 'nonexistent', error: 'API Error: Section not found' },
            ])
            expect(result.structuredContent.appliedOperations).toEqual({
                updateCount: 0,
                failureCount: 1,
            })
            expect(result.textContent).toContain('Updated 0 sections')
        })

        it('should keep the updated sections when one in the batch fails', async () => {
            const mockSection = createMockSection({
                id: 'section-1',
                projectId: 'project-1',
                name: 'Updated Section',
            })

            mockTodoistApi.updateSection
                .mockResolvedValueOnce(mockSection)
                .mockRejectedValueOnce(new Error('API Error: Section not found'))

            const result = await updateSections.execute(
                {
                    sections: [
                        { id: 'section-1', name: 'Updated Section' },
                        { id: 'nonexistent', name: 'New Name' },
                    ],
                },
                mockTodoistApi,
            )

            expect(result.structuredContent.updatedSectionIds).toEqual(['section-1'])
            expect(result.structuredContent.failures).toEqual([
                { item: 'nonexistent', error: 'API Error: Section not found' },
            ])
            expect(result.structuredContent.appliedOperations).toEqual({
                updateCount: 1,
                failureCount: 1,
            })
            expect(result.textContent).toContain('Updated 1 section:')
            expect(result.textContent).toContain('Failed (1) - address or drop these items')
        })

        it('retries a transient 5xx failure on a per-section call', async () => {
            vi.useFakeTimers()
            try {
                mockTodoistApi.updateSection
                    .mockRejectedValueOnce(
                        Object.assign(new Error('Service Unavailable'), { httpStatusCode: 503 }),
                    )
                    .mockResolvedValueOnce(
                        createMockSection({ id: 'section-1', projectId: 'project-1' }),
                    )

                const promise = updateSections.execute(
                    { sections: [{ id: 'section-1', name: 'Renamed' }] },
                    mockTodoistApi,
                )
                await vi.runAllTimersAsync()
                const result = await promise

                expect(mockTodoistApi.updateSection).toHaveBeenCalledTimes(2)
                expect(result.structuredContent.appliedOperations.failureCount).toBe(0)
            } finally {
                vi.useRealTimers()
            }
        })
    })
})
