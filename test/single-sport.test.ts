// Engine-split 2b Task E2 (plan false premise 2): the single-sport ratchet's `--check --against HEAD^1` on this repository's import commit.
// scripts/single-sport.ts was moved in by Task E1 from onryde/seazn.club's tools/matrix/single-sport.ts; its own test file
// (tools/matrix/__tests__/single-sport.test.ts) stays there with the app's half of the ratchet, so this file holds the engine repository's
// cases only: the ones that exist because this repository starts at ONE import commit whose parent is the README commit.
//   - On the import commit CI's HEAD^1 is that README commit: no baseline, no scanner and no package.json there. That is "the baseline is
//     being introduced", a notice, and the committed baseline is still held to today's counts (its own counts are the ceiling): a pin above
//     it, or a count that fell unrecorded, is still exit 1. Never a pass by skipping.
//   - A HEAD^1 that does not resolve (a shallow clone) is refused, exit 2.
// Every claim is checked by RUNNING the CLI against a real git history, the engine at the repository root as here.
//
// The second half of this file (the scope and the ZERO refusal) is the engine's twin of three cases that onryde/seazn.club's
// tools/matrix/__tests__/single-sport.test.ts held at engine-split-base and lost when the scanner's engine scope roots left that repository
// (ledger docs/superpowers/specs/engine-split/ledgers/2b.json, 2b A3): "one scope root that finds nothing is refused by name even when the
// others find files" (retired, "the engine repo's test/single-sport.test.ts has no grammar or multi-root case"), the scope case (narrowed:
// "engine fixtures/witnesses left with packages/engine; engine twin owed") and the empty case, whose expected roots were the app's. The
// assertions are the tag's; the paths are re-rooted (`packages/engine/src/x` is `src/x`, and the two name roots `packages/engine/src` and
// `apps/web/src` are this scanner's one, `src`).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { BASELINE_PATH, NAME_ROOTS, RATCHET_SCRIPT, SCANNER_PATH, SCOPE_DIRS, scanSingleSport } from "../scripts/single-sport.ts";
import { builtinModules } from "../src/sports/index.ts";
import { SPAWN_MS, spawnBudget } from "./spawn-budget.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = resolve(REPO, SCANNER_PATH);
// single-sport: the fixture needs one registry key as a pin token; which sport it is does not matter to the ratchet.
const SPORT = builtinModules[0]!.key;

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

// Git must not see the parent's repository (a hook sets GIT_DIR) or its identity.
const cleanEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
  return env;
};
function git(root: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", root, "-c", "user.email=ratchet@example.invalid", "-c", "user.name=Ratchet", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8", env: cleanEnv() });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
function cli(root: string, ...args: string[]) {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", CLI, ...args, "--root", root], { cwd: REPO, encoding: "utf8", timeout: SPAWN_MS, env: cleanEnv() });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
function write(root: string, files: Record<string, string>): void {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
}
const baseline = (pins: Record<string, number>) => `${JSON.stringify({ schemaVersion: 2, generatedBy: SCANNER_PATH, pins, moves: {} }, null, 2)}\n`;
const PIN_FILE = "src/competition/standings.test.ts";

/** The README commit, then the import commit: one test file under each scope root (`competition/standings.test.ts` also counts for the `src`
 *  name root), one unreasoned pin, the baseline recording it, and a package.json that runs the ratchet. */
function importCommit(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "engine-ss-")));
  roots.push(root);
  write(root, { "README.md": "# seazn.club.engine\n" });
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "first commit");
  write(root, {
    "src/scheduling/sched.test.ts": "const a = 1;\n",
    [PIN_FILE]: `f("${SPORT}");\n`,
    [BASELINE_PATH]: baseline({ [`${PIN_FILE}:${SPORT}`]: 1 }),
    "package.json": `${JSON.stringify({ name: "@onryde/seazn-engine", scripts: { [RATCHET_SCRIPT]: `node --experimental-strip-types ${SCANNER_PATH}` } }, null, 2)}\n`,
  });
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "chore: import @onryde/seazn-engine");
  return root;
}
const NOTICE = `::notice::single-sport: HEAD^1 has no ${BASELINE_PATH} yet — the baseline is being introduced, so its own counts are the ceiling`;

