// S2-4 (2026-11-07) — the hand strike swap (CK-SS-1, ruling 277; S2-4 phone design ruling 76), read through the real fold,
// the scorecard, the player stats and DLS.
//
// single-sport: every fact here is a cricket Law (who is on strike); no other sport has them.
import { describe, expect, it } from "vitest";
import { EngineError } from "../../core/errors.ts";
import { foldMatch, type EventEnvelope } from "../../core/events.ts";
import type { LineupPair } from "../../core/types.ts";
import { aggregatePlayerStats } from "../../stats/stats.ts";
import { makeEnvelope } from "../../testkit/index.ts";
import {
  cricket,
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
