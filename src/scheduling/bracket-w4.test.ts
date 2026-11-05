// W4 knockout engine — generation (plan 2026-11-05-w4-knockout-engine.md, batch B1). Rows proved here live in
// rules/cross-sport.md; the rulebook is rulebook-W4-knockout.md (RB4-*), signed by rulings 263-274.
//
// Task 1 — X-TP-5 (ruling 266, RB4-T4): a third-place match is generated only where both semi-finals are real. A semi-final
// holding a bye (an `award`, which only round 0 can hold) has no loser to send, and a 2-entrant knockout has no semi-final
// at all. X-SD-3 (ruling 274, RB4-E3): a knockout of 2 entrants is one final.
//
// Expected values come from the rulebook's arithmetic, never from the generator: a field of n is drawn into the next power
// of two S, S - n byes go to the top seeds (X-SD-5), the final is the one round-(depth - 1) game, and the semi-finals are
// the two games that feed it.
// single-sport: bracket code is sport-agnostic (reads no SportModule)
import { describe, expect, it } from "vitest";
import { EngineError } from "../core/errors.ts";
import { generateSingleElim, type BracketFixtureGen } from "./bracket.ts";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `e${i + 1}`);
const seeds = (n: number) => new Map(ids(n).map((id, i) => [id, i + 1]));

/** The refusal a call throws; a call that returns a bracket instead fails the test. */
function refusalOf(run: () => unknown): EngineError {
  try {
    run();
  } catch (e) {
    if (e instanceof EngineError) return e;
    throw e;
  }
  throw new Error("expected a refusal, got a bracket");
}

/** The X-TP-5 refusal as the plan's interface declares it (plan "Interfaces": data holds reason, entrants, realSemis). */
function expectThirdPlaceRefusal(err: EngineError, entrants: number, realSemis: number): void {
  expect(err.code).toBe("CONFIG_INVALID");
  expect(err.data).toEqual({ reason: "third_place_needs_two_semis", entrants, realSemis });
  expect(err.message).toBe(`a third-place match needs two real semi-finals; ${entrants} entrants give ${realSemis}`);
}

/** Rounds a field of n needs: the depth of the next power of two (the rulebook's draw size), computed here. */
const depthOf = (n: number): number => Math.ceil(Math.log2(n));

