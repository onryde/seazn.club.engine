// W4 knockout engine — ranks that can tie (plan 2026-11-05-w4-knockout-engine.md, batch B3, Tasks 5-8). Rows proved here
// live in rules/cross-sport.md; the rulebook is rulebook-W4-knockout.md (RB4-*), signed by rulings 263-274.
//
// X-FR-1 (RB4-R1): a completed bracket's final ranks cover every entrant of the stage exactly once (withdrawn and
// disqualified entrants included, and one in no fixture at all) as a permutation, except the declared shared places. A
// rank is now `FinalPlace { entrantId, rank }`. Two entrants may share a rank only at 1, 2, 3 or 4, never more than two
// (BRACKET_SHARED_RANKS), and only where the stage's own fixtures declare that shape (controller ruling B3-1).
//
// Expected values come from the plan's Rank places table (Global Constraints) and the rulebook, never from bracketRanks.
// Each pinned rank carries the table line it comes from.
// single-sport: bracket code is sport-agnostic (reads no SportModule)
import { describe, expect, it } from "vitest";
import { EngineError } from "../core/errors.ts";
import {
  generateDoubleElim,
  generatePagePlayoff,
  generateSingleElim,
  generateStepladder,
  type GeneratedBracket,
} from "../scheduling/bracket.ts";
import { playOutBracket, type PlayOutOptions } from "../testkit/bracket-play.ts";
import { tableRulesOf } from "../testkit/helpers.ts";
import { placementTable } from "./progression.ts";
import type { FixtureResult } from "./standings.ts";
import {
  assertBracketPlaces,
  assertCompletedBracketPlaces,
  BRACKET_SHARED_RANKS,
  bracketRanks,
  bracketTitle,
  completeBracketStage,
  completeTableStage,
  type BracketFixture,
  type BracketStage,
  type FinalPlace,
  type TableFixture,
  type TableStage,
} from "./stage.ts";

/** Ranks by position: the i-th id ranks i + 1 (a strict order). */
const places = (...ids: string[]): FinalPlace[] => ids.map((entrantId, i) => ({ entrantId, rank: i + 1 }));
/** Places written out, for a shape with a shared or a vacant rank. */
const ranked = (...pairs: readonly (readonly [string, number])[]): FinalPlace[] => pairs.map(([entrantId, rank]) => ({ entrantId, rank }));
const seedsOf = (ids: readonly string[]): Map<string, number> => new Map(ids.map((id, i) => [id, i + 1]));
const decided = (id: string, round: number, home: string, away: string, winner: string, extra: Partial<BracketFixture> = {}): BracketFixture =>
  ({ id, round, status: "decided", home, away, winner, loser: winner === home ? away : home, ...extra });

/** The refusal a call throws; a call that returns instead fails the test. */
function refusalOf(run: () => unknown): EngineError {
  try {
    run();
  } catch (e) {
    if (e instanceof EngineError) return e;
    throw e;
  }
  throw new Error("expected a refusal, the call returned");
}

/** A wiring bug the engine refuses by name: CONFIG_INVALID, with the reason the guard names. */
function expectInvalid(run: () => unknown, reason: string): void {
  const err = refusalOf(run);
  expect(err.code, err.message).toBe("CONFIG_INVALID");
  expect((err.data as { reason?: unknown }).reason, err.message).toBe(reason);
}

// The 4-entrant single-elimination shape `generateSingleElim({ thirdPlace: true })` writes (seed fold 1v4, 3v2), every
// semi-final to seed, S1 champion, and the play-off an upset: S4 beats S3. Rank places table, "n ≥ 4, Play-off decided":
// 1, 2, 3, 4 — S1, S2, then the play-off's winner S4 and its loser S3.
const PLAYOFF4: BracketFixture[] = [
  decided("se-r0-i0", 0, "S1", "S4", "S1"),
  decided("se-r0-i1", 0, "S3", "S2", "S2"),
  decided("se-r1-i0", 1, "S1", "S2", "S1", { isFinal: true }),
  decided("se-3p", 1, "S3", "S4", "S4", { thirdPlace: true }),
];
const S4_SEEDS = seedsOf(["S1", "S2", "S3", "S4"]);

// An 8-entrant knockout (seed fold 1v8, 4v5, 3v6, 2v7), every match to seed, then the play-off an upset: E4 beats E3.
// Rank places table, "n ≥ 4, Play-off decided": E1, E2, E4, E3, then the quarter-final losers by seed (X-FR-2) 5..8.
const E = ["E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8"];
const QUARTERS: BracketFixture[] = [
  decided("se-r0-i0", 0, "E1", "E8", "E1"),
  decided("se-r0-i1", 0, "E4", "E5", "E4"),
  decided("se-r0-i2", 0, "E3", "E6", "E3"),
  decided("se-r0-i3", 0, "E7", "E2", "E2"),
];
const SEMIS: BracketFixture[] = [decided("se-r1-i0", 1, "E1", "E4", "E1"), decided("se-r1-i1", 1, "E3", "E2", "E2")];
const FINAL = decided("se-r2-i0", 2, "E1", "E2", "E1", { isFinal: true });
const THIRD = decided("se-3p", 2, "E4", "E3", "E4", { thirdPlace: true });
const PLAYOFF8 = [...QUARTERS, ...SEMIS, FINAL, THIRD];
const ko8: BracketStage = { id: "ko", kind: "knockout", entrants: E, seeds: seedsOf(E) };

