// W4 knockout engine, Task 9 (plan 2026-11-05-w4-knockout-engine.md, batch B4; owner ruling 265, plate option B): the
// plate's field. Rows proved here live in rules/cross-sport.md; the rulebook is rulebook-W4-knockout.md (RB4-*).
//
// X-PL-3 (RB4-P1): the plate holds everyone's first loss — every round-1 loser, plus every bye holder who loses their
// first match (in round 2). RB4-P3: the field is known after round 2 and never waits for the main final.
// X-PL-4 (RB4-P2): a first loss by walkover, withdrawal, retirement or disqualification does not enter it.
// X-SD-3 (RB4-E3): two entrants are one final and no plate.
//
// The engine's round 0 is the product's "round 1", its round 1 the product's "round 2". Rows come from the real generator
// played out by the W4 driver (`playOutBracket`, better seed wins unless a test says otherwise), stripped to the fields the
// app's `toBracketFixture` row carries. Expected values come from the rulebook — membership from RB4-P1/P2 and the fold of
// RB4-D1 with byes to the top seeds (RB4-D2) — never from `firstLossField`.
// single-sport: bracket code is sport-agnostic (reads no SportModule)
import { describe, expect, it } from "vitest";
import { EngineError } from "../core/errors.ts";
import { generateDoubleElim, generateSingleElim, type GeneratedBracket } from "../scheduling/bracket.ts";
import { playOutBracket, type PlayOutOptions } from "../testkit/bracket-play.ts";
import { firstLossField, type FirstLoss } from "./first-loss.ts";
import type { BracketFixtureRow } from "./progression.ts";
import type { BracketFixture } from "./stage.ts";

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `e${i + 1}`);
const seedsOf = (list: readonly string[]): Map<string, number> => new Map(list.map((id, i) => [id, i + 1]));
const nextPow2 = (n: number): number => 2 ** Math.ceil(Math.log2(n));

/** The app's row, as `toBracketFixture` builds it (competition.ts), from a played fixture: nothing the row does not carry. */
function toRow(f: BracketFixture): BracketFixtureRow {
  return {
    id: f.id,
    round: f.round,
    status: f.status,
    ...(f.bracket === undefined ? {} : { bracket: f.bracket }),
    ...(f.thirdPlace === undefined ? {} : { thirdPlace: f.thirdPlace }),
    ...(f.home === undefined ? {} : { home: f.home }),
    ...(f.away === undefined ? {} : { away: f.away }),
    ...(f.winner === undefined ? {} : { winner: f.winner }),
    ...(f.loser === undefined ? {} : { loser: f.loser }),
    ...(f.walkedOver === undefined ? {} : { walkedOver: f.walkedOver }),
  };
}

const knockout = (n: number): GeneratedBracket => generateSingleElim({ entrants: ids(n), seeds: seedsOf(ids(n)) });
const playOut = (gen: GeneratedBracket, n: number, opts: PlayOutOptions = {}): BracketFixtureRow[] =>
  playOutBracket(gen, { seeds: seedsOf(ids(n)), ...opts }).map(toRow);
const played = (n: number, opts: PlayOutOptions = {}): BracketFixtureRow[] => playOut(knockout(n), n, opts);

/** A row not yet played: its result gone, its seats kept only when asked (fed from settled lines) — the bracket mid-play. */
function unplayed(row: BracketFixtureRow, keepSeats: boolean): BracketFixtureRow {
  return {
    id: row.id,
    round: row.round,
    status: "scheduled",
    ...(row.bracket === undefined ? {} : { bracket: row.bracket }),
    ...(row.thirdPlace === undefined ? {} : { thirdPlace: row.thirdPlace }),
    ...(keepSeats && row.home !== undefined ? { home: row.home } : {}),
    ...(keepSeats && row.away !== undefined ? { away: row.away } : {}),
  };
}

/** The bracket as it stands once engine round `last` is played: the next round seated from it, anything later empty. */
const asOfRound = (rows: readonly BracketFixtureRow[], last: number): BracketFixtureRow[] =>
  rows.map((row) => (row.round <= last ? row : unplayed(row, row.round === last + 1)));

const who = (list: readonly FirstLoss[]): string[] => list.map((loss) => loss.entrantId);
const asSet = (list: readonly string[]): string[] => [...list].sort();

