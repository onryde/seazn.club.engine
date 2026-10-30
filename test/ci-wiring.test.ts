// Moved from onryde/seazn.club@5a67fbf37d25675c683bbc91785bba5bacd93714:tools/matrix/__tests__/ci-wiring.test.ts (engine-split 2b Task E1; reverse
// inventory rows 18 and 29): the "Stryker floor CI wiring", "fold-epoch guard CI wiring" and "engine-pack CI wiring" describes,
// which pin the engine's own CI steps. Titles and assertions are verbatim; only paths are re-rooted (the engine is this repository's
// root: `packages/engine/<x>` reads `<x>`, the pnpm path filter `./packages/engine` is `.`). The ledger is
// onryde/seazn.club docs/superpowers/specs/engine-split/ledgers/2b.json. Comments below are the source's, unedited.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SPAWN_MS, spawnBudget } from "./spawn-budget.ts";
import { jobsOf } from "./workflow-text.ts";

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
    const corpora = (readdirSync(resolve(REPO, "src/sports"), { recursive: true }) as string[]).filter((f) => f.endsWith(".golden.json")).length;
    expect(corpora).toBeGreaterThan(0);
    const m = /^fold-epoch: (\d+) sports checked, (\d+) streams compared against HEAD: 0 violation\(s\), STATS_FOLD_VERSION (\d+) -> (\d+)$/m.exec(r.stdout);
    expect(m, r.stdout).not.toBeNull();
    expect(Number(m?.[1])).toBe(corpora);
    expect(Number(m?.[2])).toBeGreaterThanOrEqual(corpora);
    // GF-3 T1: the summary also carries the stats version, base -> tree; HEAD and this tree are the same commit, and the number is what
    // src/stats/stats.ts declares (read here by its declaration line: the engine's own, not the guard's output)
    const declared = /^export const STATS_FOLD_VERSION = (\d+);$/m.exec(readFileSync(resolve(REPO, "src/stats/stats.ts"), "utf8"))?.[1];
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
