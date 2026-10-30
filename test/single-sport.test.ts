// Engine-split 2b Task E2 (plan false premise 2): the single-sport ratchet's `--check --against HEAD^1` on this repository's import commit.
// scripts/single-sport.ts was moved in by Task E1 from onryde/seazn.club's tools/matrix/single-sport.ts; its own test file
// (tools/matrix/__tests__/single-sport.test.ts) stays there with the app's half of the ratchet, so this file holds the engine repository's
// cases only: the ones that exist because this repository starts at ONE import commit whose parent is the README commit.
//   - On the import commit CI's HEAD^1 is that README commit: no baseline, no scanner and no package.json there. That is "the baseline is
//     being introduced", a notice, and the committed baseline is still held to today's counts (its own counts are the ceiling): a pin above
//     it, or a count that fell unrecorded, is still exit 1. Never a pass by skipping.
//   - A HEAD^1 that does not resolve (a shallow clone) is refused, exit 2.
// Every claim is checked by RUNNING the CLI against a real git history, the engine at the repository root as here.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { BASELINE_PATH, RATCHET_SCRIPT, SCANNER_PATH } from "../scripts/single-sport.ts";
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