function refusalOf(run: () => unknown): EngineError {
  try {
    run();
  } catch (e) {
    if (e instanceof EngineError) return e;
    throw e;
  }
  throw new Error("expected a refusal, the call returned");
}

/** RB4-P1 over the RB4-D1 fold, for a draw played out to seed — computed from the seed numbers, never from the generator.
 *  S = the draw (next power of two), B = S − n byes, to seeds 1..B (RB4-D2). Round 0 pairs seed s with S + 1 − s; the
 *  line headed by s ≤ S/2 is played when its partner is a real entrant (s > B), and the worse seed S + 1 − s loses it.
 *  Round 1 pairs the round-0 lines whose top seeds sum to S/2 + 1 (the fold at half size): lines a and S/2 + 1 − a, for
 *  a = 1..S/4. Under better-seed-wins a bye holder loses its first match only to another bye holder, so a round-1 line
 *  whose two top seeds are both bye holders (S/2 + 1 − a ≤ B) adds one first loss: the worse seed, S/2 + 1 − a. */
function ruleBookField(n: number): { roundOne: string[]; byeHolders: string[] } {
  const S = nextPow2(n);
  const B = S - n;
  const roundOne: string[] = [];
  for (let s = B + 1; s <= S / 2; s++) roundOne.push(`e${S + 1 - s}`);
  const byeHolders: string[] = [];
  for (let a = 1; a <= S / 4; a++) if (S / 2 + 1 - a <= B) byeHolders.push(`e${S / 2 + 1 - a}`);
  return { roundOne, byeHolders };
}

