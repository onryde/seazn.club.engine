import { describe, expect, it } from "vitest";
import { boardMetrics, isStrictlyBetter, type DayView } from "./build-objectives.ts";
import type { Assignment } from "./calendar.ts";

const T0 = Date.UTC(2026, 7, 8, 9, 0);
const MIN = 60_000;

const card = (id: string, court: string, startMin: number, durMin = 30, entrants: string[] = [], people: string[] = []): Assignment => ({
  fixtureId: id,
  court,
  startAt: T0 + startMin * MIN,
  endAt: T0 + (startMin + durMin) * MIN,
  entrants,
  people,
});

describe("boardMetrics", () => {
  it("reports zero for an empty board", () => {
    expect(boardMetrics([], ["C1"], 0)).toEqual({
      daysUsed: 0, daySpanMinutes: 0, dayStartOffsetMinutes: 0,
      makespanMinutes: 0, worstIdleGapMinutes: 0, courtImbalanceMinutes: 0, dayRankSum: 0, placed: 0, total: 0,
    });
  });

  it("makespan spans earliest start to latest end", () => {
    const m = boardMetrics([card("a", "C1", 0), card("b", "C1", 60)], ["C1"], 2);
    expect(m.makespanMinutes).toBe(90);
  });

  it("worst idle gap is measured per entrant, between consecutive matches", () => {
    const m = boardMetrics(
      [card("a", "C1", 0, 30, ["E1"]), card("b", "C2", 120, 30, ["E1"])],
      ["C1", "C2"], 2,
    );
    expect(m.worstIdleGapMinutes).toBe(90); // 30 -> 120
  });

  it("counts a person's gap as well as an entrant's", () => {
    const m = boardMetrics(
      [card("a", "C1", 0, 30, [], ["p1"]), card("b", "C2", 200, 30, [], ["p1"])],
      ["C1", "C2"], 2,
    );
    expect(m.worstIdleGapMinutes).toBe(170);
  });

  it("never merges an entrant with a person that shares its id string", () => {
    // `entrants` is EntrantId[] and `people` is string[], but both are plain
    // strings at runtime, so the `e:` / `p:` key prefixes inside boardMetrics
    // are load-bearing. Drop them and these two cards collapse into ONE
    // participant chain that reports a fabricated 470-minute wait.
    const m = boardMetrics(
      [card("a", "C1", 0, 30, ["X1"]), card("b", "C2", 500, 30, [], ["X1"])],
      ["C1", "C2"], 2,
    );
    expect(m.worstIdleGapMinutes).toBe(0);
  });

  it("is zero when nobody plays twice", () => {
    const m = boardMetrics([card("a", "C1", 0, 30, ["E1"]), card("b", "C2", 500, 30, ["E2"])], ["C1", "C2"], 2);
    expect(m.worstIdleGapMinutes).toBe(0);
  });

  it("court imbalance counts an unused configured court as zero minutes", () => {
    const m = boardMetrics([card("a", "C1", 0, 30), card("b", "C1", 60, 30)], ["C1", "C2"], 2);
    expect(m.courtImbalanceMinutes).toBe(60);
  });

  it("counts a court the board uses but the config omits", () => {
    // Two courts must reach `mins` for this to constrain anything: the
    // configured-but-unused C1 at 0, and the unconfigured-but-used CX at 30.
    // A version that only ever measured the configured courts would see
    // [0] and report 0; one that only measured used courts would see [30]
    // and also report 0. Only counting BOTH gives 30.
    const m = boardMetrics([card("a", "CX", 0, 30)], ["C1"], 1);
    expect(m.courtImbalanceMinutes).toBe(30);
  });
});

