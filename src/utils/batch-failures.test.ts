import { logBatchFailures, partitionSettled } from './batch-failures.js'
import { LogLimits } from './constants.js'

describe('logBatchFailures', () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    })

    afterEach(() => {
        consoleErrorSpy.mockRestore()
    })

    it('reports the failures with their counts', () => {
        logBatchFailures('complete-tasks', 3, [
            { item: '6X4Vw2Hfmg73Q2XR', error: 'HTTP 404: Not Found' },
        ])

        expect(consoleErrorSpy).toHaveBeenCalledWith('complete-tasks: items failed', {
            failed: 1,
            of: 3,
            sample: [{ item: '6X4Vw2Hfmg73Q2XR', error: 'HTTP 404: Not Found' }],
        })
    })

    it('keeps the failure code when the tool reports one', () => {
        logBatchFailures('update-tasks', 1, [
            {
                item: '6X4Vw2Hfmg73Q2XR',
                error: 'Moved, but the update failed',
                code: 'PARTIAL_MOVE_APPLIED',
            },
        ])

        expect(consoleErrorSpy).toHaveBeenCalledWith(
            'update-tasks: items failed',
            expect.objectContaining({
                sample: [
                    {
                        item: '6X4Vw2Hfmg73Q2XR',
                        error: 'Moved, but the update failed',
                        code: 'PARTIAL_MOVE_APPLIED',
                    },
                ],
            }),
        )
    })

    it('logs once per batch with a capped sample', () => {
        const failures = Array.from({ length: 200 }, (_, index) => ({
            item: `task-${index}`,
            error: 'HTTP 403: Forbidden',
        }))

        logBatchFailures('add-tasks', 200, failures)

        expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
        expect(consoleErrorSpy).toHaveBeenCalledWith(
            'add-tasks: items failed',
            expect.objectContaining({
                failed: 200,
                of: 200,
                // Only a sample, so one outage can't put an unbounded array
                // into a log line.
                sample: failures.slice(0, LogLimits.MAX_FAILURES_LOGGED),
            }),
        )
    })

    it('redacts the caller text that an error quotes', () => {
        logBatchFailures('add-reminders', 1, [
            {
                item: 'Reminder 1 on task 6X4Vw2Hfmg73Q2XR',
                error: 'Could not find user(s): "ana@example.com", "Bo Smith".',
            },
        ])

        expect(consoleErrorSpy).toHaveBeenCalledWith('add-reminders: items failed', {
            failed: 1,
            of: 1,
            sample: [
                {
                    item: 'Reminder 1 on task 6X4Vw2Hfmg73Q2XR',
                    error: 'Could not find user(s): "[redacted]", "[redacted]".',
                },
            ],
        })
    })

    it('stays quiet when every item succeeds', () => {
        logBatchFailures('complete-tasks', 2, [])

        expect(consoleErrorSpy).not.toHaveBeenCalled()
    })
})

describe('partitionSettled', () => {
    it('keeps each item that worked with its value and index, and names each that failed', () => {
        const items = [{ name: 'Work' }, { name: 'Home' }, { name: 'Errands' }]
        const settled: PromiseSettledResult<string>[] = [
            { status: 'fulfilled', value: 'label-1' },
            {
                status: 'rejected',
                reason: Object.assign(new Error('Bad Gateway'), { httpStatusCode: 502 }),
            },
            { status: 'fulfilled', value: 'label-3' },
        ]

        const { succeeded, failures } = partitionSettled(items, settled, (item) => item.name)

        expect(succeeded).toEqual([
            { item: { name: 'Work' }, index: 0, value: 'label-1' },
            { item: { name: 'Errands' }, index: 2, value: 'label-3' },
        ])
        expect(failures).toEqual([{ item: 'Home', error: 'Bad Gateway (HTTP 502)' }])
    })

    it('passes the index to describe, for items named by position', () => {
        const { failures } = partitionSettled(
            ['task-a', 'task-b'],
            [
                { status: 'rejected', reason: new Error('Task not found') },
                { status: 'rejected', reason: new Error('Task not found') },
            ],
            (taskId, index) => `Reminder ${index + 1} on task ${taskId}`,
        )

        expect(failures.map((failure) => failure.item)).toEqual([
            'Reminder 1 on task task-a',
            'Reminder 2 on task task-b',
        ])
    })
})
