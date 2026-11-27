// The push check. Before an agent runs a shell command, it stops one that pushes code from this
// checkout, or another worktree of it, that `npm run verify` hasn't passed, or opens a pull request
// for it. A push sends commits, not the working tree, so what's pushed has to be exactly a tree
// verify passed. Changes that verify records nothing for (docs, files only CI reads) need no
// verify.

import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { branchBase, defaultBranchRef, findRepoRoot, git, resolveCommit } from './git.ts'
import { findTargets, type PushTarget, type Staged } from './push-targets.ts'
import { readVerified } from './state.ts'
import {
    changedSince,
    changeNeedsChecks,
    classify,
    codeFingerprint,
    commitChanges,
    needsChecks,
    snapshot,
    snapshotCommit,
} from './tree.ts'

export type PushVerdict =
    | { decision: 'allow'; notes: string[] }
    | { decision: 'deny'; reason: string; notes: string[] }

/** One checkout the command pushes from, with what the command does there before it pushes. */
type Checkout = {
    root: string
    notes: string[]
    head: string | undefined
    verified: string | undefined
    /** Read only when needed, since most checks never get that far. */
    defaultRef: () => string | undefined
    /** The working tree's fingerprint, read once however many sources the command pushes. */
    tree: () => string
    /** The branch checked out at this point of the command, which a commit there advances. */
    branch: string | undefined
    /** What `git add` has staged of the whole checkout so far in the command. */
    staged: Staged | undefined
    /** The last commit the command makes before it pushes, and what it takes of the tree. */
    committed: { stages: Staged | undefined; partial: boolean } | undefined
    /** Whether that commit holds the whole working tree, read once. */
    holdsTree: () => boolean
    /** `HEAD` and the branches a commit earlier in the command moves to the commit it makes. */
    advanced: Set<string>
    movedFirst: boolean
    /**
     * Branches the command makes from what's checked out before it pushes them, each with whether
     * it is forced over one that may exist.
     */
    created: Map<string, boolean>
}

/**
 * What one push source sends: `ok`; `every` (every branch, a wildcard, or what git's settings or
 * `xargs` pick); `unknown` (a branch named by a variable, or one that doesn't exist); `moved` (what's
 * checked out changes first); `partial` (the same command commits first, and the commit can leave
 * out part of the working tree); `unverified`; `dirty` (unverified, and the working tree holds more
 * than the pushed commit); or `other` (unverified, and not what's checked out).
 */
type SourceResult =
    | 'ok'
    | 'every'
    | 'unknown'
    | 'moved'
    | 'partial'
    | 'unverified'
    | 'dirty'
    | 'other'

export function checkCommand({
    root,
    command,
    cwd,
}: {
    /**
     * The checkout the guard lives in. It also guards the other worktrees of its repository that
     * have the guard; pushes from anywhere else are that folder's business.
     */
    root: string
    command: string
    /** The folder the command starts in. */
    cwd: string
}): PushVerdict {
    const notes: string[] = []
    const targets = findTargets(command, cwd)
    if (!targets.some((target) => target.kind === 'push' || target.kind === 'pr')) {
        return { decision: 'allow', notes }
    }

    const guarded = guardedCheckouts(root)
    const checkouts = new Map<string, Checkout>()
    const found = new Set<SourceResult>()
    let onlyPullRequests = true
    for (const target of targets) {
        const pushes = target.kind === 'push' || target.kind === 'pr'
        const what = target.kind === 'pr' ? 'pull request' : 'push'
        if (target.dir === null) {
            if (pushes) notes.push(`can't tell which folder a ${what} runs in, so it isn't checked`)
            continue
        }
        const path = checkoutOf(target.dir)
        // A folder that doesn't exist yet, such as one the same command makes.
        if (path === undefined) {
            if (pushes) {
                notes.push(
                    `can't find the checkout of ${target.dir}, so a ${what} there isn't checked`,
                )
            }
            continue
        }
        if (!guarded(path)) continue
        let checkout = checkouts.get(path)
        if (checkout === undefined) {
            checkout = openCheckout(path, notes)
            checkouts.set(path, checkout)
        }
        if (target.kind === 'commit') {
            checkout.committed = {
                stages: widest(checkout.staged, target.stages),
                partial: target.partial === true,
            }
            // The commit moves HEAD, and the branch checked out, to itself.
            checkout.advanced.add('HEAD')
            if (checkout.branch !== undefined) checkout.advanced.add(checkout.branch)
        } else if (target.kind === 'stage') {
            if (stagesWholeCheckout(target, path)) {
                checkout.staged = widest(checkout.staged, target.stages)
            }
        } else if (target.kind === 'move') checkout.movedFirst = true
        else if (target.kind === 'create') {
            for (const name of target.sources) {
                checkout.created.set(name, target.force === true)
                // Made after a commit in the same command, it holds that commit.
                if (checkout.committed !== undefined) checkout.advanced.add(name)
                if (target.switches) checkout.branch = name
            }
        } else {
            // With no refspec, git's push settings can send other branches than HEAD.
            const named =
                target.implicit && configuredPush(path, target.remote ?? null)
                    ? ['*']
                    : target.sources
            const sources = target.tags
                ? [...named, ...newTags(checkout)]
                : followsTags(path, target)
                  ? [...named, ...followedTags(checkout, named)]
                  : named
            for (const source of sources) {
                const result = checkSource(checkout, source, target.kind)
                if (result === 'ok') continue
                if (target.kind === 'push') onlyPullRequests = false
                found.add(result)
            }
        }
    }
    if (found.size === 0) return { decision: 'allow', notes }
    return { decision: 'deny', reason: denyReason(found, onlyPullRequests), notes }
}

