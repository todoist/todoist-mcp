import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createTempRepo, markVerified, type TempRepo } from './lib/test-repo.ts'

// guard.ts as the agents' hooks run it: a separate node process, the hook's JSON on stdin, in a
// throwaway repo holding a copy of .agents/scripts. The decisions themselves are covered in
// lib/push-check.test.ts.
let repo: TempRepo

function guard(
    payload: Record<string, unknown> | string,
    options: { cwd?: string; env?: Record<string, string | undefined>; script?: string } = {},
) {
    const script = options.script ?? join(repo.dir, '.agents/scripts/guard.ts')
    const result = repo.run(process.execPath, [script, 'tool-start'], {
        input: typeof payload === 'string' ? payload : JSON.stringify(payload),
        ...options,
    })
    return { ...result, json: result.stdout ? JSON.parse(result.stdout) : undefined }
}

const bash = (command: string, cwd = repo.dir) => ({
    tool_name: 'Bash',
    tool_input: { command },
    cwd,
})

const commitOnBranch = (branch: string, path: string) => repo.commitOnBranch(branch, path)

beforeEach(() => {
    repo = createTempRepo()
    repo.copyFromCheckout('.agents/scripts/guard.ts', '.agents/scripts/lib')
    repo.write('.gitignore', '.tmp/\n')
    repo.write('src/a.ts', 'export const a = 1\n')
    repo.git(['add', '.'])
    repo.git(['commit', '--quiet', '-m', 'initial'])
    repo.addOrigin()
})

afterEach(() => repo.cleanup())

it('stops an unverified push with the PreToolUse decision Claude Code and Codex read', () => {
    commitOnBranch('feature', 'src/b.ts')
    const result = guard(bash('git push -u origin HEAD'))
    expect(result.status).toBe(0)
    expect(result.json).toEqual({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: expect.stringContaining('npm run verify'),
        },
    })
})

it('prints nothing for a verified push, or a command that pushes nothing', () => {
    commitOnBranch('feature', 'src/b.ts')
    markVerified(repo.dir)
    expect(guard(bash('git push')).stdout).toBe('')
    expect(guard(bash('ls')).stdout).toBe('')
    // A tool call with no shell command, such as one a wider matcher lets through
    expect(guard({ tool_name: 'Read', tool_input: { file_path: 'x' } }).stdout).toBe('')
})

it('tells the person about a push it could not check', () => {
    commitOnBranch('feature', 'src/b.ts')
    expect(guard(bash('cd "$REPO" && git push')).json).toEqual({
        systemMessage: "agent-guard: can't tell which folder a push runs in, so it isn't checked",
    })
})

it('guards the checkout it lives in, whatever the git variables', () => {
    commitOnBranch('feature', 'src/b.ts')
    const elsewhere = mkdtempSync(join(tmpdir(), 'agent-elsewhere-'))
    try {
        const other = { GIT_DIR: join(elsewhere, '.git'), GIT_WORK_TREE: elsewhere }
        const result = guard(bash('git push'), { cwd: elsewhere, env: other })
        expect(result.json?.hookSpecificOutput?.permissionDecision).toBe('deny')
    } finally {
        rmSync(elsewhere, { recursive: true, force: true })
    }
})

it('guards another worktree of this repository the agent works in, never another repository', () => {
    const tree = join(dirname(repo.dir), `${repo.dir.split('/').pop()}-linked`)
    repo.git(['worktree', 'add', '--quiet', '-b', 'in-worktree', tree])
    const other = createTempRepo()
    try {
        writeFileSync(join(tree, 'src/w.ts'), 'export const w = 1\n')
        repo.git(['-C', tree, 'add', '.'])
        repo.git(['-C', tree, 'commit', '--quiet', '-m', 'w'])
        const inTree = guard(bash('git push', tree), { cwd: tree })
        expect(inTree.json?.hookSpecificOutput?.permissionDecision).toBe('deny')

        // Another repository with an unverified commit, and its own copy of the guard
        other.copyFromCheckout('.agents/scripts/guard.ts', '.agents/scripts/lib')
        other.write('src/o.ts', 'export const o = 1\n')
        other.git(['add', '.'])
        other.git(['commit', '--quiet', '-m', 'other'])
        expect(guard(bash('git push', other.dir), { cwd: other.dir }).stdout).toBe('')
    } finally {
        other.cleanup()
        repo.git(['worktree', 'remove', '--force', tree])
    }
})

it('says so when it finds no git repository to guard', () => {
    const outside = mkdtempSync(join(tmpdir(), 'agent-outside-'))
    try {
        mkdirSync(join(outside, '.agents'))
        cpSync(join(repo.dir, '.agents/scripts'), join(outside, '.agents/scripts'), {
            recursive: true,
        })
        const result = guard(bash('git push', outside), {
            cwd: outside,
            script: join(outside, '.agents/scripts/guard.ts'),
        })
        expect(result.json).toEqual({
            systemMessage: 'agent-guard: no git repository found, so the push was not checked',
        })
    } finally {
        rmSync(outside, { recursive: true, force: true })
    }
})

it('fails open, visibly, when a library file is broken', () => {
    commitOnBranch('feature', 'src/b.ts')
    repo.write('.agents/scripts/lib/push-check.ts', 'this is not valid typescript (\n')
    const result = guard(bash('git push'))
    expect(result.status).toBe(0)
    expect(result.json).toEqual({
        systemMessage: expect.stringContaining('tool-start hook failed, so it allowed the action'),
    })
})

it.each(['not json', '[1, 2]', 'null', '"git push"'])('fails open on the input %s', (input) => {
    const result = guard(input)
    expect(result.status).toBe(0)
    expect(result.json.systemMessage).toContain('hook failed, so it allowed the action')
})

function runEvent(event: string) {
    return repo.run(process.execPath, [join(repo.dir, '.agents/scripts/guard.ts'), event], {
        input: JSON.stringify({ session_id: 's1' }),
    })
}

it('fails open on an unknown event', () => {
    const result = runEvent('turn-middle')
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout).systemMessage).toContain('unknown event "turn-middle"')
})

it('says nothing to the end-of-turn events older hook configs still send', () => {
    commitOnBranch('feature', 'src/b.ts')
    for (const event of ['turn-start', 'turn-end']) {
        const result = runEvent(event)
        expect([result.status, result.stdout, result.stderr], event).toEqual([0, '', ''])
    }
})

it('runs the check even when the agent running the tests has DISABLE_AGENT_GUARD=1', () => {
    const previous = process.env.DISABLE_AGENT_GUARD
    process.env.DISABLE_AGENT_GUARD = '1'
    try {
        commitOnBranch('feature', 'src/b.ts')
        expect(guard(bash('git push')).json?.hookSpecificOutput?.permissionDecision).toBe('deny')
    } finally {
        if (previous === undefined) delete process.env.DISABLE_AGENT_GUARD
        else process.env.DISABLE_AGENT_GUARD = previous
    }
})

it('does nothing with DISABLE_AGENT_GUARD=1', () => {
    commitOnBranch('feature', 'src/b.ts')
    const result = guard(bash('git push'), { env: { DISABLE_AGENT_GUARD: '1' } })
    expect([result.status, result.stdout, result.stderr]).toEqual([0, '', ''])
})
