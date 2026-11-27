import { rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { checkCommand, type PushVerdict } from './push-check.ts'
import { createTempRepo, markVerified as markDirVerified, type TempRepo } from './test-repo.ts'

let repo: TempRepo

function check(command: string, cwd = repo.dir): PushVerdict {
    return checkCommand({ root: repo.dir, command, cwd })
}

/** The reason the check stops `command`, or undefined when it lets it run. */
function denial(command: string, cwd?: string): string | undefined {
    const verdict = check(command, cwd)
    return verdict.decision === 'deny' ? verdict.reason : undefined
}

const markVerified = () => markDirVerified(repo.dir)
const commitOnBranch = (branch: string, path: string, content?: string) =>
    repo.commitOnBranch(branch, path, content)

/** A linked worktree of the test repo on a new branch, beside it, removed when the test ends. */
function addWorktree(name: string): string {
    const tree = join(dirname(repo.dir), `${repo.dir.split('/').pop()}-${name}`)
    repo.git(['worktree', 'add', '--quiet', '-b', name, tree])
    // Outside repo.dir, so its cleanup doesn't reach it, even when an assertion fails first.
    onTestFinished(() => rmSync(tree, { recursive: true, force: true }))
    return tree
}

const config = (...args: string[]) => repo.git(['config', ...args])

beforeEach(() => {
    // The check reads git's push settings, so the person's own git config must not reach it.
    vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null')
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
    repo = createTempRepo()
    repo.write('.gitignore', '.tmp/\n')
    repo.write('src/a.ts', 'export const a = 1\n')
    repo.write('README.md', 'readme\n')
    repo.write('CHANGELOG.md', '# Changelog\n')
    repo.write('.nvmrc', '24\n')
    repo.git(['add', '.'])
    repo.git(['commit', '--quiet', '-m', 'initial'])
    repo.addOrigin()
})

afterEach(() => {
    repo.cleanup()
    vi.unstubAllEnvs()
})

describe('pushes it checks', () => {
    it('stops a branch that deletes a doc, since the agent docs may name it', () => {
        repo.git(['switch', '--quiet', '-c', 'no-changelog'])
        repo.git(['rm', '--quiet', 'CHANGELOG.md'])
        repo.git(['commit', '--quiet', '-m', 'remove the changelog'])
        expect(denial('git push')).toContain('npm run verify')
        // The same, committed in the command that pushes
        repo.git(['reset', '--quiet', '--hard', 'main'])
        rmSync(join(repo.dir, 'CHANGELOG.md'))
        expect(denial('git commit -am "remove it" && git push')).toContain('npm run verify')
    })

    it('stops a branch that changes only the README, since the format check reads it', () => {
        commitOnBranch('readme', 'README.md', 'a better readme\n')
        expect(denial('git push')).toContain('npm run verify')
    })

    it('stops a push of code verify has not passed, and allows it once it has', () => {
        commitOnBranch('feature', 'src/b.ts')
        const reason = denial('git push -u origin HEAD')
        expect(reason).toContain("This pushes code that `npm run verify` hasn't passed.")
        expect(reason).toContain('Run `npm run verify` and fix what fails')
        expect(reason).not.toContain('git stash')

        markVerified()
        expect(check('git push -u origin HEAD')).toEqual({ decision: 'allow', notes: [] })
    })

    it('stops a push of a commit that holds less than the tree verify passed', () => {
        commitOnBranch('partial', 'src/committed.ts')
        repo.write('src/uncommitted.ts', 'export const y = 1\n')
        markVerified()
        expect(denial('git push')).toMatch(
            /holds changes your last commit doesn't[\s\S]*git stash -u/,
        )
    })

    it('checks the working tree when the same command commits before it pushes', () => {
        repo.git(['switch', '--quiet', '-c', 'together'])
        repo.write('src/together.ts', 'export const t = 1\n')
        const command = 'git add -A && git commit -m "add together" && git push'
        expect(denial(command)).toContain('npm run verify')
        markVerified()
        expect(check(command).decision).toBe('allow')
    })

    it('stops a commit and push in one command when the commit can leave out what verify saw', () => {
        repo.git(['switch', '--quiet', '-c', 'together'])
        repo.write('src/a.ts', 'export const a = 2\n')
        repo.write('src/new.ts', 'export const n = 1\n')
        markVerified()
        // `-a` leaves out the untracked file; a plain commit, the unstaged edit too.
        for (const command of [
            'git commit -am "x" && git push',
            'git commit -m "x" && git push',
            'git add src/a.ts && git commit -m x && git push',
            'git add -A && git commit -m x src/a.ts && git push',
            'git add -A && git commit -p && git push',
            'git commit -m x && git add -A && git push',
            'git commit -am x && gh pr create --fill',
        ]) {
            expect(denial(command), command).toContain('Stage everything in the same command')
        }
        // Staged whole first, the commit holds what verify saw.
        for (const command of [
            'git add -A && git commit -m x && git push',
            'git add . && git commit -m x && git push',
            'cd src && git add --all && git commit -qm x && git push',
            'git add :/ && git commit -m x && git push',
        ]) {
            expect(check(command).decision, command).toBe('allow')
        }
        // With nothing untracked, `-a` takes every change, and a plain commit what's staged.
        rmSync(join(repo.dir, 'src/new.ts'))
        markVerified()
        expect(check('git commit -am x && git push').decision).toBe('allow')
        expect(denial('git commit -m x && git push')).toContain('Stage everything')
        repo.git(['add', 'src/a.ts'])
        expect(check('git commit -m x && git push').decision).toBe('allow')
    })

    it('checks only what the commit moves against the working tree, though it commits first', () => {
        commitOnBranch('tagged', 'src/tagged.ts')
        repo.git(['tag', 'v1'])
        repo.git(['branch', 'beside'])
        repo.write('src/tagged.ts', 'export const fixed = 1\n')
        markVerified()
        // The commit moves the branch, not the tag or another branch, so git sends the old,
        // unverified commit for those.
        for (const command of [
            'git commit -qam fix && git push origin v1',
            'git commit -qam fix && git push origin beside',
            'git branch made && git commit -qam fix && git push origin made',
            'git switch -c moved && git commit -qam fix && git push origin tagged',
        ]) {
            expect(denial(command), command).toContain('npm run verify')
        }
        for (const command of [
            'git commit -qam fix && git push origin tagged',
            'git commit -qam fix && git push origin refs/heads/tagged',
            'git commit -qam fix && git push origin @',
            'git commit -qam fix && git push origin HEAD:refs/heads/elsewhere',
            'git commit -qam fix && git branch after && git push origin after',
            'git switch -c moved && git commit -qam fix && git push -u origin moved',
        ]) {
            expect(check(command).decision, command).toBe('allow')
        }
    })

    it('reads `@` as HEAD, which a commit moves even when no branch is checked out', () => {
        commitOnBranch('detached', 'src/detached.ts')
        markVerified()
        repo.git(['switch', '--quiet', '--detach'])
        repo.write('src/detached.ts', 'export const unverified = 1\n')
        for (const source of ['@', 'HEAD']) {
            const command = `git commit -qam x && git push origin ${source}:refs/heads/published`
            expect(denial(command), command).toContain('npm run verify')
        }
    })

    it('stops a new pull request for unverified code, including one for another branch', () => {
        commitOnBranch('pull-request', 'src/feature.ts')
        expect(denial('gh pr create --fill')).toContain(
            "This opens a pull request for code that `npm run verify` hasn't passed.",
        )
        repo.git(['switch', '--quiet', 'main'])
        expect(denial('gh pr create --head pull-request --fill')).toContain('opens a pull request')
        expect(denial('gh pr create -Hpull-request --fill')).toContain('opens a pull request')
        // With advice for a pull request, not a push
        expect(denial('gh pr create --head "$BRANCH" --fill')).toContain('gh pr create --head')
        expect(denial('echo x | xargs gh pr create --head')).toContain('gh pr create --head')
    })

    it('checks every tag a --tags push sends that main does not already have', () => {
        repo.git(['tag', 'v0.1', 'main'])
        commitOnBranch('feature', 'src/b.ts')
        expect(check('git push --tags').decision).toBe('allow')
        repo.git(['tag', 'unverified'])
        repo.git(['switch', '--quiet', 'main'])
        markVerified()
        expect(denial('git push --tags')).toContain('npm run verify')
        expect(denial('git push origin main --tags')).toContain('npm run verify')
    })

    it('checks the annotated tags a push following tags sends with its commits', () => {
        commitOnBranch('feature', 'src/b.ts')
        repo.git(['tag', '-a', '-m', 'unverified', 'unverified'])
        commitOnBranch('feature', 'src/c.ts')
        markVerified()
        expect(check('git push origin HEAD').decision).toBe('allow')
        expect(denial('git push --follow-tags origin HEAD')).toContain('npm run verify')
        expect(denial('git -c push.followTags=true push origin feature')).toContain(
            'npm run verify',
        )
        config('push.followTags', 'true')
        expect(denial('git push origin HEAD')).toContain('npm run verify')
        expect(check('git push --no-follow-tags origin HEAD').decision).toBe('allow')

        // Not a lightweight tag, nor one the pushed commits don't reach
        repo.git(['tag', '-d', 'unverified'])
        repo.git(['tag', 'light', 'HEAD~1'])
        commitOnBranch('elsewhere', 'src/d.ts')
        repo.git(['tag', '-a', '-m', 'elsewhere', 'elsewhere'])
        repo.git(['switch', '--quiet', 'feature'])
        expect(check('git push origin HEAD').decision).toBe('allow')
    })

    it('checks a push from a subfolder, and one split across lines', () => {
        commitOnBranch('nested', 'src/nested.ts')
        expect(denial('git push', join(repo.dir, 'src'))).toContain('npm run verify')
        expect(denial('git \\\n  push origin nested')).toContain('npm run verify')
    })

    it('stops a push of every branch at once, since there is no one tree to check', () => {
        expect(denial('git push --all origin')).toContain('every branch at once')
        expect(denial("git push origin 'refs/heads/*:refs/heads/*'")).toContain(
            'every branch at once',
        )
    })

    it("stops a push with no refspec when git's push settings pick what it sends", () => {
        commitOnBranch('configured', 'src/configured.ts')
        markVerified()
        expect(check('git push').decision).toBe('allow')

        config('remote.origin.push', 'refs/heads/main:refs/heads/main')
        expect(denial('git push origin')).toContain('push settings pick')
        expect(check('git push origin configured').decision).toBe('allow')
        config('--unset', 'remote.origin.push')

        // Another remote's settings don't change what a push to origin sends…
        config('remote.other.push', 'refs/heads/main:refs/heads/main')
        expect(check('git push origin').decision).toBe('allow')
        // …but they do when git's settings send a bare push there.
        for (const key of [
            'branch.configured.pushRemote',
            'remote.pushDefault',
            'branch.configured.remote',
        ]) {
            config(key, 'other')
            expect(denial('git push'), key).toContain('push settings pick')
            expect(check('git push origin').decision, key).toBe('allow')
            config('--unset', key)
        }
        config('--unset', 'remote.other.push')

        config('remote.origin.mirror', 'yes')
        expect(denial('git push origin')).toContain('push settings pick')
        config('remote.origin.mirror', 'off')
        expect(check('git push origin').decision).toBe('allow')
        config('--unset', 'remote.origin.mirror')

        config('push.default', 'matching')
        expect(denial('git push')).toContain('push settings pick')
        config('--unset', 'push.default')

        // Settings given in the command count the same, and a refspec there wins over them.
        expect(denial('git -c push.default=matching push')).toContain('push settings pick')
        const inline =
            'git -c push.default=matching -c remote.origin.push=refs/heads/*:refs/heads/*'
        expect(check(`${inline} push origin configured`).decision).toBe('allow')

        // With one remote, a bare push goes there, whatever its name.
        repo.git(['remote', 'rename', 'origin', 'upstream'])
        config('remote.upstream.push', 'refs/heads/main:refs/heads/main')
        expect(denial('git push')).toContain('push settings pick')
    })

    it('checks a branch pushed by name against where that branch left main', () => {
        commitOnBranch('elsewhere', 'src/elsewhere.ts')
        // main moves on after `elsewhere` left it
        repo.git(['switch', '--quiet', 'main'])
        repo.write('src/upstream.ts', 'export const u = 1\n')
        repo.git(['add', '.'])
        repo.git(['commit', '--quiet', '-m', 'upstream'])
        repo.git(['push', '--quiet', 'origin', 'main'])
        commitOnBranch('docs-branch', 'CHANGELOG.md', '# Changelog\n\n## 1.0.0\n')
        repo.git(['switch', '--quiet', 'elsewhere'])

        expect(check('git push origin docs-branch').decision).toBe('allow')
        expect(check('git push origin origin/main:refs/heads/copy').decision).toBe('allow')
        // An unverified branch that is checked out can be verified here…
        expect(denial('git push origin elsewhere')).not.toContain('Check out each branch')
        // …and one that isn't can't.
        repo.git(['switch', '--quiet', 'docs-branch'])
        expect(denial('git push origin elsewhere')).toContain('Check out each branch')
        // A branch the same command makes holds what's checked out.
        markVerified()
        expect(check('git switch -c made && git push -u origin made').decision).toBe('allow')
    })

    it('stops a push on a branch that shares no history with main, as verify records a pass there', () => {
        repo.git(['switch', '--quiet', '--orphan', 'alone'])
        repo.write('CHANGELOG.md', '# Changelog\n')
        repo.git(['add', '.'])
        repo.git(['commit', '--quiet', '-m', 'alone'])
        expect(denial('git push origin alone')).toContain('npm run verify')
        markVerified()
        expect(check('git push origin alone').decision).toBe('allow')
    })
})

describe('pushes it stops before reading them', () => {
    it('stops a push that follows a branch switch, rebase or pull in the same command', () => {
        commitOnBranch('feature', 'src/b.ts')
        markVerified()
        repo.git(['switch', '--quiet', '-c', 'other', 'main'])
        repo.write('src/other.ts', 'export const o = 1\n')
        repo.git(['add', '.'])
        repo.git(['commit', '--quiet', '-m', 'other'])
        repo.git(['switch', '--quiet', 'feature'])
        for (const command of [
            'git switch other && git push',
            'git checkout other && git push origin HEAD',
            'git pull --rebase && git push',
            'git rebase origin/main && git push --force-with-lease origin feature',
            'git reset --hard other && git push',
            'gh pr checkout 12 && git push',
        ]) {
            expect(denial(command), command).toContain('Run the push as a command of its own.')
        }
        // These keep what's checked out
        for (const command of [
            'git checkout -- src/b.ts && git push',
            'git checkout HEAD -- src/b.ts && git push',
            'git reset && git push',
            'git switch -c copy && git push -u origin copy',
            'git checkout -b copy2 && git push -u origin copy2',
            'git branch copy3 && git push origin copy3',
        ]) {
            expect(check(command), command).toEqual({ decision: 'allow', notes: [] })
        }
    })

    it('checks what a branch forced over an existing one will hold, not what it holds now', () => {
        commitOnBranch('feature', 'src/b.ts')
        repo.git(['branch', 'publish', 'main'])
        // publish holds main's code, which needs no verify
        expect(check('git push origin publish').decision).toBe('allow')
        for (const command of [
            'git switch -C publish && git push origin publish',
            'git checkout -B publish && git push origin publish',
            'git switch -C publish && git push origin refs/heads/publish',
            'git switch -C publish && git push origin heads/publish:publish',
        ]) {
            expect(denial(command), command).toContain(
                "This pushes code that `npm run verify` hasn't passed.",
            )
        }
        // Without force, switching to a new branch named like an existing one fails, and the push
        // sends the existing one.
        expect(check('git switch -c publish; git push origin publish').decision).toBe('allow')
        for (const command of [
            'git branch -f publish && git push origin publish',
            'git branch -M publish && git push origin publish',
            'git update-ref refs/heads/publish HEAD && git push origin publish',
        ]) {
            expect(denial(command), command).toContain('Run the push as a command of its own.')
        }
        markVerified()
        expect(check('git switch -C publish && git push origin publish').decision).toBe('allow')
    })

    it('checks a branch the command makes and commits to, when the push names it in full', () => {
        commitOnBranch('feature', 'src/b.ts')
        markVerified()
        repo.write('src/b.ts', 'export const b = 2\n')
        expect(
            denial(
                'git switch -c fresh && git commit -qam more && git push origin refs/heads/fresh',
            ),
        ).toContain('npm run verify')
    })

    it('stops a push of a branch named by a variable, or one that does not exist', () => {
        commitOnBranch('feature', 'src/b.ts')
        markVerified()
        for (const command of [
            'git push origin "$BRANCH"',
            'for b in feature other; do git push -u origin $b; done',
            'git push origin nowhere',
            'git switch -c new origin/main && git push -u origin new',
        ]) {
            expect(denial(command), command).toMatch(/can't tell what it (will )?send/)
        }
    })

    it('reads a push run through eval, a shell, sudo or xargs', () => {
        commitOnBranch('feature', 'src/b.ts')
        for (const command of [
            'eval "git push origin feature"',
            "sh -c 'git push origin feature'",
            'bash -lc "cd src && git push"',
            'sudo -u me git push',
            "env -S 'git push origin feature'",
        ]) {
            expect(denial(command), command).toContain('npm run verify')
        }
        expect(denial('echo feature | xargs git push origin')).toContain('what `xargs` adds')
        expect(denial('echo feature | xargs --max-procs 2 git push origin')).toContain(
            'what `xargs` adds',
        )
        expect(denial('sudo --chdir src git push origin feature')).toContain('npm run verify')
        markVerified()
        expect(check('eval "git push origin feature"').decision).toBe('allow')
    })
})

describe('pushes that need no verify', () => {
    it('allows a branch that changes only docs or files only CI reads', () => {
        commitOnBranch('docs-only', 'CHANGELOG.md', '# Changelog\n\n## 1.0.0\n')
        repo.write('.nvmrc', '26\n')
        repo.git(['add', '.'])
        repo.git(['commit', '--quiet', '-m', 'changelog and node version'])
        expect(check('git push origin docs-only')).toEqual({ decision: 'allow', notes: [] })
        expect(check('gh pr create --fill').decision).toBe('allow')
    })

    it('allows a branch whose code is what main already has', () => {
        commitOnBranch('undone', 'src/undone.ts')
        repo.git(['rm', '--quiet', 'src/undone.ts'])
        repo.git(['commit', '--quiet', '-m', 'undo'])
        expect(check('git push').decision).toBe('allow')
    })

    it('allows dry runs, deletions and pushes of tags main already has', () => {
        repo.git(['tag', 'v0.1', 'main'])
        commitOnBranch('quiet', 'src/quiet.ts')
        for (const command of [
            'git push --dry-run',
            'git push -n origin quiet',
            'git push origin --delete old',
            'git push origin :old',
            'git push --tags',
        ]) {
            expect(check(command), command).toEqual({ decision: 'allow', notes: [] })
        }
    })
})

describe('pushes it leaves alone, and says so', () => {
    it('lets a push from another checkout through without a word', () => {
        commitOnBranch('here', 'src/here.ts')
        const other = createTempRepo()
        try {
            expect(check(`cd '${other.dir}' && git push`)).toEqual({ decision: 'allow', notes: [] })
        } finally {
            other.cleanup()
        }
    })

    it("notes a push from a folder it can't name, or that isn't in a checkout yet", () => {
        commitOnBranch('unnamed', 'src/unnamed.ts')
        expect(check('cd "$REPO" && git push')).toEqual({
            decision: 'allow',
            notes: ["can't tell which folder a push runs in, so it isn't checked"],
        })
        const made = check('mkdir -p newdir && cd newdir && git push')
        expect(made.decision).toBe('allow')
        expect(made.notes).toEqual([expect.stringMatching(/can't find the checkout of .*newdir/)])
    })

    it("notes a pull request for a branch it can't find, in full words", () => {
        expect(check('gh pr create --head nowhere')).toEqual({
            decision: 'allow',
            notes: ["can't find nowhere, so the pull request isn't checked"],
        })
        expect(check('cd "$REPO" && gh pr create --fill').notes).toEqual([
            "can't tell which folder a pull request runs in, so it isn't checked",
        ])
    })

    it('ignores commands that push nothing', () => {
        commitOnBranch('reading', 'src/reading.ts')
        for (const command of ['git status', 'git commit -m "then git push"', 'gh pr view']) {
            expect(check(command), command).toEqual({ decision: 'allow', notes: [] })
        }
    })
})

describe('worktrees', () => {
    it('checks a push from another worktree of this repository that has the guard', () => {
        const tree = addWorktree('linked')
        writeFileSync(join(tree, 'src/w.ts'), 'export const w = 1\n')
        repo.git(['-C', tree, 'add', '.'])
        repo.git(['-C', tree, 'commit', '--quiet', '-m', 'w'])
        // An older branch has no guard, and is left alone
        expect(check(`git -C '${tree}' push origin HEAD`)).toEqual({ decision: 'allow', notes: [] })

        repo.write('.agents/scripts/guard.ts', '')
        repo.git(['add', '.'])
        repo.git(['commit', '--quiet', '-m', 'add the guard'])
        repo.git(['-C', tree, 'merge', '--quiet', '--no-edit', 'main'])
        for (const command of [
            `git -C '${tree}' push origin HEAD`,
            `git -C'${tree}' push origin HEAD`,
            `cd '${tree}' && git push`,
        ]) {
            expect(denial(command), command).toContain('npm run verify')
        }
        expect(denial('git push', tree)).toContain('npm run verify')

        // Its own verify record counts, not this checkout's
        markVerified()
        expect(denial(`git -C '${tree}' push origin HEAD`)).toContain('npm run verify')
        markDirVerified(tree)
        expect(check(`git -C '${tree}' push origin HEAD`).decision).toBe('allow')
    })
})
