import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createTempRepo, markVerified, REPO_ROOT, type TempRepo } from './lib/test-repo.ts'

// Drives a copy of .pi/extensions/agent-guard.ts the way Pi does, in its own node process:
// register the handlers, then call `tool_call` with one event, and print what the handler
// returned and the notes it showed. The extension guards the checkout it lives in, so it runs from
// a throwaway repo holding a copy of it and of .agents/scripts. Node loads it with type stripping,
// which also holds it to the erasable syntax the rest of the tooling uses.
const DRIVER = `
    const { readFileSync } = await import('node:fs')
    const [extension, cwd, eventFile] = process.argv.slice(1)
    const event = JSON.parse(readFileSync(eventFile, 'utf8'))
    const { default: agentGuard } = await import(extension)
    const handlers = {}
    const notes = []
    agentGuard({ on: (name, handler) => (handlers[name] = handler) })
    const hasUI = !process.env.HEADLESS
    function notify(message) {
        if (process.env.BROKEN_UI) throw new Error('the UI is gone')
        notes.push(message)
    }
    const ctx = {
        get cwd() {
            if (process.env.BROKEN_CONTEXT) throw new Error('the context is gone')
            return cwd
        },
        hasUI,
        ui: { notify },
    }
    const result = await handlers.tool_call(event, ctx)
    console.log(JSON.stringify({ result: result ?? null, notes }))
`

type Driven = {
    result: { block: true; reason?: string } | null
    notes: string[]
    stderr: string
}

let repo: TempRepo

function setUp(target: TempRepo, { withGuard = true } = {}): void {
    const paths = ['.pi/extensions/agent-guard.ts']
    if (withGuard) paths.push('.agents/scripts/guard.ts', '.agents/scripts/lib')
    target.copyFromCheckout(...paths)
    target.write('.gitignore', '.tmp/\n')
    target.write('src/a.ts', 'export const a = 1\n')
    target.git(['add', '.'])
    target.git(['commit', '--quiet', '-m', 'initial'])
}

function drive(
    event: { toolName: string; input: unknown },
    options: { root?: string; cwd?: string; env?: Record<string, string> } = {},
): Driven {
    const root = options.root ?? repo.dir
    const cwd = options.cwd ?? root
    const eventFile = join(root, '.tmp/event.json')
    mkdirSync(join(root, '.tmp'), { recursive: true })
    writeFileSync(eventFile, JSON.stringify(event))
    const extension = join(root, '.pi/extensions/agent-guard.ts')
    const result = repo.run(
        process.execPath,
        ['--no-warnings', '--input-type=module', '-e', DRIVER, extension, cwd, eventFile],
        { cwd, env: options.env },
    )
    expect(result.status, result.stderr).toBe(0)
    return { ...(JSON.parse(result.stdout) as Omit<Driven, 'stderr'>), stderr: result.stderr }
}

/**
 * A `node` first on PATH that notes each start before it runs the real one. The driver runs node
 * by its full path, so only the extension's own `spawn('node', …)` of the guard goes through it.
 */
function watchNode(): { env: Record<string, string>; started: () => boolean } {
    const bin = join(repo.dir, '.tmp/bin')
    const log = join(bin, 'started')
    repo.write(
        '.tmp/bin/node',
        `#!/bin/sh\necho started >> '${log}'\nexec '${process.execPath}' "$@"\n`,
    )
    chmodSync(join(bin, 'node'), 0o755)
    return {
        env: { PATH: `${bin}${delimiter}${process.env.PATH}` },
        started: () => existsSync(log),
    }
}

const bash = (command: string) => ({ toolName: 'bash', input: { command } })

const commitOnBranch = (branch: string, path: string) => repo.commitOnBranch(branch, path)

beforeEach(() => {
    repo = createTempRepo()
    setUp(repo)
    repo.addOrigin()
})

afterEach(() => repo.cleanup())

it("blocks an unverified push through tool_call with the guard's reason", () => {
    commitOnBranch('feature', 'src/b.ts')
    const { result, notes } = drive(bash('git push -u origin HEAD'))
    expect(result).toEqual({ block: true, reason: expect.stringContaining('npm run verify') })
    expect(notes).toEqual([])

    // From a subfolder, with a pull request split across lines
    const opened = drive(bash('gh pr \\\n  create --fill'), { cwd: join(repo.dir, 'src') })
    expect(opened.result?.reason).toContain('opens a pull request')
})

it('lets the push run once verify has passed on it', () => {
    commitOnBranch('feature', 'src/b.ts')
    markVerified(repo.dir)
    const node = watchNode()
    expect(drive(bash('git push -u origin HEAD'), { env: node.env })).toEqual({
        result: null,
        notes: [],
        stderr: '',
    })
    expect(node.started()).toBe(true)
})

it('leaves every other tool call alone, without starting the guard', () => {
    commitOnBranch('feature', 'src/b.ts')
    const node = watchNode()
    for (const event of [
        bash('ls'),
        bash('git status && npm test'),
        { toolName: 'read', input: { path: 'push.md' } },
        { toolName: 'grep', input: { command: 'git push' } },
        { toolName: 'bash', input: null },
    ]) {
        expect(drive(event, { env: node.env }), JSON.stringify(event)).toEqual({
            result: null,
            notes: [],
            stderr: '',
        })
    }
    expect(node.started()).toBe(false)
})

