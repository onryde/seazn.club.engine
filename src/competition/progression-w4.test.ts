// W4 knockout engine, Task 8 (plan 2026-11-05-w4-knockout-engine.md; RB4-Q2): `rank_range` over a source whose ranks can
// tie. A bracket source's places come from `placementTable(FinalPlace[])` and may share a rank (a knockout's two
// semi-final losers both 3rd, X-FR-1). `rank_range` takes by POSITION in rank order, so a take never needs a rank nobody
// holds, and a row whose rank it shares with another is flagged `tieUnbroken`, `tieBreak.key: "shared_place"` — the
// organiser decides the order (controller ruling B3-8). A strict table resolves exactly the rows it always did.
// Expected values come from the Rank places table (plan Global Constraints), never from the resolver.
// single-sport: progression is sport-agnostic (reads no SportModule)
import { describe, expect, it } from "vitest";
import { EngineError } from "../core/errors.ts";
import { generateSingleElim } from "../scheduling/bracket.ts";
import { playOutBracket } from "../testkit/bracket-play.ts";
import { placementTable, resolveProgression, type ProgressionSpec, type SourceTables } from "./progression.ts";
import type { StandingsRow } from "./standings.ts";
import { completeBracketStage, type BracketStage, type FinalPlace } from "./stage.ts";

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `E${i + 1}`);
const seedsOf = (list: readonly string[]): Map<string, number> => new Map(list.map((id, i) => [id, i + 1]));
const rankRange = (from: number, to: number): ProgressionSpec => ({
  sources: [{ stage: "previous", take: [{ kind: "rankRange", from, to }] }],
  placement: "rank_order",
});
const fromPlaces = (finalRanks: readonly FinalPlace[]): SourceTables => ({ pools: [placementTable(finalRanks)] });
const resolve = (spec: ProgressionSpec, source: SourceTables) => resolveProgression(spec, [{ poolKeys: [] }], [source]);

/** A generated 8-draw knockout played out to seed, completed: the REAL producer of a bracket source's places. */
function knockoutPlaces(thirdPlace: boolean): FinalPlace[] {
  const stage: BracketStage = { id: "ko", kind: "knockout", entrants: ids(8), seeds: seedsOf(ids(8)) };
  const rows = playOutBracket(generateSingleElim({ entrants: ids(8), seeds: seedsOf(ids(8)), ...(thirdPlace ? { thirdPlace } : {}) }), { seeds: seedsOf(ids(8)) });
  return completeBracketStage(stage, rows).finalRanks;
}

function refusalOf(run: () => unknown): EngineError {
  try {
    run();
  } catch (e) {
    if (e instanceof EngineError) return e;
    throw e;
  }
  throw new Error("expected a refusal, the call returned");
}

