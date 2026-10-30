// Moved from onryde/seazn.club@5a67fbf37d25675c683bbc91785bba5bacd93714:apps/web/src/server/engine-db/__tests__/append-event.test.ts (engine-split 2b Task E1; reverse inventory row 4):
// the K7 test of the "no logger outside the sanctioned funnel" describe, which polices the engine (zero effectful deps) and so
// belongs with it. K5 and K6 police apps/web and stay there. The title and assertions are verbatim; only paths are re-rooted (the
// engine is this repository's root: `packages/engine/src/sports` is `src/sports`). The ledger is onryde/seazn.club
// docs/superpowers/specs/engine-split/ledgers/2b.json.
// Under Stryker the scan reads the checkout's `src`, never the sandbox's instrumented copy (./checkout-source.ts).
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CHECKOUT, refuseInstrumented } from "./checkout-source.ts";

// Static, DB-independent checks — always run, regardless of DATABASE_URL.
const REPO_ROOT = CHECKOUT;
const ENGINE_SPORTS_DIR = resolve(REPO_ROOT, "src/sports");

function sourceFilesUnder(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__" || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFilesUnder(full, exts));
    } else if (exts.some((ext) => entry.name.endsWith(ext)) && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("no logger outside the sanctioned funnel (R3.5 Task K, K6/K7)", () => {
  it("K7: no sport module imports a logger (packages/engine is zero-effectful-deps by declaration)", () => {
    const files = sourceFilesUnder(ENGINE_SPORTS_DIR, [".ts"]);
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter((f) =>
      /from\s+["']pino["']|require\(\s*["']pino["']\s*\)/.test(refuseInstrumented(f, readFileSync(f, "utf8"))),
    );
    expect(offenders).toEqual([]);
  });
});
