# Working with coding agents

This repository is set up so coding agents prove their work before they call it done. This page explains the parts, what each one guarantees, and where it stops. It grows as each part lands.

## Layers

1. **Git hooks** run for everyone, people and agents alike, on every commit and push.
2. **`npm run verify`** runs every CI check locally and records a pass.
3. **`AGENTS.md`** tells agents what done means. Claude Code reads it through `CLAUDE.md`; Codex and Cursor read it directly.
4. **Skills** in `.agents/skills/` give step-by-step procedures for recurring work. They load only when a task needs them.
5. **Review**: fresh reviewers and Doistbot check a finished change against the checks in `.agents/checks/`.
6. **The push check** stops an agent's `git push` or `gh pr create` until `npm run verify` has passed on exactly what it pushes.

## Rules and what holds them

| Rule                                                                                                    | Held by                                                              | Certainty                                |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------- |
| No commits on `main`                                                                                    | `pre-commit` and `commit-msg` → `.agents/scripts/branch-guard.sh`    | Enforced locally; `--no-verify` skips it |
| No pushes to `main`                                                                                     | `pre-push` → `branch-guard.sh`; the "Protect default branch" ruleset | Enforced on GitHub                       |
| Committed files are linted and formatted                                                                | `pre-commit` (lefthook, staged files only); CI                       | Enforced in CI                           |
| Type check passes before a commit                                                                       | `pre-commit`; CI                                                     | Enforced in CI                           |
| Tests pass before a push                                                                                | `pre-push`; CI                                                       | Enforced in CI                           |
| Agent tooling and developer scripts never ship in the npm package                                       | `.agents/scripts/package-contents.test.ts`                           | Enforced in CI                           |
| `npm run verify` runs what CI runs                                                                      | `.agents/scripts/lib/steps.test.ts` compares it with `ci.yml`        | Enforced in CI                           |
| Run `npm run verify` before calling work done                                                           | `AGENTS.md`                                                          | Asked                                    |
| An agent pushes only code `npm run verify` passed                                                       | The push check, `.agents/scripts/guard.ts`                           | Enforced on an agent's push              |
| Never weaken a check to pass it                                                                         | `AGENTS.md`                                                          | Asked                                    |
| Instructions name only files, links and scripts that exist                                              | `.agents/scripts/instructions.test.ts`                               | Enforced in CI                           |
| Every skill says when to use it and is linked for Claude Code                                           | `.agents/scripts/instructions.test.ts`                               | Enforced in CI                           |
| Use the matching skill for each task                                                                    | `AGENTS.md`                                                          | Asked                                    |
| Tests meet the quality bar                                                                              | `.agents/skills/write-tests/references/test-rules.md`                | Asked                                    |
| Review checks say what to report and what is fine, and AGENTS.md links them                             | `.agents/scripts/instructions.test.ts`                               | Enforced in CI                           |
| A finished change gets a task review, a blast-radius review when shared code changed, and a code review | `review-changes` skill                                               | Asked                                    |
| Reviewers never edit the shared checkout                                                                | the reviewer brief; `npm run review:worktree` gives them their own   | Asked                                    |

"Enforced in CI" means a pull request cannot merge without it. A local hook alone is a speed bump: `git commit --no-verify` skips it.

## Git hooks