// The placement service's LAST rung (2026-11-04, owner ruling, seazn.club W3
// X-SW-29): `day_rank`, the earliest-day tie-break. Every rung above it is blind
// to a whole board sliding one calendar day, so a lattice with a spare empty day
// held two proved optima and the search race picked one. The service minimises
// the sum, over every match with a day, of that day's rank in time order; this is
// the same number measured on a board, for `ladderTied`'s equality.
describe("boardMetrics.dayRankSum", () => {
  const DAY = 24 * 60;
  /** Days from T0's UTC midnight, each opening at its midnight — the shape
   *  `build.ts`'s view has, with a dense index in time order. A start before
   *  T0's day reads `-1`, which is `build.ts`'s `OFF_GRID_DAY`. */
  const DAY0 = Date.UTC(2026, 7, 8, 0, 0);
  const view: DayView = {
    dayOf: (startAt) => (startAt < DAY0 ? -1 : Math.floor((startAt - DAY0) / (DAY * MIN))),
    openOf: (d) => DAY0 + d * DAY * MIN,
  };

  it("sums each match's day rank: 0 + 1 + 2 + 2 = 5", () => {
    const m = boardMetrics(
      [card("a", "C1", 0), card("b", "C1", DAY), card("c", "C1", 2 * DAY), card("d", "C2", 2 * DAY)],
      ["C1", "C2"], 4, view,
    );
    expect(m.dayRankSum).toBe(5);
  });

  it("is 0 for a board wholly on the first day, and grows by one per match per day later", () => {
    // The X-SW-29 pair: the same two-card board on day 0 and on day 1. Every
    // other metric is identical between them, which is the whole defect.
    const early = boardMetrics([card("a", "C1", 0), card("b", "C2", 0)], ["C1", "C2"], 2, view);
    const late = boardMetrics([card("a", "C1", DAY), card("b", "C2", DAY)], ["C1", "C2"], 2, view);
    expect(early.dayRankSum).toBe(0);
    expect(late.dayRankSum).toBe(2);
    const { dayRankSum: _e, ...earlyRest } = early;
    const { dayRankSum: _l, ...lateRest } = late;
    expect(lateRest).toEqual(earlyRest);
  });

  it("counts nothing for a match on no grid day (OFF_GRID_DAY), as the service skips a pin with no day", () => {
    // 23:00 the evening before day 0: on no day of the view, so `dayOf` says -1.
    // Summing that raw would report 0 here and hide the day-1 match.
    const m = boardMetrics([card("pin", "C1", -10 * 60), card("a", "C2", DAY)], ["C1", "C2"], 2, view);
    expect(view.dayOf(T0 - 10 * 60 * MIN)).toBe(-1);
    expect(m.dayRankSum).toBe(1);
  });

  it("is 0 with no view: one day, the placer's own answer without a zone", () => {
    const m = boardMetrics([card("a", "C1", 0), card("b", "C1", 3 * DAY)], ["C1"], 2);
    expect(m.daysUsed).toBe(1);
    expect(m.dayRankSum).toBe(0);
  });
});

describe("isStrictlyBetter", () => {
  const base = {
    daysUsed: 3, daySpanMinutes: 300, dayStartOffsetMinutes: 60,
    makespanMinutes: 100, worstIdleGapMinutes: 50, courtImbalanceMinutes: 20, dayRankSum: 7, placed: 10, total: 10,
  };

  it("prefers more placed above everything", () => {
    expect(isStrictlyBetter({ ...base, placed: 11, makespanMinutes: 999 }, base)).toBe(true);
  });

  // The ORDERING here is unchanged by the day-aware rungs, deliberately — see
  // `isStrictlyBetter`'s note. Mirroring the solver's ladder into this
  // comparison was tried and reverted: the seed it compares against is
  // greedy's, and greedy is rule-blind, so ranking the day terms made the gate
  // prefer a rule-BREAKING board that packed from the day's first tick. Who
  // decides between a solver board and a greedy seed now lives in `build.ts`,
  // where legality and the solver's own proof come first.

  it("prefers a shorter makespan over a fairer board", () => {
    expect(isStrictlyBetter({ ...base, makespanMinutes: 90, worstIdleGapMinutes: 999 }, base)).toBe(true);
    expect(isStrictlyBetter({ ...base, makespanMinutes: 110, worstIdleGapMinutes: 0 }, base)).toBe(false);
  });

  it("does NOT rank the day metrics — they are reported, not compared", () => {
    // A board that is better on every day term and worse on nothing the
    // comparison reads is still not "strictly better" here. If this ever
    // starts passing, the ladder has been mirrored back into the gate and the
    // rule-blind-seed problem has come with it.
    expect(
      isStrictlyBetter(
        { ...base, daysUsed: 1, daySpanMinutes: 1, dayStartOffsetMinutes: 0, dayRankSum: 0 },
        base,
      ),
    ).toBe(false);
    // ...and a board that is WORSE on every day term still wins on makespan.
    expect(
      isStrictlyBetter(
        { ...base, daysUsed: 99, daySpanMinutes: 999, dayStartOffsetMinutes: 999, dayRankSum: 999, makespanMinutes: 90 },
        base,
      ),
    ).toBe(true);
  });

  it("prefers a fairer board over a balanced one", () => {
    expect(isStrictlyBetter({ ...base, worstIdleGapMinutes: 40, courtImbalanceMinutes: 999 }, base)).toBe(true);
  });


  it("is false for an identical board", () => {
    expect(isStrictlyBetter(base, base)).toBe(false);
  });
});
