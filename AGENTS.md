# @onryde/seazn-engine

The Seazn scoring and competition engine: sport modules, the event fold, scheduling, standings and the testkit. Published
to GitHub Packages as `@onryde/seazn-engine`; onryde/seazn.club installs it under the alias `@seazn/engine`.

## History

This repository starts at one import commit. Everything before it, with blame, PR numbers and reviews, is
`packages/engine` in onryde/seazn.club at `5a67fbf37d25675c683bbc91785bba5bacd93714` (tag `engine-split-base`). That
repository is never rewritten (engine-split design D22), so `git log` / `git blame` there are the record for any line
older than the import. Design of record: onryde/seazn.club `docs/superpowers/specs/2026-10-13-engine-split-design.md`
(§7 the cutover, §8 versioning, §9 the dev loop, §10 CI).

## Registry auth (D18)

`.npmrc` here holds only the scope line (`@onryde:registry=https://npm.pkg.github.com`). Local installs that need an
`@onryde` package authenticate with a personal token scoped `read:packages`, kept in your own `~/.npmrc`
(`//npm.pkg.github.com/:_authToken=<token>`). The token lives only there: never in a repo file, a commit, a log line or
a command's argv. CI uses `GITHUB_TOKEN`. Only release.yml's two publishing jobs (`release` and `snapshot`) hold
`packages: write`, and only their registry steps see it as `NODE_AUTH_TOKEN`.

## The dev loop (design §9, D17)

1. **Local.** In the onryde/seazn.club checkout, add an UNCOMMITTED `pnpm.overrides` entry
   `"@seazn/engine": "link:../seazn.club.engine"` and keep `tsc --watch` running here. App CI fails any committed
   `link:` or `file:` engine spec, so the override stays in your working tree.
2. **Paired PRs are the unit of review.** The engine PR publishes `0.0.0-pr<N>.<sha>`; the app PR pins that exact
   version and carries the matrix rows, contract tests and any web change. Each PR links the other. Merge order: engine
   PR, then the owner merges a release PR (Releasing, below), then the app PR repins to the release and merges.
3. **Every engine PR body has a `Matrix rows:` line** naming the format × sport rows the change touches
   (onryde/seazn.club `docs/superpowers/TEST-STRATEGY.md` rule 9). The engine PR declares them; the paired app PR runs
   them.

## Releasing (D16, §8)

Every PR adds a changeset (`pnpm changeset`, or `pnpm changeset --empty` for a change that releases nothing), and they
collect on main. While main holds any, each push's `release` job (release.yml) names them in a notice and publishes
nothing. GitHub Actions may not open pull requests in this organisation, so a person cuts each release by hand:

1. Branch `release/<version>` from an up-to-date main (`git checkout -b release/<version> origin/main`), where
   `<version>` is the one `pnpm changeset status --verbose` says the pending changesets add up to.
2. Run `pnpm changeset version`. It writes that version into package.json and its entry into CHANGELOG.md, and deletes
   the changesets it consumed.
3. Commit package.json, CHANGELOG.md and the deleted changesets, and nothing else.
4. Open the PR against main, then merge it with a merge commit. CI's changeset job lets a `release/*` PR whose version
   differs from main's pass without a changeset, and judges the fold tables against that version bump: a moved
   FOLD_EPOCH needs a major, a moved FOLD_MINOR at least a minor. If another PR adds a changeset to main before this one
   merges, cut the branch again from the new main: a merge that leaves a changeset on main publishes nothing.
5. On that merge's push, the `release` job finds no changeset pending, publishes the version to GitHub Packages, tags
   `v<version>`, and creates the GitHub Release: the CHANGELOG entry, then the epoch report (the sports this release
   locks out for older capture apps).

## Known red

A check that is red on `main` for a reason already owned elsewhere. A release or merge may pass over ONLY these, each matched by test name in the job log; anything else red stops the merge. Delete the line in the PR that fixes it.

- `test/stryker-sizing.test.ts` (job "Engine coverage + golden ledgers + sim matrix"): leg mutant counts drifted past the 10% line before the split. Owner: the mutation session's re-measure, ported here as one PR (stryker-measured.json, stryker-timeouts.json).

## Porting a branch that was in flight at the cutover (D37)

A seazn.club branch that edited `packages/engine` lands here as a patch:

```
git -C ~/github/seazn.club diff origin/main...<branch> -- packages/engine | git apply -p3
```

Then open the engine PR and the paired app PR (step 2 above).

## Tests

- Run the tests covering the files you changed, by path. CI runs the rest.
- Read results from the JSON reporter written to a file, plus the command's own exit code:
  `npx vitest run --reporter=json --outputFile=<file> <paths>; echo "EXIT=$?"`, then compare `numTotalTests`,
  `numPassedTests` and `numFailedTestSuites`. A file that fails to collect lowers the total and leaves `numFailedTests`
  at 0.
- `vitest.config.ts` sets `isolate: false`. A parity or collect-only run passes `--isolate`, or tests from a file that
  imports another test file are attributed to whichever worker reached them first.
- Several tests locate the repository with `git rev-parse --show-toplevel` (`test/layout.ts`), so run them from a git
  checkout of this repository.
- Golden corpora (`*.golden.json`) and `FOLD_EPOCH` / `FOLD_MINOR` move only on purpose: a fold change that alters a
  recorded outcome bumps the epoch (`pnpm fold-epoch:check`), and the version follows it (§8).
