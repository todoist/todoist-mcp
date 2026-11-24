import type { z } from 'zod'
import type { ArgsSchema } from '../../tools/find-tasks-by-date.js'
import { describeDateRange } from '../../utils/date.js'

type TitleArgs = Pick<
    z.input<z.ZodObject<typeof ArgsSchema>>,
    'startDate' | 'daysCount' | 'overdueOption'
>

/**
 * The heading for the task list, describing what the search that produced it covered.
 */
function getTaskListTitle(args: TitleArgs | null): string {
    if (args?.overdueOption === 'overdue-only') {
        return 'Overdue tasks'
    }

    const daysCount = args?.daysCount ?? 1

    if (!args?.startDate || args.startDate === 'today') {
        if (daysCount === 2) {
            return 'Tasks for Today and Tomorrow'
        }
        return daysCount > 2
            ? `Tasks for Today and the next ${daysCount - 1} days`
            : 'Tasks for Today'
    }

    return `Tasks for ${describeDateRange(args.startDate, daysCount)}`
}

export { getTaskListTitle }
