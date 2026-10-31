// W1d Task 20 pre-step, carries (a) and (c): how the vitest each Stryker sandbox runs is configured.
//
// (a) vitest adds its `github-actions` reporter by itself when GITHUB_ACTIONS=true and the config names no reporters. Inside a
//     Stryker run the test-runner child's stdout is not read as a report, but a CRASHED child's stdout is printed, and the
//     reporter turned it into `##[error]` annotations on a job that finished green. The Stryker runs use a vitest config of
//     their own (vitest.stryker.config.ts) that names its reporters.
// (c) a mutant that turns a counter into a runaway loop is killed by the heap, not by anything quicker. The runner child gets
//     a cap on its heap, so the loop dies in seconds; and the same cap is the ceiling of the dry run, which sets its floor.
//
// The figures below are MEASURED, through Stryker with a cap on the runner child (`stryker run --dryRunOnly --concurrency 1
// --testRunnerNodeArgs --max-old-space-size=N`), on this engine's largest dry run: the core-2 leg, whose related-tests set is the
// whole engine (errors.ts, events.ts and time.ts are imported by nearly everything). At 04bfa54f9 (803 mutants, 126 files, 4,217
// tests) it ran out of memory at 1024 and 1536 MB (SIGABRT, "Child process ran out of memory", as CI runs 38418427451 and
// 38420799725) and passed at 1792 MB (RSS 2.28 GB) and 2048 MB (RSS 2.64 GB, 94 s). The floor moves with the mutant count: the
// runner child's main thread deserialises the cumulative per-test mutant coverage of every test file (isolate:false, one worker),
// so it grows with mutants x files x tests. At 89d8d3c53 (541 mutants) the same leg failed at 768 and 896 MB and passed at 1024.
// The older "passes at 256 MB" figure (core-1, before W2b) was taken on a low-mutant case and is stale: nothing below uses it.
// A runaway allocating loop in a worker thread died after 13.9 s at 1024 MB and 42.3 s at 4096 MB (2026-10-05, a 12-core
// machine): a larger cap is a slower kill, and the time at any cap in between is an interpolation, not a measurement.
// ONE LEG IS THE EXCEPTION (owner ruling A, 2026-10-31): core-2 grew to 888 mutants, and its dry run ran out of memory at the
// default cap and at the most the default's own rule allows (2730 MB); it ran to the end at 4096 MB. It alone gets 4096, and the
// last describe of this file holds that, and what 4096 costs.
// None of them is taken from the code under test.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SPAWN_MS, spawnBudget } from "./stryker-spawn.ts";
import { STRYKER_GROUPS, STRYKER_HEAP_MB_BY_LEG, strykerConcurrency } from "../stryker.groups.mjs";

const ENGINE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const req = createRequire(import.meta.url);

/** The least cap the whole-engine dry run (core-2 at 04bfa54f9, 803 mutants) was seen to pass at, and the greatest it was seen to
 *  fail at, in MB. */
const DRY_RUN_PASSES_AT_MB = 1792;
const DRY_RUN_FAILS_AT_MB = 1536;
/** The default cap those figures chose (stryker.config.mjs's note above `testRunnerNodeArgs`): every leg's but core-2's. */
const DEFAULT_CAP_MB = 2560;
/** The headroom over the least passing cap that the cap must keep: 1.4x. 2x (the margin the 256 MB figure allowed) is out of
 *  reach now: 3 children at 2 x 1792 MB are over half a hosted runner (asserted below, so the number is not just a comment). */