describe("X-PL-3 the plate holds everyone's first loss: every round-1 loser, plus every bye holder who loses their first match (RB4-P1, P3)", () => {
  it("X-PL-3 the empty case first: no rows → not complete, no losers, nothing pending (controller ruling B4-2)", () => {
    // differential: the brief's "no rows → complete" — overridden (C5, B4-2): no main draw yet is never a final field, so
    // the app does not complete a plate as too small before its main draw exists.
    expect(firstLossField([])).toEqual({ complete: false, losers: [], excluded: [], pending: [] });
  });

  it("X-PL-3 an 8-draw, no byes: the four round-1 losers, complete after round 1", () => {
    // RB4-D1 fold of 8: lines (1,8) (5,4) (3,6) (7,2), every one played; the worse seed loses each (RB4-P1: round-1 losers).
    const all = played(8);
    const afterRoundOne = firstLossField(asOfRound(all, 0));
    expect(afterRoundOne.complete).toBe(true);
    expect(asSet(who(afterRoundOne.losers))).toEqual(asSet(["e8", "e5", "e6", "e7"]));
    expect(afterRoundOne.losers.every((loss) => loss.round === 0)).toBe(true);
    expect(afterRoundOne).toMatchObject({ excluded: [], pending: [] });
    // RB4-P3: known after round 1 here, and nothing later moves it — the final changes no one's first loss.
    expect(firstLossField(all)).toEqual(afterRoundOne);
  });

  it("X-PL-3 n=5 (8-draw, fold lines (1,8b) (5,4) (3,6b) (7b,2), better seed wins): losers = [e5 (R1, 4 v 5), e3 (R2, bye holders 2 v 3 meet)]", () => {
    // RB4-D2: byes to seeds 1-3. Round 1 plays only 4 v 5 (e5 loses). Round 2: e1 v e4 (e4 won its first match, so its
    // loss to e1 is not a first loss), e3 v e2 — both bye holders, so e3's loss IS its first (RB4-P1).
    const rows = played(5);
    const field = firstLossField(rows);
    expect(field.losers).toEqual([
      { entrantId: "e5", fixtureId: "se-r0-i1", round: 0 },
      { entrantId: "e3", fixtureId: "se-r1-i1", round: 1 },
    ]);
    expect(field).toMatchObject({ complete: true, excluded: [], pending: [] });
    expect(who(field.losers)).not.toContain("e4");
    // RB4-P3: the field is final after round 2.
    expect(firstLossField(asOfRound(rows, 1))).toEqual(field);
  });

  it("X-PL-3 a bye holder who wins round 2 is not in the plate, and a bye holder who wins R2 by walkover and loses R3 is not either", () => {
    // n=6 (8-draw): byes to e1 and e2; round 1 plays 5 v 4 and 3 v 6 (e5, e6 lose). Round 2: e1 v e4, e3 v e2.
    const toSeed = firstLossField(played(6));
    // Both bye holders win round 2: their first match is a win (RB4-P1 holds only first LOSSES).
    expect(asSet(who(toSeed.losers))).toEqual(asSet(["e5", "e6"]));
    // e4 forfeits round 2 to e1, and e2 beats e1 in the final (round 3). e1's first match was that round-2 walkover win,
    // so the final is e1's first LOSS but not its first MATCH: not in the plate. e4's forfeit follows its round-1 win, so
    // it is no first loss either (nothing excluded).
    const finalToE2 = (home: string, away: string): string => (home === "e2" || away === "e2" ? "e2" : home < away ? home : away);
    const walkedThenLost = firstLossField(
      played(6, { forfeit: new Map([["se-r1-i0", "e4"]]), winner: finalToE2 }),
    );
    expect(asSet(who(walkedThenLost.losers))).toEqual(asSet(["e5", "e6"]));
    expect(walkedThenLost).toMatchObject({ complete: true, excluded: [], pending: [] });
  });

  it("X-PL-3 incomplete: a bye holder's round-2 line still scheduled → complete false, pending [that id]", () => {
    // n=5: round 1 played; round 2's e3 v e2 decided (e3's first loss), e1 v e4 still scheduled — e1's first match unknown.
    const rows = played(5).map((row) =>
      row.round >= 2 ? unplayed(row, false) : row.id === "se-r1-i0" ? unplayed(row, true) : row,
    );
    const field = firstLossField(rows);
    expect(field.complete).toBe(false);
    expect(field.pending).toEqual(["se-r1-i0"]);
    expect(who(field.losers)).toEqual(["e5", "e3"]);
    // Both round-2 lines scheduled: both owed, in bracket order.
    expect(firstLossField(asOfRound(played(5), 0)).pending).toEqual(["se-r1-i0", "se-r1-i1"]);
  });

  it("X-PL-3 incomplete: a round-1 line in play, or a bye holder not yet seated in round 2, owes its line's id", () => {
    // n=5. Round 1's 4 v 5 still in play: both its sides' first match is unknown, and so is bye holder e1's, seated in
    // round 2 against that line's winner. Round 2's e3 v e2 is decided (e3's first loss).
    const inPlay = played(5).map((row) => {
      if (row.id === "se-r0-i1") return { ...unplayed(row, true), status: "in_play" as const };
      if (row.id === "se-r1-i0") return { id: row.id, round: row.round, status: "scheduled" as const, home: "e1" };
      return row.round >= 2 ? unplayed(row, false) : row;
    });
    const live = firstLossField(inPlay);
    expect(live.complete).toBe(false);
    expect(live.pending).toEqual(["se-r0-i1", "se-r1-i0"]);
    expect(who(live.losers)).toEqual(["e3"]);
    // Round 1 settled, round 2 not yet seated at all: each bye holder (e1, e3, e2) advanced and waits for its first match,
    // owed by its round-1 line (fold lines 0, 2, 3); e4 played and won its round-1 line, so it owes nothing here.
    const unseated = played(5).map((row) => (row.round >= 1 ? unplayed(row, false) : row));
    const waiting = firstLossField(unseated);
    expect(waiting.complete).toBe(false);
    expect(waiting.pending).toEqual(["se-r0-i0", "se-r0-i2", "se-r0-i3"]);
    expect(who(waiting.losers)).toEqual(["e5"]);
  });

  it("X-PL-3 losers are ordered by round, then bracket position: a bye holder's round-2 loss follows every round-1 loss", () => {
    // n=6 with e4 beating e1 in round 2 (e1's first loss, at the top of the draw), everyone else to seed.
    const upset = (home: string, away: string): string =>
      [home, away].includes("e1") && [home, away].includes("e4") ? "e4" : home < away ? home : away;
    const field = firstLossField(played(6, { winner: upset }));
    expect(field.losers).toEqual([
      { entrantId: "e5", fixtureId: "se-r0-i1", round: 0 },
      { entrantId: "e6", fixtureId: "se-r0-i2", round: 0 },
      { entrantId: "e1", fixtureId: "se-r1-i0", round: 1 },
    ]);
  });

  it("X-PL-3 the round orders first, whatever order the rows arrive in: round-2 rows listed before round-1 rows give the same losers", () => {
    // The same n=6 upset, its rows handed over later rounds first (each round's own rows still in bracket order): e1's
    // round-2 loss now comes FIRST in the rows, and still follows every round-1 loss (review m1).
    const upset = (home: string, away: string): string =>
      [home, away].includes("e1") && [home, away].includes("e4") ? "e4" : home < away ? home : away;
    const rows = played(6, { winner: upset });
    const laterFirst = [...rows.filter((row) => row.round >= 1), ...rows.filter((row) => row.round === 0)];
    expect(laterFirst[0]?.id).toBe("se-r1-i0");
    expect(firstLossField(laterFirst).losers).toEqual([
      { entrantId: "e5", fixtureId: "se-r0-i1", round: 0 },
      { entrantId: "e6", fixtureId: "se-r0-i2", round: 0 },
      { entrantId: "e1", fixtureId: "se-r1-i0", round: 1 },
    ]);
  });

  it("X-PL-3 a late entrant's case-(1) line (newcomer v bye holder in round 0) feeds the plate with its first loss like anyone else (RB4-L14, L3)", () => {
    // n=5, then a 6th entrant arrives: RB4-L3/L4 reverse the lowest-seeded bye holder's bye (e3, fold line 2) into a new
    // round-1 match, e3 v e6. Nothing else moves.
    const late = (): GeneratedBracket => {
      const gen = knockout(5);
      return {
        ...gen,
        fixtures: gen.fixtures.map((f) => (f.id === "se-r0-i2" ? { id: f.id, round: 0, home: "e3", away: "e6" } : f)),
      };
    };
    // e3 wins: e6's loss is its first (RB4-P1). e3 has now played and won round 1, so its round-2 loss to e2 is no first
    // loss — differential: without the late entrant, e3 is in the plate (n=5 above).
    const newcomerLoses = firstLossField(playOut(late(), 6));
    expect(asSet(who(newcomerLoses.losers))).toEqual(asSet(["e5", "e6"]));
    expect(newcomerLoses.complete).toBe(true);
    // e6 wins instead: e3's round-1 loss is its first; e6 lost to e2 in round 2 after a win, which is no first loss.
    const newcomerWins = firstLossField(
      playOut(late(), 6, { winner: (home, away) => ([home, away].includes("e6") && [home, away].includes("e3") ? "e6" : home < away ? home : away) }),
    );
    expect(asSet(who(newcomerWins.losers))).toEqual(asSet(["e5", "e3"]));
  });

  it("X-PL-3 a voided round-1 line (a departed qualifier's) waits for nobody: the field completes without its two sides (controller ruling B4-5, R13)", () => {
    // n=8: line (5,4) voided — nobody advances from it, so neither side ever has a first match to wait for, and e1 walks
    // through round 2. Every other line went to seed: e8, e6, e7 lose round 1.
    const field = firstLossField(played(8, { voided: new Set(["se-r0-i1"]) }));
    expect(field.complete).toBe(true);
    expect(field.pending).toEqual([]);
    expect(asSet(who(field.losers))).toEqual(asSet(["e8", "e6", "e7"]));
    expect(field.excluded).toEqual([]);
  });

  it("X-PL-3 a second call answers the same and leaves its rows untouched", () => {
    const rows = played(13).map((row) => Object.freeze(row));
    const first = firstLossField(rows);
    expect(firstLossField(rows)).toEqual(first);
    expect(rows).toEqual(played(13));
  });

  it("X-PL-3 counted sweep: n = 4 … 131 played out to seed, every first loss eligible — the RB4-P1 count over the RB4-D1 fold", () => {
    let checked = 0;
    for (let n = 4; n <= 131; n++) {
      const field = firstLossField(played(n));
      const { roundOne, byeHolders } = ruleBookField(n);
      expect(field.losers.length, `n=${n}`).toBe((2 * n - nextPow2(n)) / 2 + byeHolders.length);
      expect(asSet(who(field.losers)), `n=${n}`).toEqual(asSet([...roundOne, ...byeHolders]));
      expect(field, `n=${n}`).toMatchObject({ complete: true, excluded: [], pending: [] });
      checked++;
    }
    expect(checked).toBe(128);
  });

  // Hand-computed from the fold, beside the sweep's formula: S, round-1 losers (2n − S)/2, and the round-2 lines of two
  // bye holders (top seeds a and S/2 + 1 − a, both ≤ B = S − n, for a ≤ S/4).
  it.each([
    [5, 8, 1, 1],
    [6, 8, 2, 0],
    [7, 8, 3, 0],
    [9, 16, 1, 3],
    [17, 32, 1, 7],
    [33, 64, 1, 15],
    [34, 64, 2, 14],
    [35, 64, 3, 13],
    [65, 128, 1, 31],
    [66, 128, 2, 30],
    [67, 128, 3, 29],
    [129, 256, 1, 63],
    [130, 256, 2, 62],
    [131, 256, 3, 61],
  ])("X-PL-3 n=%i (draw of %i): %i round-1 losers plus %i bye holders who lose their first match", (n, draw, roundOne, byeHolders) => {
    expect(nextPow2(n)).toBe(draw);
    const field = firstLossField(played(n));
    expect(field.losers.filter((loss) => loss.round === 0)).toHaveLength(roundOne);
    expect(field.losers.filter((loss) => loss.round === 1)).toHaveLength(byeHolders);
    expect(field.complete).toBe(true);
  });
});

