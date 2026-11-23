import { z } from 'zod'

/** The largest page the Todoist API returns. */
const MAX_PAGE_SIZE = 200

/** How many API requests one call may make before handing back a cursor. */
const MAX_REQUESTS = 5

/**
 * Marks a cursor this module issued. The API's own cursors never contain a colon,
 * so anything without this prefix is passed to the API as it is.
 */
const RESUME_CURSOR_PREFIX = 'resume:'

const ResumePointSchema = z.object({
    /** The API cursor the page started from; null for the first page. */
    cursor: z.string().nullable(),
    /** How many items of that page were already examined. */
    skip: z.number().int().min(1),
})

type ResumePoint = { cursor: string | null; skip: number }

type Page<T> = { results: T[]; nextCursor: string | null }

function encodeResumeCursor(point: ResumePoint): string {
    return `${RESUME_CURSOR_PREFIX}${Buffer.from(JSON.stringify(point)).toString('base64url')}`
}

function decodeCursor(cursor: string | undefined): ResumePoint {
    if (!cursor) return { cursor: null, skip: 0 }
    if (!cursor.startsWith(RESUME_CURSOR_PREFIX)) return { cursor, skip: 0 }

    try {
        const encoded = cursor.slice(RESUME_CURSOR_PREFIX.length)
        return ResumePointSchema.parse(JSON.parse(Buffer.from(encoded, 'base64url').toString()))
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
 * The first request asks only for what one page of results needs, so a list where
 * most items match costs the same single request as before.
 */
export async function collectFilteredPage<T>({
    fetchPage,
    matches,
    limit,
    cursor,
}: {
    fetchPage: (args: { cursor: string | null; limit: number }) => Promise<Page<T>>
    matches: (item: T) => boolean
    limit: number
    cursor: string | undefined
}): Promise<{ items: T[]; nextCursor: string | null }> {
    let { cursor: pageCursor, skip } = decodeCursor(cursor)
    const items: T[] = []

    for (let request = 0; request < MAX_REQUESTS; request++) {
        const pageSize = request === 0 ? Math.min(MAX_PAGE_SIZE, skip + limit) : MAX_PAGE_SIZE
        const { results, nextCursor } = await fetchPage({ cursor: pageCursor, limit: pageSize })

        for (let index = skip; index < results.length; index++) {
            const item = results[index] as T
            if (!matches(item)) continue

            items.push(item)
            if (items.length === limit) {
                const examined = index + 1
                return {
                    items,
                    nextCursor:
                        examined < results.length
                            ? encodeResumeCursor({ cursor: pageCursor, skip: examined })
                            : nextCursor,
                }
            }
        }

        if (!nextCursor) return { items, nextCursor: null }
        pageCursor = nextCursor
        skip = 0
    }

    return { items, nextCursor: pageCursor }
}
