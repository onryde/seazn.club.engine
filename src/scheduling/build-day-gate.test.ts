// The tier-name guard, and the day metrics reaching the response.
//
// `solveBuild` does not return the placement service's board because the
// service says so — it compares that board against the legalised greedy seed
// with `isStrictlyBetter` and ships the SEED when the candidate does not win
// (`build.ts`, `const improved = ...`). That gate is the last thing between an
// organiser and a worse board, and it is only as good as its ordering.
//
// WHY THIS FILE EXISTS. When the day-aware rungs landed in the service
// (2026-08-13), `isStrictlyBetter` was left ranking `placed → makespanMinutes →
// idleGap → imbalance` — the retired ladder — and the `already_optimal` gate
// still keyed on a bare tier COUNT. Two silent consequences:
//
//   * the solver's `day_start` rung deliberately BUYS an earlier day start with
//     a worse idle gap (production board: 132 600 000 → 170 400 000 ms), so a
//     day-anchored board could lose the comparison and be discarded for the
//     greedy seed — the change's entire benefit thrown away on exactly the
//     boards it was written for;
//   * and a reply from a service running a DIFFERENT six-rung ladder would have
//     its `tiers_completed: 6` read as a full proof of ours, which is the live
//     hazard while two separately deployed apps disagree about the ladder.
//
// Both were found by review rather than by a test, because nothing drove a
// board where the two ladders disagree. The ORDERING itself is pinned rung by
// rung in `build-objectives.test.ts`; what this file pins is the WIRING — that
// the gate is handed a day view at all, and that the name check is real.
import { describe, expect, it } from "vitest";
import { buildSchedule, TIER_COUNT, TIER_NAMES } from "./build.ts";
import { boardMetrics, type DayView } from "./build-objectives.ts";
import type { SchedulableFixture, SlotConfig } from "./calendar.ts";
import type { SolveBuildOutcome } from "./solver-port.ts";
import { fakeSolver, resolvingSolver, silentLogger } from "./__tests__/solver-fakes.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 7, 8, 9, 0);

const config: SlotConfig & { courts: string[] } = {
  startAt: T0,
  matchMinutes: 30,
  gapMinutes: 0,
  courts: ["C1", "C2"],
  perEntrantMinRest: 0,
  window: { from: T0, to: T0 + 240 * MIN },
  tz: "Europe/London",
};

/** The measured corner (borrowed from `build-polish.test.ts`): one court, a
 *  start window only `b` can use. Greedy takes 09:00 for `a` and is left with
 *  nowhere legal for `b`, so it returns a ONE-card board; the solver places
 *  both. That gap on `placed` is what carries the solver's board past the gate,
 *  which is what makes it usable for testing what the gate MEASURES. */
const cornerConfig: SlotConfig & { courts: string[] } = {
  ...config,
  courts: ["C1"],
  sessionWindows: [{ from: T0, to: T0 + 60 * MIN }],
  constraints: {
    noBackToBack: false,
    fieldFairness: "off",
    parallelism: "mixed",
    crossPersonClash: "warn",
    startWindows: [{ target: { kind: "entrant", id: "E3" }, notAfter: T0 }],
  },
};
const cornerFixtures: SchedulableFixture[] = [
  { id: "a", roundNo: 1, home: "E1", away: "E2" },
  { id: "b", roundNo: 1, home: "E3", away: "E4" },
];

/** Two cards locked onto the one 09:00 row: nothing for the solver to place and
 *  nothing to improve, so the run reaches the `!improved` branch — the only
 *  place `already_optimal` is reachable from. */
const optimal: SchedulableFixture[] = [
  { id: "a", roundNo: 1, home: "E1", away: "E2", locked: { court: "C1", startAt: T0 } },
  { id: "b", roundNo: 1, home: "E3", away: "E4", locked: { court: "C2", startAt: T0 } },
];

const reply = (
  assignments: SolveBuildOutcome["assignments"],
  names: readonly string[] = TIER_NAMES,
): SolveBuildOutcome => ({
  assignments,
  status: "OPTIMAL",
  tiersCompleted: TIER_COUNT,
  objectiveValues: names.map((name, i) => ({ name, value: i })),
  elapsedMs: 5,
  wallExhausted: false,
});

