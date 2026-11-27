import type { TodoistApi } from '@todoist/sdk'
import { afterEach, type Mocked, vi } from 'vitest'
import { z } from 'zod'
import { formatToolExecutionError } from '../tool-execution-error.js'
import { executeWithRetry } from '../utils/retry.js'
import {
    createApiError,
    createMockProject,
    createMockSection,
    createMockTask,
    createMockTemplate,
    createMockToolRequest,
    getAdvertisedPattern,
    mockUnjoinedWorkspaceProject,
    TEST_IDS,
} from '../utils/test-helpers.js'
import { ToolNames } from '../utils/tool-names.js'
import { importIntoProject } from './import-into-project.js'

const mockTodoistApi = {
    getProject: vi.fn(),
    getTemplate: vi.fn(),
    getWorkspaces: vi.fn(),
    getWorkspaceActiveProjects: vi.fn(),
    importTemplateFromId: vi.fn(),
    importCsvIntoProject: vi.fn(),
} as unknown as Mocked<TodoistApi>

const { IMPORT_INTO_PROJECT } = ToolNames

function createImportResponse(overrides: Record<string, unknown> = {}) {
    return {
        status: 'ok',
        templateType: 'project',
        projects: [],
        sections: [],
        tasks: [],
        comments: [],
        ...overrides,
    }
}