const MARGIN_OVER_PASS = 1.4;
/** The two caps a runaway allocating loop's death was timed at, in MB, and the seconds each took (2026-10-05). */
const RUNAWAY = { lowMb: 1024, lowSeconds: 13.9, highMb: 4096, highSeconds: 42.3 };
/** What a hosted runner has (ubuntu-latest, 4 vCPU), and the concurrency strykerConcurrency gives it: run 37330725739. */
const HOSTED = { cores: 4, memBytes: 16 * 1024 ** 3, workersPerSandbox: 1 };
const HOSTED_CONCURRENCY = 3;
const MB = 1024 ** 2;
/** THE EXCEPTION'S MEASUREMENTS (onryde/seazn.club mutation.yml dispatches, cold, every log "Cache not found"; the tree engine #5
 *  re-measured against, which this repository's src/ copies). core-2 at 888 mutants (the instrumenter's count of this tree too):
 *  its dry run ran out of memory at 2560 MB (run 40984031307, job 123830750053, sha 499f6daf4) and at 2730 MB, the most the
 *  default's half-the-runner rule below allows (run 41153927287, job 124396508011, sha 46222a238): each "Child process ran out of
 *  memory" twice, then "DryRunExecutor One or more tests resulted in an error". At 4096 MB it ran to the end (run 41153932848, job
 *  124396562181, sha 49fd3dbd7): "Creating 3 test runner process(es)" on ubuntu-latest (4 vCPU, 16 GB), 888 of 888 mutants
 *  tested, no child out of memory, a 187.8-minute job. Fewer sandboxes would not fit the leg: its 10,910 s phase over 2 instead
 *  of 3 is about 273 minutes, over the 200-minute split line (test/stryker-sizing.test.ts), so the leg would have to be cut again
 *  and measured again; the exception keeps the concurrency it was measured at. */
const CORE2 = { leg: "core-2", mutants: 888, failsAtMb: [2560, 2730], passesAtMb: 4096, concurrency: 3, phaseSeconds: 10_910, splitLineMinutes: 200 };

/** The vitest config as vitest itself resolves it, in a plain node process (the config is TypeScript and `defineConfig`'d, so
 *  the resolution is vitest's, not a read of the file), with GITHUB_ACTIONS as given. */
