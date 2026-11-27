// Finds what a shell command pushes: each `git push`, new pull request, commit and `git add` it
// runs, in order, with the folder each runs in, and the commands before them that change what's
// checked out. Nothing here runs the command or git.

import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { readCommands, type ShellItem } from './shell-commands.ts'

/**
 * - `push`, `pr`: what a push or a new pull request sends, as git names it in `sources` (`HEAD`, a
 *   branch, `refs/tags/v1`); `*` when it can't be told from the command: every branch, a wildcard,
 *   what git's push settings pick, or arguments `xargs` adds.
 * - `commit`: a commit, so a later push from that folder sends what it takes. `stages: 'tracked'`
 *   for `git commit -a`, and `partial` when it takes only some changes: named paths, or `--patch`.
 * - `stage`: `git add`, of the paths in `sources` (none: the whole checkout), with `stages: 'all'`
 *   when it takes untracked files too, or `'tracked'` for `git add -u`.
 * - `create`: a branch made from what's checked out, named in `sources`; `force` when it replaces a
 *   branch that may exist already (`git switch -C`, `git checkout -B`), and `switches` when the
 *   command checks it out too (all but `git branch <name>`).
 * - `move`: a command that changes what's checked out, such as `git switch` or `git rebase`.
 * - `dir`: the folder it runs in, or null when the command doesn't say, as after `cd "$REPO"`.
 * - `implicit`: a push with no refspec, so git's settings decide what it sends, to `remote` (null
 *   when the command names none).
 * - `tags`: the push also sends every tag (`--tags`), which only the repository can list.
 * - `followTags`: what the command says about sending the annotated tags the pushed commits reach
 *   (`--follow-tags`, `--no-follow-tags`, or an inline `push.followTags`). Unset, git's settings
 *   decide.
 */
export type PushTarget = {
    kind: 'push' | 'pr' | 'commit' | 'stage' | 'create' | 'move'
    dir: string | null
    sources: string[]
    implicit?: boolean
    remote?: string | null
    tags?: boolean
    followTags?: boolean
    force?: boolean
    switches?: boolean
    stages?: Staged
    partial?: boolean
}

/** What a `git add` or `git commit` takes from the working tree. */
export type Staged = 'all' | 'tracked'

/**
 * Where the shell is: the folder commands run in (null when the command doesn't say), and the
 * folders `pushd` keeps below it for `popd`, last on top. `deeper` means the stack goes on below
 * those, out of sight, as after `pushd +1` rotates it.
 */
type Shell = { dir: string | null; stack: (string | null)[]; deeper: boolean }

