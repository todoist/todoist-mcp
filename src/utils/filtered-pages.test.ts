import { collectFilteredPage, readFilteredPageCursor } from './filtered-pages.js'

type Item = { id: number; keep: boolean }

/** Items whose `keep` flags follow `pattern`, numbered from 0. */
function itemsFrom(pattern: boolean[]): Item[] {
    return pattern.map((keep, id) => ({ id, keep }))
}

/**
 * A fake paginated endpoint that behaves like the Todoist API: the next cursor
 * names the last item returned, and works with any page size.
 */
function fakeApi(items: Item[]) {
    return vi.fn(async ({ cursor, limit }: { cursor: string | null; limit: number }) => {
        const start =
            cursor === null ? 0 : items.findIndex((item) => String(item.id) === cursor) + 1
        const results = items.slice(start, start + limit)
        const last = results.at(-1)
        const hasMore = start + limit < items.length
        return { results, nextCursor: hasMore && last ? String(last.id) : null }
    })
}

const keep = (item: Item) => item.keep
const ids = (items: Item[]) => items.map((item) => item.id)

function collect(
    fetchPage: ReturnType<typeof fakeApi>,
    cursor: string | null | undefined,
    { limit = 3, state }: { limit?: number; state?: unknown } = {},
) {
    return collectFilteredPage({
        fetchPage,
        matches: keep,
        limit,
        maxPageSize: 200,
        from: readFilteredPageCursor(cursor ?? undefined),
        state,
    })
}

describe('collectFilteredPage', () => {
    it('keeps fetching pages until it has `limit` matches', async () => {
        const items = itemsFrom([...Array(30).fill(false), ...Array(5).fill(true)])
        const fetchPage = fakeApi(items)

        const page = await collect(fetchPage, undefined)

        expect(ids(page.items)).toEqual([30, 31, 32])
        expect(fetchPage.mock.calls.map(([args]) => args)).toEqual([
            { cursor: null, limit: 3 },
            { cursor: '2', limit: 200 },
        ])
    })

    it('resumes part-way through a page, after the last item it examined', async () => {
        const items = itemsFrom([...Array(30).fill(false), ...Array(5).fill(true)])
        const fetchPage = fakeApi(items)

        const first = await collect(fetchPage, undefined)
        const second = await collect(fetchPage, first.nextCursor)

        expect(ids(second.items)).toEqual([33, 34])
        expect(second.nextCursor).toBeNull()
    })

    it('returns every match exactly once, in order, across repeated calls', async () => {
        const items = itemsFrom(Array.from({ length: 1500 }, (_, id) => id % 7 === 3))
        const fetchPage = fakeApi(items)
        const collected: number[] = []
        let cursor: string | null = null
        let calls = 0

        do {
            const page = await collect(fetchPage, cursor, { limit: 10 })
            collected.push(...ids(page.items))
            cursor = page.nextCursor
            calls++
        } while (cursor && calls < 500)

        expect(collected).toEqual(ids(items.filter(keep)))
    })

    it('makes a single request when the first page holds enough matches', async () => {
        const fetchPage = fakeApi(itemsFrom(Array(6).fill(true)))

        const first = await collect(fetchPage, undefined)
        const second = await collect(fetchPage, first.nextCursor)

        expect(ids(first.items)).toEqual([0, 1, 2])
        expect(ids(second.items)).toEqual([3, 4, 5])
        expect(fetchPage.mock.calls.map(([args]) => args)).toEqual([
            { cursor: null, limit: 3 },
            { cursor: '2', limit: 3 },
        ])
    })

    it('stops after five requests and resumes from the next page', async () => {
        const items = itemsFrom([...Array(900).fill(false), true])
        const fetchPage = fakeApi(items)

        const first = await collect(fetchPage, undefined)
        expect(first.items).toEqual([])
        expect(fetchPage).toHaveBeenCalledTimes(5)

        fetchPage.mockClear()
        const second = await collect(fetchPage, first.nextCursor)
        // 3 + 4 × 200 items were examined, so the next call starts after item 802.
        expect(fetchPage).toHaveBeenNthCalledWith(1, { cursor: '802', limit: 3 })
        expect(ids(second.items)).toEqual([900])
    })

    it("hands back the API's own cursor when it stops at a page boundary with no state", async () => {
        const fetchPage = fakeApi(itemsFrom(Array(6).fill(true)))

        const page = await collect(fetchPage, undefined)

        expect(page.nextCursor).toBe('2')
    })

    it('saves the state it is given in the cursor it returns', async () => {
        const fetchPage = fakeApi(itemsFrom(Array(6).fill(true)))

        const page = await collect(fetchPage, undefined, { state: { apiLabel: 'work' } })

        expect(readFilteredPageCursor(page.nextCursor ?? undefined)?.state).toEqual({
            apiLabel: 'work',
        })
    })
})

describe('readFilteredPageCursor', () => {
    it('reads no cursor as the start of the list', () => {
        expect(readFilteredPageCursor(undefined)).toBeUndefined()
    })

    it('reads a cursor the API issued as the start of its page, with no saved state', () => {
        expect(readFilteredPageCursor('abc.def')).toEqual({ cursor: 'abc.def', skip: 0 })
    })

    it('rejects a resume cursor it cannot read', () => {
        expect(() => readFilteredPageCursor('resume:not-json')).toThrow('Invalid cursor')
    })
})