function resolved(configFile: string, githubActions: boolean) {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { resolveConfig } from "vitest/node";
    const { vitestConfig: c } = await resolveConfig({ config: ${JSON.stringify(configFile)}, watch: false });
    console.log(JSON.stringify({ reporters: c.reporters, pool: c.pool, isolate: c.isolate, maxWorkers: c.maxWorkers, include: c.include, environment: c.environment }));
  `], { cwd: ENGINE, encoding: "utf8", timeout: SPAWN_MS, env: { ...process.env, GITHUB_ACTIONS: githubActions ? "true" : "" } });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as { reporters: [string, unknown][]; pool: string; isolate: boolean; maxWorkers: number; include: string[]; environment: string };
}
const names = (r: { reporters: [string, unknown][] }) => r.reporters.map(([n]) => n);

/** stryker.config.mjs as Stryker loads it (a plain node process), for one real group. */
function strykerConfig(): Record<string, unknown> {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `process.env.STRYKER_GROUP = "probe"; console.log(JSON.stringify((await import("./stryker.config.mjs")).default));`], { cwd: ENGINE, encoding: "utf8", timeout: SPAWN_MS });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as Record<string, unknown>;
}

describe("carry (a): the Stryker runs' vitest does not turn a crashed child's stdout into job annotations", () => {
  it("the POSITIVE CONTROL: the engine's own vitest config, under GITHUB_ACTIONS=true, gets the github-actions reporter; without it, it does not", () => {
    expect(names(resolved("vitest.config.ts", true))).toContain("github-actions");
    expect(names(resolved("vitest.config.ts", false))).not.toContain("github-actions");
  }, spawnBudget(2));

  it("stryker.config.mjs hands the runner vitest.stryker.config.ts, and that file is there", () => {
    const c = strykerConfig();
    expect(c.vitest).toEqual({ related: true, configFile: "vitest.stryker.config.ts" });
    expect(existsSync(join(ENGINE, "vitest.stryker.config.ts")), "the file the runner is told to load").toBe(true);
  }, spawnBudget(1));

  it("under GITHUB_ACTIONS=true the Stryker config resolves to explicit reporters and no github-actions, and the suite it runs is the engine's own", () => {
    const base = resolved("vitest.config.ts", false);
    const stryker = resolved("vitest.stryker.config.ts", true);
    expect(stryker.reporters.length, "reporters are named, not defaulted").toBeGreaterThan(0);
    expect(names(stryker)).not.toContain("github-actions");
    expect(names(stryker)).toEqual(["default"]);
    // only the reporters differ: the same tests, the same pool, the same bound on workers as every plain run
    expect({ ...stryker, reporters: null }).toEqual({ ...base, reporters: null });
    expect(stryker.include.length, "the engine's tests are still selected").toBeGreaterThan(0);
  }, spawnBudget(3));

  it("the same file under GITHUB_ACTIONS unset names the same reporters (the reporter is not tied to CI)", () => {
    expect(names(resolved("vitest.stryker.config.ts", false))).toEqual(["default"]);
  }, spawnBudget(1));
});

describe("carry (c): the runner child's heap is capped, so a runaway mutant dies in seconds (the DEFAULT cap: the probe's, and every leg's but core-2's)", () => {
  const args = strykerConfig().testRunnerNodeArgs as string[] | undefined;
  const cap = (() => {
    const m = /^--max-old-space-size=(\d+)$/.exec(args?.[0] ?? "");
    return m ? Number(m[1]) : NaN;
  })();

  it("stryker.config.mjs passes exactly one node arg to the test runner child, --max-old-space-size=<MB>", () => {
    expect(args, "testRunnerNodeArgs is set").toBeDefined();
    expect(args).toHaveLength(1);
    expect(Number.isInteger(cap), `${args?.[0]} is --max-old-space-size=<integer>`).toBe(true);
  });

  it("both option names are ones Stryker's own schema has (a misspelling would be ignored or refused only on a Sunday)", () => {
    const core = req.resolve("@stryker-mutator/core/package.json");
    const apiCore = createRequire(core).resolve("@stryker-mutator/api/core");
    const schema = JSON.parse(readFileSync(join(dirname(apiCore), "../../schema/stryker-core.json"), "utf8")) as { properties: Record<string, { type?: string; items?: { type?: string } }> };
    expect(schema.properties.testRunnerNodeArgs).toMatchObject({ type: "array", items: { type: "string" } });
    const runnerDir = dirname(req.resolve("@stryker-mutator/vitest-runner"));
    const runner = JSON.parse(readFileSync(join(runnerDir, "../schema/vitest-runner-options.json"), "utf8")) as { properties: { vitest: { properties: Record<string, unknown> } } };
    expect(Object.keys(runner.properties.vitest.properties)).toContain("configFile");
  });

  it("the cap is above the one the whole-engine dry run was seen to fail at, and at least 1.4x the least it was seen to pass at", () => {
    expect(DRY_RUN_FAILS_AT_MB).toBeLessThan(DRY_RUN_PASSES_AT_MB);
    expect(cap, "above a cap the dry run failed at").toBeGreaterThan(DRY_RUN_FAILS_AT_MB);
    expect(cap, "a margin of at least 1.4x over the least cap it passed at").toBeGreaterThanOrEqual(MARGIN_OVER_PASS * DRY_RUN_PASSES_AT_MB);
  });

  it("the hosted runner's concurrent children fit in memory: 3 children at the cap, half the runner's memory at most", () => {
    expect(strykerConcurrency(HOSTED), "the hosted concurrency the sizing assumes").toBe(HOSTED_CONCURRENCY);
    expect(cap * HOSTED_CONCURRENCY * MB, "all the children at their cap").toBeLessThanOrEqual(HOSTED.memBytes / 2);
  });

  it("the two bounds leave a window, and 2x over the least passing cap is outside it (that is why the margin is 1.4x)", () => {
    const floorMb = MARGIN_OVER_PASS * DRY_RUN_PASSES_AT_MB;
    const ceilingMb = HOSTED.memBytes / 2 / HOSTED_CONCURRENCY / MB;
    expect(floorMb, "a cap exists that is both safe for the dry run and fits the runner").toBeLessThanOrEqual(ceilingMb);
    expect(2 * DRY_RUN_PASSES_AT_MB, "a 2x margin would not fit the runner").toBeGreaterThan(ceilingMb);
    expect(cap).toBeGreaterThanOrEqual(floorMb);
    expect(cap).toBeLessThanOrEqual(ceilingMb);
  });

  it("a runaway loop dies in the time the two measurements bracket: the cap is between 1024 and 4096 MB, so 13.9 s to 42.3 s, about 28 s if linear", () => {
    expect(cap, "not below the cap it was timed at (13.9 s)").toBeGreaterThanOrEqual(RUNAWAY.lowMb);
    expect(cap, "below the cap it was timed at (42.3 s): above it nothing was measured").toBeLessThan(RUNAWAY.highMb);
    const interpolated = RUNAWAY.lowSeconds + ((cap - RUNAWAY.lowMb) / (RUNAWAY.highMb - RUNAWAY.lowMb)) * (RUNAWAY.highSeconds - RUNAWAY.lowSeconds);
    expect(interpolated, "an interpolation, not a measurement").toBeGreaterThanOrEqual(RUNAWAY.lowSeconds);
    expect(interpolated).toBeLessThan(RUNAWAY.highSeconds);
  });

  it("and the cap is 2560 MB (a deliberate change moves this with the comment above it in stryker.config.mjs)", () => {
    expect(cap).toBe(DEFAULT_CAP_MB);
  });
});

describe("the ONE per-leg exception: core-2's runner child gets 4096 MB, every other leg the default (owner ruling A, 2026-10-31)", () => {
  const legs = Object.keys(STRYKER_GROUPS);
  const CHANGED = "(a changed-lines run)";
  /** Every leg's testRunnerNodeArgs, and a changed-lines run's (STRYKER_MUTATE), as Stryker loads the config: ONE plain node process
   *  that imports it once per group (a query string re-evaluates the module), so the seam is the config itself, not the table. */
  let loaded: Record<string, unknown> | undefined;
  const argsByLeg = (): Record<string, unknown> => {
    if (loaded !== undefined) return loaded;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", `
      const out = {};
      for (const g of ${JSON.stringify(legs)}) {
        delete process.env.STRYKER_MUTATE;
        process.env.STRYKER_GROUP = g;
        out[g] = (await import("./stryker.config.mjs?g=" + g)).default.testRunnerNodeArgs;
      }
      process.env.STRYKER_MUTATE = "src/core/events.ts:10-20";
      out[${JSON.stringify(CHANGED)}] = (await import("./stryker.config.mjs?changed")).default.testRunnerNodeArgs;
      console.log(JSON.stringify(out));
    `], { cwd: ENGINE, encoding: "utf8", timeout: SPAWN_MS, env: { ...process.env, STRYKER_GROUP: undefined, STRYKER_MUTATE: undefined } });
    expect(r.status, r.stderr).toBe(0);
    loaded = JSON.parse(r.stdout) as Record<string, unknown>;
    return loaded;
  };
  /** Each one's cap in MB; NaN where the args are not exactly one `--max-old-space-size=<integer>` (the first test names those). */
  const capsByLeg = (): Record<string, number> =>
    Object.fromEntries(Object.entries(argsByLeg()).map(([g, a]) => {
      const m = Array.isArray(a) && a.length === 1 ? /^--max-old-space-size=(\d+)$/.exec(String(a[0])) : null;
      return [g, m ? Number(m[1]) : NaN];
    }));

  it("every leg, and a changed-lines run, passes exactly one node arg to the runner child, --max-old-space-size=<MB>", () => {
    const caps = capsByLeg();
    expect(Object.keys(caps), "every leg and the changed-lines run were loaded").toEqual([...legs, CHANGED]);
    const malformed = Object.entries(caps).filter(([, mb]) => !Number.isInteger(mb)).map(([g]) => `${g}: ${JSON.stringify(argsByLeg()[g])}`);
    expect(malformed).toEqual([]);
    expect(Object.keys(caps).length, "configs checked").toBe(legs.length + 1);
  }, spawnBudget(1));

  it("core-2 is the ONLY leg above the default cap and its cap is 4096 MB; every other leg, and a changed-lines run, keeps the default exactly", () => {
    const caps = capsByLeg();
    const above = Object.entries(caps).filter(([, mb]) => mb > DEFAULT_CAP_MB).map(([g]) => g);
    expect(above, "the legs above the default cap").toEqual([CORE2.leg]);
    expect(caps[CORE2.leg], "core-2's cap").toBe(CORE2.passesAtMb);
    let checked = 0;
    for (const [g, mb] of Object.entries(caps)) {
      if (g === CORE2.leg) continue;
      expect(mb, `${g} keeps the default cap`).toBe(DEFAULT_CAP_MB);
      checked++;
    }
    // every leg but core-2, plus the changed-lines run
    expect(checked, "configs held to the default").toBe(legs.length);
    expect(checked).toBeGreaterThan(0);
  }, spawnBudget(1));

  it("the per-leg table names core-2 and nothing else (an entry for a name that is not a leg would be inert, and one for another leg is a second exception)", () => {
    expect(STRYKER_HEAP_MB_BY_LEG).toEqual({ [CORE2.leg]: CORE2.passesAtMb });
    const strays = Object.keys(STRYKER_HEAP_MB_BY_LEG).filter((g) => !legs.includes(g));
    expect(strays, "entries that are not legs").toEqual([]);
  });

  it("the exception is measured both ways: above every cap core-2's dry run ran out of memory at, and no higher than the cap it ran to the end at (4096 is the most, not a floor)", () => {
    const core2 = capsByLeg()[CORE2.leg] as number;
    // the default itself failed, and so did the most the default's own rule allows (half the runner over 3 children: 2730.7 MB),
    // so no value of the default could serve core-2: it is an exception, not a default to raise
    expect(CORE2.failsAtMb).toContain(DEFAULT_CAP_MB);
    expect(Math.max(...CORE2.failsAtMb), "the default rule's own ceiling, whole MB").toBe(Math.floor(HOSTED.memBytes / 2 / HOSTED_CONCURRENCY / MB));
    expect(core2, "above every cap the dry run failed at").toBeGreaterThan(Math.max(...CORE2.failsAtMb));
    expect(core2, "no higher than the cap the leg was measured to pass at: above it nothing was run").toBeLessThanOrEqual(CORE2.passesAtMb);
    // and a runaway mutant on core-2 dies in the time measured AT that cap (42.3 s): above 4096 MB no kill was timed
    expect(core2, "no higher than the cap a runaway loop's death was timed at").toBeLessThanOrEqual(RUNAWAY.highMb);
  }, spawnBudget(1));

  it("core-2's children fit the runner as they were measured to: 3 at 4096 MB are 12 GiB, the three quarters of a hosted runner run 41153932848 ran to the end on, over the default's half (why it is an exception), and fewer sandboxes would put the leg over the split line", () => {
    const core2 = capsByLeg()[CORE2.leg] as number;
    expect(strykerConcurrency(HOSTED), "the hosted concurrency is the one the leg was measured at").toBe(CORE2.concurrency);
    const children = core2 * CORE2.concurrency * MB;
    const measuredCeiling = CORE2.passesAtMb * CORE2.concurrency * MB;
    expect(measuredCeiling, "12 GiB is three quarters of the runner, 4 GiB left for Stryker's own process and the OS").toBe((HOSTED.memBytes * 3) / 4);
    expect(children, "all of core-2's children at their cap, against what the measured run held").toBeLessThanOrEqual(measuredCeiling);
    expect(children, "over the half the default is held to: the exception is a real departure, so it is pinned").toBeGreaterThan(HOSTED.memBytes / 2);
    // the other way to fit the half (2 children at 4096) is not measured, and its phase alone would pass the split line
    expect((CORE2.phaseSeconds * CORE2.concurrency) / (CORE2.concurrency - 1) / 60, "core-2's phase over one sandbox fewer, minutes").toBeGreaterThan(CORE2.splitLineMinutes);
  }, spawnBudget(1));

  it("the measurement the exception rests on is the one stryker-measured.json records for core-2 (one run, two readers)", () => {
    const measured = JSON.parse(readFileSync(join(ENGINE, "stryker-measured.json"), "utf8")) as { measured: Record<string, { mutants: number; phaseSeconds: number; run?: { id: number; job: number; sha: string } }> };
    const leg = measured.measured[CORE2.leg];
    expect(leg, "core-2 is a measured leg").toBeDefined();
    expect(leg).toMatchObject({ mutants: CORE2.mutants, phaseSeconds: CORE2.phaseSeconds, run: { id: 41153932848, job: 124396562181, sha: "49fd3dbd7" } });
  });
});
