// Fingerprints of the working tree, or of a commit, by file content. Hashing content (not mtimes)
// catches edits made in the same second, and hashing in-process writes nothing to git's object
// store. Files are hashed the way git hashes a blob, so a commit can be described from `git
// ls-tree` without reading its files, and a commit that holds exactly a tree verify passed has the
// same fingerprint.

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'
import { git } from './git.ts'

/** Path → mode and content hash for every tracked and untracked, non-ignored file. */
export type Snapshot = Record<string, string>

export function snapshot(root: string): Snapshot {
    const listed = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    if (!listed.ok) throw new Error(`git ls-files failed: ${listed.stderr.trim()}`)
    const files: Snapshot = {}
    for (const path of new Set(listed.stdout.split('\0').filter(Boolean))) {
        const hash = hashPath(join(root, path))
        // A tracked file deleted from disk is left out, exactly as it is once the deletion is
        // staged, so staging a deletion doesn't change the snapshot.
        if (hash !== undefined) files[path] = hash
    }
    return files
}

function hashPath(path: string): string | undefined {
    try {
        const stat = lstatSync(path)
        if (stat.isSymbolicLink()) return `link:${blobId(Buffer.from(readlinkSync(path)))}`
        if (stat.isDirectory()) return 'dir' // a nested repository, listed but not entered
        return `${stat.mode & 0o111 ? 'x' : '-'}:${blobId(readFileSync(path))}`
    } catch (error) {
        // Gone, or went away while being read. Any other failure, such as a file it may not read,
        // must not leave the file out of a fingerprint that claims to cover the tree.
        const code = (error as NodeJS.ErrnoException)?.code
        if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
        throw error
    }
}

/** The id git gives a blob with this content. */
function blobId(content: Buffer): string {
    return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex')
}

/**
 * A commit's files, described the way `snapshot` describes the working tree, from git's own blob
 * ids: a commit that holds exactly the working tree gets the same snapshot.
 */
export function snapshotCommit(root: string, commit: string): Snapshot {
    const listed = git(root, ['ls-tree', '-r', '-z', commit])
    if (!listed.ok) throw new Error(`git ls-tree failed: ${listed.stderr.trim()}`)
    const files: Snapshot = {}
    for (const entry of listed.stdout.split('\0')) {
        const match = /^(\d+) \w+ ([0-9a-f]+)\t(.*)$/s.exec(entry)
        if (!match) continue
        const [, mode = '', id = '', path = ''] = match
        if (mode === '160000') files[path] = 'dir'
        else if (mode === '120000') files[path] = `link:${id}`
        else files[path] = `${mode === '100755' ? 'x' : '-'}:${id}`
    }
    return files
}

/** The kind of file, as far as local checks are concerned. */
export type FileKind = 'docs' | 'unchecked' | 'code'

/**
 * - docs: prose no local check reads. `npm run format:check` (oxfmt) reads Markdown, JSON and YAML
 *   as well as code, so that is only what it leaves alone: CHANGELOG.md, which `.oxfmtrc.json`
 *   ignores and the release writes, and LICENSE.
 * - unchecked: files only CI reads. `.nvmrc` picks the release workflow's Node version; verify runs
 *   on yours, and the test workflow on its own list.
 * - code: everything else, including every other Markdown file, the workflows, lockfiles and tests.
 *
 * tree.test.ts keeps this honest: oxfmt has to leave alone every file in the checkout classified as
 * docs or unchecked.
 */
export function classify(path: string): FileKind {
    if (path === 'CHANGELOG.md' || path === 'LICENSE') return 'docs'
    if (path === '.nvmrc') return 'unchecked'
    return 'code'
}

const present = (files: Snapshot, path: string) => files[path] !== undefined

/**
 * Hash of every file local checks read, so editing docs, or files only CI reads, after a pass
 * keeps it valid. Docs count by name: the agent docs may name one, so adding, renaming or deleting
 * a doc means checking again.
 */
export function codeFingerprint(files: Snapshot): string {
    const hash = createHash('sha256')
    for (const path of Object.keys(files).sort()) {
        const kind = classify(path)
        if (kind === 'code') hash.update(`${path}\0${files[path]}\n`)
        else if (kind === 'docs' && present(files, path)) hash.update(`${path}\0doc\n`)
    }
    return hash.digest('hex')
}

/**
 * Changed files local checks read: what `codeFingerprint` sees change, code by content and docs by
 * whether they are there at all.
 */
export function changedCodePaths(before: Snapshot, after: Snapshot): string[] {
    return changedPaths(before, after).filter(
        (path) =>
            classify(path) === 'code' ||
            (classify(path) === 'docs' && present(before, path) !== present(after, path)),
    )
}

export function changedPaths(before: Snapshot, after: Snapshot): string[] {
    const paths = new Set([...Object.keys(before), ...Object.keys(after)])
    return [...paths].filter((path) => before[path] !== after[path]).sort()
}

/**
 * Whether a file that differs from the default branch needs the checks: code, or a doc that was
 * deleted or renamed, since the agent docs may name it.
 */
export function needsChecks(root: string, path: string): boolean {
    return changeNeedsChecks(path, !existsSync(join(root, path)))
}

/** `needsChecks` for a change whose deletion is already known, such as one in a commit. */
export function changeNeedsChecks(path: string, deleted: boolean): boolean {
    const kind = classify(path)
    return kind === 'code' || (kind === 'docs' && deleted)
}

/**
 * Files a commit changes since `base`, and whether each was deleted. Renames count as a deletion
 * and an addition.
 */
export function commitChanges(
    root: string,
    base: string,
    commit: string,
): { path: string; deleted: boolean }[] {
    const diff = git(root, ['diff', '--name-status', '--no-renames', '-z', base, commit])
    if (!diff.ok) throw new Error(`git diff failed: ${diff.stderr.trim()}`)
    const fields = diff.stdout.split('\0')
    const changes: { path: string; deleted: boolean }[] = []
    for (let i = 0; i + 1 < fields.length; i += 2) {
        changes.push({ path: fields[i + 1] as string, deleted: fields[i] === 'D' })
    }
    return changes
}

/** Files that differ from `base`: committed, staged, unstaged and untracked. */
export function changedSince(root: string, base: string): string[] {
    const diff = git(root, ['diff', '--name-only', '-z', '--no-renames', base])
    if (!diff.ok) throw new Error(`git diff failed: ${diff.stderr.trim()}`)
    const untracked = git(root, ['ls-files', '-z', '--others', '--exclude-standard'])
    const paths = [...diff.stdout.split('\0'), ...untracked.stdout.split('\0')].filter(Boolean)
    return [...new Set(paths)].sort()
}
