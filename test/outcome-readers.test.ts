// Moved from onryde/seazn.club@5a67fbf37d25675c683bbc91785bba5bacd93714:apps/web/src/server/engine-db/__tests__/outcome-readers.test.ts (engine-split 2b Task E1; reverse inventory row 6, engine
// half): the two tests of the "finding 1" describe that read only the engine — the golden corpora's settle allowance and the
// teeth of its scan — with the scan helper they share, copied unedited. The describe's other tests scan apps/web, tools/matrix/lib
// and the engine together and stay in onryde/seazn.club. Titles and assertions are verbatim; only paths are re-rooted (the engine
// is this repository's root: `packages/engine/src/sports` is `src/sports`, and `@seazn/engine/core` is `../src/core/index.ts`). The
// ledger is onryde/seazn.club docs/superpowers/specs/engine-split/ledgers/2b.json.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SETTLE_METHODS, settledMethod } from "../src/core/index.ts";

const REPO = resolve(__dirname, "..");

describe("finding 1: every fold-outcome reader goes through outcomeOf", () => {
  type ScanCorpus = { format?: number; streams: { config: string; seed: number; outcome: string; events: { type: string; voids?: string }[] }[] };
  /** One corpus read the way the allowance in golden.ts needs it: what it holds, what was actually checked, and what is wrong. */
  const scanSettles = (file: string, corpus: ScanCorpus, settledMethods: readonly string[]) => {
    const out = { streams: 0, settleStreams: 0, checked: 0, struck: 0, wrong: [] as string[] };
    corpus.streams.forEach((stream, i) => {
      out.streams++;
      const settles = stream.events.map((e, k) => (e.type === "core.settle" ? k : -1)).filter((k) => k >= 0);
      if (settles.length === 0) return;
      out.settleStreams++;
      const label = `${file}#${i} (${stream.config}#${stream.seed})`;
      // a settle only ever reaches a corpus recorded by the format-2 recorder or a later one (format 3 is format 2 plus the player
      // stats): the format-1 recorder would have written the module's answer
      if ((corpus.format ?? 1) < 2) out.wrong.push(`${label}: carries core.settle in a format-${corpus.format ?? 1} corpus`);
      // the settle in force at the end (no later void strikes it) decides the match: the recorded outcome is a settled win
      const standing = settles.filter((k) => !stream.events.some((e) => e.voids === `e-${k}`));
      out.struck += settles.length - standing.length;
      if (standing.length === 0) return;
      out.checked++;
      const outcome = JSON.parse(stream.outcome) as { kind?: string; method?: string } | null;
      if (outcome === null || outcome.kind !== "win" || !settledMethods.includes(outcome.method as string)) out.wrong.push(`${label}: ends on ${stream.outcome}, not a settled win`);
    });
    return out;
  };

  it("golden.ts's allowance holds: every corpus stream that carries core.settle is recorded by the format-2 recorder or a later one, and ends on a settled win (the reason is a guard, not a comment)", () => {
    const SPORTS = join(REPO, "src/sports");
    const settledMethods = SETTLE_METHODS.map(settledMethod);
    let streams = 0;
    let settleStreams = 0;
    let checked = 0; // streams whose standing settle was read against the recorded outcome
    let struck = 0; // settles a later void strikes (the "said again" half of every settle story)
    const wrong: string[] = [];
    const sports = new Set<string>();
    for (const dir of readdirSync(SPORTS)) {
      if (!statSync(join(SPORTS, dir)).isDirectory()) continue;
      for (const file of readdirSync(join(SPORTS, dir)).filter((n) => n.endsWith(".golden.json"))) {
        const read = scanSettles(file, JSON.parse(readFileSync(join(SPORTS, dir, file), "utf8")) as ScanCorpus, settledMethods);
        streams += read.streams;
        settleStreams += read.settleStreams;
        checked += read.checked;
        struck += read.struck;
        wrong.push(...read.wrong);
        if (read.settleStreams > 0) sports.add(file);
      }
    }
    expect(streams).toBeGreaterThan(200);
    expect(settleStreams, "a settle stream in every sport's corpus").toBeGreaterThanOrEqual(sports.size);
    expect(sports.size, "every sport records a settle").toBeGreaterThanOrEqual(11);
    // Anti-vacuity: a stream whose settle is struck and never said again is skipped, so a scan that skipped EVERY stream would
    // read as clean. Every sport's settle story ends on a standing settle and strikes one on the way.
    expect(checked, "a standing settle was actually checked in every sport").toBeGreaterThanOrEqual(sports.size);
    expect(struck, "a struck settle in every sport").toBeGreaterThanOrEqual(sports.size);
    expect(wrong).toEqual([]);
  });

  it("the settle scan has teeth: each way a settle stream can be wrong is reported, a struck-only settle is skipped, and a good stream is clean", () => {
    const methods = SETTLE_METHODS.map(settledMethod);
    const good = JSON.stringify({ kind: "win", method: methods[0] });
    const stream = (outcome: string, events: { type: string; voids?: string }[]) => ({ config: "c", seed: 1, outcome, events });
    const settle = { type: "core.settle" };
    // control: a standing settle ending on a settled win in a format-2 corpus
    const clean = scanSettles("f", { format: 2, streams: [stream(good, [settle])] }, methods);
    expect(clean).toMatchObject({ settleStreams: 1, checked: 1, struck: 0, wrong: [] });
    // the same stream in a format-3 corpus (GF-2 T4: format 2 plus the player stats) is as clean: a later format is the real recorder too
    expect(scanSettles("f", { format: 3, streams: [stream(good, [settle])] }, methods), "format 3 is recorded by the effective-outcome recorder").toMatchObject({ settleStreams: 1, checked: 1, struck: 0, wrong: [] });
    // struck then said again: both counted, the standing one checked
    const again = scanSettles("f", { format: 2, streams: [stream(good, [settle, { type: "core.void", voids: "e-0" }, settle])] }, methods);
    expect(again).toMatchObject({ settleStreams: 1, checked: 1, struck: 1, wrong: [] });
    // struck and never said again: skipped, not judged (there is no standing settle to read)
    const gone = scanSettles("f", { format: 2, streams: [stream("null", [settle, { type: "core.void", voids: "e-0" }])] }, methods);
    expect(gone).toMatchObject({ settleStreams: 1, checked: 0, struck: 1, wrong: [] });
    // each way to be wrong
    expect(scanSettles("f", { format: 1, streams: [stream(good, [settle])] }, methods).wrong.join("|")).toContain("format-1 corpus");
    expect(scanSettles("f", { streams: [stream(good, [settle])] }, methods).wrong.join("|"), "no format field is format 1").toContain("format-1 corpus");
    expect(scanSettles("f", { format: 2, streams: [stream(JSON.stringify({ kind: "draw" }), [settle])] }, methods).wrong.join("|")).toContain("not a settled win");
    expect(scanSettles("f", { format: 2, streams: [stream(JSON.stringify({ kind: "draw", method: methods[0] }), [settle])] }, methods).wrong.join("|"), "a settled METHOD on a result that is not a win").toContain("not a settled win");
    expect(scanSettles("f", { format: 2, streams: [stream("null", [settle])] }, methods).wrong.join("|"), "no outcome at all").toContain("not a settled win");
    expect(scanSettles("f", { format: 2, streams: [stream(JSON.stringify({ kind: "win", method: "abandoned" }), [settle])] }, methods).wrong.join("|"), "a win that is not a settled one").toContain("not a settled win");
    expect(methods.length, "the engine declares its settled methods").toBeGreaterThan(0);
  });
});
