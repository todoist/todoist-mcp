// The changes that passed `npm run verify`, recorded by patch rather than by tree, so the push
// check can let a branch through when it holds the same changes on a newer default branch: a
// rebase that only moved the base. Without this, every rebase of a verified branch, and of every
// branch of a stack, would need verify again before it could push.

import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from './git.ts'
import { readJson, stateDir, writeJson } from './state.ts'

/** A branch's changes that passed verify, and where the branch left the default branch then. */
export type PassedPatch = { patchId: string; base: string; at: string }

/** Enough for every branch of a long stack, and a few rebases of each. */
const MAX_RECORDED = 50

function patchesPath(root: string): string {
    return join(stateDir(root), 'verified-patches.json')
}

export function readPassedPatches(root: string): PassedPatch[] {
    return readJson<{ patches?: PassedPatch[] }>(patchesPath(root))?.patches ?? []
}

/**
 * An id for everything a commit changes since `base`, the same wherever the changes sit: git's
 * patch id ignores line numbers and file order, but not the three lines around each change, which
 * the diff sets itself whatever `diff.context` or `GIT_DIFF_OPTS` say, as it sets the algorithm and
 * the indent heuristic. So a rebase that changed nothing near the branch's changes keeps the id, and
 * one that did, by a conflict or by new code next to them, doesn't. `--verbatim` keeps whitespace, which the default strips, so a change inside a string or
 * to formatting changes the id. Binary files count by their full blob ids. A git older than 2.39
 * has no `--verbatim`, so every rebase there needs verify again.
 */
export function branchPatchId(root: string, base: string, commit: string): string | undefined {
    return patchIdOf(root, [base, commit])
}

/** The patch id of `git diff <compared>`, with the diff settings `branchPatchId` describes. */
function patchIdOf(
    root: string,
    compared: string[],
    env?: Record<string, string>,
): string | undefined {
    const diff = git(
        root,
        [
            'diff',
            '--unified=3',
            '--diff-algorithm=myers',
            '--indent-heuristic',
            '--src-prefix=a/',
            '--dst-prefix=b/',
            '--full-index',
            '--no-color',
            '--no-ext-diff',
            '--no-textconv',
            '--no-renames',
            ...compared,
        ],
        { env },
    )
    if (!diff.ok || !diff.stdout.trim()) return undefined
    const id = git(root, ['patch-id', '--verbatim'], { input: diff.stdout })
    return id.ok ? id.stdout.split(' ')[0] || undefined : undefined
}

/**
 * The patch ids of what could be committed next, from `base`: HEAD's changes, what's staged, and
 * the whole working tree, untracked files included. The working tree is read through a copy of the
 * index with everything added, so the real index is left as it is.
 */
function pendingPatchIds(root: string, base: string): Set<string> {
    const ids = [branchPatchId(root, base, 'HEAD'), patchIdOf(root, ['--cached', base])]
    const scratch = mkdtempSync(join(tmpdir(), 'agent-index-'))
    try {
        const index = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])
        const copy = join(scratch, 'index')
        const real = index.stdout.trim()
        if (index.ok && existsSync(real)) copyFileSync(real, copy)
        const env = { GIT_INDEX_FILE: copy }
        if (git(root, ['add', '--all'], { env }).ok)
            ids.push(patchIdOf(root, ['--cached', base], env))
    } finally {
        rmSync(scratch, { recursive: true, force: true })
    }
    return new Set(ids.filter((id) => id !== undefined))
}

/**
 * Records that the changes `commit` makes since `base` passed verify. Best effort: a record that
 * can't be written only means the next rebase needs verify again.
 */
export function recordPassedPatch(root: string, base: string, commit: string): void {
    try {
        const patchId = branchPatchId(root, base, commit)
        if (patchId === undefined) return
        const others = readPassedPatches(root).filter(
            (patch) => patch.patchId !== patchId || patch.base !== base,
        )
        const patches = [...others, { patchId, base, at: new Date().toISOString() }]
        writeJson(patchesPath(root), { patches: patches.slice(-MAX_RECORDED) })
    } catch {
        // Nothing to undo: the push or the verify run it follows already succeeded.
    }
}

/**
 * Forgets that the changes verify is about to check passed, whatever base they passed on, so a run
 * that doesn't pass can't leave them counted as passed: HEAD's changes since `base`, and the ones a
 * commit could hold next, staged or not, as after `git reset HEAD~1`. When the record can't be
 * rewritten it is deleted, and when it can't be deleted either, this throws.
 */
export function forgetPassedChanges(root: string, base: string): void {
    const patches = readPassedPatches(root)
    if (patches.length === 0) return
    const pending = pendingPatchIds(root, base)
    const kept = patches.filter((patch) => !pending.has(patch.patchId))
    if (kept.length === patches.length) return
    try {
        writeJson(patchesPath(root), { patches: kept })
    } catch {
        // Losing the other branches' records only means they need verify again after a rebase.
        try {
            rmSync(patchesPath(root), { force: true })
        } catch (error) {
            throw new Error(
                `can't remove ${patchesPath(root)}, so a pass recorded there would outlive this run: ${(error as Error).message}`,
            )
        }
    }
}

/**
 * Whether `commit` holds changes that passed verify, from `base` or from an earlier point of the
 * default branch that `base` has moved on from.
 */
export function hasPassedPatch(root: string, base: string, commit: string): boolean {
    const patches = readPassedPatches(root)
    if (patches.length === 0) return false
    const patchId = branchPatchId(root, base, commit)
    if (patchId === undefined) return false
    return patches.some(
        (patch) =>
            patch.patchId === patchId &&
            git(root, ['merge-base', '--is-ancestor', patch.base, base]).ok,
    )
}
