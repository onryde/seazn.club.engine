// W4 knockout engine, Task 8 (plan 2026-11-05-w4-knockout-engine.md; RB4-Q2): `rank_range` over a source whose ranks can
// tie. A bracket source's places come from `placementTable(FinalPlace[])` and may share a rank (a knockout's two
// semi-final losers both 3rd, X-FR-1). `rank_range` takes by POSITION in rank order, so a take never needs a rank nobody
// holds, and a row whose rank it shares with another is flagged `tieUnbroken`, `tieBreak.key: "shared_place"` — the
// organiser decides the order (controller ruling B3-8). A strict table resolves exactly the rows it always did.
// Expected values come from the Rank places table (plan Global Constraints), never from the resolver.
//
// Task 10 (RB4-P1, P4; X-PL-3; owner ruling 265, plate option B): the `firstLosses` take. The plate takes every eligible
// first loss of its main draw (`firstLossField`, first-loss.ts) — no fixed count q (RB4-P4). The count is known only once
// the field is (after round 2, RB4-P3), so at save time the take expands to no slot and skips the "< 2 qualifiers"
// refusal; the app sizes the stage from the field and hands the count back as `SourceShape.firstLosses`. Expected
// membership comes from RB4-P1 over the RB4-D1 fold, never from the resolver.
// single-sport: progression is sport-agnostic (reads no SportModule)
import { describe, expect, it } from "vitest";
import { EngineError } from "../core/errors.ts";
import { generateDoubleElim, generateSingleElim } from "../scheduling/bracket.ts";
import { playOutBracket, type PlayOutOptions } from "../testkit/bracket-play.ts";
import {
  descriptorKey,
  descriptorLabel,
  expandSources,
  placementTable,
  progressionSize,
  resolveProgression,
  validateProgressionAgainstShapes,
  type ProgressionSpec,
  type SourceShape,
  type SourceTables,
} from "./progression.ts";
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

// ---------------------------------------------------------------------------------------------------------------------
// Task 10: the firstLosses take (RB4-P1, P4; X-PL-3).
// ---------------------------------------------------------------------------------------------------------------------

const firstLosses: ProgressionSpec = { sources: [{ stage: "previous", take: [{ kind: "firstLosses" }] }], placement: "rank_order" };
const shapeOf = (firstLossCount?: number): SourceShape => ({ poolKeys: [], ...(firstLossCount === undefined ? {} : { firstLosses: firstLossCount }) });

/** 13 entrants in a 16-draw, played out: byes to seeds 1-3 (RB4-D2). Fold lines (1,16b) (9,8) (5,12) (13,4) (3,14b) (11,6)
 *  (7,10) (15b,2): round 1 plays five lines, the worse seed losing each — E9, E12, E13, E11, E10 ((2·13 − 16) / 2 = 5).
 *  Round 2 meets the bye holders: E1 v E8, E3 v E6, E7 v E2 — and the driver's winner makes E6 beat E3, so bye holder
 *  E3 loses its first match (RB4-P1). Everyone else goes to seed. */
const e6BeatsE3 = (home: string, away: string): string => {
  if ([home, away].includes("E3") && [home, away].includes("E6")) return "E6";
  return Number(home.slice(1)) < Number(away.slice(1)) ? home : away;
};
const thirteen = (opts: PlayOutOptions = {}) =>
  playOutBracket(generateSingleElim({ entrants: ids(13), seeds: seedsOf(ids(13)) }), { seeds: seedsOf(ids(13)), winner: e6BeatsE3, ...opts });
const bracketSource = (rows: SourceTables["bracket"]): SourceTables => ({ pools: [], ...(rows === undefined ? {} : { bracket: rows }) });
const resolveFirst = (count: number | undefined, source: SourceTables) => resolveProgression(firstLosses, [shapeOf(count)], [source], "knockout");

