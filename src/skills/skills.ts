import type { McpServer } from '@modelcontextprotocol/server'
import {
    type Skill,
    type SkillSource,
    SkillsExtension,
    skillEntry,
} from '@modelcontextprotocol/server/ext/skills'
import { CATALOGUE_CACHE_HINT } from '../utils/constants.js'
import { filterQueries } from './filter-queries.js'
import { planMyDay } from './plan-my-day.js'
import { productivityReview } from './productivity-review.js'
import { templates } from './templates.js'
import type { TodoistSkill } from './todoist-skill.js'

/** Every skill the server serves. */
const registeredSkills: readonly TodoistSkill[] = [
    planMyDay,
    productivityReview,
    templates,
    filterQueries,
]

const SKILL_BASE_URI = 'skill://'

/** Text of every skill file, by the URI the skill's listing gives it. */
const skillFiles = new Map<string, string>(
    registeredSkills.flatMap((skill) =>
        Object.entries(skill.files).map(
            ([path, text]) => [`${SKILL_BASE_URI}${skill.name}/${path}`, text] as const,
        ),
    ),
)

let skillEntries: Promise<Skill[]> | undefined

/**
 * The listing entry of every skill: its frontmatter and the digest and size of each file, which a
 * client checks every file it reads against. Hashing is async, so the entries are built on first
 * use and then kept: the skills are fixed for the life of the process.
 */
function loadSkillEntries(): Promise<Skill[]> {
    skillEntries ??= Promise.all(
        registeredSkills.map((skill) =>
            skillEntry(skill.name, skill.files, { baseUri: SKILL_BASE_URI }),
        ),
    )
    return skillEntries
}

const source: SkillSource = {
    async list() {
        return { skills: await loadSkillEntries() }
    },
    async get(uri) {
        return (await loadSkillEntries()).find((skill) => skill.uri === uri)
    },
    async read(uri) {
        const text = skillFiles.get(uri)
        return text === undefined ? undefined : { text, mimeType: 'text/markdown' }
    },
}

/**
 * One extension serves every server `getMcpServer` builds, including the one the HTTP transport
 * builds per request. The skills change only with a deploy, like the rest of the catalogue, so
 * they share its cache hint.
 */
const skillsExtension = new SkillsExtension({
    source,
    baseUri: SKILL_BASE_URI,
    cacheHint: CATALOGUE_CACHE_HINT,
})

/**
 * Serve the skills on `server`: the `skills/list` and `skills/get` methods, a `skill://` resource
 * template for the files, and the extension in the server's capabilities. Clients that do not
 * declare the extension never ask for them. Must run before the server connects.
 */
function registerSkills(server: McpServer): void {
    skillsExtension.attach(server)
}

export { registerSkills, registeredSkills }