describe("X-FR-1 ranks are FinalPlace[] over the stage's declared entrants (Task 5)", () => {
  it("X-FR-1 the empty case first: a stage with no entrants and no fixtures ranks nobody, and assertBracketPlaces([], []) passes", () => {
    // RB4-R1: ranks cover every entrant of the stage; a stage with none has no place to give.
    expect(bracketRanks({ id: "ko", kind: "knockout", entrants: [] }, [])).toEqual([]);
    expect(() => assertBracketPlaces([], [])).not.toThrow();
    // BRACKET_SHARED_RANKS is the rule text's "only at 1, 2, 3 or 4" (Global Constraints), nothing more.
    expect([...BRACKET_SHARED_RANKS].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  it("X-FR-1 a declared entrant in no fixture (a departed qualifier whose line was voided) is ranked, last", () => {
    // differential: today W is absent — bracketRanks ranked only the entrants its fixtures name.
    // W was seeded 1, so a seed-first order would put W at the top: last is the elimination rule, not the seed.
    const stage: BracketStage = { id: "ko", kind: "knockout", entrants: ["W", "S1", "S2", "S3", "S4"], seeds: seedsOf(["W", "S1", "S2", "S3", "S4"]) };
    // Rank places, "n ≥ 4, Play-off decided": S1, S2, S4 (play-off won), S3; W, who played nothing, below every round.
    const want = places("S1", "S2", "S4", "S3", "W");
    expect(bracketRanks(stage, PLAYOFF4)).toEqual(want);
    expect(completeBracketStage(stage, PLAYOFF4).finalRanks).toEqual(want);

    // Another bracket kind: a stepladder (A, B, C by seed; B beats C, then A beats B) with W declared and never seated.
    // Rank places, "stepladder: strict 1 … n": A, B, C, then W.
    const ladder: BracketStage = { id: "sl", kind: "stepladder", entrants: ["A", "B", "C", "W"], seeds: seedsOf(["W", "A", "B", "C"]) };
    const rungs = [decided("sl-g0", 0, "B", "C", "B"), decided("sl-g1", 1, "A", "B", "A", { isFinal: true })];
    expect(completeBracketStage(ladder, rungs).finalRanks).toEqual(places("A", "B", "C", "W"));
  });

  it("X-FR-1 a second call on the same rows gives the same places, and neither call moves the rows", () => {
    const stage: BracketStage = { id: "ko", kind: "knockout", entrants: ["S1", "S2", "S3", "S4"], seeds: S4_SEEDS };
    const before = structuredClone(PLAYOFF4);
    const first = completeBracketStage(stage, PLAYOFF4);
    expect(completeBracketStage(stage, PLAYOFF4)).toEqual(first);
    expect(bracketRanks(stage, PLAYOFF4)).toEqual(first.finalRanks);
    expect(first.events).toEqual([{ type: "stage_completed", stageId: "ko", finalRanks: places("S1", "S2", "S4", "S3") }]);
    expect(PLAYOFF4).toEqual(before);
  });

  it("X-FR-1 an entrant in a fixture but not in stage.entrants → CONFIG_INVALID", () => {
    // Assumption → guard: the stage declares its entrants, so a fixture naming anyone else is a wiring bug.
    // differential: today Z is ranked like any entrant.
    const stage: BracketStage = { id: "ko", kind: "knockout", entrants: ["S1", "S2", "S3", "S4"], seeds: S4_SEEDS };
    const rows: BracketFixture[] = [
      { id: "x", round: 0, status: "scheduled", home: "Z", away: "S1" },
      { id: "x", round: 0, status: "scheduled", home: "S1", away: "Z" },
      { id: "x", round: 0, status: "walkover", home: "S1", winner: "Z" },
      { id: "x", round: 0, status: "decided", home: "S1", away: "S2", winner: "S1", loser: "Z" },
    ];
    let checked = 0;
    for (const row of rows) {
      expectInvalid(() => bracketRanks(stage, [...PLAYOFF4, row]), "undeclared_entrant");
      checked++;
    }
    expect(checked, "fixture slots checked (home, away, winner, loser)").toBe(4);
    // Completion reads the same ranks, so it refuses too (every row above but the scheduled ones is settled).
    expectInvalid(() => completeBracketStage(stage, [...PLAYOFF4, rows[3] as BracketFixture]), "undeclared_entrant");
  });

  it("X-FR-1 a duplicated entrant in stage.entrants → CONFIG_INVALID", () => {
    // Assumption → guard: "each entrant exactly once" needs a declared list without a repeat.
    const stage: BracketStage = { id: "ko", kind: "knockout", entrants: ["S1", "S2", "S3", "S4", "S2"], seeds: S4_SEEDS };
    expectInvalid(() => bracketRanks(stage, PLAYOFF4), "duplicate_declared_entrant");
    expectInvalid(() => bracketRanks({ ...stage, entrants: ["A", "A"] }, []), "duplicate_declared_entrant");
  });

  it("X-FR-1 bracketRanks never returns a place set the guard refuses", () => {
    // The guard runs inside bracketRanks: a fixture naming an undeclared entrant reaches it as a place, and is refused
    // there rather than returned (Step 6(a)).
    const stage: BracketStage = { id: "ko", kind: "knockout", entrants: ["S1", "S2", "S3"], seeds: S4_SEEDS };
    expectInvalid(() => bracketRanks(stage, PLAYOFF4), "undeclared_entrant");
    // C3: every entrant declared, so the undeclared clause passes, and a place missing: the guard's own throw, CONFIG_INVALID.
    expectInvalid(() => assertBracketPlaces(["S1", "S2", "S3", "S4"], places("S1", "S2", "S4")), "missing_entrant");
  });

  it("X-FR-1 assertBracketPlaces refuses a missing entrant, a duplicate, an undeclared one, ranks out of order, a non-positive and a non-integer rank", () => {
    const declared = ["A", "B", "C", "D"];
    const cases: [string, FinalPlace[]][] = [
      ["missing_entrant", places("A", "B", "C")],
      ["duplicate_entrant", places("A", "B", "B", "C", "D")],
      ["undeclared_entrant", places("A", "B", "C", "Z")],
      ["rank_order", ranked(["A", 1], ["B", 3], ["C", 2], ["D", 4])],
      ["rank_not_positive_integer", ranked(["A", 0], ["B", 2], ["C", 3], ["D", 4])],
      ["rank_not_positive_integer", ranked(["A", 1], ["B", 2.5], ["C", 3], ["D", 4])],
    ];
    let refused = 0;
    for (const [reason, set] of cases) {
      expectInvalid(() => assertBracketPlaces(declared, set), reason);
      refused++;
    }
    expect(refused).toBe(6);
    expect(() => assertBracketPlaces(declared, places("A", "B", "C", "D"))).not.toThrow();
  });
});

describe("X-FR-1 at completion only the declared shared places pass (Task 5, controller ruling B3-1)", () => {
  // Each shape below is refused at completion and accepted provisionally: assertBracketPlaces is structural, and a
  // mid-bracket read never refuses (Review Focus 5). The stage is PLAYOFF8, whose play-off and final were both decided,
  // so its Rank places line is strict 1 … 8 and it declares no shared or vacant place at all.
  const killers: [string, string, FinalPlace[]][] = [
    ["three at rank 3", "more_than_two", ranked(["E1", 1], ["E2", 2], ["E4", 3], ["E3", 3], ["E5", 3], ["E6", 6], ["E7", 7], ["E8", 8])],
    ["two at rank 5", "not_a_shared_rank", ranked(["E1", 1], ["E2", 2], ["E4", 3], ["E3", 4], ["E5", 5], ["E6", 5], ["E7", 7], ["E8", 8])],
    ["[1,2,2,4]: a tie at 2 with a 1st", "undeclared_shared_place", ranked(["E1", 1], ["E2", 2], ["E4", 2], ["E3", 4], ["E5", 5], ["E6", 6], ["E7", 7], ["E8", 8])],
    ["[1,1,2]: joint winners with nothing declared", "undeclared_shared_place", ranked(["E1", 1], ["E2", 1], ["E4", 2], ["E3", 4], ["E5", 5], ["E6", 6], ["E7", 7], ["E8", 8])],
    ["[1,2,4,4]: two 4ths with the play-off decided", "undeclared_shared_place", ranked(["E1", 1], ["E2", 2], ["E4", 4], ["E3", 4], ["E5", 5], ["E6", 6], ["E7", 7], ["E8", 8])],
    ["[1,2,3,3]: a shared 3rd with the play-off decided", "undeclared_shared_place", ranked(["E1", 1], ["E2", 2], ["E4", 3], ["E3", 3], ["E5", 5], ["E6", 6], ["E7", 7], ["E8", 8])],
    ["[2,2]: a vacant title with the final decided", "undeclared_shared_place", ranked(["E1", 2], ["E2", 2], ["E4", 3], ["E3", 4], ["E5", 5], ["E6", 6], ["E7", 7], ["E8", 8])],
    ["[1,2,4,5]: a rank skipped with no tie", "not_competition_ranking", ranked(["E1", 1], ["E2", 2], ["E4", 4], ["E3", 5], ["E5", 6], ["E6", 7], ["E7", 8], ["E8", 9])],
    ["[1,3,4]: no 2nd with the final decided", "not_competition_ranking", ranked(["E1", 1], ["E2", 3], ["E4", 4], ["E3", 5], ["E5", 6], ["E6", 7], ["E7", 8], ["E8", 9])],
  ];

  it("X-FR-1 the strict check accepts the stage's own strict ranks (the positive pair)", () => {
    // Rank places, "n ≥ 4, Play-off decided": 1, 2, 3, 4, then 5 … strict.
    const want = places("E1", "E2", "E4", "E3", "E5", "E6", "E7", "E8");
    expect(completeBracketStage(ko8, PLAYOFF8).finalRanks).toEqual(want);
    expect(() => assertCompletedBracketPlaces(ko8, PLAYOFF8, want)).not.toThrow();
  });

  it("X-FR-1 the strict check refuses every shape outside the Rank places table, each by its reason, and assertBracketPlaces accepts each", () => {
    let checked = 0;
    for (const [what, reason, set] of killers) {
      expect(() => assertBracketPlaces(E, set), what).not.toThrow();
      expectInvalid(() => assertCompletedBracketPlaces(ko8, PLAYOFF8, set), reason);
      checked++;
    }
    expect(checked, "shapes checked").toBe(9);
  });

  it("X-FR-1 the strict check holds a set to the structural one first: a declared entrant missing, or ranks out of order → CONFIG_INVALID", () => {
    // B3 fix round 1 (review m1): assertCompletedBracketPlaces is exported, so it owes the structural check itself. E8
    // missing leaves a strict 1 … 7 the walk alone accepts; ranks out of order the walk would refuse only by another
    // reason. Each is refused here by the structural reason.
    expectInvalid(() => assertCompletedBracketPlaces(ko8, PLAYOFF8, places("E1", "E2", "E4", "E3", "E5", "E6", "E7")), "missing_entrant");
    expectInvalid(
      () => assertCompletedBracketPlaces(ko8, PLAYOFF8, ranked(["E1", 1], ["E2", 2], ["E3", 4], ["E4", 3], ["E5", 5], ["E6", 6], ["E7", 7], ["E8", 8])),
      "rank_order",
    );
  });
});

describe("X-FR-1 provisional ranks mid-bracket (Task 5, Review Focus 5, controller ruling B3-3)", () => {
  it("X-FR-1 mid-bracket ranks are provisional and valid: every entrant still in play ranks above every entrant out", () => {
    // A half-played 8-draw: the quarter-finals went E8 > E1, E5 > E4, E3 > E6, E7 > E2 (upsets, so seed order is not
    // bracket order), the semi-finals are seated and scheduled, the final is not yet seated.
    const half: BracketFixture[] = [
      decided("se-r0-i0", 0, "E1", "E8", "E8"),
      decided("se-r0-i1", 0, "E4", "E5", "E5"),
      decided("se-r0-i2", 0, "E3", "E6", "E3"),
      decided("se-r0-i3", 0, "E7", "E2", "E7"),
      { id: "se-r1-i0", round: 1, status: "scheduled", home: "E8", away: "E5" },
      { id: "se-r1-i1", round: 1, status: "in_play", home: "E3", away: "E7" },
      { id: "se-r2-i0", round: 2, isFinal: true, status: "scheduled" },
    ];
    // B3-3: the four still in play first (by seed: E3, E5, E7, E8), then the quarter-final losers by seed (E1, E2, E4,
    // E6). differential: today the unbeaten four had no loss round and ranked LAST, below every quarter-final loser.
    const want = places("E3", "E5", "E7", "E8", "E1", "E2", "E4", "E6");
    expect(bracketRanks(ko8, half)).toEqual(want);
    expect(() => assertBracketPlaces(E, bracketRanks(ko8, half))).not.toThrow();
    // Provisional only: completing it is refused (X-CH-7), never ranked.
    expect(refusalOf(() => completeBracketStage(ko8, half)).code).toBe("STAGE_NOT_READY");
  });

  it("X-FR-1 mid-bracket: an entrant walked over is out there, even while a stale unsettled row still seats it", () => {
    // The same half-played draw, but E2 forfeited its quarter-final to E7 (walkedOver "loser", X-DE-1's out-at-fixture
    // rule), and a stale scheduled row still seats E2 against E3. E2 is out at round 0, not in play: the four in play,
    // then the quarter-final losers by seed, E2 among them.
    const stale: BracketFixture[] = [
      decided("se-r0-i0", 0, "E1", "E8", "E8"),
      decided("se-r0-i1", 0, "E4", "E5", "E5"),
      decided("se-r0-i2", 0, "E3", "E6", "E3"),
      { id: "se-r0-i3", round: 0, status: "walkover", home: "E7", away: "E2", winner: "E7", loser: "E2", walkedOver: "loser" },
      { id: "se-r1-i0", round: 1, status: "scheduled", home: "E8", away: "E5" },
      { id: "se-r1-i1", round: 1, status: "scheduled", home: "E3", away: "E7" },
      { id: "stale", round: 1, status: "scheduled", home: "E3", away: "E2" },
      { id: "se-r2-i0", round: 2, isFinal: true, status: "scheduled" },
    ];
    expect(bracketRanks(ko8, stale)).toEqual(places("E3", "E5", "E7", "E8", "E1", "E2", "E4", "E6"));
  });

  it("X-FR-1 mid-bracket in a double elimination: a losers'-bracket side still in play ranks above one already out, below the unbeaten", () => {
    // 4-entrant double elimination (generateDoubleElim's rounds: WB 0-1, LB 2-3, GF 4). WB round 0: E4 upsets E1, E2
    // beats E3; the LB round-0 game E1 > E3 is played, so E3 is out; the WB final and LB round 1 are scheduled.
    // B3-3: in play first, fewest losses first — E2, E4 (unbeaten, seed order), then E1 (one loss, though seeded 1);
    // then E3, out. differential: today E3 (last loss round 2) ranked first and the unbeaten E2, E4 ranked last.
    const de: BracketStage = { id: "de", kind: "double_elim", entrants: ["E1", "E2", "E3", "E4"], seeds: seedsOf(["E1", "E2", "E3", "E4"]) };
    const rows: BracketFixture[] = [
      decided("wb-r0-i0", 0, "E1", "E4", "E4", { bracket: "WB" }),
      decided("wb-r0-i1", 0, "E3", "E2", "E2", { bracket: "WB" }),
      { id: "wb-r1-i0", bracket: "WB", round: 1, status: "scheduled", home: "E4", away: "E2" },
      decided("lb-r0-i0", 2, "E1", "E3", "E1", { bracket: "LB" }),
      { id: "lb-r1-i0", bracket: "LB", round: 3, status: "scheduled", home: "E1" },
      { id: "gf", bracket: "GF", round: 4, isFinal: true, status: "scheduled" },
    ];
    expect(bracketRanks(de, rows)).toEqual(places("E2", "E4", "E1", "E3"));
    // A second call on the same rows gives the same places.
    expect(bracketRanks(de, rows)).toEqual(places("E2", "E4", "E1", "E3"));
  });
});

describe("X-FR-1 the event and the progression read places (Task 5)", () => {
  it("X-FR-1 a table stage's stage_completed carries rank = position", () => {
    // B3-2: a literal, the order stage.test.ts pins for the same two pools (A1 3-0 … rank-1s first), ranked 1..4.
    const fb = (home: string, away: string, hg: number, ag: number): FixtureResult => [
      { entrantId: home, played: 1, won: hg > ag ? 1 : 0, drawn: 0, lost: hg < ag ? 1 : 0, points: hg > ag ? 3 : 0, metrics: { gf: hg, ga: ag, gd: hg - ag } },
      { entrantId: away, played: 1, won: ag > hg ? 1 : 0, drawn: 0, lost: ag < hg ? 1 : 0, points: ag > hg ? 3 : 0, metrics: { gf: ag, ga: hg, gd: ag - hg } },
    ];
    const stage: TableStage = { id: "grp", kind: "group", entrants: ["A1", "A2", "B1", "B2"], rules: tableRulesOf(["points", "diff", "for", "lots"]) };
    const fixtures: TableFixture[] = [
      { id: "a", poolId: "A", status: "decided", result: fb("A1", "A2", 2, 0) },
      { id: "b", poolId: "B", status: "decided", result: fb("B1", "B2", 3, 0) },
    ];
    const done = completeTableStage(stage, fixtures).events.find((e) => e.type === "stage_completed");
    expect(done).toEqual({
      type: "stage_completed",
      stageId: "grp",
      finalRanks: [{ entrantId: "A1", rank: 1 }, { entrantId: "B1", rank: 2 }, { entrantId: "A2", rank: 3 }, { entrantId: "B2", rank: 4 }],
    });
  });

  it("X-FR-1 placementTable keeps a FinalPlace rank and numbers an EntrantId list i + 1; a mixed or unsorted FinalPlace input → CONFIG_INVALID", () => {
    const rowsOf = (input: Parameters<typeof placementTable>[0]) => placementTable(input).rows.map((row) => [row.entrantId, row.rank]);
    // The empty case: no places, no rows, in either form.
    expect(placementTable([]).rows).toEqual([]);
    // An EntrantId list (a table stage's order, a pre-W4 caller): position i ranks i + 1, as before.
    expect(rowsOf(["S1", "S2", "S3", "S4"])).toEqual([["S1", 1], ["S2", 2], ["S3", 3], ["S4", 4]]);
    // A FinalPlace list keeps its ranks, a shared 3rd included (Rank places, "n ≥ 4, Shared"). differential: today the
    // rows were numbered by position, so S4 read 4th.
    expect(rowsOf(ranked(["S1", 1], ["S2", 2], ["S3", 3], ["S4", 3]))).toEqual([["S1", 1], ["S2", 2], ["S3", 3], ["S4", 3]]);
    expect(placementTable(ranked(["S1", 1], ["S2", 2])).pool).toBe("");
    // Assumption → guard: a list mixing the two forms, or places out of rank order, is a wiring bug.
    const mixed = [{ entrantId: "S1", rank: 1 }, "S2"] as unknown as FinalPlace[];
    expectInvalid(() => placementTable(mixed), "mixed_places");
    expectInvalid(() => placementTable(ranked(["S1", 1], ["S3", 3], ["S2", 2])), "places_out_of_order");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Task 6 — shared 3rd, the play-off's places, strict below the semi-finals (SH-3, Q4; RB4-T2, T3, T6, R2; X-FR-2)
// ---------------------------------------------------------------------------------------------------------------------

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `E${i + 1}`);
/** A generated single-elimination bracket played out, every match to seed unless `opts` says otherwise. */
function knockout(n: number, opts: { thirdPlace?: boolean } & PlayOutOptions = {}): { stage: BracketStage; rows: BracketFixture[] } {
  const entrants = ids(n);
  const seeds = seedsOf(entrants);
  const { thirdPlace, ...play } = opts;
  const rows = playOutBracket(generateSingleElim({ entrants, seeds, ...(thirdPlace === true ? { thirdPlace } : {}) }), { seeds, ...play });
  return { stage: { id: "ko", kind: "knockout", entrants, seeds }, rows };
}
/** Each entrant's rank, by id: a whole place set compared in one line. */
const rankOf = (set: readonly FinalPlace[]): Record<string, number> => Object.fromEntries(set.map((p) => [p.entrantId, p.rank]));

// The 4-draw stage.test.ts pins ("bracketRanks (spec 05 §1)"): S1 > S4, S2 > S3, S1 > S2, no play-off.
const DRAW4: BracketFixture[] = [
  decided("sf1", 0, "S1", "S4", "S1"),
  decided("sf2", 0, "S2", "S3", "S2"),
  decided("fin", 1, "S1", "S2", "S1", { isFinal: true }),
];
const SHARED4 = ranked(["S1", 1], ["S2", 2], ["S3", 3], ["S4", 3]);

describe("X-FR-1 a knockout's semi-final losers share 3rd unless a play-off decides it (Task 6, SH-3, ruling 270)", () => {
  it("X-FR-1 shared 3rd: the 4-draw from stage.test.ts ranks S3 and S4 both 3rd, nobody 4th", () => {
    // differential: today S3 3, S4 4
    // Rank places, "n ≥ 4, Shared (no -3p)": 1, 2, 3, 3. Within the shared rank, seed then id: S3 before S4, though S4's
    // semi-final is listed first.
    const stage: BracketStage = { id: "ko", kind: "knockout", entrants: ["S1", "S2", "S3", "S4"], seeds: S4_SEEDS };
    expect(bracketRanks(stage, DRAW4)).toEqual(SHARED4);
    expect(completeBracketStage(stage, DRAW4).finalRanks).toEqual(SHARED4);
    expect(SHARED4.some((p) => p.rank === 4), "nobody 4th").toBe(false);
    // The declared pair is 3rd in standard competition ranking, after a 1st and a 2nd: a shared 3rd with nobody 2nd is
    // refused (the final had a runner-up), as is a shared 2nd.
    expectInvalid(() => assertCompletedBracketPlaces(stage, DRAW4, ranked(["S1", 1], ["S3", 3], ["S4", 3], ["S2", 4])), "not_competition_ranking");
    expectInvalid(() => assertCompletedBracketPlaces(stage, DRAW4, ranked(["S1", 1], ["S2", 2], ["S3", 2], ["S4", 4])), "undeclared_shared_place");
  });

  it("X-FR-1 a play-off with both sides out: 1, 2, 4, 4, 5 …", () => {
    // differential: today 3/4 by seed
    // Rank places, "Play-off both out (DW)": 1, 2, 4, 4, then 5 … strict; 3rd is vacant. The play-off is E4 v E3.
    const { stage, rows } = knockout(8, { thirdPlace: true, doubleWalkover: new Set(["se-3p"]) });
    const want = ranked(["E1", 1], ["E2", 2], ["E3", 4], ["E4", 4], ["E5", 5], ["E6", 6], ["E7", 7], ["E8", 8]);
    expect(bracketRanks(stage, rows)).toEqual(want);
    expect(completeBracketStage(stage, rows).finalRanks).toEqual(want);
    // A shared 3rd is not declared by a play-off both sides walked over, nor two 4ths with 3rd held.
    expectInvalid(() => assertCompletedBracketPlaces(stage, rows, ranked(["E1", 1], ["E2", 2], ["E3", 3], ["E4", 3], ["E5", 5], ["E6", 6], ["E7", 7], ["E8", 8])), "undeclared_shared_place");
    expectInvalid(() => assertCompletedBracketPlaces(stage, rows, ranked(["E1", 1], ["E2", 2], ["E5", 3], ["E3", 4], ["E4", 4], ["E6", 6], ["E7", 7], ["E8", 8])), "not_competition_ranking");
  });

  it("X-FR-1 a voided play-off: both semi-final losers 3rd", () => {
    // Review Focus 4 (plan's call, B3-6): Rank places, "Play-off voided": 1, 2, 3, 3, 5 …
    const { stage, rows } = knockout(8, { thirdPlace: true, voided: new Set(["se-3p"]) });
    const want = ranked(["E1", 1], ["E2", 2], ["E3", 3], ["E4", 3], ["E5", 5], ["E6", 6], ["E7", 7], ["E8", 8]);
    expect(bracketRanks(stage, rows)).toEqual(want);
    expect(completeBracketStage(stage, rows).finalRanks).toEqual(want);
    // A voided play-off declares the shared 3rd, not the play-off-both-out shape.
    expectInvalid(() => assertCompletedBracketPlaces(stage, rows, ranked(["E1", 1], ["E2", 2], ["E3", 4], ["E4", 4], ["E5", 5], ["E6", 6], ["E7", 7], ["E8", 8])), "undeclared_shared_place");
  });

  it("X-FR-1 a semi lost by walkover (the loser withdrew): with no play-off the forfeiter still shares 3rd; with one it is out and 4th alone", () => {
    // RB4-T2 has no exception: E2 forfeits its semi-final to E3, and still ranks 3rd with E4 (seed order within it).
    const shared = knockout(8, { forfeit: new Map([["se-r1-i1", "E2"]]) });
    const want = ranked(["E1", 1], ["E3", 2], ["E2", 3], ["E4", 3], ["E5", 5], ["E6", 6], ["E7", 7], ["E8", 8]);
    expect(completeBracketStage(shared.stage, shared.rows).finalRanks).toEqual(want);
    // With a play-off, E2 is out at the semi-final (X-FR-3; B3-10: its loser's seat in the play-off is dead), so E4 wins
    // the play-off by walkover: Rank places, "Play-off decided" — E4 3rd, E2 4th.
    const playOff = knockout(8, { thirdPlace: true, forfeit: new Map([["se-r1-i1", "E2"]]) });
    expect(completeBracketStage(playOff.stage, playOff.rows).finalRanks).toEqual(places("E1", "E3", "E4", "E2", "E5", "E6", "E7", "E8"));
  });

  it("X-FR-1 n=3: the one real semi-final loser ranks 3rd alone", () => {
    // RB4-E5: Rank places, "n = 3": 1, 2, 3 — E1's semi-final is a bye, which has no loser.
    const { stage, rows } = knockout(3);
    expect(completeBracketStage(stage, rows).finalRanks).toEqual(places("E1", "E2", "E3"));
    // n = 2: one final, no semi-final round. Rank places, "n = 2": 1, 2.
    const two = knockout(2);
    expect(completeBracketStage(two.stage, two.rows).finalRanks).toEqual(places("E1", "E2"));
  });

  it("X-FR-1 double_elim, stepladder and page_playoff stay strict 1..n", () => {
    // Rank places, "double_elim, stepladder, page_playoff: strict 1 … n". Every match to seed, so the strict order is the
    // seed order (X-FR-2: a later elimination first, then seed).
    const cases: [string, BracketStage["kind"], GeneratedBracket, number][] = [
      ["double elimination, 8, with a bracket reset", "double_elim", generateDoubleElim({ entrants: ids(8), seeds: seedsOf(ids(8)), bracketReset: true }), 8],
      ["stepladder, 4", "stepladder", generateStepladder({ entrants: ids(4), seeds: seedsOf(ids(4)) }), 4],
      ["page playoff, 4", "page_playoff", generatePagePlayoff({ entrants: ids(4), seeds: seedsOf(ids(4)) }), 4],
    ];
    let checked = 0;
    for (const [what, kind, gen, n] of cases) {
      const stage: BracketStage = { id: "s", kind, entrants: ids(n), seeds: seedsOf(ids(n)) };
      const rows = playOutBracket(gen, { seeds: seedsOf(ids(n)) });
      expect(completeBracketStage(stage, rows).finalRanks, what).toEqual(places(...ids(n)));
      checked++;
    }
    // The same 4-draw rows the knockout shares 3rd on, read as each other kind: strict. Only a knockout's semi-final
    // losers share (SH-3); the rows are identical, so the kind alone moves S4 from 3rd to 4th.
    for (const kind of ["double_elim", "stepladder", "page_playoff"] as const) {
      const stage: BracketStage = { id: "s", kind, entrants: ["S1", "S2", "S3", "S4"], seeds: S4_SEEDS };
      expect(completeBracketStage(stage, DRAW4).finalRanks, kind).toEqual(places("S1", "S2", "S3", "S4"));
      // …and a shared 3rd is never declared for it.
      expectInvalid(() => assertCompletedBracketPlaces(stage, DRAW4, SHARED4), "undeclared_shared_place");
      checked++;
    }
    expect(checked, "kinds checked: three played out, three read over the 4-draw").toBe(6);
  });

  it("X-FR-1 mid-bracket: a semi-final loser ranks below the three still in play (provisional, B3-3)", () => {
    // An 8-draw, no play-off: the quarter-finals to seed, the first semi-final E1 > E4, the second (E3 v E2) and the
    // final (E1 seated) still to play. In play first — E1, E2, E3 by seed — then E4, the semi-final's loser, below them:
    // 3rd is never above an entrant still in play. Then the quarter-final losers by seed.
    const rows: BracketFixture[] = [
      ...QUARTERS,
      decided("se-r1-i0", 1, "E1", "E4", "E1"),
      { id: "se-r1-i1", round: 1, status: "scheduled", home: "E3", away: "E2" },
      { id: "se-r2-i0", round: 2, isFinal: true, status: "scheduled", home: "E1" },
    ];
    expect(bracketRanks(ko8, rows)).toEqual(places("E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8"));
  });

  it("X-FR-1 a malformed knockout with three semi-final losers is refused at completion (more_than_two), ranked provisionally", () => {
    // Assumption → guard: a knockout has two semi-finals. Three fixtures in the round before the final give three losers
    // at 3rd; the structural check lets a provisional read through (B3-1), completion refuses it by name.
    const stage: BracketStage = { id: "ko", kind: "knockout", entrants: ["A", "B", "C", "D", "E", "F"], seeds: seedsOf(["A", "B", "C", "D", "E", "F"]) };
    const rows: BracketFixture[] = [
      decided("s1", 0, "A", "B", "A"),
      decided("s2", 0, "C", "D", "C"),
      decided("s3", 0, "E", "F", "E"),
      decided("f", 1, "A", "C", "A", { isFinal: true }),
    ];
    expect(bracketRanks(stage, rows).filter((p) => p.rank === 3).map((p) => p.entrantId)).toEqual(["B", "D", "F"]);
    expectInvalid(() => completeBracketStage(stage, rows), "more_than_two");
  });

  it("X-FR-1 a semi-final both sides walked over: the other semi's winner takes the final by walkover, nobody ranks 2nd", () => {
    // B3-6 (controller call): E2 and E3 both walk over their semi-final, so the final's other seat is dead and E1 wins it
    // by walkover. Rank 2 is vacant — a declared shape only because the final was a walkover over a dead seat. E4, the
    // one semi-final loser, ranks 3rd; E2 and E3, out in the semi-final with no loser's place, rank in the strict block
    // (plan's call), each max(previous rank + 1, placed + 1): 4, 5, then the quarter-final losers 6 … 9.
    const { stage, rows } = knockout(8, { doubleWalkover: new Set(["se-r1-i1"]) });
    const want = ranked(["E1", 1], ["E4", 3], ["E2", 4], ["E3", 5], ["E5", 6], ["E6", 7], ["E7", 8], ["E8", 9]);
    expect(completeBracketStage(stage, rows).finalRanks).toEqual(want);
    // The vacancy is the final's, so the strict check refuses it where the final had a runner-up.
    expectInvalid(() => assertCompletedBracketPlaces(ko8, PLAYOFF8, want), "not_competition_ranking");
  });
});

describe("X-FR-1 counted sweep over the Rank places table (Task 6)", () => {
  // Rank places table: n = 2 → 1, 2; n = 3 → 1, 2, 3; n ≥ 4 Shared (no -3p) → 1, 2, 3, 3, then 5 … n strict; Play-off
  // decided → 1 … n. Typed from the table, never read from bracketRanks.
  const tableRow = (n: number, playOff: boolean): number[] => {
    if (n === 2) return [1, 2];
    if (n === 3) return [1, 2, 3];
    const strictBelow = Array.from({ length: n - 4 }, (_, i) => i + 5);
    return playOff ? [1, 2, 3, 4, ...strictBelow] : [1, 2, 3, 3, ...strictBelow];
  };
  // Every match to seed, so the semi-final losers are seeds 3 and 4 and each round's losers the next seeds down: seed k
  // ranks k, except that seed 4 shares 3rd with seed 3 when no play-off is played (X-FR-2: by round, then seed).
  const rankBySeed = (n: number, playOff: boolean): Record<string, number> =>
    Object.fromEntries(ids(n).map((id, i) => [id, !playOff && n >= 4 && i + 1 === 4 ? 3 : i + 1]));
  let checked = 0;

  it("X-FR-1 Shared n=2..64: the rank multiset is the table's row, and each seed sits where the table puts it", () => {
    for (let n = 2; n <= 64; n++) {
      const { stage, rows } = knockout(n);
      const got = completeBracketStage(stage, rows).finalRanks;
      expect(got.map((p) => p.rank), `n=${n}`).toEqual(tableRow(n, false));
      expect(rankOf(got), `n=${n}`).toEqual(rankBySeed(n, false));
      expect(() => assertBracketPlaces(stage.entrants, got), `n=${n}`).not.toThrow();
      checked++;
    }
  });

  it("X-FR-1 Play-off n=4..64 (T1 refuses it below 4): the rank multiset is 1 … n", () => {
    for (let n = 4; n <= 64; n++) {
      const { stage, rows } = knockout(n, { thirdPlace: true });
      const got = completeBracketStage(stage, rows).finalRanks;
      expect(got.map((p) => p.rank), `n=${n}`).toEqual(tableRow(n, true));
      expect(rankOf(got), `n=${n}`).toEqual(rankBySeed(n, true));
      expect(() => assertBracketPlaces(stage.entrants, got), `n=${n}`).not.toThrow();
      checked++;
    }
  });

  it("X-FR-1 the sweep checked 124 brackets (63 Shared + 61 Play-off)", () => {
    expect(checked).toBe(124);
  });
});

describe("X-FR-2 below the semi-finals ranks stay strict (Task 6, ruling 273, RB4-R2)", () => {
  it("X-FR-2 below the semi-finals: quarter-final losers rank 5–8 by seed, then id; equal 5th is not used (S7)", () => {
    // 8 entrants, E1 … E6 seeded and U, V not. The generator seats E1 v V, E5 v E4, E3 v E6, U v E2; two upsets, E5 > E4
    // and E6 > E3, so bracket position is not seed order. The semi-finals E1 > E5, E2 > E6, the final E1 > E2.
    const entrants = ["E1", "E2", "E3", "E4", "E5", "E6", "U", "V"];
    const seeds = seedsOf(entrants.slice(0, 6));
    const upset = new Map([["E4", "E5"], ["E3", "E6"]]); // favourite → who beats it
    const seedOf = (id: string): number => seeds.get(id) ?? Number.MAX_SAFE_INTEGER;
    const winner = (home: string, away: string): string =>
      upset.get(home) === away ? away : upset.get(away) === home ? home : seedOf(away) < seedOf(home) ? away : home;
    const rows = playOutBracket(generateSingleElim({ entrants, seeds }), { winner });
    const stage: BracketStage = { id: "ko", kind: "knockout", entrants, seeds };
    // Rank places, "n ≥ 4, Shared": E1, E2, then the semi-final losers E5, E6 level 3rd; then the four quarter-final
    // losers, all out in one round, strict 5 … 8 by seed (E3, E4) and then the unseeded by id (U, V). differential: by
    // seed alone E3 and E4 would rank 3rd and 4th.
    const want = ranked(["E1", 1], ["E2", 2], ["E5", 3], ["E6", 3], ["E3", 5], ["E4", 6], ["U", 7], ["V", 8]);
    expect(completeBracketStage(stage, rows).finalRanks).toEqual(want);
    expect(want.filter((p) => p.rank === 5), "equal 5th is not used").toHaveLength(1);
  });

  it("X-FR-2 sequence: a second call agrees, and after a withdrawal at a quarter-final the table's row still holds", () => {
    // 16-draw, no play-off; E1 forfeits its quarter-final (se-r1-i0) to E8. E8 then loses its semi-final to E4, E2 beats
    // E3 and wins the final. Rank places, "n ≥ 4, Shared": E2, E4, then E3 and E8 level 3rd; the quarter-final losers by
    // seed — E1 (out at the fixture it forfeited, X-FR-3), E5, E6, E7 — 5 … 8; the round-0 losers E9 … E16, 9 … 16.
    const { stage, rows } = knockout(16, { forfeit: new Map([["se-r1-i0", "E1"]]) });
    const want = ranked(
      ["E2", 1], ["E4", 2], ["E3", 3], ["E8", 3], ["E1", 5], ["E5", 6], ["E6", 7], ["E7", 8],
      ...ids(16).slice(8).map((id, i): [string, number] => [id, i + 9]),
    );
    const first = completeBracketStage(stage, rows).finalRanks;
    expect(first).toEqual(want);
    expect(first.map((p) => p.rank)).toEqual([1, 2, 3, 3, ...Array.from({ length: 12 }, (_, i) => i + 5)]);
    expect(completeBracketStage(stage, rows).finalRanks, "a second call").toEqual(first);
    expect(bracketRanks(stage, rows), "the provisional read agrees once complete").toEqual(first);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Task 7 — the title: champion, joint winners, vacant (Q4; RB4-C1, C3, C4; X-CH-1, X-FR-1 part 3)
// ---------------------------------------------------------------------------------------------------------------------

/** An 8-draw whose upper semi-final is an upset, E4 over E1: the final is seated E4 (home) v E2, so a pair at the title
 *  is not already in seed order and the within-rank order (seed, then id) is witnessed. */
const upsetE4 = (home: string, away: string): string =>
  (home === "E1" && away === "E4") || (home === "E4" && away === "E1") ? "E4" : Number(away.slice(1)) < Number(home.slice(1)) ? away : home;

describe("X-CH-1 the title: champion, joint winners, vacant (Task 7, Q4; RB4-C1, C3, C4)", () => {
  it("X-CH-1 the empty case: bracketTitle([]) is undefined", () => {
    expect(bracketTitle([])).toBeUndefined();
    // Nothing decided yet: a scheduled final crowns nobody either.
    expect(bracketTitle([{ id: "f", round: 0, isFinal: true, status: "scheduled", home: "A", away: "B" }])).toBeUndefined();
  });

  it("X-CH-1 the champion is the decided final's winner; one champion", () => {
    const { stage, rows } = knockout(8);
    const done = completeBracketStage(stage, rows);
    expect(bracketTitle(rows)).toEqual({ kind: "champion", champion: "E1" });
    expect(done.title).toEqual({ kind: "champion", champion: "E1" });
    expect(done.finalRanks.filter((p) => p.rank === 1).map((p) => p.entrantId), "one champion").toEqual(["E1"]);

    // A double elimination whose reset is played: E2 (from the losers' bracket) wins the grand final, E1 the reset. The
    // latest decided final crowns (spec 05 §2.4): E1. differential: the first grand final's winner is E2.
    let meetings = 0; // E1 v E2: the winners' final, the grand final, the reset
    const winner = (home: string, away: string): string => {
      if ([home, away].sort().join() !== "E1,E2") return Number(away.slice(1)) < Number(home.slice(1)) ? away : home;
      meetings++;
      return meetings === 2 ? "E2" : "E1";
    };
    const de: BracketStage = { id: "de", kind: "double_elim", entrants: ids(4), seeds: seedsOf(ids(4)) };
    const deRows = playOutBracket(generateDoubleElim({ entrants: ids(4), seeds: seedsOf(ids(4)), bracketReset: true }), { winner });
    expect(deRows.find((f) => f.id === "gf")?.winner).toBe("E2");
    expect(deRows.find((f) => f.id === "gf-reset")?.status).toBe("decided");
    expect(meetings, "E1 and E2 met three times").toBe(3);
    const deDone = completeBracketStage(de, deRows);
    expect(deDone.title).toEqual({ kind: "champion", champion: "E1" });
    expect(deDone.finalRanks).toEqual(places("E1", "E2", "E3", "E4"));
  });

  it("X-CH-1 no title while a final is still to play: a double elimination's reset scheduled after the grand final", () => {
    // B3 fix round 1 (review m3, controller ruling): E2, from the losers' bracket, wins the grand final, so the reset is
    // seated E2 v E1 (the grand final's winner at home) and still to play. Nobody is champion yet: the reset may crown E1. differential: before the fix the
    // grand final's winner, E2, was named champion. Once the reset is decided (E1), E1 is.
    let meetings = 0; // E1 v E2: the winners' final, the grand final, the reset
    const winner = (home: string, away: string): string => {
      if ([home, away].sort().join() !== "E1,E2") return Number(away.slice(1)) < Number(home.slice(1)) ? away : home;
      meetings++;
      return meetings === 2 ? "E2" : "E1";
    };
    const decidedRows = playOutBracket(generateDoubleElim({ entrants: ids(4), seeds: seedsOf(ids(4)), bracketReset: true }), { winner });
    const reset = decidedRows.find((f) => f.id === "gf-reset");
    expect([reset?.isFinal, reset?.home, reset?.away, reset?.winner]).toEqual([true, "E2", "E1", "E1"]);
    const pending = decidedRows.map((f): BracketFixture => {
      if (f.id !== "gf-reset") return f;
      const { winner: _w, loser: _l, ...seated } = f;
      return { ...seated, status: "scheduled" };
    });
    expect(pending.find((f) => f.id === "gf")?.winner, "the grand final is decided").toBe("E2");
    expect(bracketTitle(pending)).toBeUndefined();
    expect(bracketTitle(decidedRows)).toEqual({ kind: "champion", champion: "E1" });
    // The same holds for a knockout's final: scheduled → no title; decided → its winner.
    const { rows } = knockout(4);
    const open = rows.map((f): BracketFixture => (f.isFinal === true ? { id: f.id, round: f.round, isFinal: true, status: "scheduled", home: "E1", away: "E2" } : f));
    expect(bracketTitle(open)).toBeUndefined();
    expect(bracketTitle(rows)).toEqual({ kind: "champion", champion: "E1" });
  });

  it("X-CH-1 joint winners: both finalists rank 1st, nobody 2nd, semi-final losers 3rd", () => {
    // differential: before W4 the finalists ranked 1/2 by seed; with no winner recorded and no title read, the unbeaten
    // finalists rank below every loser and completion refuses the shape (rank 3 first).
    // Rank places, "Joint winners": 1, 1, then the 3rd-place block (Shared: 3, 3), then 5 … strict.
    const { stage, rows } = knockout(8, { jointFinal: true });
    const want = ranked(["E1", 1], ["E2", 1], ["E3", 3], ["E4", 3], ["E5", 5], ["E6", 6], ["E7", 7], ["E8", 8]);
    const done = completeBracketStage(stage, rows);
    expect(done.title).toEqual({ kind: "joint", winners: ["E1", "E2"] });
    expect(done.finalRanks).toEqual(want);
    expect(bracketRanks(stage, rows)).toEqual(want);
    // The joint winners in seed order, whichever is home: E4 (home, seed 4) and E2 share 1st as E2, E4.
    const upset = knockout(8, { jointFinal: true, winner: upsetE4 });
    const upsetDone = completeBracketStage(upset.stage, upset.rows);
    expect(upsetDone.title).toEqual({ kind: "joint", winners: ["E4", "E2"] });
    expect(upsetDone.finalRanks).toEqual(ranked(["E2", 1], ["E4", 1], ["E1", 3], ["E3", 3], ["E5", 5], ["E6", 6], ["E7", 7], ["E8", 8]));
    // Joint winners declare a pair at 1st and nothing at 2nd: [1, 1, 2 …] is not competition ranking (B3-4), and one
    // winner with nobody 2nd is refused (the vacancy at 2nd is a walkover's, not a joint final's).
    expectInvalid(() => assertCompletedBracketPlaces(stage, rows, ranked(["E1", 1], ["E2", 1], ["E3", 2], ["E4", 3], ["E5", 5], ["E6", 6], ["E7", 7], ["E8", 8])), "not_competition_ranking");
    expectInvalid(() => assertCompletedBracketPlaces(stage, rows, ranked(["E1", 1], ["E2", 3], ["E3", 4], ["E4", 5], ["E5", 6], ["E6", 7], ["E7", 8], ["E8", 9])), "not_competition_ranking");
  });

  it("X-CH-1 vacant title: a final double walkover → title vacant, both finalists 2nd, nobody 1st", () => {
    // differential: before W4 1/2 by seed (both out in the final's round); with no title read, the two finalists rank below
    // the semi-final losers and completion refuses the shape (rank 3 first).
    // Rank places, "Vacant title (final DW)": 2, 2, then the 3rd-place block (Shared: 3, 3), then 5 … strict.
    const { stage, rows } = knockout(8, { doubleWalkover: new Set(["se-r2-i0"]) });
    const want = ranked(["E1", 2], ["E2", 2], ["E3", 3], ["E4", 3], ["E5", 5], ["E6", 6], ["E7", 7], ["E8", 8]);
    const done = completeBracketStage(stage, rows);
    expect(done.title).toEqual({ kind: "vacant" });
    expect(done.finalRanks).toEqual(want);
    expect(want.some((p) => p.rank === 1), "nobody 1st").toBe(false);
    // The finalists in seed order, whichever is home.
    const upset = knockout(8, { doubleWalkover: new Set(["se-r2-i0"]), winner: upsetE4 });
    expect(completeBracketStage(upset.stage, upset.rows).finalRanks).toEqual(
      ranked(["E2", 2], ["E4", 2], ["E1", 3], ["E3", 3], ["E5", 5], ["E6", 6], ["E7", 7], ["E8", 8]),
    );
    // With a play-off both sides walked over too: 2, 2, 4, 4, 5 … (the 3rd-place block's own shape).
    const both = knockout(8, { thirdPlace: true, doubleWalkover: new Set(["se-r2-i0", "se-3p"]) });
    expect(completeBracketStage(both.stage, both.rows).finalRanks).toEqual(
      ranked(["E1", 2], ["E2", 2], ["E3", 4], ["E4", 4], ["E5", 5], ["E6", 6], ["E7", 7], ["E8", 8]),
    );
  });

  it("X-CH-1 a vacant title reverses itself: the final re-decided gives a champion, and a second call is stable", () => {
    // As an Undo / Reinstate leaves the rows: the final's double walkover replaced by a decided result, E1 over E2.
    const { stage, rows } = knockout(8, { doubleWalkover: new Set(["se-r2-i0"]) });
    expect(completeBracketStage(stage, rows).title).toEqual({ kind: "vacant" });
    const redecided = rows.map((f): BracketFixture => {
      if (f.id !== "se-r2-i0") return f;
      const { walkedOver: _gone, ...rest } = f;
      return { ...rest, status: "decided", winner: "E1", loser: "E2" };
    });
    const first = completeBracketStage(stage, redecided);
    expect(first.title).toEqual({ kind: "champion", champion: "E1" });
    expect(first.finalRanks).toEqual(ranked(["E1", 1], ["E2", 2], ["E3", 3], ["E4", 3], ["E5", 5], ["E6", 6], ["E7", 7], ["E8", 8]));
    expect(completeBracketStage(stage, redecided), "a second call").toEqual(first);
    // And back again: the vacant rows still read vacant.
    expect(completeBracketStage(stage, rows).title).toEqual({ kind: "vacant" });
  });

  it("X-CH-1 jointWinners on a semi, with a winner, or on a scheduled final throws", () => {
    // Assumption → guard (wiring bugs, the house CONFIG_INVALID with a named reason — final review F-m; B3-4: one case
    // each). The final row every case starts from is valid.
    const ok: BracketFixture = { id: "f", round: 1, isFinal: true, status: "decided", home: "E1", away: "E2", jointWinners: true };
    expect(bracketTitle([ok])).toEqual({ kind: "joint", winners: ["E1", "E2"] });
    const { away: _away, ...noAway } = ok;
    const { home: _home, ...noHome } = ok;
    const cases: [string, BracketFixture, RegExp, string][] = [
      ["on a semi-final", { ...ok, isFinal: false }, /not the final/, "joint_winners_not_final"],
      ["with no away side", noAway, /both sides seated/, "joint_winners_side_missing"],
      ["with no home side", noHome, /both sides seated/, "joint_winners_side_missing"],
      ["with a winner", { ...ok, winner: "E1" }, /winner or a loser/, "joint_winners_result_named"],
      ["with a loser", { ...ok, loser: "E2" }, /winner or a loser/, "joint_winners_result_named"],
      ["walked over", { ...ok, status: "walkover", walkedOver: "both" }, /walkedOver/, "joint_winners_walked_over"],
      ["on a scheduled final", { ...ok, status: "scheduled" }, /decided/, "joint_winners_not_decided"],
    ];
    let thrown = 0;
    for (const [what, row, message, reason] of cases) {
      expect(() => bracketTitle([row]), what).toThrow(message);
      const err = refusalOf(() => bracketTitle([row]));
      expect(err.code, what).toBe("CONFIG_INVALID");
      expect(err.data, what).toEqual({ reason, fixtureId: "f" });
      thrown++;
    }
    expect(thrown, "jointWinners guards reached").toBe(7);
    // Reached from the ranking and the completion too, not only from bracketTitle.
    const stage: BracketStage = { id: "ko", kind: "knockout", entrants: ["E1", "E2", "E3", "E4"], seeds: seedsOf(ids(4)) };
    const semi: BracketFixture = { ...decided("s", 0, "E1", "E4", "E1"), jointWinners: true };
    expect(() => bracketRanks(stage, [semi])).toThrow(/not the final/);
    expect(() => completeBracketStage(stage, [semi, decided("f", 1, "E1", "E2", "E1", { isFinal: true })])).toThrow(/not the final/);
  });

  it("X-CH-1 page playoff and stepladder joint winners → 1, 1, 3, 4", () => {
    // Rank places, "double_elim, stepladder, page_playoff: strict 1 … n, except joint (1, 1, 3 …)".
    const cases: [string, BracketStage["kind"], GeneratedBracket, number][] = [
      ["page playoff, 4", "page_playoff", generatePagePlayoff({ entrants: ids(4), seeds: seedsOf(ids(4)) }), 4],
      ["stepladder, 4", "stepladder", generateStepladder({ entrants: ids(4), seeds: seedsOf(ids(4)) }), 4],
      ["double elimination, 8", "double_elim", generateDoubleElim({ entrants: ids(8), seeds: seedsOf(ids(8)), bracketReset: true }), 8],
    ];
    let checked = 0;
    for (const [what, kind, gen, n] of cases) {
      const stage: BracketStage = { id: "s", kind, entrants: ids(n), seeds: seedsOf(ids(n)) };
      const rows = playOutBracket(gen, { seeds: seedsOf(ids(n)), jointFinal: true });
      const done = completeBracketStage(stage, rows);
      expect(done.title, what).toEqual({ kind: "joint", winners: ["E1", "E2"] });
      expect(done.finalRanks, what).toEqual(ranked(["E1", 1], ["E2", 1], ...ids(n).slice(2).map((id, i): [string, number] => [id, i + 3])));
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("X-CH-1 a settled final that decided nobody (void, no reset) refuses completion", () => {
    // Assumption → guard: X-CH-1 says there is exactly one champion otherwise; a final voided, with no reset to follow, is
    // settled (so the stage is not "not ready") yet crowns nobody — CONFIG_INVALID, never a ranking with no 1st.
    const { stage, rows } = knockout(4, { voided: new Set(["se-r1-i0"]) });
    expect(bracketTitle(rows)).toBeUndefined();
    expectInvalid(() => completeBracketStage(stage, rows), "no_title");
    // Provisional reads still answer (Review Focus 5): the stage just cannot complete. B3 fix round 1 (review m2,
    // controller ruling): the void final decided nothing, so its seated sides E1 and E2 are still in — B3-3: everyone in
    // ranks above everyone out, fewest losses first, then seed — and the semi-final losers share 3rd below them (SH-3).
    // differential: before the fix the two finalists ranked LAST, below the entrants they beat.
    expect(bracketRanks(stage, rows)).toEqual(ranked(["E1", 1], ["E2", 2], ["E3", 3], ["E4", 3]));
    const eight = knockout(8, { voided: new Set(["se-r2-i0"]) });
    expect(bracketRanks(eight.stage, eight.rows)).toEqual(
      ranked(["E1", 1], ["E2", 2], ["E3", 3], ["E4", 3], ["E5", 5], ["E6", 6], ["E7", 7], ["E8", 8]),
    );
    // Fewest losses first, not seed: a double elimination whose grand final is void, E2 the unbeaten winners'-bracket
    // champion (it beat E1 in the winners' final) and E1 back through the losers' bracket with one loss.
    const upset = (home: string, away: string): string =>
      [home, away].sort().join() === "E1,E2" ? "E2" : Number(away.slice(1)) < Number(home.slice(1)) ? away : home;
    const de: BracketStage = { id: "de", kind: "double_elim", entrants: ids(4), seeds: seedsOf(ids(4)) };
    const deRows = playOutBracket(generateDoubleElim({ entrants: ids(4), seeds: seedsOf(ids(4)), bracketReset: true }), {
      winner: upset,
      voided: new Set(["gf"]),
    });
    const gf = deRows.find((f) => f.id === "gf");
    expect([gf?.status, gf?.home, gf?.away]).toEqual(["void", "E2", "E1"]);
    expect(bracketRanks(de, deRows)).toEqual(places("E2", "E1", "E3", "E4"));
  });
});

describe("X-FR-1 counted: the title × the 3rd-place block over the Rank places table (Task 7)", () => {
  // Rank places table, the title rows (champion 1, 2; joint 1, 1; vacant 2, 2), then the 3rd-place block (Shared: 3, 3;
  // Play-off decided: 3, 4), then 5 … n strict. Typed from the table, never read from bracketRanks.
  const TITLE = { champion: [1, 2], joint: [1, 1], vacant: [2, 2] } as const;
  const THIRD = { shared: [3, 3], playOff: [3, 4] } as const;
  let checked = 0;

  it("X-FR-1 n=4..32 × {champion, joint, vacant} × {Shared, Play-off}: the rank multiset is the table's row", () => {
    for (let n = 4; n <= 32; n++) {
      for (const title of ["champion", "joint", "vacant"] as const) {
        for (const third of ["shared", "playOff"] as const) {
          const finalId = `se-r${Math.ceil(Math.log2(n)) - 1}-i0`;
          const { stage, rows } = knockout(n, {
            ...(third === "playOff" ? { thirdPlace: true } : {}),
            ...(title === "joint" ? { jointFinal: true } : {}),
            ...(title === "vacant" ? { doubleWalkover: new Set([finalId]) } : {}),
          });
          const what = `n=${n} ${title} ${third}`;
          expect(rows.find((f) => f.id === finalId)?.isFinal, `${what}: ${finalId} is the final`).toBe(true);
          const got = completeBracketStage(stage, rows).finalRanks;
          const want = [...TITLE[title], ...THIRD[third], ...Array.from({ length: n - 4 }, (_, i) => i + 5)];
          expect(got.map((p) => p.rank), what).toEqual(want);
          expect(() => assertBracketPlaces(stage.entrants, got), what).not.toThrow();
          checked++;
        }
      }
    }
  });

  it("X-FR-1 the sweep checked 174 brackets (29 sizes × 3 titles × 2)", () => {
    expect(checked).toBe(174);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Task 8 — a walkover loser is out at that fixture (RB4-R3; X-FR-3)
// ---------------------------------------------------------------------------------------------------------------------

/** For each entrant a walkover put out (a forfeit's loser, both sides of a double walkover), the earliest round it went
 *  out in — from the rows, never from bracketRanks. */
function walkedOutAt(rows: readonly BracketFixture[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of rows) {
    if (f.status !== "walkover" || f.walkedOver === undefined) continue;
    const sides = f.walkedOver === "both" ? [f.home, f.away] : [f.loser];
    for (const id of sides) if (id !== undefined && (out.get(id) ?? Infinity) > f.round) out.set(id, f.round);
  }
  return out;
}

/** X-FR-3: ranks and seats agree. Nobody out at round r is seated in a later fixture, and everyone seated after r ranks
 *  above them. Returns how many (out entrant, later fixture) pairs it checked. */
function expectRanksAndSeatsAgree(stage: BracketStage, rows: readonly BracketFixture[], what: string): number {
  const rankOfId = rankOf(bracketRanks(stage, rows));
  let checked = 0;
  for (const [id, round] of walkedOutAt(rows)) {
    for (const f of rows.filter((row) => row.round > round)) {
      expect([f.home, f.away], `${what}: ${id} (out at round ${round}) is seated in ${f.id}`).not.toContain(id);
      for (const later of [f.home, f.away]) {
        if (later !== undefined) expect(rankOfId[later] ?? NaN, `${what}: ${later} (seated in ${f.id}) ranks above ${id}`).toBeLessThan(rankOfId[id] ?? NaN);
      }
      checked++;
    }
  }
  return checked;
}

describe("X-FR-3 a walkover loser is out at that fixture, so ranks and seats agree (Task 8, ruling 274, RB4-R3)", () => {
  it("X-FR-3 a forfeit loser at a quarter-final is ranked out there even if a stale later row names them", () => {
    // 8-draw, no play-off: E4 forfeits its quarter-final to E5 (se-r0-i1). E4 is out at round 0, among the quarter-final
    // losers by seed — Rank places, "n ≥ 4, Shared": E1, E2, then E3 and E5 level 3rd, then E4, E6, E7, E8 5 … 8.
    const { stage, rows } = knockout(8, { forfeit: new Map([["se-r0-i1", "E4"]]) });
    const want = ranked(["E1", 1], ["E2", 2], ["E3", 3], ["E5", 3], ["E4", 5], ["E6", 6], ["E7", 7], ["E8", 8]);
    expect(completeBracketStage(stage, rows).finalRanks).toEqual(want);
    // A pre-W2b row that seated E4 in the semi-final round and recorded it lost — played, or walked over a second time.
    // Neither moves E4: its elimination is the EARLIEST walkover, in either order of the rows, and a later row naming it
    // a loser never makes it a semi-final loser.
    const stale: BracketFixture[] = [
      decided("stale", 1, "E1", "E4", "E1"),
      { id: "stale", round: 1, status: "walkover", home: "E1", away: "E4", winner: "E1", loser: "E4", walkedOver: "loser" },
    ];
    let checked = 0;
    for (const row of stale) {
      for (const fixtures of [[...rows, row], [row, ...rows].reverse()]) {
        expect(bracketRanks(stage, fixtures), JSON.stringify(row)).toEqual(want);
        checked++;
      }
    }
    expect(checked).toBe(4);
  });

  it("X-FR-3 both sides of a QF double walkover are out at the QF, and nobody seated later is ranked there", () => {
    // 8-draw, no play-off: E5 v E4 (se-r0-i1) both walked over. Its semi-final seat is dead, so E1 goes through by
    // walkover; E3 is the semi-finals' one loser, 3rd alone; E4 and E5 rank with the quarter-final losers, by seed.
    const { stage, rows } = knockout(8, { doubleWalkover: new Set(["se-r0-i1"]) });
    expect(completeBracketStage(stage, rows).finalRanks).toEqual(places("E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8"));
    // Ranks and seats agree, swept over every non-final fixture of an 8-draw with a play-off and of a double elimination
    // (its losers'-bracket seats), each walked over three ways: home forfeits, away forfeits, both (B3-10: a forfeiter's
    // onward LOSER feeds are dead too).
    let brackets = 0;
    let pairs = 0;
    const sweeps: [string, BracketStage["kind"], () => GeneratedBracket][] = [
      ["knockout 8 + play-off", "knockout", () => generateSingleElim({ entrants: ids(8), seeds: seedsOf(ids(8)), thirdPlace: true })],
      ["double elimination 8", "double_elim", () => generateDoubleElim({ entrants: ids(8), seeds: seedsOf(ids(8)), bracketReset: true })],
    ];
    for (const [what, kind, gen] of sweeps) {
      const sweepStage: BracketStage = { id: "s", kind, entrants: ids(8), seeds: seedsOf(ids(8)) };
      const played = playOutBracket(gen(), { seeds: seedsOf(ids(8)) });
      for (const f of played.filter((row) => row.isFinal !== true && row.thirdPlace !== true && row.home !== undefined && row.away !== undefined)) {
        const modes: [string, PlayOutOptions][] = [
          ["home forfeits", { forfeit: new Map([[f.id, f.home ?? ""]]) }],
          ["away forfeits", { forfeit: new Map([[f.id, f.away ?? ""]]) }],
          ["double walkover", { doubleWalkover: new Set([f.id]) }],
        ];
        for (const [mode, opts] of modes) {
          const walked = playOutBracket(gen(), { seeds: seedsOf(ids(8)), ...opts });
          // The seat a mode removes is only the driver's: the fixture must still be seated as the played-out one.
          const at = walked.find((row) => row.id === f.id);
          expect([at?.home, at?.away], `${what} ${f.id} ${mode}`).toEqual([f.home, f.away]);
          pairs += expectRanksAndSeatsAgree(sweepStage, walked, `${what} ${f.id} ${mode}`);
          brackets++;
        }
      }
    }
    // knockout: 4 quarter-finals + 2 semi-finals; double elimination: 4 + 2 + 1 winners' and 2 + 2 + 1 + 1 losers'
    // fixtures — each three ways.
    expect(brackets, "walked-over brackets checked").toBe((6 + 13) * 3);
    // Pairs, from the bracket shapes the generators build (B3 fix round 1, review m5). Each swept fixture puts out one
    // entrant per forfeit and two on a double walkover: 1 + 1 + 2 = 4 per later fixture, the one walked-over fixture in
    // its rows (a dead seat after it is a plain walkover). A fixture of round r is followed by every row of a higher round:
    //   knockout 8 + play-off — 8 rows: round 0 ×4, round 1 ×2, round 2 ×2 (final, play-off). A quarter-final has 4
    //   later rows, a semi-final 2: 4 × (4 × 4 + 2 × 2) = 80.
    //   double elimination 8 — 15 rows: WB rounds 0, 1, 2 (×4, ×2, ×1), LB rounds 3, 4, 5, 6 (×2, ×2, ×1, ×1), grand
    //   final 7, reset 8. Later rows: 11 (WB r0), 9 (WB r1), 8 (WB r2), 6 (LB r3), 4 (LB r4), 3 (LB r5), 2 (LB r6):
    //   4 × (4 × 11 + 2 × 9 + 8 + 2 × 6 + 2 × 4 + 3 + 2) = 4 × 95 = 380.
    expect(pairs, "(out entrant, later fixture) pairs checked").toBe(80 + 380);
  });

  it("X-FR-3 page playoff: a pp-q1 forfeit loser is out at round 0, never ranked by a pp-q2 row", () => {
    // E2 forfeits Qualifier 1 to E1. E2 is out there (B3-10: its Qualifier 2 seat is dead), so E3, the Eliminator's
    // winner, goes through Qualifier 2 by walkover and loses the final to E1. The order of E2 against the Eliminator
    // loser E4 is T11's: only that the two hold 3rd and 4th is pinned here.
    const stage: BracketStage = { id: "pp", kind: "page_playoff", entrants: ids(4), seeds: seedsOf(ids(4)) };
    const rows = playOutBracket(generatePagePlayoff({ entrants: ids(4), seeds: seedsOf(ids(4)) }), {
      seeds: seedsOf(ids(4)),
      forfeit: new Map([["pp-q1", "E2"]]),
    });
    const check = (fixtures: readonly BracketFixture[], what: string): void => {
      const got = rankOf(completeBracketStage(stage, fixtures).finalRanks);
      expect([got.E1, got.E3], what).toEqual([1, 2]);
      expect([got.E2, got.E4].sort(), what).toEqual([3, 4]);
    };
    check(rows, "as played");
    expect(expectRanksAndSeatsAgree(stage, rows, "page playoff"), "later fixtures checked against E2").toBe(2);
    // A stale Qualifier 2 row that seated E2 and recorded it lost does not rank E2 there.
    check([...rows, decided("pp-q2-stale", 1, "E3", "E2", "E3")], "with a stale pp-q2 row");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Task 11 — a withdrawn stepladder seed and a page-playoff withdrawal (RB4-S4, RB4-S5; X-SP-4, X-SP-5)
// ---------------------------------------------------------------------------------------------------------------------
// The rows are the ones the app writes after the withdrawal, hand-built (controller ruling B5-1) from the app's shape:
// a seat the withdrawal emptied is stamped dead (X-WD-3, ruling 116), the side that arrives walks over it, and
// `toBracketFixture` (apps/web engine-db/competition.ts) omits the empty seat while `bracketWinnerLoser` drops the loser
// an award names for the copy alone (she holds no seat in it). A forfeit with both sides seated names its loser,
// `walkedOver: "loser"`. Expected ranks come from RB4-S4 / RB4-S5 and the Rank places table, never from bracketRanks.

/** A walkover over a dead seat: only the side that arrived is seated, and it wins; no loser (ruling 116). */
const overDeadSeat = (id: string, round: number, present: string, extra: Partial<BracketFixture> = {}): BracketFixture =>
  ({ id, round, status: "walkover", away: present, winner: present, ...extra });
/** A forfeit with both sides seated: the other side wins, the forfeiter is out here (X-FR-3). */
const forfeited = (id: string, round: number, home: string, away: string, forfeiter: string): BracketFixture =>
  ({ id, round, status: "walkover", home, away, winner: forfeiter === home ? away : home, loser: forfeiter, walkedOver: "loser" });

/** A k-stepladder (seed i is `E${i}`) played to seed, in which waiting seed s (s ≤ k − 2) withdrew before the climber
 *  reached her rung: her seat there is dead and the climber walks over it. Every played rung goes to the higher seed. */
function ladderWithdrawn(k: number, s: number): BracketFixture[] {
  const e = ids(k);
  const at = (i: number): string => e[i] as string;
  const rows: BracketFixture[] = [decided("sl-g0", 0, at(k - 2), at(k - 1), at(k - 2))];
  let climber = at(k - 2);
  for (let j = 1; j <= k - 2; j++) {
    const final = j === k - 2 ? { isFinal: true } : {};
    const waiting = at(k - 2 - j); // seed k − 1 − j (RB4-S1: each winner meets the next seed up)
    if (k - 1 - j === s) {
      rows.push(overDeadSeat(`sl-g${j}`, j, climber, final));
    } else {
      rows.push(decided(`sl-g${j}`, j, waiting, climber, waiting, final));
      climber = waiting;
    }
  }
  return rows;
}

/** RB4-S4 over the Rank places table, read off the rows (never off bracketRanks): a stepladder ranks its champion 1st,
 *  then each rung's loser, the final's first and round 0's last; a rung walked over a dead seat has as its loser the
 *  seed whose seat it was. */
function ladderOrderByRule(rows: readonly BracketFixture[], withdrawn: string): string[] {
  const final = rows.find((r) => r.isFinal === true);
  const rungs = [...rows].sort((a, b) => b.round - a.round);
  return [final?.winner ?? "?", ...rungs.map((r) => r.loser ?? withdrawn)];
}

describe("X-SP-4 a withdrawn stepladder seed ranks as the loser of the rung they were due to enter (Task 11, RB4-S4)", () => {
  it("X-SP-4 the empty case first: a stepladder with no entrants ranks nobody; one with every seed seated places nobody at a rung", () => {
    // RB4-R1: no entrant, no place.
    expect(bracketRanks({ id: "sl", kind: "stepladder", entrants: [] }, [])).toEqual([]);
    // Nobody withdrew: every entrant is in a fixture, so no rung is read — Rank places, "stepladder: strict 1 … n", every
    // match to seed: E1 … E5. With no seed map at all nothing changes: a rung is read only for an entrant in no fixture,
    // and the ranks are elimination round, then id.
    const rows = playOutBracket(generateStepladder({ entrants: ids(5), seeds: seedsOf(ids(5)) }), { seeds: seedsOf(ids(5)) });
    expect(completeBracketStage({ id: "sl", kind: "stepladder", entrants: ids(5), seeds: seedsOf(ids(5)) }, rows).finalRanks).toEqual(places(...ids(5)));
    expect(completeBracketStage({ id: "sl", kind: "stepladder", entrants: ids(5) }, rows).finalRanks).toEqual(places(...ids(5)));
  });

  it("X-SP-4 truth run: k = 5, seed 2 withdrawn before the climber arrived ranks 3rd — below the final's loser, above the round-1 and round-0 losers", () => {
    // k = 5: sl-g0 E4 v E5 (round 0), sl-g1 E3 v climber (1), sl-g2 E2 v climber (2), sl-g3 E1 v climber (3, the final).
    // E2 withdrew before sl-g1 was played: her seat in sl-g2 is dead, and E3 (who won sl-g1) walks over it.
    const stage: BracketStage = { id: "sl", kind: "stepladder", entrants: ids(5), seeds: seedsOf(ids(5)) };
    const rows = ladderWithdrawn(5, 2);
    // Who plays whom (RB4-S1, X-SP-1): the generator's rungs, every waiting seed at home on its own rung except E2's.
    const gen = generateStepladder({ entrants: ids(5), seeds: seedsOf(ids(5)) });
    expect(rows.map((r) => [r.id, r.round, r.isFinal === true])).toEqual(gen.fixtures.map((f) => [f.id, f.round, f.isFinal === true]));
    expect(rows.map((r) => r.home)).toEqual(["E4", "E3", undefined, "E1"]);
    expect(rows.find((r) => r.id === "sl-g2")).toEqual({ id: "sl-g2", round: 2, status: "walkover", away: "E3", winner: "E3" });
    // RB4-S4: E2 is the loser of sl-g2 (round 2), so she ranks below sl-g3's loser E3 (2nd) and above sl-g1's loser E4 and
    // sl-g0's loser E5 — Rank places, "stepladder: strict 1 … n": E1, E3, E2, E4, E5.
    // differential: today E1, E3, E4, E5, E2 (E2 is in no fixture, so she ranks last).
    const want = places("E1", "E3", "E2", "E4", "E5");
    expect(bracketRanks(stage, rows)).toEqual(want);
    expect(completeBracketStage(stage, rows).finalRanks).toEqual(want);
    // X-SP-4: every seed appears in the final ranks.
    expect(completeBracketStage(stage, rows).finalRanks.map((p) => p.entrantId).sort()).toEqual(ids(5));
  });

  it("X-SP-4 counted: every waiting seed s of every k = 3..8, withdrawn at their rung, ranks s + 1 — that rung's loser", () => {
    // RB4-S1: seed s ≤ k − 2 waits for round k − 1 − s; the Rank places table ranks the loser of round r k − r (the final's
    // loser 2nd, round 0's last), so seed s ranks k − (k − 1 − s) = s + 1. The whole order is ladderOrderByRule's.
    // differential: today seed s ranks k, last, for every s here (s + 1 ≤ k − 1).
    let checked = 0;
    for (let k = 3; k <= 8; k++) {
      const stage: BracketStage = { id: "sl", kind: "stepladder", entrants: ids(k), seeds: seedsOf(ids(k)) };
      const gen = generateStepladder({ entrants: ids(k), seeds: seedsOf(ids(k)) });
      for (let s = 1; s <= k - 2; s++) {
        const rows = ladderWithdrawn(k, s);
        const what = `k=${k}, seed ${s} withdrawn`;
        // The rows are the generator's rungs, and the dead seat is the one the generator gave seed s.
        expect(rows.map((r) => [r.id, r.round, r.isFinal === true]), what).toEqual(gen.fixtures.map((f) => [f.id, f.round, f.isFinal === true]));
        const dead = rows.find((r) => r.home === undefined);
        expect(gen.fixtures.find((f) => f.id === dead?.id)?.home, what).toBe(`E${s}`);
        const got = completeBracketStage(stage, rows).finalRanks;
        expect(got, what).toEqual(places(...ladderOrderByRule(rows, `E${s}`)));
        expect(rankOf(got)[`E${s}`], what).toBe(s + 1);
        checked++;
      }
    }
    // Σ (k − 2) for k = 3..8 = 1 + 2 + 3 + 4 + 5 + 6.
    expect(checked, "withdrawn ladders checked").toBe(21);
  });

  it("X-SP-4 the rung is read from seed ORDER, as the ladder is drawn: gapped seeds name the same rung, tied seeds draw in the order given", () => {
    // The generator draws a ladder in seed order (`seedOrder`), so seeds 10 … 50 draw the same rungs as 1 … 5 — the app
    // passes an entrant's own seed, which need not run 1 … k. E2 (seed 20, ladder place 2) is due at round 2 as before.
    const gapped = new Map(ids(5).map((id, i) => [id, (i + 1) * 10]));
    const gen = generateStepladder({ entrants: ids(5), seeds: gapped });
    expect(gen.fixtures).toEqual(generateStepladder({ entrants: ids(5), seeds: seedsOf(ids(5)) }).fixtures);
    const stage: BracketStage = { id: "sl", kind: "stepladder", entrants: ids(5), seeds: gapped };
    // RB4-S4, as the truth run: E1, E3, E2, E4, E5. differential: a raw seed of 20 read as the place puts E2 at round 0,
    // where no seat is empty, and so last.
    expect(completeBracketStage(stage, ladderWithdrawn(5, 2)).finalRanks).toEqual(places("E1", "E3", "E2", "E4", "E5"));
    // Tied seeds draw in the order given (`seedOrder`): E2 and E3 both seed 2, so E3 is ladder place 3, home on sl-g1
    // (round 1). Withdrawn there, she ranks as sl-g1's loser, 4th (RB4-S4: s + 1 for place 3). differential: a place read
    // without the tie order counts E3 2nd, due at round 2, whose seats are both filled — and so last.
    const tied = new Map([["E1", 1], ["E2", 2], ["E3", 2], ["E4", 3], ["E5", 4]]);
    expect(generateStepladder({ entrants: ids(5), seeds: tied }).fixtures.find((f) => f.id === "sl-g1")?.home).toBe("E3");
    const rows = ladderWithdrawn(5, 3);
    expect(completeBracketStage({ id: "sl", kind: "stepladder", entrants: ids(5), seeds: tied }, rows).finalRanks).toEqual(places(...ladderOrderByRule(rows, "E3")));
    expect(rankOf(bracketRanks({ id: "sl", kind: "stepladder", entrants: ids(5), seeds: tied }, rows)).E3).toBe(4);
  });

  it("X-SP-4 sequence: before the climber reaches her dead seat she already ranks out at her rung (provisional); completion agrees, and a second call is stable", () => {
    const stage: BracketStage = { id: "sl", kind: "stepladder", entrants: ids(5), seeds: seedsOf(ids(5)) };
    // E2 withdrew with sl-g1 still to play: her sl-g2 seat is dead, its other seat waits on sl-g1, and E1 waits in the final.
    const mid: BracketFixture[] = [
      decided("sl-g0", 0, "E4", "E5", "E4"),
      { id: "sl-g1", round: 1, status: "scheduled", home: "E3", away: "E4" },
      { id: "sl-g2", round: 2, status: "scheduled" },
      { id: "sl-g3", round: 3, status: "scheduled", isFinal: true, home: "E1" },
    ];
    // B3-3: E1, E3 and E4 are in play (no losses; by seed) 1–3; then the out by elimination round — E2 at her rung (2),
    // E5 at round 0. differential: today E5 4th, E2 5th.
    const before = structuredClone(mid);
    expect(bracketRanks(stage, mid)).toEqual(places("E1", "E3", "E4", "E2", "E5"));
    expect(bracketRanks(stage, mid)).toEqual(places("E1", "E3", "E4", "E2", "E5"));
    expect(mid).toEqual(before);
    // Played out: E3 beats E4, walks over E2's dead seat, and loses the final to E1 — the truth run's rows and ranks.
    const done = ladderWithdrawn(5, 2);
    expect(done.map((r) => r.id)).toEqual(mid.map((r) => r.id));
    expect(completeBracketStage(stage, done).finalRanks).toEqual(places("E1", "E3", "E2", "E4", "E5"));
    expect(completeBracketStage(stage, done).finalRanks).toEqual(places("E1", "E3", "E2", "E4", "E5"));
  });

  it("X-SP-4 a stepladder entrant in no fixture with no seed, or no seed map at all, ranks last and is never refused; a knockout's likewise", () => {
    // T11 review I1 (controller ruling): an unseeded division is legal and a read path never refuses (Review Focus 5). The
    // rung is read from the seed, so with none there is no rung: E2, in no fixture, ranks last, as before W4 (X-FR-1).
    // Rank places, "stepladder: strict 1 … n": E1, E3 (the final), E4 (sl-g1, round 1), E5 (sl-g0, round 0), then E2.
    // differential: at d8ff048 every one of these reads threw CONFIG_INVALID stepladder_seed_missing.
    const rows = ladderWithdrawn(5, 2);
    const unseeded = new Map([...seedsOf(ids(5))].filter(([id]) => id !== "E2"));
    const stage: BracketStage = { id: "sl", kind: "stepladder", entrants: ids(5), seeds: unseeded };
    const last = places("E1", "E3", "E4", "E5", "E2");
    expect(bracketRanks(stage, rows)).toEqual(last);
    expect(completeBracketStage(stage, rows).finalRanks).toEqual(last);
    // No seed map at all (every registration seed null, so the app omits it): the same, elimination round then id.
    const noSeeds: BracketStage = { id: "sl", kind: "stepladder", entrants: ids(5) };
    expect(bracketRanks(noSeeds, rows)).toEqual(last);
    expect(completeBracketStage(noSeeds, rows).finalRanks).toEqual(last);
    // Mid-ladder too (provisional): her dead seat waits on sl-g1, and she still ranks last, below E5.
    const mid: BracketFixture[] = [
      decided("sl-g0", 0, "E4", "E5", "E4"),
      { id: "sl-g1", round: 1, status: "scheduled", home: "E3", away: "E4" },
      { id: "sl-g2", round: 2, status: "scheduled" },
      { id: "sl-g3", round: 3, status: "scheduled", isFinal: true, home: "E1" },
    ];
    expect(bracketRanks(noSeeds, mid)).toEqual(places("E1", "E3", "E4", "E5", "E2"));
    // The positive pair: her seed back, she is ranked at her rung (the truth run).
    expect(bracketRanks({ ...stage, seeds: seedsOf(ids(5)) }, rows)).toEqual(places("E1", "E3", "E2", "E4", "E5"));
    // Kind-scoped: a knockout entrant in no fixture with no seed is ranked last, as X-FR-1 has it, and nothing is refused.
    const ko: BracketStage = { id: "ko", kind: "knockout", entrants: ["S1", "S2", "S3", "S4", "W"], seeds: S4_SEEDS };
    expect(completeBracketStage(ko, PLAYOFF4).finalRanks).toEqual(places("S1", "S2", "S4", "S3", "W"));
  });

  it("X-SP-4 an entrant whose due rung holds no empty seat was drawn without them: ranked last, as one in no fixture", () => {
    // W is ladder place 3 of 4 (seeds A 1, B 2, W 3, C 4), so due at round 0 — but the ladder was drawn over A, B and C
    // alone (B v C, then A v B), and its round-0 rung seats both B and C: there is no seat of W's to have left. Rank places,
    // "stepladder: strict 1 … n": A, B, C, then W in no fixture (X-FR-1). (No rung at all at the due round is X-FR-1's own
    // case above: W seeded 1 of 4 is due at round 2, which that ladder does not have.) A rung read without its empty
    // seat would put W at round 0 beside C, and above C on seed.
    const stage: BracketStage = { id: "sl", kind: "stepladder", entrants: ["A", "B", "W", "C"], seeds: seedsOf(["A", "B", "W", "C"]) };
    const rungs = [decided("sl-g0", 0, "B", "C", "B"), decided("sl-g1", 1, "A", "B", "A", { isFinal: true })];
    expect(completeBracketStage(stage, rungs).finalRanks).toEqual(places("A", "B", "C", "W"));
  });

  it("X-SP-4 a round-0 seat left dead is that rung's loss, while an entrant whose rung seats two others stays last", () => {
    // T11 review m1. Declared E1, E2, W, E4, E5 (seeds 1–5, k = 5); the ladder was drawn over the other four (W absent):
    // sl-g0 E4 v E5 (round 0), sl-g1 E2 v climber (1), sl-g2 E1 v climber (2, the final). E5's seat at sl-g0 is dead, so
    // E4 walks over it; E2 beats E4, and E1 beats E2.
    //   E5 is ladder place 5 of 5: places k − 1 and k play first (RB4-S1), so she was due at round 0, and sl-g0 holds her
    //   empty seat — she ranks as its loser (RB4-S4), out at round 0.
    //   W is place 3, due at round k − 1 − 3 = 1; sl-g1 seats E2 and E4, so no seat there was hers — drawn without her,
    //   in no fixture, last (X-FR-1).
    // Rank places, "stepladder: strict 1 … n": E1 (champion), E2 (the final's loser), E4 (sl-g1's, round 1), E5 (sl-g0's,
    // round 0), W. Each reading that is not the rule moves someone: no round-0 clamp leaves E5 with no rung, tied with W,
    // and W's seed puts her above E5; checking only the home seat misses E5's away seat, with the same result; checking a
    // free seat in ANY round reads sl-g0's as W's rung, so W is out at round 1 beside E4 and above him on seed.
    const entrants = ["E1", "E2", "W", "E4", "E5"];
    const seeds = seedsOf(entrants);
    const gen = generateStepladder({ entrants: ["E1", "E2", "E4", "E5"], seeds });
    const rows: BracketFixture[] = [
      { id: "sl-g0", round: 0, status: "walkover", home: "E4", winner: "E4" },
      decided("sl-g1", 1, "E2", "E4", "E2"),
      decided("sl-g2", 2, "E1", "E2", "E1", { isFinal: true }),
    ];
    // Who plays whom: the generator's rungs and concrete seats, E5's away seat at sl-g0 the one left empty.
    expect(rows.map((r) => [r.id, r.round, r.isFinal === true])).toEqual(gen.fixtures.map((f) => [f.id, f.round, f.isFinal === true]));
    expect(gen.fixtures.map((f) => [f.home, f.away])).toEqual([["E4", "E5"], ["E2", undefined], ["E1", undefined]]);
    const stage: BracketStage = { id: "sl", kind: "stepladder", entrants, seeds };
    const want = places("E1", "E2", "E4", "E5", "W");
    expect(bracketRanks(stage, rows)).toEqual(want);
    expect(completeBracketStage(stage, rows).finalRanks).toEqual(want);
  });
});

/** A page playoff (seed i is `E${i}`) in which `withdrawn`, a Qualifier 1 side, withdrew before it: Q1 walked over to the
 *  other side, Q2 walked over the dead loser-edge seat to E's winner (`eWinner`), and the final won by `champion`. */
function pageQ1Withdrawn(withdrawn: "E1" | "E2", eWinner: "E3" | "E4", champion: "q1" | "q2"): BracketFixture[] {
  const q1Winner = withdrawn === "E1" ? "E2" : "E1";
  return [
    forfeited("pp-q1", 0, "E1", "E2", withdrawn),
    decided("pp-elim", 0, "E3", "E4", eWinner),
    overDeadSeat("pp-q2", 1, eWinner),
    decided("pp-final", 2, q1Winner, eWinner, champion === "q1" ? q1Winner : eWinner, { isFinal: true }),
  ];
}

describe("X-SP-5 a withdrawn page-playoff entrant gets no second life and ranks below everyone still in the stage (Task 11, RB4-S5)", () => {
  it("X-SP-5 the empty case first: a page playoff with no entrants ranks nobody; one nobody left keeps round, then seed", () => {
    // RB4-R1: no entrant, no place.
    expect(bracketRanks({ id: "pp", kind: "page_playoff", entrants: [] }, [])).toEqual([]);
    // Nobody walked over: no forfeit to order. Rank places, "page_playoff: strict 1 … n", every match to seed — E1 beats
    // E2 then E2 beats E3 in Qualifier 2: E1, E2, E3 (out at Q2, round 1), E4 (out at E, round 0).
    const rows = playOutBracket(generatePagePlayoff({ entrants: ids(4), seeds: seedsOf(ids(4)) }), { seeds: seedsOf(ids(4)) });
    expect(rows.some((r) => r.walkedOver !== undefined)).toBe(false);
    expect(completeBracketStage({ id: "pp", kind: "page_playoff", entrants: ids(4), seeds: seedsOf(ids(4)) }, rows).finalRanks).toEqual(places(...ids(4)));
  });

  it("X-SP-5 truth run: a Q1 withdrawal walks Q1 over, then Q2 over to E's winner, and ranks 4th, below the Eliminator loser", () => {
    // E1 withdrew before Qualifier 1: E2 wins it by walkover (both seated), and E1's loser-edge seat in Qualifier 2 is dead
    // (no second life, X-DE-1 by analogy), so E3 — the Eliminator's winner over E4 — walks over it. E2 beats E3 in the final.
    const stage: BracketStage = { id: "pp", kind: "page_playoff", entrants: ids(4), seeds: seedsOf(ids(4)) };
    const rows: BracketFixture[] = [
      forfeited("pp-q1", 0, "E1", "E2", "E1"),
      decided("pp-elim", 0, "E3", "E4", "E3"),
      overDeadSeat("pp-q2", 1, "E3"),
      decided("pp-final", 2, "E2", "E3", "E2", { isFinal: true }),
    ];
    // Who plays whom (RB4-S2, RB4-S5): the generator's fixtures; Qualifier 2 seats E's winner and nobody from Qualifier 1;
    // the final seats Qualifier 1's winner and Qualifier 2's.
    const gen = generatePagePlayoff({ entrants: ids(4), seeds: seedsOf(ids(4)) });
    expect(rows.map((r) => [r.id, r.round, r.isFinal === true])).toEqual(gen.fixtures.map((f) => [f.id, f.round, f.isFinal === true]));
    expect(rows.map((r) => [r.home, r.away])).toEqual([["E1", "E2"], ["E3", "E4"], [undefined, "E3"], ["E2", "E3"]]);
    expect(expectRanksAndSeatsAgree(stage, rows, "Q1 withdrawal"), "later fixtures checked against E1").toBe(2);
    // RB4-S5: E1 ranks below everyone still in the stage when she left — E2 and E3 (the final), and E4, the Eliminator
    // loser, out in the same round as her. Rank places, "page_playoff: strict 1 … n": E2, E3, E4, E1.
    // differential: today E2, E3, E1, E4 (E1 and E4 both out at round 0, and E1's seed is the better).
    const want = places("E2", "E3", "E4", "E1");
    expect(bracketRanks(stage, rows)).toEqual(want);
    expect(completeBracketStage(stage, rows).finalRanks).toEqual(want);
  });

  it("X-SP-5 counted: either Q1 side's withdrawal, whoever wins E and the final, ranks 4th, below the Eliminator loser", () => {
    // RB4-S5 over the Rank places table: the final's winner 1st and loser 2nd; then the Eliminator's loser, still in the
    // stage when the Q1 side left; the withdrawn last. differential: today the withdrawn (seed 1 or 2) ranks 3rd, above
    // the Eliminator loser (seed 3 or 4), in every case.
    const stage: BracketStage = { id: "pp", kind: "page_playoff", entrants: ids(4), seeds: seedsOf(ids(4)) };
    let checked = 0;
    for (const withdrawn of ["E1", "E2"] as const) {
      for (const eWinner of ["E3", "E4"] as const) {
        for (const champion of ["q1", "q2"] as const) {
          const rows = pageQ1Withdrawn(withdrawn, eWinner, champion);
          const what = `${withdrawn} withdrew, ${eWinner} won E, the ${champion} side won the final`;
          const final = rows.find((r) => r.isFinal === true);
          const eLoser = eWinner === "E3" ? "E4" : "E3";
          expect(expectRanksAndSeatsAgree(stage, rows, what), what).toBe(2);
          expect(completeBracketStage(stage, rows).finalRanks, what).toEqual(places(final?.winner ?? "?", final?.loser ?? "?", eLoser, withdrawn));
          checked++;
        }
      }
    }
    expect(checked, "Q1 withdrawals checked: 2 sides × 2 Eliminator winners × 2 champions").toBe(8);
  });

  it("X-SP-5 only a same-round tie moves: a withdrawal before Qualifier 2 still ranks above the Eliminator loser, out already", () => {
    // E1 beats E2 in Q1 and E3 beats E4 in E; then E2 withdraws with both Q2 seats filled — a forfeit at round 1. E4 was
    // out before E2 left, so RB4-S5 does not put E2 below E4: Rank places, strict by elimination round (X-FR-2) — E1, E3
    // (the final), E2 (round 1), E4 (round 0). The positive pair of the truth run, and the same as before Task 11.
    const stage: BracketStage = { id: "pp", kind: "page_playoff", entrants: ids(4), seeds: seedsOf(ids(4)) };
    const rows: BracketFixture[] = [
      decided("pp-q1", 0, "E1", "E2", "E1"),
      decided("pp-elim", 0, "E3", "E4", "E3"),
      forfeited("pp-q2", 1, "E2", "E3", "E2"),
      decided("pp-final", 2, "E1", "E3", "E1", { isFinal: true }),
    ];
    expect(completeBracketStage(stage, rows).finalRanks).toEqual(places("E1", "E3", "E2", "E4"));
  });

  it("X-SP-5 sequence: mid-bracket the Q1 withdrawal ranks below the three still in play; a second withdrawal in round 0 ranks with her, below the finalists", () => {
    const stage: BracketStage = { id: "pp", kind: "page_playoff", entrants: ids(4), seeds: seedsOf(ids(4)) };
    // E1 withdrew before Q1; E is still to play. Q2's E1 seat is dead and its other seat waits on E; E2 waits in the final.
    const mid: BracketFixture[] = [
      forfeited("pp-q1", 0, "E1", "E2", "E1"),
      { id: "pp-elim", round: 0, status: "scheduled", home: "E3", away: "E4" },
      { id: "pp-q2", round: 1, status: "scheduled" },
      { id: "pp-final", round: 2, status: "scheduled", isFinal: true, home: "E2" },
    ];
    // B3-3: E2, E3 and E4 are in play (no losses; by seed) 1–3; E1 is out (round 0) — below everyone still in.
    const before = structuredClone(mid);
    expect(bracketRanks(stage, mid)).toEqual(places("E2", "E3", "E4", "E1"));
    expect(bracketRanks(stage, mid)).toEqual(places("E2", "E3", "E4", "E1"));
    expect(mid).toEqual(before);
    // Then E4 withdraws too: E walks over to E3, who walks over E1's dead Q2 seat and beats E2 in the final. RB4-S5 puts each
    // withdrawn entrant below everyone still in the stage, so both below the finalists E3 and E2. Which of the two ranks
    // 3rd is the plan's call, not pinned here: the rows carry no order of the two withdrawals (both round-0 walkovers),
    // and the order between two walkovers of one round is X-FR-2's seed, then id.
    const done: BracketFixture[] = [
      forfeited("pp-q1", 0, "E1", "E2", "E1"),
      forfeited("pp-elim", 0, "E3", "E4", "E4"),
      overDeadSeat("pp-q2", 1, "E3"),
      decided("pp-final", 2, "E2", "E3", "E3", { isFinal: true }),
    ];
    const got = rankOf(completeBracketStage(stage, done).finalRanks);
    expect([got.E3, got.E2]).toEqual([1, 2]);
    expect([got.E1, got.E4].sort()).toEqual([3, 4]);
    expect(expectRanksAndSeatsAgree(stage, done, "two round-0 withdrawals"), "(out entrant, later fixture) pairs").toBe(4);
  });

  it("X-SP-5 kind-scoped: the same rows read as any other bracket kind keep round, then seed (X-FR-2)", () => {
    // The truth run's rows. Only a page playoff puts the forfeiter below the Eliminator loser; every other kind ranks the
    // two round-0 losers by seed — E1 3rd, E4 4th (X-FR-2: elimination round, then seed, then id).
    const rows = pageQ1Withdrawn("E1", "E3", "q1");
    let checked = 0;
    for (const kind of ["knockout", "double_elim", "stepladder"] as const) {
      const got = rankOf(bracketRanks({ id: "s", kind, entrants: ids(4), seeds: seedsOf(ids(4)) }, rows));
      expect([got.E1, got.E4], kind).toEqual([3, 4]);
      checked++;
    }
    expect(rankOf(bracketRanks({ id: "pp", kind: "page_playoff", entrants: ids(4), seeds: seedsOf(ids(4)) }, rows))).toMatchObject({ E1: 4, E4: 3 });
    expect(checked, "other kinds checked").toBe(3);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Final review I1 — a withdrawn entrant on a dead seat loses that walkover (controller ruling F-I1/I2; RB4-R3, RB4-C2)
// ---------------------------------------------------------------------------------------------------------------------
// An entrant withdraws while their next opponent is still to be decided. The app stamps their onward seat DEAD — empty —
// and, once the other side arrives, awards that side the walkover (X-WD-3, ruling 116): the row names no loser. The
// seat's FEED (`homeFrom` / `awayFrom`, the generator's wiring, which the app keeps on the row) still names them, and the
// engine attributes the walkover loss to them. Rows: the real generator played out to seed (`playOutBracket`), its feeds
// kept, and the withdrawal hand-built from the app's shape (controller ruling B5-1). Expected ranks come from RB4-C2,
// RB4-R3, RB4-C3, B3-3 and the Rank places table, never from bracketRanks.

/** The app's rows keep the generator's feeds: each row with its generated fixture's `homeFrom` / `awayFrom`. */
function withFeeds(gen: GeneratedBracket, rows: readonly BracketFixture[]): BracketFixture[] {
  const byId = new Map(gen.fixtures.map((f) => [f.id, f]));
  return rows.map((row) => {
    const g = byId.get(row.id);
    return { ...row, ...(g?.homeFrom === undefined ? {} : { homeFrom: g.homeFrom }), ...(g?.awayFrom === undefined ? {} : { awayFrom: g.awayFrom }) };
  });
}
/** The same rows with every feed dropped: a caller that does not pass them (the pre-fix input). */
const withoutFeeds = (rows: readonly BracketFixture[]): BracketFixture[] =>
  rows.map(({ homeFrom: _h, awayFrom: _a, ...row }) => row);
/** The app's row once the side in `dead` left before the other side arrived: that seat empty (dead), the side that
 *  arrived awarded the walkover with no loser (ruling 116), the feeds kept. */
function walkedOverDeadSeat(row: BracketFixture, dead: "home" | "away"): BracketFixture {
  const { home, away, winner: _w, loser: _l, walkedOver: _o, ...rest } = row;
  const present = dead === "home" ? away : home;
  if (present === undefined) throw new Error(`walkedOverDeadSeat: ${row.id} has no side present`);
  return { ...rest, status: "walkover", ...(dead === "home" ? { away: present } : { home: present }), winner: present };
}
/** The row not yet played: its result gone, its seats kept only when asked, its feeds kept. */
function notYetPlayed(row: BracketFixture, keepSeats: boolean): BracketFixture {
  const { home, away, winner: _w, loser: _l, walkedOver: _o, ...rest } = row;
  return { ...rest, status: "scheduled", ...(keepSeats && home !== undefined ? { home } : {}), ...(keepSeats && away !== undefined ? { away } : {}) };
}
const rowIn = (rows: readonly BracketFixture[], id: string): BracketFixture => {
  const row = rows.find((r) => r.id === id);
  if (row === undefined) throw new Error(`no row ${id}`);
  return row;
};
const replacing = (rows: readonly BracketFixture[], swaps: Record<string, (row: BracketFixture) => BracketFixture>): BracketFixture[] =>
  rows.map((row) => swaps[row.id]?.(row) ?? row);

/** The 8-draw (seed fold 1v8, 5v4, 3v6, 7v2), every match to seed, feeds kept: semi-finals se-r1-i0 E1 > E4 and
 *  se-r1-i1 E2 > E3, final se-r2-i0 E1 v E2 (home fed by se-r1-i0's winner). */
function fed8(thirdPlace: boolean): { stage: BracketStage; rows: BracketFixture[] } {
  const entrants = ids(8);
  const seeds = seedsOf(entrants);
  const gen = generateSingleElim({ entrants, seeds, ...(thirdPlace ? { thirdPlace } : {}) });
  return { stage: { id: "ko", kind: "knockout", entrants, seeds }, rows: withFeeds(gen, playOutBracket(gen, { seeds })) };
}
/** I1a: E1 won semi-final A, then withdrew while semi-final B was still to play; E2 won it and walked over E1's dead
 *  seat in the final. */
const finalistWithdrew = (rows: readonly BracketFixture[]): BracketFixture[] =>
  replacing(rows, { "se-r2-i0": (row) => walkedOverDeadSeat(row, "home") });

describe("X-FR-3 a withdrawn entrant on a dead seat loses that walkover (final review I1; controller ruling F-I1; RB4-R3, RB4-C2)", () => {
  it("X-FR-3 the fixture's premise: the final's home seat is fed by semi-final A's winner, the play-off's home seat by its loser", () => {
    const { rows } = fed8(true);
    expect(rowIn(rows, "se-r2-i0").homeFrom).toEqual({ fixtureId: "se-r1-i0", side: "winner" });
    expect(rowIn(rows, "se-3p").homeFrom).toEqual({ fixtureId: "se-r1-i0", side: "loser" });
    expect([rowIn(rows, "se-r1-i0").winner, rowIn(rows, "se-r1-i0").loser]).toEqual(["E1", "E4"]);
    expect([rowIn(rows, "se-r1-i1").winner, rowIn(rows, "se-r1-i1").loser]).toEqual(["E2", "E3"]);
  });

  it("X-FR-3 I1a, no play-off: the semi-final A winner withdraws while semi-final B is unplayed — completion ranks E2 1, E1 2, E3 3, E4 3, then strict", () => {
    // RB4-C2: one finalist out → the final is a walkover, the other finalist (E2) is champion. RB4-R3: the walkover loser
    // (E1, whose dead seat the feed names) is out at the final — its loser, 2nd. Rank places, "n ≥ 4, Shared": the two
    // semi-final losers E3, E4 share 3rd (seed order), then the quarter-final losers strict, by seed: 5, 6, 7, 8.
    // differential: today completion throws CONFIG_INVALID not_competition_ranking (E1, never beaten, ranked last).
    const { stage, rows } = fed8(false);
    const done = finalistWithdrew(rows);
    const want = ranked(["E2", 1], ["E1", 2], ["E3", 3], ["E4", 3], ["E5", 5], ["E6", 6], ["E7", 7], ["E8", 8]);
    const completed = completeBracketStage(stage, done);
    expect(completed.finalRanks).toEqual(want);
    expect(completed.title).toEqual({ kind: "champion", champion: "E2" });
    expect(bracketRanks(stage, done)).toEqual(want);
    // A second call on the same rows gives the same answer, and leaves the rows as they were.
    const frozen = done.map((row) => Object.freeze({ ...row }));
    expect(completeBracketStage(stage, frozen).finalRanks).toEqual(want);
    expect(frozen).toEqual(done);
  });

  it("X-FR-3 I1b, play-off on: E1 withdraws after semi-final A and E4, its loser, before the play-off — 1 E2, 2 E1, 3 E3, 4 E4, then strict", () => {
    // Both left while semi-final B was still to play: E1's final seat and E4's play-off seat are dead. E2 then beat E3,
    // walked over E1's seat in the final, and E3 walked over E4's in the play-off. RB4-C2 + RB4-R3: E2 champion, E1 the
    // final's walkover loser, 2nd. Rank places, "n ≥ 4, Play-off decided": the play-off's winner E3 3rd, its walkover
    // loser E4 4th (RB4-R3: out at the play-off). Then the quarter-final losers strict, 5 … 8.
    // differential: today it completes SILENTLY with E1 9th (2nd read as vacant, E1 never beaten so ranked last).
    const { stage, rows } = fed8(true);
    const done = replacing(rows, {
      "se-r2-i0": (row) => walkedOverDeadSeat(row, "home"),
      "se-3p": (row) => walkedOverDeadSeat(row, "home"),
    });
    expect([rowIn(done, "se-3p").away, rowIn(done, "se-3p").winner]).toEqual(["E3", "E3"]);
    const want = places("E2", "E1", "E3", "E4", "E5", "E6", "E7", "E8");
    expect(completeBracketStage(stage, done).finalRanks).toEqual(want);
    expect(bracketRanks(stage, done)).toEqual(want);
  });

  it("X-FR-3 I1c sequence: before semi-final B is played the read is provisional and obeys B3-3; then it completes as I1a", () => {
    // E1 has withdrawn; semi-final B (E3 v E2) is still to play, so the final is scheduled with nobody seated: E1's seat
    // is dead, the other is still to come. The walkover is not settled, so E1 is not out yet. B3-3: everyone not out
    // ranks above everyone out — E1 (its seat named by the final's feed), E2, E3, fewest losses then seed; then E4 (semi-
    // final loser), then the quarter-final losers by seed.
    // differential: today E1, never beaten and in no unsettled seat, ranks LAST, below every entrant out (B3-3's trap).
    const { stage, rows } = fed8(false);
    const midway = replacing(rows, {
      "se-r1-i1": (row) => notYetPlayed(row, true),
      "se-r2-i0": (row) => notYetPlayed(row, false),
    });
    const provisional = places("E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8");
    expect(bracketRanks(stage, midway)).toEqual(provisional);
    expect(bracketRanks(stage, midway)).toEqual(provisional); // a second call
    expect(bracketTitle(midway)).toBeUndefined();
    expect(refusalOf(() => completeBracketStage(stage, midway)).code).toBe("STAGE_NOT_READY");
    // Semi-final B played (E2 > E3); E2 arrives and walks over E1's dead seat: the stage completes, as I1a.
    const done = finalistWithdrew(rows);
    expect(completeBracketStage(stage, done).finalRanks).toEqual(ranked(["E2", 1], ["E1", 2], ["E3", 3], ["E4", 3], ["E5", 5], ["E6", 6], ["E7", 7], ["E8", 8]));
  });

  it("X-FR-3 no-feed control: the same rows without the feed read as before — completion still refused, provisional reads never throw", () => {
    // The pre-fix answer, unchanged when the caller passes no feed (final review I1): the final's loser is unknown, 2nd is
    // read as vacant (B3-6), and E1 — never beaten — ranks below every round (eliminatedIn −1). E2 1, the semi-final
    // losers E3, E4 at max(3, 1 + 1) = 3, then each max(previous rank + 1, placed + 1) (X-FR-2): E5 4, E6 5, E7 6, E8 7,
    // E1 8 — which the strict check refuses (two at 3rd straight after a vacant 2nd).
    const { stage, rows } = fed8(false);
    const done = withoutFeeds(finalistWithdrew(rows));
    expectInvalid(() => completeBracketStage(stage, done), "not_competition_ranking");
    expect(bracketRanks(stage, done)).toEqual(ranked(["E2", 1], ["E3", 3], ["E4", 3], ["E5", 4], ["E6", 5], ["E7", 6], ["E8", 7], ["E1", 8]));
    // Mid-way, with no feed, E1 is in no seat and ranks last — and the read does not throw.
    const midway = withoutFeeds(replacing(rows, { "se-r1-i1": (row) => notYetPlayed(row, true), "se-r2-i0": (row) => notYetPlayed(row, false) }));
    expect(bracketRanks(stage, midway).at(-1)).toEqual({ entrantId: "E1", rank: 8 });
  });

  it("X-FR-3 the strict check reads the attributed runner-up: 2nd vacant is refused over a final whose dead seat's feed names E1, accepted where nothing does", () => {
    // B3-6: 2nd is vacant only when the final was a walkover over a dead seat with nobody to rank there. With the feed
    // naming E1 the final HAS a loser, so a ranking that leaves 2nd vacant breaks competition ranking.
    const { stage, rows } = fed8(false);
    const done = finalistWithdrew(rows);
    const vacantSecond = ranked(["E2", 1], ["E1", 3], ["E3", 4], ["E4", 5], ["E5", 6], ["E6", 7], ["E7", 8], ["E8", 9]);
    expectInvalid(() => assertCompletedBracketPlaces(stage, done, vacantSecond), "not_competition_ranking");
    // Its positive pair: the same rows with no feed have no runner-up, so the vacancy is declared and the shape passes.
    expect(() => assertCompletedBracketPlaces(stage, withoutFeeds(done), vacantSecond)).not.toThrow();
  });

  it("X-FR-3 a dead seat whose feed names nobody attributes nothing: a semi-final double walkover keeps B3-6's 1, 3, 4 … with the feeds passed", () => {
    // B3-6 (controller call), pinned above without feeds: E2 and E3 both walk over semi-final B, so the final's away seat
    // is dead and its feed (se-r1-i1's winner) names nobody. E1 wins the final by walkover, 2nd stays vacant.
    const entrants = ids(8);
    const seeds = seedsOf(entrants);
    const gen = generateSingleElim({ entrants, seeds });
    const rows = withFeeds(gen, playOutBracket(gen, { seeds, doubleWalkover: new Set(["se-r1-i1"]) }));
    expect(rowIn(rows, "se-r2-i0").awayFrom).toEqual({ fixtureId: "se-r1-i1", side: "winner" });
    const want = ranked(["E1", 1], ["E4", 3], ["E2", 4], ["E3", 5], ["E5", 6], ["E6", 7], ["E7", 8], ["E8", 9]);
    expect(completeBracketStage({ id: "ko", kind: "knockout", entrants, seeds }, rows).finalRanks).toEqual(want);
  });

  it("X-FR-3 both finalists withdrew before the final (a double walkover over two dead seats): the title is vacant, both rank 2nd", () => {
    // RB4-C3: both finalists out → the title is vacant, both rank 2nd, nobody 1st. Rank places, "Vacant title": 2, 2,
    // then the 3rd-place block (E3, E4 at 3), then 5 …. Each dead seat's feed names its semi-final's winner.
    // differential: today the double walkover is missing both sides and throws, on a provisional read too.
    const { stage, rows } = fed8(false);
    const done = replacing(rows, {
      "se-r2-i0": (row) => {
        const { home: _h, away: _a, winner: _w, loser: _l, ...rest } = row;
        return { ...rest, status: "walkover", walkedOver: "both" };
      },
    });
    const want = ranked(["E1", 2], ["E2", 2], ["E3", 3], ["E4", 3], ["E5", 5], ["E6", 6], ["E7", 7], ["E8", 8]);
    expect(bracketRanks(stage, done)).toEqual(want);
    const completed = completeBracketStage(stage, done);
    expect(completed.finalRanks).toEqual(want);
    expect(completed.title).toEqual({ kind: "vacant" });
  });

  it("X-FR-3 a LOSER feed: in a double elimination, a winners'-bracket loser who withdrew before their losers'-bracket fixture is out there", () => {
    // 8-entrant double elimination (no reset), to seed, except: E5 lost wb-r0-i1 to E4 by play, then withdrew while
    // wb-r0-i0 (E1 v E8) was still to play. Its lb-r0-i0 seat (fed by wb-r0-i1's LOSER) is dead, and E8, arriving,
    // walks over it; E4 then beats E8 in lb-r1-i0. RB4-R3: E5 is out at lb-r0-i0 (round 3), as E7 is (lost lb-r0-i1 by
    // play). Rank places, "double_elim: strict 1 … n", X-FR-2 below the final: elimination round (later first), then seed:
    // E1 (GF winner), E2 (GF loser), E3 (out round 6), E4 (5), E6 and E8 (4, seed order), E5 and E7 (3, seed order).
    // differential: today E5 is out at its last LOSS, the winners'-bracket round 0, so last — below E7.
    const entrants = ids(8);
    const seeds = seedsOf(entrants);
    const gen = generateDoubleElim({ entrants, seeds });
    const e8OverE5 = (home: string, away: string): string =>
      [home, away].includes("E5") && [home, away].includes("E8") ? "E8" : (seeds.get(away) ?? 0) < (seeds.get(home) ?? 0) ? away : home;
    const rows = withFeeds(gen, playOutBracket(gen, { seeds, winner: e8OverE5 }));
    expect(rowIn(rows, "lb-r0-i0")).toMatchObject({ home: "E8", away: "E5", awayFrom: { fixtureId: "wb-r0-i1", side: "loser" } });
    expect(rowIn(rows, "wb-r0-i1")).toMatchObject({ winner: "E4", loser: "E5" });
    const done = replacing(rows, { "lb-r0-i0": (row) => walkedOverDeadSeat(row, "away") });
    const want = places("E1", "E2", "E3", "E4", "E6", "E8", "E5", "E7");
    expect(completeBracketStage({ id: "de", kind: "double_elim", entrants, seeds }, done).finalRanks).toEqual(want);
  });

  it("X-FR-3 every bracket kind: the fed finalist who withdrew before their final ranks 2nd, behind the side that walked over their seat (counted)", () => {
    // RB4-C2 + RB4-R3 over the Rank places table ("double_elim, stepladder, page_playoff: strict 1 … n"): the walkover
    // winner is champion, the walkover loser — the finalist whose dead seat the feed names — is the final's loser, 2nd.
    // The withdrawn side is the final's FED seat (a stepladder's top seed is seated by the draw, its climber fed).
    // differential: today the withdrawn finalist, never beaten, ranks LAST and 2nd reads as vacant.
    const cases: [string, BracketStage["kind"], number, (entrants: string[], seeds: Map<string, number>) => GeneratedBracket][] = [
      ["knockout 8", "knockout", 8, (entrants, seeds) => generateSingleElim({ entrants, seeds })],
      ["double elimination 8", "double_elim", 8, (entrants, seeds) => generateDoubleElim({ entrants, seeds })],
      ["stepladder 5", "stepladder", 5, (entrants, seeds) => generateStepladder({ entrants, seeds })],
      ["page playoff 4", "page_playoff", 4, (entrants, seeds) => generatePagePlayoff({ entrants, seeds })],
    ];
    let checked = 0;
    for (const [what, kind, n, generate] of cases) {
      const entrants = ids(n);
      const seeds = seedsOf(entrants);
      const gen = generate(entrants, seeds);
      const rows = withFeeds(gen, playOutBracket(gen, { seeds }));
      const finals = rows.filter((row) => row.isFinal === true);
      expect(finals, what).toHaveLength(1);
      const final = finals[0] as BracketFixture;
      const dead = final.homeFrom !== undefined ? "home" : "away";
      const withdrawn = final[dead];
      const champion = dead === "home" ? final.away : final.home;
      expect(withdrawn, what).toBeDefined();
      const done = replacing(rows, { [final.id]: (row) => walkedOverDeadSeat(row, dead) });
      const got = rankOf(completeBracketStage({ id: "s", kind, entrants, seeds }, done).finalRanks);
      expect([got[champion ?? "?"], got[withdrawn ?? "?"]], what).toEqual([1, 2]);
      checked++;
    }
    expect(checked, "bracket kinds checked").toBe(4);
  });
});
