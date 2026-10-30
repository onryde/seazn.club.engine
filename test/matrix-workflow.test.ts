// Moved from onryde/seazn.club@5a67fbf37d25675c683bbc91785bba5bacd93714:tools/matrix/__tests__/matrix-workflow.test.ts (engine-split 2b Task E1; reverse
// inventory row 17): the 42 tests that pin mutation.yml (the "both workflows run on the switchable runner" describe and every
// describe from "mutation.yml and the runner wiring" on), with the module-level helpers they use, copied unedited (REPO, the
// workflow reads, the scratch directory, SAME_REPO, ifOf/evalIf/evalExpr/ctxOf, permissionBlocks). Titles and assertions are
// verbatim; only paths are re-rooted: the engine is this repository's root, so a repo path `packages/engine/<x>` is `<x>`, the
// engine directory `packages/engine` is `.`, and the pnpm path filter `./packages/engine...` is `....`. Three of the tests compare
// mutation.yml with matrix-truth.yml, which stays in onryde/seazn.club. The ledger is onryde/seazn.club
// docs/superpowers/specs/engine-split/ledgers/2b.json. Comments below are the source's, unedited.
/* eslint-disable @typescript-eslint/no-implied-eval, @typescript-eslint/no-unnecessary-type-assertion -- the body is moved
   verbatim: onryde/seazn.club lints tools/matrix with its scripts/ config, which runs neither rule; evalExpr's Function is
   restricted to the workflow's own committed text by its token whitelist. */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type * as TS from "typescript";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { SPAWN_MS, spawnBudget } from "./spawn-budget.ts";
import { jobsOf, stepHeads, stepOf } from "./workflow-text.ts";
import { resolveGroup } from "../scripts/stryker-cuts.mjs";
import { STRYKER_FAMILIES, STRYKER_GROUPS } from "../stryker.groups.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS = join(REPO, ".github/workflows");
const WF = readFileSync(join(WORKFLOWS, "matrix-truth.yml"), "utf8");
const JOBS = jobsOf(WF);                               // job name → that job's text
const GUARD = "Visibility guard (design §6.4; R14a)";
// Task 20 pre-step, carry (b): the refusal said "Matrix truth run refused ... Sharded matrix runs", which is matrix-truth.yml's
// name for itself, on a Stryker run. mutation.yml's guard is matrix-truth's script in every line but that message.
const MATRIX_TRUTH_REFUSAL = "Matrix truth run refused::repository visibility is '${vis:-unreadable}'. Sharded matrix runs are free only while the repo is public (design §6.4); refusing before any minute is spent. Set vars.MATRIX_RUNNER to a self-hosted runner label to run them privately (ruling 68).";
const STRYKER_REFUSAL = "Stryker mutation run refused::repository visibility is '${vis:-unreadable}'. The Stryker mutation workflow (mutation.yml) runs one hosted job per group, and those minutes are free only while the repo is public (design §6.4); refusing before any minute is spent. Set vars.MATRIX_RUNNER to a self-hosted runner label to run it privately (ruling 68).";

