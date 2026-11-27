/**
 * Format a Date using UTC calendar components (YYYY-MM-DD).
 */
export function formatUtcDate(date: Date): string {
    const year = date.getUTCFullYear()
    const month = String(date.getUTCMonth() + 1).padStart(2, '0')
    const day = String(date.getUTCDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
}

/**
 * Parse a GMT offset string (+HH:MM or -HH:MM) to total minutes.
 * Falls back to 0 for malformed offsets.
 */
export function parseGmtOffsetToMinutes(gmtOffset: string): number {
    const match = /^([+-])(\d{2}):(\d{2})$/.exec(gmtOffset)
    if (!match) {
        return 0
    }

    const [, sign, hours, minutes] = match
    const totalMinutes = Number(hours) * 60 + Number(minutes)
    return sign === '-' ? -totalMinutes : totalMinutes
}

/**
 * Return the date string (YYYY-MM-DD) in a provided GMT offset.
 */
export function getDateInOffset(date: Date, offsetMinutes: number): string {
    const shiftedDate = new Date(date.getTime() + offsetMinutes * 60 * 1000)
    return formatUtcDate(shiftedDate)
}

/**
 * Shift a YYYY-MM-DD date string by the specified number of days in UTC.
 */
export function shiftDateStringByDays(dateString: string, days: number): string {
    const [yearPart, monthPart, dayPart] = dateString.split('-')
    const year = Number(yearPart)
    const month = Number(monthPart)
    const day = Number(dayPart)

    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
        throw new Error(`Invalid date format: ${dateString}. Expected YYYY-MM-DD.`)
    }

    const date = new Date(Date.UTC(year, month - 1, day))
    date.setUTCDate(date.getUTCDate() + days)
    return formatUtcDate(date)
}

/**
 * The days a search of `daysCount` days from `startDate` covers, as "YYYY-MM-DD" or
 * "YYYY-MM-DD to YYYY-MM-DD". The search stops before the day after the range, so
 * the last day named is `daysCount - 1` days after the start.
 */
export function describeDateRange(startDate: string, daysCount: number): string {
    return daysCount > 1
        ? `${startDate} to ${shiftDateStringByDays(startDate, daysCount - 1)}`
        : startDate
}

/**
 * The days a search of `daysCount` days from today covers: "Today", "Today and
 * Tomorrow", or "Today and the next N days".
 */
export function describeDaysFromToday(daysCount: number): string {
    if (daysCount <= 1) return 'Today'
    if (daysCount === 2) return 'Today and Tomorrow'
    return `Today and the next ${daysCount - 1} days`
}

/**
 * Format a number of minutes east of UTC as a GMT offset string (+HH:MM or -HH:MM).
 */
function formatGmtOffset(offsetMinutes: number): string {
    const sign = offsetMinutes < 0 ? '-' : '+'
    const total = Math.abs(offsetMinutes)
    const hours = String(Math.floor(total / 60)).padStart(2, '0')
    const minutes = String(total % 60).padStart(2, '0')
    return `${sign}${hours}:${minutes}`
}

/**
 * Minutes east of UTC that `timeZone` observes at `instant`, or undefined when the
 * runtime does not know the zone.
 */
export function getZoneOffsetMinutes(instant: number, timeZone: string): number | undefined {
    try {
        const zoneName = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
            .formatToParts(instant)
            .find((part) => part.type === 'timeZoneName')?.value
        if (zoneName === undefined) return undefined
        // "GMT" alone means UTC; otherwise "GMT+05:30" or "GMT-06:00"
        return zoneName === 'GMT' ? 0 : parseGmtOffsetToMinutes(zoneName.slice(3))
    } catch {
        return undefined
    }
}

const MINUTE_MS = 60_000

/**
 * The first moment of a YYYY-MM-DD date in `timeZone`, as `YYYY-MM-DDT00:00:00` with the
 * offset that names it. A fixed offset such as the user's current `gmtString` is wrong
 * for dates on the other side of a daylight-saving change, so ranges in the past or
 * future use this. Falls back to `fallbackOffset` when the zone is missing or unknown.
 *
 * Some zones change their clocks at midnight. When the clocks skip midnight, the day
 * starts at the jump, which is midnight at the offset before it. When midnight happens
 * twice, the day starts at the first one.
 */
export function getStartOfDay({
    date,
    timeZone,
    fallbackOffset,
}: {
    date: string
    timeZone: string | null | undefined
    fallbackOffset: string
}): string {
    const withOffset = (offset: string) => `${date}T00:00:00${offset}`
    const midnightAsUtc = Date.parse(`${date}T00:00:00Z`)
    if (!timeZone || Number.isNaN(midnightAsUtc)) return withOffset(fallbackOffset)

    // Offsets run from -12:00 to +14:00, so the offsets in force 14 hours either side of
    // midnight-as-UTC are the only ones this day's midnight can have.
    const offsetAt = (instant: number) => getZoneOffsetMinutes(instant, timeZone)
    const before = offsetAt(midnightAsUtc - 14 * 60 * MINUTE_MS)
    const after = offsetAt(midnightAsUtc + 14 * 60 * MINUTE_MS)
    if (before === undefined || after === undefined) return withOffset(fallbackOffset)

    // The offsets at which midnight really happens: one, two when it happens twice, or
    // none when the clocks skip it going forward.
    const midnights = [...new Set([before, after])].filter(
        (offset) => offsetAt(midnightAsUtc - offset * MINUTE_MS) === offset,
    )
    const offset = midnights.length > 0 ? Math.max(...midnights) : before
    return withOffset(formatGmtOffset(offset))
}
