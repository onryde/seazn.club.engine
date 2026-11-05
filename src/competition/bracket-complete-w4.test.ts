// W4 knockout engine — completion (plan 2026-11-05-w4-knockout-engine.md, batch B2, Task 4). Rows proved here live in
// rules/cross-sport.md; the rulebook is rulebook-W4-knockout.md (RB4-*), signed by rulings 263-274.
//
// X-CH-7 (ruling 274, RB4-C7): a bracket stage completes only when EVERY fixture is decided or settled, and completing it
// with a fixture undecided is refused by name. Before W4 the predicate read the final alone, so a stage completed with a
// semi-final still scheduled (CH-1), and `completeBracketStage` ranked whatever it was handed, so a stage and its division
// completed while the final was still in_play (AN-2, a live prod defect).
//
// X-TP-4 (ruling 266, RB4-T3): with a third-place play-off, the stage is not complete until that match is decided or
// settled (3P-3). It is one of the stage's fixtures, so X-CH-7's rule holds it; these tests pin that it does.
//
// Expected values come from the rule text: "settled" is decided, void or walkover (the stage's own SETTLED set, spec 02
// §6), "complete" needs a final to have been played, and the refusal names every fixture still owed, in the caller's order.
// single-sport: bracket code is sport-agnostic (reads no SportModule)
import { describe, expect, it } from "vitest";
import { EngineError } from "../core/errors.ts";
import { BRACKET_STAGE_KINDS } from "./progression.ts";
import {
  completeBracketStage,
  isBracketStageComplete,
  undecidedBracketFixtures,
  type BracketFixture,
  type BracketStage,
} from "./stage.ts";

const ko: BracketStage = { id: "ko", kind: "knockout", entrants: ["A", "B", "C", "D"] };
const koS: BracketStage = { ...ko, entrants: ["S1", "S2", "S3", "S4"] };
const sf = (id: string, h: string, a: string, w: string): BracketFixture =>
  ({ id, round: 0, status: "decided", home: h, away: a, winner: w, loser: w === h ? a : h });

/** The refusal a call throws; a call that completes the stage instead fails the test. */
function refusalOf(run: () => unknown): EngineError {
  try {
    run();
  } catch (e) {
    if (e instanceof EngineError) return e;
    throw e;
  }
  throw new Error("expected a refusal, the stage completed");
}

/** RB4-C7's refusal as the plan's interface declares it: STAGE_NOT_READY with the stage and the named reason. */
function expectNotReady(err: EngineError, data: { stageId: string; reason: "no_final" } | { stageId: string; reason: "fixtures_undecided"; undecided: string[] }): void {
  expect(err.code).toBe("STAGE_NOT_READY");
  expect(err.data).toEqual(data);
}

// The 4-entrant single-elimination shape `generateSingleElim({ thirdPlace: true })` writes (ids `se-r<round>-i<game>`, the
// third-place match `se-3p` in the final's round), S1..S4 seeded 1v4 / 2v3, every semi-final going to seed.
const seBracket = (thirdPlace: BracketFixture): BracketFixture[] => [
  sf("se-r0-i0", "S1", "S4", "S1"),
  sf("se-r0-i1", "S2", "S3", "S2"),
  { id: "se-r1-i0", round: 1, isFinal: true, status: "decided", home: "S1", away: "S2", winner: "S1", loser: "S2" },
  thirdPlace,
];

