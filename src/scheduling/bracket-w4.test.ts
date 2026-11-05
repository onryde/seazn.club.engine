// W4 knockout engine — generation (plan 2026-11-05-w4-knockout-engine.md, batch B1). Rows proved here live in
// rules/cross-sport.md; the rulebook is rulebook-W4-knockout.md (RB4-*), signed by rulings 263-274.
//
// Task 1 — X-TP-5 (ruling 266, RB4-T4): a third-place match is generated only where both semi-finals are real. A semi-final
// holding a bye (an `award`, which only round 0 can hold) has no loser to send, and a 2-entrant knockout has no semi-final
// at all. X-SD-3 (ruling 274, RB4-E3): a knockout of 2 entrants is one final.
//
// Task 2 — X-SD-4 (ruling 268, RB4-D1, a recorded deviation): seeds are placed by the deterministic fold; X-SD-5 (ruling
// 268, RB4-D2): byes go to the top seeds as awards. Both are proved on unchanged code, every n = 2..128 (not sampled).
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

/** RB4-D1: the draw size S of a field of n is the next power of two, computed here (never `nextPowerOfTwo`). */
const drawSizeOf = (n: number): number => 2 ** depthOf(n);

/** The entrant a seeds map gives seed s (the inverse of the map the test hands the generator). */
function entrantOfSeed(map: ReadonlyMap<string, number>, s: number): string {
  const hit = [...map].filter(([, seed]) => seed === s);
  expect(hit, `exactly one entrant holds seed ${s}`).toHaveLength(1);
  return (hit[0] as [string, number])[0];
}

/** Round 0 in line order, asserted whole: S / 2 lines, line i named `se-r0-i<i>`. */
function linesOf(fixtures: readonly BracketFixtureGen[], size: number): BracketFixtureGen[] {
  const round0 = fixtures.filter((f) => f.round === 0);
  expect(round0.map((f) => f.id)).toEqual(Array.from({ length: size / 2 }, (_, i) => `se-r0-i${i}`));
  return round0;
}

/** n = 2..128, the sizes every Task 2 enumeration walks: 127 of them. */
const SIZES = Array.from({ length: 127 }, (_, i) => i + 2);

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

/** RB4-D1 checked seat by seat on a generated bracket of the n entrants `map` seeds 1..n; returns the section levels checked.
 *  Line i is round-0 fixture i; a bye stands for a seed beyond n, so an award line holds one real seed s and the bye S + 1 - s. */
function expectFold(fixtures: readonly BracketFixtureGen[], n: number, map: ReadonlyMap<string, number>): number {
  const size = drawSizeOf(n);
  const at = `n=${n} S=${size}`;
  const lines = linesOf(fixtures, size);
  const seedOf = (e: string | undefined): number => {
    const s = map.get(e as string);
    expect(s, `${at}: ${e} is a seeded entrant`).toBeDefined();
    return s as number;
  };
  const lineOfSeed = new Map<number, number>();
  let realSeats = 0;
  let byeSeats = 0;
  lines.forEach((f, i) => {
    if (f.award === undefined) {
      const h = seedOf(f.home);
      const a = seedOf(f.away);
      // RB4-D1: the two seats of line i hold seeds summing to S + 1
      expect(h + a, `${at} line ${i}`).toBe(size + 1);
      lineOfSeed.set(h, i).set(a, i);
      realSeats += 2;
    } else {
      // the award holder's fold partner, S + 1 - s, is beyond n: a bye, no entrant
      const s = seedOf(f.award);
      expect(size + 1 - s, `${at} line ${i}: the bye partner of seed ${s}`).toBeGreaterThan(n);
      lineOfSeed.set(s, i);
      realSeats += 1;
      byeSeats += 1;
    }
  });
  // seed 1 at the top: line 0, home
  expect(lines[0]?.home, `${at}: seed 1 at the top`).toBe(entrantOfSeed(map, 1));
  // seed 2 at the bottom: line S/2 - 1. Ruling C2: an award line seats its real side at home (X-SD-5), so seed 2 is home
  // when it holds a bye (2 <= S - n) and away, the bottom seat, otherwise.
  const bottom = lines[size / 2 - 1];
  const seed2 = entrantOfSeed(map, 2);
  if (2 <= size - n) {
    expect(bottom?.home, `${at}: seed 2 at the bottom, on its bye`).toBe(seed2);
    expect(bottom?.award, `${at}: seed 2 holds a bye`).toBe(seed2);
  } else {
    expect(bottom?.away, `${at}: seed 2 at the bottom`).toBe(seed2);
  }
  // for every k with 2^k <= S, seeds 1..2^k fall in 2^k distinct sections of S / 2^k slots
  let levels = 0;
  for (let sections = 1; sections <= size; sections *= 2) {
    const slots = size / sections;
    if (slots >= 2) {
      // a section of `slots` seats is slots / 2 whole lines; seeds 1..sections are all entrants here (n > S/2 >= sections)
      const hit = new Set<number>();
      for (let s = 1; s <= sections; s++) {
        expect(s, `${at}: seed ${s} is an entrant`).toBeLessThanOrEqual(n);
        const line = lineOfSeed.get(s);
        expect(line, `${at}: seed ${s} is placed`).toBeDefined();
        hit.add(Math.floor((line as number) / (slots / 2)));
      }
      expect(hit.size, `${at}: seeds 1..${sections} in ${sections} sections of ${slots}`).toBe(sections);
    } else {
      // the slot level (2^k = S): S distinct seats, each of the n seeds on one, S - n byes on the rest
      expect(lineOfSeed.size, `${at}: n distinct seeds placed`).toBe(n);
      expect(realSeats, `${at}: n seats hold an entrant`).toBe(n);
      expect(byeSeats, `${at}: S - n seats are byes`).toBe(size - n);
    }
    levels++;
  }
  return levels;
}