/** Shell words before a command that run the command after them. */
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{'])

/** Commands that run the command after them, with the options of each that take a value. */
const WRAPPERS = new Map<string, string[]>([
    ['command', []],
    ['builtin', []],
    ['exec', ['-a']],
    ['nohup', []],
    ['time', ['-f', '--format', '-o', '--output']],
    ['env', ['-u', '--unset', '-C', '--chdir', '-S', '--split-string']],
    ['timeout', ['-s', '--signal', '-k', '--kill-after']],
    [
        'sudo',
        [
            '-u',
            '--user',
            '-g',
            '--group',
            '-h',
            '--host',
            '-p',
            '--prompt',
            '-C',
            '--close-from',
            '-D',
            '--chdir',
        ],
    ],
    [
        'xargs',
        [
            '-I',
            '-L',
            '-n',
            '-P',
            '-d',
            '-E',
            '-s',
            '-a',
            '--arg-file',
            '--delimiter',
            '--max-args',
            '--max-lines',
            '--max-procs',
            '--max-chars',
            '--eof',
            '--process-slot-var',
        ],
    ],
])

/** Shells whose `-c` runs a command given as a string. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])

/** Git commands that change what's checked out, or move a branch, except in the forms `isMove` lets
 * through. */
const MOVES = new Set([
    'update-ref',
    'switch',
    'checkout',
    'reset',
    'rebase',
    'merge',
    'pull',
    'cherry-pick',
    'revert',
    'am',
])

export function findTargets(command: string, cwd: string): PushTarget[] {
    const targets: PushTarget[] = []
    walk(readCommands(command), newShell(cwd), targets)
    return targets
}

const newShell = (dir: string | null): Shell => ({ dir, stack: [], deeper: false })

/** Reads the commands in `items`, moving `shell` to the folder they end in. */
function walk(items: ShellItem[], shell: Shell, targets: PushTarget[]): void {
    const saved: Shell[] = []
    for (const item of items) {
        // A subshell works on a copy, and the shell is back where it was when it ends.
        if (item.type === 'enter') saved.push({ ...shell, stack: [...shell.stack] })
        else if (item.type === 'leave') {
            const before = saved.pop()
            if (before) Object.assign(shell, before)
        } else readCommand(item.words, shell, targets)
    }
}

/** Reads one simple command, and moves `shell` to the folder the next one runs in. */
function readCommand(words: string[], shell: Shell, targets: PushTarget[]): void {
    const { start, inDir, extraArgs, nested } = skipWrappers(words, shell.dir)
    // `env -S '…'`: a command given as a string, run by another process
    if (nested !== undefined) {
        walk(readCommands(nested), newShell(inDir), targets)
        return
    }
    const name = basename(words[start] ?? '')
    const rest = words.slice(start + 1)
    if (name === 'cd') {
        shell.dir = resolveDir(shell.dir, rest.find((word) => !/^(-[LPe@]+|--)$/.test(word)) ?? '~')
    } else if (name === 'pushd') pushd(shell, rest)
    else if (name === 'popd') popd(shell, rest)
    // `eval` runs its words as a command in this shell, so a `cd` in it stays.
    else if (name === 'eval') {
        shell.dir = inDir
        walk(readCommands(rest.join(' ')), shell, targets)
    } else if (SHELLS.has(name)) {
        const script = shellScript(rest)
        if (script !== undefined) walk(readCommands(script), newShell(inDir), targets)
    } else if (name === 'git') readGit(words, start + 1, inDir, extraArgs, targets)
    else if (name === 'gh') readGh(words, start + 1, inDir, extraArgs, targets)
}

/**
 * `pushd <dir>` keeps the folder for `popd` and goes to `<dir>`; `-n` only adds `<dir>` to the
 * stack. With no folder it swaps the top two; `+N` and `-N` rotate the stack.
 */
function pushd(shell: Shell, args: string[]): void {
    const keep = args.includes('-n')
    const to = args.find((word) => word !== '--' && word !== '-n')
    if (to !== undefined && /^[+-]\d+$/.test(to)) {
        if (!keep) shell.dir = null
        shell.stack = []
        shell.deeper = true
    } else if (to === undefined) {
        if (keep) return
        if (shell.stack.length > 0) {
            const next = shell.stack.pop() ?? null
            shell.stack.push(shell.dir)
            shell.dir = next
        } else if (shell.deeper) shell.dir = null
        // An empty stack: pushd fails and the folder stays.
    } else if (keep) shell.stack.push(resolveDir(shell.dir, to))
    else {
        shell.stack.push(shell.dir)
        shell.dir = resolveDir(shell.dir, to)
    }
}

/** `popd` goes back to the folder on top of the stack; `-n` only drops it; `+N` and `-N` remove
 * another entry. */
function popd(shell: Shell, args: string[]): void {
    const keep = args.includes('-n')
    if (args.some((word) => /^[+-]\d+$/.test(word))) {
        shell.dir = null
        shell.stack = []
        shell.deeper = true
    } else if (shell.stack.length > 0) {
        const top = shell.stack.pop() ?? null
        if (!keep) shell.dir = top
    } else if (shell.deeper && !keep) shell.dir = null
    // An empty stack: popd fails and the folder stays.
}

/** The command string a shell's `-c` runs: `bash -lc 'git push'`. */
function shellScript(args: string[]): string | undefined {
    let runsString = false
    for (let i = 0; i < args.length; i++) {
        const word = args[i] as string
        if (word === '--' || !word.startsWith('-')) return runsString ? word : undefined
        if (word === '-o' || word === '--rcfile' || word === '--init-file') i++
        else if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(word)) runsString = true
    }
    return undefined
}

/**
 * Skips the shell keywords, variable assignments and wrapper commands (`env`, `sudo`, `xargs`, …)
 * before a command, with their options. `env -C` changes the folder for that command only, and
 * `env -S` gives the command as one string. A command `xargs` runs gets arguments nobody can see.
 */