describe("X-CH-7 a bracket stage completes only when every fixture is settled (RB4-C7)", () => {
  it("X-CH-7 the empty case first: no fixtures is not complete, and completeBracketStage refuses no_final", () => {
    // RB4-C7: nothing has been played, so no final has been — not complete. The empty list has no undecided fixture, so
    // only the no_final check can refuse it. differential: today completeBracketStage(ko, []) completes with no ranks.
    expect(isBracketStageComplete(ko, [])).toBe(false);
    expect(undecidedBracketFixtures([])).toEqual([]);
    expectNotReady(refusalOf(() => completeBracketStage(ko, [])), { stageId: "ko", reason: "no_final" });
  });

  it("X-CH-7 rows with no final are not complete, settled or not; no_final is refused before fixtures_undecided", () => {
    // RB4-C7: a stage whose final row does not exist has not played its final, however settled the rows it has.
    // differential: today completeBracketStage completes both sets below.
    const settled = [sf("sf1", "A", "D", "A"), sf("sf2", "B", "C", "B")];
    expect(undecidedBracketFixtures(settled)).toEqual([]);
    expect(isBracketStageComplete(ko, settled)).toBe(false);
    expectNotReady(refusalOf(() => completeBracketStage(ko, settled)), { stageId: "ko", reason: "no_final" });

    // The plan's order: no_final first, so a set with no final AND an undecided row names the missing final.
    const open: BracketFixture[] = [sf("sf1", "A", "D", "A"), { id: "sf2", round: 0, status: "scheduled", home: "B", away: "C" }];
    expect(undecidedBracketFixtures(open)).toEqual(["sf2"]);
    expect(isBracketStageComplete(ko, open)).toBe(false);
    expectNotReady(refusalOf(() => completeBracketStage(ko, open)), { stageId: "ko", reason: "no_final" });
  });

  it("X-CH-7 AN-2: final in_play with no outcome → not complete; refused fixtures_undecided naming the final", () => {
    const f: BracketFixture[] = [sf("sf1", "A", "D", "A"), sf("sf2", "B", "C", "B"), { id: "fin", round: 1, isFinal: true, status: "in_play", home: "A", away: "B" }];
    // RB4-C7: the final is in_play, not settled. differential: today completes and ranks C, D, A, B (observed at d68376e:
    // the unbeaten finalists have no loss round, so they sort below the semi-final losers).
    expect(isBracketStageComplete(ko, f)).toBe(false);
    expect(undecidedBracketFixtures(f)).toEqual(["fin"]);
    expectNotReady(refusalOf(() => completeBracketStage(ko, f)), { stageId: "ko", reason: "fixtures_undecided", undecided: ["fin"] });
  });

  it("X-CH-7 CH-1: final decided but a semi still scheduled → not complete", () => {
    // RB4-C7: sf2 is scheduled, so the stage owes a fixture whatever the final says. The rule reads no stage kind, so
    // it holds for every bracket-shaped kind the engine declares (BRACKET_STAGE_KINDS). differential: today true.
    const f: BracketFixture[] = [
      sf("sf1", "A", "D", "A"),
      { id: "sf2", round: 0, status: "scheduled", home: "B", away: "C" },
      { id: "fin", round: 1, isFinal: true, status: "decided", home: "A", away: "B", winner: "A", loser: "B" },
    ];
    let kinds = 0;
    for (const kind of BRACKET_STAGE_KINDS) {
      const stage: BracketStage = { id: `s-${kind}`, kind: kind as BracketStage["kind"], entrants: ["A", "B", "C", "D"] };
      expect(isBracketStageComplete(stage, f), kind).toBe(false);
      expectNotReady(refusalOf(() => completeBracketStage(stage, f)), { stageId: stage.id, reason: "fixtures_undecided", undecided: ["sf2"] });
      kinds++;
    }
    expect(kinds, "bracket stage kinds checked").toBe(4); // knockout, double_elim, stepladder, page_playoff
    expect(undecidedBracketFixtures(f)).toEqual(["sf2"]);
  });

  it("X-CH-7 void and walkover lines count as settled (a DE reset voided, a withdrawal walked over)", () => {
    // RB4-C7 "decided or settled": void and walkover are settled (spec 02 §6). The 4-entrant double-elimination shape
    // `generateDoubleElim({ bracketReset: true })` writes: S3 withdrew before the losers' first game (a walkover, the
    // loser forfeited), and the WB champion S1 won the grand final, so the reset was voided.
    const de: BracketStage = { id: "de", kind: "double_elim", entrants: ["S1", "S2", "S3", "S4"] };
    const f: BracketFixture[] = [
      { ...sf("wb-r0-i0", "S1", "S4", "S1"), bracket: "WB" },
      { ...sf("wb-r0-i1", "S2", "S3", "S2"), bracket: "WB" },
      { id: "wb-r1-i0", bracket: "WB", round: 1, status: "decided", home: "S1", away: "S2", winner: "S1", loser: "S2" },
      { id: "lb-r0-i0", bracket: "LB", round: 2, status: "walkover", home: "S4", away: "S3", winner: "S4", loser: "S3", walkedOver: "loser" },
      { id: "lb-r1-i0", bracket: "LB", round: 3, status: "decided", home: "S4", away: "S2", winner: "S2", loser: "S4" },
      { id: "gf", bracket: "GF", round: 4, isFinal: true, status: "decided", home: "S1", away: "S2", winner: "S1", loser: "S2" },
      { id: "gf-reset", bracket: "GF", round: 5, isFinal: true, status: "void", home: "S1", away: "S2" },
    ];
    expect(f.filter((x) => x.status === "void" || x.status === "walkover").map((x) => x.id)).toEqual(["lb-r0-i0", "gf-reset"]);
    expect(undecidedBracketFixtures(f)).toEqual([]);
    expect(isBracketStageComplete(de, f)).toBe(true);
    expect(completeBracketStage(de, f).events).toMatchObject([{ type: "stage_completed", stageId: "de" }]);
  });

  it("X-CH-7 a second call on the same rows gives the same answer; undecidedBracketFixtures keeps input order", () => {
    // Input order differs from id order (fin, qf2, sf1) and from round order (qf2, sf1, fin): the refusal lists the rows
    // as the caller handed them (plan "Interfaces": ids, input order).
    const open: BracketFixture[] = [
      { id: "sf1", round: 1, status: "in_play", home: "A", away: "C" },
      sf("qf1", "A", "H", "A"),
      { id: "fin", round: 2, isFinal: true, status: "scheduled" },
      { id: "qf2", round: 0, status: "scheduled", home: "B", away: "G" },
    ];
    const before = structuredClone(open);
    const want = ["sf1", "fin", "qf2"];
    expect(undecidedBracketFixtures(open)).toEqual(want);
    expect(undecidedBracketFixtures(open)).toEqual(want);
    expect(isBracketStageComplete(ko, open)).toBe(false);
    expect(isBracketStageComplete(ko, open)).toBe(false);
    for (let call = 1; call <= 2; call++) {
      expectNotReady(refusalOf(() => completeBracketStage(ko, open)), { stageId: "ko", reason: "fixtures_undecided", undecided: want });
    }
    expect(open).toEqual(before);

    // And on a settled stage: two completions of the same rows are the same completion, and neither moves the rows.
    const done = [sf("sf1", "A", "D", "A"), sf("sf2", "B", "C", "B"), { id: "fin", round: 1, isFinal: true, status: "decided" as const, home: "A", away: "B", winner: "A", loser: "B" }];
    const doneBefore = structuredClone(done);
    expect(isBracketStageComplete(ko, done)).toBe(true);
    expect(isBracketStageComplete(ko, done)).toBe(true);
    expect(completeBracketStage(ko, done)).toEqual(completeBracketStage(ko, done));
    expect(done).toEqual(doneBefore);
  });
});