/**
 * Which checkouts to guard: the one the guard lives in, and the other worktrees of its repository
 * that have the guard (a worktree on an older branch doesn't), such as one Claude Code entered
 * mid-session. Never another repository.
 */
function guardedCheckouts(root: string): (path: string) => boolean {
    const own = realPath(root)
    let shared: string | undefined
    return (path) => {
        if (path === own) return true
        shared ??= commonDir(root)
        return (
            shared !== undefined &&
            commonDir(path) === shared &&
            existsSync(join(path, '.agents/scripts/guard.ts'))
        )
    }
}

function openCheckout(root: string, notes: string[]): Checkout {
    let tree: string | undefined
    let defaultRef: { ref: string | undefined } | undefined
    let holdsTree: boolean | undefined
    const branch = git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
    const checkout: Checkout = {
        root,
        notes,
        head: resolveCommit(root, 'HEAD'),
        verified: readVerified(root)?.fingerprint,
        defaultRef: () => (defaultRef ??= { ref: defaultBranchRef(root) }).ref,
        tree: () => (tree ??= codeFingerprint(snapshot(root))),
        branch: branch.ok ? branch.stdout.trim() || undefined : undefined,
        staged: undefined,
        committed: undefined,
        holdsTree: () => (holdsTree ??= commitHoldsTree(checkout)),
        advanced: new Set(),
        movedFirst: false,
        created: new Map(),
    }
    return checkout
}

/** `all` takes in more than `tracked`. */
function widest(a: Staged | undefined, b: Staged | undefined): Staged | undefined {
    return a === 'all' || b === 'all' ? 'all' : (a ?? b)
}

/** Whether a `git add` takes the whole checkout: no paths, `:/`, or `.` from its top folder. */
function stagesWholeCheckout(target: PushTarget, root: string): boolean {
    if (target.sources.length === 0) return true
    return target.sources.some(
        (path) =>
            path === ':/' ||
            ((path === '.' || path === './') &&
                target.dir !== null &&
                realPath(target.dir) === root),
    )
}

/**
 * Whether the commit the command makes before it pushes holds the whole working tree, as verify
 * saw it: everything staged first, or nothing left out of what it takes. Files only CI reads don't
 * count, since verify records nothing for them.
 */
function commitHoldsTree(checkout: Checkout): boolean {
    const { root, committed } = checkout
    if (committed === undefined || committed.partial) return false
    // What `git add` staged before the commit, and what the commit itself takes.
    const { stages } = committed
    if (stages === 'all') return true
    const counts = (path: string) => classify(path) !== 'unchecked'
    const untracked = git(root, ['ls-files', '-z', '--others', '--exclude-standard'])
    if (!untracked.ok || untracked.stdout.split('\0').filter(Boolean).some(counts)) return false
    if (stages === 'tracked') return true
    const unstaged = git(root, ['diff', '--no-ext-diff', '--name-only', '-z'])
    return unstaged.ok && !unstaged.stdout.split('\0').filter(Boolean).some(counts)
}

/** The real path of the checkout a folder is in, or undefined when it isn't in one. */
function checkoutOf(dir: string): string | undefined {
    const toplevel = findRepoRoot(dir)
    return toplevel === undefined ? undefined : realPath(toplevel)
}

/** The repository a checkout belongs to, the same for all its worktrees. */
function commonDir(dir: string): string | undefined {
    const common = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
    return common.ok ? realPath(common.stdout.trim()) : undefined
}

function realPath(path: string): string | undefined {
    try {
        return realpathSync(path)
    } catch {
        return undefined
    }
}

function setting(root: string, key: string): string | undefined {
    const value = git(root, ['config', '--get', key])
    return value.ok ? value.stdout.trim() || undefined : undefined
}

/**
 * Whether a push with no refspec sends what git's settings pick rather than the current branch:
 * the push refspec or mirror setting of the remote it pushes to, or `push.default=matching`.
 */