[Lefthook](https://github.com/evilmartians/lefthook) runs the hooks, configured in `lefthook.yml`. `npm install` installs them into `.git/hooks` (the `prepare` script runs `lefthook install --reset-hooks-path`). If your clone still has husky's `core.hooksPath`, that first install removes it, which lefthook needs; the leftover `.husky/` folder can be deleted.

- **`pre-commit`** refuses a commit on `main`, then lints and formats the staged files (re-staging what the tools fix), runs the schema check when a tool file is staged, and runs the type check. Unstaged changes in a partly staged file are left alone.
- **`commit-msg`** refuses a commit on `main` again. Lefthook runs no pre-commit job when nothing is staged, so without it an empty commit would get past.
- **`pre-push`** refuses a push to `main`, then runs the tests. It checks `git push --dry-run` too.
- If node is not on `PATH` (some GUI git clients), both hooks still apply the branch rule, skip the checks, and say so. CI runs the same checks.
- The default branch is read from `origin/HEAD`, falling back to `main`.

The release workflow commits and pushes to `main` from GitHub Actions, and `npm ci` runs `prepare` there, which installs the hooks. The guard therefore skips itself when `GITHUB_ACTIONS=true`. That is the one exemption. Branch protection on GitHub is the real enforcement; the hooks only catch mistakes early.

## `npm run verify`

One command, every check a pull request's CI runs: lint, format, both type checks, all tests, the build, schema validation and the executable smoke test. It takes about ten seconds, so it always checks the whole tree. Picking only the affected tests would save two seconds and add a way to miss something.

- **Before the checks** it stops if Node is older than `package.json` requires, or if `node_modules` does not match the lockfile. Both make checks fail for reasons unrelated to your change.
- **Only docs changed** since the branch left `main`: it says there is nothing to check. Docs here means only what no local check reads, `CHANGELOG.md` and `LICENSE`: the format check (oxfmt) reads every other Markdown file, and the JSON and YAML under `.github/`, so a README edit needs verify like code. Adding or deleting a doc counts as code too, since the agent instructions may name it. `.agents/scripts/lib/tree.test.ts` checks that oxfmt leaves alone every file verify leaves out.
- **Only CI files changed** (`.nvmrc`, which picks the release workflow's Node version): it says no local check reads them.
- **`MCP_TOKEN_BUDGET`** raises the token budget test's limit. CI never sets it, so verify ignores it and says so.
- **Output:** one line per step. A failing step prints the last 30 lines of its log and the log's path under `.tmp/agents/logs/`.
- **The record:** after a full pass it writes a content hash of every file local checks read (not docs, not CI-only files) to `.tmp/agents/verified.json`. A run that fails, or sees files change while it runs, deletes it. The push check reads it.
- **What it cannot see:** the MCP Apps widgets in a real client, the real Todoist API, and how models use tool descriptions. It prints these after every pass.

If CI gains a step, `.agents/scripts/lib/steps.test.ts` fails until verify gains it too.

## The push check

Every agent calls one script, `.agents/scripts/guard.ts`, so the agents can't drift apart: Claude Code and Codex from their hook configs, Pi from a small extension. Before each shell command an agent runs, it stops one that pushes code `npm run verify` hasn't passed, or opens a pull request for it. That's where a person starts reviewing, so that's where the proof has to exist. It costs nothing until a command pushes: the hook command only starts Node when the shell command itself mentions a push or a new pull request, and the guard only runs git when it reads one.

- **What it checks:** what's pushed has to be exactly a tree verify passed, docs aside. A push sends commits, not the working tree, so verifying with uncommitted changes and then pushing only some of them doesn't get through. When the working tree holds more than the last commit, it says to commit or stash the rest before verifying.
- **A commit and a push in one command:** for `git add -A && git commit -m "…" && git push`, it checks the working tree that's about to be committed. That holds only when the commit takes all of it: everything staged first in the same command (`git add -A`, or `git add .` from the top folder), `git commit -a` with no untracked files, or a plain commit with nothing unstaged either. A commit that can leave part of the tree out, by naming paths, `--patch` or what it doesn't stage, is stopped: commit first, then push. The working tree stands in only for what the commit moves, `HEAD` and the branch checked out when it commits (and a branch the command makes after it); a tag or another branch at the same commit is checked against what it holds, since the commit leaves it where it was.
- **What needs no verify:** a branch whose changes since `main` are all ones verify records nothing for (edits to `CHANGELOG.md`, `LICENSE` or `.nvmrc`), or whose code is back to what `main` has; a dry run; and a push that only deletes. A README or other Markdown change does need verify, since the format check reads it. A tag named in the command, such as `git push origin v1.0`, is checked like a branch, `git push --tags` checks every tag that `main` doesn't already contain, and `--follow-tags` (or `push.followTags`) checks the annotated tags the pushed commits reach that `main` doesn't contain, so release tags push freely and a tag on unverified code doesn't. A branch with no history in common with `main` always needs verify, since verify checks the whole tree there and records a pass.
- **What it reads:** `git push`, with `-C` or after a `cd`, `pushd` or `popd`, and `gh pr create` (or `gh pr new`, with `-R` and `--head` or `-H`), anywhere in a command, after `env`, `command`, `builtin`, `exec`, `nohup`, `time`, `timeout` or `sudo` (with `env -C` or `sudo --chdir` changing the folder), and inside `eval`, `sh -c` (or another shell's `-c`) and `env -S`, but not inside quotes or a here-document, such as a commit message. It stops a push it can't tell the contents of: every branch at once (`--all`, `--mirror`, `:` or a wildcard), one with no refspec when git's settings for the remote it goes to pick what it sends (`remote.<name>.push` or `.mirror`, or `push.default=matching`, set in the config or with `git -c`; a refspec in the command wins over them, as in git), one run through `xargs`, a branch named by a shell variable or one that doesn't exist, and a push after a command in the same line that changes what's checked out or moves a branch (`git switch`, `git checkout`, `git reset <commit>`, `git rebase`, `git pull`, `git merge`, `git branch -f`, `-m` or `-c`, `git update-ref`, `gh pr checkout` and the like). A branch the same line makes from what's checked out (`git switch -c`, `git checkout -b`, `git branch <name>`) counts as what's checked out, and so does one it forces over an existing branch (`git switch -C`, `git checkout -B`), whatever that held before.
- **Which pushes:** pushes from the checkout `guard.ts` lives in, and from any other worktree of this repository that has the guard, however the command gets there (the agent works in it, `cd`, or `git -C`), each checked against that worktree's own verify record. A worktree on a branch without the guard is left alone, as is a push from another repository, and a push you run in your own terminal never passes through it.

When it stops a command, the reason tells the agent to run verify and try again. When you want something pushed that can't pass yet, push it yourself.

| Agent       | Wiring                                                                                                                                                   | Known limits                                                                                                                                                                                                                                                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | `.claude/settings.json`: `PreToolUse` on `Bash`                                                                                                          | `hook-wiring.test.ts` runs the exact command. Accept the workspace trust prompt.                                                                                                                                                                                                                                                                                                      |
| Codex       | `.codex/hooks.json`: `PreToolUse` on `Bash`                                                                                                              | Runs only in a trusted project (`codex --trust`), after each person reviews the hook in `/hooks`; a change to `hooks.json` needs a new review. In a linked worktree, Codex (0.171) trusts and runs the hooks of the main checkout, not the worktree's. The hook command finds the worktree from its folder, so a worktree is guarded once the main checkout has this hook.            |
| Cursor      | Runs the Claude Code hooks itself; the command falls back to the git root if Cursor does not set `CLAUDE_PROJECT_DIR`                                    | No Cursor hooks file: a second one would run every hook twice. A test keeps it out. Not yet tried here.                                                                                                                                                                                                                                                                               |
| Pi          | `.pi/extensions/agent-guard.ts` runs the guard from Pi's `tool_call` event, before each `bash` call that could push, and blocks the call with its reason | Pi loads project extensions only after you trust the project (`pi --approve`, or the prompt on first run), and only from the folder it starts in, so start Pi at the repository root. `pi-extension.test.ts` drives the extension; it can't sit next to it, since Pi would load a test there as another extension. In print and JSON modes, which have no UI, its notes go to stderr. |

**Limits.** The push check catches an agent's honest mistakes. It isn't a security boundary, and CI is still what gates a merge.

- **Pushes it can't see:** a push from a script, a git alias, a `gh` extension such as `gh stack`, GitHub's API or a GitHub MCP tool goes through unchecked, as does a command `eval` or a shell builds from variables. CI still checks them.
- **One record per checkout:** verify records the last tree it passed. To push a stack, verify and push each branch in turn; a push of several branches at once, or of a branch that isn't checked out, is stopped unless its changes need no verify.
- **A commit and a push in one command:** the check sees the working tree as it is before the command runs. A step before the commit that changes the tree or what's staged, such as `git stash pop` or `git restore --staged`, can let code through that verify didn't see.
- **Two sessions in one checkout** share its record. Use a worktree per session.
- Worktrees share the hooks in `.git/hooks`, so the branch rule works in a new worktree at once. Lint, format, types and tests need `npm ci` in that worktree first.
- Without the lefthook binary (no `node_modules` in the main checkout), the hooks print "Can't find lefthook in PATH" and let the commit through.

**Fails open, visibly:** a broken guard, bad input, or a push from a folder it can't name lets the command run and says why in a message. A checkout without the script, such as an older branch, is skipped without a word, since the hook runs before every shell command. In Pi, a guard that crashes or can't start, or an error in the extension itself, also lets the command run with a note giving the reason, though Pi blocks a tool call whose handler throws; a note that can't be shown never turns a block into an allow. If node isn't on `PATH`, the hook command fails and the agent carries on. `DISABLE_AGENT_GUARD=1` in the agent's environment turns the check off; in Claude Code, a gitignored settings.local.json in `.claude/` can set it for one checkout with `{ "env": { "DISABLE_AGENT_GUARD": "1" } }`.

## Skills

Each skill is a short procedure with a check at the end of every step. Agents load one when the task matches its description.

| Skill            | For                                    | Ends with                                                                                     |
| ---------------- | -------------------------------------- | --------------------------------------------------------------------------------------------- |
| `verify`         | Any change about to be called done     | `npm run verify`, proof matched to the change, an evidence report                             |
| `fix-bug`        | Something broken                       | A test that failed on the symptom, the root cause, undo/restore                               |
| `build-feature`  | A new tool, parameter or behaviour     | Decisions settled up front, test-first slices, a "touches X" map                              |
| `refactor`       | Structure changes, behaviour unchanged | Pinned tests, no changed assertions or snapshots                                              |
| `write-tests`    | Writing or changing tests              | Tests that failed once, meeting the test rules                                                |
| `learn`          | A correction from you                  | A type, lint rule, test or script check that catches the mistake                              |
| `review-changes` | A change you say is ready              | Task, blast-radius and code reviews; each finding fixed, dismissed with evidence or left open |

The evidence report rates each claim: **said**, **cited** (a line), **traced** (followed the code), **ran** (a test or command executed it), **seen** (in the running server). "Fixed" or "safe" needs **ran**. Anything less is listed under "Not verified".

The test rules were measured against this repository's tests first, so they accept the patterns that are fine here: `.not.toHaveBeenCalled()`, snapshots of model-facing text, contract tests that read source files.

## Review

When you say a change is ready, the agent runs `review-changes`:

- **Task review:** a fresh subagent gets your request in your words, what done means and the decisions made, never the author's reasoning. It looks for what is missing or unrequested. Doistbot can't do this, since it never sees the task.
- **Blast-radius review:** only when shared code changed (`src/utils/`, `src/index.ts` exports, dependencies, build config). It names the one fact that makes the change safe and proves it by running code.
- **Code review:** Doistbot locally (`doistbot review --json`, or `--base <branch below>` in a stack) when version 1.0.12+ is installed and `doistbot doctor` passes. Otherwise one subagent per check in `.agents/checks/`. Doistbot reads `AGENTS.md` and its links, so the checks apply to its pull request reviews too.

Findings are fixed, dismissed with evidence (a line or a test run, never an argument), or left open for you. Reviewers that need to run code get their own worktree from `npm run review:worktree -- <dir>`; the shared one stays read-only.

The checks cover tests, architecture, security, privacy, the tool surface and evidence. Two kinds Todoist uses elsewhere don't apply here: there are no translations and no database migrations. The closest thing to a destructive migration is a tool that deletes or overwrites Todoist data, which the architecture check covers through tool annotations.

A review costs several agent runs, so it runs when you ask, not on every change. A Doistbot run with a failed provider (`providerFailures`) is partial; the agent should say so.

## How to ask an agent

Give it:

- **the goal**, in a sentence;
- **a done check** that can pass or fail ("`find-tasks` with `labels: ["x"]` returns only tasks labelled x");
- **the proof you want** (a failing test first, a real `npm run tool` call, an eval run);
- **facts you know** and **real constraints** (a deadline, a public API that must not change).

Leave out the method and your theory of the cause. For a vague report, ask the agent to restate it first. Start a new session for unrelated work.

| To start…  | Say                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------ |
| a bug fix  | "Fix: <symptom>. Input: <args>. Expected: <x>." (`fix-bug`)                                                        |
| a feature  | "Add <behaviour>. Done when <check>." (`build-feature`)                                                            |
| a refactor | "Refactor <area> so <what gets easier>." (`refactor`)                                                              |
| a review   | "Ready for a PR." (`review-changes`)                                                                               |
| a release  | "Ready to release." Check the PR title type: `feat:`, `fix:`, `perf:` and breaking changes publish; others do not. |

Your part: answer the decision questions, and read the evidence report, especially "Not verified".

## Where the tooling lives

- `.agents/scripts/` holds scripts and their tests, next to the skills and review checks. It is not under `scripts/`, which holds the project's own developer scripts, nor a top-level "tools" folder, which would read as MCP tools (`src/tools/`).
- The tooling runs straight from TypeScript with Node's type stripping, so it only uses erasable syntax (`.agents/scripts/tsconfig.json` enforces this). `npm run type-check` covers it.
- Tests run in `npm test` and CI. They copy the tools into throwaway git repositories and never touch your checkout. A test helper clears the variables git exports to hooks, since `npm test` itself runs inside `pre-push`.

## Releases

semantic-release publishes from `main` on every merge. The squash-merged PR title decides whether anything ships: `feat:`, `fix:`, `perf:` and any breaking change (`!`) release; `chore:`, `ci:`, `docs:`, `test:` and `refactor:` do not. Changes to the agent tooling use `chore:` or `ci:`, so they never publish a new version. No path filter is needed.

## What fails open

- No node on `PATH` in a GUI client: the hooks skip lint, the type check and the tests, with a message. The branch rule still applies.
- `git commit --no-verify`: every local hook is skipped. CI and branch protection still apply.
- The push check: any error lets the command run, with a message saying why. `DISABLE_AGENT_GUARD=1` turns it off.