describe("X-PL-4 a first loss by walkover, withdrawal, retirement or disqualification does not enter the plate (RB4-P2)", () => {
  // Controller ruling B4-4: the four reasons (FORFEIT_REASONS, core/types.ts) reach the engine as ONE input. The app's
  // `bracketWinnerLoser` marks every award with a seated loser `walkedOver: "loser"` (apps/web/src/server/engine-db/
  // competition.ts:207-210), so which reason it was is the app's mapping, and here it is one case plus the double walkover.
  it("X-PL-4 excluded: a round-1 loss by forfeit (walkedOver \"loser\", whatever the reason) and both sides of a round-1 double walkover", () => {
    // n=8: e4 forfeits its line to e5 (the better seed out, not the worse); e3 v e6 is a double walkover; (1,8) and (7,2)
    // go to seed (e8, e7 lose). e5 won round 1 without playing, so its first match is round 2, which it loses to e1: a
    // first loss, played (RB4-P1). e2 walks over the dead line.
    const field = firstLossField(
      played(8, { forfeit: new Map([["se-r0-i1", "e4"]]), doubleWalkover: new Set(["se-r0-i2"]) }),
    );
    expect(asSet(who(field.losers))).toEqual(asSet(["e8", "e7", "e5"]));
    expect(field.excluded).toEqual([
      { entrantId: "e4", fixtureId: "se-r0-i1", round: 0 },
      { entrantId: "e3", fixtureId: "se-r0-i2", round: 0 },
      { entrantId: "e6", fixtureId: "se-r0-i2", round: 0 },
    ]);
    expect(field).toMatchObject({ complete: true, pending: [] });
  });

  it("X-PL-4 excluded: a bye holder whose first match (round 2) is a forfeit or a double walkover; its opponent, who played round 1, is not", () => {
    // n=6: e1 holds a bye; round 2 is e1 v e4 (e4 beat e5 in round 1).
    const forfeit = firstLossField(played(6, { forfeit: new Map([["se-r1-i0", "e1"]]) }));
    expect(forfeit.excluded).toEqual([{ entrantId: "e1", fixtureId: "se-r1-i0", round: 1 }]);
    expect(who(forfeit.losers)).not.toContain("e1");
    const both = firstLossField(played(6, { doubleWalkover: new Set(["se-r1-i0"]) }));
    expect(both.excluded).toEqual([{ entrantId: "e1", fixtureId: "se-r1-i0", round: 1 }]);
    expect(asSet(who(both.losers))).toEqual(asSet(["e5", "e6"]));
    expect(both.complete).toBe(true);
  });
});

