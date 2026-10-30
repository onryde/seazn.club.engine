// Moved from onryde/seazn.club@5a67fbf37d25675c683bbc91785bba5bacd93714:scripts/__tests__/main-module.test.ts (engine-split 2b Task E1; reverse inventory row 15,
// :59-65): the FB-10 test, which starts the engine's own boundary gate through a symlinked path. The rest of that file tests the
// root's scripts/lib/main-module.ts and stays in onryde/seazn.club. The title and assertions are verbatim; only paths are
// re-rooted (the engine is this repository's root: `packages/engine/scripts/engine-boundary.ts` is `scripts/engine-boundary.ts`).
// The ledger is onryde/seazn.club docs/superpowers/specs/engine-split/ledgers/2b.json.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "scripts-main-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// One spawn's cap, and the budget derived from it (AGENTS.md class 20: a flat
// timeout beside a derived cost is a latent red). The harness keeps the same
// pair in tools/matrix/__tests__/spawn-budget.ts, which scripts/ may not import.
const SPAWN_MS = 25_000;
const SLACK_MS = 5_000;

describe("isMainModule — the entry-script check the matrix CLIs and the repo gates share", () => {
  it("final batch FB-10: the engine boundary gate (scripts/engine-boundary.ts) started through a symlinked path runs its scan — never a silent 0", () => {
    // It takes no input to refuse: on a clean engine it passes, so the witness
    // is its PASS line (the old idiom loaded, printed nothing and exited 0).
    const via = join(dir, "link-engine-boundary.ts");
    // The gate moved into the engine package (engine-split 1d-2): the title names it package-relative, which is still true there.
    symlinkSync(resolve(REPO, "scripts/engine-boundary.ts"), via);
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", via], { cwd: REPO, encoding: "utf8", timeout: SPAWN_MS, env: { PATH: process.env.PATH ?? "" } });
    expect(r.stdout, `engine-boundary: no PASS line — main never ran (stderr: ${r.stderr})`).toContain("PASS  engine boundary clean");
    expect(r.status, r.stderr).toBe(0);
  }, SPAWN_MS + SLACK_MS);
});
