// The engine half of one test of onryde/seazn.club@5a67fbf37d25675c683bbc91785bba5bacd93714:tools/matrix/__tests__/scenarios.test.ts (engine-split
// 2b Task E2; reverse inventory row 25b; owner ruling 2026-10-30, option A: split the mixed tests, same assertions). The source test pins the
// product's lineup PUT from its source and ends on one scan over `apps/web/src` AND `packages/engine/src` for callers of `assertLineup(`. That
// scan is the engine half: it is below, titled as the source with " (engine half)", over this repository's `src`, its expectations the source's
// (the one caller is the engine's catalog, holding one call). The rest of the test, and the app's half of the scan, keep the original id in
// onryde/seazn.club. The ledger is onryde/seazn.club docs/superpowers/specs/engine-split/ledgers/2b.json.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(resolve(REPO, rel), "utf8");

describe("team rosters and per-fixture lineups (W1-driving Task 4, fold-in beneath ruling 49)", () => {
  it("Step 0: the product's lineup PUT, pinned from its source — the refusal codes, replace-not-append, a warning-only check, no event-time assertLineup (engine half)", () => {
    // No event refuses through assertLineup: nothing outside its own definition (and the engine's tests) calls it,
    // so no lineup is required to post — a forfeit or a walkover needs none, and M1's hook is left alone.
    // (engine half) The source's roots were ["apps/web/src", "packages/engine/src"]; the engine's own is this repository's src.
    const sources = ["src"].flatMap((root) => (readdirSync(resolve(REPO, root), { recursive: true }) as string[])
      .filter((p) => /\.tsx?$/.test(p) && !/\.test\.tsx?$|__tests__/.test(p)).map((p) => `${root}/${p}`));
    expect(sources.length, "product and engine sources scanned").toBeGreaterThan(100);
    const callers = sources.filter((p) => /\bassertLineup\(/.test(read(p)));
    expect(callers).toEqual(["src/sport/catalog.ts"]);
    expect(read("src/sport/catalog.ts").match(/\bassertLineup\(/g)).toHaveLength(1);
  });
});
