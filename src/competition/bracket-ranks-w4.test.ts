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
import { tableRulesOf } from "../testkit/helpers.ts";
import { placementTable } from "./progression.ts";
import type { FixtureResult } from "./standings.ts";
import {
  assertBracketPlaces,
  assertCompletedBracketPlaces,
  BRACKET_SHARED_RANKS,
  bracketRanks,
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