describe("X-SD-3 two entrants are one final and no plate (RB4-E3)", () => {
  it("X-SD-3 n=2 and n=3: the first-loss field is complete with fewer than 2 losers — too small for a plate (X-PL-2's named outcome is the app's)", () => {
    // n=2: one final, e2 loses it — one first loss. n=3 (4-draw, bye to e1): e3 loses round 1 to e2; e1's first match is
    // the final, which it wins — still one first loss.
    for (const [n, losers] of [[2, ["e2"]], [3, ["e3"]]] as const) {
      const field = firstLossField(played(n));
      expect(field.complete, `n=${n}`).toBe(true);
      expect(who(field.losers), `n=${n}`).toEqual(losers);
      expect(field.losers.length, `n=${n}`).toBeLessThan(2);
    }
  });
});

describe("firstLossField refuses rows it cannot read (CONFIG_INVALID, controller ruling B4-6)", () => {
  it("a row without an id is refused by name", () => {
    const rows = played(4);
    const err = refusalOf(() => firstLossField([...rows, { round: 1, status: "scheduled" }]));
    expect(err.code).toBe("CONFIG_INVALID");
    expect(err.data).toEqual({ reason: "first_loss_row_without_id", index: rows.length });
  });

  it("rows with no opening round (1-based, as the app's round_no) are refused by name, never read as a field still open (review m3)", () => {
    // differential: before the refusal these rows answered { complete: false, pending: [] } forever — a plate that never
    // proposes and says nothing. The same draw numbered from 0 (BracketFixture.round, as the generators emit) is read.
    const zeroBased = played(4);
    const oneBased = zeroBased.map((row) => ({ ...row, round: row.round + 1 }));
    const err = refusalOf(() => firstLossField(oneBased));
    expect(err.code).toBe("CONFIG_INVALID");
    expect(err.data).toEqual({ reason: "first_loss_no_opening_round", lowestRound: 1 });
    expect(firstLossField(zeroBased).complete).toBe(true);
  });

  it("a row without a status is refused by name", () => {
    const err = refusalOf(() => firstLossField([{ id: "se-r0-i0", round: 0, home: "e1", away: "e2" }]));
    expect(err.code).toBe("CONFIG_INVALID");
    expect(err.data).toEqual({ reason: "first_loss_row_without_status", fixtureId: "se-r0-i0" });
  });

  it("another bracket kind: a double elimination's losers'-bracket row, or its grand final, is refused — the plate is a single-elimination feed", () => {
    // The real double-elimination generator, played out: its first LB row and its GF row, each refused by name.
    const de = playOutBracket(generateDoubleElim({ entrants: ids(4), seeds: seedsOf(ids(4)) }), { seeds: seedsOf(ids(4)) }).map(toRow);
    const firstOff = de.find((row) => row.bracket === "LB" || row.bracket === "GF");
    const gf = de.find((row) => row.bracket === "GF");
    expect(firstOff?.bracket).toBe("LB"); // the generator lists the losers' bracket before the grand final
    expect(gf?.id).toBeDefined();
    const lb = refusalOf(() => firstLossField(de));
    expect(lb.code).toBe("CONFIG_INVALID");
    expect(lb.data).toEqual({ reason: "first_loss_not_single_elimination", fixtureId: firstOff?.id, bracket: "LB" });
    const gfOnly = refusalOf(() => firstLossField(de.filter((row) => row.bracket !== "LB")));
    expect(gfOnly.data).toEqual({ reason: "first_loss_not_single_elimination", fixtureId: gf?.id, bracket: "GF" });
  });
});

