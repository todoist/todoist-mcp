import z from 'zod'
import {
    AmbiguousUserError,
    DueStringParseError,
    formatBatchItemError,
    formatDueStringParseError,
    formatToolExecutionError,
    getRateLimitDetails,
    UnconfirmedCreateError,
} from './tool-execution-error.js'

// Longer than the 220 characters a generic error is cut to.
const AMBIGUOUS_USER_MESSAGE =
    '"Smith" matches 7 people: "Ada Smith" (ID 6Jf8VQXxpwv56VQ1), "Bo Smith" (ID 6Jf8VQXxpwv56VQ2), "Cy Smith" (ID 6Jf8VQXxpwv56VQ3), "Di Smith" (ID 6Jf8VQXxpwv56VQ4), "Ed Smith" (ID 6Jf8VQXxpwv56VQ5) and 2 more. Retry with the ID of the one you mean, or search for them with find-project-collaborators.'

describe('batch rate-limit details', () => {
    it('keeps the longest body-provided delay across raw and SDK error fields', () => {
        expect(
            getRateLimitDetails({
                httpStatusCode: 429,
                responseData: { retry_after: 30, errorExtra: { retryAfter: '90' } },
            }),
        ).toEqual({ code: 'RATE_LIMITED', retryAfterSeconds: 90 })
    })

    it.each([
        { statusCode: 429, data: { retry_after: 60 } },
        { status: 429, responseData: { retryAfter: 60 } },
        { response: { status: 429, data: { error_extra: { retry_after: 60 } } } },
        { data: { http_code: 429, retry_after: 60 } },
        new Error('Request failed', {
            cause: { response: { status: 429, data: { retry_after: 60 } } },
        }),
    ])('preserves metadata across supported structured error shapes: %j', (error) => {
        expect(getRateLimitDetails(error)).toEqual({
            code: 'RATE_LIMITED',
            retryAfterSeconds: 60,
        })
    })

    it.each([undefined, null, '', -1, Infinity, '9'.repeat(400), true, 'later'])(
        'does not invent a delay from %j',
        (retryAfter) => {
            expect(
                getRateLimitDetails({ httpStatusCode: 429, responseData: { retryAfter } }),
            ).toEqual({ code: 'RATE_LIMITED' })
        },
    )

    it('keeps a zero-second delay', () => {
        expect(
            getRateLimitDetails({ httpStatusCode: 429, responseData: { retryAfter: 0 } }),
        ).toEqual({ code: 'RATE_LIMITED', retryAfterSeconds: 0 })
    })

    it.each([
        { httpStatusCode: 403, responseData: { errorTag: 'MAX_ITEMS_LIMIT_REACHED' } },
        { httpStatusCode: 401, responseData: { retryAfter: 30 } },
        new Error('An unrelated error mentioning HTTP 429'),
    ])('does not classify an unrelated failure as a rate limit', (error) => {
        expect(getRateLimitDetails(error)).toBeUndefined()
    })

    it('retains timing on an uncertain create without changing its recovery warning', () => {
        const error = new UnconfirmedCreateError(
            { httpStatusCode: 429, responseData: { error_extra: { retry_after: 60 } } },
            { noun: 'task', findWith: 'find-tasks' },
        )
        expect(getRateLimitDetails(error)).toEqual({
            code: 'RATE_LIMITED',
            retryAfterSeconds: 60,
        })
        expect(formatBatchItemError(error)).toContain('may have been saved anyway')
    })
})