function configuredPush(root: string, remote: string | null): boolean {
    if (setting(root, 'push.default') === 'matching') return true
    const current = git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
    const branch = current.ok ? current.stdout.trim() : undefined
    const target =
        remote ??
        (branch ? setting(root, `branch.${branch}.pushRemote`) : undefined) ??
        setting(root, 'remote.pushDefault') ??
        (branch ? setting(root, `branch.${branch}.remote`) : undefined) ??
        soleRemote(root) ??
        'origin'
    const mirror = git(root, ['config', '--type=bool', '--get', `remote.${target}.mirror`])
    return setting(root, `remote.${target}.push`) !== undefined || mirror.stdout.trim() === 'true'
}

/**
 * The tags `git push --tags` sends that may hold new code: every tag the default branch doesn't
 * already contain, or every tag when there is no default branch.
 */
function newTags(checkout: Checkout): string[] {
    const ref = checkout.defaultRef()
    const args = ['for-each-ref', '--format=%(refname)']
    if (ref !== undefined) args.push(`--no-merged=${ref}`)
    return git(checkout.root, [...args, 'refs/tags'])
        .stdout.split('\n')
        .filter(Boolean)
}

/**
 * Whether a push also sends the annotated tags its commits reach, as the command or
 * `push.followTags` says.
 */
function followsTags(root: string, target: PushTarget): boolean {
    if (target.followTags !== undefined) return target.followTags
    const value = git(root, ['config', '--type=bool', '--get', 'push.followTags'])
    return value.stdout.trim() === 'true'
}

/**
 * The tags `--follow-tags` may send with `sources`: the annotated tags the pushed commits reach that
 * the default branch doesn't already contain. Every such tag when a source can't be resolved.
 */
function followedTags(checkout: Checkout, sources: string[]): string[] {
    const ref = checkout.defaultRef()
    const args = ['for-each-ref', '--format=%(objecttype) %(refname)']
    if (ref !== undefined) args.push(`--no-merged=${ref}`)
    // A branch the command makes holds what's checked out by the time the push runs.
    const commits = sources.map((source) =>
        checkout.created.has(branchName(source))
            ? checkout.head
            : resolveCommit(checkout.root, source),
    )
    if (commits.every((commit) => commit !== undefined)) {
        for (const commit of commits) args.push(`--merged=${commit}`)
    }
    return git(checkout.root, [...args, 'refs/tags'])
        .stdout.split('\n')
        .filter((line) => line.startsWith('tag '))
        .map((line) => line.slice('tag '.length))
}