describe("X-TP-5 a third-place match needs two real semi-finals (RB4-T4)", () => {
  it("X-TP-5 the empty case first: n=0 and n=1 with thirdPlace return the empty bracket, never the refusal (counted)", () => {
    // RB4-E1/E2: below 2 entrants there is no bracket; the app refuses 0 and 1 by name (X-SD-1, X-SD-2), so the engine
    // answers with no fixtures (depth 0) and does not reach the third-place rule.
    let checked = 0;
    for (const n of [0, 1]) {
      expect(generateSingleElim({ entrants: ids(n), seeds: seeds(n), thirdPlace: true })).toEqual({ fixtures: [], rounds: 0 });
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("X-TP-5 n=3 with thirdPlace: refused CONFIG_INVALID third_place_needs_two_semis, realSemis 1", () => {
    // RB4-T4: n=3 draws into 4, one bye (4 - 3) to seed 1 (X-SD-5), so one semi-final is a bye award and one is real.
    // differential: today a -3p fed by the bye award's (absent) loser
    const run = () => generateSingleElim({ entrants: ids(3), seeds: seeds(3), thirdPlace: true });
    expectThirdPlaceRefusal(refusalOf(run), 3, 1);
    // a second call refuses the same way
    expectThirdPlaceRefusal(refusalOf(run), 3, 1);
  });

  it("X-TP-5 n=3 with thirdPlace: refused whichever way the bye is placed (organiser's byes, an explicit slot map)", () => {
    // RB4-T4: wherever the one bye of a 3-entrant draw sits, it sits in a semi-final, so one semi-final is real.
    // differential: today both routes generate a -3p fed by the bye award's (absent) loser
    const byOrganiser = () => generateSingleElim({ entrants: ids(3), seeds: seeds(3), byeEntrants: ["e3"], thirdPlace: true });
    expectThirdPlaceRefusal(refusalOf(byOrganiser), 3, 1);
    // slot map 1 v 2, 3 v bye
    const bySlotMap = () => generateSingleElim({ entrants: ids(3), seeds: seeds(3), slotOrder: [1, 2, 3, null], thirdPlace: true });
    expectThirdPlaceRefusal(refusalOf(bySlotMap), 3, 1);
  });

  it("X-TP-5 n=2 with thirdPlace: refused, realSemis 0", () => {
    // RB4-E3 / X-SD-3: n=2 draws into 2, one round, the final is round 0; no semi-final exists.
    // differential: today silently omitted (one final, no -3p, no error)
    const run = () => generateSingleElim({ entrants: ids(2), seeds: seeds(2), thirdPlace: true });
    expectThirdPlaceRefusal(refusalOf(run), 2, 0);
    expectThirdPlaceRefusal(refusalOf(run), 2, 0);
  });

  it("X-TP-5 n=4..64 with thirdPlace: exactly one -3p, fed by the losers of the two round depth-2 fixtures, neither an award (counted)", () => {
    let checked = 0;
    for (let n = 4; n <= 64; n++) {
      const { fixtures, rounds } = generateSingleElim({ entrants: ids(n), seeds: seeds(n), thirdPlace: true });
      const depth = depthOf(n);
      expect(rounds).toBe(depth);
      const byId = new Map(fixtures.map((f) => [f.id, f]));
      const finals = fixtures.filter((f) => f.isFinal === true);
      expect(finals).toHaveLength(1);
      const final = finals[0] as BracketFixtureGen;
      // the semi-finals are the two games feeding the final, both winner feeds, both in round depth - 2
      expect([final.homeFrom?.side, final.awayFrom?.side]).toEqual(["winner", "winner"]);
      const semiIds = [final.homeFrom?.fixtureId, final.awayFrom?.fixtureId];
      const semis = semiIds.map((id) => byId.get(id as string));
      for (const semi of semis) {
        expect(semi?.round).toBe(depth - 2);
        // n >= 4: S - n byes sit in round 0 only, and at n = 4 there are none, so no semi-final is an award
        expect(semi?.award).toBeUndefined();
      }
      const third = fixtures.filter((f) => f.thirdPlace === true);
      expect(third).toHaveLength(1);
      expect(third[0]).toEqual({
        id: "se-3p",
        round: depth - 1,
        thirdPlace: true,
        homeFrom: { fixtureId: semiIds[0], side: "loser" },
        awayFrom: { fixtureId: semiIds[1], side: "loser" },
      });
      checked++;
    }
    // n = 4..64 inclusive
    expect(checked).toBe(61);
  });

  it("X-TP-5 n=3 without thirdPlace still generates: 1 award, 1 real semi, 1 final", () => {
    // n=3 draws into 4: semi-finals are round 0, one the bye award to seed 1 (X-SD-5), one e2 v e3; the final (round 1)
    // takes both winners; S - 1 = 3 games; no third-place game.
    for (const opts of [{}, { thirdPlace: false }]) {
      const { fixtures, rounds } = generateSingleElim({ entrants: ids(3), seeds: seeds(3), ...opts });
      expect(rounds).toBe(2);
      expect(fixtures).toHaveLength(3);
      const awards = fixtures.filter((f) => f.award !== undefined);
      expect(awards.map((f) => [f.round, f.award])).toEqual([[0, "e1"]]);
      const real = fixtures.filter((f) => f.round === 0 && f.award === undefined);
      expect(real).toHaveLength(1);
      expect(new Set([real[0]?.home, real[0]?.away])).toEqual(new Set(["e2", "e3"]));
      const finals = fixtures.filter((f) => f.isFinal === true);
      expect(finals).toHaveLength(1);
      expect(finals[0]?.round).toBe(1);
      expect(new Set([finals[0]?.homeFrom?.fixtureId, finals[0]?.awayFrom?.fixtureId])).toEqual(
        new Set([awards[0]?.id, real[0]?.id]),
      );
      expect(fixtures.some((f) => f.thirdPlace === true)).toBe(false);
    }
  });

  it("X-TP-5 after a withdrawal: a 4-entrant draw takes its third place; the same field less the withdrawn entrant is refused", () => {
    // RB4-T4: 4 entrants give two real semi-finals; with one withdrawn before the draw, 3 give one (the bye semi).
    const four = generateSingleElim({ entrants: ids(4), seeds: seeds(4), thirdPlace: true });
    expect(four.fixtures.filter((f) => f.thirdPlace === true)).toHaveLength(1);
    const remaining = ids(4).filter((e) => e !== "e4");
    const run = () => generateSingleElim({ entrants: remaining, seeds: seeds(4), thirdPlace: true });
    expectThirdPlaceRefusal(refusalOf(run), 3, 1);
  });
});

describe("X-SD-3 a knockout of 2 entrants is one final (RB4-E3)", () => {
  it("X-SD-3 n=2: one fixture, round 0, isFinal, both seats, no award, no thirdPlace; a second call is byte-identical", () => {
    // RB4-E3: one final, seed 1 at the top (home) and seed 2 at the bottom (X-SD-4); 2 = 2^1, so no bye; one round.
    const first = generateSingleElim({ entrants: ids(2), seeds: seeds(2) });
    expect(first.rounds).toBe(1);
    expect(first.fixtures).toEqual([{ id: "se-r0-i0", round: 0, isFinal: true, home: "e1", away: "e2" }]);
    const only = first.fixtures[0] as BracketFixtureGen;
    expect(only.award).toBeUndefined();
    expect(only.thirdPlace).toBeUndefined();
    expect(only.homeFrom).toBeUndefined();
    expect(only.awayFrom).toBeUndefined();
    const second = generateSingleElim({ entrants: ids(2), seeds: seeds(2) });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    // thirdPlace: false is the same one final
    expect(JSON.stringify(generateSingleElim({ entrants: ids(2), seeds: seeds(2), thirdPlace: false }))).toBe(JSON.stringify(first));
    // no third-place match: asked for, it is refused (X-TP-5, no semi-final)
    // differential: today the request is dropped silently and the same one final comes back
    expectThirdPlaceRefusal(refusalOf(() => generateSingleElim({ entrants: ids(2), seeds: seeds(2), thirdPlace: true })), 2, 0);
  });
});