describe(`${IMPORT_INTO_PROJECT} tool`, () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    describe('importing a template by ID', () => {
        it('should import a gallery template and summarize what was created', async () => {
            mockTodoistApi.importTemplateFromId.mockResolvedValue(
                createImportResponse({
                    sections: [createMockSection({ id: TEST_IDS.SECTION_1, name: 'Websites' })],
                    tasks: [
                        createMockTask({ id: TEST_IDS.TASK_1, content: 'Home page' }),
                        createMockTask({ id: TEST_IDS.TASK_2, content: 'Product page' }),
                    ],
                }),
            )

            const result = await importIntoProject.execute(
                { projectId: TEST_IDS.PROJECT_TEST, templateId: 'product-launch' },
                mockTodoistApi,
            )

            expect(mockTodoistApi.importTemplateFromId).toHaveBeenCalledWith({
                projectId: TEST_IDS.PROJECT_TEST,
                templateId: 'product-launch',
                locale: undefined,
            })
            expect(mockTodoistApi.importCsvIntoProject).not.toHaveBeenCalled()
            expect(result.structuredContent?.totalCount).toBe(3)
            expect(result.textContent).toBe(
                `Imported template into project (id=${TEST_IDS.PROJECT_TEST}): 1 section, 2 tasks.`,
            )
            expect(result.structuredContent?.sections).toEqual([
                expect.objectContaining({ id: TEST_IDS.SECTION_1, name: 'Websites' }),
            ])
            expect(result.structuredContent?.tasks).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ id: TEST_IDS.TASK_1, content: 'Home page' }),
                    expect.objectContaining({ id: TEST_IDS.TASK_2, content: 'Product page' }),
                ]),
            )
        })

        it('should count imported projects toward totalCount even though they are not returned', async () => {
            mockTodoistApi.importTemplateFromId.mockResolvedValue(
                createImportResponse({
                    projects: [{ id: 'imported-project' }],
                    tasks: [createMockTask({ id: TEST_IDS.TASK_1, content: 'Home page' })],
                }),
            )

            const result = await importIntoProject.execute(
                { projectId: TEST_IDS.PROJECT_TEST, templateId: 'product-launch' },
                mockTodoistApi,
            )

            expect(result.structuredContent?.totalCount).toBe(2)
            expect(result.structuredContent).not.toHaveProperty('projects')
            expect(result.textContent).toContain('1 project')
        })

        it('should reduce a template URL to its ID before calling the API', async () => {
            mockTodoistApi.importTemplateFromId.mockResolvedValue(createImportResponse())

            await importIntoProject.execute(
                {
                    projectId: TEST_IDS.PROJECT_TEST,
                    templateId:
                        'https://app.todoist.com/app/templates/category/my-templates/UT_28ExampleTemplateId000001/view',
                },
                mockTodoistApi,
            )

            expect(mockTodoistApi.importTemplateFromId).toHaveBeenCalledWith(
                expect.objectContaining({ templateId: 'UT_28ExampleTemplateId000001' }),
            )
        })

        it('should pass locale through', async () => {
            mockTodoistApi.importTemplateFromId.mockResolvedValue(createImportResponse())

            await importIntoProject.execute(
                {
                    projectId: TEST_IDS.PROJECT_TEST,
                    templateId: 'product-launch',
                    locale: 'de',
                },
                mockTodoistApi,
            )

            expect(mockTodoistApi.importTemplateFromId).toHaveBeenCalledWith(
                expect.objectContaining({ locale: 'de' }),
            )
        })

        it('should report an import that created nothing', async () => {
            mockTodoistApi.importTemplateFromId.mockResolvedValue(createImportResponse())

            const result = await importIntoProject.execute(
                { projectId: TEST_IDS.PROJECT_TEST, templateId: 'product-launch' },
                mockTodoistApi,
            )

            expect(result.structuredContent?.totalCount).toBe(0)
            expect(result.textContent).toContain('created nothing')
        })

        it('should propagate import errors', async () => {
            mockTodoistApi.importTemplateFromId.mockRejectedValue(
                new Error('HTTP 403: The user is not allowed to view this template'),
            )

            await expect(
                importIntoProject.execute(
                    { projectId: TEST_IDS.PROJECT_TEST, templateId: 'UT_someoneElses' },
                    mockTodoistApi,
                ),
            ).rejects.toThrow('not allowed to view this template')
        })
    })

    describe('importing CSV content', () => {
        it('should import CSV content into the project', async () => {
            mockTodoistApi.importCsvIntoProject.mockResolvedValue(
                createImportResponse({
                    tasks: [createMockTask({ id: TEST_IDS.TASK_1, content: 'Buy milk' })],
                }),
            )

            const result = await importIntoProject.execute(
                {
                    projectId: TEST_IDS.PROJECT_TEST,
                    csvFileContent: 'TYPE,CONTENT\ntask,Buy milk',
                },
                mockTodoistApi,
            )

            expect(mockTodoistApi.importCsvIntoProject).toHaveBeenCalledWith({
                projectId: TEST_IDS.PROJECT_TEST,
                file: expect.any(Blob),
                fileName: 'template.csv',
            })
            expect(mockTodoistApi.importTemplateFromId).not.toHaveBeenCalled()
            const file = mockTodoistApi.importCsvIntoProject.mock.calls[0]?.[0].file as Blob
            expect(await file.text()).toBe('TYPE,CONTENT\ntask,Buy milk')
            expect(result.textContent).toBe(
                `Imported CSV into project (id=${TEST_IDS.PROJECT_TEST}): 1 task.`,
            )
            expect(result.structuredContent?.tasks).toEqual([
                expect.objectContaining({ id: TEST_IDS.TASK_1, content: 'Buy milk' }),
            ])
        })

        it('should propagate CSV import errors', async () => {
            mockTodoistApi.importCsvIntoProject.mockRejectedValue(
                new Error('HTTP 400: Invalid CSV'),
            )

            await expect(
                importIntoProject.execute(
                    { projectId: TEST_IDS.PROJECT_TEST, csvFileContent: 'not,a,template' },
                    mockTodoistApi,
                ),
            ).rejects.toThrow('Invalid CSV')
        })
    })

    describe('failed imports', () => {
        const SOURCES = [
            ['template', 'importTemplateFromId', { templateId: 'product-launch' }],
            ['CSV', 'importCsvIntoProject', { csvFileContent: 'TYPE,CONTENT\ntask,Buy milk\n' }],
        ] as const

        it.each(SOURCES)(
            'names the project when a %s import fails, keeping the API error',
            async (_source, method, args) => {
                mockTodoistApi[method].mockRejectedValue(
                    createApiError({
                        status: 400,
                        error: 'Invalid import',
                        tag: 'INVALID_ARGUMENT',
                    }),
                )

                const error = await importIntoProject
                    .execute({ projectId: TEST_IDS.PROJECT_TEST, ...args }, mockTodoistApi)
                    .catch((caught: unknown) => caught)

                const message = formatToolExecutionError(error)
                expect(message).toContain('Invalid import')
                expect(message).toContain('HTTP 400')
                expect(message).toContain(
                    `The import into project (id=${TEST_IDS.PROJECT_TEST}) did not complete. If you created that project for this import, it may be empty.`,
                )
            },
        )

        it('is still retried after a 503, like any other call', async () => {
            vi.useFakeTimers()
            try {
                mockTodoistApi.importTemplateFromId
                    .mockRejectedValueOnce(createApiError({ status: 503, error: 'Unavailable' }))
                    .mockResolvedValueOnce(createImportResponse())

                const promise = executeWithRetry(() =>
                    importIntoProject.execute(
                        { projectId: TEST_IDS.PROJECT_TEST, templateId: 'product-launch' },
                        mockTodoistApi,
                    ),
                )
                await vi.runAllTimersAsync()
                await promise

                expect(mockTodoistApi.importTemplateFromId).toHaveBeenCalledTimes(2)
            } finally {
                vi.useRealTimers()
            }
        })
    })

    describe('source validation', () => {
        it('should reject a call with both templateId and csvFileContent', async () => {
            await expect(
                importIntoProject.execute(
                    {
                        projectId: TEST_IDS.PROJECT_TEST,
                        templateId: 'product-launch',
                        csvFileContent: 'TYPE,CONTENT',
                    },
                    mockTodoistApi,
                ),
            ).rejects.toThrow('exactly one source')

            expect(mockTodoistApi.importTemplateFromId).not.toHaveBeenCalled()
            expect(mockTodoistApi.importCsvIntoProject).not.toHaveBeenCalled()
        })

        it('should reject a call with neither templateId nor csvFileContent', async () => {
            await expect(
                importIntoProject.execute({ projectId: TEST_IDS.PROJECT_TEST }, mockTodoistApi),
            ).rejects.toThrow(
                'Provide exactly one source: either `templateId` or `csvFileContent`. Find template IDs with find-templates.',
            )
        })
    })

    // templateId is model-supplied, so the schema itself narrows it to the forms extractTemplateId
    // reads. Clients read the advertised JSON Schema pattern; the server enforces the same rule
    // through the Zod schema.
    describe('templateId validation', () => {
        const schema = z.object(importIntoProject.parameters)
        const advertisedPattern = getAdvertisedPattern(importIntoProject.parameters, 'templateId')

        it.each([
            'product-launch',
            'UT_28ExampleTemplateId000001',
            '  product-launch  ',
            'https://www.todoist.com/templates/product-launch?ref=nav#top',
            'https://app.todoist.com/app/templates/category/my-templates/UT_28ExampleTemplateId000001/view',
            'https://todoist.com/templates/product-launch/',
            // Hostnames and the scheme are case-insensitive, and a pasted link may be shouted.
            'https://WWW.TODOIST.COM/templates/product-launch',
            'HTTPS://Todoist.com/templates/product-launch',
        ])('should accept %s', (templateId) => {
            expect(schema.safeParse({ projectId: TEST_IDS.PROJECT_TEST, templateId }).success).toBe(
                true,
            )
            expect(advertisedPattern.test(templateId)).toBe(true)
        })

        it.each([
            ['an external host', 'https://attacker.example/templates/product-launch'],
            ['a host ending in the brand name', 'https://nottodoist.com/templates/product-launch'],
            ['a look-alike host', 'https://todoist.com.attacker.example/templates/product-launch'],
            ['credentials before the host', 'https://todoist.com@attacker.example/templates/x'],
            ['plain http', 'http://todoist.com/templates/product-launch'],
            ['another scheme', 'ftp://todoist.com/templates/product-launch'],
            ['a path without a host', '../templates/product-launch'],
        ])('should reject %s', (_name, templateId) => {
            expect(schema.safeParse({ projectId: TEST_IDS.PROJECT_TEST, templateId }).success).toBe(
                false,
            )
            expect(advertisedPattern.test(templateId)).toBe(false)
        })

        it('should explain a rejected templateId in words, not as the pattern', () => {
            const result = schema.safeParse({
                projectId: TEST_IDS.PROJECT_TEST,
                templateId: 'https://attacker.example/templates/product-launch',
            })

            expect(result.error?.issues[0]?.message).toBe(
                'Pass a template slug ("product-launch"), a template ID ("UT_..."), or an https URL on todoist.com or one of its subdomains.',
            )
        })
    })

    // An import writes into a project the user already has and cannot be undone, so a client that
    // can ask the user does, naming the template and the project.
    describe('asking the user first', () => {
        beforeEach(() => {
            mockTodoistApi.getProject.mockResolvedValue(createMockProject({ name: 'Q3 Plan' }))
        })

        it('should ask before importing a template, naming it and the project, and import nothing yet', async () => {
            mockTodoistApi.getTemplate.mockResolvedValue(
                createMockTemplate({ name: 'Launch plan' }),
            )
            const request = createMockToolRequest('asking')

            const result = await importIntoProject.execute(
                { projectId: TEST_IDS.PROJECT_TEST, templateId: 'UT_28Ex1' },
                mockTodoistApi,
                request,
            )

            expect(request.questions).toEqual([
                {
                    key: 'import',
                    message:
                        'Import the template "Launch plan" into the project "Q3 Plan"? Its sections, tasks and comments are added to what\'s already there. This can\'t be undone.',
                },
            ])
            expect(result).toEqual({
                inputRequired: expect.objectContaining({ resultType: 'input_required' }),
            })
            expect(mockTodoistApi.importTemplateFromId).not.toHaveBeenCalled()
        })

        // The names only make the question clearer: a lookup that fails for any reason but a
        // missing project must not stop an import the user may well confirm.
        describe('when a name cannot be read', () => {
            let consoleError: ReturnType<typeof vi.spyOn>
            beforeEach(() => {
                consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
            })
            afterEach(() => {
                consoleError.mockRestore()
            })

            it('should name the template by its ID when its details cannot be read', async () => {
                mockTodoistApi.getTemplate.mockRejectedValue(new Error('not found'))
                const request = createMockToolRequest('asking')

                await importIntoProject.execute(
                    { projectId: TEST_IDS.PROJECT_TEST, templateId: 'product-launch' },
                    mockTodoistApi,
                    request,
                )

                expect(request.questions[0]?.message).toBe(
                    'Import the template "product-launch" into the project "Q3 Plan"? Its sections, tasks and comments are added to what\'s already there. This can\'t be undone.',
                )
                expect(consoleError).toHaveBeenCalledWith(
                    'import-into-project: could not look up the template to name it',
                    { id: 'product-launch', error: expect.stringContaining('not found') },
                )
            })

            it('should name the project by its ID when it cannot be read, then import once the user confirms', async () => {
                mockTodoistApi.getProject.mockRejectedValue(
                    createApiError({ status: 502, error: 'Bad Gateway' }),
                )
                mockTodoistApi.getTemplate.mockResolvedValue(
                    createMockTemplate({ name: 'Launch plan' }),
                )
                const request = createMockToolRequest('asking')

                await importIntoProject.execute(
                    { projectId: TEST_IDS.PROJECT_TEST, templateId: 'UT_28Ex1' },
                    mockTodoistApi,
                    request,
                )

                expect(request.questions).toEqual([
                    {
                        key: 'import',
                        message: `Import the template "Launch plan" into the project (id=${TEST_IDS.PROJECT_TEST})? Its sections, tasks and comments are added to what's already there. This can't be undone.`,
                    },
                ])
                expect(consoleError).toHaveBeenCalledWith(
                    'import-into-project: could not look up the project to name it',
                    { id: TEST_IDS.PROJECT_TEST, error: expect.stringContaining('HTTP 502') },
                )
                expect(mockTodoistApi.importTemplateFromId).not.toHaveBeenCalled()

                mockTodoistApi.importTemplateFromId.mockResolvedValue(createImportResponse())
                const result = await importIntoProject.execute(
                    { projectId: TEST_IDS.PROJECT_TEST, templateId: 'UT_28Ex1' },
                    mockTodoistApi,
                    createMockToolRequest('confirmed'),
                )

                expect(mockTodoistApi.importTemplateFromId).toHaveBeenCalledWith({
                    projectId: TEST_IDS.PROJECT_TEST,
                    templateId: 'UT_28Ex1',
                    locale: undefined,
                })
                expect(result.structuredContent?.totalCount).toBe(0)
            })
        })

        // The import would fail on it anyway, and the lookup explains why, so there is
        // nothing to ask the user about.
        it('should not ask about a project that was not found', async () => {
            const expected = mockUnjoinedWorkspaceProject(mockTodoistApi)
            mockTodoistApi.getTemplate.mockResolvedValue(
                createMockTemplate({ name: 'Launch plan' }),
            )
            const request = createMockToolRequest('asking')

            const error = await importIntoProject
                .execute(
                    { projectId: 'unjoined-project-id', templateId: 'UT_28Ex1' },
                    mockTodoistApi,
                    request,
                )
                .catch((caught: unknown) => caught)

            expect(formatToolExecutionError(error)).toBe(expected)
            expect(request.questions).toEqual([])
        })

        it('should ask before importing CSV content', async () => {
            const request = createMockToolRequest('asking')

            await importIntoProject.execute(
                { projectId: TEST_IDS.PROJECT_TEST, csvFileContent: 'TYPE,CONTENT\ntask,Write' },
                mockTodoistApi,
                request,
            )

            expect(request.questions[0]?.message).toBe(
                'Import the CSV into the project "Q3 Plan"? Its sections, tasks and comments are added to what\'s already there. This can\'t be undone.',
            )
            expect(mockTodoistApi.importCsvIntoProject).not.toHaveBeenCalled()
        })

        it('should import once the user confirms', async () => {
            mockTodoistApi.importTemplateFromId.mockResolvedValue(createImportResponse())

            await importIntoProject.execute(
                { projectId: TEST_IDS.PROJECT_TEST, templateId: 'product-launch' },
                mockTodoistApi,
                createMockToolRequest('confirmed'),
            )

            expect(mockTodoistApi.importTemplateFromId).toHaveBeenCalledWith({
                projectId: TEST_IDS.PROJECT_TEST,
                templateId: 'product-launch',
                locale: undefined,
            })
            // The names are looked up only to ask, not again on the call carrying the answer.
            expect(mockTodoistApi.getProject).not.toHaveBeenCalled()
            expect(mockTodoistApi.getTemplate).not.toHaveBeenCalled()
        })

        it('should import nothing when the user declines, and say not to retry', async () => {
            const result = await importIntoProject.execute(
                { projectId: TEST_IDS.PROJECT_TEST, templateId: 'product-launch' },
                mockTodoistApi,
                createMockToolRequest('declined'),
            )

            expect(mockTodoistApi.importTemplateFromId).not.toHaveBeenCalled()
            expect(result.structuredContent).toEqual({
                sections: [],
                tasks: [],
                comments: [],
                totalCount: 0,
            })
            expect(result.textContent).toBe(
                `Nothing imported: the user declined the import into project (id=${TEST_IDS.PROJECT_TEST}). Don't try again unless they ask.`,
            )
        })

        it('should not ask when the call names no source', async () => {
            const request = createMockToolRequest('asking')

            await expect(
                importIntoProject.execute(
                    { projectId: TEST_IDS.PROJECT_TEST },
                    mockTodoistApi,
                    request,
                ),
            ).rejects.toThrow('Provide exactly one source')
            expect(request.questions).toEqual([])
        })
    })
})
