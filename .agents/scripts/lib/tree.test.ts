import { chmodSync, rmSync, symlinkSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { git } from './git.ts'
import { createTempRepo, REPO_ROOT, type TempRepo } from './test-repo.ts'
import {
    changedCodePaths,
    changedPaths,
    changedSince,
    classify,
    codeFingerprint,
    commitChanges,
    snapshot,
    snapshotCommit,
} from './tree.ts'

let repo: TempRepo

beforeEach(() => {
    repo = createTempRepo()
    repo.write('src/a.ts', 'export const a = 1\n')
    repo.write('README.md', 'readme\n')
    repo.write('CHANGELOG.md', '# Changelog\n')
    repo.write('.nvmrc', '24\n')
    repo.write('.gitignore', 'ignored/\n')
    repo.git(['add', '.'])
    repo.git(['commit', '--quiet', '-m', 'initial'])
})

afterEach(() => repo.cleanup())

const objectCount = () => repo.git(['count-objects', '-v']).stdout

describe('snapshot', () => {
    it('sees an edit that keeps the size and modification time', () => {
        const before = codeFingerprint(snapshot(repo.dir))
        const file = join(repo.dir, 'src/a.ts')
        repo.write('src/a.ts', 'export const a = 2\n')
        utimesSync(file, new Date(2020, 0, 1), new Date(2020, 0, 1))
        const middle = codeFingerprint(snapshot(repo.dir))
        repo.write('src/a.ts', 'export const a = 3\n')
        utimesSync(file, new Date(2020, 0, 1), new Date(2020, 0, 1))
        const after = codeFingerprint(snapshot(repo.dir))
        expect(new Set([before, middle, after]).size).toBe(3)
    })

    it('includes untracked files and leaves out ignored ones', () => {
        const before = snapshot(repo.dir)
        repo.write('src/new.ts', 'new\n')
        repo.write('ignored/build.js', 'built\n')
        expect(changedPaths(before, snapshot(repo.dir))).toEqual(['src/new.ts'])
    })

    it('sees a deleted tracked file', () => {
        const before = snapshot(repo.dir)
        rmSync(join(repo.dir, 'src/a.ts'))
        expect(changedPaths(before, snapshot(repo.dir))).toEqual(['src/a.ts'])
    })

    it('is the same before and after a deletion is staged', () => {
        rmSync(join(repo.dir, 'src/a.ts'))
        const unstaged = snapshot(repo.dir)
        repo.git(['add', '--all'])
        expect(snapshot(repo.dir)).toEqual(unstaged)
    })

    // Root reads any file, and chmod cannot make a file unreadable on Windows.
    it.skipIf(process.getuid?.() === 0 || process.platform === 'win32')(
        'fails on a file it cannot read, rather than leaving it out',
        () => {
            repo.write('src/secret.ts', 'export const s = 1\n')
            chmodSync(join(repo.dir, 'src/secret.ts'), 0o000)
            expect(() => snapshot(repo.dir)).toThrow(/EACCES/)
        },
    )

    it('sees an executable bit change', () => {
        const before = codeFingerprint(snapshot(repo.dir))
        repo.run('chmod', ['+x', 'src/a.ts'])
        expect(codeFingerprint(snapshot(repo.dir))).not.toBe(before)
    })

    it('writes nothing to the object store', () => {
        repo.write('src/new.ts', 'new\n')
        const before = objectCount()
        snapshot(repo.dir)
        expect(objectCount()).toBe(before)
    })
})

describe('snapshotCommit', () => {
    it('describes a commit exactly as the identical working tree', () => {
        repo.write('run.sh', '#!/bin/sh\n')
        repo.run('chmod', ['+x', 'run.sh'])
        symlinkSync('src/a.ts', join(repo.dir, 'link'))
        repo.write('src/naïve name.ts', 'export const n = 1\n')
        repo.git(['add', '.'])
        repo.git(['commit', '--quiet', '-m', 'more kinds of file'])
        expect(snapshotCommit(repo.dir, 'HEAD')).toEqual(snapshot(repo.dir))
        expect(snapshot(repo.dir)['run.sh']).toMatch(/^x:/)
        expect(snapshot(repo.dir).link).toMatch(/^link:/)
    })

    it('differs from a working tree that holds more, or other content', () => {
        const committed = codeFingerprint(snapshotCommit(repo.dir, 'HEAD'))
        expect(codeFingerprint(snapshot(repo.dir))).toBe(committed)
        repo.write('src/new.ts', 'new\n')
        expect(codeFingerprint(snapshot(repo.dir))).not.toBe(committed)
        rmSync(join(repo.dir, 'src/new.ts'))
        repo.write('src/a.ts', 'export const a = 2\n')
        expect(codeFingerprint(snapshot(repo.dir))).not.toBe(committed)
    })
})

describe('commitChanges', () => {
    it('lists what a commit changes since a base, deletions marked', () => {
        const base = repo.git(['rev-parse', 'HEAD']).stdout.trim()
        repo.write('src/b.ts', 'b\n')
        repo.git(['rm', '--quiet', 'CHANGELOG.md'])
        repo.git(['add', '.'])
        repo.git(['commit', '--quiet', '-m', 'c'])
        repo.write('src/uncommitted.ts', 'not in the commit\n')
        expect(commitChanges(repo.dir, base, 'HEAD')).toEqual([
            { path: 'CHANGELOG.md', deleted: true },
            { path: 'src/b.ts', deleted: false },
        ])
    })
})

describe('codeFingerprint', () => {
    it('ignores edits to the changelog, LICENSE and .nvmrc, which no local check reads', () => {
        repo.write('LICENSE', 'MIT\n')
        const before = codeFingerprint(snapshot(repo.dir))
        repo.write('CHANGELOG.md', '# Changelog\n\n## 1.0.0\n')
        repo.write('LICENSE', 'MIT, changed\n')
        repo.write('.nvmrc', '26\n')
        expect(codeFingerprint(snapshot(repo.dir))).toBe(before)
    })

    it.each([
        ['README.md', 'changed\n'],
        ['docs/guide.md', 'new\n'],
        ['.github/PULL_REQUEST_TEMPLATE.md', 'new\n'],
        ['.github/renovate.json', '{}\n'],
        ['.github/workflows/release.yml', 'on: push\n'],
        ['src/prompt.md', 'markdown the server could load\n'],
    ])('changes when %s changes, since a local check reads it', (path, content) => {
        const before = codeFingerprint(snapshot(repo.dir))
        repo.write(path, content)
        expect(codeFingerprint(snapshot(repo.dir))).not.toBe(before)
    })

    it('changes when the changelog is deleted or added, since the agent docs may name it', () => {
        const before = codeFingerprint(snapshot(repo.dir))
        rmSync(join(repo.dir, 'CHANGELOG.md'))
        expect(codeFingerprint(snapshot(repo.dir))).not.toBe(before)
        repo.write('CHANGELOG.md', 'back again\n')
        expect(codeFingerprint(snapshot(repo.dir))).toBe(before)
    })
})

describe('changedCodePaths', () => {
    it('counts a deleted or added doc, but not an edited one', () => {
        const before = snapshot(repo.dir)
        repo.write('CHANGELOG.md', 'edited\n')
        expect(changedCodePaths(before, snapshot(repo.dir))).toEqual([])
        rmSync(join(repo.dir, 'CHANGELOG.md'))
        const deleted = snapshot(repo.dir)
        expect(changedCodePaths(before, deleted)).toEqual(['CHANGELOG.md'])
        repo.write('CHANGELOG.md', 'back\n')
        expect(changedCodePaths(deleted, snapshot(repo.dir))).toEqual(['CHANGELOG.md'])
    })
})

describe('classify', () => {
    it.each([
        ['CHANGELOG.md', 'docs'],
        ['LICENSE', 'docs'],
        ['.nvmrc', 'unchecked'],
        ['README.md', 'code'],
        ['docs/dev-setup.md', 'code'],
        ['CONTRIBUTING.md', 'code'],
        ['CODEBASE.md', 'code'],
        ['AGENTS.md', 'code'],
        ['docs/agents.md', 'code'],
        ['.agents/skills/verify/SKILL.md', 'code'],
        ['.github/PULL_REQUEST_TEMPLATE.md', 'code'],
        ['.github/workflows/ci.yml', 'code'],
        ['.github/workflows/release.yml', 'code'],
        ['.github/renovate.json', 'code'],
        ['src/mcp-server.ts', 'code'],
        ['src/notes.md', 'code'],
        ['package-lock.json', 'code'],
        ['.agents/scripts/verify.ts', 'code'],
        ['lefthook.yml', 'code'],
    ])('%s is %s', (path, kind) => {
        expect(classify(path)).toBe(kind)
    })

    // CI's format check reads Markdown, JSON and YAML too, so only a file oxfmt leaves alone may be
    // left out of verify. Each one the checkout holds is made badly formatted in a throwaway repo
    // with this repository's .oxfmtrc.json, and oxfmt must still pass; README.md, which it reads,
    // shows the same content would fail.
    it('leaves out of the checks only files the format check leaves alone', () => {
        const tracked = git(REPO_ROOT, ['ls-files']).stdout.split('\n').filter(Boolean)
        const leftOut = tracked.filter((path) => classify(path) !== 'code')
        expect(leftOut).toEqual(expect.arrayContaining(['CHANGELOG.md', 'LICENSE', '.nvmrc']))
        repo.copyFromCheckout('.oxfmtrc.json')
        const unformatted = '#   Not   formatted\n\n\n\n*   item\n'
        for (const path of leftOut) repo.write(path, unformatted)
        const oxfmt = () =>
            repo.run(join(REPO_ROOT, 'node_modules/.bin/oxfmt'), ['--check'], { cwd: repo.dir })

        const skipped = oxfmt()
        expect(skipped.status, skipped.stdout).toBe(0)
        repo.write('README.md', unformatted)
        const read = oxfmt()
        expect(read.status).not.toBe(0)
        expect(read.stdout).toContain('README.md')
    })
})

describe('changedSince', () => {
    it('lists committed, staged, unstaged and untracked changes', () => {
        const base = repo.git(['rev-parse', 'HEAD']).stdout.trim()
        repo.git(['switch', '--quiet', '-c', 'feature'])
        repo.write('src/committed.ts', '1\n')
        repo.git(['add', '.'])
        repo.git(['commit', '--quiet', '-m', 'c'])
        repo.write('src/staged.ts', '1\n')
        repo.git(['add', 'src/staged.ts'])
        repo.write('src/a.ts', 'unstaged\n')
        repo.write('src/untracked.ts', '1\n')
        expect(changedSince(repo.dir, base)).toEqual([
            'src/a.ts',
            'src/committed.ts',
            'src/staged.ts',
            'src/untracked.ts',
        ])
    })
})
