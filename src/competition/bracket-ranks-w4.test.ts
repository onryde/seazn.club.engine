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

  it("X-FR-1 a semi lost by walkover (the loser withdrew) still shares 3rd", () => {
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
    // Assumption → guard (wiring bugs, plain Error; B3-4: one case each). The final row every case starts from is valid.
    const ok: BracketFixture = { id: "f", round: 1, isFinal: true, status: "decided", home: "E1", away: "E2", jointWinners: true };
    expect(bracketTitle([ok])).toEqual({ kind: "joint", winners: ["E1", "E2"] });
    const { away: _away, ...noAway } = ok;
    const { home: _home, ...noHome } = ok;
    const cases: [string, BracketFixture, RegExp][] = [
      ["on a semi-final", { ...ok, isFinal: false }, /not the final/],
      ["with no away side", noAway, /both sides seated/],
      ["with no home side", noHome, /both sides seated/],
      ["with a winner", { ...ok, winner: "E1" }, /winner or a loser/],
      ["with a loser", { ...ok, loser: "E2" }, /winner or a loser/],
      ["walked over", { ...ok, status: "walkover", walkedOver: "both" }, /walkedOver/],
      ["on a scheduled final", { ...ok, status: "scheduled" }, /decided/],
    ];
    let thrown = 0;
    for (const [what, row, message] of cases) {
      expect(() => bracketTitle([row]), what).toThrow(message);
      expect(() => bracketTitle([row]), what).not.toThrow(EngineError);
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
    // Provisional reads still answer (Review Focus 5): the stage just cannot complete.
    expect(() => bracketRanks(stage, rows)).not.toThrow();
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