/** The branch a source names in full (`refs/heads/x`) or in part (`heads/x`), as git reads them. */
function branchName(source: string): string {
    return source.replace(/^(refs\/)?heads\//, '')
}

/**
 * Whether a commit earlier in the same command moves `source`: HEAD, the branch checked out when it
 * commits, or a branch the command makes after it. A tag, a commit or another branch stays where it
 * was.
 */
function advancedByCommit(checkout: Checkout, source: string): boolean {
    if (source === 'HEAD' || source === '@') return checkout.advanced.has('HEAD')
    if (checkout.created.has(branchName(source))) return checkout.advanced.has(branchName(source))
    const full = git(checkout.root, ['rev-parse', '--symbolic-full-name', source])
    const name = full.ok ? full.stdout.trim() : ''
    return name.startsWith('refs/heads/') && checkout.advanced.has(name.slice('refs/heads/'.length))
}

/** The only remote, which git pushes to when nothing else names one. */
function soleRemote(root: string): string | undefined {
    const remotes = git(root, ['remote']).stdout.split('\n').filter(Boolean)
    return remotes.length === 1 ? remotes[0] : undefined
}

function checkSource(checkout: Checkout, source: string, kind: 'push' | 'pr'): SourceResult {
    if (source.includes('*')) return 'every'
    // HEAD, or the branch a rebase or pull moves, holds something else by the time the push runs.
    if (checkout.movedFirst) return 'moved'
    // A shell variable or command substitution, whose value the command doesn't show
    if (source.includes('$')) return 'unknown'

    const { root, notes, head } = checkout
    // A branch forced over an existing one (`git switch -C`) holds what's checked out by the time
    // the push runs. One made without force fails if it exists, so the push sends the old one.
    const created = checkout.created.get(branchName(source))
    let commit = created === true ? head : resolveCommit(root, source)
    if (commit === undefined) {
        if (created !== undefined) commit = head
        else if (kind === 'pr') {
            // It may exist only on the remote, which no local check can vouch for either way.
            notes.push(`can't find ${source}, so the pull request isn't checked`)
            return 'ok'
        } else return 'unknown'
        if (commit === undefined) return 'ok'
    }
    // The same command commits first and moves what's pushed, so it pushes the working tree, when
    // the commit takes all of it. A tag or another branch at the same commit stays where it was.
    const fromTree =
        checkout.committed !== undefined && commit === head && advancedByCommit(checkout, source)
    // From the pushed commit: the branch checked out may have left main somewhere else.
    const base = branchBase(root, checkout.defaultRef(), fromTree ? 'HEAD' : commit)
    if (fromTree && !checkout.holdsTree()) {
        return onlyUncheckedChanges(root, base, undefined) ? 'ok' : 'partial'
    }
    const fingerprint = fromTree ? checkout.tree() : codeFingerprint(snapshotCommit(root, commit))
    if (fingerprint === checkout.verified) return 'ok'
    if (onlyUncheckedChanges(root, base, fromTree ? undefined : commit)) return 'ok'

    if (!fromTree && commit !== head) return 'other'
    if (!fromTree && checkout.tree() !== fingerprint) return 'dirty'
    return 'unverified'
}

/**
 * Whether everything a commit, or the working tree when `commit` is undefined, changes since the
 * default branch is something verify records nothing for: docs, or files only CI reads. Verify
 * checks the whole tree, and records a pass, when there is no default branch to compare with, so
 * then nothing is exempt.
 */
function onlyUncheckedChanges(
    root: string,
    base: string | undefined,
    commit: string | undefined,
): boolean {
    if (base === undefined) return false
    if (commit === undefined)
        return !changedSince(root, base).some((path) => needsChecks(root, path))
    return !commitChanges(root, base, commit).some(({ path, deleted }) =>
        changeNeedsChecks(path, deleted),
    )
}

function denyReason(found: Set<SourceResult>, onlyPullRequests: boolean): string {
    const paragraphs: string[] = []
    if (found.has('every') && onlyPullRequests) {
        paragraphs.push(
            "This opens a pull request for a branch the command doesn't name, a wildcard or what " +
                "`xargs` adds, so the push check can't tell which. Name the branch instead: `gh pr " +
                'create --head <branch>`.',
        )
    } else if (found.has('every')) {
        paragraphs.push(
            "This pushes every branch at once, the ones a wildcard matches, what git's push " +
                'settings pick (`remote.<name>.push`, or `push.default=matching`), or what `xargs` ' +
                "adds, so the push check can't tell what it sends. Name each branch instead: `git " +
                'push origin <branch>`.',
        )
    }
    if (found.has('unknown') && onlyPullRequests) {
        paragraphs.push(
            'This opens a pull request for a branch named by a shell variable, so the push check ' +
                "can't tell which. Name the branch instead: `gh pr create --head <branch>`.",
        )
    } else if (found.has('unknown')) {
        paragraphs.push(
            'This pushes a branch named by a shell variable, or one that does not exist, so the ' +
                "push check can't tell what it sends. Name each branch instead: `git push origin " +
                '<branch>`.',
        )
    }
    if (found.has('moved')) {
        paragraphs.push(
            'This changes what is checked out, or moves a branch (`git switch`, `git checkout`, ' +
                '`git rebase`, `git pull`, `git branch -f` and the like), before it pushes, so the ' +
                "push check can't tell what it will send. Run the push as a command of its own.",
        )
    }
    if (found.has('partial')) {
        paragraphs.push(
            'This commits and pushes in one command, but the commit can leave out changes verify ' +
                "checked: files git doesn't track yet, changes the command doesn't stage, or the " +
                'paths it leaves out. Stage everything in the same command (`git add -A && git ' +
                'commit …`), or commit first and run the push as a command of its own.',
        )
    }
    if (found.has('unverified') || found.has('dirty') || found.has('other')) {
        const lines = [
            onlyPullRequests
                ? "This opens a pull request for code that `npm run verify` hasn't passed."
                : "This pushes code that `npm run verify` hasn't passed.",
            '',
            found.has('other')
                ? 'Verify checks the working tree and keeps one record per checkout, so it can only ' +
                  'vouch for what you have checked out. Check out each branch, or the commit a tag ' +
                  'names, run `npm run verify` there, and push it on its own.'
                : 'Run `npm run verify` and fix what fails, then run this command again.',
        ]
        if (found.has('dirty')) {
            lines.push(
                "Verify checks the working tree, which holds changes your last commit doesn't. " +
                    'Commit what belongs in it, and stash the rest with `git stash -u` before you ' +
                    'run verify. `git stash pop` brings them back afterwards.',
            )
        }
        paragraphs.push(lines.join('\n'))
    }
    return [
        paragraphs.join('\n\n'),
        'If it has to be pushed this way anyway, ask the person you are working with to push it ' +
            'themselves.',
        'Details: docs/agents.md',
    ].join('\n')
}