it('does nothing with DISABLE_AGENT_GUARD=1', () => {
    commitOnBranch('feature', 'src/b.ts')
    const node = watchNode()
    const off = drive(bash('git push'), { env: { ...node.env, DISABLE_AGENT_GUARD: '1' } })
    expect(off).toEqual({ result: null, notes: [], stderr: '' })
    expect(node.started()).toBe(false)
})

it('skips a checkout without the guard, such as an older branch, without a word', () => {
    const older = createTempRepo()
    try {
        setUp(older, { withGuard: false })
        older.write('src/b.ts', 'export const b = 1\n')
        older.git(['add', '.'])
        older.git(['commit', '--quiet', '-m', 'b'])
        const node = watchNode()
        expect(drive(bash('git push'), { root: older.dir, env: node.env })).toEqual({
            result: null,
            notes: [],
            stderr: '',
        })
        expect(node.started()).toBe(false)
    } finally {
        older.cleanup()
    }
})

it("shows the guard's notes: a push it can't check, or a broken guard", () => {
    commitOnBranch('feature', 'src/b.ts')
    const unknown = drive(bash('cd "$REPO" && git push'))
    expect(unknown.result).toBeNull()
    expect(unknown.notes.join('\n')).toContain("can't tell which folder a push runs in")

    repo.write('.agents/scripts/lib/push-check.ts', 'this is not valid typescript (\n')
    const broken = drive(bash('git push'))
    expect(broken.result).toBeNull()
    expect(broken.notes.join('\n')).toContain('hook failed, so it allowed the action')
})

it('prints the notes on stderr when Pi has no UI', () => {
    commitOnBranch('feature', 'src/b.ts')
    const headless = drive(bash('cd "$REPO" && git push'), { env: { HEADLESS: '1' } })
    expect(headless.notes).toEqual([])
    expect(headless.stderr).toContain("can't tell which folder a push runs in")
})

it('allows the call when the extension itself fails, which Pi would treat as a block', () => {
    commitOnBranch('feature', 'src/b.ts')
    const failed = drive(bash('git push'), { env: { BROKEN_CONTEXT: '1' } })
    expect(failed.result).toBeNull()
    expect(failed.notes.join('\n')).toContain('the Pi extension failed, so it allowed the action')

    // With no UI left to show it either, the note goes to stderr.
    const silent = drive(bash('git push'), { env: { BROKEN_CONTEXT: '1', BROKEN_UI: '1' } })
    expect(silent.result).toBeNull()
    expect(silent.stderr).toContain('the Pi extension failed, so it allowed the action')
})

it('keeps a denial when showing its notes fails', () => {
    commitOnBranch('feature', 'src/b.ts')
    // One push it can't place, which brings a note, and one it denies.
    const denied = drive(bash('(cd "$REPO" && git push); git push'), { env: { BROKEN_UI: '1' } })
    expect(denied.result).toEqual({
        block: true,
        reason: expect.stringContaining('npm run verify'),
    })
    expect(denied.stderr).toContain("can't tell which folder a push runs in")
})

it('says so when the guard itself fails to run', () => {
    commitOnBranch('feature', 'src/b.ts')
    repo.write('.agents/scripts/guard.ts', 'this is not valid typescript (\n')
    const failed = drive(bash('git push'))
    expect(failed.result).toBeNull()
    expect(failed.notes.join('\n')).toMatch(
        /tool-start exited with code 1, so it allowed the action\. .*SyntaxError/s,
    )
})

it("allows the call when node can't start the guard at all", () => {
    commitOnBranch('feature', 'src/b.ts')
    // The driver runs node by its full path, so only the extension's own spawn of the guard fails.
    const failed = drive(bash('git push'), { env: { PATH: join(repo.dir, '.tmp/no-such-folder') } })
    expect(failed.result).toBeNull()
    expect(failed.notes.join('\n')).toContain('tool-start failed to run')
})

it('allows the call when the guard exits without reading its input or printing JSON', () => {
    commitOnBranch('feature', 'src/b.ts')
    // A command long enough that the write is still going when the guard closes the pipe
    repo.write('.agents/scripts/guard.ts', 'process.exit(0)\n')
    expect(drive(bash(`git push # ${'x'.repeat(512 * 1024)}`)).result).toBeNull()

    repo.write('.agents/scripts/guard.ts', 'console.log("not json")\n')
    const garbled = drive(bash('git push'))
    expect(garbled.result).toBeNull()
    expect(garbled.notes.join('\n')).toContain('printed no JSON, so it allowed the action')
})

it('is type-checked with the rest of the agent tooling', () => {
    // A bare folder in the tooling tsconfig's include, such as "../../.pi", matches no files and
    // fails nothing, so ask tsc what it reads.
    const tsc = join(REPO_ROOT, 'node_modules/.bin/tsc')
    const result = spawnSync(tsc, ['--noEmit', '--listFilesOnly', '-p', '.agents/scripts'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.split('\n')).toContain(join(REPO_ROOT, '.pi/extensions/agent-guard.ts'))
})
