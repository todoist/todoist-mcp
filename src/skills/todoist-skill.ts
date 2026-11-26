/**
 * A skill served over MCP (the `io.modelcontextprotocol/skills` extension): instructions a client
 * loads into the model's context only when a task calls for them, so a workflow can be spelled out
 * in full without adding to every request.
 */
type TodoistSkill = {
    /** The skill's folder name. Must equal the `name` in its `SKILL.md` frontmatter. */
    name: string
    /**
     * The skill's files, keyed by their path inside the skill's folder. `SKILL.md` starts with
     * YAML frontmatter carrying `name` and `description`: the description is all a model sees
     * until it loads the skill, so it says what the skill does and when to reach for it.
     */
    files: { 'SKILL.md': string } & Record<string, string>
}

export type { TodoistSkill }