// Final review I2 (controller ruling F-I1/I2). An entrant who withdraws while their next opponent is still to be decided
// leaves that seat EMPTY and stamped dead (X-WD-3, ruling 116); the side that arrives walks over it, and the row names no
// loser. The row's feed (`homeFrom` / `awayFrom`, the generator's wiring, which the app keeps on the row) still names
// them, so the walkover is their first match and their loss by withdrawal — excluded (RB4-P2). Rows: the generator played
// out, its feeds kept, the withdrawal hand-built from the app's shape (controller ruling B5-1).

/** The rows with the generator's feeds, as the app keeps them on the row. */
function withFeeds(gen: GeneratedBracket, rows: readonly BracketFixtureRow[]): BracketFixtureRow[] {
  const byId = new Map(gen.fixtures.map((f) => [f.id, f]));
  return rows.map((row) => {
    const g = row.id === undefined ? undefined : byId.get(row.id);
    return { ...row, ...(g?.homeFrom === undefined ? {} : { homeFrom: g.homeFrom }), ...(g?.awayFrom === undefined ? {} : { awayFrom: g.awayFrom }) };
  });
}
const withoutFeeds = (rows: readonly BracketFixtureRow[]): BracketFixtureRow[] => rows.map(({ homeFrom: _h, awayFrom: _a, ...row }) => row);
/** The app's row once the side in `dead` left before the other arrived: that seat empty, the walkover to the side present. */
function walkedOverDeadSeat(row: BracketFixtureRow, dead: "home" | "away"): BracketFixtureRow {
  const { home, away, winner: _w, loser: _l, walkedOver: _o, ...rest } = row;
  const present = dead === "home" ? away : home;
  if (present === undefined) throw new Error(`walkedOverDeadSeat: ${row.id ?? "?"} has no side present`);
  return { ...rest, status: "walkover", ...(dead === "home" ? { away: present } : { home: present }), winner: present };
}
const rowAt = (rows: readonly BracketFixtureRow[], id: string): BracketFixtureRow => {
  const row = rows.find((r) => r.id === id);
  if (row === undefined) throw new Error(`no row ${id}`);
  return row;
};
const swapping = (rows: readonly BracketFixtureRow[], swaps: Record<string, (row: BracketFixtureRow) => BracketFixtureRow>): BracketFixtureRow[] =>
  rows.map((row) => (row.id === undefined ? row : swaps[row.id]?.(row) ?? row));

