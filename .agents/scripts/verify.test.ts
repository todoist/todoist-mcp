import { afterEach, beforeEach, expect, it } from 'vitest'
import { readPassedPatches, recordPassedPatch } from './lib/patches.ts'
import { createTempRepo, GIT_HAS_VERBATIM_PATCH_ID, type TempRepo } from './lib/test-repo.ts'

// `npm run verify` as people and agents run it: a copy of .agents/scripts in a throwaway repo,
// started as its own node process. The checks themselves are covered in lib/verify.test.ts.
let repo: TempRepo

beforeEach(() => {
    repo = createTempRepo()
    repo.copyFromCheckout('.agents/scripts/verify.ts', '.agents/scripts/lib')
    repo.write('.gitignore', '.tmp/\n')
    repo.write('package.json', '{ "engines": { "node": ">=24" } }\n')
    repo.write('src/a.ts', 'export const a = 1\n')
    repo.git(['add', '.'])
    repo.git(['commit', '--quiet', '-m', 'initial'])
    repo.commitOnBranch('feature', 'src/b.ts')
})

afterEach(() => repo.cleanup())

it.skipIf(!GIT_HAS_VERBATIM_PATCH_ID)(
    'forgets that the changes passed when the preflight stops the run',
    () => {
        const base = repo.git(['merge-base', 'HEAD', 'main']).stdout.trim()
        recordPassedPatch(repo.dir, base, 'HEAD')
        expect(readPassedPatches(repo.dir)).toHaveLength(1)

        // No node_modules, as after a rebase onto a main whose dependencies changed
        const result = repo.run(process.execPath, ['.agents/scripts/verify.ts'])
        expect(result.status).toBe(1)
        expect(result.stdout).toContain('node_modules is missing')
        expect(readPassedPatches(repo.dir)).toEqual([])
    },
)
