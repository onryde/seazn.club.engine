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
   PR, then the owner merges the Version PR, then the release, then the app PR repins to the release and merges.
3. **Every engine PR body has a `Matrix rows:` line** naming the format × sport rows the change touches
   (onryde/seazn.club `docs/superpowers/TEST-STRATEGY.md` rule 9). The engine PR declares them; the paired app PR runs
   them.

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