const stub = (outcome: SolveBuildOutcome) => resolvingSolver(outcome);

describe("the day metrics reach the response", () => {
  it("hands the day view to boardMetrics, so a shipped board reports real day metrics", async () => {
    // `boardMetrics` day fields are 0 unless a `DayView` is passed, and 0 is a
    // legal value — an unwired call therefore does not throw or fail a type
    // check, it silently reports every board as touching no days at all. A
    // shipped board carrying non-zero day metrics is the observable proof that
    // the view reached the metric call.
    //
    // REPORTED, NOT RANKED. `isStrictlyBetter` deliberately does not read these
    // — see its own note, and the C2 follow-up in the release-2 index for why
    // mirroring the solver's ladder into the acceptance gate is a separate,
    // still-open task rather than something this change does.
    const solve = stub(
      reply([
        { fixtureId: "b", court: "C1", startAtMs: T0 },
        { fixtureId: "a", court: "C1", startAtMs: T0 + 30 * MIN },
      ]),
    );

    const out = await buildSchedule({ fixtures: cornerFixtures, config: cornerConfig, solve, log: silentLogger });

    expect(out.engine).toBe("optimized");
    expect(out.metrics.placed).toBe(2);
    // Both cards are on one calendar day, 09:00 and 09:30 London.
    expect(out.metrics.daysUsed).toBe(1);
    expect(out.metrics.daySpanMinutes).toBe(60);
    expect(out.metrics.dayStartOffsetMinutes).toBe(0);
  });
});

describe("already_optimal requires OUR ladder, not merely a matching count", () => {
  it("refuses the claim when the reply names a different ladder of the same length", async () => {
    // The deploy hazard as a test. A COUNT cannot tell one ladder from another,
    // and the two apps ship separately. This reply is fully proved and
    // correctly counted, and names the RETIRED ladder with `makespan` where
    // `days` belongs.
    const solve = stub(
      reply([], ["placed", "makespan", "idle_gap", "imbalance", "spare_one", "spare_two"]),
    );

    const out = await buildSchedule({ fixtures: optimal, config, frozen: ["a", "b"], solve, log: silentLogger });

    expect(out.status).not.toBe("already_optimal");
    // The count still says six, which is exactly why the count is not enough.
    expect(out.tiersCompleted).toBe(TIER_COUNT);
  });

  it("refuses the claim when the reply is short a rung it never named", async () => {
    // The other shape of the same hazard: right names, too few of them. A
    // service that proved four of six rungs must not be read as a full ladder.
    const solve = stub(reply([], TIER_NAMES.slice(0, 4)));

    const out = await buildSchedule({ fixtures: optimal, config, frozen: ["a", "b"], solve, log: silentLogger });

    expect(out.status).not.toBe("already_optimal");
  });

  it("still claims already_optimal on our own ladder", async () => {
    // Without this the two above pass against a gate that simply never fires.
    const solve = stub(reply([]));

    const out = await buildSchedule({ fixtures: optimal, config, frozen: ["a", "b"], solve, log: silentLogger });

    expect(out.status).toBe("already_optimal");
    expect(out.tiersCompleted).toBe(TIER_COUNT);
  });
});

// ---------------------------------------------------------------------------
// The acceptance gate itself (2026-08-13). The defect this file's own header
// PREDICTED, now driven.
// ---------------------------------------------------------------------------

/** `config.startAt` IS NOT THE SOLVER'S FLOOR, and that is the whole fixture.
 *
 *  The grid opens at `window.from`; greedy's cursor opens at
 *  `max(config.startAt, window.notBefore)` (`calendar.ts:759`). Set the window
 *  to midnight and `startAt` to 09:00 and the two producers legitimately see
 *  different first ticks — which is exactly what production does, where
 *  `applyWindow` floors the window at START-OF-DAY. Greedy's board then sits
 *  nine hours past the day's opening slot and the solver's does not.
 *
 *  The two boards are then IDENTICAL on every term `isStrictlyBetter` ranks —
 *  same `placed`, same 30-minute makespan, same zero idle gap, same zero court
 *  imbalance — and differ only on `dayStartOffsetMinutes`, a rung the solver
 *  optimises and that comparison cannot see. Measured on the real service in
 *  `schedule-polish-current`: 0 against 540. */
