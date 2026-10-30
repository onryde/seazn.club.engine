// Engine-split 2b Task E1 (plan Task E1 step 2; the 2b-readers review, m1). onryde/seazn.club's matrix readers used to find the
// tie-capable sports by scanning this tree's sport sources for a `kind: "tie"` outcome (tools/matrix applicability.test.ts and
// streams.test.ts). Batch R moved them onto the installed surface: they now take the set from each module's own
// `reachableResultKinds` declaration. That read trusts the declaration it guards, so a sport whose fold writes a tie but forgets
// to declare it would hide from both the LEVEL_PROBES guard and the streams tie sweep. This test keeps the source scan, here
// where reading src/ is legitimate, and holds it equal to the declaration: two independent readings of one fact.
// Under Stryker the scan reads the checkout's sources, never the sandbox's instrumented copy (./checkout-source.ts), where a mutated
// `kind: "tie"` reads `kind: stryMutAct_<hash>("n") ? "" : "tie"`. The declaration is still the sandbox's module, so a mutant that drops
// "tie" from `reachableResultKinds` still fails the equality below.
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { StageKind } from "../src/core/index.ts";
import { builtinModules } from "../src/sports/index.ts";
import { declaredCfgs } from "../src/testkit/declared-cfgs.ts";
import { CHECKOUT, refuseInstrumented } from "./checkout-source.ts";

const SPORTS_SRC = join(CHECKOUT, "src/sports");
const WRITES_TIE = /kind:\s*"tie"/;

/** The directories under src/sports (first path segment) holding a non-test source that writes a `kind: "tie"` outcome, the
 *  scan the matrix readers used before Batch R, and how many sources it read. */
function tieSourceDirs(): { dirs: Set<string>; scanned: number } {
  const sources = (readdirSync(SPORTS_SRC, { recursive: true }) as string[])
    .filter((p) => p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.split(sep).includes("__tests__"));
  const dirs = new Set(sources.filter((p) => WRITES_TIE.test(refuseInstrumented(p, readFileSync(join(SPORTS_SRC, p), "utf8")))).map((p) => p.split(sep)[0]!));
  return { dirs, scanned: sources.length };
}

/** The sports whose module DECLARES a tie reachable: `reachableResultKinds` holds "tie" for some declared config at some stage
 *  kind (the read Batch R's matrix readers make), and how many (sport, config, stage kind) cells were read. */
function declaredTieSports(): { sports: Set<string>; cells: number } {
  let cells = 0;
  const sports = new Set<string>();
  for (const m of builtinModules) {
    for (const { cfg } of declaredCfgs(m as never)) {
      for (const stage of StageKind.options) {
        cells++;
        if (m.reachableResultKinds(cfg, stage).has("tie")) sports.add(m.key);
      }
    }
  }
  return { sports, cells };
}

describe("a sport whose fold writes a tie declares it reachable (engine-split 2b-readers review m1)", () => {
  it("the sports whose source writes `kind: \"tie\"` are exactly the sports whose module declares a reachable tie", () => {
    const written = tieSourceDirs();
    const declared = declaredTieSports();
    // anti-vacuity: both readings saw the tree (an empty scan and an empty declaration would be equal)
    expect(written.scanned, "sport sources scanned").toBeGreaterThan(builtinModules.length);
    expect(declared.cells, "(sport, config, stage kind) cells read").toBeGreaterThanOrEqual(builtinModules.length * StageKind.options.length);
    // the rulebook control: cricket's level result is a tie (rules/cricket.md CK-PT-1 pays a tie, CK-SO-2 declares one; MCC Laws of
    // Cricket, Law 16.3), so cricket is in both sets whatever the code says
    expect([...written.dirs], "the scan finds cricket's tie").toContain("cricket");
    expect([...declared.sports], "cricket declares its tie").toContain("cricket");
    expect([...declared.sports].sort(), `${written.scanned} sources scanned, ${declared.cells} cells read`).toEqual([...written.dirs].sort());
  });
});
