// Pi's wiring for the push check: the same `.agents/scripts/guard.ts` the Claude Code and Codex
// hooks call, so the rules can't drift apart per agent. Pi has no hook files; it has extension
// events, and `tool_call` fires before each tool runs and can block it. Before a `bash` call that
// could push, this asks the guard, and blocks the call with the guard's reason when it says no.
//
// Pi loads project extensions only once you trust the project, and only from the folder it starts
// in. The rest works as it does for the other agents: DISABLE_AGENT_GUARD=1 turns it off, a
// checkout without the guard (an older branch) is skipped without a word, and a guard that fails
// to run allows the call. See docs/agents.md.
//
// Its tests are in .agents/scripts/pi-extension.test.ts: Pi would load a test file in this folder
// as another extension.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** What the guard prints: the same JSON the Claude Code and Codex hooks read. */
type GuardOutput = {
    hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string }
    systemMessage?: string
}

/** What the handler reads of Pi's `tool_call` context. */
type ToolContext = {
    cwd: string
    hasUI: boolean
    ui: { notify(message: string, type?: 'info' | 'warning' | 'error'): void }
}

type ToolCallResult = { block: true; reason?: string } | undefined

type ToolCallHandler = (
    event: { toolName: string; input: unknown },
    ctx: ToolContext,
) => Promise<ToolCallResult>

/** What this uses of Pi's extension API, declared here since Pi isn't a dependency. */
type ExtensionAPI = { on(event: 'tool_call', handler: ToolCallHandler): void }

/** The same quick test as the hook commands: a command without these words can't push. */
const MIGHT_PUSH = /push|pr\s.*(create|new)/s

/** The checkout this file lives in, two folders up, whichever folder Pi runs in. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const GUARD = join(ROOT, '.agents/scripts/guard.ts')

/** As long as the Claude Code and Codex hooks wait for the guard. */
const TIMEOUT_MS = 30_000

/**
 * Runs the guard the way the other agents' hooks do: a separate process with JSON on stdin that
 * prints JSON on stdout. Any failure resolves to a note rather than a decision, so the call runs.
 */
function runGuard(payload: Record<string, unknown>): Promise<GuardOutput> {
    return new Promise((done) => {
        const child = spawn('node', [GUARD, 'tool-start'], { cwd: ROOT, env: process.env })
        let stdout = ''
        let stderr = ''
        let finished = false
        function finish(output: GuardOutput): void {
            if (finished) return
            finished = true
            clearTimeout(timer)
            done(output)
        }
        const timer = setTimeout(() => {
            child.kill()
            finish({
                systemMessage:
                    `agent-guard: tool-start timed out, so it allowed the action. ${stderr.trim()}`.trim(),
            })
        }, TIMEOUT_MS)
        child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
        child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
        child.on('error', (error) => {
            finish({ systemMessage: `agent-guard: tool-start failed to run: ${error.message}` })
        })
        child.on('close', (code, signal) => {
            // The guard prints its own failures as JSON and exits 0, so any other exit means it
            // never ran, as when a syntax error stops Node: it says why on stderr only.
            if (code !== 0) {
                const how = signal ? `was stopped by ${signal}` : `exited with code ${code}`
                finish({
                    systemMessage:
                        `agent-guard: tool-start ${how}, so it allowed the action. ${stderr.trim()}`.trim(),
                })
                return
            }
            try {
                finish(stdout.trim() ? (JSON.parse(stdout) as GuardOutput) : {})
            } catch {
                finish({
                    systemMessage: `agent-guard: tool-start printed no JSON, so it allowed the action. ${stderr.trim()}`,
                })
            }
        })
        // A guard that exits before reading its input closes the pipe; `close` still reports how
        // it ended, so a write error must not crash Pi.
        child.stdin.on('error', () => {})
        child.stdin.end(JSON.stringify(payload))
    })
}

/**
 * Shows a note in Pi's UI, or on stderr in print and JSON modes, which have none. A note the UI
 * can't show goes to stderr too: it costs only the note, never the decision.
 */
function tell(ctx: ToolContext, message: string): void {
    try {
        if (ctx.hasUI) {
            ctx.ui.notify(message, 'warning')
            return
        }
    } catch {
        // Falls back to stderr below.
    }
    process.stderr.write(`${message}\n`)
}

async function checkToolCall(
    event: { toolName: string; input: unknown },
    ctx: ToolContext,
): Promise<ToolCallResult> {
    if (event.toolName !== 'bash') return undefined
    const command = (event.input as { command?: unknown } | null | undefined)?.command
    if (typeof command !== 'string' || !MIGHT_PUSH.test(command)) return undefined
    // Not started at all when turned off, or on an older branch without the guard.
    if (process.env.DISABLE_AGENT_GUARD === '1' || !existsSync(GUARD)) return undefined

    const output = await runGuard({ tool_name: 'Bash', tool_input: { command }, cwd: ctx.cwd })
    const decision = output.hookSpecificOutput
    const result: ToolCallResult =
        decision?.permissionDecision === 'deny'
            ? { block: true, reason: decision.permissionDecisionReason }
            : undefined
    if (output.systemMessage) tell(ctx, output.systemMessage)
    return result
}

// Pi loads an extension through its default export.
export default function agentGuard(pi: ExtensionAPI): void {
    pi.on('tool_call', async (event, ctx) => {
        // Pi blocks the tool call when a handler throws; a broken extension must allow it instead.
        try {
            return await checkToolCall(event, ctx)
        } catch (error) {
            const message = `agent-guard: the Pi extension failed, so it allowed the action. ${(error as Error)?.message ?? error}`
            tell(ctx, message)
            return undefined
        }
    })
}
