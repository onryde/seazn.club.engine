// The engine half of one test of onryde/seazn.club@5a67fbf37d25675c683bbc91785bba5bacd93714:tools/matrix/__tests__/http-driver.test.ts (engine-split
// 2b Task E2; reverse inventory row 26; owner ruling 2026-10-30, option A: split the mixed tests, same assertions). The source test pins two
// facts the matrix's HTTP driver relies on: that core.void is a kernel core event (read from packages/engine/src/core/events.ts) and that
// PATCH /fixtures/:id takes scheduled_at as an offset datetime or null (read from apps/web). The first is the engine half: it is below, titled
// as the source with " (engine half)", reading this repository's src/core/events.ts with the source's expectation. The PatchFixture half keeps
// the original id in onryde/seazn.club. The ledger is onryde/seazn.club docs/superpowers/specs/engine-split/ledgers/2b.json.
// Under Stryker the read is of the checkout's `src`, never the sandbox's instrumented copy (./checkout-source.ts).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CHECKOUT, refuseInstrumented } from "./checkout-source.ts";

const REPO = CHECKOUT;
const product = (rel: string) => refuseInstrumented(rel, readFileSync(resolve(REPO, rel), "utf8"));
// The event type the matrix's driver POSTs to void the newest event: onryde/seazn.club tools/matrix/lib/driver/types.ts `VOID_EVENT` at the tag,
// the CONSUMER's name for it (that harness is not in this repository). The pin is that the engine's registry carries exactly that name.
const VOID_EVENT = "core.void";

describe("HttpDriver — divisionPhase (W1d Task 14, item 15c)", () => {
  it("the void and the dating are the product's: core.void is a kernel core event, and PATCH /fixtures/:id takes scheduled_at as an offset datetime or null (engine half)", () => {
    expect(product("src/core/events.ts")).toContain(`"${VOID_EVENT}": CoreVoid,`);
  });
});