describe("single-sport --check --against HEAD^1 on this repository's import commit (engine-split 2b E2, plan false premise 2)", () => {
  it("the import commit: HEAD^1 (the README commit) has no baseline, so the committed baseline is checked against itself: exit 0, a notice, and what it scanned", { timeout: spawnBudget(1) }, () => {
    const r = cli(importCommit(), "--check", "--against", "HEAD^1");
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
    expect(r.stdout).toContain(NOTICE);
    // the counts are the fixture's: two test files (the name root counts standings.test.ts again), one pin, unreasoned, in one entry
    expect(r.stdout).toContain("single-sport: 2 files scanned (src/scheduling 1, src/competition 1, src 1); 1 pins, 1 unreasoned in 1 file:sport entries");
    expect(r.stdout).toContain(`single-sport: check passed against ${BASELINE_PATH} and HEAD^1`);
  });

  it("the README parent excuses nothing in the baseline itself: a pin above it, or a count that fell unrecorded, is still exit 1", { timeout: spawnBudget(2) }, () => {
    const rose = importCommit();
    write(rose, { "src/scheduling/sched.test.ts": `g("${SPORT}");\n` });
    const up = cli(rose, "--check", "--against", "HEAD^1");
    expect(up.status).toBe(1);
    expect(up.stdout).toContain(NOTICE);
    expect(up.stdout).toContain("single-sport: check FAILED — 1 new, 0 risen, 0 fallen and unrecorded, 0 raised above HEAD^1");
    expect(up.stderr).toContain(`new unreasoned single-sport pin src/scheduling/sched.test.ts:${SPORT} (0 → 1)`);
    const fell = importCommit();
    write(fell, { [PIN_FILE]: "const b = 2;\n" });
    const down = cli(fell, "--check", "--against", "HEAD^1");
    expect(down.status).toBe(1);
    expect(down.stdout).toContain("single-sport: check FAILED — 0 new, 0 risen, 1 fallen and unrecorded, 0 raised above HEAD^1");
  });

  it("a shallow clone of the import (fetch-depth 1) cannot resolve HEAD^1: exit 2, never a pass", { timeout: spawnBudget(1) }, () => {
    const root = importCommit();
    const clone = join(realpathSync(mkdtempSync(join(tmpdir(), "engine-ss-shallow-"))), "shallow");
    roots.push(dirname(clone));
    git(dirname(clone), "clone", "-q", "--depth", "1", `file://${root}`, clone);
    expect(git(clone, "rev-parse", "--is-shallow-repository")).toBe("true");
    const r = cli(clone, "--check", "--against", "HEAD^1");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--against HEAD^1: no such commit here");
    expect(r.stdout).not.toContain("check passed");
    expect(r.stdout).not.toContain("::notice::");
  });
});

// ---------------------------------------------------------------- the scope and the ZERO refusal (engine twins of the app's R26 cases)

/** The scope roots these cases exercise, in the scanner's order: two scope directories, then the one name root. The scanner exports them as
 *  SCOPE_DIRS and NAME_ROOTS and the premise case pins both lists to this one, so a root added there fails here instead of going unexercised. */
const ROOTS = ["src/scheduling", "src/competition", "src"];
const REGISTRY = builtinModules.map((m) => m.key);

/** A scratch tree: `files` maps a repo-relative path to its text. */
function tree(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "engine-ss-scope-")));
  roots.push(root);
  write(root, files);
  return root;
}

/** The roots a ZERO refusal names: `scanned ZERO files under <root>[, <root>…] in <dir> — the scope is wrong, not clean`. */
const namedRoots = (stderr: string): string[] => (/scanned ZERO files under (.+?) in /.exec(stderr)?.[1] ?? "").split(", ").filter((r) => r !== "");

// One sweep-free file under every scope root, so the CLI has nothing to refuse on scope grounds, and EXACTLY one file that counts for each
// root, so dropping a file empties that root and no other. `competition/matches.test.ts` is in a scope directory but its name is not a name
// hit, so it never counts for `src`; `stats/tiebreak-order.test.ts` is a name hit outside both scope directories, so it is `src`'s only file.
// (The app's fixture used `competition/standings.test.ts`, which counts for BOTH, so dropping it could not tell the two roots apart.)
const FULL: Record<string, string> = {
  "src/scheduling/sched.test.ts": "const a = 1;\n",
  "src/competition/matches.test.ts": "const b = 2;\n",
  "src/stats/tiebreak-order.test.ts": "const c = 3;\n",
};
// the root each FULL file alone feeds, written out here so the loop below is not derived from FULL's own keys
const DROPS: ReadonlyArray<{ drop: string; empty: string }> = [
  { drop: "src/scheduling/sched.test.ts", empty: "src/scheduling" },
  { drop: "src/competition/matches.test.ts", empty: "src/competition" },
  { drop: "src/stats/tiebreak-order.test.ts", empty: "src" },
];
const MODES: string[][] = [["--check"], [], ["--write"], ["--init"], ["--move", "a.test.ts", "b.test.ts"]];

