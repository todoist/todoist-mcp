import { z } from 'zod'

/**
 * How many API requests one call may make. A project holds at most 300 active tasks,
 * so two requests read any project, section or parent task; the rest is headroom.
 */
const MAX_REQUESTS = 5

/** Marks a cursor this module issued. */
const RESUME_CURSOR_PREFIX = 'resume:'

export const INVALID_CURSOR_MESSAGE =
    'Invalid cursor. Pass the nextCursor from the previous call unchanged, with the same parameters.'

const FilteredPagePositionSchema = z.object({
    next: z.string(),
    state: z.unknown().optional(),
})

/** Where a filtered listing resumes. */
export type FilteredPagePosition = {
    /** The id of the first match not yet returned; the next page starts there. */
    next: string
    /** What the caller saved with the cursor, to read back on later pages. */
    state?: unknown
}

type Page<T> = { results: T[]; nextCursor: string | null }

function encodeCursor(position: FilteredPagePosition): string {
    return `${RESUME_CURSOR_PREFIX}${Buffer.from(JSON.stringify(position)).toString('base64url')}`
}

/**
 * Reads a cursor that {@link collectFilteredPage} returned. Undefined for no cursor.
 */
export function readFilteredPageCursor(
    cursor: string | undefined,
): FilteredPagePosition | undefined {
    if (!cursor) return undefined
    if (!cursor.startsWith(RESUME_CURSOR_PREFIX)) throw new Error(INVALID_CURSOR_MESSAGE)

    try {
        const encoded = cursor.slice(RESUME_CURSOR_PREFIX.length)
        return FilteredPagePositionSchema.parse(
            JSON.parse(Buffer.from(encoded, 'base64url').toString()),
        )
    } catch {
        throw new Error(INVALID_CURSOR_MESSAGE)
    }
}

/**
 * One page of the items that pass `matches`, for short lists the API cannot filter
 * itself, such as the tasks of one project.
 *
 * Every call reads the list from the start, a page of `maxPageSize` at a time, and
 * stops once it has `limit` matches and knows whether another one follows. The cursor
 * names that next match, so the following call resumes exactly there. The API's own
 * cursors name the last item returned, and find nothing once that item is completed,
 * moved or deleted; anchoring on a match the caller has not seen yet means acting on
 * the returned items between calls neither skips matches nor ends the list early.
 *
 * `state` is saved in the cursor for the caller to read back with
 * {@link readFilteredPageCursor}, so later pages can reuse what the first one worked out.
 */
export async function collectFilteredPage<T extends { id: string }>({
    fetchPage,
    matches,
    limit,
    maxPageSize,
    from,
    state,
}: {
    fetchPage: (args: { cursor: string | null; limit: number }) => Promise<Page<T>>
    matches: (item: T) => boolean
    limit: number
    /** The largest page the API returns. */
    maxPageSize: number
    from: FilteredPagePosition | undefined
    state?: unknown
}): Promise<{ items: T[]; nextCursor: string | null }> {
    const items: T[] = []
    let resumeAt = from?.next
    let pageCursor: string | null = null

    for (let request = 0; request < MAX_REQUESTS; request++) {
        const { results, nextCursor } = await fetchPage({ cursor: pageCursor, limit: maxPageSize })

        for (const item of results) {
            if (resumeAt !== undefined) {
                if (item.id !== resumeAt) continue
                resumeAt = undefined
            }
            if (!matches(item)) continue
            if (items.length === limit) {
                return { items, nextCursor: encodeCursor({ next: item.id, state }) }
            }
            items.push(item)
        }

        if (!nextCursor) {
            if (resumeAt !== undefined) {
                throw new Error(
                    'The item this cursor resumes at is no longer in the list, for example because it or its parent was completed, moved or deleted. Search again without a cursor.',
                )
            }
            return { items, nextCursor: null }
        }
        pageCursor = nextCursor
    }

    throw new Error(
        `Stopped after reading ${MAX_REQUESTS * maxPageSize} items without reaching the end of the list.`,
    )
}
