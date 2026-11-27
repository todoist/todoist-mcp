// `npm run verify`: every check CI runs on a pull request, in about ten seconds.
// Records a fingerprint of the tree only when everything passed; the push check reads it.

import { CHECKOUT_ROOT, branchBase, defaultBranchRef } from './lib/git.ts'
import { forgetPassedChanges } from './lib/patches.ts'
import { clearVerified } from './lib/state.ts'
import { BLIND_SPOTS, LOOSENING_ENV, preflight, VERIFY_STEPS } from './lib/steps.ts'
import { runVerify } from './lib/verify.ts'

const root = CHECKOUT_ROOT
const ref = defaultBranchRef(root)
const base = ref ? branchBase(root, ref) : undefined

const problems = preflight(root)
if (problems.length > 0) {
    for (const problem of problems) console.log(`✗ ${problem}`)
    // A run that stops here is a run that didn't pass: forget the tree and the branch's changes, as
    // a failing check would. After the problems, which still say what to fix when forgetting fails.
    clearVerified(root)
    if (base !== undefined) forgetPassedChanges(root, base)
    process.exit(1)
}

for (const name of LOOSENING_ENV) {
    if (process.env[name] === undefined) continue
    console.log(`Ignoring ${name}: CI does not set it.`)
    delete process.env[name]
}

const result = await runVerify({
    root,
    steps: VERIFY_STEPS,
    base,
    baseName: ref?.replace(/^refs\/(remotes|heads)\//, '') ?? 'main',
})

if (result.recorded) {
    console.log('Not covered by these checks:')
    for (const spot of BLIND_SPOTS) console.log(`- ${spot}`)
}
process.exit(result.ok ? 0 : 1)