describe("single-sport scanner scope and ZERO refusal (engine twins of R26, engine-split 2b)", () => {
  it("premise: the scope roots are the three these fixtures exercise, each fixture file feeds one, and the sport keys they use are registry keys (engine)", () => {
    expect([...SCOPE_DIRS, ...NAME_ROOTS]).toEqual(ROOTS);
    expect(DROPS.map((d) => d.empty)).toEqual(ROOTS);
    expect(DROPS.map((d) => d.drop).sort()).toEqual(Object.keys(FULL).sort());
    const full = scanSingleSport(tree(FULL));
    expect(full.perRoot, "one file per root").toEqual({ "src/scheduling": 1, "src/competition": 1, src: 1 });
    expect(full.scanned).toBe(3);
    expect(REGISTRY.length).toBeGreaterThan(0);
    for (const k of ["generic", "badminton", "tennis", "football", "cricket", "volleyball", "hockey"]) expect(REGISTRY).toContain(k);
    for (const k of ["padel", "chess", "setbased", "index"]) expect(REGISTRY).not.toContain(k);
  });

  it("empty case first: a tree with nothing in scope scans zero files — and the CLI, run for real, refuses it with exit 2 in every mode (engine)", { timeout: spawnBudget(MODES.length) }, () => {
    const root = tree({ "README.md": "x" });
    const r = scanSingleSport(root);
    expect(r.scanned).toBe(0);
    expect(r.pins).toEqual([]);
    expect(r.perRoot).toEqual({ "src/scheduling": 0, "src/competition": 0, src: 0 });
    let refused = 0;
    for (const args of MODES) {
      const c = cli(root, ...args);
      expect({ args, status: c.status }).toEqual({ args, status: 2 });
      expect(c.stderr).toMatch(/ZERO/);
      // an empty tree names every root: none is singled out as the one at fault
      expect({ args, named: namedRoots(c.stderr) }).toEqual({ args, named: ROOTS });
      refused++;
    }
    expect(refused, "modes refused").toBe(MODES.length);
    expect(existsSync(join(root, BASELINE_PATH))).toBe(false);
  });

  it("one scope root that finds nothing is refused by name even when the others find files (the CLI, run for real) (engine)", { timeout: spawnBudget(DROPS.length + 1) }, () => {
    let refused = 0;
    for (const { drop, empty } of DROPS) {
      const root = tree(Object.fromEntries(Object.entries(FULL).filter(([p]) => p !== drop)));
      // the others DO find files: this is not the empty tree
      expect({ drop, scanned: scanSingleSport(root).scanned }).toEqual({ drop, scanned: DROPS.length - 1 });
      const c = cli(root);
      expect({ drop, status: c.status }).toEqual({ drop, status: 2 });
      expect(c.stderr).toMatch(/ZERO/);
      // by name: only the emptied root is named. `src` is a prefix of the other two, so the list is compared whole, never searched for a substring
      expect({ drop, named: namedRoots(c.stderr) }).toEqual({ drop, named: [empty] });
      refused++;
    }
    expect(refused, "roots dropped").toBe(ROOTS.length);
    // the positive control: with every root fed, the same CLI on the same fixture passes
    expect(cli(tree(FULL)).status).toBe(0);
  });

  it("scope: .test.ts AND .test.tsx under the scope dirs and the name root; the name is the file's; out-of-scope files are not read (engine)", () => {
    const root = tree({
      "src/scheduling/a.test.ts": `const x = "badminton";\nconst y = 'generic';\nconst z = \`tennis\`;\nconst n = "padel";\nconst m = "generic';\n`,
      "src/scheduling/b.test.tsx": `const el = <Table sport="hockey" />;\n`,
      "src/competition/__tests__/deep.test.ts": `f("cricket");\n`,
      "src/competition/helper.ts": `f("cricket");\n`, // not a test file
      "src/stats/tiebreak-order.test.ts": `f("football");\n`, // named in, outside the scope dirs
      "src/stats/other.test.ts": `f("football");\n`, // neither
      "src/server/usecases/__tests__/stage-progression.test.ts": "sportKey: `tennis`\n",
      "src/server/usecases/__tests__/other.test.ts": `const z = "football";\n`,
      "src/standings/inner.test.ts": `const z = "football";\n`, // the NAME is the file's, not a directory's
      "src/components/standings-table.test.tsx": `const z = render(<T sport="volleyball" />);\n`, // .tsx is in (review I-1)
      "src/node_modules/x/progression.test.ts": `const z = "football";\n`,
      "scripts/standings.test.ts": `const z = "football";\n`, // outside the name root
    });
    const r = scanSingleSport(root);
    expect(r.scanned).toBe(6);
    expect(r.pins.map((p) => [p.file, p.line, p.sport, p.via])).toEqual([
      ["src/competition/__tests__/deep.test.ts", 1, "cricket", "literal"],
      ["src/components/standings-table.test.tsx", 1, "volleyball", "literal"],
      ["src/scheduling/a.test.ts", 1, "badminton", "literal"],
      ["src/scheduling/a.test.ts", 2, "generic", "literal"],
      ["src/scheduling/a.test.ts", 3, "tennis", "literal"],
      ["src/scheduling/b.test.tsx", 1, "hockey", "literal"],
      ["src/server/usecases/__tests__/stage-progression.test.ts", 1, "tennis", "literal"],
      ["src/stats/tiebreak-order.test.ts", 1, "football", "literal"],
    ]);
    // the app's two name roots (`packages/engine/src` 1, `apps/web/src` 2) are this scanner's one: 1 + 2
    expect(r.perRoot).toEqual({ "src/scheduling": 2, "src/competition": 1, src: 3 });
  });
});
