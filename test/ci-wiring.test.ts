// Moved from onryde/seazn.club@5a67fbf37d25675c683bbc91785bba5bacd93714:tools/matrix/__tests__/ci-wiring.test.ts (engine-split 2b Task E1; reverse
// inventory rows 18 and 29): the "Stryker floor CI wiring", "fold-epoch guard CI wiring" and "engine-pack CI wiring" describes,
// which pin the engine's own CI steps. Titles and assertions are verbatim; only paths are re-rooted (the engine is this repository's
// root: `packages/engine/<x>` reads `<x>`, the pnpm path filter `./packages/engine` is `.`). The ledger is
// onryde/seazn.club docs/superpowers/specs/engine-split/ledgers/2b.json. Comments below are the source's, unedited.
// The two reads of `src/` (the corpora count and STATS_FOLD_VERSION's declaration line) are of the checkout's files, never a Stryker
// sandbox's instrumented copy (./checkout-source.ts); everything else, the spawned guards included, still runs from REPO.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CHECKOUT, refuseInstrumented } from "./checkout-source.ts";
import { SPAWN_MS, spawnBudget } from "./spawn-budget.ts";
import { jobsOf, stepHeads, stepOf } from "./workflow-text.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS = resolve(REPO, ".github/workflows");
const ci = readFileSync(resolve(WORKFLOWS, "ci.yml"), "utf8");

