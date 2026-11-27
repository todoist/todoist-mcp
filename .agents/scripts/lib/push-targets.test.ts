import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findTargets } from './push-targets.ts'

// [kind, folder, sources] for each push, pull request and commit a command runs, from /w.
type Row = [string, string | null, string]

const read = (command: string): Row[] =>
    findTargets(command, '/w').map((target) => [target.kind, target.dir, target.sources.join(',')])

describe('findTargets', () => {
    it.each<[string, Row[]]>([
        ['git push', [['push', '/w', 'HEAD']]],
        ['cd ../other && git push origin main', [['push', '/other', 'main']]],
        [
            '(cd sub && git push) && git -C /x push',
            [
                ['push', '/w/sub', 'HEAD'],
                ['push', '/x', 'HEAD'],
            ],
        ],
        ['FOO=1 command git push 2>&1 | tail', [['push', '/w', 'HEAD']]],
        ['git push origin +feature:main :old tag v1', [['push', '/w', 'feature,refs/tags/v1']]],
        ['git push --all', [['push', '/w', '*']]],
        [
            'git push origin :; git push origin +:',
            [
                ['push', '/w', '*'],
                ['push', '/w', '*'],
            ],
        ],
        ['cd "$REPO"; (cd /tmp); git push', [['push', null, 'HEAD']]],
        ['cd - && git push', [['push', null, 'HEAD']]],
        ['cd ~/code && git push', [['push', join(homedir(), 'code'), 'HEAD']]],
        ['gh pr create --head me:feature --fill', [['pr', '/w', 'feature']]],
        [
            'git commit -m "fix: git push later" && git push',
            [
                ['commit', '/w', ''],
                ['push', '/w', 'HEAD'],
            ],
        ],
        // Wrappers, keywords and full paths still run git.
        ['if /usr/bin/git push; then echo ok; fi', [['push', '/w', 'HEAD']]],
        ['! timeout -k 5 60 nohup git push', [['push', '/w', 'HEAD']]],
        ['env -u FOO -C /x git push', [['push', '/x', 'HEAD']]],
        [
            'env -C/x git push; builtin git push',
            [
                ['push', '/x', 'HEAD'],
                ['push', '/w', 'HEAD'],
            ],
        ],
        ['git push --repo=origin backup', [['push', '/w', 'HEAD']]],
        ['command -p git push; command -v git push', [['push', '/w', 'HEAD']]],
        ['pushd sub && git push', [['push', '/w/sub', 'HEAD']]],
        // `popd` goes back to the folder `pushd` left, in this shell but not from a subshell.
        ['pushd ../other && git status && popd && git push', [['push', '/w', 'HEAD']]],
        ['pushd /x && pushd /y && popd && git push', [['push', '/x', 'HEAD']]],
        ['pushd -n /x && popd && git push', [['push', '/x', 'HEAD']]],
        ['pushd /x && pushd && git push', [['push', '/w', 'HEAD']]],
        [
            'pushd && git push; popd && git push',
            [
                ['push', '/w', 'HEAD'],
                ['push', '/w', 'HEAD'],
            ],
        ],
        ['(pushd /x) && popd && git push', [['push', '/w', 'HEAD']]],
        ['pushd /x && pushd +1 && popd && git push', [['push', null, 'HEAD']]],
        ['git --git-dir=/r/.git push', [['push', null, 'HEAD']]],
        // A command split across lines, as agents write long ones.
        ['gh pr \\\n  create --fill', [['pr', '/w', 'HEAD']]],
        [
            'echo "$(cd /x && git push)" && git push',
            [
                ['push', '/x', 'HEAD'],
                ['push', '/w', 'HEAD'],
            ],
        ],
        [
            'git -C/x push; git -C ../y push',
            [
                ['push', '/x', 'HEAD'],
                ['push', '/y', 'HEAD'],
            ],
        ],
        [
            'pushd -n /x && git push; pushd +1 && git push',
            [
                ['push', '/w', 'HEAD'],
                ['push', null, 'HEAD'],
            ],
        ],
        // Commands that run a command given to them as words or a string
        [
            'eval "cd /x && git push origin main"; git push',
            [
                ['push', '/x', 'main'],
                ['push', '/x', 'HEAD'],
            ],
        ],
        [
            "bash -lc 'cd /x && git push'; git push",
            [
                ['push', '/x', 'HEAD'],
                ['push', '/w', 'HEAD'],
            ],
        ],
        ["sh -c 'git push' && zsh script.sh", [['push', '/w', 'HEAD']]],
        ['sudo -u me git push origin main', [['push', '/w', 'main']]],
        ["env -S 'git push origin main'", [['push', '/w', 'main']]],
        ['echo main | xargs -n1 git push origin', [['push', '/w', '*']]],
        ['echo 1 | xargs gh pr create --head', [['pr', '/w', '*']]],
        ['echo main | xargs --max-args 1 git push origin', [['push', '/w', '*']]],
        ['echo main | xargs --max-procs=2 --replace git push origin', [['push', '/w', '*']]],
        [
            'sudo --chdir /x git push; sudo -D /y git push; sudo -D/z git push',
            [
                ['push', '/x', 'HEAD'],
                ['push', '/y', 'HEAD'],
                ['push', '/z', 'HEAD'],
            ],
        ],
        ['echo `git push origin feature`', [['push', '/w', 'feature']]],
        // Commands that make a branch from what's checked out, or change what's checked out
        [
            'git switch -c a && git checkout -b b && git branch c',
            [
                ['create', '/w', 'a'],
                ['create', '/w', 'b'],
                ['create', '/w', 'c'],
            ],
        ],
        [
            'git switch main; git switch -c d origin/main; git checkout x; gh pr checkout 1',
            [
                ['move', '/w', ''],
                ['move', '/w', ''],
                ['move', '/w', ''],
                ['move', '/w', ''],
            ],
        ],
        [
            'git pull; git rebase main; git merge x; git reset --hard y; git reset HEAD~1',
            [
                ['move', '/w', ''],
                ['move', '/w', ''],
                ['move', '/w', ''],
                ['move', '/w', ''],
                ['move', '/w', ''],
            ],
        ],
        [
            'git checkout -- a.ts; git checkout HEAD -- b.ts; git reset; git reset -- a.ts; git branch -d x',
            [],
        ],
        // `--` after a branch, with no file, only says it is a branch.
        ['git checkout other --', [['move', '/w', '']]],
        // Commands that move a branch to wherever they like
        [
            'git branch -f a; git branch -M b; git update-ref refs/heads/c HEAD',
            [
                ['move', '/w', ''],
                ['move', '/w', ''],
                ['move', '/w', ''],
            ],
        ],
        // What git's settings pick can't be read from the command.
        ['git -c push.default=matching push', [['push', '/w', '*']]],
        ['git -c remote.origin.push=refs/heads/a push origin', [['push', '/w', '*']]],
        ['git -c remote.pushDefault=other push', [['push', '/w', '*']]],
        ['git --config-env=branch.a.pushRemote=R push', [['push', '/w', '*']]],
        ['git -c core.editor=vi push', [['push', '/w', 'HEAD']]],
        // A refspec on the command line wins over git's push settings.
        ['git -c push.default=matching push origin feature', [['push', '/w', 'feature']]],
        ['git -c remote.origin.push=refs/heads/a push origin b', [['push', '/w', 'b']]],
        [
            'git push --mirror; git push --branches',
            [
                ['push', '/w', '*'],
                ['push', '/w', '*'],
            ],
        ],
        ["git push origin 'refs/heads/*:refs/heads/*'", [['push', '/w', 'refs/heads/*']]],
        [
            'gh -R o/r pr create --fill; gh pr new -H a; gh pr create --head=b; gh pr create -Hc',
            [
                ['pr', '/w', 'HEAD'],
                ['pr', '/w', 'a'],
                ['pr', '/w', 'b'],
                ['pr', '/w', 'c'],
            ],
        ],
        // Nothing that sends code: comments, quotes, here-documents, dry runs, deletions, tags.
        ['git push -fn # git push', []],
        ['echo "git push"; cat <<EOF\ngit push\nEOF', []],
        ["git commit -m 'git push' <<-'END'\n\tgit push\n\tEND", [['commit', '/w', '']]],
        ['git push --dry-run; git push -d origin old', []],
        // Every tag, which only the repository can list
        ['git push --tags', [['push', '/w', '']]],
        ['gh pr view; gh pr list --state open; git fetch', []],
    ])('reads %j', (command, expected) => {
        expect(read(command)).toEqual(expected)
    })

    it('takes the remote from an argument over --repo, as git does', () => {
        expect(findTargets('git push --repo=origin backup', '/w')[0]?.remote).toBe('backup')
        expect(findTargets('git push --repo origin', '/w')[0]?.remote).toBe('origin')
    })

    it('marks a push with no refspec as one git settings decide', () => {
        expect(findTargets('git push upstream', '/w')).toEqual([
            { kind: 'push', dir: '/w', sources: ['HEAD'], implicit: true, remote: 'upstream' },
        ])
        expect(findTargets('git push upstream feature', '/w')[0]?.implicit).toBeUndefined()
    })

    it('marks a push that also sends every tag', () => {
        expect(findTargets('git push --tags', '/w')).toEqual([
            { kind: 'push', dir: '/w', sources: [], tags: true },
        ])
        expect(findTargets('git push origin feature --tags', '/w')).toEqual([
            { kind: 'push', dir: '/w', sources: ['feature'], tags: true },
        ])
    })

    it('marks what a push says about sending the annotated tags its commits reach', () => {
        const follows = (command: string) => findTargets(command, '/w').at(-1)?.followTags
        expect(follows('git push --follow-tags origin HEAD')).toBe(true)
        expect(follows('git push --follow-tags --no-follow-tags origin HEAD')).toBe(false)
        expect(follows('git -c push.followTags=true push origin feature')).toBe(true)
        expect(follows('git -c push.followtags push origin feature')).toBe(true)
        expect(follows('git -c push.followTags=off push origin feature')).toBe(false)
        expect(follows('git -c push.followTags=false push --follow-tags origin feature')).toBe(true)
        expect(follows('git --config-env=push.followTags=FOLLOW push origin feature')).toBe(true)
        expect(follows('git push origin feature')).toBeUndefined()
    })

    it('marks a branch forced over an existing one', () => {
        const created = (command: string) =>
            findTargets(command, '/w').map((target) => [target.sources[0], target.force])
        expect(
            created('git switch -C a; git checkout -B b; git switch -c c; git branch d'),
        ).toEqual([
            ['a', true],
            ['b', true],
            ['c', false],
            ['d', false],
        ])
    })

    it('reads what a commit and `git add` take from the working tree', () => {
        const taken = (command: string) =>
            findTargets(command, '/w').map(({ kind, sources, stages, partial }) => ({
                kind,
                sources,
                stages,
                partial,
            }))
        const commit = { kind: 'commit', sources: [] }
        expect(taken('git commit -am x; git commit --all -m x; git commit -ma')).toEqual([
            { ...commit, stages: 'tracked' },
            { ...commit, stages: 'tracked' },
            commit,
        ])
        expect(
            taken(
                'git commit -m x a.ts; git commit -p; git commit -- a.ts; git commit -F - --amend',
            ),
        ).toEqual([
            { ...commit, partial: true },
            { ...commit, partial: true },
            { ...commit, partial: true },
            commit,
        ])
        expect(taken('git add -A; git add .; git add -u; git add -p; git add -n .')).toEqual([
            { kind: 'stage', sources: [], stages: 'all' },
            { kind: 'stage', sources: ['.'], stages: 'all' },
            { kind: 'stage', sources: [], stages: 'tracked' },
        ])
    })
})
