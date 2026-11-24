import type { z } from 'zod'
import type { ArgsSchema } from '../../tools/find-tasks-by-date.js'
import type { Priority } from '../../utils/priorities.js'

export type Task = {
    id: string
    content: string
    priority: Priority
}

export type FindTasksByDateArgs = z.input<z.ZodObject<typeof ArgsSchema>>