describe('formatToolExecutionError', () => {
    it('shows the people an ambiguous user reference fits in full', () => {
        expect(formatToolExecutionError(new AmbiguousUserError(AMBIGUOUS_USER_MESSAGE))).toBe(
            AMBIGUOUS_USER_MESSAGE,
        )
    })

    it('formats Todoist API errors with actionable details', () => {
        const output = formatToolExecutionError({
            httpStatusCode: 400,
            responseData: {
                error: 'Invalid due date format',
                errorCode: 42,
                errorTag: 'INVALID_ARGUMENT',
                parameter: 'dueString',
                details: 'Use natural language (e.g., "tomorrow") or YYYY-MM-DD.',
            },
        })

        expect(output).toContain(
            'Todoist API request failed (HTTP 400, code 42, tag INVALID_ARGUMENT).',
        )
        expect(output).toContain('Message: Invalid due date format')
        expect(output).toContain('Field hints: dueString')
        expect(output).toContain('Try next: Fix the field hints above and retry.')
    })

    it('supports canonical Todoist snake_case error payloads', () => {
        const output = formatToolExecutionError({
            responseData: {
                error: 'Invalid temporary id',
                error_code: 58,
                error_tag: 'INVALID_TEMP_ID',
                http_code: 400,
                error_extra: {
                    argument: 'temp_id_mapping',
                    explanation: 'At least one temporary id was not found.',
                },
            },
        })

        expect(output).toContain(
            'Todoist API request failed (HTTP 400, code 58, tag INVALID_TEMP_ID).',
        )
        expect(output).toContain('Message: Invalid temporary id')
        expect(output).toContain(
            'Details: argument: temp_id_mapping; explanation: At least one temporary id was not found.',
        )
        expect(output).toContain('Field hints: temp_id_mapping')
    })

    it('formats nested response errors consistently', () => {
        const output = formatToolExecutionError({
            message: 'Request failed with status code 404',
            response: {
                status: 404,
                data: {
                    message: 'Task not found',
                    errors: [{ field: 'taskId', message: 'No task matches this id' }],
                },
            },
        })

        expect(output).toContain('Todoist API request failed (HTTP 404).')
        expect(output).toContain('Message: Task not found')
        expect(output).toContain('Field hints: taskId: No task matches this id')
        expect(output).toContain(
            'Try next: Confirm the referenced IDs exist and are accessible, then retry.',
        )
    })

    it('extracts HTTP status from generic API error messages', () => {
        const output = formatToolExecutionError(new Error('HTTP 400: Bad Request'))

        expect(output).toContain('Todoist API request failed (HTTP 400).')
        expect(output).toContain('Message: HTTP 400: Bad Request')
        expect(output).toContain('Try next: Check parameter values and formats, then retry.')
    })

    it('advises against retrying on 403 forbidden responses', () => {
        const output = formatToolExecutionError({
            httpStatusCode: 403,
            responseData: {
                error: 'Not allowed to move objects out of a workspace',
                error_tag: 'FORBIDDEN',
                http_code: 403,
            },
        })

        expect(output).toContain('Message: Not allowed to move objects out of a workspace')
        expect(output).toContain('Retrying the same request will not help')
        expect(output).not.toContain('then retry')
    })

    it('covers both the scope/access and permission-decision remediations on 403', () => {
        const output = formatToolExecutionError({
            httpStatusCode: 403,
            responseData: {
                error: 'Insufficient token scope',
                error_tag: 'FORBIDDEN',
                http_code: 403,
            },
        })

        // A scope/access-denied 403 cannot be fixed by changing the request — the hint
        // must point the caller toward a token/account with the required access too.
        expect(output).toContain('insufficient token scope')
        expect(output).toContain('required access')
        expect(output).toContain('change the request or target')
    })

    it('keeps token guidance distinct on 401 unauthorized responses', () => {
        const output = formatToolExecutionError({
            httpStatusCode: 401,
            responseData: { error: 'Unauthorized', http_code: 401 },
        })

        expect(output).toContain(
            'Try next: Authentication failed. Verify your API token, then retry.',
        )
    })

    it('redacts secret values in API errors', () => {
        const output = formatToolExecutionError({
            httpStatusCode: 401,
            responseData: {
                error: 'Unauthorized',
                details:
                    'Authorization: Bearer secret_token_123456789 and token=another_secret_value',
            },
        })

        expect(output).toContain('Todoist API request failed (HTTP 401).')
        expect(output).toContain('[REDACTED]')
        expect(output).not.toContain('secret_token_123456789')
        expect(output).not.toContain('another_secret_value')
    })

    describe('project item-limit errors (MAX_ITEMS_LIMIT_REACHED)', () => {
        it('surfaces item-limit guidance instead of the generic 403 auth hint', () => {
            // Shape thrown by the SDK for REST calls: an Error with
            // httpStatusCode + the raw snake_case API body in responseData.
            const error = Object.assign(new Error('HTTP 403: Forbidden'), {
                httpStatusCode: 403,
                responseData: {
                    error: 'Maximum number of items exceeded',
                    error_code: 49,
                    error_tag: 'MAX_ITEMS_LIMIT_REACHED',
                    http_code: 403,
                },
            })

            const output = formatToolExecutionError(error)

            expect(output).toContain(
                'Todoist API request failed (HTTP 403, code 49, tag MAX_ITEMS_LIMIT_REACHED).',
            )
            expect(output).toContain('Message: Maximum number of items exceeded')
            expect(output).toContain('maximum number of active tasks')
            expect(output).toContain('not an authentication or permission problem')
            // The cap is identical on Beginner/Pro/Business (per the Todoist
            // usage-limits docs), so the copy must not nudge a plan upgrade.
            expect(output).toContain('upgrading will not raise it')
            expect(output).not.toContain('Verify your API token')
        })

        it('supports camelCase item-limit payloads', () => {
            const output = formatToolExecutionError({
                httpStatusCode: 403,
                responseData: {
                    error: 'Maximum number of items exceeded',
                    errorCode: 49,
                    errorTag: 'MAX_ITEMS_LIMIT_REACHED',
                },
            })

            expect(output).toContain('tag MAX_ITEMS_LIMIT_REACHED')
            expect(output).toContain('maximum number of active tasks')
            expect(output).not.toContain('Verify your API token')
        })

        it('advises against retrying plain 403s without item-limit signals', () => {
            const output = formatToolExecutionError({
                httpStatusCode: 403,
                responseData: { error: 'Forbidden' },
            })

            expect(output).toContain('Todoist API request failed (HTTP 403).')
            expect(output).toContain(
                'Try next: Access denied. Retrying the same request will not help',
            )
            expect(output).not.toContain('maximum number of active tasks')
        })

        it('recovers the item-limit tag from wrapper errors that embed per-item failures', () => {
            // A plain Error whose message embeds per-item summaries, as thrown
            // by a tool that folds its items' errors into one message.
            const output = formatToolExecutionError(
                new Error(
                    'All 1 task(s) failed to create: "one too many": Maximum number of items exceeded (HTTP 403, code 49, tag MAX_ITEMS_LIMIT_REACHED)',
                ),
            )

            expect(output).toContain('maximum number of active tasks')
            expect(output).not.toContain('Verify your API token')
        })

        it('recovers the item-limit tag from long wrapper errors before display truncation', () => {
            const longTaskTitle = 'x'.repeat(260)
            const output = formatToolExecutionError(
                new Error(
                    `All 1 task(s) failed to create: "${longTaskTitle}": Maximum number of items exceeded (HTTP 403, code 49, tag MAX_ITEMS_LIMIT_REACHED)`,
                ),
            )

            expect(output).toContain('maximum number of active tasks')
            expect(output).not.toContain('Verify your API token')
        })
    })

    describe('plan-restricted features (PREMIUM_ONLY)', () => {
        // The shape a rejected Sync command is settled with: the SDK's camelCase status.
        const deadlineOnFreePlan = Object.assign(new Error('Premium only feature'), {
            httpStatusCode: 403,
            responseData: {
                error: 'Premium only feature',
                errorCode: 32,
                errorTag: 'PREMIUM_ONLY',
                httpCode: 403,
                errorExtra: { explanation: 'Deadlines are a premium only feature' },
            },
        })

        it('explains the plan restriction instead of the generic 403 access hint', () => {
            const output = formatToolExecutionError(deadlineOnFreePlan)

            expect(output).toContain(
                'Todoist API request failed (HTTP 403, code 32, tag PREMIUM_ONLY).',
            )
            expect(output).toContain("Try next: The user's Todoist plan does not include")
            expect(output).toContain('retry without `deadlineDate`')
            expect(output).toContain('retry with a more recent date range')
            expect(output).not.toContain('insufficient token scope')
        })
    })

    describe('unparseable dates (INVALID_DATE)', () => {
        const invalidDate = Object.assign(new Error('Date is invalid'), {
            httpStatusCode: 400,
            responseData: {
                error: 'Date is invalid',
                errorCode: 480,
                errorTag: 'INVALID_DATE',
                httpCode: 400,
            },
        })

        it('says what a parseable date looks like instead of the generic 400 hint', () => {
            const output = formatToolExecutionError(invalidDate)

            expect(output).toContain('Try next: Todoist could not parse a date in this request.')
            expect(output).toContain('a period such as "this week" is not a date')
            expect(output).toContain('YYYY-MM-DD')
            expect(output).not.toContain('Check parameter values and formats')
        })
    })

    describe('formatBatchItemError', () => {
        it('shows the people an ambiguous user reference fits in full', () => {
            expect(formatBatchItemError(new AmbiguousUserError(AMBIGUOUS_USER_MESSAGE))).toBe(
                AMBIGUOUS_USER_MESSAGE,
            )
        })

        it('keeps the status of a create that may have been saved and says where to check', () => {
            const cause = Object.assign(new Error('Bad Gateway'), { httpStatusCode: 502 })

            expect(
                formatBatchItemError(
                    new UnconfirmedCreateError(cause, { noun: 'label', findWith: 'find-labels' }),
                ),
            ).toBe(
                'Bad Gateway (HTTP 502). The label may have been saved anyway. Check with find-labels before adding it again.',
            )
        })

        it.each([
            {
                tag: 'MAX_ITEMS_LIMIT_REACHED',
                status: 403,
                code: 49,
                error: 'Maximum number of items exceeded',
                expected:
                    'Maximum number of items exceeded (HTTP 403, code 49, tag MAX_ITEMS_LIMIT_REACHED). This project has reached the maximum number of active tasks per project (subtasks count toward it; completed tasks do not). The cap is the same on every Todoist plan — upgrading will not raise it — and it is not an authentication or permission problem. Complete, delete, or move existing tasks out of the project, or add the task to a different project, then retry.',
            },
            {
                // No batch tool reads the activity log, so the per-item wording
                // leaves out the advice about its date range.
                tag: 'PREMIUM_ONLY',
                status: 403,
                code: 32,
                error: 'Premium only feature',
                expected:
                    "Premium only feature (HTTP 403, code 32, tag PREMIUM_ONLY). The user's Todoist plan does not include a feature this item used. It is not an authentication or permission problem, and retrying the same item will not help. On a task it is most often a deadline on a free plan: retry without `deadlineDate`. Tell the user what was left out and that it needs a plan upgrade.",
            },
            {
                tag: 'INVALID_DATE',
                status: 400,
                code: 480,
                error: 'Date is invalid',
                expected:
                    'Date is invalid (HTTP 400, code 480, tag INVALID_DATE). Todoist could not parse a date in this request. A due string must name one specific date or recurrence, such as "tomorrow", "Friday at 3pm", "2026-12-01" or "every weekday"; a period such as "this week" is not a date. Where a field asks for YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS, send exactly that, not words such as "today". Change only the date and retry.',
            },
        ])(
            'keeps the API error signals and explains the $tag tag',
            ({ tag, status, code, error, expected }) => {
                const apiError = Object.assign(new Error(`HTTP ${status}`), {
                    httpStatusCode: status,
                    responseData: {
                        error,
                        error_code: code,
                        error_tag: tag,
                        http_code: status,
                    },
                })

                expect(formatBatchItemError(apiError)).toBe(expected)
            },
        )

        it('adds no explanation to an error without a known tag', () => {
            const error = Object.assign(new Error('HTTP 404: Not Found'), {
                httpStatusCode: 404,
                responseData: { error: 'Task not found', error_tag: 'ITEM_NOT_FOUND' },
            })

            expect(formatBatchItemError(error)).toBe(
                'Task not found (HTTP 404, tag ITEM_NOT_FOUND)',
            )
        })

        it('avoids repeating generic HTTP messages when context is available', () => {
            const error = Object.assign(new Error('HTTP 403: Forbidden'), {
                httpStatusCode: 403,
            })

            expect(formatBatchItemError(error)).toBe('Todoist API request failed (HTTP 403)')
        })

        it('returns plain messages for non-API errors', () => {
            expect(formatBatchItemError(new Error('Section "xyz" not found'))).toBe(
                'Section "xyz" not found',
            )
        })
    })

    describe('formatDueStringParseError', () => {
        it('gives an explicit retry for the malformed recurring prefix', () => {
            const error = Object.assign(new Error('HTTP 400: Bad Request'), {
                httpStatusCode: 400,
                responseData: { error: 'Invalid date format' },
            })

            expect(
                formatDueStringParseError(error, {
                    taskContent: 'Lavendel abschneiden',
                    dueString: 'recurring every year on July 1',
                }),
            ).toBe(
                'Task "Lavendel abschneiden" wasn\'t created because `dueString` could not be parsed. Use Todoist recurrence syntax, for example `every year on July 1`; don\'t prefix it with `recurring`. Change only `dueString` and retry.',
            )
        })

        it.each([
            { name: 'the REST create', responseData: { error: 'Invalid date format' } },
            {
                // Sync reports an unparseable due string this way, as the real API showed.
                name: 'a Sync command',
                responseData: {
                    error: 'Date is invalid',
                    errorCode: 480,
                    errorTag: 'INVALID_DATE',
                    httpCode: 400,
                },
            },
        ])('recognises an unparseable dueString reported by $name', ({ responseData }) => {
            const error = Object.assign(new Error('HTTP 400: Bad Request'), {
                httpStatusCode: 400,
                responseData,
            })

            expect(
                formatDueStringParseError(error, {
                    taskContent: 'Water plants',
                    dueString: 'blursday',
                }),
            ).toBe(
                'Task "Water plants" wasn\'t created because `dueString` could not be parsed. A due string must name one specific date or recurrence, such as "tomorrow", "Friday at 3pm", "2026-12-01" or "every weekday"; a period such as "this week" is not a date. Change only `dueString` and retry.',
            )
        })

        it('does not blame dueString for an invalid date when a deadline was sent too', () => {
            const error = Object.assign(new Error('HTTP 400: Bad Request'), {
                httpStatusCode: 400,
                responseData: { error: 'Date is invalid', errorTag: 'INVALID_DATE', httpCode: 400 },
            })

            expect(
                formatDueStringParseError(error, {
                    taskContent: 'Water plants',
                    dueString: 'blursday',
                    deadlineDate: '2026-13-45',
                }),
            ).toBeUndefined()
        })

        it('preserves dueString recovery guidance in batch-item output', () => {
            const recovery =
                'Task "Lavendel abschneiden" wasn\'t created because `dueString` could not be parsed. Change only `dueString` and retry.'

            expect(formatBatchItemError(new DueStringParseError(recovery))).toBe(recovery)
        })

        it('returns a safe generic dueString retry for a non-recurring expression', () => {
            const error = Object.assign(new Error('HTTP 400: Bad Request'), {
                httpStatusCode: 400,
                responseData: { error: 'Invalid date format' },
            })

            expect(
                formatDueStringParseError(error, {
                    taskContent: 'Lavendel abschneiden',
                    dueString: 'tomorrow',
                }),
            ).toBe(
                'Task "Lavendel abschneiden" wasn\'t created because `dueString` could not be parsed. A due string must name one specific date or recurrence, such as "tomorrow", "Friday at 3pm", "2026-12-01" or "every weekday"; a period such as "this week" is not a date. Change only `dueString` and retry.',
            )
        })

        it('does not give an empty example for a bare recurring prefix', () => {
            const error = Object.assign(new Error('HTTP 400: Bad Request'), {
                httpStatusCode: 400,
                responseData: { error: 'Invalid date format' },
            })

            expect(
                formatDueStringParseError(error, {
                    taskContent: 'Lavendel abschneiden',
                    dueString: 'recurring',
                }),
            ).toBe(
                'Task "Lavendel abschneiden" wasn\'t created because `dueString` could not be parsed. Use a complete Todoist recurrence expression; `recurring` alone is not valid. Change only `dueString` and retry.',
            )
        })

        it('does not attribute a generic date error to dueString when deadlineDate is supplied', () => {
            const error = Object.assign(new Error('HTTP 400: Bad Request'), {
                httpStatusCode: 400,
                responseData: { error: 'Invalid date format' },
            })

            expect(
                formatDueStringParseError(error, {
                    taskContent: 'Task',
                    dueString: 'tomorrow',
                    deadlineDate: 'not-a-date',
                }),
            ).toBeUndefined()
        })
    })

    it('keeps Zod validation errors unchanged', () => {
        const validationResult = z.object({ taskId: z.string() }).safeParse({ taskId: 123 })

        expect(validationResult.success).toBe(false)
        if (validationResult.success) {
            throw new Error('Expected Zod validation to fail')
        }

        expect(formatToolExecutionError(validationResult.error)).toBe(
            validationResult.error.message,
        )
    })

    it('returns non-API errors as plain messages', () => {
        expect(formatToolExecutionError(new Error('Simple failure'))).toBe('Simple failure')
    })

    it('does not mislabel generic errors with data payloads as API errors', () => {
        const error = Object.assign(new Error('Unexpected tool failure'), {
            data: { foo: 'bar' },
        })

        expect(formatToolExecutionError(error)).toBe('Unexpected tool failure')
    })
})
