// The checkout's own source, for the tests in test/ that READ `src/` as text: the tests moved in from onryde/seazn.club and the engine
// halves split from them (engine-split 2b Tasks E1 and E2: outcome-readers, tie-declaration-parity, scenarios, http-driver, append-event,
// ci-wiring). In onryde/seazn.club they lived in apps/web and tools/matrix and never ran under Stryker. Here they do: every test runs
// from a COPY of this repository, `<repo>/.stryker-tmp/sandbox-<id>/`, and the copy of every file a leg mutates is INSTRUMENTED. Stryker
// prepends its helpers (whose `cover.apply(null, arguments)` is an `.apply(` call site) and wraps each expression it can mutate in a
// `stryMutAct_<hash>("n") ? ... : ...` choice, so a text scan of the copy counts code nobody wrote and the leg's dry run fails
// (mutation.yml run 41097384340: core-1's "19 .apply( call sites scanned", core-2's and core-3's allowed-file counts in "finding 1").
//
// The fix is the one src/sport/outcome-methods-source.test.ts and src/testkit/golden-policy.test.ts already make: read the checkout's
// own, untouched files above the sandbox (outOfSandbox), and refuse by name a source that still carries Stryker's helpers
// (refuseInstrumented). What a test IMPORTS is still the sandbox's, so every mutant is still judged by the tests that run the code.
// Outside a sandbox every path is unchanged.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The segment Stryker copies this repository into (stryker.config.mjs `tempDirName`, then `sandbox-<id>`). It needs the slash after
 *  the id, so a directory is named with its trailing slash before the segment is taken out (CHECKOUT below). */
const SANDBOX = /\.stryker-tmp\/sandbox-[A-Za-z0-9_-]+\//;
/** `path` in the checkout: the one sandbox segment taken out, every other path unchanged. */
export const outOfSandbox = (path: string): string => path.replace(SANDBOX, "");

/** Stryker's instrumentation helpers (`stryNS_<hash>`, `stryCov_<hash>`, `stryMutAct_<hash>`): a source that carries one is a sandbox
 *  copy, and a scan of it is the false red above. The mapping is an assumption; this makes it a guard with a name. */
const INSTRUMENTED = /\bstry(?:NS|Cov|MutAct)_[0-9a-f]+/;
export const refuseInstrumented = (path: string, text: string): string => {
  if (INSTRUMENTED.test(text)) throw new Error(`${path} is Stryker-instrumented: the scan must read the checkout's source, not a sandbox copy`);
  return text;
};

/** This repository's root in the checkout, never in a sandbox (no trailing slash, as `resolve` gives it). */
export const CHECKOUT = resolve(outOfSandbox(fileURLToPath(new URL("../", import.meta.url))));