function skipWrappers(
    words: string[],
    dir: string | null,
): { start: number; inDir: string | null; extraArgs: boolean; nested?: string } {
    let i = 0
    let inDir = dir
    let extraArgs = false
    while (i < words.length) {
        const word = words[i] as string
        if (KEYWORDS.has(word) || /^[A-Za-z_]\w*=/.test(word)) {
            i++
            continue
        }
        const name = basename(word)
        const valueOptions = WRAPPERS.get(name)
        if (!valueOptions) break
        if (name === 'xargs') extraArgs = true
        for (i++; i < words.length && (words[i] as string).startsWith('-'); i++) {
            const option = words[i] as string
            if (option === '--') {
                i++
                break
            }
            // `command -v git` prints where git is; it runs nothing.
            if (name === 'command' && /^-[a-zA-Z]*[vV]/.test(option)) {
                return { start: words.length, inDir, extraArgs }
            }
            const [flag = option, value] = option.split(/=(.*)/s)
            const operand = value ?? (valueOptions.includes(flag) ? words[++i] : undefined)
            if (name === 'env' && (flag === '-S' || flag === '--split-string')) {
                return { start: words.length, inDir, extraArgs, nested: operand ?? '' }
            }
            // `env -C` and `sudo -D` change the folder for that command only.
            const chdir = name === 'env' ? '-C' : name === 'sudo' ? '-D' : undefined
            if (chdir !== undefined && (flag === chdir || flag === '--chdir')) {
                inDir = resolveDir(inDir, operand ?? '')
            } else if (chdir !== undefined && option.startsWith(chdir) && option.length > 2) {
                inDir = resolveDir(inDir, option.slice(2))
            }
        }
        // timeout's first operand is how long to wait.
        if (name === 'timeout') i++
    }
    return { start: i, inDir, extraArgs }
}

