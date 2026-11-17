import { parseTodoistUrl } from '@todoist/sdk'

/**
 * Pattern source matching `text` in any letter case. JSON Schema patterns carry
 * no flags, so an `i` flag would be dropped from the advertised pattern while
 * the server kept applying it.
 */
function anyCase(text: string): string {
    return text
        .replace(/[a-z]/gi, (letter) => `[${letter.toUpperCase()}${letter.toLowerCase()}]`)
        .replace(/\./g, '\\.')
}

/**
 * The forms `extractTemplateId` reads: a bare gallery slug or template ID, or
 * an https URL on todoist.com or one of its subdomains, in any letter case.
 * Stated in the schema so a client can see that the parameter cannot name any
 * other host. Every `-` in a character class is escaped so the pattern also
 * compiles with the `v` flag that HTML's `pattern` attribute uses.
 */
const TEMPLATE_ID_PATTERN = new RegExp(
    String.raw`^\s*(?:[A-Za-z0-9_\-]+|${anyCase('https')}:\/\/(?:[A-Za-z0-9\-]+\.)*${anyCase('todoist.com')}(?:\/\S*)?)\s*$`,
)

/** What a rejected template ID is told, instead of the pattern. */
const TEMPLATE_ID_ERROR =
    'Pass a template slug ("product-launch"), a template ID ("UT_..."), or an https URL on todoist.com or one of its subdomains.'

/**
 * Accepts a bare template ID or a Todoist template URL. Both gallery links
 * (`/templates/product-launch`) and in-app links
 * (`/app/templates/category/my-templates/UT_28Ex.../view`) reduce to the last
 * path segment once a trailing `/view` is dropped. Non-Todoist hosts are
 * rejected rather than reduced, so a look-alike link cannot quietly resolve to
 * a real gallery slug.
 */
function extractTemplateId(input: string): string {
    const trimmed = input.trim()

    if (!/^https?:\/\//i.test(trimmed)) {
        return trimmed
    }

    let url: URL
    try {
        url = new URL(trimmed)
    } catch {
        throw new Error(`Could not read a template ID from "${trimmed}".`)
    }

    if (!isTodoistHost(url.hostname)) {
        throw new Error(
            `"${url.hostname}" is not a Todoist domain. Pass a todoist.com template URL or the template ID itself.`,
        )
    }

    // The SDK recognises a fixed set of Todoist hosts, which is narrower than
    // the subdomains accepted above, so point the URL at the canonical host
    // before reading the template ID out of the path.
    url.hostname = 'todoist.com'

    const parsed = parseTodoistUrl(url.toString())
    if (parsed?.type !== 'template') {
        throw new Error(`"${trimmed}" is not a Todoist template URL.`)
    }

    return parsed.id
}

function isTodoistHost(hostname: string): boolean {
    const host = hostname.toLowerCase()
    return host === 'todoist.com' || host.endsWith('.todoist.com')
}

export { extractTemplateId, TEMPLATE_ID_ERROR, TEMPLATE_ID_PATTERN }