const scratch = mkdtempSync(join(tmpdir(), "w1d-wf-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => { vi.restoreAllMocks(); });
let seq = 0;
const fresh = (label: string): string => { const d = join(scratch, `${label}-${++seq}`); mkdirSync(d, { recursive: true }); return d; };

const SAME_REPO = "onryde/seazn.club";

/** `if:` expression of a job, from its own text; throws when the job has none (a gate that is not there reds, never reads as open). */
function ifOf(jobText: string): string {
  const m = /^ {4}if:\s*(\S.*)$/m.exec(jobText);
  if (m === null) throw new Error("the job has no `if:`");
  return m[1]!.trim();
}

/** A workflow `if:` evaluated against a context. It handles exactly what these workflows spell — context paths, `==`, `!=`, `&&`,
 *  `||`, `!`, string literals and the status functions — and throws on anything else, so a new construct is a red here rather than a
 *  silent misreading. A missing context path is null, as in GitHub. */
function evalIf(raw: string, ctx: Record<string, unknown>, cancelled = false): boolean {
  return Boolean(evalExpr(raw, ctx, cancelled));
}
/** The VALUE of one expression, by the same rules (`&&` and `||` return an operand, as in GitHub's expressions, which is what makes
 *  `cond && a || b` a ternary, and both short-circuit, so `plan.result == 'success' && fromJSON(plan output)` never parses an
 *  output a skipped plan did not write). The functions it knows: the status functions, `fromJSON(ref).a.*.b` (an object filter),
 *  `join` and `format`; anything else throws. */
function evalExpr(raw: string, ctx: Record<string, unknown>, cancelled = false): unknown {
  const expr = raw.trim().replace(/^\$\{\{\s*/, "").replace(/\s*\}\}$/, "");
  const js = expr
    .replace(/\b(github|vars|needs|inputs|steps)((?:\.[A-Za-z_][\w-]*)+)/g, (_m, root: string, path: string) => `ref(${JSON.stringify(root + path)})`)
    .replace(/fromJSON\((ref\("[^"]*"\))\)((?:\.[A-Za-z_*][\w-]*)+)/g, (_m, arg: string, path: string) => `fj(${arg}, ${JSON.stringify(path)})`)
    .replace(/fromJSON\((ref\("[^"]*"\))\)/g, (_m, arg: string) => `fj(${arg}, "")`);
  const bare = js.replace(/"[^"]*"|'[^']*'/g, '""');   // the whitelist is read with string contents out, so `*` and `{0}` may sit in a literal
  if (!/^[\s\w"'.()!=&|,-]*$/.test(bare) || /\b(?!always\b|cancelled\b|success\b|ref\b|fj\b|join\b|format\b)\w+\s*\(/.test(bare)) throw new Error(`evalIf: unsupported syntax in: ${expr}`);
  const ref = (path: string): unknown => {
    let at: unknown = ctx;
    for (const k of path.split(".")) { if (at === null || typeof at !== "object") return null; at = (at as Record<string, unknown>)[k] ?? null; }
    return at;
  };
  // fromJSON(text).a.b, and .a.*.b = that field of every item of `a` (what the workflow's LEGS spells)
  const fj = (text: unknown, path: string): unknown => {
    let at: unknown = JSON.parse(String(text));
    const segs = path.split(".").filter((x) => x !== "");
    for (const [i, k] of segs.entries()) {
      if (k === "*") {
        const items = Array.isArray(at) ? at : Object.values(at as object);
        return items.map((item: unknown) => segs.slice(i + 1).reduce<unknown>((a, key) => (a === null || typeof a !== "object" ? null : ((a as Record<string, unknown>)[key] ?? null)), item));
      }
      at = at === null || typeof at !== "object" ? null : ((at as Record<string, unknown>)[k] ?? null);
    }
    return at;
  };
  const join = (items: unknown, sep: string): string => (Array.isArray(items) ? items.join(sep) : String(items));
  const format = (fmt: string, ...args: unknown[]): string => fmt.replace(/\{(\d+)\}/g, (_m, n: string) => String(args[Number(n)]));
  // The expression is this repo's own committed workflow text, restricted to the token whitelist above.
  return new Function("ref", "fj", "join", "format", "always", "cancelled", "success", `return (${js});`)(ref, fj, join, format, () => true, () => cancelled, () => !cancelled);
}
const ctxOf = (o: { event: string; head?: string | null; weekly?: string; planResult?: string; scope?: string; headRef?: string; runId?: string; prNumber?: number; matrix?: string }) => ({
  github: { event_name: o.event, repository: SAME_REPO, head_ref: o.headRef ?? "", run_id: o.runId ?? "1", event: o.event === "pull_request" ? { pull_request: { number: o.prNumber ?? 1, head: { repo: o.head === null ? null : { full_name: o.head ?? SAME_REPO } } } } : {} },
  vars: { MATRIX_WEEKLY_ENABLED: o.weekly ?? "true" },
  inputs: { scope: o.scope ?? "" },
  needs: { plan: { result: o.planResult ?? "success", outputs: { matrix: o.matrix ?? "" } }, "matrix-rows": { outputs: { run: "true" } } },
});

/** Every `permissions:` block of a workflow's text: its line, the scalar form (`permissions: write-all`) or null, and its key→value entries. */
function permissionBlocks(text: string): { line: number; scalar: string | null; entries: Record<string, string> }[] {
  const lines = text.split("\n");
  const out: { line: number; scalar: string | null; entries: Record<string, string> }[] = [];
  lines.forEach((l, i) => {
    const m = /^(\s*)permissions:\s*([^#\s].*?)?\s*(?:#.*)?$/.exec(l);
    if (m === null) return;
    const entries: Record<string, string> = {};
    if (m[2] === undefined) {
      for (const next of lines.slice(i + 1)) {
        if (next.trim() === "" || next.trim().startsWith("#")) continue;
        if (next.length - next.trimStart().length <= m[1]!.length) break;
        const kv = /^\s+([\w-]+):\s*(\S+)/.exec(next);
        if (kv !== null) entries[kv[1]!] = kv[2]!;
      }
    }
    out.push({ line: i + 1, scalar: m[2] ?? null, entries });
  });
  return out;
}

// --- mutation.yml (W1d Task 15; rulings 66, 67, 68; D14) ----------------------------------------------------------------
// Held by text like matrix-truth.yml, and where a step's logic lives in its `run:` the block is RUN for real, with `pnpm`
// stood in on the PATH: what is proven is the YAML's own wiring (the flags it passes, the exit code it keeps, the files it
// reads) against the real engine CLIs, never a copy of the command kept in the test. They live here, not in Task 9's block,
// because they read mutation.yml and stryker.groups.mjs, which Task 15 creates (a read in a `describe` body fails the whole
// file at collection).
const MUT = readFileSync(join(WORKFLOWS, "mutation.yml"), "utf8");
const MJOBS = jobsOf(MUT);
/** The `matrix=` value the plan job's "Derive the matrix" step really writes for an event and a dispatch group: the step's own
 *  command run through bash against stryker-matrix.mjs. It is what `needs.plan.outputs.matrix` holds for the jobs after it. */
function planMatrix(event: string, group: string): string {
  const out = join(fresh("plan-out"), "github-output");
  writeFileSync(out, "");
  const r = spawnSync("bash", ["-c", runLine(MJOBS.plan!, "Derive the matrix")], { cwd: REPO, encoding: "utf8", timeout: SPAWN_MS, env: { PATH: process.env.PATH ?? "", GITHUB_OUTPUT: out, EVENT: event, GROUP: group } });
  if (r.status !== 0) throw new Error(`the plan step refused EVENT=${event} GROUP=${group}: ${r.stderr}`);
  const lines = readFileSync(out, "utf8").split("\n").filter(Boolean);
  if (lines.length !== 1 || !lines[0]!.startsWith("matrix=")) throw new Error(`the plan step wrote ${JSON.stringify(lines)}`);
  return lines[0]!.slice("matrix=".length);
}
const ENGINE_DIR = join(REPO, ".");
const enginePkg = JSON.parse(readFileSync(join(ENGINE_DIR, "package.json"), "utf8")) as { scripts: Record<string, string> };

describe("both workflows run on the switchable runner (ruling 68, D24)", () => {
  it("every job of matrix-truth.yml AND mutation.yml runs on the switchable runner (ruling 68, D24), and has a timeout-minutes", () => {
    for (const [file, text] of [["matrix-truth.yml", WF], ["mutation.yml", MUT]] as const) {
      const jobs = Object.entries(jobsOf(text));
      expect(jobs.length, file).toBeGreaterThan(1);   // anti-vacuity
      for (const [name, t] of jobs) {
        expect(t, `${file}:${name} runs-on`).toContain("runs-on: ${{ vars.MATRIX_RUNNER || 'ubuntu-latest' }}");
        expect(t, `${file}:${name} timeout-minutes`).toMatch(/timeout-minutes:/);
      }
    }
  });
});

describe("mutation.yml and the runner wiring (review 5: R5-I1, m2, m3; moved here by review 6, R6-I1)", () => {
  it("every guard step of BOTH workflows takes RUNNER_ENV from runner.environment, never a literal (the one line that decides whether private hosted minutes can be billed)", () => {
    const all = [...Object.values(JOBS), ...Object.values(MJOBS)];
    expect(all.length).toBeGreaterThan(4);   // anti-vacuity: matrix-truth's four plus mutation's
    for (const t of all) expect(stepOf(t, GUARD).body).toContain("RUNNER_ENV: ${{ runner.environment }}");
  });
  it("the mutate job does not cancel its siblings, takes its timeout from the matrix, and saves its evidence even when Stryker exits non-zero (R5-I1)", () => {
    expect(MJOBS.mutate).toContain("matrix: ${{ fromJSON(needs.plan.outputs.matrix) }}");
    expect(MJOBS.mutate).toContain("fail-fast: false");
    expect(MJOBS.mutate).toContain("timeout-minutes: ${{ matrix.timeout }}");
    for (const n of ["Survivors", "Upload mutation results"]) expect(stepOf(MJOBS.mutate!, n).body).toContain("if: always()");
  });
  it("the mutate job runs at most 12 legs at a time, next to fail-fast: false: the leg fan-out cannot take every hosted slot of the org (T20-FIX1, I1)", () => {
    // Ruling T20-FIX1: the org is on GitHub's Free plan (about 20 concurrent hosted jobs, account-wide), and a `group=all` dispatch
    // queues one job per leg (81 legs, about 1.3 hours each, since the first full run's slow legs were cut again and every part ran). Without a cap it holds
    // every slot for about 6.8 hours while ci.yml's PR runs (13-16 jobs) and e2e.yml's push fan-out (11 jobs) wait behind it. The
    // value is the owner's choice (12): a PR run may partly queue, and a dispatch takes about 10.1 hours instead of about 14.1 at 8
    // (derived from the measured walls by packages/engine/test/stryker-sizing.test.ts). A literal integer, never an expression:
    // the number is the thing this pin names, and an input or a variable would let a dispatch lift it unseen.
    const strategy = /\n {4}strategy:\n((?: {6}\S.*\n)+)/.exec(`${MJOBS.mutate!}\n`);
    expect(strategy, "the mutate job has a strategy block").not.toBeNull();
    const keys = new Map<string, string>();
    for (const line of strategy![1]!.split("\n")) {
      const m = /^ {6}([a-z-]+):\s*(.*?)\s*(?:#.*)?$/.exec(line);
      if (m) keys.set(m[1]!, m[2]!);
    }
    expect([...keys.keys()].sort(), "the strategy holds exactly these keys").toEqual(["fail-fast", "matrix", "max-parallel"]);
    expect(keys.get("fail-fast")).toBe("false");
    expect(keys.get("max-parallel"), "a literal integer, not an expression").toMatch(/^\d+$/);
    expect(keys.get("max-parallel"), "the cap, 12").toBe("12");
    // the cap is on the job that fans out and nowhere else (plan and floors are single jobs: a cap there would mean nothing)
    for (const n of ["plan", "floors"]) expect(MJOBS[n], `${n} has no matrix to cap`).not.toContain("max-parallel");
    expect(Object.keys(MJOBS).length, "all three jobs were read").toBe(3);
  });
  // Split out of packages/engine/test/stryker-sizing.test.ts (engine-split 1d-1, spec §5.4 / R20): the engine's test keeps the half that reads
  // mutation.yml; this half reads THIS file, which sits outside the package. The figures are about the org's shared hosted slots, not about runner sharing.
  it("the fan-out figures this file quotes (legs, hours each, a dispatch's wall at the org's slots, at 12, at 8) are the ones the measured walls give (T20 review M1)", () => {
    interface Measured { run: { maxParallel: number }; measured: Record<string, { wallSeconds: number }>; split: Record<string, { parts: Record<string, { basis: string; wallSeconds?: number }> }> }
    const measured = JSON.parse(readFileSync(join(REPO, "stryker-measured.json"), "utf8")) as Measured;
    /** The org's concurrent hosted jobs, account-wide (GitHub Free; ruling T20-FIX1): what an uncapped dispatch can hold. */
    const ORG_SLOTS = 20;
    /** A leg's wall in minutes, as its own job measured it: a part cut after the first run was RUN since (`basis: measured`), any other leg is the first run's.
     *  A leg timed from a projection, or one the data does not hold, has no wall to quote: refused by name, never read as zero. */
    const wallMinutesIn = (data: Measured, leg: string): number => {
      for (const split of Object.values(data.split)) {
        const part = split.parts[leg];
        if (part === undefined) continue;
        if (part.basis !== "measured" || part.wallSeconds === undefined) throw new Error(`${leg} is timed from a projection, not a measured wall: run it and record it in stryker-measured.json`);
        return part.wallSeconds / 60;
      }
      const m = data.measured[leg];
      if (m === undefined) throw new Error(`${leg} is neither measured nor a part of a leg that was`);
      return m.wallSeconds / 60;
    };
    // the refusals are reached, each by its own fixture row: a part on a pace (even one that carries a wall), a measured part with no wall, and a leg the data does not hold
    const fixture: Measured = {
      run: { maxParallel: 1 }, measured: { whole: { wallSeconds: 120 } },
      split: { cut: { parts: { "cut-1": { basis: "measured", wallSeconds: 60 }, "cut-2": { basis: "rate", wallSeconds: 999 }, "cut-3": { basis: "measured" } } } },
    };
    expect([wallMinutesIn(fixture, "whole"), wallMinutesIn(fixture, "cut-1")]).toEqual([2, 1]);
    expect(() => wallMinutesIn(fixture, "cut-2")).toThrow(/cut-2 is timed from a projection/);
    expect(() => wallMinutesIn(fixture, "cut-3")).toThrow(/cut-3 is timed from a projection/);
    expect(() => wallMinutesIn(fixture, "nowhere")).toThrow(/nowhere is neither measured/);
    const order = Object.keys(STRYKER_GROUPS).filter((g) => g !== "probe");
    const walls = order.map((g) => wallMinutesIn(measured, g));
    /** The wall of a queue served first come first served by `slots` runners, in hours (a job takes the slot that frees first). */
    const fifoHours = (minutes: readonly number[], slots: number): number => {
      const free = new Array<number>(slots).fill(0);
      for (const m of minutes) {
        const at = free.indexOf(Math.min(...free));
        free[at] = (free[at] as number) + m;
      }
      return Math.max(...free) / 60;
    };
    const hours = (h: number): string => String(Math.round(h * 10) / 10);
    const jobHours = walls.reduce((n, m) => n + m, 0) / 60;
    const figure = { legs: order.length, each: hours(jobHours / order.length), all: hours(fifoHours(walls, ORG_SLOTS)), at12: hours(fifoHours(walls, measured.run.maxParallel)), at8: hours(fifoHours(walls, 8)) };
    expect(figure.legs, "legs in a dispatch of `all`").toBe(81);
    // the figures differ from one another, so a note that quoted one for another would be wrong
    expect(new Set([figure.all, figure.at12, figure.at8]).size, "three different walls").toBe(3);
    // This file's own text. Its expected phrases below are built from the derived figures, so none of them is a literal in this file that the read could find in itself.
    const own = readFileSync(fileURLToPath(import.meta.url), "utf8");
    for (const phrase of [`${figure.legs} legs, about ${figure.each} hours each`, `for about ${figure.all} hours`, `takes about ${figure.at12} hours instead of about ${figure.at8} at 8`]) {
      expect(own, `matrix-workflow.test.ts quotes "${phrase}"`).toContain(phrase);
    }
  });
  it("the dispatch `group` choices are `all` plus exactly STRYKER_GROUPS's keys, in declaration order (m2)", () => {
    // a trailing `# comment` on an option line is stripped (review 6, m4)
    const opts = /group:[\s\S]*?options:\n((?:\s+- .+\n)+)/.exec(MUT)![1]!.split("\n").map((l) => l.replace(/\s+#.*$/, "").replace(/^\s+- /, "").trim()).filter(Boolean);
    expect(opts).toEqual(["all", ...Object.keys(STRYKER_GROUPS)]);
    expect(opts.length).toBeGreaterThan(2);
  });
  it("mutation.yml's guard is the first step of every job, with matrix-truth's script in every line but the refusal's wording (the identical-script claim for the second workflow)", () => {
    const base = stepOf(JOBS.plan!, GUARD).script;
    expect(base).not.toBeNull();
    expect(base, "matrix-truth's script still carries its own wording, so the substitution below is a real one").toContain(MATRIX_TRUTH_REFUSAL);
    const want = base!.replace(MATRIX_TRUTH_REFUSAL, STRYKER_REFUSAL);
    expect(want).not.toBe(base);
    expect(Object.keys(MJOBS).length).toBeGreaterThan(1);
    for (const [name, t] of Object.entries(MJOBS)) {
      expect(stepHeads(t)[0], name).toBe(`      - name: ${GUARD}`);
      expect(stepOf(t, GUARD).script, name).toBe(want);
    }
  });
});

// The probe's trigger names its INPUTS one by one (2026-10-12), never a `packages/engine/stryker*` glob: that glob also took the
// RECORDED data (an equivalent recorded, a floor raised, a leg re-measured), and each such PR spent 45-60 minutes on a probe its
// change could not move. A push to main on the same inputs runs the probe too, so main holds the warm incremental file a PR's
// restore key reaches (GitHub lets a PR restore its base branch's cache, never another PR's).
/** The `paths:` filter of one trigger under `on:`, in order. */
function triggerPaths(event: "pull_request" | "push"): string[] {
  const block = triggerBlock(event);
  const list = /^ {4}paths:\n((?: {6}- "[^"]+"\n)+)/m.exec(block)?.[1];
  if (list === undefined) throw new Error(`mutation.yml's ${event} trigger has no paths list`);
  return list.split("\n").filter(Boolean).map((l) => /^ {6}- "([^"]+)"$/.exec(l)![1]!);
}
/** The text of one trigger under `on:` (its indented lines). */
function triggerBlock(event: string): string {
  const block = new RegExp(`^ {2}${event}:\\n((?: {4,}\\S.*\\n)+)`, "m").exec(MUT)?.[1];
  if (block === undefined) throw new Error(`mutation.yml has no \`${event}:\` trigger`);
  return block;
}
/** GitHub's path filter: `*` is any run of characters but `/`, `**` is any run at all. */
const globRe = (g: string): RegExp => new RegExp(`^${g.split("**").map((deep) => deep.split("*").map((t) => t.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*")}$`);
const coveredBy = (paths: readonly string[], f: string): boolean => paths.some((g) => globRe(g).test(f));
/** The engine's files named for Stryker, at its top level and in scripts/, as repo paths: what the tree holds, never typed. */
function strykerFilesInTree(): string[] {
  return [...readdirSync(ENGINE_DIR), ...readdirSync(join(ENGINE_DIR, "scripts")).map((f) => `scripts/${f}`)]
    .filter((f) => /stryker/.test(f) && statSync(join(ENGINE_DIR, f)).isFile())
    .map((f) => `${f}`);
}
/** What the probe's run and its plan REACH, read from the code, never typed: the files reached from the Stryker config (what
 *  `pnpm mutation` loads: the groups, the cuts, the runner plugin it names, the vitest config it hands the runner and the base that
 *  merges) and from the plan's script (the matrix: the legs, their timeouts and their cut fingerprints), following every STRING in
 *  their code that names a file at the engine's top level or in its scripts/ (comments are not tokens, so a note naming a file is
 *  not a reach), and the Stryker data files those strings name. The steps after Stryker (stryker-floor.ts --check-selection and
 *  --survivors) are deliberately not roots: they judge what the run produced and never change which mutants it generates or kills
 *  (the survivors step reads stryker-equivalent.json only to leave recorded equivalents out of its list). */
function probeReach(): { code: string[]; data: string[] } {
  const ts = createRequire(import.meta.url)("typescript") as typeof TS;
  const inScope = (abs: string): boolean => {
    const rel = relative(ENGINE_DIR, abs);
    return !rel.startsWith("..") && (dirname(rel) === "." || dirname(rel) === "scripts");
  };
  const code = new Set<string>();
  const data = new Set<string>();
  const queue = ["stryker.config.mjs", "scripts/stryker-matrix.mjs"].map((f) => join(ENGINE_DIR, f));
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (code.has(file)) continue;
    code.add(file);
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, false, /\.m?ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS);
    const strings: string[] = [];
    const walk = (n: TS.Node): void => {
      if (ts.isStringLiteralLike(n)) strings.push(n.text);
      ts.forEachChild(n, walk);
    };
    walk(sf);
    for (const s of strings) {
      // relative to the file (an import, `new URL("../x", import.meta.url)`), to the engine (Stryker's cwd: `configFile`, `plugins`)
      // and to the repository (a path a message spells)
      for (const abs of new Set([resolve(dirname(file), s), resolve(ENGINE_DIR, s), resolve(REPO, s)])) {
        if (!inScope(abs) || !existsSync(abs) || !statSync(abs).isFile()) continue;
        if (abs.endsWith(".json")) { if (/stryker/.test(basename(abs))) data.add(relative(REPO, abs)); }
        else if (/\.m?[jt]s$/.test(abs)) queue.push(abs);
      }
    }
  }
  return { code: [...code].map((f) => relative(REPO, f)).sort(), data: [...data].sort() };
}
/** The Stryker data files that RECORD results and never decide what the probe runs: a PR that edits only these must not spend
 *  45-60 minutes on the probe. Each is named by nothing on the probe's path (probeReach), which the test below holds. */
const RECORDED_DATA: Record<string, string> = {
  "stryker-equivalent.json": "mutants a reviewer judged equivalent: stryker-floor.ts leaves them out of the survivors list and the score, after the run",
  "stryker-floor.json": "the families' floors: read by the floors job (a probe-only plan skips it) and by ci.yml's --check-file-against",
  "stryker-measured.json": "what each leg took on the measuring run: test/stryker-sizing.test.ts derives the timeouts from it",
  "stryker-unscored.json": "the mutants a member cut never scores: test/stryker-sizing.test.ts holds the cuts to it",
};

describe("mutation.yml: triggers, the weekly gate and the fork gate (T9 conventions: T9-FORK, m1, m2, m3)", () => {
  it("schedule + workflow_dispatch + its own pull_request paths + a push to main on the SAME paths, and no workflow_call, no pull_request_target", () => {
    expect(MUT).toMatch(/schedule:\s*\n\s*- cron: "23 3 \* \* 0"/);
    expect(MUT.match(/^\s*- cron:/gm)).toHaveLength(1);   // one weekly firing: a second cron line would run the whole matrix again
    for (const t of ["workflow_dispatch:", "pull_request:", "push:"]) expect(MUT).toContain(t);
    expect(MUT).not.toContain("workflow_call");
    expect(MUT).not.toContain("pull_request_target");
    // the explicit list: the probe's inputs, no `stryker*` glob (it took the recorded data with it)
    expect(triggerPaths("pull_request")).toEqual([
      ".github/workflows/mutation.yml",
      "stryker.config.mjs",
      "stryker.groups.mjs",
      "stryker.groups.d.mts",
      "stryker-anchors.json",
      "stryker-timeouts.json",
      "vitest.config.ts",
      "vitest.stryker.config.ts",
      "scripts/stryker-*",
    ]);
    // the push is the warm-up for those same inputs, on main alone: a push to any other branch is a PR's business (its own probe)
    expect(triggerPaths("push"), "the push names the pull request's paths, in its order").toEqual(triggerPaths("pull_request"));
    const push = triggerBlock("push").split("\n").filter(Boolean);
    expect(push.filter((l) => !/^ {4}paths:$|^ {6}- "/.test(l)), "the push's only other filter is main").toEqual(["    branches: [main]"]);
    expect(MUT.match(/^ {2}push:$/gm), "one push trigger").toHaveLength(1);
  });

  it("the probe runs on every file its run and its plan reach: the code from the Stryker config and the plan's script, and the data that code names, each derived from the code (a dropped stryker.config.mjs is red here)", () => {
    const reach = probeReach();
    // controls: the reader follows the config to what it loads and the plan to what it reads (a reader that saw nothing would make
    // every check below vacuous)
    for (const f of ["stryker.config.mjs", "stryker.groups.mjs", "scripts/stryker-cuts.mjs", "scripts/stryker-vitest-runner.mjs", "vitest.stryker.config.ts", "vitest.config.ts", "scripts/stryker-matrix.mjs", "scripts/stryker-files.mjs"]) {
      expect(reach.code, `the probe's path reaches ${f}`).toContain(`${f}`);
    }
    expect(reach.data, "the plan reads the timeouts and the anchors").toEqual(expect.arrayContaining(["stryker-timeouts.json", "stryker-anchors.json"]));
    let checked = 0;
    for (const event of ["pull_request", "push"] as const) {
      const paths = triggerPaths(event);
      expect(coveredBy(paths, "stryker.config.mjs"), `${event}: the probe runs on its own config`).toBe(true);
      expect(coveredBy(paths, "test/stryker-sizing.test.ts"), `${event}: and its filter is not a catch-all (a control: the matcher refuses)`).toBe(false);
      for (const f of [...reach.code, ...reach.data]) {
        expect(coveredBy(paths, f), `${event}: ${f} decides what the probe runs, and the trigger does not name it`).toBe(true);
        checked++;
      }
    }
    expect(checked, "files on the probe's path, checked against both triggers").toBe(2 * (reach.code.length + reach.data.length));
    expect(reach.code.length + reach.data.length).toBeGreaterThan(9);
  });

  it("a recorded data file never triggers the probe, stryker-equivalent.json and stryker-floor.json above all: each exists, nothing on the probe's path names it, and neither trigger takes it", () => {
    const reach = probeReach();
    const recorded = Object.keys(RECORDED_DATA);
    expect(recorded, "the two a mutation-debt PR edits most").toEqual(expect.arrayContaining(["stryker-equivalent.json", "stryker-floor.json"]));
    let checked = 0;
    for (const f of recorded) {
      expect(existsSync(join(REPO, f)), `${f} exists (a renamed file would leave this exclusion vacuous)`).toBe(true);
      expect(reach.data, `${f} is named on the probe's path, so it is an INPUT: take it out of RECORDED_DATA and into the trigger`).not.toContain(f);
      for (const event of ["pull_request", "push"] as const) {
        expect(coveredBy(triggerPaths(event), f), `${event}: ${f} is recorded data (${RECORDED_DATA[f]}) and must not trigger the probe`).toBe(false);
        checked++;
      }
    }
    expect(checked).toBe(recorded.length * 2);
    expect(recorded.length).toBe(4);
    // every Stryker data file in the tree is one or the other: a new one must be classified, never silently left out
    const data = strykerFilesInTree().filter((f) => f.endsWith(".json"));
    expect(data.length, "Stryker data files in the tree").toBeGreaterThan(4);
    expect(data.filter((f) => !reach.data.includes(f) && !recorded.includes(f)), "Stryker data files neither on the probe's path nor recorded").toEqual([]);
  });

  it("every other Stryker file of the engine is in the trigger, and the vitest config the runner is handed (T20-FIX1, M3)", () => {
    // `packages/engine/stryker*` did not match `vitest.stryker.config.ts` (it starts with `vitest.`), so a PR that changed the
    // reporters the Stryker runs use, the fix T20-PRE made, would not have run the probe that proves them. The files are read
    // from the TREE (every file named for Stryker, in the engine and its scripts) and from the config's own declaration of the
    // runner's vitest config, never typed here; the recorded data alone is left out (the test above holds each of those).
    const engine = ENGINE_DIR;
    const named = strykerFilesInTree();
    const declared = /configFile:\s*"([^"]+)"/.exec(readFileSync(join(engine, "stryker.config.mjs"), "utf8"))![1]!;
    // and what that config MERGES (T20-FIX2, m3): vitest.stryker.config.ts is `mergeConfig(base, ...)`, so a change to the base it
    // imports (`./vitest.config.ts`) alters every Stryker run, and the probe must run on it
    const imported = [...readFileSync(join(engine, declared), "utf8").matchAll(/from "\.\/([^"]+)"/g)].map((m) => m[1]!);
    expect(imported, "the runner's vitest config imports the engine's own vitest config").toContain("vitest.config.ts");
    const files = [...new Set([...named, `${declared}`, ...imported.map((f) => `${f}`)])].filter((f) => RECORDED_DATA[f] === undefined);
    expect(files.length, "Stryker files read from the tree").toBeGreaterThan(6);
    expect(files, "the runner's vitest config is among them").toContain("vitest.stryker.config.ts");
    expect(files, "and the base it merges").toContain("vitest.config.ts");
    expect(files, "and the groups' type declarations").toContain("stryker.groups.d.mts");
    for (const event of ["pull_request", "push"] as const) {
      expect(files.filter((f) => !coveredBy(triggerPaths(event), f)), `${event}: Stryker files the probe's trigger does not cover`).toEqual([]);
    }
  });

  it("the three jobs are plan, mutate and floors; mutate needs plan, floors needs both, and plan and floors have the 15-minute timeout", () => {
    expect(Object.keys(MJOBS)).toEqual(["plan", "mutate", "floors"]);
    expect(MJOBS.mutate).toMatch(/needs:\s*\[plan\]/);
    expect(MJOBS.floors).toMatch(/needs:\s*\[plan, mutate\]/);
    expect(MJOBS.plan).toMatch(/timeout-minutes: 15\b/);
    expect(MJOBS.floors).toMatch(/timeout-minutes: 15\b/);
    expect(MJOBS.plan).toContain("outputs:\n      matrix: ${{ steps.matrix.outputs.matrix }}");
  });

  it("plan and mutate spell the fork condition in their own `if:` (plan the weekly gate beside it), and floors runs only when the plan holds a leg with a floor: each evaluated over every event, with the matrix the plan step really writes (10 cases x 3 jobs = 30 evaluations)", () => {
    let evaluated = 0;
    const plan = ifOf(MJOBS.plan!);
    const mutate = ifOf(MJOBS.mutate!);
    const floors = ifOf(MJOBS.floors!);
    expect(plan).toContain("(github.event_name != 'schedule' || vars.MATRIX_WEEKLY_ENABLED == 'true')");
    expect(mutate).toContain("(github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository)");
    // floors: after every leg even a red one (always()), only when plan ran, and never when the plan holds only the probe (a
    // probe-only plan, a pull request or `workflow_dispatch group=probe`, has no floor: --check-all refuses the probe). The fromJSON
    // term comes LAST: a skipped or failed plan wrote no matrix, and `&&` stops before it is parsed.
    expect(floors).toBe("always() && needs.plan.result == 'success' && join(fromJSON(needs.plan.outputs.matrix).include.*.group, ',') != 'probe'");
    const ran = (event: string, group: string) => ({ event, matrix: planMatrix(event, group) });
    const cases: { name: string; ctx: Record<string, unknown>; plan: boolean; mutate: boolean; floors: boolean }[] = [
      { name: "workflow_dispatch group=all", ctx: ctxOf(ran("workflow_dispatch", "all")), plan: true, mutate: true, floors: true },
      { name: "workflow_dispatch of one leg", ctx: ctxOf(ran("workflow_dispatch", "draws-3")), plan: true, mutate: true, floors: true },
      // N1: the documented probe-only dispatch plans [probe]; floors must skip, not refuse the probe
      { name: "workflow_dispatch group=probe", ctx: ctxOf(ran("workflow_dispatch", "probe")), plan: true, mutate: true, floors: false },
      { name: "schedule, enabled", ctx: ctxOf({ ...ran("schedule", ""), weekly: "true" }), plan: true, mutate: true, floors: true },
      // the disabled weekly firing: plan is skipped by its own `if:` and wrote no matrix, and mutate by `needs: [plan]` (a skipped
      // need skips the job); floors has always(), so only its own `needs.plan.result == 'success'` keeps it from running
      { name: "schedule, disabled", ctx: ctxOf({ event: "schedule", weekly: "", planResult: "skipped" }), plan: false, mutate: true, floors: false },
      // a pull request plans the probe
      { name: "PR from the same repository", ctx: ctxOf(ran("pull_request", "")), plan: true, mutate: true, floors: false },
      { name: "PR from a fork", ctx: ctxOf({ event: "pull_request", head: "someone-else/seazn.club", planResult: "skipped" }), plan: false, mutate: false, floors: false },
      { name: "PR whose head repository was deleted", ctx: ctxOf({ event: "pull_request", head: null, planResult: "skipped" }), plan: false, mutate: false, floors: false },
      // a push to main on the probe's inputs plans the probe (the warm-up main's cache is kept by); the weekly switch does not gate it
      { name: "push to main, weekly switch off", ctx: ctxOf({ ...ran("push", ""), weekly: "" }), plan: true, mutate: true, floors: false },
      // plan itself failed: there is no matrix, so nothing for floors to judge
      { name: "workflow_dispatch whose plan failed", ctx: ctxOf({ event: "workflow_dispatch", planResult: "failure" }), plan: true, mutate: true, floors: false },
    ];
    for (const c of cases) {
      expect(evalIf(plan, c.ctx), `plan: ${c.name}`).toBe(c.plan);
      expect(evalIf(mutate, c.ctx), `mutate: ${c.name}`).toBe(c.mutate);
      expect(evalIf(floors, c.ctx), `floors: ${c.name}`).toBe(c.floors);
      evaluated += 3;
    }
    expect(evaluated).toBe(30);
  }, spawnBudget(6));

  it("a push to a pull request cancels the run it supersedes and nothing else is ever cancelled: one top-level `concurrency:` whose group is the PR's number for a PR and the run's own id otherwise", () => {
    const blocks = MUT.match(/^concurrency:\n(?: {2}.*\n)+/gm);
    expect(blocks, "ONE concurrency block at column 0").toHaveLength(1);
    const group = /^ {2}group: (.+)$/m.exec(blocks![0]!)![1]!;
    const cancel = /^ {2}cancel-in-progress: (.+)$/m.exec(blocks![0]!)![1]!;
    expect(group).toBe("mutation-${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || format('run-{0}', github.run_id) }}");
    expect(cancel).toBe("${{ github.event_name == 'pull_request' }}");
    const groupOf = (ctx: Record<string, unknown>) => `mutation-${String(evalExpr(/\$\{\{\s*(.+?)\s*\}\}/.exec(group)![1]!, ctx))}`;
    const cancels = (ctx: Record<string, unknown>) => evalIf(cancel, ctx);
    // a PR: the same PR is the same group (so a new push cancels the old run), another PR is another group
    const pr = (prNumber: number, headRef: string, runId: string) => ctxOf({ event: "pull_request", prNumber, headRef, runId });
    expect(groupOf(pr(7, "feat/a", "10"))).toBe("mutation-pr-7");
    expect(groupOf(pr(7, "feat/a", "11")), "a new push to the same PR").toBe(groupOf(pr(7, "feat/a", "10")));
    expect(groupOf(pr(7, "feat/renamed", "12")), "the same PR after its branch was renamed").toBe(groupOf(pr(7, "feat/a", "10")));
    expect(groupOf(pr(8, "feat/b", "13")), "another PR").not.toBe(groupOf(pr(7, "feat/a", "10")));
    // a fork PR whose branch is named like a same-repo PR's must not share its group: it would cancel that PR's run (the group is
    // taken before any job's `if:` skips the fork's run). Same head_ref, different PR number.
    expect(groupOf(pr(9, "feat/a", "14")), "a fork PR reusing a same-repo branch name").not.toBe(groupOf(pr(7, "feat/a", "10")));
    expect(cancels(pr(7, "feat/a", "10"))).toBe(true);
    // every other event: its own group per run, and never cancelling, so a weekly run, a dispatch or main's warm-up push run is
    // never aborted by a later push (a second push to main is a second run, never a cancel of the first one's cache save)
    let others = 0;
    for (const event of ["schedule", "workflow_dispatch", "push"]) {
      const a = ctxOf({ event, headRef: "", runId: "100" });
      const b = ctxOf({ event, headRef: "", runId: "101" });
      expect(groupOf(a), event).toBe("mutation-run-100");
      expect(groupOf(a), `${event}: two runs`).not.toBe(groupOf(b));
      expect(cancels(a), event).toBe(false);
      others++;
    }
    expect(others).toBe(3);
    // a dispatch from a branch whose name equals a PR's head ref does not share its group (head_ref is empty outside a PR), and a run
    // id that equals a PR number is another group (the two namespaces are prefixed)
    expect(groupOf(ctxOf({ event: "workflow_dispatch", headRef: "feat/a", runId: "7" }))).toBe("mutation-run-7");
    expect(groupOf(ctxOf({ event: "workflow_dispatch", runId: "7" }))).not.toBe(groupOf(pr(7, "feat/a", "10")));
  });

  it("the exposure surface is read-only and secret-free: ONE workflow-level permissions block, contents read, and no secrets anywhere", () => {
    const blocks = permissionBlocks(MUT);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.scalar).toBeNull();
    expect(blocks[0]!.entries).toEqual({ contents: "read" });
    expect(MUT).toMatch(/^permissions:$/m);   // at column 0: the workflow's, not a job's
    expect(MUT).not.toMatch(/\$\{\{[^}]*\bsecrets\b/);
    expect(MUT).not.toMatch(/^\s*secrets:/m);
  });

  it("the one upload overwrites its own artifact (a re-run must not 409), is named per group, and is rooted at packages/engine/ (PF-5: a download holds reports/mutation/<group>.json)", () => {
    expect(MUT.match(/uses: actions\/upload-artifact@v4/g)).toHaveLength(1);
    expect(MUT.match(/^\s+overwrite: true$/gm)).toHaveLength(1);
    const up = stepOf(MJOBS.mutate!, "Upload mutation results").body;
    expect(up).toContain("name: mutation-${{ matrix.group }}");
    const paths = /path: \|\n((?: {12}\S.*\n?)+)/.exec(up)![1]!.split("\n").map((l) => l.trim()).filter(Boolean);
    expect(paths.length).toBeGreaterThan(1);
    for (const x of paths) expect(x, x).toMatch(/^packages\/engine\//);
    expect(paths).toContain("reports/mutation/${{ matrix.group }}.json");
    expect(paths).toContain("SURVIVORS.md");
  });
});

describe("mutation.yml: the incremental cache is keyed so no group can restore another's file, and no cut another cut's", () => {
  const cache = stepOf(MJOBS.mutate!, "Restore the incremental file").body;
  /** What the plan step really hands the mutate job for every leg (the probe's PR matrix and the dispatch of all the others):
   *  group -> { timeout, cut }, the values `matrix.cut` takes in the keys below. Spawned once, on first use. */
  let planned: Record<string, { timeout: number; cut: string }> | undefined;
  const plannedLegs = (): Record<string, { timeout: number; cut: string }> => {
    planned ??= Object.fromEntries([planMatrix("pull_request", ""), planMatrix("workflow_dispatch", "all")]
      .flatMap((m) => (JSON.parse(m) as { include: { group: string; timeout: number; cut: string }[] }).include)
      .map((e) => [e.group, { timeout: e.timeout, cut: e.cut }]));
    return planned;
  };
  /** The test runner's fingerprint, as the keys spell it (engine mutation-debt P0, review I1): the runner decides verdicts
   *  (scripts/stryker-vitest-runner.mjs turns a test file that fails to load into a kill), and Stryker reuses a cached Survived
   *  result unless a test covering the mutant was ADDED, so a runner edit must start its legs cold once. `runner` stands for the
   *  value the expression takes. */
  const RUNNER = "scripts/stryker-vitest-runner.mjs";
  const RUNNER_HASH = `\${{ hashFiles('${RUNNER}') }}`;
  const keyOf = (g: string, cut = plannedLegs()[g]!.cut, runner = "r1") => /^ {10}key: (.+)$/m.exec(cache)![1]!.replace("${{ matrix.group }}", g).replace("${{ matrix.cut }}", cut).replace(RUNNER_HASH, runner).replace("${{ github.sha }}", "0123abc");
  const restoreOf = (g: string, cut = plannedLegs()[g]!.cut, runner = "r1") => /restore-keys: \|\n {12}(\S.*)$/m.exec(cache)![1]!.replace("${{ matrix.group }}", g).replace("${{ matrix.cut }}", cut).replace(RUNNER_HASH, runner);

  it("the cached path is the group's own incremental file, the one stryker.config.mjs writes", () => {
    expect(cache).toContain("path: reports/mutation/${{ matrix.group }}.incremental.json");
    expect(cache).toContain("uses: actions/cache/restore@v4");
  });

  it("the file is SAVED by its own step, after Stryker and the check, `if: always()` and only when the check passed, under the key the restore looks for (a red Stryker run must not lose it; a refused file must not be kept)", () => {
    const save = stepOf(MJOBS.mutate!, "Save the incremental file").body;
    expect(save).toContain("uses: actions/cache/save@v4");
    expect(save).toContain("if: always() && steps.incremental.outcome == 'success'");
    expect(save).toContain("path: reports/mutation/${{ matrix.group }}.incremental.json");
    expect(save).toContain(`key: ${/^ {10}key: (.+)$/m.exec(cache)![1]!}`);
    const heads = stepHeads(MJOBS.mutate!);
    const at = (n: string) => heads.indexOf(`      - name: ${n}`);
    expect(at("Run Stryker")).toBeGreaterThan(at("Restore the incremental file"));
    // the check and the save sit right after Stryker, each `if: always()`, before any later step that can exit non-zero
    expect(at("Check the incremental file")).toBe(at("Run Stryker") + 1);
    expect(at("Save the incremental file")).toBe(at("Run Stryker") + 2);
    expect(at("Survivors")).toBeGreaterThan(at("Save the incremental file"));
    expect(heads.filter((h) => h.includes("Floor check")), "the floor is judged per family by the floors job, never by a leg").toEqual([]);
    // the plain `actions/cache@v4` would save only on a green job: none may remain
    expect(MUT).not.toMatch(/uses: actions\/cache@/);
  });

  it("the check before the save is the engine's own selection check on the incremental file, `if: always()`, a red step when it refuses, and the save runs only on its success (evaluated, not just read)", () => {
    const check = stepOf(MJOBS.mutate!, "Check the incremental file").body;
    expect(check).toContain("id: incremental");
    expect(check).toMatch(/^ {8}if: always\(\)$/m);
    expect(check).toContain("working-directory: .");
    expect(check, "a refusal is a red step, never advisory").not.toContain("continue-on-error");
    expect(check).toContain('run: node --experimental-strip-types scripts/stryker-floor.ts --check-selection "$GROUP" "reports/mutation/$GROUP.incremental.json"');
    // the same CLI and the same working directory Survivors uses, so the two judge alike
    expect(stepOf(MJOBS.mutate!, "Survivors").body).toContain("working-directory: .");
    expect(stepOf(MJOBS.mutate!, "Survivors").body).toContain("run: node --experimental-strip-types scripts/stryker-floor.ts --survivors");
    // the save's own condition, evaluated for each outcome the check can have
    const raw = /^ {8}if: (.+?)\s*(?:#.*)?$/m.exec(stepOf(MJOBS.mutate!, "Save the incremental file").body)![1]!;
    const saves = (outcome: string, cancelled = false) => evalIf(raw, { steps: { incremental: { outcome } } }, cancelled);
    expect(saves("success"), "the check accepted the file").toBe(true);
    expect(saves("failure"), "the check refused it").toBe(false);
    expect(saves("skipped"), "the check did not run").toBe(false);
    expect(saves("cancelled"), "the check was cancelled").toBe(false);
    expect(saves("success", true), "a cancelled job still saves what the check accepted (an interrupted leg's partial file)").toBe(true);
  });

  it("the check step run for real: a file inside the leg's ranges is exit 0, one with a mutant past them (the first re-run's poisoned file), a missing file and an empty one are exit 2 and the step is red", () => {
    const LEG = "sports-cricket-9";
    const CRICKET = "src/sports/cricket/cricket.ts";
    const range = resolveGroup(LEG).map((e) => /^(.*):(\d+)-(\d+)$/.exec(e)).find((m) => m !== null && m[1] === CRICKET);
    expect(range, `${LEG} takes a range of cricket.ts`).toBeDefined();
    const to = Number(range![3]);
    const from = Number(range![2]);
    const line = runLine(MJOBS.mutate!, "Check the incremental file");
    const inc = (lines: number[]) => JSON.stringify({ files: { [CRICKET]: { mutants: lines.map((l, i) => ({ id: String(i), mutatorName: "BlockStatement", status: i % 2 === 0 ? "Killed" : "Pending", location: { start: { line: l, column: 1 } } })) } } });
    const stepRun = (text: string | null) => {
      const cwd = fresh("incremental");
      mkdirSync(join(cwd, "reports/mutation"), { recursive: true });
      if (text !== null) writeFileSync(join(cwd, "reports/mutation", `${LEG}.incremental.json`), text);
      const r = spawnSync("bash", ["-c", line], { cwd, encoding: "utf8", timeout: SPAWN_MS, env: { PATH: process.env.PATH ?? "", GROUP: LEG } });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    };
    expect(stepRun(inc([from, from + 1, to])).status, "inside").toBe(0);
    const poisoned = stepRun(inc([from, to + 1]));
    expect(poisoned.status, "a mutant one line past the leg's range").toBe(2);
    expect(poisoned.stderr).toContain(`is not group "${LEG}"'s`);
    expect(stepRun(null).status, "no file: Stryker died before it wrote one").toBe(2);
    expect(stepRun(inc([])).status, "no mutants").toBe(2);
  }, spawnBudget(4));

  it("no group's restore prefix is a prefix of another group's cache key (derived from the real group names, each with the cut the plan step gives it)", () => {
    const names = Object.keys(STRYKER_GROUPS);
    expect(Object.keys(plannedLegs()).sort(), "the plan step gives every group a cut").toEqual([...names].sort());
    let compared = 0;
    for (const g of names) {
      for (const h of names) {
        if (g === h) { expect(keyOf(h).startsWith(restoreOf(g)), `${g} restores its own`).toBe(true); continue; }
        expect(keyOf(h).startsWith(restoreOf(g)), `${g}'s restore prefix "${restoreOf(g)}" reaches ${h}'s key "${keyOf(h)}"`).toBe(false);
        compared++;
      }
    }
    expect(compared).toBe(names.length * (names.length - 1));
  });

  it("the warm-up's point: the key main's push run saves the probe under is one a PR probe's restore key reaches (the same group, cut and runner from the real plan step; only the sha differs)", () => {
    const probeOf = (event: string) => (JSON.parse(planMatrix(event, "")) as { include: { group: string; timeout: number; cut: string }[] }).include;
    const push = probeOf("push");
    const pr = probeOf("pull_request");
    expect(push.map((e) => e.group), "a push plans the probe alone").toEqual(["probe"]);
    expect(push, "the push's plan is the PR's").toEqual(pr);
    const mainKey = keyOf("probe", push[0]!.cut).replace("0123abc", "fedcba9");   // saved by the push run, at main's sha
    expect(mainKey.startsWith(restoreOf("probe", pr[0]!.cut)), `a PR's restore prefix "${restoreOf("probe", pr[0]!.cut)}" reaches main's key "${mainKey}"`).toBe(true);
    expect(mainKey, "and it is not the PR's own key").not.toBe(keyOf("probe", pr[0]!.cut));
  }, spawnBudget(2));

  it("the premise: a restore key that stopped at the group's name WOULD collide on the real names, `sports-cricket-1` reaching `sports-cricket-10` (so the '@' is doing work, not decoration)", () => {
    const names = Object.keys(STRYKER_GROUPS);
    const colliding = names.flatMap((g) => names.filter((h) => h !== g && keyOf(h).startsWith(`stryker-${g}`)).map((h) => `${g} -> ${h}`));
    expect(colliding.length).toBeGreaterThan(0);
    expect(colliding, "the numbered legs are the ones that collide").toContain("sports-cricket-1 -> sports-cricket-10");
  });

  it("the cut and the runner's fingerprint are in the key, the restore key and the save key, and the restore key has no shorter fallback that would reach another cut's or another runner's file", () => {
    const save = stepOf(MJOBS.mutate!, "Save the incremental file").body;
    const key = `key: stryker-\${{ matrix.group }}@\${{ matrix.cut }}@${RUNNER_HASH}@\${{ github.sha }}`;
    expect(cache).toContain(key);
    expect(save).toContain(key);
    // exactly one restore key, and it stops AFTER the runner's fingerprint: `stryker-${{ matrix.group }}@` alone is the defect
    // (T20), and one that stopped after the cut would restore a file a different runner judged (I1)
    const block = /restore-keys: \|\n((?: {12}\S.*\n?)+)/.exec(cache);
    expect(block, "a restore-keys block").not.toBeNull();
    expect(block![1]!.split("\n").filter((l) => l.trim() !== "").map((l) => l.trim())).toEqual([`stryker-\${{ matrix.group }}@\${{ matrix.cut }}@${RUNNER_HASH}@`]);
  });

  it("a runner edit starts every leg cold once: a file saved under another runner fingerprint, or under the key before the runner was in it, is never restored, and a file this runner saved still is (each group, its own cut)", () => {
    let checked = 0;
    for (const g of Object.keys(STRYKER_GROUPS)) {
      const own = plannedLegs()[g]!.cut;
      expect(keyOf(g, own, "r1").startsWith(restoreOf(g, own, "r1")), `${g} restores the file the same runner saved`).toBe(true);
      expect(keyOf(g, own, "r2").startsWith(restoreOf(g, own, "r1")), `${g} would restore a file another runner judged`).toBe(false);
      // the key before the runner was in it: `stryker-<group>@<cut>@<sha>` (judged by the plain vitest runner)
      expect(`stryker-${g}@${own}@0123abc`.startsWith(restoreOf(g, own, "r1")), `${g} would restore the pre-fix key`).toBe(false);
      checked++;
    }
    expect(checked).toBeGreaterThan(10);
  });

  it("a leg that is cut again never restores the file another cut wrote, and one that is not still restores its own (each group, the cut the plan step gives it)", () => {
    let checked = 0;
    for (const g of Object.keys(STRYKER_GROUPS)) {
      const own = plannedLegs()[g]!.cut;
      const other = own.slice(0, -1) + (own.endsWith("0") ? "1" : "0"); // a different cut, the same group
      expect(keyOf(g, own).startsWith(restoreOf(g, own)), `${g} restores the file its own cut saved`).toBe(true);
      expect(keyOf(g, other).startsWith(restoreOf(g, own)), `${g} (cut ${own}) would restore a file saved by cut ${other}`).toBe(false);
      // the key the workflow wrote before the cut was in it: `stryker-<group>@<sha>` (the old cut's file, which is NOT to be restored)
      expect(`stryker-${g}@78c7ef3e6c0e5bb2b3c1d4f6a7e8d9c0b1a2f3e4`.startsWith(restoreOf(g, own)), `${g} would restore the pre-fix key`).toBe(false);
      checked++;
    }
    expect(checked).toBe(Object.keys(STRYKER_GROUPS).length);
    expect(checked).toBeGreaterThan(10);
  });

  it("the premise: a restore key that stopped at the group's name and its '@' (the shape before the fix) WOULD reach a file another cut wrote (so the cut in the prefix is doing work)", () => {
    const g = "sports-cricket-9";
    const other = plannedLegs()[g]!.cut.replace(/^./, (c) => (c === "0" ? "1" : "0"));
    expect(keyOf(g, other).startsWith(`stryker-${g}@`), "the old prefix reaches the other cut's key").toBe(true);
    expect(keyOf(g, other).startsWith(restoreOf(g)), "the new one does not").toBe(false);
  });

  it("every `matrix.<field>` the mutate job reads is a field the plan step really emits (the seam: producer and consumer meet in the real output)", () => {
    const read = new Set([...MJOBS.mutate!.matchAll(/(?<![\w-])matrix\.(\w+)/g)].map((m) => m[1]!));
    const emitted = new Set(Object.keys(JSON.parse(planMatrix("workflow_dispatch", "core-1")).include[0] as Record<string, unknown>));
    expect([...read].sort()).toEqual(["cut", "group", "timeout"]);
    for (const f of read) expect(emitted.has(f), `matrix.${f} is not in the plan step's output (${[...emitted].join(", ")})`).toBe(true);
  });

  it("the workflow hashes ONE thing itself, the test runner, in the three keys only, and it is the runner the engine's Stryker config loads; the cut's fingerprint still comes from the plan step, never from inline shell over source", () => {
    expect([...MUT.matchAll(/hashFiles\(([^)]*)\)/g)].map((m) => m[1])).toEqual([`'${RUNNER}'`, `'${RUNNER}'`, `'${RUNNER}'`]);
    const code = MUT.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n").replaceAll(RUNNER_HASH, "");
    expect(code).not.toMatch(/sha\d*sum|shasum|md5|openssl|hashFiles|\bcksum\b/);
    // hashFiles of a path that matches nothing is '' (no error), so the fingerprint would silently stop moving: the path must be
    // the file stryker.config.mjs names as its plugin (resolved, as Stryker does, against packages/engine)
    expect(existsSync(join(REPO, RUNNER)), RUNNER).toBe(true);
    const plugins = /plugins: \[([^\]]*)\]/.exec(readFileSync(join(REPO, "stryker.config.mjs"), "utf8"))![1]!;
    const local = [...plugins.matchAll(/"(\.[^"]+)"/g)].map((m) => resolve(REPO, ".", m[1]!));
    expect(local).toEqual([join(REPO, RUNNER)]);
  });
});

// --- the steps, run for real -----------------------------------------------------------------------------------------

/** A `pnpm` on the PATH for a step that runs in packages/engine: `mutation:floor` runs the REAL engine CLI as the engine's
 *  package.json spells it (paths made absolute, so the cwd can be a scratch dir); `mutation` is a stand-in that records the
 *  STRYKER_GROUP it was given and exits with FAIL_CODE (the real Stryker run is the probe's, not a unit test's). */
function enginePnpm(dir: string): void {
  const floorCmd = enginePkg.scripts["mutation:floor"];
  expect(floorCmd, "the engine's mutation:floor script").toBeDefined();
  writeFileSync(join(dir, "pnpm"), `#!/bin/sh
echo "$*" >> "$RECORD"
cmd="$1"; shift
case "$cmd" in
  mutation:floor) exec ${floorCmd!.replace(" scripts/", ` ${ENGINE_DIR}/scripts/`)} "$@" ;;
  mutation) echo "STRYKER_GROUP=$STRYKER_GROUP" >> "$RECORD"; if [ -n "$FAIL_CODE" ]; then echo "stand-in: stryker failed" >&2; exit "$FAIL_CODE"; fi ;;
  *) echo "stand-in pnpm: unexpected command $cmd" >&2; exit 99 ;;
esac
`, { mode: 0o755 });
  chmodSync(join(dir, "pnpm"), 0o755);
}
/** The one-line `run:` of a step (the floor and survivors steps), with the engine-relative script path made absolute. */
function runLine(jobText: string, name: string): string {
  const m = /^ {8}run: (\S.*)$/m.exec(stepOf(jobText, name).body);
  if (m === null) throw new Error(`the "${name}" step has no one-line run:`);
  return m[1]!.replace(" scripts/stryker-floor.ts", ` ${ENGINE_DIR}/scripts/stryker-floor.ts`);
}
function runBlock(script: string, o: { cwd: string; env?: Record<string, string> }): { status: number | null; stdout: string; stderr: string; record: string[] } {
  const bin = fresh("bin");
  enginePnpm(bin);
  const recordFile = join(bin, "record");
  writeFileSync(recordFile, "");
  const r = spawnSync("bash", ["-c", script], { cwd: o.cwd, encoding: "utf8", timeout: SPAWN_MS * 3, env: { PATH: `${bin}:${process.env.PATH ?? ""}`, RECORD: recordFile, ...o.env } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, record: readFileSync(recordFile, "utf8").split("\n").filter(Boolean) };
}
/** A scratch packages/engine: the floor file, and a `draws-3` report (3 killed, 1 survived: 75.0%) at reports/mutation/draws-3.json
 *  (the Survivors step's own layout: one leg's report in the leg's own job). */
function engineDir(floors: Record<string, number>, over: { omitReport?: boolean } = {}): string {
  const cwd = fresh("engine");
  writeFileSync(join(cwd, "stryker-floor.json"), JSON.stringify({ note: "t", families: floors }));
  if (over.omitReport !== true) {
    mkdirSync(join(cwd, "reports/mutation"), { recursive: true });
    writeFileSync(join(cwd, "reports/mutation/draws-3.json"), JSON.stringify({ files: { "src/scheduling/bracket.ts": { mutants: mutantsOf([["Killed", 1], ["Killed", 2], ["Timeout", 3], ["Survived", 4]]) } } }));
  }
  return cwd;
}
const mutantsOf = (rows: [string, number][]) => rows.map(([status, line]) => ({ mutatorName: "ConditionalExpression", replacement: "true", status, location: { start: { line, column: 1 } } }));
/** A scratch checkout for the `floors` job: packages/engine holds the floor file (the step's working directory), and floors-in/
 *  holds what download-artifact unpacks, each leg's artifact at mutation-<leg>/reports/mutation/<leg>.json. Returns the engine
 *  directory. `reports` maps a leg to the file it mutated and its (status, line) mutants; a leg left out left no artifact. */
function floorsRepo(floors: Record<string, number>, reports: Record<string, { file: string; mutants: [string, number][] }>): string {
  const root = fresh("checkout");
  const engine = join(root, ".");
  mkdirSync(engine, { recursive: true });
  writeFileSync(join(engine, "stryker-floor.json"), JSON.stringify({ note: "t", families: floors }));
  for (const [leg, r] of Object.entries(reports)) {
    const dir = join(root, "floors-in", `mutation-${leg}`, "reports/mutation");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${leg}.json`), JSON.stringify({ files: { [r.file]: { mutants: mutantsOf(r.mutants) } } }));
  }
  return engine;
}

describe("mutation.yml: the plan step derives the matrix through the real script, per event", () => {
  const script = stepOf(MJOBS.plan!, "Derive the matrix").script ?? runLine(MJOBS.plan!, "Derive the matrix");
  const derive = (env: Record<string, string>) => {
    const out = join(fresh("out"), "github-output");
    writeFileSync(out, "");
    // the step's command, as the workflow spells it, run from the repo root (a workflow step's default directory)
    const r = spawnSync("bash", ["-c", script], { cwd: REPO, encoding: "utf8", timeout: SPAWN_MS, env: { PATH: process.env.PATH ?? "", GITHUB_OUTPUT: out, ...env } });
    return { status: r.status, stderr: r.stderr, lines: readFileSync(out, "utf8").split("\n").filter(Boolean) };
  };
  const groupsIn = (lines: string[]) => (JSON.parse(lines[0]!.slice("matrix=".length)) as { include: { group: string; timeout: number }[] }).include.map((e) => e.group);

  it.each([
    ["pull_request", "", ["probe"]],
    ["schedule", "", Object.keys(STRYKER_GROUPS).filter((g) => g !== "probe")],
    ["workflow_dispatch", "all", Object.keys(STRYKER_GROUPS).filter((g) => g !== "probe")],
    ["workflow_dispatch", "probe", ["probe"]],
    ["workflow_dispatch", "draws-3", ["draws-3"]],
  ])("EVENT=%s GROUP='%s' appends exactly one `matrix=<json>` line to $GITHUB_OUTPUT with %j", (event, group, want) => {
    const r = derive({ EVENT: event, GROUP: group });
    expect(r.status, r.stderr).toBe(0);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatch(/^matrix=\{"include":\[/);
    expect(groupsIn(r.lines)).toEqual(want);
  }, spawnBudget(1));

  it("a dispatch of an unknown group fails the step and appends nothing (the matrix is never empty-and-green)", () => {
    const r = derive({ EVENT: "workflow_dispatch", GROUP: "nosuch" });
    expect(r.status).not.toBe(0);
    expect(r.lines).toEqual([]);
  }, spawnBudget(1));
});

describe("mutation.yml: the Stryker step keeps Stryker's own exit and writes it down (D8: a killed command reads as 0 otherwise)", () => {
  const body = stepOf(MJOBS.mutate!, "Run Stryker");
  const script = body.script!;
  it("it runs `pnpm mutation` in packages/engine with STRYKER_GROUP from the job's GROUP", () => {
    expect(body.body).toContain("working-directory: .");
    const r = runBlock(script, { cwd: fresh("engine"), env: { GROUP: "draws-3" } });
    expect(r.status, r.stderr).toBe(0);
    expect(r.record).toEqual(["mutation", "STRYKER_GROUP=draws-3"]);
  }, spawnBudget(1));
  it("a failing run: the step exits with Stryker's code, reports/mutation/exit.txt says so (the directory is made even if Stryker died before writing one), and EXIT= is printed", () => {
    let checked = 0;
    for (const code of [1, 2, 137]) {
      const cwd = fresh("engine");
      const r = runBlock(script, { cwd, env: { GROUP: "core-1", FAIL_CODE: String(code) } });
      expect(r.status, `exit ${code}`).toBe(code);
      expect(readFileSync(join(cwd, "reports/mutation/exit.txt"), "utf8").trim(), `exit ${code}`).toBe(String(code));
      expect(r.stdout).toContain(`EXIT=${code}`);
      checked++;
    }
    expect(checked).toBe(3);
  }, spawnBudget(3));
});

describe("mutation.yml: the floors job judges each family on all its legs, run through the real engine CLI", () => {
  const floorStep = stepOf(MJOBS.floors!, "Floor check");
  const floorLine = runLine(MJOBS.floors!, "Floor check");
  const survivorsLine = runLine(MJOBS.mutate!, "Survivors");
  // two families: `core` is three legs, each (3 killed, 1 survived), so the family is 9 of 12 = 75.0%; `draws` is four, bracket.ts
  // 3 of 4 and one killed mutant in each of the others, which SUM to 6 of 7 = 85.7% (the mean of the legs' scores is 93.75 and the
  // weakest leg 75.0, so a floor of 85.7 tells the sum from both)
  const CORE = STRYKER_FAMILIES.core;
  const DRAWS = STRYKER_FAMILIES.draws;
  const CORE_FILES = ["src/core/clock.ts", "src/core/errors.ts", "src/core/rng.ts"];   // a whole file each core leg selects
  const DRAWS_FILES: Record<string, string> = { "draws-1": "src/scheduling/americano.ts", "draws-2": "src/scheduling/feedgraph.ts", "draws-3": "src/scheduling/bracket.ts", "draws-4": "src/scheduling/swiss.ts" };
  const LEGS = [...CORE, ...DRAWS].join(",");
  const ALL: Record<string, { file: string; mutants: [string, number][] }> = {
    ...Object.fromEntries(CORE.map((leg, i) => [leg, { file: CORE_FILES[i]!, mutants: [["Killed", 1], ["Killed", 2], ["Killed", 3], ["Survived", 4]] as [string, number][] }])),
    ...Object.fromEntries(DRAWS.map((leg) => [leg, { file: DRAWS_FILES[leg]!, mutants: (leg === "draws-3" ? [["Killed", 1], ["Killed", 2], ["Killed", 3], ["Survived", 4]] : [["Killed", 1]]) as [string, number][] }])),
  };
  const only = (legs: readonly string[]) => Object.fromEntries(legs.map((l) => [l, ALL[l]!]));

  it("the floors job reads the legs' artifacts from floors-in, judges them with --check-all over the legs the plan scheduled, and the step can be neither conditional nor advisory", () => {
    expect(MJOBS.floors).toContain("LEGS: ${{ join(fromJSON(needs.plan.outputs.matrix).include.*.group, ',') }}");
    const dl = MJOBS.floors!.slice(MJOBS.floors!.indexOf("uses: actions/download-artifact@v4"));
    expect(dl).toMatch(/^uses: actions\/download-artifact@v4\n {8}with:\n {10}pattern: mutation-\*\n {10}path: floors-in\n/);
    expect(MJOBS.floors!.match(/uses: actions\/download-artifact@/g), "one download").toHaveLength(1);
    // each leg's upload is named mutation-<leg> (the pattern above reads exactly those)
    expect(stepOf(MJOBS.mutate!, "Upload mutation results").body).toContain("name: mutation-${{ matrix.group }}");
    expect(floorStep.body).toContain("working-directory: .");
    expect(floorStep.body).not.toContain("continue-on-error");
    expect(floorStep.body, "no step-level `if:` that could skip it").not.toMatch(/^ {8}if:/m);
    expect(floorLine).toBe('pnpm mutation:floor --check-all ../../floors-in --legs "$LEGS" --skip-if-no-floors');
    // the install the jobs share is the engine's own (Stryker, vitest and the TypeScript parser are its devDependencies)
    for (const job of ["mutate", "floors"] as const) expect(MJOBS[job], job).toContain("run: pnpm install --frozen-lockfile --filter .... --fail-if-no-match");
    expect(MUT).not.toMatch(/run: pnpm install --frozen-lockfile\s*$/m);
    // the artifacts the job unpacks are those of the families it judges: every non-probe leg is in a family
    expect(Object.values(STRYKER_FAMILIES).flat().sort()).toEqual(Object.keys(STRYKER_GROUPS).filter((g) => g !== "probe").sort());
    // the fixtures below name legs of the real families (a re-cut that moved them reds here, not in a refusal that reads like a verdict)
    expect(Object.keys(DRAWS_FILES), "the fixture's draws legs are the family's").toEqual([...DRAWS]);
    expect(CORE).toHaveLength(CORE_FILES.length);
  });

  it("against the real plan, for every dispatch group and the weekly, the PR and main's push: floors runs exactly when the plan holds a leg with a floor, LEGS is those legs, and the probe is never in it (N1)", () => {
    const floors = ifOf(MJOBS.floors!);
    const legsExpr = /^ {6}LEGS: \$\{\{\s*(.+?)\s*\}\}/m.exec(MJOBS.floors!)![1]!;
    const keys = Object.keys(STRYKER_GROUPS);
    const plans = [...keys.map((group) => ({ event: "workflow_dispatch", group })), { event: "workflow_dispatch", group: "all" }, { event: "schedule", group: "" }, { event: "pull_request", group: "" }, { event: "push", group: "" }];
    let ran = 0;
    for (const p of plans) {
      const matrix = planMatrix(p.event, p.group);
      const ctx = ctxOf({ event: p.event, matrix });
      // what the plan scheduled, read from its own JSON (not from the workflow's expressions under test)
      const scheduled = (JSON.parse(matrix) as { include: { group: string }[] }).include.map((e) => e.group);
      const runs = evalIf(floors, ctx);
      expect(runs, `${p.event} ${p.group}: floors runs unless the plan holds only the probe (plan: ${scheduled.join(",")})`).toBe(!scheduled.every((g) => g === "probe"));
      if (runs) {
        const legs = String(evalExpr(legsExpr, ctx));
        expect(legs, `${p.event} ${p.group}: LEGS`).toBe(scheduled.join(","));
        expect(legs.split(","), `${p.event} ${p.group}: --check-all refuses the probe`).not.toContain("probe");
        ran++;
      }
    }
    // anti-vacuity: every plan was looked at, and the jobs that ran are every leg dispatched alone, group=all and the weekly
    // (the probe dispatched alone, the pull request and the push, the three probe-only plans, are the rest, each checked above)
    expect(plans.length).toBe(keys.length + 4);
    expect(ran).toBe(keys.length - 1 + 2);
  }, spawnBudget(Object.keys(STRYKER_GROUPS).length + 4));   // one plan spawn per dispatch group, plus all, the weekly, the PR and the push

  it("what the skip prevents: a probe-only dispatch's LEGS is `probe`, and the real CLI refuses it (exit 2, names the probe), so a floors job that ran would go red on a documented option", () => {
    const legsExpr = /^ {6}LEGS: \$\{\{\s*(.+?)\s*\}\}/m.exec(MJOBS.floors!)![1]!;
    const legs = String(evalExpr(legsExpr, ctxOf({ event: "workflow_dispatch", matrix: planMatrix("workflow_dispatch", "probe") })));
    expect(legs).toBe("probe");
    const r = runBlock(floorLine, { cwd: floorsRepo({}, {}), env: { LEGS: legs } });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--legs names the probe");
    // and the same wiring on a real one-leg plan: the LEGS the expression gives is read by the CLI (one leg of a family is not the family)
    const core = String(evalExpr(legsExpr, ctxOf({ event: "workflow_dispatch", matrix: planMatrix("workflow_dispatch", "core-1") })));
    expect(core).toBe("core-1");
    const ok = runBlock(floorLine, { cwd: floorsRepo({}, only(["core-1"])), env: { LEGS: core } });
    expect({ status: ok.status, stderr: ok.stderr }).toEqual({ status: 0, stderr: "" });
    expect(ok.stdout).toContain(`core: not judged, only 1 of its ${CORE.length} legs were planned`);
  }, spawnBudget(4));

  it("PR-A's state (the committed floor file is empty): it prints `no floor yet: PR-B sets it` for each family and passes, for the legs' real reports", () => {
    const r = runBlock(floorLine, { cwd: floorsRepo({}, ALL), env: { LEGS } });
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
    expect(r.stdout.match(/no floor yet: PR-B sets it/g)).toHaveLength(2);
    expect(r.stdout).toContain("core: score 75.0% (9 of 12 detected");
    expect(r.stdout).toContain("draws: score 85.7% (6 of 7 detected");   // the SUM of the four legs
    expect(r.record).toEqual([`mutation:floor --check-all ../../floors-in --legs ${LEGS} --skip-if-no-floors`]);
  }, spawnBudget(1));

  it("once PR-B commits floors: a family with no entry is a failure, met floors pass and a missed one fails", () => {
    expect(runBlock(floorLine, { cwd: floorsRepo({ core: 75 }, ALL), env: { LEGS } }).status, "no entry for draws").toBe(2);
    expect(runBlock(floorLine, { cwd: floorsRepo({ core: 75, draws: 85.7 }, ALL), env: { LEGS } }).status).toBe(0);                  // 9 of 12 = 75.0, 6 of 7 = 85.7
    expect(runBlock(floorLine, { cwd: floorsRepo({ core: 75, draws: 85.8 }, ALL), env: { LEGS } }).status).toBe(1);                // one tenth over the sum
    expect(runBlock(floorLine, { cwd: floorsRepo({ core: 75.1, draws: 85.7 }, ALL), env: { LEGS } }).status).toBe(1);
  }, spawnBudget(4));

  it("a planned leg that left no report is a failure even while no floor exists (a leg that died is never a skip), and the other families are still judged", () => {
    const withoutSwiss = only(LEGS.split(",").filter((l) => l !== "draws-4"));   // draws-4's job died before it wrote a report
    const r = runBlock(floorLine, { cwd: floorsRepo({}, withoutSwiss), env: { LEGS } });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('draws: no report for leg "draws-4"');
    expect(r.stdout).toContain("core: score 75.0%");
  }, spawnBudget(1));

  it("a dispatch of ONE leg of a family does not judge the family (it is not the sum of its legs) and still passes; every leg of a family is judged", () => {
    const partial = runBlock(floorLine, { cwd: floorsRepo({ draws: 99 }, only(["draws-3"])), env: { LEGS: "draws-3" } });
    expect({ status: partial.status, stderr: partial.stderr }).toEqual({ status: 0, stderr: "" });
    expect(partial.stdout).toContain(`draws: not judged, only 1 of its ${DRAWS.length} legs were planned`);
    const whole = runBlock(floorLine, { cwd: floorsRepo({ core: 99 }, only(CORE)), env: { LEGS: CORE.join(",") } });
    expect(whole.status, "core is judged on its three legs, and 75.0 is under 99").toBe(1);
  }, spawnBudget(2));

  it("an empty LEGS (the expression evaluating to nothing) is a refusal, never a pass over zero families", () => {
    const r = runBlock(floorLine, { cwd: floorsRepo({}, ALL), env: { LEGS: "" } });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--check-all needs --legs");
  }, spawnBudget(1));

  it("the survivors step writes SURVIVORS.md next to the group's report, listing the one survivor", () => {
    expect(stepOf(MJOBS.mutate!, "Survivors").body).toContain("working-directory: .");
    const cwd = engineDir({});
    const r = runBlock(survivorsLine, { cwd, env: { GROUP: "draws-3" } });
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
    const md = readFileSync(join(cwd, "SURVIVORS.md"), "utf8");
    expect(md.split("\n").filter((l) => l.startsWith("src/"))).toEqual(["src/scheduling/bracket.ts:4:1 ConditionalExpression → true"]);
  }, spawnBudget(1));
});