describe("X-SD-4 seeded entrants are placed by the deterministic fold (RB4-D1, deviation 268)", () => {
  it("X-SD-4 the empty case first: n=0 and n=1 place no one (no fixtures, depth 0; counted)", () => {
    // RB4-E1/E2: below 2 entrants there is no draw to fold (the app refuses both by name, X-SD-1, X-SD-2).
    let checked = 0;
    for (const n of [0, 1]) {
      expect(generateSingleElim({ entrants: ids(n), seeds: seeds(n) })).toEqual({ fixtures: [], rounds: 0 });
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("X-SD-4 the fold, written from RB4-D1 not from seedPositions: line seats sum to S + 1, seed 1 top, seed 2 bottom, seeds 1..2^k in 2^k sections (n=2..128, counted)", () => {
    // n - 1 after a withdrawal is one of these sizes: the fold is the same rule over whatever field is drawn.
    let checked = 0;
    let levels = 0;
    for (const n of SIZES) {
      const { fixtures } = generateSingleElim({ entrants: ids(n), seeds: seeds(n) });
      levels += expectFold(fixtures, n, seeds(n));
      checked++;
    }
    expect(checked).toBe(127);
    // log2(S) + 1 levels per size, by S: 2 (1 size, 2 levels), 4 (2 sizes, 3), 8 (4, 4), 16 (8, 5), 32 (16, 6), 64 (32, 7),
    // 128 (64, 8)
    expect(levels).toBe(2 + 6 + 16 + 40 + 96 + 224 + 512);
  });

  it("X-SD-4 the seeds map decides the fold, not the input order: reversed input, and a map reversing the input, still put seed 1 at the top (n=2..128, counted)", () => {
    let checked = 0;
    for (const n of SIZES) {
      const forward = generateSingleElim({ entrants: ids(n), seeds: seeds(n) });
      // the same map over the input reversed: the same bracket, seed 1 (e1) at the top
      const reversedInput = generateSingleElim({ entrants: [...ids(n)].reverse(), seeds: seeds(n) });
      expect(JSON.stringify(reversedInput), `n=${n}`).toBe(JSON.stringify(forward));
      expect(reversedInput.fixtures[0]?.home, `n=${n}`).toBe("e1");
      // the input in order and a map that reverses it (e_k holds seed n + 1 - k): seed 1 is the LAST entrant listed, and the
      // fold puts it at the top all the same, with the whole fold drawn from the map
      const reversedMap = new Map(ids(n).map((id, i) => [id, n - i]));
      const byMap = generateSingleElim({ entrants: ids(n), seeds: reversedMap });
      expect(byMap.fixtures[0]?.home, `n=${n}`).toBe(`e${n}`);
      expectFold(byMap.fixtures, n, reversedMap);
      checked++;
    }
    expect(checked).toBe(127);
  });

  it("X-SD-4 a second call is byte-identical (n=2..128, counted)", () => {
    let checked = 0;
    for (const n of SIZES) {
      const first = generateSingleElim({ entrants: ids(n), seeds: seeds(n) });
      const second = generateSingleElim({ entrants: ids(n), seeds: seeds(n) });
      expect(JSON.stringify(second), `n=${n}`).toBe(JSON.stringify(first));
      checked++;
    }
    expect(checked).toBe(127);
  });
});

describe("X-SD-5 byes go to the top seeds, and a bye is an award, never a match (RB4-D2)", () => {
  it("X-SD-5 the empty case first: n=0 and n=1 award no bye (no fixtures; counted)", () => {
    // RB4-E1/E2: no draw, so no bye line and no award.
    let checked = 0;
    for (const n of [0, 1]) {
      const { fixtures } = generateSingleElim({ entrants: ids(n), seeds: seeds(n) });
      expect(fixtures).toEqual([]);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("X-SD-5 byes go to the top seeds: the award holders are exactly seeds 1..S−n, each an award with no opponent and no feed (n=2..128, counted)", () => {
    let checked = 0;
    let awarded = 0;
    for (const n of SIZES) {
      const size = drawSizeOf(n);
      const { fixtures } = generateSingleElim({ entrants: ids(n), seeds: seeds(n) });
      const awards = fixtures.filter((f) => f.award !== undefined);
      // RB4-D2: S - n byes, to seeds 1..S - n in seed order
      expect(awards, `n=${n}`).toHaveLength(size - n);
      const topSeeds = Array.from({ length: size - n }, (_, i) => entrantOfSeed(seeds(n), i + 1));
      expect(new Set(awards.map((f) => f.award)), `n=${n}`).toEqual(new Set(topSeeds));
      for (const f of awards) {
        // an award, never a match: the real side at home, no opponent, no feed, and only round 0 can hold one
        expect(f.home, `n=${n} ${f.id}`).toBe(f.award);
        expect(f.away, `n=${n} ${f.id}`).toBeUndefined();
        expect(f.homeFrom, `n=${n} ${f.id}`).toBeUndefined();
        expect(f.awayFrom, `n=${n} ${f.id}`).toBeUndefined();
        expect(f, `n=${n} ${f.id}`).toEqual({ id: f.id, round: 0, home: f.award, award: f.award });
      }
      awarded += awards.length;
      checked++;
    }
    expect(checked).toBe(127);
    // the sum of S - n over n = 2..128, by S: 2 gives 0, 4 gives 1, 8 gives 3+2+1, 16 gives 7+..+1, 32 gives 15·16/2,
    // 64 gives 31·32/2, 128 gives 63·64/2
    expect(awarded).toBe(0 + 1 + 6 + 28 + 120 + 496 + 2016);
  });

  it("X-SD-5 every entrant is placed exactly once in round 0: home ∪ away ∪ award is a permutation of the n ids (n=2..128, counted)", () => {
    let checked = 0;
    let placed = 0;
    for (const n of SIZES) {
      const size = drawSizeOf(n);
      const { fixtures } = generateSingleElim({ entrants: ids(n), seeds: seeds(n) });
      const seats: string[] = [];
      for (const f of linesOf(fixtures, size)) {
        if (f.award !== undefined) {
          // an award line places its one real side once (home is the same entrant, not a second placement)
          expect(f.home, `n=${n} ${f.id}`).toBe(f.award);
          expect(f.away, `n=${n} ${f.id}`).toBeUndefined();
          seats.push(f.award);
        } else {
          expect(f.home, `n=${n} ${f.id}`).toBeDefined();
          expect(f.away, `n=${n} ${f.id}`).toBeDefined();
          seats.push(f.home as string, f.away as string);
        }
      }
      expect([...seats].sort(), `n=${n}`).toEqual([...ids(n)].sort());
      // past round 0 every seat is a winner feed, so no later round places an entrant a second time; S - 1 games in all,
      // S / 2 of them in round 0
      const later = fixtures.filter((f) => f.round > 0);
      expect(later, `n=${n}`).toHaveLength(size / 2 - 1);
      for (const f of later) {
        expect([f.home, f.away, f.award], `n=${n} ${f.id}`).toEqual([undefined, undefined, undefined]);
        expect([f.homeFrom?.side, f.awayFrom?.side], `n=${n} ${f.id}`).toEqual(["winner", "winner"]);
      }
      placed += seats.length;
      checked++;
    }
    expect(checked).toBe(127);
    // the sum of n over n = 2..128: 128·129/2 - 1
    expect(placed).toBe(8255);
  });

  it("X-SD-5 after a withdrawal: the byes skip the withdrawn seed and go to the top remaining seeds, in seed order", () => {
    // A field of 6 seeded 1..6; e3 withdraws before the draw. 5 remain, S = 8, so 3 byes (8 - 5), to the three highest
    // remaining seeds: e1, e2 and e4 (seed 3 is gone; a reading of "seed number <= S - n" would hand the third to nobody).
    const remaining = ids(6).filter((e) => e !== "e3");
    const run = () => generateSingleElim({ entrants: remaining, seeds: seeds(6) });
    const { fixtures } = run();
    const awards = fixtures.filter((f) => f.award !== undefined).map((f) => f.award);
    expect(awards).toHaveLength(3);
    expect(new Set(awards)).toEqual(new Set(["e1", "e2", "e4"]));
    const seats = linesOf(fixtures, 8).flatMap((f) => (f.award === undefined ? [f.home, f.away] : [f.award]));
    expect([...seats].sort()).toEqual([...remaining].sort());
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });
});