describe("X-TP-4 a stage with a third-place play-off is not complete until it is decided (RB4-T3)", () => {
  it("X-TP-4 final decided, -3p scheduled → not complete; undecided ['se-3p']", () => {
    // RB4-T3: the semi-final losers still owe the play-off for 3rd and 4th. differential: today complete.
    const f = seBracket({ id: "se-3p", round: 1, thirdPlace: true, status: "scheduled", home: "S4", away: "S3" });
    expect(isBracketStageComplete(koS, f)).toBe(false);
    expect(undecidedBracketFixtures(f)).toEqual(["se-3p"]);
    expectNotReady(refusalOf(() => completeBracketStage(koS, f)), { stageId: "ko", reason: "fixtures_undecided", undecided: ["se-3p"] });
  });

  it("X-TP-4 -3p walked over (one side withdrew) → complete", () => {
    // RB4-T3 "decided or settled": S3 withdrew before the play-off, which S4 wins by walkover (X-TP-7's one-side-out case).
    const f = seBracket({ id: "se-3p", round: 1, thirdPlace: true, status: "walkover", home: "S4", away: "S3", winner: "S4", loser: "S3", walkedOver: "loser" });
    expect(undecidedBracketFixtures(f)).toEqual([]);
    expect(isBracketStageComplete(koS, f)).toBe(true);
    expect(completeBracketStage(koS, f).events).toMatchObject([{ type: "stage_completed", stageId: "ko" }]);
  });
});
