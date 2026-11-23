import { z } from 'zod'

/** How many API requests one call may make before handing back a cursor. */
const MAX_REQUESTS = 5

/**
 * Marks a cursor this module issued. The API's own cursors never contain a colon,
 * so anything without this prefix is read as one of them.
 */
const RESUME_CURSOR_PREFIX = 'resume:'

const FilteredPagePositionSchema = z.object({
    cursor: z.string().nullable(),
    skip: z.number().int().min(0),
    state: z.unknown().optional(),
})

/** Where a filtered listing resumes. */
export type FilteredPagePosition = {
    /** The API cursor the page started from; null for the first page. */
    cursor: string | null
    /** How many items of that page were already examined. */
    skip: number
    /**
     * What the caller saved with the cursor, such as a filter it must keep using for
     * the counts to stay right. Undefined for a cursor the API issued.
     */
    state?: unknown
}

type Page<T> = { results: T[]; nextCursor: string | null }

function encodeCursor(position: FilteredPagePosition): string {
    return `${RESUME_CURSOR_PREFIX}${Buffer.from(JSON.stringify(position)).toString('base64url')}`
}

/**
 * Reads a cursor that {@link collectFilteredPage} returned. A cursor the API issued
 * is read as the start of its page, with no saved state. Undefined for no cursor.
 */
export function readFilteredPageCursor(
    cursor: string | undefined,
): FilteredPagePosition | undefined {
    if (!cursor) return undefined
    if (!cursor.startsWith(RESUME_CURSOR_PREFIX)) return { cursor, skip: 0 }

    try {
        const encoded = cursor.slice(RESUME_CURSOR_PREFIX.length)
        return FilteredPagePositionSchema.parse(
            JSON.parse(Buffer.from(encoded, 'base64url').toString()),
        )
    } catch {
        throw new Error(
            'Invalid cursor. Pass the nextCursor from the previous call unchanged, with the same parameters.',
        )
    }
}

/**
 * One page of the items that pass `matches`, for lists the API cannot filter itself.
 *
 * Filtering a single API page would return fewer than `limit` items, often none, when
 * the matches sit further down the list. This keeps fetching pages until it has
 * `limit` matches or the list ends, making at most a few requests per call. The
 * returned cursor resumes right after the last item examined, even part-way through
 * an API page, so repeated calls return every match exactly once.
 *
 * The cursor counts items of the pages `fetchPage` returned, so every call must fetch
 * the same list. `state` is saved in the cursor for the caller to read back with
 * {@link readFilteredPageCursor}: put anything that decides what `fetchPage` returns
 * there, rather than working it out again on each call.
 *
 * The first request asks only for what one page of results needs, so a list where
 * most items match costs a single request, and with no state to save it returns
 * the API's own cursor.
 */
export async function collectFilteredPage<T>({
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
    let pageCursor = from?.cursor ?? null
    let skip = from?.skip ?? 0
    const items: T[] = []
    // A cursor the API issued already resumes at the start of its page, so it is
    // only wrapped when there is more to say: a position part-way through, or state.
    const resumeAt = (cursor: string | null, examined: number) =>
        examined === 0 && state === undefined && cursor !== null
            ? cursor
            : encodeCursor({ cursor, skip: examined, state })

    for (let request = 0; request < MAX_REQUESTS; request++) {
        const pageSize = request === 0 ? Math.min(maxPageSize, skip + limit) : maxPageSize
        const { results, nextCursor } = await fetchPage({ cursor: pageCursor, limit: pageSize })

        for (let index = skip; index < results.length; index++) {
            const item = results[index] as T
            if (!matches(item)) continue

            items.push(item)
            if (items.length === limit) {
                const examined = index + 1
                if (examined < results.length) {
                    return { items, nextCursor: resumeAt(pageCursor, examined) }
                }
                return { items, nextCursor: nextCursor ? resumeAt(nextCursor, 0) : null }
            }
        }

        if (!nextCursor) return { items, nextCursor: null }
        pageCursor = nextCursor
        skip = 0
    }

    return { items, nextCursor: resumeAt(pageCursor, 0) }
}
