import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTempRepo, markVerified, REPO_ROOT, type TempRepo } from './lib/test-repo.ts'

// Runs the exact hook commands from each agent's config, the way the agent would, in a
// throwaway repo with a copy of .agents/scripts.
type HookConfig = {
    hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>
}

const AGENTS = [
    {
        name: 'Claude Code',
        config: '.claude/settings.json',
        env: (dir: string) => ({ CLAUDE_PROJECT_DIR: dir }),
    },
    // Hostile git variables, as a hook may inherit: the command must unset them to find the
    // checkout.
    {
        name: 'Codex',
        config: '.codex/hooks.json',
        env: () => ({ GIT_DIR: '/nonexistent/.git', GIT_WORK_TREE: '/nonexistent' }),
    },
    // Cursor runs the Claude Code hooks. If it does not set CLAUDE_PROJECT_DIR, the command falls
    // back to the git root.
    {
        name: 'Cursor (Claude Code hooks, no CLAUDE_PROJECT_DIR)',
        config: '.claude/settings.json',
        env: () => ({ CLAUDE_PROJECT_DIR: undefined }),
    },
]

function readConfig(config: string): HookConfig {
    return JSON.parse(readFileSync(join(REPO_ROOT, config), 'utf8')) as HookConfig
}

/** The one command a config runs before each shell command. */
function command(config: string): string {
    const entries = readConfig(config).hooks.PreToolUse ?? []
    expect(entries.map((entry) => entry.matcher)).toEqual(['Bash'])
    const commands = entries.flatMap((entry) => entry.hooks.map((hook) => hook.command))
    expect(commands, config).toHaveLength(1)
    return commands[0] ?? ''
}

let repo: TempRepo

beforeEach(() => {
    repo = createTempRepo()
    repo.copyFromCheckout('.agents/scripts/guard.ts', '.agents/scripts/lib')
    repo.write('.gitignore', '.tmp/\n')
    repo.write('src/a.ts', 'export const a = 1\n')
    repo.git(['add', '.'])
    repo.git(['commit', '--quiet', '-m', 'initial'])
    repo.addOrigin()
    repo.git(['switch', '--quiet', '-c', 'feature'])
    repo.write('src/a.ts', 'export const a = 2\n')
    repo.git(['commit', '--quiet', '-am', 'change a'])
})

afterEach(() => repo.cleanup())

describe.each(AGENTS)('$name', ({ config, env }) => {
    const run = (
        input: string,
        options: { dir?: string; path?: string } = {},
    ): { status: number | null; stdout: string; stderr: string } => {
        const dir = options.dir ?? repo.dir
        const result = repo.run('sh', ['-c', command(config)], {
            cwd: join(dir, 'src'),
            env: { ...env(dir), ...(options.path ? { PATH: options.path } : {}) },
            input,
        })
        return { status: result.status, stdout: result.stdout, stderr: result.stderr }
    }
    const bash = (shell: string) =>
        JSON.stringify({
            tool_name: 'Bash',
            tool_input: { command: shell },
            cwd: join(repo.dir, 'src'),
        })
    const decision = (stdout: string) => JSON.parse(stdout).hookSpecificOutput?.permissionDecision

    it('stops an unverified push or pull request, and lets it through once verify passed', () => {
        const pushed = run(bash('git push -u origin HEAD'))
        expect(pushed.status).toBe(0)
        expect(decision(pushed.stdout)).toBe('deny')
        expect(decision(run(bash('gh pr create --fill')).stdout)).toBe('deny')
        expect(decision(run(bash('gh pr\tcreate --fill')).stdout)).toBe('deny')

        markVerified(repo.dir)
        expect(run(bash('git push -u origin HEAD'))).toEqual({ status: 0, stdout: '', stderr: '' })
    })

    it('never starts git or node for a command that cannot push', () => {
        const bin = mkdtempSync(join(tmpdir(), 'agent-bin-'))
        const calls = join(bin, 'calls')
        try {
            for (const tool of ['git', 'node']) {
                writeFileSync(join(bin, tool), `#!/bin/sh\necho ${tool} >> "${calls}"\n`)
                chmodSync(join(bin, tool), 0o755)
            }
            const path = `${bin}${delimiter}${process.env.PATH}`
            // Even input the guard would reject passes in silence, at no cost.
            expect(run('{not json, ls', { path })).toEqual({ status: 0, stdout: '', stderr: '' })
            expect(run(bash('npm test && git status'), { path })).toEqual({
                status: 0,
                stdout: '',
                stderr: '',
            })
            // Only the command counts, not a folder name elsewhere in the payload
            const inPushFolder = JSON.stringify({
                cwd: '/work/fix-push',
                transcript_path: '/home/me/.claude/projects/-work-fix-push/session.jsonl',
                tool_name: 'Bash',
                tool_input: { command: 'ls' },
            })
            expect(run(inPushFolder, { path })).toEqual({ status: 0, stdout: '', stderr: '' })
            expect(existsSync(calls)).toBe(false)
        } finally {
            rmSync(bin, { recursive: true, force: true })
        }
    })

    it('skips a checkout without the guard, such as an older branch, without a word', () => {
        rmSync(join(repo.dir, '.agents'), { recursive: true })
        expect(run(bash('git push'))).toEqual({ status: 0, stdout: '', stderr: '' })
    })
})

it('runs the guard only before shell commands, and at no other point', () => {
    for (const config of ['.claude/settings.json', '.codex/hooks.json']) {
        expect(Object.keys(readConfig(config).hooks), config).toEqual(['PreToolUse'])
    }
})

it('has no Cursor hooks file: Cursor runs the Claude Code hooks, and a second file runs them twice', () => {
    expect(existsSync(join(REPO_ROOT, '.cursor/hooks.json'))).toBe(false)
})