describe("X-PL-4 a first loss by withdrawal on a dead seat does not enter the plate, and the field completes (final review I2, RB4-P2)", () => {
  // n=6 (8-draw), to seed: byes to e1 (line se-r0-i0) and e2 (se-r0-i3); round 1 plays se-r0-i1 (e5 v e4) and se-r0-i2
  // (e3 v e6). Round 2: se-r1-i0 = e1 v the winner of se-r0-i1, se-r1-i1 = e3 v e2.
  const n6 = (): BracketFixtureRow[] => withFeeds(knockout(6), played(6));

  it("X-PL-4 the fixture's premise: bye holder e1's round-2 seat is fed by its bye line, and e4 beats e5 to reach it", () => {
    const rows = n6();
    expect(rowAt(rows, "se-r0-i0")).toMatchObject({ status: "walkover", winner: "e1" });
    expect(rowAt(rows, "se-r1-i0")).toMatchObject({ home: "e1", away: "e4", homeFrom: { fixtureId: "se-r0-i0", side: "winner" } });
    expect(rowAt(rows, "se-r0-i1")).toMatchObject({ winner: "e4", loser: "e5" });
  });

  it("X-PL-4 I2 sequence: bye holder e1 withdraws before round 2 while e4 v e5 is unplayed — pending names e1's own round-2 line, then the field completes with e1 excluded", () => {
    const rows = n6();
    // (1) e1 has withdrawn; se-r0-i1 (e5 v e4) and se-r1-i1 (e3 v e2) are still to play, se-r1-i0 seats nobody (e1's seat
    // dead, the other still to come). e1's first match is se-r1-i0 — its seat, though empty — and it is unplayed, so it
    // is owed; so are e4's and e5's (se-r0-i1) and e2's (se-r1-i1). e6 lost round 1 to e3: a first loss (RB4-P1).
    // differential: today pending names e1's BYE line se-r0-i0, already settled, and never clears.
    const unplayedRow = (keepSeats: boolean) => (row: BracketFixtureRow): BracketFixtureRow => ({
      ...unplayed(row, keepSeats),
      ...(row.homeFrom === undefined ? {} : { homeFrom: row.homeFrom }),
      ...(row.awayFrom === undefined ? {} : { awayFrom: row.awayFrom }),
    });
    const before = swapping(rows, {
      "se-r0-i1": unplayedRow(true),
      "se-r1-i0": unplayedRow(false),
      "se-r1-i1": unplayedRow(true),
      "se-r2-i0": unplayedRow(false),
    });
    expect(firstLossField(before)).toEqual({
      complete: false,
      losers: [{ entrantId: "e6", fixtureId: "se-r0-i2", round: 0 }],
      excluded: [],
      pending: ["se-r0-i1", "se-r1-i0", "se-r1-i1"],
    });
    // (2) e4 beats e5 and arrives: se-r1-i0 is a walkover to e4 over e1's dead seat. RB4-P2: e1's first match is a loss by
    // withdrawal, excluded. se-r1-i1 still owed (e2's first match).
    const arrived = swapping(rows, {
      "se-r1-i0": (row) => walkedOverDeadSeat(row, "home"),
      "se-r1-i1": unplayedRow(true),
      "se-r2-i0": unplayedRow(false),
    });
    expect(rowAt(arrived, "se-r1-i0")).toMatchObject({ status: "walkover", away: "e4", winner: "e4" });
    expect(firstLossField(arrived)).toEqual({
      complete: false,
      losers: [{ entrantId: "e5", fixtureId: "se-r0-i1", round: 0 }, { entrantId: "e6", fixtureId: "se-r0-i2", round: 0 }],
      excluded: [{ entrantId: "e1", fixtureId: "se-r1-i0", round: 1 }],
      pending: ["se-r1-i1"],
    });
    // (3) The other round-2 row settles (e2 beats e3: e2's first match a win; e3's loss follows its round-1 win). The field
    // is complete: e5 and e6 (RB4-P1), e1 excluded (RB4-P2), nothing owed.
    // differential: today complete stays false and pending stays ["se-r0-i0"] forever.
    const done = swapping(rows, { "se-r1-i0": (row) => walkedOverDeadSeat(row, "home") });
    const want = {
      complete: true,
      losers: [{ entrantId: "e5", fixtureId: "se-r0-i1", round: 0 }, { entrantId: "e6", fixtureId: "se-r0-i2", round: 0 }],
      excluded: [{ entrantId: "e1", fixtureId: "se-r1-i0", round: 1 }],
      pending: [],
    };
    expect(firstLossField(done)).toEqual(want);
    // A second call answers the same and leaves the rows untouched.
    const frozen = done.map((row) => Object.freeze({ ...row }));
    expect(firstLossField(frozen)).toEqual(want);
    expect(frozen).toEqual(done);
  });

  it("X-PL-4 a round-1 walkover winner who withdraws before round 2 (their seat dead) is excluded there, and the field completes", () => {
    // n=8, to seed, except e4 forfeits its round-1 line (se-r0-i1) to e5 — e4 excluded at round 1 (RB4-P2). e5 then
    // withdraws while e1 v e8 is unplayed: its se-r1-i0 seat is dead, and e1, arriving, walks over it. e5's first match
    // (it won round 1 without playing) is that walkover, a loss by withdrawal: excluded too. Round 1's played lines go to
    // seed: e8, e6, e7 lose (RB4-P1). differential: today e5's line se-r0-i1 is pending forever.
    const rows = withFeeds(knockout(8), played(8, { forfeit: new Map([["se-r0-i1", "e4"]]) }));
    expect(rowAt(rows, "se-r1-i0")).toMatchObject({ home: "e1", away: "e5", awayFrom: { fixtureId: "se-r0-i1", side: "winner" } });
    const done = swapping(rows, { "se-r1-i0": (row) => walkedOverDeadSeat(row, "away") });
    expect(firstLossField(done)).toEqual({
      complete: true,
      losers: [
        { entrantId: "e8", fixtureId: "se-r0-i0", round: 0 },
        { entrantId: "e6", fixtureId: "se-r0-i2", round: 0 },
        { entrantId: "e7", fixtureId: "se-r0-i3", round: 0 },
      ],
      excluded: [
        { entrantId: "e4", fixtureId: "se-r0-i1", round: 0 },
        { entrantId: "e5", fixtureId: "se-r1-i0", round: 1 },
      ],
      pending: [],
    });
  });

  it("X-PL-4 no-feed control: the same rows without the feed read as before — the bye holder's line stays pending, nothing thrown", () => {
    // The pre-fix answer the final review recorded (I2): with no feed the dead seat names nobody, so e1 is seated in no
    // round-2 row and its settled bye line stays owed. Unchanged for a caller that passes no feed.
    const done = withoutFeeds(swapping(n6(), { "se-r1-i0": (row) => walkedOverDeadSeat(row, "home") }));
    expect(firstLossField(done)).toEqual({
      complete: false,
      losers: [{ entrantId: "e5", fixtureId: "se-r0-i1", round: 0 }, { entrantId: "e6", fixtureId: "se-r0-i2", round: 0 }],
      excluded: [],
      pending: ["se-r0-i0"],
    });
  });
});
