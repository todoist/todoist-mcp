// The one entry point every agent's hooks call, so the rules can't drift apart per agent.
//
//   node .agents/scripts/guard.ts tool-start   before a shell command: stops a push, or a new pull
//                                              request, of code `npm run verify` hasn't passed
//
// Input is the hook's JSON on stdin; Claude Code and Codex send the same shape, and both read
// `hookSpecificOutput.permissionDecision: "deny"` from a PreToolUse hook. It guards pushes from the
// checkout this file lives in, and from the other worktrees of its repository that have it. A
// broken guard never blocks work: any error allows the action and says why. DISABLE_AGENT_GUARD=1
// turns it off. See docs/agents.md.

import { readFileSync } from 'node:fs'

const event = process.argv[2]

function reply(value: Record<string, unknown>): void {
    // No process.exit(): stdout to a hook can be an asynchronous pipe, and exiting early could
    // cut off the JSON.
    process.stdout.write(JSON.stringify(value))
}

function readPayload(): Record<string, unknown> {
    // Run by hand in a terminal, there is no hook payload; reading would wait for EOF.
    if (process.stdin.isTTY) return {}
    const text = readFileSync(0, 'utf8')
    const payload: unknown = text.trim() ? JSON.parse(text) : {}
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error("hook input isn't a JSON object")
    }
    return payload as Record<string, unknown>
}

/**
 * Events of the end-of-turn gate the push check replaced. Hook configs elsewhere still send them:
 * Codex runs the main checkout's hooks in a linked worktree, and a running session keeps the
 * hooks it started with. There is nothing to do for them.
 */
const RETIRED_EVENTS = new Set(['turn-start', 'turn-end'])

async function main(): Promise<void> {
    if (event !== undefined && RETIRED_EVENTS.has(event)) return
    if (event !== 'tool-start') throw new Error(`unknown event "${event}"`)
    // Imported inside the try, so a broken library file fails open like any other error.
    const { CHECKOUT_ROOT, findRepoRoot } = await import('./lib/git.ts')
    const { checkCommand } = await import('./lib/push-check.ts')
    const { findTargets } = await import('./lib/push-targets.ts')

    const payload = readPayload()
    const command = (payload.tool_input as { command?: unknown } | undefined)?.command
    // A tool call with no shell command pushes nothing.
    if (typeof command !== 'string') return
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : process.cwd()
    // The command only mentions a push, in a message, a dry run or the like: no git to run.
    if (!findTargets(command, cwd).some(({ kind }) => kind === 'push' || kind === 'pr')) return
    const root = findRepoRoot(CHECKOUT_ROOT)
    if (root === undefined) {
        reply({
            systemMessage: 'agent-guard: no git repository found, so the push was not checked',
        })
        return
    }

    const verdict = checkCommand({ root, command, cwd })
    const notes = verdict.notes.map((note) => `agent-guard: ${note}`).join('\n')
    if (verdict.decision === 'deny') {
        reply({
            hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: verdict.reason,
            },
            ...(notes ? { systemMessage: notes } : {}),
        })
    } else if (notes) {
        reply({ systemMessage: notes })
    }
}

if (process.env.DISABLE_AGENT_GUARD !== '1') {
    try {
        await main()
    } catch (error) {
        const message = `agent-guard: ${event ?? 'unknown'} hook failed, so it allowed the action. ${(error as Error)?.message ?? error}`
        process.stderr.write(`${message}\n`)
        reply({ systemMessage: message })
    }
}
