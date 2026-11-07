// S2-4 (2026-11-07) — the hand strike swap (CK-SS-1, ruling 277; S2-4 phone design ruling 76) and the mid-over bowler
// change (CK-BC-1 and CK-BO-3, ruling 278; S2-4 phone design ruling 75; MCC Law 17.7 and 17.8), read through the real fold,
// the scorecard, the player stats and DLS.
//
// single-sport: every fact here is a cricket Law (who is on strike, who bowls an over); no other sport has them.
import { describe, expect, it } from "vitest";
import { EngineError } from "../../core/errors.ts";
import { foldMatch, type EventEnvelope } from "../../core/events.ts";
import type { LineupPair } from "../../core/types.ts";
import { aggregatePlayerStats } from "../../stats/stats.ts";
import { makeEnvelope } from "../../testkit/index.ts";
import {
  cricket,
  eligibleBowlers,
  eligibleChangeBowlers,
  oversUsed,
  type CricketBallEv,
  type CricketCfg,
  type CricketState,
  type FineInnings,
} from "./cricket.ts";
import { deriveCricketScorecard } from "./scorecard.ts";

function lineup(prefix: string): LineupPair["home"] {
  return {
    entrantId: prefix,
    slots: Array.from({ length: 11 }, (_, i) => ({
      personId: `${prefix}-${i + 1}`,
      slot: "starting" as const,
      orderNo: i + 1,
      ...(i === 1 ? { roles: ["wicketkeeper"] } : {}),
    })),
  };
}
const lineups: LineupPair = { home: lineup("H"), away: lineup("A") };
const STRICT_ALL = { strictFromSeq: 0 } as const;
const parse = (raw: unknown): CricketCfg => cricket.configSchema.parse(raw);

/** Ten overs a side, two overs a bowler: room for a part over to matter to the quota. */
const TEN = parse({ ballsPerInnings: 60, maxOversPerBowler: 2, minOversForResult: 5 });
/** Two overs a side with DLS on, one over a bowler: the shortest chase an abandon hands to Duckworth/Lewis/Stern. */
const DLS = parse({ ballsPerInnings: 12, maxOversPerBowler: 1, minOversForResult: 1, dls: { enabled: true, edition: "standard" } });

interface Ball {
  striker: string;
  nonStriker: string;
  bowler: string;
  bat?: number;
  extras?: NonNullable<CricketBallEv["runs"]["extras"]>;
  wicket?: CricketBallEv["wicket"];
}

/** DLS's first innings: two overs of fours (48), so the chase has a target to be short of. */
const firstInnings = (l: Ledger): Ledger => {
  for (let i = 0; i < 6; i++) l.ball({ striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 4 });
  for (let i = 0; i < 6; i++) l.ball({ striker: "H-2", nonStriker: "H-1", bowler: "A-10", bat: 4 });
  return l.innings();
};

/** Keeps the fold's over/ball cursor; `innings()` restarts it for the next innings. */
class Ledger {
  private readonly specs: Array<[string, unknown]> = [["core.start", {}]];
  private legal = 0;
  ball(spec: Ball): this {
    this.specs.push([
      "cricket.ball",
      {
        over: Math.floor(this.legal / 6),
        ballInOver: (this.legal % 6) + 1,
        striker: spec.striker,
        nonStriker: spec.nonStriker,
        bowler: spec.bowler,
        runs: { bat: spec.bat ?? 0, ...(spec.extras === undefined ? {} : { extras: spec.extras }) },
        ...(spec.wicket === undefined ? {} : { wicket: spec.wicket }),
      } satisfies CricketBallEv,
    ]);
    const kind = spec.extras?.kind;
    if (kind !== "wide" && kind !== "noball") this.legal += 1;
    return this;
  }
  /** `n` dot balls by `bowler` to an unchanged pair. */
  dots(n: number, striker: string, nonStriker: string, bowler: string): this {
    for (let i = 0; i < n; i++) this.ball({ striker, nonStriker, bowler });
    return this;
  }
  change(bowler: string, reason?: "incapacitated" | "suspended" | "other"): this {
    this.specs.push(["cricket.bowler.change", { bowler, ...(reason === undefined ? {} : { reason }) }]);
    return this;
  }
  ev(type: string, payload: unknown = {}): this {
    this.specs.push([type, payload]);
    return this;
  }
  innings(): this {
    this.legal = 0;
    return this;
  }
  build(): EventEnvelope[] {
    return this.specs.map(([type, payload], i) => makeEnvelope(i, { type, payload }));
  }
}