describe("X-PL-3 the plate's firstLosses take: every eligible first loss is a slot, no fixed count (RB4-P1, P4)", () => {
  it("X-PL-3 the empty case first: firstLosses with no count expands to no slot and resolves no qualifier", () => {
    expect(expandSources(firstLosses.sources, () => shapeOf())).toEqual([[]]);
    expect(resolveFirst(undefined, bracketSource(thirteen()))).toEqual({ qualifiers: [], ties: [], newLotsDraws: [] });
  });

  it("X-PL-3 firstLosses at save time (no count) validates without the <2 refusal and expands to no slot", () => {
    // differential: today's take kinds refuse a progression of fewer than 2 qualifiers; the plate's field is unknown until
    // round 2 (RB4-P3), so it cannot be counted here — X-PL-2's "too small" is the app's named outcome once it is.
    expect(() => validateProgressionAgainstShapes([shapeOf()], firstLosses, "knockout")).not.toThrow();
    // The refusal still holds once the shape knows the count, and for every other take (the regression pair).
    const counted = refusalOf(() => validateProgressionAgainstShapes([shapeOf(1)], firstLosses, "knockout"));
    expect(counted.code).toBe("SEEDING_RULES_MISSING");
    const roundLosers: ProgressionSpec = { sources: [{ stage: "previous", take: [{ kind: "roundLosers", round: 0, count: 1 }] }], placement: "rank_order" };
    expect(refusalOf(() => validateProgressionAgainstShapes([shapeOf()], roundLosers, "knockout")).code).toBe("SEEDING_RULES_MISSING");
    // With a count, one pot of first_loss slots, positions 1..count.
    expect(expandSources(firstLosses.sources, () => shapeOf(3))).toEqual([
      [1, 2, 3].map((position) => ({ sourceIndex: 0, descriptor: { kind: "first_loss", position } })),
    ]);
  });

  it("X-PL-3 progressionSize counts a firstLosses take as 0 — callers size it from the field — beside the takes it sums", () => {
    // controller ruling B4-7: the explicit branch is load-bearing; without it the take falls through to roundLosers' count.
    expect(progressionSize([{ kind: "firstLosses" }])).toBe(0);
    expect(progressionSize([{ kind: "rankRange", from: 1, to: 2 }, { kind: "firstLosses" }, { kind: "roundLosers", round: 0, count: 3 }])).toBe(5);
  });

  it("X-PL-3 firstLosses resolves every eligible first loss of a 13-entrant bracket (16-draw, byes to seeds 1-3; the driver's winner makes bye holder E3 lose its R2 line): 6 slots, the 5 round-1 losers plus E3", () => {
    // differential: roundLosers{round:1,count:4} took 4 — today's plate template, the product's round 1 being the engine's
    // round 0 — dropping E10 and E3 (PL-1).
    const rows = thirteen();
    const { qualifiers, ties } = resolveFirst(6, bracketSource(rows));
    expect(qualifiers.map((q) => [q.seed, q.entrantId, q.descriptor])).toEqual(
      ["E9", "E12", "E13", "E11", "E10", "E3"].map((entrantId, i) => [i + 1, entrantId, { kind: "first_loss", position: i + 1 }]),
    );
    expect(ties).toEqual([]);
    const today = resolveProgression(
      { sources: [{ stage: "previous", take: [{ kind: "roundLosers", round: 0, count: 4 }] }], placement: "rank_order" },
      [shapeOf()],
      [bracketSource(rows)],
    );
    expect(today.qualifiers.map((q) => q.entrantId)).toEqual(["E9", "E12", "E13", "E11"]);
  });

  it("X-PL-3 an incomplete field → STAGE_NOT_READY first_loss_field_incomplete; a count of 5 against that field of 6 → first_loss_field_changed", () => {
    // E3 v E6 (round 2) not yet played: E3's first match is unknown, so the field is not final.
    // Round 2's E1 v E8 and E7 v E2 are played; E3 v E6 is seated, still scheduled; everything later is still to come.
    const played = new Set(["se-r1-i0", "se-r1-i3"]);
    const open = thirteen().map((row) => {
      if (row.round === 0 || played.has(row.id)) return row;
      return { id: row.id, round: row.round, status: "scheduled" as const, ...(row.id === "se-r1-i2" ? { home: "E3", away: "E6" } : {}) };
    });
    const incomplete = refusalOf(() => resolveFirst(6, bracketSource(open)));
    expect(incomplete.code).toBe("STAGE_NOT_READY");
    expect(incomplete.data).toEqual({ reason: "first_loss_field_incomplete", sourceIndex: 0, pending: ["se-r1-i2"] });
    // No bracket on the source at all is no main draw yet: never a final field (controller ruling B4-2).
    expect(refusalOf(() => resolveFirst(6, bracketSource(undefined))).data).toEqual({ reason: "first_loss_field_incomplete", sourceIndex: 0, pending: [] });
    // The shape's count was taken from an earlier field: a field that has since grown or shrunk is refused, either way.
    for (const count of [5, 7]) {
      const changed = refusalOf(() => resolveFirst(count, bracketSource(thirteen())));
      expect(changed.code, `count ${count}`).toBe("STAGE_NOT_READY");
      expect(changed.data, `count ${count}`).toEqual({ reason: "first_loss_field_changed", sourceIndex: 0, expected: count, found: 6 });
    }
  });

  it("X-PL-3 a forfeit loser never appears in a slot, and a second call is identical", () => {
    // E9 forfeits its round-1 line to E8 (RB4-P2: out of the plate). E8 won without playing, so its first match is round 2,
    // lost to E1: a first loss (RB4-P1). Six slots still: E12, E13, E11, E10, then E8 and E3 in round 2's bracket order.
    const source = bracketSource(thirteen({ forfeit: new Map([["se-r0-i1", "E9"]]) }));
    const first = resolveFirst(6, source);
    expect(first.qualifiers.map((q) => q.entrantId)).toEqual(["E12", "E13", "E11", "E10", "E8", "E3"]);
    expect(first.qualifiers.map((q) => q.entrantId)).not.toContain("E9");
    expect(resolveFirst(6, source)).toEqual(first);
  });

  it("X-PL-3 another bracket kind: firstLosses over a double elimination refuses by name (the plate is a single-elimination feed)", () => {
    const de = playOutBracket(generateDoubleElim({ entrants: ids(4), seeds: seedsOf(ids(4)) }), { seeds: seedsOf(ids(4)) });
    const err = refusalOf(() => resolveFirst(2, bracketSource(de)));
    expect(err.code).toBe("CONFIG_INVALID");
    expect((err.data as { reason?: string }).reason).toBe("first_loss_not_single_elimination");
  });

  it("descriptorKey first:3; descriptorLabel slot.first_loss {n: 3}", () => {
    expect(descriptorKey({ kind: "first_loss", position: 3 })).toBe("first:3");
    expect(descriptorLabel({ kind: "first_loss", position: 3 })).toEqual({ key: "slot.first_loss", params: { n: 3 } });
  });

  it("roundLosers still resolves as before, over the widened rows and over the old two-field rows (the regression pair)", () => {
    const spec: ProgressionSpec = { sources: [{ stage: "previous", take: [{ kind: "roundLosers", round: 0, count: 5 }] }], placement: "rank_order" };
    const widened = resolveProgression(spec, [shapeOf()], [bracketSource(thirteen())]);
    expect(widened.qualifiers.map((q) => [q.entrantId, q.descriptor])).toEqual(
      ["E9", "E12", "E13", "E11", "E10"].map((entrantId, i) => [entrantId, { kind: "round_loser", round: 0, position: i + 1 }]),
    );
    const old = resolveProgression(spec, [shapeOf()], [bracketSource(thirteen().map((row) => ({ round: row.round, ...(row.loser === undefined ? {} : { loser: row.loser }) })))]);
    expect(old).toEqual(widened);
  });
});