const dayOpenConfig: SlotConfig & { courts: string[] } = {
  ...config,
  tz: "UTC",
  startAt: Date.UTC(2026, 7, 8, 9, 0),
  window: { from: Date.UTC(2026, 7, 8, 0, 0), to: Date.UTC(2026, 7, 8, 23, 0) },
};
const DAY_OPEN = Date.UTC(2026, 7, 8, 0, 0);

/** Four distinct entrants, so no participant plays twice and `worstIdleGap` is
 *  0 on BOTH boards by construction rather than by luck — one fewer term that
 *  could accidentally separate them. */
const twoCards: SchedulableFixture[] = [
  { id: "a", roundNo: 1, home: "E1", away: "E2" },
  { id: "b", roundNo: 1, home: "E3", away: "E4" },
];

describe("the gate does not discard a board the service proved optimal", () => {
  it("ships a proved board that beats the seed only on a rung isStrictlyBetter cannot see", async () => {
    // THE REGRESSION. Before this change the gate ranked
    // `placed → makespan → idleGap → imbalance`, so this reply — better on
    // `day_start`, tied on all four of those — lost to the greedy seed and was
    // thrown away. `engine` is the observable: "greedy" means the proved board
    // was discarded.
    const solve = stub(
      reply([
        { fixtureId: "a", court: "C1", startAtMs: DAY_OPEN },
        { fixtureId: "b", court: "C2", startAtMs: DAY_OPEN },
      ]),
    );

    const out = await buildSchedule({ fixtures: twoCards, config: dayOpenConfig, solve, log: silentLogger });

    expect(out.engine).toBe("optimized");
    expect(out.status).toBe("ok");
    expect(out.assignments.map((a) => a.startAt)).toEqual([DAY_OPEN, DAY_OPEN]);
    // The board that shipped opens the day it is on — the rung it won.
    expect(out.metrics.dayStartOffsetMinutes).toBe(0);
  });

  it("is a run the OLD ordering could not have separated", async () => {
    // The premise of the spec above, asserted rather than assumed, so it cannot
    // quietly become a test about a board that simply wins on makespan too.
    // This run takes the greedy fallback, so `out.metrics` IS the seed's.
    const solve = fakeSolver(() => Promise.reject(new Error("no service")));

    const seed = await buildSchedule({ fixtures: twoCards, config: dayOpenConfig, solve, log: silentLogger });

    expect(seed.engine).toBe("greedy");
    // Greedy opens at `startAt`, nine hours after the day's first slot.
    expect(seed.metrics.dayStartOffsetMinutes).toBe(0); // no DayView on the seed's own metrics
    expect(seed.assignments.map((a) => a.startAt)).toEqual([
      dayOpenConfig.startAt,
      dayOpenConfig.startAt,
    ]);
    // The four terms the retired comparison ranked, all tied against the
    // proved board above — which is why it could only ever have kept the seed.
    expect(seed.metrics.placed).toBe(2);
    expect(seed.metrics.makespanMinutes).toBe(30);
    expect(seed.metrics.worstIdleGapMinutes).toBe(0);
    expect(seed.metrics.courtImbalanceMinutes).toBe(0);
  });

  it("keeps the seed when the proved board only rearranges it", async () => {
    // THE OTHER DIRECTION, and it is not hypothetical: on
    // `schedule-solver-telemetry`'s one-fixture board the service returns a
    // bare COURT SWAP — same instant, every rung byte-identical. Trusting the
    // proof must not mean shipping churn, so the tie is decided on the LADDER:
    // nothing to gain, keep the board the organiser already had.
    //
    // Board IDENTITY is the wrong predicate here and this spec is what says so.
    // These two boards are not the same board — `a` and `b` swap courts — so a
    // gate comparing assignments ships this reply, reports `ok`, and moves
    // every card on a board nothing improved.
    const solve = stub(
      reply([
        { fixtureId: "a", court: "C2", startAtMs: dayOpenConfig.startAt },
        { fixtureId: "b", court: "C1", startAtMs: dayOpenConfig.startAt },
      ]),
    );

    const out = await buildSchedule({ fixtures: twoCards, config: dayOpenConfig, solve, log: silentLogger });

    expect(out.engine).toBe("greedy");
    expect(out.status).toBe("already_optimal");
    // Greedy's own courts, untouched — the swap did not ship.
    expect(out.assignments.find((a) => a.fixtureId === "a")?.court).toBe("C1");
  });

  it("still refuses a proved board that places fewer than the seed", async () => {
    // D6's floor, unchanged and checked before the proof in every arm: no
    // amount of proof outranks placing fewer fixtures.
    const solve = stub(reply([{ fixtureId: "a", court: "C1", startAtMs: DAY_OPEN }]));

    const out = await buildSchedule({ fixtures: twoCards, config: dayOpenConfig, solve, log: silentLogger });

    expect(out.engine).toBe("greedy");
    expect(out.metrics.placed).toBe(2);
  });

  it("reports moved 0 for a BUILD, even now that the solver's board ships", async () => {
    // `moved`'s baseline used to be greedy's own seed, which read as zero only
    // because every no-`current` exit RETURNED that seed. The spec above breaks
    // that coincidence: the solver's board ships, and against an invented
    // baseline this would report "2 matches moved" on a fresh full pass — the
    // meaningless number R20 warns about, and the one
    // `schedule-polish-current`'s "does not anchor a BUILD" spec exists to
    // refuse. Nothing to have moved FROM is zero, exactly as `lost` already is.
    const solve = stub(
      reply([
        { fixtureId: "a", court: "C1", startAtMs: DAY_OPEN },
        { fixtureId: "b", court: "C2", startAtMs: DAY_OPEN },
      ]),
    );

    const out = await buildSchedule({ fixtures: twoCards, config: dayOpenConfig, solve, log: silentLogger });

    expect(out.engine).toBe("optimized");
    expect(out.moved).toBe(0);
    expect(out.lost).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The seventh rung (2026-11-04, owner ruling; seazn.club W3 X-SW-29):
// `day_rank`, the earliest-day tie-break, LAST in the service's ladder.
//
// Every rung above it is blind to a whole board sliding one calendar day, so
// with no end date (seazn.club's `boundSolverWindow` adds a day of slack) the
// service held two proved optima and returned whichever a search worker found
// first: the round on the start day, or at midnight of the next. The service
// now proves the earliest. What the engine owes: the SAME ladder by name (the
// `provedOurLadder` check is exact, so a 6-name engine against a 7-rung service
// never trusts a proof), and `day_rank` in `ladderTied`, or a proved board
// that is better ONLY on the new rung is called a tie and thrown away.
// ---------------------------------------------------------------------------

describe("the ladder is the placement service's, rung for rung", () => {
  it("names the service's seven rungs in its order", () => {
    // Typed, not derived: the source of truth is the OTHER repo's
    // `placement/objective.py` `TIER_ORDER`, and `provedOurLadder` compares
    // these strings to the reply's exactly.
    expect(TIER_NAMES).toEqual(["placed", "days", "day_span", "day_start", "idle_gap", "imbalance", "day_rank"]);
    expect(TIER_COUNT).toBe(7);
  });

  it("does not trust a reply that proved the six-rung ladder this engine used to share", async () => {
    // The deploy-skew case, from the side this repo owns: a service that has not
    // shipped the seventh rung proves six names. Counted as fewer than
    // `TIER_COUNT`, so not a proof of ours — the D6 comparator decides instead.
    const sixRung = TIER_NAMES.slice(0, 6);
    const solve = resolvingSolver({ ...reply([], sixRung), tiersCompleted: sixRung.length });

    const out = await buildSchedule({ fixtures: optimal, config, frozen: ["a", "b"], solve, log: silentLogger });

    expect(out.status).not.toBe("already_optimal");
  });
});

const DAY_0 = Date.UTC(2026, 7, 8, 0, 0);
const DAY_1 = Date.UTC(2026, 7, 9, 0, 0);

/** Greedy's cursor opens at `startAt` — here the SECOND day's midnight — while
 *  the window (so the grid) opens at the first day's. Greedy's board on day 1
 *  and the solver's same board on day 0 then tie on every rung above
 *  `day_rank`: one day, a 30-minute span, each day opened by its first card
 *  (`dayStartOffsetMinutes` 0), no idle (four distinct entrants), no imbalance
 *  (one card per court). That is X-SW-29's pair with the roles reversed: here
 *  the seed is the late board, so the one the gate must ship is the solver's. */
const twoDayConfig: SlotConfig & { courts: string[] } = {
  ...config,
  tz: "UTC",
  startAt: DAY_1,
  window: { from: DAY_0, to: DAY_1 + 23 * 60 * MIN },
};

/** Calendar days of UTC from DAY_0, opening at midnight: the view `build.ts`
 *  builds for `twoDayConfig`'s grid (dense, in time order, ticks from 00:00). */
const utcDays: DayView = {
  dayOf: (startAt) => Math.floor((startAt - DAY_0) / (24 * 60 * MIN)),
  openOf: (d) => DAY_0 + d * 24 * 60 * MIN,
};

describe("ladderTied reads day_rank", () => {
  it("is a run where the seed and the day-0 board differ ONLY on day_rank", async () => {
    // The premise of the next spec, asserted: without it that spec could pass
    // on a board that also wins `day_start` or `days`.
    const seed = await buildSchedule({
      fixtures: twoCards,
      config: twoDayConfig,
      solve: fakeSolver(() => Promise.reject(new Error("no service"))),
      log: silentLogger,
    });
    expect(seed.engine).toBe("greedy");
    expect(seed.assignments.map((a) => a.startAt)).toEqual([DAY_1, DAY_1]);

    const day0 = seed.assignments.map((a) => ({ ...a, startAt: a.startAt - (DAY_1 - DAY_0), endAt: a.endAt - (DAY_1 - DAY_0) }));
    const late = boardMetrics(seed.assignments, twoDayConfig.courts, 2, utcDays);
    const early = boardMetrics(day0, twoDayConfig.courts, 2, utcDays);
    expect(late.dayRankSum).toBe(2);
    expect(early.dayRankSum).toBe(0);
    const { dayRankSum: _l, ...lateRest } = late;
    const { dayRankSum: _e, ...earlyRest } = early;
    expect(earlyRest).toEqual(lateRest);
  });

  it("ships a proved board that beats the seed only on day_rank", async () => {
    // THE ENGINE HALF OF THE FIX. With `day_rank` missing from `ladderTied`
    // this reply reads as a tie, the gate keeps greedy's day-1 board, and calls
    // it `already_optimal` — the late round shipped by the very rung meant to
    // stop it.
    const solve = stub(
      reply([
        { fixtureId: "a", court: "C1", startAtMs: DAY_0 },
        { fixtureId: "b", court: "C2", startAtMs: DAY_0 },
      ]),
    );

    const out = await buildSchedule({ fixtures: twoCards, config: twoDayConfig, solve, log: silentLogger });

    expect(out.engine).toBe("optimized");
    expect(out.status).toBe("ok");
    expect(out.assignments.map((a) => a.startAt)).toEqual([DAY_0, DAY_0]);
    expect(out.metrics.dayRankSum).toBe(0);
  });

  it("still keeps the seed when the proved board ties it on day_rank too", async () => {
    // The cleared pair: the same courts swapped, on the seed's own day. Every
    // rung ties, `day_rank` included, so nothing improved and nothing ships.
    const solve = stub(
      reply([
        { fixtureId: "a", court: "C2", startAtMs: DAY_1 },
        { fixtureId: "b", court: "C1", startAtMs: DAY_1 },
      ]),
    );

    const out = await buildSchedule({ fixtures: twoCards, config: twoDayConfig, solve, log: silentLogger });

    expect(out.engine).toBe("greedy");
    expect(out.status).toBe("already_optimal");
    expect(out.assignments.map((a) => a.startAt)).toEqual([DAY_1, DAY_1]);
  });
});