const strict = (cfg: CricketCfg, events: EventEnvelope[]): CricketState => foldMatch(cricket, cfg, lineups, events, STRICT_ALL);
/** The read path: every event already in the ledger (no strict seam). */
const replay = (cfg: CricketCfg, events: EventEnvelope[]): CricketState => foldMatch(cricket, cfg, lineups, events);
function fineOf(state: CricketState, index = 0): FineInnings {
  const fine = state.innings[index]?.fine;
  if (fine == null) throw new Error("premise: a ball-by-ball innings");
  return fine;
}
function refusalOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    if (err instanceof EngineError) return `${err.code}: ${err.message}`;
    throw err;
  }
}
const statsOf = (events: EventEnvelope[]) =>
  Object.fromEntries(aggregatePlayerStats(events, cricket.playerStats!, lineups).map((row) => [row.personId, row.stats]));

// ---------------------------------------------------------------------------------------------------------------------
// CK-SS-1 — the hand strike swap
// ---------------------------------------------------------------------------------------------------------------------

describe("CK-SS-1 a hand strike swap is the pair reversed on the next ball", () => {
  it("CK-SS-1 accepts the reversed pair mid-over on the write path, and the swapped striker is credited the ball", () => {
    const events = new Ledger()
      .ball({ striker: "H-1", nonStriker: "H-2", bowler: "A-11" })
      // the scorer corrects the strike: same two batters, ends swapped
      .ball({ striker: "H-2", nonStriker: "H-1", bowler: "A-11", bat: 2 })
      .build();
    const fine = fineOf(strict(TEN, events));
    expect([fine.striker, fine.nonStriker]).toEqual(["H-2", "H-1"]);
    expect(fine.batterBalls).toEqual({ "H-1": 1, "H-2": 1 });
    expect(fine.batterRuns).toEqual({ "H-1": 0, "H-2": 2 });
    // the strict fold and the read path agree on the swapped ledger, byte for byte
    expect(JSON.stringify(replay(TEN, events))).toBe(JSON.stringify(strict(TEN, events)));
  });

  it("CK-SS-1 leaves the unfaced incoming batter unfaced: the swap moves no one in, and his end may still be named afresh", () => {
    const opened = new Ledger()
      .ball({ striker: "H-1", nonStriker: "H-2", bowler: "A-11", wicket: { kind: "bowled", out: "H-1", bowlerCredited: true } });
    const after = fineOf(strict(TEN, opened.build()));
    expect([after.striker, after.nonStriker, after.unfacedIncoming]).toEqual(["H-3", "H-2", "H-3"]);
    const swapped = opened.ball({ striker: "H-2", nonStriker: "H-3", bowler: "A-11" });
    const fine = fineOf(strict(TEN, swapped.build()));
    expect([fine.striker, fine.nonStriker]).toEqual(["H-2", "H-3"]);
    expect(fine.unfacedIncoming, "H-3 has still not faced").toBe("H-3");
    // …so the captain may still send someone else in at that end (the unfaced-incoming rule, unchanged)
    const renamed = swapped.ball({ striker: "H-2", nonStriker: "H-7", bowler: "A-11" });
    expect(fineOf(strict(TEN, renamed.build())).nonStriker).toBe("H-7");
  });

  it("CK-SS-1 refuses a third batter: a pair that brings in anyone but the two at the crease is not a swap", () => {
    const base = new Ledger().ball({ striker: "H-1", nonStriker: "H-2", bowler: "A-11" });
    let refused = 0;
    for (const [striker, nonStriker] of [
      ["H-3", "H-2"], // one end replaced
      ["H-2", "H-3"], // the swap with a stranger at the other end
      ["H-3", "H-1"],
      ["H-3", "H-4"], // both ends replaced
    ] as const) {
      const events = new Ledger().ball({ striker: "H-1", nonStriker: "H-2", bowler: "A-11" }).ball({ striker, nonStriker, bowler: "A-11" }).build();
      expect(refusalOf(() => strict(TEN, events)), `${striker}/${nonStriker}`).toBe("INVALID_EVENT: striker/non-striker do not match the ledger");
      refused++;
    }
    expect(refused).toBe(4);
    expect(refusalOf(() => strict(TEN, base.build()))).toBeNull();
  });

  it("CK-SS-1 refuses a one-end change outside the unfaced-incoming rule, at either end and after a wicket at the other end", () => {
    // no wicket: neither batter is unfaced, so neither end may change
    for (const pair of [{ striker: "H-1", nonStriker: "H-5" }, { striker: "H-5", nonStriker: "H-2" }]) {
      const events = new Ledger().ball({ striker: "H-1", nonStriker: "H-2", bowler: "A-11" }).ball({ ...pair, bowler: "A-11" }).build();
      expect(refusalOf(() => strict(TEN, events)), JSON.stringify(pair)).toBe("INVALID_EVENT: striker/non-striker do not match the ledger");
    }
    // after a wicket H-3 is the unfaced incoming batter at the striker's end: the survivor's end (H-2) may not change
    const events = new Ledger()
      .ball({ striker: "H-1", nonStriker: "H-2", bowler: "A-11", wicket: { kind: "bowled", out: "H-1", bowlerCredited: true } })
      .ball({ striker: "H-3", nonStriker: "H-5", bowler: "A-11" })
      .build();
    expect(refusalOf(() => strict(TEN, events))).toBe("INVALID_EVENT: striker/non-striker do not match the ledger");
  });

  it("CK-SS-1 the scorecard, the player stats and DLS agree with the fold after a swap", () => {
    // Innings 1: two dot overs. The chase: a swap on its second ball, then an abandon after over 1, so DLS decides.
    const first = firstInnings;
    const swapped = first(new Ledger())
      .ball({ striker: "A-1", nonStriker: "A-2", bowler: "H-11", bat: 1 })
      .ball({ striker: "A-1", nonStriker: "A-2", bowler: "H-11", bat: 2 }) // the fold has A-2 on strike after the single
      .dots(4, "A-1", "A-2", "H-11")
      .ball({ striker: "A-2", nonStriker: "A-1", bowler: "H-10", bat: 1 })
      .ev("core.abandon", { reason: "rain" });
    // the premise: A-1/A-2 on the second ball is the pair reversed (the single put A-2 on strike)
    const preSwap = first(new Ledger()).ball({ striker: "A-1", nonStriker: "A-2", bowler: "H-11", bat: 1 }).build();
    const preFine = fineOf(strict(DLS, preSwap), 1);
    expect([preFine.striker, preFine.nonStriker]).toEqual(["A-2", "A-1"]);
    // the twin: the same runs, wickets and balls with nobody swapping (A-2 faces the ball the swap gave A-1)
    const twin = first(new Ledger())
      .ball({ striker: "A-1", nonStriker: "A-2", bowler: "H-11", bat: 1 })
      .ball({ striker: "A-2", nonStriker: "A-1", bowler: "H-11", bat: 2 })
      .dots(4, "A-2", "A-1", "H-11")
      .ball({ striker: "A-1", nonStriker: "A-2", bowler: "H-10", bat: 1 })
      .ev("core.abandon", { reason: "rain" });
    const events = swapped.build();
    const state = strict(DLS, events);
    const twinState = strict(DLS, twin.build());
    expect(state.outcome, "premise: the abandon is decided by DLS").toMatchObject({ method: "dls" });
    expect(state.outcome).toEqual(twinState.outcome);
    expect(state.margin).toEqual(twinState.margin);
    expect([state.r1, state.r2, state.revisedTarget]).toEqual([twinState.r1, twinState.r2, twinState.revisedTarget]);
    // the fold: A-1 faced the swap ball and the four dots after it, then the over end put A-2 on strike for the last single
    const fine = fineOf(state, 1);
    expect(fine.batterRuns).toEqual({ "A-1": 3, "A-2": 1 });
    expect(fine.batterBalls).toEqual({ "A-1": 6, "A-2": 1 });
    // the scorecard reads the fold's figures
    const card = deriveCricketScorecard({ events, cfg: DLS, lineups }).innings[1]!;
    const line = (person: string) => card.batting.find((l) => l.person === person);
    expect([line("A-1")?.runs, line("A-1")?.balls, line("A-2")?.runs, line("A-2")?.balls]).toEqual([3, 6, 1, 1]);
    expect(card.total).toMatchObject({ runs: 4, wickets: 0, legalBalls: 7 });
    // the player stats read the ledger's own striker, which the swap named
    const stats = statsOf(events);
    expect([stats["A-1"]?.runs, stats["A-1"]?.balls_faced, stats["A-2"]?.runs, stats["A-2"]?.balls_faced]).toEqual([3, 6, 1, 1]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// CK-BC-1 — the mid-over bowler change (Law 17.8)
// ---------------------------------------------------------------------------------------------------------------------

/** Over 1: A-11 bowls two balls (a single, then a dot), is replaced by A-10, who completes it with four. */
const splitFirstOver = () =>
  new Ledger()
    .ball({ striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 1 })
    .ball({ striker: "H-2", nonStriker: "H-1", bowler: "A-11" })
    .change("A-10", "incapacitated")
    .ball({ striker: "H-2", nonStriker: "H-1", bowler: "A-10", bat: 4 })
    .dots(3, "H-2", "H-1", "A-10");

describe("CK-BC-1 another bowler completes the over in progress (MCC Law 17.8)", () => {
  it("CK-BC-1 hands the over to the incoming bowler: later balls name and credit them, and each bowler's figures get the balls they bowled", () => {
    const fine = fineOf(strict(TEN, splitFirstOver().build()));
    expect(fine.bowlerBalls).toEqual({ "A-11": 2, "A-10": 4 });
    expect(fine.bowlerRuns).toEqual({ "A-11": 1, "A-10": 4 });
    expect(fine.currentBowler, "the over is over").toBeNull();
    expect(fine.prevOverBowler).toBe("A-10");
    expect(fine.prevOverBowlers).toEqual(["A-11", "A-10"]);
    expect(fine.overSpells, "cleared at the over's end").toBeUndefined();
    // mid-over, the fold names the spell that left
    const mid = fineOf(strict(TEN, new Ledger().dots(2, "H-1", "H-2", "A-11").change("A-10").build()));
    expect([mid.currentBowler, mid.overSpells]).toEqual(["A-10", [{ bowler: "A-11", legalBalls: 2 }]]);
  });

  it("CK-BC-1 refuses a ball that names the outgoing bowler after the change", () => {
    const events = new Ledger().dots(2, "H-1", "H-2", "A-11").change("A-10").ball({ striker: "H-1", nonStriker: "H-2", bowler: "A-11" }).build();
    expect(refusalOf(() => strict(TEN, events))).toBe('INVALID_EVENT: over in progress belongs to "A-10"');
  });

  it("CK-BC-1 bars both bowlers of the split over from the next one (Law 17.7), and frees both for the one after", () => {
    const next = (bowler: string) => splitFirstOver().ball({ striker: "H-1", nonStriker: "H-2", bowler }).build();
    expect(refusalOf(() => strict(TEN, next("A-11")))).toBe(
      'INVALID_EVENT: bowler "A-11" bowled part of the previous over and cannot bowl this one (Law 17.8)',
    );
    expect(refusalOf(() => strict(TEN, next("A-10")))).toBe('INVALID_EVENT: bowler "A-10" cannot bowl consecutive overs');
    expect(refusalOf(() => strict(TEN, next("A-9")))).toBeNull();
    // the over after: both may bowl again (each has one of two overs used)
    const third = (bowler: string) => splitFirstOver().dots(6, "H-1", "H-2", "A-9").ball({ striker: "H-2", nonStriker: "H-1", bowler }).build();
    expect(refusalOf(() => strict(TEN, third("A-11")))).toBeNull();
    expect(refusalOf(() => strict(TEN, third("A-10")))).toBeNull();
    expect(fineOf(strict(TEN, third("A-11"))).prevOverBowlers, "an unsplit over forgets the split before it").toBeUndefined();
  });

  it("CK-BC-1 refuses an incoming bowler who bowled the previous over, the bowler already on, and one who left this over", () => {
    const previous = new Ledger().dots(6, "H-1", "H-2", "A-9").dots(2, "H-2", "H-1", "A-11").change("A-9").build();
    expect(refusalOf(() => strict(TEN, previous))).toBe('INVALID_EVENT: bowler "A-9" bowled the previous over and cannot complete this one (Law 17.8)');
    const same = new Ledger().dots(2, "H-1", "H-2", "A-11").change("A-11").build();
    expect(refusalOf(() => strict(TEN, same))).toBe('INVALID_EVENT: bowler "A-11" has already bowled in this over');
    const back = new Ledger().dots(2, "H-1", "H-2", "A-11").change("A-10").dots(1, "H-1", "H-2", "A-10").change("A-11").build();
    expect(refusalOf(() => strict(TEN, back))).toBe('INVALID_EVENT: bowler "A-11" has already bowled in this over');
    // a second change in the same over, to someone new, is a change like the first
    const twice = new Ledger().dots(2, "H-1", "H-2", "A-11").change("A-10").dots(1, "H-1", "H-2", "A-10").change("A-8").dots(3, "H-1", "H-2", "A-8").build();
    const fine = fineOf(strict(TEN, twice));
    expect(fine.prevOverBowlers).toEqual(["A-11", "A-10", "A-8"]);
    expect(fine.partOverBalls).toEqual({ "A-11": 2, "A-10": 1, "A-8": 3 });
  });

  it("CK-BC-1 refuses a change with no over in progress, from outside the fielding side, at summary fidelity, and before the start", () => {
    expect(refusalOf(() => strict(TEN, new Ledger().change("A-10").build()))).toBe(
      "INVALID_EVENT: bowler change needs an innings in progress",
    );
    expect(refusalOf(() => strict(TEN, new Ledger().dots(6, "H-1", "H-2", "A-11").change("A-10").build()))).toBe(
      "INVALID_EVENT: no over is in progress: the next over's bowler is named on its first ball",
    );
    expect(refusalOf(() => strict(TEN, new Ledger().dots(2, "H-1", "H-2", "A-11").change("H-5").build()))).toBe(
      'INVALID_EVENT: bowler "H-5" is not in the fielding lineup',
    );
    const coarse = new Ledger().ev("cricket.innings.summary", { runs: 10, wickets: 0, legalBalls: 12, partial: true }).change("A-10").build();
    expect(refusalOf(() => strict(TEN, coarse))).toBe("INVALID_EVENT: this innings is recorded at summary fidelity — a bowler change is not allowed");
    const pre = [makeEnvelope(0, { type: "cricket.bowler.change", payload: { bowler: "A-10" } })];
    expect(refusalOf(() => strict(TEN, pre))).toMatch(/^WRONG_PHASE: bowler change in phase "pre"/);
  });

  it("CK-BC-1 a change in an over of only wides so far charges the outgoing bowler a part over of no legal balls", () => {
    const events = new Ledger()
      .ball({ striker: "H-1", nonStriker: "H-2", bowler: "A-11", extras: { kind: "wide", runs: 1 } })
      .change("A-10")
      .dots(6, "H-1", "H-2", "A-10")
      .build();
    const fine = fineOf(strict(TEN, events));
    expect(fine.bowlerBalls).toEqual({ "A-10": 6 });
    expect(fine.bowlerRuns).toEqual({ "A-11": 1, "A-10": 0 });
    expect(fine.partOvers).toEqual({ "A-11": 1, "A-10": 1 });
    expect(fine.partOverBalls).toEqual({ "A-11": 0, "A-10": 6 });
  });

  it("CK-BC-1 on the read path a change that no longer lands inside an over, or names the bowler on, is a no-op, not a throw", () => {
    const outside = new Ledger().dots(6, "H-1", "H-2", "A-11").change("A-10").ball({ striker: "H-2", nonStriker: "H-1", bowler: "A-9" }).build();
    const without = new Ledger().dots(6, "H-1", "H-2", "A-11").ball({ striker: "H-2", nonStriker: "H-1", bowler: "A-9" }).build();
    expect(JSON.stringify(fineOf(replay(TEN, outside)))).toBe(JSON.stringify(fineOf(replay(TEN, without))));
    const same = new Ledger().dots(2, "H-1", "H-2", "A-11").change("A-11").build();
    expect(fineOf(replay(TEN, same)).overSpells).toBeUndefined();
    // and the lineup is still checked: it is recorded with the stream, not read from the division config
    const stranger = new Ledger().dots(2, "H-1", "H-2", "A-11").change("H-5").build();
    expect(refusalOf(() => replay(TEN, stranger))).toBe('INVALID_EVENT: bowler "H-5" is not in the fielding lineup');
  });

  it("CK-BC-1 is keyed on the event, never on the ball: a stored mid-over ball naming another bowler, with no change, is still credited to the over's bowler on replay", () => {
    const stored = new Ledger().dots(2, "H-1", "H-2", "A-11").dots(4, "H-1", "H-2", "A-10").build();
    // the write path refuses it, as before
    expect(refusalOf(() => strict(TEN, stored))).toBe('INVALID_EVENT: over in progress belongs to "A-11"');
    // the read path folds it as it always did: the whole over is A-11's, and the card's over has one bowler
    const fine = fineOf(replay(TEN, stored));
    expect(fine.bowlerBalls).toEqual({ "A-11": 6 });
    expect([fine.prevOverBowler, fine.prevOverBowlers, fine.partOvers]).toEqual(["A-11", undefined, undefined]);
    const card = deriveCricketScorecard({ events: stored, cfg: TEN, lineups }).innings[0]!;
    expect(card.overs[0]).toMatchObject({ bowler: "A-11" });
    expect(card.overs[0]).not.toHaveProperty("bowlers");
    expect(card.bowling.map((line) => [line.person, line.legalBalls, line.maidens])).toEqual([["A-11", 6, 1]]);
  });

  it("CK-BC-1 is dropped by coarsen: the coarse ledger folds to the same totals and result", () => {
    const events = splitFirstOver().dots(6, "H-1", "H-2", "A-9").ev("cricket.innings.close", { reason: "other" }).build();
    const coarse = cricket.coarsen!(events as never).map((event, i) => makeEnvelope(i, event));
    expect(coarse.map((e) => e.type)).not.toContain("cricket.bowler.change");
    const fine = strict(TEN, events);
    const folded = strict(TEN, coarse);
    expect(folded.innings[0]).toMatchObject({ runs: fine.innings[0]!.runs, wickets: fine.innings[0]!.wickets, legalBalls: 12 });
    expect(cricket.summary(folded)).toEqual(cricket.summary(fine));
  });

  it("CK-BC-1 eligibleChangeBowlers and eligibleBowlers name exactly who the fold accepts, mid-over and at the next over", () => {
    const order = lineups.away.slots.map((slot) => slot.personId);
    // mid-over: A-9 bowled the previous over, A-11 left this one, A-10 is on
    const mid = fineOf(strict(TEN, new Ledger().dots(6, "H-1", "H-2", "A-9").dots(2, "H-2", "H-1", "A-11").change("A-10").build()));
    const changeable = eligibleChangeBowlers(order, mid, TEN.maxOversPerBowler, TEN.ballsPerOver);
    expect(changeable).toEqual(order.filter((p) => !["A-9", "A-10", "A-11"].includes(p)));
    // each answer is the fold's: every bowler is tried as the next change
    for (const person of order) {
      const events = new Ledger().dots(6, "H-1", "H-2", "A-9").dots(2, "H-2", "H-1", "A-11").change("A-10").change(person).build();
      expect(refusalOf(() => strict(TEN, events)) === null, person).toBe(changeable.includes(person));
    }
    // with no over in progress nobody is a change
    expect(eligibleChangeBowlers(order, fineOf(strict(TEN, splitFirstOver().build())), TEN.maxOversPerBowler, TEN.ballsPerOver)).toEqual([]);
    // at the next over: both bowlers of the split over are out
    const next = eligibleBowlers(order, fineOf(strict(TEN, splitFirstOver().build())), TEN.maxOversPerBowler, TEN.ballsPerOver);
    expect(next).toEqual(order.filter((p) => p !== "A-10" && p !== "A-11"));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// CK-BO-3 — the part over counts whole toward the quota, and is nobody's maiden
// ---------------------------------------------------------------------------------------------------------------------

describe("CK-BO-3 a part over counts as a whole over toward maxOversPerBowler, and neither bowler is credited a maiden for it", () => {
  /** A-11 bowls over 1 whole, A-10 over 2, A-11 two balls of over 3 before A-9 completes it, then A-10 over 4. */
  const quotaLedger = () =>
    new Ledger()
      .dots(6, "H-1", "H-2", "A-11")
      .dots(6, "H-2", "H-1", "A-10")
      .dots(2, "H-1", "H-2", "A-11")
      .change("A-9", "suspended")
      .dots(4, "H-1", "H-2", "A-9")
      .dots(6, "H-2", "H-1", "A-10");

  it("CK-BO-3 charges each bowler of a split over one whole over: A-11 has used both of two after one and a third", () => {
    const fine = fineOf(strict(TEN, quotaLedger().build()));
    expect(fine.bowlerBalls).toEqual({ "A-11": 8, "A-10": 12, "A-9": 4 });
    expect(oversUsed(fine, "A-11", 6), "1 whole + 1 part").toBe(2);
    expect(oversUsed(fine, "A-9", 6), "1 part").toBe(1);
    expect(oversUsed(fine, "A-10", 6), "2 whole").toBe(2);
    // over 5: A-11 is out of quota (floor(8 / 6) would have said 1); A-9, with one part over, may bowl
    const fifth = (bowler: string) => quotaLedger().ball({ striker: "H-1", nonStriker: "H-2", bowler }).build();
    expect(refusalOf(() => strict(TEN, fifth("A-11")))).toBe('INVALID_EVENT: bowler "A-11" has exhausted the 2-over quota');
    expect(refusalOf(() => strict(TEN, fifth("A-9")))).toBeNull();
    // the quota binds the change too: A-11, out of quota, may not come on to complete an over
    const late = quotaLedger().dots(2, "H-1", "H-2", "A-8").change("A-11").build();
    expect(refusalOf(() => strict(TEN, late))).toBe('INVALID_EVENT: bowler "A-11" has exhausted the 2-over quota');
    // with no change in the innings the count is floor(balls / bpo), as before
    const plain = fineOf(strict(TEN, new Ledger().dots(6, "H-1", "H-2", "A-11").dots(6, "H-2", "H-1", "A-10").dots(2, "H-1", "H-2", "A-11").build()));
    expect([plain.partOvers, oversUsed(plain, "A-11", 6)]).toEqual([undefined, 1]);
  });

  it("CK-BO-3 a split over that concedes nothing is nobody's maiden; an unsplit one is its bowler's", () => {
    // over 1 split A-11 / A-10, no runs; over 2 A-9, no runs
    const events = new Ledger().dots(2, "H-1", "H-2", "A-11").change("A-10").dots(4, "H-1", "H-2", "A-10").dots(6, "H-2", "H-1", "A-9").build();
    const card = deriveCricketScorecard({ events, cfg: TEN, lineups }).innings[0]!;
    const bowling = Object.fromEntries(card.bowling.map((line) => [line.person, line]));
    expect(bowling["A-11"]).toMatchObject({ legalBalls: 2, overs: "0.2", maidens: 0, runs: 0 });
    expect(bowling["A-10"]).toMatchObject({ legalBalls: 4, overs: "0.4", maidens: 0, runs: 0 });
    expect(bowling["A-9"], "control: the unsplit dot over is a maiden").toMatchObject({ legalBalls: 6, overs: "1.0", maidens: 1 });
    expect(card.overs[0]).toMatchObject({ number: 1, bowler: "A-11", bowlers: ["A-11", "A-10"], runs: 0 });
    expect(card.overs[1]).toMatchObject({ number: 2, bowler: "A-9" });
    expect(card.overs[1]).not.toHaveProperty("bowlers");
    // the player stats credit each bowler the balls they bowled
    const stats = statsOf(events);
    expect([stats["A-11"]?.balls_bowled, stats["A-10"]?.balls_bowled, stats["A-9"]?.balls_bowled]).toEqual([2, 4, 6]);
  });

  it("CK-BO-3 DLS reads the same chase whoever bowled it: a split over and its one-bowler twin decide alike", () => {
    const first = firstInnings;
    const split = first(new Ledger())
      .ball({ striker: "A-1", nonStriker: "A-2", bowler: "H-11", bat: 2 })
      .ball({ striker: "A-1", nonStriker: "A-2", bowler: "H-11", wicket: { kind: "bowled", out: "A-1", bowlerCredited: true } })
      .change("H-10", "incapacitated")
      .dots(4, "A-3", "A-2", "H-10")
      .ball({ striker: "A-2", nonStriker: "A-3", bowler: "H-9", bat: 1 })
      .ev("core.abandon", { reason: "rain" })
      .build();
    const twin = first(new Ledger())
      .ball({ striker: "A-1", nonStriker: "A-2", bowler: "H-11", bat: 2 })
      .ball({ striker: "A-1", nonStriker: "A-2", bowler: "H-11", wicket: { kind: "bowled", out: "A-1", bowlerCredited: true } })
      .dots(4, "A-3", "A-2", "H-11")
      .ball({ striker: "A-2", nonStriker: "A-3", bowler: "H-10", bat: 1 })
      .ev("core.abandon", { reason: "rain" })
      .build();
    const state = strict(DLS, split);
    const twinState = strict(DLS, twin);
    expect(state.outcome, "premise: the abandon is decided by DLS").toMatchObject({ method: "dls" });
    expect(state.outcome).toEqual(twinState.outcome);
    expect(state.margin).toEqual(twinState.margin);
    expect([state.r1, state.r2, state.revisedTarget]).toEqual([twinState.r1, twinState.r2, twinState.revisedTarget]);
    // and the wicket is H-11's, who bowled it, not H-10's
    expect(fineOf(state, 1).bowlerWickets).toEqual({ "H-11": 1 });
  });
});