describe("rank_range over a bracket source by position (Task 8, RB4-Q2, controller ruling B3-8)", () => {
  it("rank_range 1..4 over 1,2,3,4 takes four, none flagged", () => {
    // A knockout with a decided play-off: Rank places, "Play-off decided": E1 1, E2 2, E3 3, E4 4 (every match to seed).
    const source = fromPlaces(knockoutPlaces(true));
    const { qualifiers, ties } = resolve(rankRange(1, 4), source);
    expect(qualifiers.map((q) => [q.entrantId, q.rank, q.tieUnbroken])).toEqual([
      ["E1", 1, false],
      ["E2", 2, false],
      ["E3", 3, false],
      ["E4", 4, false],
    ]);
    expect(ties).toEqual([]);
  });

  it("rank_range 1..4 over 1,2,3,3 takes four, flagged shared_place at 3", () => {
    // differential: today STAGE_NOT_READY "takes rank 4" — no row is ranked 4th.
    // A knockout with no play-off: Rank places, "n ≥ 4, Shared": E1 1, E2 2, E3 3, E4 3. q at a whole round (the four
    // semi-finalists) needs no rank 4; the two 3rds' order between them is an unbroken tie the organiser decides.
    const source = fromPlaces(knockoutPlaces(false));
    const { qualifiers, ties } = resolve(rankRange(1, 4), source);
    expect(qualifiers.map((q) => [q.entrantId, q.rank, q.tieUnbroken])).toEqual([
      ["E1", 1, false],
      ["E2", 2, false],
      ["E3", 3, true],
      ["E4", 3, true],
    ]);
    expect(ties).toEqual([
      {
        descriptors: [
          { sourceIndex: 0, descriptor: { kind: "rank_range", rank: 3 } },
          { sourceIndex: 0, descriptor: { kind: "rank_range", rank: 4 } },
        ],
        entrantIds: ["E3", "E4"],
        reason: "shared_place",
      },
    ]);
    // A second call on the same table gives the same answer, and the source rows are not flagged in place.
    expect(resolve(rankRange(1, 4), source)).toEqual(resolve(rankRange(1, 4), source));
    expect(source.pools[0]?.rows.some((row) => row.tieUnbroken === true)).toBe(false);
  });

  it("rank_range 1..3 over ranks 1,2,3,3: both 3rds flagged tieUnbroken shared_place, never STAGE_NOT_READY", () => {
    // differential: today the first rank-3 row, no flag
    // The cut falls inside the shared 3rd: position 3 is E3 (seed order within the place), and the tie names both 3rds.
    const { qualifiers, ties } = resolve(rankRange(1, 3), fromPlaces(knockoutPlaces(false)));
    expect(qualifiers.map((q) => [q.entrantId, q.rank, q.tieUnbroken])).toEqual([
      ["E1", 1, false],
      ["E2", 2, false],
      ["E3", 3, true],
    ]);
    expect(ties).toEqual([
      { descriptors: [{ sourceIndex: 0, descriptor: { kind: "rank_range", rank: 3 } }], entrantIds: ["E3", "E4"], reason: "shared_place" },
    ]);
  });

  it("the empty case: rankRange 1..2 over an empty table → today's STAGE_NOT_READY message, unchanged", () => {
    const empty = refusalOf(() => resolve(rankRange(1, 2), fromPlaces([])));
    expect(empty.code).toBe("STAGE_NOT_READY");
    expect(empty.message).toBe("the previous stage takes rank 1, but only 0 entrants are available — lower the qualifier count or add entrants");
    expect(empty.data).toEqual({ pool: "", rank: 1, available: 0 });
    // One past the end of a one-row table: the singular form, as before.
    const short = refusalOf(() => resolve(rankRange(1, 2), fromPlaces([{ entrantId: "E1", rank: 1 }])));
    expect(short.message).toBe("the previous stage takes rank 2, but only 1 entrant is available — lower the qualifier count or add entrants");
  });

  it("a strict 8-row table: rankRange 3..6 resolves the same rows as before (the regression pair)", () => {
    // A table stage's rows (rank = position), listed out of rank order as a stored snapshot may be: by rank, as before.
    const order = ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"];
    const rows = [...order].reverse().map((entrantId) => ({ entrantId, rank: order.indexOf(entrantId) + 1 }) as StandingsRow);
    const { qualifiers, ties } = resolve(rankRange(3, 6), { pools: [{ pool: "", rows }] });
    expect(qualifiers.map((q) => [q.entrantId, q.rank, q.tieUnbroken])).toEqual([
      ["t3", 3, false],
      ["t4", 4, false],
      ["t5", 5, false],
      ["t6", 6, false],
    ]);
    expect(ties).toEqual([]);
    // A row the standings already flagged (an unbroken tie on every cascade key) keeps its own flag and reason.
    const flagged = rows.map((row) => (row.entrantId === "t4" ? { ...row, tieUnbroken: true, tieBreak: { key: "seed", with: ["t5"] } } : row));
    const kept = resolve(rankRange(3, 6), { pools: [{ pool: "", rows: flagged }] });
    expect(kept.qualifiers.map((q) => q.tieUnbroken)).toEqual([false, true, false, false]);
    expect(kept.ties).toEqual([{ descriptors: [{ sourceIndex: 0, descriptor: { kind: "rank_range", rank: 4 } }], entrantIds: ["t4", "t5"], reason: "seed" }]);
  });
});
