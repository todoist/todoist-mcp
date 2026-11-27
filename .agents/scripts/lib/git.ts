import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The checkout this copy of the tooling lives in, whatever the caller's working directory. */
export const CHECKOUT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

// Git exports GIT_DIR, GIT_INDEX_FILE and friends to hooks. A tool that runs git with them in
// place acts on whatever repository they name, not the one it was asked about.
let localVars: string[] | undefined
function localGitVars(): string[] {
    localVars ??= spawnSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' })
        .stdout.split('\n')
        .filter(Boolean)
    return localVars
}

export function cleanGitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const clean = { ...env }
    for (const name of localGitVars()) delete clean[name]
    return clean
}

export type GitResult = { ok: boolean; stdout: string; stderr: string }

export function git(root: string, args: string[], options: { input?: string } = {}): GitResult {
    const result = spawnSync('git', args, {
        cwd: root,
        env: cleanGitEnv(),
        input: options.input,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    })
    return { ok: result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** The ref the current branch is measured against: origin's default branch, else a local one. */
export function defaultBranchRef(root: string): string | undefined {
    const originHead = git(root, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'])
    const candidates = [
        originHead.ok ? originHead.stdout.trim() : undefined,
        'refs/remotes/origin/main',
        'refs/heads/main',
    ]
    return candidates.find((ref) => ref && resolveCommit(root, ref) !== undefined)
}

/** The commit `ref` names, or undefined when it names none. */
export function resolveCommit(root: string, ref: string): string | undefined {
    const commit = git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
    return commit.ok ? commit.stdout.trim() || undefined : undefined
}

/**
 * Where the current branch, or `head`, left the default branch, or undefined if there is no default
 * branch or they share no history.
 */
export function branchBase(
    root: string,
    ref = defaultBranchRef(root),
    head = 'HEAD',
): string | undefined {
    if (!ref) return undefined
    const base = git(root, ['merge-base', head, ref])
    return base.ok ? base.stdout.trim() : undefined
}

/** The top folder of the checkout `dir` is in, or undefined when it isn't in one. */
export function findRepoRoot(dir: string): string | undefined {
    const toplevel = git(dir, ['rev-parse', '--show-toplevel'])
    return toplevel.ok ? toplevel.stdout.trim() : undefined
}