// W1d Task 15 (D14): the Stryker floor never falls. Nothing else goes red when the step is deleted or made advisory, so this
// pins it, line-based as Task 10's is, and then RUNS the command as ci.yml spells it, so a flag pnpm swallowed or a script
// that does not exist reds here and not on the first PR that lowers a floor.
describe("Stryker floor CI wiring (W1d Task 15, D14)", () => {
  const STEP = "      - run: pnpm --filter . --fail-if-no-match mutation:floor --check-file-against HEAD^1";
  const TSC_STEP = "      - run: node node_modules/typescript-native/bin/tsc -p tsconfig.tools-tests.json";
  const lines = ci.split("\n");
  const isComment = (l: string) => /^\s*#/.test(l);
  // the job a line sits in: the last two-space job key at or above it
  const jobAt = (i: number) => lines.slice(0, i + 1).filter((l) => /^ {2}[a-z][\w-]*:$/.test(l)).pop();

  it("the Stryker floor gate runs in the gates job, exactly once, and nothing can make it conditional or advisory (W1d D14)", () => {
    const at = lines.indexOf(STEP);
    expect(at).toBeGreaterThan(0);
    expect(lines.filter((l) => l.includes("mutation:floor") && !isComment(l))).toEqual([STEP]);
    expect(lines[at + 1]).toMatch(/^ {6}(- |#)/);   // no key beneath it (`if:`, `continue-on-error:`, `env:`)
    expect(jobAt(at)).toBe("  gates:");
    // appended AFTER the steps Tasks 1 and 10 added, never directly after reference:boundary (Task 1 pins the lock step as the line after it)
    expect(at).toBeGreaterThan(lines.indexOf(TSC_STEP));
    expect(lines.indexOf(TSC_STEP)).toBeGreaterThan(0);
    // nor a job-level `if:` / `continue-on-error:` on the job that hosts it
    const gatesAt = lines.indexOf("  gates:");
    const header = lines.slice(gatesAt + 1, lines.indexOf("    steps:", gatesAt));
    expect(header.length).toBeGreaterThan(0);
    for (const l of header.filter((x) => !isComment(x))) expect(l).not.toMatch(/^ {4}(if|continue-on-error):/);
    // The step's `--filter ./packages/engine` is a PATH, resolved against the shell's cwd: a `defaults.run.working-directory` on the job
    // (or on the workflow) or a `working-directory:` on the step moves the cwd, the path matches nothing and pnpm exits 0 in silence.
    // `--fail-if-no-match` is the second line of defence; this is the first. (Phase 1 batch 1b review, minor 1.)
    for (const l of header.filter((x) => !isComment(x))) expect(l, "a job-level cwd shift would make the path filter a silent no-op").not.toMatch(/^ {4}(defaults|working-directory):/);
    expect(lines.filter((l) => /^(defaults|working-directory):/.test(l)), "a workflow-level default would shift every job's cwd").toEqual([]);
    expect(lines[at], "the step carries its no-match flag (a key beneath the step is already refused above, so nothing moves its cwd)").toContain(" --fail-if-no-match mutation:floor ");
  });

  it("the engine's package script runs the CLI under strip-types, and the CLI exists", () => {
    const engine = JSON.parse(readFileSync(resolve(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(engine.scripts["mutation:floor"]).toBe("node --experimental-strip-types scripts/stryker-floor.ts");
    expect(existsSync(resolve(REPO, "scripts/stryker-floor.ts"))).toBe(true);
    expect(engine.scripts.mutation).toBe("stryker run stryker.config.mjs");
  });

  it("the step's command as ci.yml spells it, run the way CI runs it, reaches the CLI with its flag and passes on this tree", () => {
    const step = lines.find((l) => l.includes("mutation:floor") && !isComment(l));
    expect(step).toBeDefined();
    const cmd = (step ?? "").trim().replace(/^- run: /, "");
    expect(cmd).toContain(" --check-file-against HEAD^1");
    // HEAD^1 needs history and a merge commit; HEAD is always there. Either HEAD has no floor file yet (the PR before its commit) or has the committed one, unchanged.
    const r = spawnSync("bash", ["-c", cmd.replace(" --check-file-against HEAD^1", " --check-file-against HEAD")], { cwd: REPO, encoding: "utf8", timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    // only a CLI that read the flag through `pnpm --filter` prints this: the flag reached it, in the engine's directory
    expect(r.stdout).toMatch(/^stryker-floor: (no floors at HEAD: nothing to compare|compared \d+ floor\(s\) against HEAD: 0 lowered or removed)$/m);
  }, spawnBudget(1));
});

// Engine-split Task 1e-2 (D15, D26): the fold-epoch guard. Nothing else goes red when the step is deleted, made advisory, or loses the history
// HEAD^1 needs, so this pins it line-based as the floor gate's is, and then RUNS the command as ci.yml spells it, so a flag pnpm swallowed or a
// script that does not exist reds here and not on the first PR that moves a golden.
describe("fold-epoch guard CI wiring (engine-split Task 1e-2, D15, D26)", () => {
  const engine = JSON.parse(readFileSync(resolve(REPO, "package.json"), "utf8")) as { name: string; scripts: Record<string, string> };
  const FLOOR_STEP = "      - run: pnpm --filter . --fail-if-no-match mutation:floor --check-file-against HEAD^1";
  const STEP = `      - run: pnpm --filter ${engine.name} --fail-if-no-match fold-epoch:check --against HEAD^1`;
  const lines = ci.split("\n");
  const isComment = (l: string) => /^\s*#/.test(l);
  const jobAt = (i: number) => lines.slice(0, i + 1).filter((l) => /^ {2}[a-z][\w-]*:$/.test(l)).pop();

  it("the guard runs in the gates job, exactly once, after the floor gate, and nothing can make it conditional or advisory", () => {
    const at = lines.indexOf(STEP);
    expect(at).toBeGreaterThan(0);
    expect(lines.filter((l) => l.includes("fold-epoch") && !isComment(l))).toEqual([STEP]);
    expect(lines[at + 1]).toMatch(/^ {6}(- |#)/); // no key beneath it (`if:`, `continue-on-error:`, `env:`, `working-directory:`)
    expect(jobAt(at)).toBe("  gates:");
    expect(lines.indexOf(FLOOR_STEP)).toBeGreaterThan(0);
    expect(at).toBeGreaterThan(lines.indexOf(FLOOR_STEP));
    const gatesAt = lines.indexOf("  gates:");
    const header = lines.slice(gatesAt + 1, lines.indexOf("    steps:", gatesAt));
    expect(header.length).toBeGreaterThan(0);
    for (const l of header.filter((x) => !isComment(x))) expect(l, "a job-level softener or cwd shift").not.toMatch(/^ {4}(if|continue-on-error|defaults|working-directory):/);
    expect(lines.filter((l) => /^(defaults|working-directory):/.test(l)), "a workflow-level default would shift every job's cwd").toEqual([]);
    // a name filter that matches no package exits 0 in silence unless told not to
    expect(lines[at]).toContain(" --fail-if-no-match fold-epoch:check ");
  });

  it("compares against HEAD^1 and the job's checkout is the full-history one that makes HEAD^1 exist", () => {
    const at = lines.indexOf(STEP);
    expect(lines[at]).toMatch(/ --against HEAD\^1$/);
    const gatesAt = lines.indexOf("  gates:");
    const checkoutAt = lines.findIndex((l, i) => i > gatesAt && l.includes("uses: actions/checkout@"));
    expect(checkoutAt).toBeGreaterThan(gatesAt);
    expect(jobAt(checkoutAt)).toBe("  gates:");
    const nextStepAt = lines.findIndex((l, i) => i > checkoutAt && /^ {6}- /.test(l));
    expect(nextStepAt).toBeGreaterThan(checkoutAt);
    expect(lines.slice(checkoutAt, nextStepAt), "a shallow checkout has no HEAD^1: the guard would refuse every PR").toContain("          fetch-depth: 0");
    expect(checkoutAt).toBeLessThan(at);
  });

  it("the engine's package script runs the guard under strip-types, and the guard exists", () => {
    expect(engine.scripts["fold-epoch:check"]).toBe("node --experimental-strip-types scripts/fold-epoch-guard.ts");
    expect(existsSync(resolve(REPO, "scripts/fold-epoch-guard.ts"))).toBe(true);
  });

  it("the step's command as ci.yml spells it, run the way CI runs it, reaches the guard and passes on this tree", () => {
    const step = lines.find((l) => l.includes("fold-epoch:check") && !isComment(l));
    expect(step).toBeDefined();
    const cmd = (step ?? "").trim().replace(/^- run: /, "");
    expect(cmd).toContain(" --against HEAD^1");
    // HEAD^1 needs history and a merge commit; HEAD is always there, and this tree is HEAD unless a golden is edited and not committed.
    const r = spawnSync("bash", ["-c", cmd.replace(" --against HEAD^1", " --against HEAD")], { cwd: REPO, encoding: "utf8", timeout: SPAWN_MS });
    expect(r.status, r.stderr + r.stdout).toBe(0);
    // only a guard that read the flag, through `pnpm --filter`, in the engine's directory, prints this; the sport count is the corpora on disk
    const corpora = (readdirSync(resolve(CHECKOUT, "src/sports"), { recursive: true }) as string[]).filter((f) => f.endsWith(".golden.json")).length;
    expect(corpora).toBeGreaterThan(0);
    const m = /^fold-epoch: (\d+) sports checked, (\d+) streams compared against HEAD: 0 violation\(s\), STATS_FOLD_VERSION (\d+) -> (\d+)$/m.exec(r.stdout);
    expect(m, r.stdout).not.toBeNull();
    expect(Number(m?.[1])).toBe(corpora);
    expect(Number(m?.[2])).toBeGreaterThanOrEqual(corpora);
    // GF-3 T1: the summary also carries the stats version, base -> tree; HEAD and this tree are the same commit, and the number is what
    // src/stats/stats.ts declares (read here by its declaration line: the engine's own, not the guard's output)
    const declared = /^export const STATS_FOLD_VERSION = (\d+);$/m.exec(refuseInstrumented("src/stats/stats.ts", readFileSync(resolve(CHECKOUT, "src/stats/stats.ts"), "utf8")))?.[1];
    expect(declared, "src/stats/stats.ts declares STATS_FOLD_VERSION on a line of its own").toBeDefined();
    expect([Number(m?.[3]), Number(m?.[4])]).toEqual([Number(declared), Number(declared)]);
  }, spawnBudget(1));
});

// Engine-split Task 1b-3 (D14): the packed-tarball proof. The job is only worth having if it runs, and the ways it quietly stops
// running are all in this file's text: a step gated on a filter id that does not exist is skipped for ever (a skipped step is a
// green job), a pnpm other than the pin packs a different tarball, a shifted cwd breaks the script path.
describe("engine-pack CI wiring (engine-split Task 1b-3, D14)", () => {
  const jobs = jobsOf(ci);
  const job = jobs["engine-pack"] ?? "";
  const jobLines = job.split("\n");
  const isComment = (l: string) => /^\s*#/.test(l);
  const code = jobLines.filter((l) => !isComment(l));
  const RUN = "        run: node pack-proof/run.mjs";
  const root = JSON.parse(readFileSync(resolve(REPO, "package.json"), "utf8")) as { packageManager: string };
  const pin = /^pnpm@(\d+\.\d+\.\d+)$/.exec(root.packageManager)?.[1];

  it("reads the jobs it asserts about (never an empty set), and the engine-pack job is one of them", () => {
    expect(Object.keys(jobs).length).toBeGreaterThan(3);
    expect(Object.keys(jobs)).toContain("engine");
    expect(job.length).toBeGreaterThan(0);
    expect(pin).toBeDefined();
  });

  it("runs the proof exactly once, as the command the engine's package script also runs, with nothing that could make it advisory", () => {
    expect(code.filter((l) => l.includes("pack-proof/run.mjs"))).toEqual([RUN]);
    const at = jobLines.indexOf(RUN);
    expect(at).toBeGreaterThan(0);
    // the step's own keys: a name and an `if`, nothing else (no continue-on-error, no env/working-directory that would move or soften it)
    const stepStart = jobLines.lastIndexOf("      - name: Pack the engine and consume the tarball (node, next, rn, types)", at);
    expect(stepStart).toBeGreaterThan(0);
    expect(jobLines.slice(stepStart + 1, at).filter((l) => !isComment(l))).toEqual(["        if: steps.engine-changes.outputs.engine == 'true'"]);
    expect(jobLines[at + 1] ?? "").not.toMatch(/^ {8}\S/);
    for (const l of code) expect(l, "a job-level softener or cwd shift").not.toMatch(/^ {4}(if|continue-on-error|defaults|working-directory):|^ {8}(continue-on-error|working-directory):/);
    const engine = JSON.parse(readFileSync(resolve(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(engine.scripts["pack:proof"]).toBe("node pack-proof/run.mjs");
    expect(existsSync(resolve(REPO, "pack-proof/run.mjs"))).toBe(true);
  });

  it("gates the step on a paths-filter step that exists, with the engine's two globs (a typo'd id skips the step for ever, and a skipped step is a green job)", () => {
    const filterId = /- uses: dorny\/paths-filter@v3\n\s+id: (\S+)/.exec(job)?.[1];
    expect(filterId).toBe("engine-changes");
    expect(job).toContain(`steps.${filterId}.outputs.engine == 'true'`);
    expect(job).toMatch(/engine:\n\s+- '\*\*'\n\s+- 'pnpm-lock\.yaml'\n/);
    // paths-filter reads the PR's files through the API: it needs the pull-requests grant the `engine` job carries
    expect(job).toMatch(/permissions:\n\s+contents: read\n\s+pull-requests: read\n/);
  });

  it("installs with the pinned pnpm and Node 26 before it runs, frozen", () => {
    expect(job).toMatch(new RegExp(`pnpm/action-setup@v4\\n\\s+with:\\n\\s+version: ${(pin ?? "").replace(/\./g, "\\.")}\\n`));
    expect(job).toMatch(/actions\/setup-node@v5\n\s+with:\n\s+node-version: 26\n\s+cache: pnpm\n/);
    const install = jobLines.indexOf("      - run: pnpm install --frozen-lockfile");
    expect(install).toBeGreaterThan(0);
    expect(install).toBeLessThan(jobLines.indexOf(RUN));
    expect(job).toContain("runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}");
  });
});

// The engine job is split: `engine-shard` jobs each run a slice of the suite and upload a blob report, and `engine` (the job whose display
// name main's branch protection requires) merges them, so the coverage thresholds judge the whole suite and one required check still
// answers for all of it. What goes quietly wrong, and nothing else would notice:
//  - a required check renamed or dropped: branch protection waits for a status nobody reports, or passes without it;
//  - the aggregator SKIPPED when a shard fails (a bare `needs`): GitHub counts a skipped required check as passing, so the PR would show
//    one red job that is not required, and merge;
//  - a shard missing from the matrix (`shard: [1, 2]` of three): its files run nowhere, and their tests are never asked;
//  - a shard that uploads nothing, or a merge over fewer blobs than shards: coverage judged on a suite with a slice missing;
//  - the golden-ledger check run where no test ran: `git status` in a fresh checkout is clean whatever the suite did.
describe("engine shard CI wiring (the engine job split into engine-shard jobs and an aggregating engine job)", () => {
  const jobs = jobsOf(ci);
  const shard = jobs["engine-shard"] ?? "";
  const agg = jobs.engine ?? "";
  const isComment = (l: string) => /^\s*#/.test(l);
  const codeOf = (job: string) => job.split("\n").filter((l) => !isComment(l));
  /** The four checks main's branch protection requires, by display name (`gh api repos/onryde/seazn.club.engine/branches/main/protection/
   *  required_status_checks --jq .contexts`, 2026-11-10). Typed here: ci.yml cannot be asked what it must keep reporting. */
  const REQUIRED = [
    "Typecheck + lint + drift gates",
    "Engine coverage + golden ledgers + sim matrix",
    "Engine packed-tarball proof",
    "Changeset present, and its bump covers the fold tables",
  ];
  const SHARD_RUN =
    "        run: pnpm test:coverage --reporter=default --reporter=github-actions --reporter=blob --coverage.reporter=text-summary --shard=${{ matrix.shard }}/${{ strategy.job-total }}";
  const GATE = "Every engine shard succeeded";
  const BLOBS = "The shards' blob reports are all here";
  const MERGE = "        run: pnpm exec vitest run --merge-reports --coverage";
  const GOLDEN = "Golden ledgers left as committed";
  const sh = (script: string, opts: { cwd?: string; env?: Record<string, string> } = {}) =>
    spawnSync("bash", ["-c", script], { cwd: opts.cwd ?? REPO, encoding: "utf8", timeout: SPAWN_MS, env: { ...process.env, ...opts.env } });

  it("reads the jobs it asserts about (never an empty set): both halves of the split exist, and both are in the job list", () => {
    expect(Object.keys(jobs)).toEqual(expect.arrayContaining(["gates", "engine-shard", "engine", "engine-pack", "changeset"]));
    expect(shard.length).toBeGreaterThan(0);
    expect(agg.length).toBeGreaterThan(0);
  });

  it("every required check's display name is reported by exactly one job, and the shard jobs are not among them", () => {
    const names = ci.split("\n").filter((l) => /^ {4}name: /.test(l)).map((l) => l.replace(/^ {4}name: /, ""));
    expect(names.length).toBeGreaterThanOrEqual(REQUIRED.length + 1);
    for (const r of REQUIRED) expect(names.filter((n) => n === r), `required check "${r}"`).toHaveLength(1);
    expect(agg).toContain("    name: Engine coverage + golden ledgers + sim matrix\n");
    expect(shard).toContain("    name: Engine shard ${{ matrix.shard }}/${{ strategy.job-total }}\n");
    // a shard's name never collides with a required one: the required-check contexts are matched by name
    for (const n of names.filter((x) => x.startsWith("Engine shard "))) expect(REQUIRED).not.toContain(n);
  });

  it("the matrix is shards 1..N in order with N of at least 2, and a failed shard does not cancel its siblings", () => {
    const m = /^ {8}shard: \[([\d, ]+)\]$/m.exec(shard);
    expect(m, "a one-line `shard: [1, 2, ...]` matrix").not.toBeNull();
    const ids = (m?.[1] ?? "").split(",").map((x) => Number(x.trim()));
    expect(ids.length, `the matrix runs ${ids.length} shards`).toBeGreaterThanOrEqual(2);
    // a gap (or a repeat) leaves a slice of the suite running nowhere, or twice; `--shard=i/N` takes N from the matrix, below
    expect(ids).toEqual(Array.from({ length: ids.length }, (_, i) => i + 1));
    expect(shard.match(/^ {6}fail-fast: false$/gm)).toHaveLength(1);
  });

  it("runs its slice as the engine's coverage script with the blob reporter, once, with N taken from the matrix and nothing that softens it", () => {
    const code = codeOf(shard);
    expect(code.filter((l) => l.includes("pnpm test:coverage"))).toEqual([SHARD_RUN]);
    const at = shard.split("\n").indexOf(SHARD_RUN);
    expect(at).toBeGreaterThan(0);
    // no key beneath it (`env:`, `continue-on-error:`, `working-directory:`), and no job-level softener or cwd shift
    expect(shard.split("\n")[at + 1] ?? "").toMatch(/^ {6}(- |#)/);
    for (const l of code) expect(l, "a softener or cwd shift").not.toMatch(/^ {4}(if|continue-on-error|defaults|working-directory):|^ {8}(continue-on-error|working-directory):/);
    expect(shard).not.toMatch(/\|\| (true|:)/);
    // the script is what turns coverage on: a shard without it writes a blob with no coverage in it
    const pkg = JSON.parse(readFileSync(resolve(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["test:coverage"]).toBe("vitest run --coverage");
  });

  it("uploads the blob report: hidden directory included, and a shard that wrote none is a red, not an empty artifact", () => {
    const upload = stepOf(shard, "Upload the blob report");
    expect(upload.body).toContain("        uses: actions/upload-artifact@v4\n");
    expect(upload.body).toContain("          name: vitest-blob-${{ matrix.shard }}\n");
    expect(upload.body).toContain("          path: .vitest-reports/\n");
    expect(upload.body).toContain("          include-hidden-files: true\n");
    expect(upload.body).toContain("          if-no-files-found: error\n");
    expect(upload.keys).not.toContain("if");
    expect(upload.keys).not.toContain("continue-on-error");
    // after the suite, never before it
    expect(shard.indexOf("- name: Upload the blob report")).toBeGreaterThan(shard.indexOf(SHARD_RUN));
  });

  it("checks the golden ledgers in the SHARD, after the slice that could rewrite them ran, and not in the aggregator, where nothing ran", () => {
    const golden = stepOf(shard, GOLDEN);
    expect(golden.keys).toEqual(["name", "run"]);
    expect(shard.indexOf(`- name: ${GOLDEN}`)).toBeGreaterThan(shard.indexOf(SHARD_RUN));
    expect(shard.indexOf(`- name: ${GOLDEN}`)).toBeLessThan(shard.indexOf("- name: Upload the blob report"));
    expect(agg, "a golden check in the job that ran no test is clean whatever the suite did").not.toContain(GOLDEN);
    expect(agg).not.toContain(".golden.json");
    // and the script, run the way CI runs it, answers both ways: in a scratch repository whose ledger is as committed, and whose ledger was rewritten
    const dir = mkdtempSync(join(tmpdir(), "golden-step-"));
    try {
      const git = (...a: string[]) => spawnSync("git", ["-C", dir, "-c", "user.email=ci@example.invalid", "-c", "user.name=CI", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8", timeout: SPAWN_MS });
      expect(git("init", "-q").status).toBe(0);
      mkdirSync(join(dir, "src/sports"), { recursive: true });
      writeFileSync(join(dir, "src/sports/a.golden.json"), "{}\n");
      writeFileSync(join(dir, "b.golden.json"), "{}\n");
      expect(git("add", "-A").status).toBe(0);
      expect(git("commit", "-q", "-m", "x").status).toBe(0);
      const clean = sh(golden.script ?? "", { cwd: dir });
      expect(clean.status, clean.stdout + clean.stderr).toBe(0);
      expect(clean.stdout).toContain("golden ledgers: 2 committed, none changed");
      writeFileSync(join(dir, "src/sports/a.golden.json"), '{"rewritten":true}\n');
      const dirty = sh(golden.script ?? "", { cwd: dir });
      expect(dirty.status, "a rewritten ledger is a red").toBe(1);
      expect(dirty.stdout).toContain("src/sports/a.golden.json");
      // a ledger created by the run and never committed is drift too
      writeFileSync(join(dir, "src/sports/a.golden.json"), "{}\n");
      writeFileSync(join(dir, "src/sports/new.golden.json"), "{}\n");
      expect(sh(golden.script ?? "", { cwd: dir }).status, "an untracked ledger is a red").toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, spawnBudget(8));

  it("the aggregator needs the shards, runs even when one failed, and turns any shard result but success into ITS OWN red", () => {
    const head = agg.split("\n").slice(0, agg.split("\n").indexOf("    steps:"));
    const headCode = head.filter((l) => !isComment(l));
    expect(headCode).toContain("    needs: engine-shard");
    // not a bare `needs`: a skipped required check counts as passing in branch protection. Not `always()` either: a CANCELLED run
    // (a superseded PR push) leaves nothing to judge. The gate step below answers for the shards' results either way.
    expect(headCode).toContain("    if: ${{ !cancelled() }}");
    expect(headCode.filter((l) => /^ {4}(continue-on-error|defaults|working-directory):/.test(l))).toEqual([]);
    // the gate is the FIRST step, ahead of the checkout, so a red shard costs this job seconds
    expect(stepHeads(agg)[0]).toBe(`      - name: ${GATE}`);
    const gate = stepOf(agg, GATE);
    expect(gate.keys).toEqual(["name", "env", "run"]);
    expect(gate.body).toContain("          SHARDS: ${{ needs.engine-shard.result }}\n");
    // the script, run as CI runs it, for every result a needs context can hold
    const results: Array<[string, number]> = [["success", 0], ["failure", 1], ["cancelled", 1], ["skipped", 1], ["", 1]];
    for (const [result, status] of results) {
      const r = sh(gate.script ?? "", { env: { SHARDS: result } });
      expect(r.status, `shards '${result}': ${r.stdout}${r.stderr}`).toBe(status);
      if (status === 1) expect(r.stdout + r.stderr, "the red names itself").toContain("::error::");
    }
    expect(results.length).toBe(5);
  }, spawnBudget(5));

  it("downloads exactly the shards' artifacts into the directory vitest merges from, then refuses a set with a shard missing", () => {
    const upload = stepOf(shard, "Upload the blob report");
    const name = /name: (vitest-blob-)\$\{\{ matrix\.shard \}\}/.exec(upload.body)?.[1];
    expect(name).toBe("vitest-blob-");
    const download = stepOf(agg, "Download the blob reports");
    expect(download.body).toContain("        uses: actions/download-artifact@v4\n");
    expect(download.body).toContain("          pattern: vitest-blob-*\n");
    expect(download.body).toContain("          merge-multiple: true\n");
    expect(`${download.body}\n`).toContain("          path: .vitest-reports\n");
    expect(download.keys).not.toContain("if");
    // the blob reporter writes `.vitest-reports/blob-<i>-<N>.json` for `--shard=i/N`: the guard reads those names
    const guard = stepOf(agg, BLOBS);
    expect(guard.keys).toEqual(["name", "run"]);
    const run = (files: string[]) => {
      const dir = mkdtempSync(join(tmpdir(), "blob-guard-"));
      try {
        mkdirSync(join(dir, ".vitest-reports"));
        for (const f of files) writeFileSync(join(dir, ".vitest-reports", f), "[]");
        return sh(guard.script ?? "", { cwd: dir });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    const CASES: Array<[string, string[], number]> = [
      ["all three", ["blob-1-3.json", "blob-2-3.json", "blob-3-3.json"], 0],
      ["all two", ["blob-1-2.json", "blob-2-2.json"], 0],
      ["none (zero checked is a failure)", [], 1],
      ["the last of three missing", ["blob-1-3.json", "blob-2-3.json"], 1],
      ["the first of three missing", ["blob-2-3.json", "blob-3-3.json"], 1],
      ["a lone blob of a suite that was not split", ["blob.json"], 1],
      ["one shard of one", ["blob-1-1.json"], 1],
      ["a stray from another split", ["blob-1-3.json", "blob-2-3.json", "blob-3-3.json", "blob-1-4.json"], 1],
      // the count of blobs is right and a shard is still missing: only the per-index check sees it
      ["a stray from another split in a missing shard's place", ["blob-1-3.json", "blob-2-3.json", "blob-3-4.json"], 1],
    ];
    for (const [what, files, status] of CASES) {
      const r = run(files);
      expect(r.status, `${what}: ${r.stdout}${r.stderr}`).toBe(status);
      if (status === 1) expect(r.stdout + r.stderr, "the red names itself").toContain("::error::");
      if (status === 0) expect(r.stdout, "it says what it checked").toMatch(/^\d+ blob reports, 1\.\.\d+ all present$/m);
    }
    expect(CASES.filter(([, , s]) => s === 0).length).toBeGreaterThan(1);
    expect(CASES.filter(([, , s]) => s === 1).length).toBeGreaterThan(4);
  }, spawnBudget(8));

  it("merges the blobs with the coverage gate ON: no --shard, no threshold override, nothing advisory, after the guard and before the sim matrix", () => {
    const code = codeOf(agg);
    expect(code.filter((l) => l.includes("--merge-reports"))).toEqual([MERGE]);
    const lines = agg.split("\n");
    const at = lines.indexOf(MERGE);
    expect(at).toBeGreaterThan(0);
    expect(lines[at + 1] ?? "").toMatch(/^ {6}(- |#)/);
    const mergeStep = lines.lastIndexOf("      - name: Merge the shards' reports and judge the coverage thresholds on the whole suite", at);
    expect(mergeStep, "the merge step is named").toBeGreaterThan(0);
    expect(lines.slice(mergeStep + 1, at).filter((l) => !isComment(l))).toEqual([]);
    for (const l of code) {
      expect(l, "the aggregator runs no slice").not.toMatch(/--shard/);
      expect(l, "a flag that moves a threshold").not.toMatch(/--coverage\.thresholds|--coverage\.(skipFull|clean)\b|--passWithNoTests|--no-coverage/);
    }
    expect(agg).not.toMatch(/\|\| (true|:)/);
    expect(at).toBeGreaterThan(lines.indexOf(`      - name: ${BLOBS}`));
    expect(lines.indexOf(`      - name: ${BLOBS}`)).toBeGreaterThan(lines.indexOf("      - name: Download the blob reports"));
    expect(at).toBeLessThan(lines.indexOf("      - name: Sim matrix (bounded CI profile)"));
  });

  it("keeps the sim matrix and its artifacts in the aggregator, as before", () => {
    const sim = stepOf(agg, "Sim matrix (bounded CI profile)");
    expect(sim.keys).toEqual(["name", "run"]);
    expect(`${sim.body}\n`).toContain("        run: SIM_SEEDS=5 pnpm sim:matrix\n");
    const report = stepOf(agg, "Sim report artifact");
    expect(report.body).toContain("        if: always()\n");
    expect(report.body).toContain("          path: sim-report.json\n");
    const failures = stepOf(agg, "Simulation failure artifacts (repro with `pnpm sim:replay -- <seedToken>`)");
    expect(failures.body).toContain("        if: failure()\n");
    expect(failures.body).toContain("          path: sim-failures/\n");
  });

  it("both halves install with the pinned pnpm and Node 26, frozen, on the repository's runner, and read the full history", () => {
    const root = JSON.parse(readFileSync(resolve(REPO, "package.json"), "utf8")) as { packageManager: string };
    const pin = /^pnpm@(\d+\.\d+\.\d+)$/.exec(root.packageManager)?.[1] ?? "";
    expect(pin).not.toBe("");
    for (const [what, job] of [["engine-shard", shard], ["engine", agg]] as const) {
      expect(job, what).toMatch(new RegExp(`pnpm/action-setup@v4\\n\\s+with:\\n\\s+version: ${pin.replace(/\./g, "\\.")}\\n`));
      expect(job, what).toMatch(/actions\/setup-node@v5\n\s+with:\n\s+node-version: 26\n\s+cache: pnpm\n/);
      expect(job, what).toContain("runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}");
      expect(job, what).toMatch(/actions\/checkout@v5\n\s+# [^\n]*\n(\s+#[^\n]*\n)*\s+with:\n\s+fetch-depth: 0\n/);
      const install = job.split("\n").indexOf("      - run: pnpm install --frozen-lockfile");
      expect(install, what).toBeGreaterThan(0);
    }
    // the shard's install is before its suite; the aggregator's, before the merge
    expect(shard.split("\n").indexOf("      - run: pnpm install --frozen-lockfile")).toBeLessThan(shard.split("\n").indexOf(SHARD_RUN));
    expect(agg.split("\n").indexOf("      - run: pnpm install --frozen-lockfile")).toBeLessThan(agg.split("\n").indexOf(MERGE));
  });
});