/** The folder `to` names from `from`, or null when it can't tell, as for a variable or `cd -`. */
function resolveDir(from: string | null, to: string): string | null {
    if (to === '~') return homedir()
    if (to.startsWith('~/')) return join(homedir(), to.slice(2))
    if (!to || to === '-' || /[$*?[~]/.test(to)) return null
    if (isAbsolute(to)) return to
    return from === null ? null : resolve(from, to)
}

function readGit(
    words: string[],
    start: number,
    dir: string | null,
    extraArgs: boolean,
    targets: PushTarget[],
): void {
    let i = start
    let inDir = dir
    // An inline `push.*`, `remote.*` or `branch.*` setting can change what a push with no refspec
    // sends, or where. A refspec in the command wins over them, as in git.
    let configured = false
    let followTags: boolean | undefined
    for (; i < words.length; i++) {
        const word = words[i] as string
        if (word === '-C') inDir = resolveDir(inDir, words[++i] ?? '')
        else if (/^-C./.test(word)) inDir = resolveDir(inDir, word.slice(2))
        else if (word === '-c' || word === '--config-env' || word.startsWith('--config-env=')) {
            const setting = word.startsWith('--config-env=')
                ? word.slice('--config-env='.length)
                : (words[++i] ?? '')
            if (/^(push|remote|branch)\./i.test(setting)) configured = true
            const follow = /^push\.followtags(?:=(.*))?$/i.exec(setting)
            // `--config-env` names a variable, whose value the command doesn't show.
            if (follow)
                followTags = word !== '-c' || !/^(false|no|off|0|)$/i.test(follow[1] ?? 'on')
        } else if (word === '--namespace') i++
        else if (word === '--git-dir' || word === '--work-tree') {
            i++
            inDir = null
        } else if (word.startsWith('--git-dir=') || word.startsWith('--work-tree=')) inDir = null
        else if (!word.startsWith('-')) break
    }
    const subcommand = words[i] ?? ''
    const args = words.slice(i + 1)
    if (subcommand === 'commit') {
        targets.push({ kind: 'commit', dir: inDir, sources: [], ...readCommit(args) })
    }
    if (subcommand === 'add') {
        const stage = readAdd(args)
        if (stage) targets.push({ kind: 'stage', dir: inDir, ...stage })
    }
    const created = createdBranch(subcommand, args)
    if (created !== undefined) {
        targets.push({
            kind: 'create',
            dir: inDir,
            sources: [created.name],
            force: created.force,
            switches: subcommand !== 'branch',
        })
    } else if (MOVES.has(subcommand) && isMove(subcommand, args)) {
        targets.push({ kind: 'move', dir: inDir, sources: [] })
    } else if (subcommand === 'branch' && movesBranch(args)) {
        targets.push({ kind: 'move', dir: inDir, sources: [] })
    }
    if (subcommand !== 'push') return
    const push = readPush(args, configured, extraArgs)
    if (push === undefined) return
    // The last of the options wins, and either wins over an inline setting.
    const option = args.filter((word) => /^--(no-)?follow-tags$/.test(word)).at(-1)
    if (option !== undefined) followTags = option === '--follow-tags'
    targets.push({ ...push, dir: inDir, ...(followTags !== undefined && { followTags }) })
}

/** `git commit` options whose value is the next word, unless given with `=`. */
const COMMIT_VALUE_OPTIONS = new Set([
    '--message',
    '--file',
    '--reuse-message',
    '--reedit-message',
    '--template',
    '--author',
    '--date',
    '--fixup',
    '--squash',
    '--cleanup',
    '--trailer',
    '--pathspec-from-file',
])

/** Whether `git commit <args>` takes every tracked change (`-a`), or only some (paths, `--patch`). */
function readCommit(args: string[]): { stages?: Staged; partial?: boolean } {
    let all = false
    let partial = false
    for (let i = 0; i < args.length; i++) {
        const word = args[i] as string
        if (word === '--') {
            partial ||= i + 1 < args.length
            break
        }
        if (word.startsWith('--')) {
            const flag = word.split('=', 1)[0] as string
            if (flag === '--all') all = true
            else if (['--patch', '--interactive', '--pathspec-from-file'].includes(flag)) {
                partial = true
            }
            if (!word.includes('=') && COMMIT_VALUE_OPTIONS.has(flag)) i++
        } else if (word.startsWith('-') && word.length > 1) {
            // A cluster such as `-am`: `-m`, `-F`, `-C`, `-c` and `-t` take the rest of it, or the
            // next word, as their value; `-S` and `-u` take only the rest.
            for (let k = 1; k < word.length; k++) {
                const letter = word[k] as string
                if (letter === 'a') all = true
                else if (letter === 'p') partial = true
                else if ('mFCct'.includes(letter)) {
                    if (k === word.length - 1) i++
                    break
                } else if ('Su'.includes(letter)) break
            }
        } else partial = true
    }
    return { ...(all ? { stages: 'tracked' as const } : {}), ...(partial ? { partial } : {}) }
}

/**
 * What `git add <args>` stages: the paths it names (none means the whole checkout), and whether it
 * takes untracked files too. Undefined when it stages nothing whole: a dry run, hunks picked by
 * hand, or paths from a file.
 */
function readAdd(args: string[]): { sources: string[]; stages: Staged } | undefined {
    let stages: Staged | undefined
    const paths: string[] = []
    for (let i = 0; i < args.length; i++) {
        const word = args[i] as string
        if (word === '--') {
            paths.push(...args.slice(i + 1))
            break
        }
        if (['-A', '--all', '--no-ignore-removal'].includes(word)) stages = 'all'
        else if (['-u', '--update'].includes(word)) stages ??= 'tracked'
        else if (
            /^(-[npieN]|--(dry-run|patch|interactive|edit|intent-to-add|refresh|pathspec-from-file)(=.*)?)$/.test(
                word,
            )
        ) {
            return undefined
        } else if (word === '--chmod') i++
        else if (!word.startsWith('-')) paths.push(word)
    }
    // `git add <paths>` takes untracked files under them too.
    if (paths.length > 0) return { sources: paths, stages: stages ?? 'all' }
    return stages ? { sources: [], stages } : undefined
}

/**
 * The branch `git switch -c`, `git checkout -b` or `git branch` makes from what's checked out, and
 * whether it is forced over one that may exist (`git switch -C`, `git checkout -B`).
 */
function createdBranch(
    subcommand: string,
    args: string[],
): { name: string; force: boolean } | undefined {
    const operands = args.filter((word) => !word.startsWith('-'))
    if (subcommand === 'branch') {
        // `git branch name` alone; with a start point, or any option, it isn't what's checked out
        const name = operands[0]
        return args.length === 1 && name !== undefined ? { name, force: false } : undefined
    }
    const flags =
        subcommand === 'switch' ? ['-c', '-C', '--create', '--force-create'] : ['-b', '-B']
    if (!['switch', 'checkout'].includes(subcommand)) return undefined
    const at = args.findIndex((word) => flags.includes(word))
    if (at === -1) return undefined
    const name = args[at + 1]
    // A start point after the name means the new branch, and HEAD, move there.
    const after = args.slice(at + 2).filter((word) => !word.startsWith('-'))
    if (name === undefined || after.length > 0) return undefined
    return { name, force: ['-C', '--force-create', '-B'].includes(args[at] as string) }
}

/** Whether `git branch` moves, renames or copies a branch over another: it may then hold anything. */
function movesBranch(args: string[]): boolean {
    return args.some((word) => /^(-[fmMcC]|--force|--move|--copy)$/.test(word))
}

/** Whether a git command that can change what's checked out does here. */
function isMove(subcommand: string, args: string[]): boolean {
    const dashes = args.indexOf('--')
    const before = dashes === -1 ? args : args.slice(0, dashes)
    const operands = before.filter((word) => !word.startsWith('-'))
    // `git checkout [<commit>] -- file` and `git reset -- file` restore files and keep HEAD;
    // `git checkout <branch> --`, with no file after it, switches.
    if (subcommand === 'checkout' && dashes !== -1 && dashes < args.length - 1) return false
    if (subcommand === 'reset') return operands.some((word) => word !== 'HEAD')
    return true
}

/**
 * What a push sends. `configured`: an inline setting may decide what a push with no refspec sends.
 * `extraArgs`: `xargs` adds arguments nobody can see.
 */
function readPush(
    args: string[],
    configured: boolean,
    extraArgs: boolean,
): Omit<PushTarget, 'dir'> | undefined {
    let remote: string | null = null
    // A remote named as an argument wins over `--repo`, as in git.
    let repoOption: string | null = null
    let tags = false
    let every = false
    const refspecs: string[] = []
    for (let i = 0; i < args.length; i++) {
        const word = args[i] as string
        // A dry run sends nothing, and a deletion sends no code.
        if (['-n', '--dry-run', '-d', '--delete'].includes(word)) return undefined
        if (word === '--tags') tags = true
        else if (['--all', '--branches', '--mirror'].includes(word)) every = true
        else if (word === '--repo') repoOption = args[++i] ?? null
        else if (word.startsWith('--repo=')) repoOption = word.slice('--repo='.length)
        else if (['-o', '--push-option', '--receive-pack', '--exec'].includes(word)) i++
        else if (/^-[^-]*[nd]/.test(word) && !word.startsWith('-o')) return undefined
        else if (word.startsWith('-')) continue
        else if (remote === null) remote = word
        else refspecs.push(word)
    }
    remote ??= repoOption
    if (every || ((configured || extraArgs) && refspecs.length === 0)) {
        return { kind: 'push', sources: ['*'] }
    }
    if (refspecs.length === 0) {
        // With --tags and no refspec, it pushes tags alone.
        if (tags) return { kind: 'push', sources: [], tags: true }
        return { kind: 'push', sources: ['HEAD'], implicit: true, remote }
    }
    // `:` alone pushes every branch both sides have, like --all.
    if (refspecs.some((spec) => spec === ':' || spec === '+:')) {
        return { kind: 'push', sources: ['*'] }
    }
    // `+` forces, `:<dst>` deletes, and `tag <name>` names a tag.
    const sources: string[] = []
    for (let k = 0; k < refspecs.length; k++) {
        const spec = refspecs[k] as string
        const tag = refspecs[k + 1]
        if (spec === 'tag' && tag !== undefined) {
            sources.push(`refs/tags/${tag}`)
            k++
            continue
        }
        const forced = spec.replace(/^\+/, '')
        if (!forced.startsWith(':')) sources.push(forced.split(':')[0] as string)
    }
    if (sources.length === 0 && !tags) return undefined
    // `xargs` may add more refspecs than the command shows.
    if (extraArgs) return { kind: 'push', sources: ['*'] }
    return tags ? { kind: 'push', sources, tags: true } : { kind: 'push', sources }
}

/**
 * `gh pr create`, or `gh pr new`, opens a pull request for the current branch, or for `--head`.
 * `gh pr checkout` changes what's checked out.
 */
function readGh(
    words: string[],
    start: number,
    dir: string | null,
    extraArgs: boolean,
    targets: PushTarget[],
): void {
    let at = start
    // Global options before the subcommand: `gh -R owner/repo pr create`.
    while (/^(-R|--repo)$/.test(words[at] ?? '')) at += 2
    while ((words[at] ?? '').startsWith('--repo=')) at++
    if (words[at] !== 'pr') return
    if (words[at + 1] === 'checkout') {
        targets.push({ kind: 'move', dir, sources: [] })
        return
    }
    if (!['create', 'new'].includes(words[at + 1] ?? '')) return
    let head = 'HEAD'
    for (let i = at + 2; i < words.length; i++) {
        const word = words[i] as string
        if (word === '-H' || word === '--head') head = words[++i] ?? 'HEAD'
        else if (word.startsWith('--head=')) head = word.slice('--head='.length)
        else if (/^-H./.test(word)) head = word.slice(2)
    }
    // A head in someone's fork, `owner:branch`, is still that branch.
    const source = extraArgs ? '*' : head.replace(/^[^:]*:/, '')
    targets.push({ kind: 'pr', dir, sources: [source] })
}
