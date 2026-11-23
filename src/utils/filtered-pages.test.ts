import { collectFilteredPage, readFilteredPageCursor } from './filtered-pages.js'
import { paginateLikeApi } from './test-helpers.js'

type Item = { id: string; keep: boolean }

/** Items whose `keep` flags follow `pattern`, with ids numbered from 0. */
function itemsFrom(pattern: boolean[]): Item[] {
    return pattern.map((keep, index) => ({ id: String(index), keep }))
}

function fakeApi(items: Item[]) {
    return vi.fn(paginateLikeApi(items))
}

/** Removes `removed` from `items` in place, as completing those tasks would. */
function remove(items: Item[], removed: Item[]) {
    for (const item of removed) items.splice(items.indexOf(item), 1)
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
        const items = itemsFrom([...Array(250).fill(false), ...Array(5).fill(true)])
        const fetchPage = fakeApi(items)

        const page = await collect(fetchPage, undefined)

        expect(ids(page.items)).toEqual(['250', '251', '252'])
        expect(fetchPage.mock.calls.map(([args]) => args)).toEqual([
            { cursor: null, limit: 200 },
            { cursor: '199', limit: 200 },
        ])
    })

    it('resumes at the first match it has not returned', async () => {
        const items = itemsFrom([false, true, true, false, true, false, true, true])
        const fetchPage = fakeApi(items)

        const first = await collect(fetchPage, undefined)
        const second = await collect(fetchPage, first.nextCursor)

        expect(ids(first.items)).toEqual(['1', '2', '4'])
        expect(ids(second.items)).toEqual(['6', '7'])
        expect(second.nextCursor).toBeNull()
    })

    it('returns every match exactly once, in order, across repeated calls', async () => {
        const items = itemsFrom(Array.from({ length: 300 }, (_, index) => index % 7 === 3))
        const fetchPage = fakeApi(items)
        const collected: string[] = []
        let cursor: string | null = null
        let calls = 0

        do {
            const page = await collect(fetchPage, cursor, { limit: 10 })
            collected.push(...ids(page.items))
            cursor = page.nextCursor
            calls++
        } while (cursor && calls < 100)

        expect(collected).toEqual(ids(items.filter(keep)))
    })

    it('returns every match when the caller removes the matches it was given before asking for more', async () => {
        const items = itemsFrom(Array.from({ length: 300 }, (_, index) => index % 7 !== 3))
        const expected = ids(items.filter(keep))
        const fetchPage = fakeApi(items)
        const collected: string[] = []
        let cursor: string | null = null
        let calls = 0

        do {
            const page = await collect(fetchPage, cursor, { limit: 10 })
            collected.push(...ids(page.items))
            remove(items, page.items)
            cursor = page.nextCursor
            calls++
        } while (cursor && calls < 100)

        expect(collected).toEqual(expected)
    })

    it('hands back no cursor when no match is left after the page', async () => {
        const fetchPage = fakeApi(itemsFrom([true, true, true, false, false]))

        const page = await collect(fetchPage, undefined)

        expect(ids(page.items)).toEqual(['0', '1', '2'])
        expect(page.nextCursor).toBeNull()
    })

    it('reads the list from the start when resuming', async () => {
        const items = itemsFrom([...Array(250).fill(true)])
        const fetchPage = fakeApi(items)

        const first = await collect(fetchPage, undefined)
        fetchPage.mockClear()
        const second = await collect(fetchPage, first.nextCursor)

        expect(ids(second.items)).toEqual(['3', '4', '5'])
        expect(fetchPage.mock.calls.map(([args]) => args)).toEqual([{ cursor: null, limit: 200 }])
    })

    it('refuses to resume when the match its cursor names is gone', async () => {
        const items = itemsFrom([true, true, true, true, true])
        const fetchPage = fakeApi(items)

        const first = await collect(fetchPage, undefined)
        remove(
            items,
            items.filter((item) => item.id === '3'),
        )

        await expect(collect(fetchPage, first.nextCursor)).rejects.toThrow('no longer in the list')
    })

    it('stops with an error rather than reading more than five pages', async () => {
        const fetchPage = fakeApi(itemsFrom(Array(1100).fill(false)))

        await expect(collect(fetchPage, undefined)).rejects.toThrow(
            'Stopped after reading 1000 items',
        )
        expect(fetchPage).toHaveBeenCalledTimes(5)
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

    it('rejects a cursor it did not issue', () => {
        expect(() => readFilteredPageCursor('abc.def')).toThrow('Invalid cursor')
    })

    it('rejects a resume cursor it cannot read', () => {
        expect(() => readFilteredPageCursor('resume:not-json')).toThrow('Invalid cursor')
    })
})
