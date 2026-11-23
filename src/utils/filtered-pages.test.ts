import { collectFilteredPage } from './filtered-pages.js'

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

describe('collectFilteredPage', () => {
    it('keeps fetching pages until it has `limit` matches', async () => {
        const items = itemsFrom([...Array(30).fill(false), ...Array(5).fill(true)])
        const fetchPage = fakeApi(items)

        const page = await collectFilteredPage({
            fetchPage,
            matches: keep,
            limit: 3,
            cursor: undefined,
        })

        expect(ids(page.items)).toEqual([30, 31, 32])
        expect(fetchPage.mock.calls.map(([args]) => args)).toEqual([
            { cursor: null, limit: 3 },
            { cursor: '2', limit: 200 },
        ])
        expect(page.nextCursor).toEqual(expect.any(String))
    })

    it('resumes part-way through a page, after the last item it examined', async () => {
        const items = itemsFrom([...Array(30).fill(false), ...Array(5).fill(true)])
        const fetchPage = fakeApi(items)

        const first = await collectFilteredPage({
            fetchPage,
            matches: keep,
            limit: 3,
            cursor: undefined,
        })
        const second = await collectFilteredPage({
            fetchPage,
            matches: keep,
            limit: 3,
            cursor: first.nextCursor ?? undefined,
        })

        expect(ids(second.items)).toEqual([33, 34])
        expect(second.nextCursor).toBeNull()
    })

    it('returns every match exactly once, in order, across repeated calls', async () => {
        const items = itemsFrom(Array.from({ length: 1500 }, (_, id) => id % 7 === 3))
        const fetchPage = fakeApi(items)
        const collected: number[] = []
        let cursor: string | undefined
        let calls = 0

        do {
            const page = await collectFilteredPage({ fetchPage, matches: keep, limit: 10, cursor })
            collected.push(...ids(page.items))
            cursor = page.nextCursor ?? undefined
            calls++
        } while (cursor && calls < 500)

        expect(collected).toEqual(ids(items.filter(keep)))
    })

    it("hands back the API's own cursor when the matches end exactly at a page boundary", async () => {
        const fetchPage = fakeApi(itemsFrom(Array(6).fill(true)))

        const page = await collectFilteredPage({
            fetchPage,
            matches: keep,
            limit: 3,
            cursor: undefined,
        })

        expect(ids(page.items)).toEqual([0, 1, 2])
        expect(page.nextCursor).toBe('2')
        expect(fetchPage).toHaveBeenCalledTimes(1)
    })

    it('stops after five requests and resumes from the next page', async () => {
        const items = itemsFrom([...Array(900).fill(false), true])
        const fetchPage = fakeApi(items)

        const page = await collectFilteredPage({
            fetchPage,
            matches: keep,
            limit: 3,
            cursor: undefined,
        })

        expect(page.items).toEqual([])
        expect(fetchPage).toHaveBeenCalledTimes(5)
        // 3 + 4 × 200 items examined, so the next call starts after item 802.
        expect(page.nextCursor).toBe('802')
    })

    it('accepts a cursor the API issued', async () => {
        const fetchPage = fakeApi(itemsFrom(Array(6).fill(true)))

        const page = await collectFilteredPage({ fetchPage, matches: keep, limit: 3, cursor: '2' })

        expect(ids(page.items)).toEqual([3, 4, 5])
        expect(fetchPage).toHaveBeenCalledWith({ cursor: '2', limit: 3 })
    })

    it('rejects a resume cursor it cannot read', async () => {
        const fetchPage = fakeApi(itemsFrom([true]))

        await expect(
            collectFilteredPage({ fetchPage, matches: keep, limit: 3, cursor: 'resume:not-json' }),
        ).rejects.toThrow('Invalid cursor')
        expect(fetchPage).not.toHaveBeenCalled()
    })
})
