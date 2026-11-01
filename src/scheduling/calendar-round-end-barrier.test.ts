// X-SW-31 (W3 T10b, controller ruling 2026-10-31): a Swiss round may start only after the previous round has ENDED.
//
// Round order (H6, `roundOrderConflicts`) is a START floor: on one day a later round may start at the same instant as
// an earlier one, so with spare courts rounds 1 and 2 run side by side. A round robin can do that (its pairings are fixed
// in advance). A Swiss round cannot: round r+1 is paired from round r's results, so no board of round r+1 may start
// before the LAST board of round r has ended (rulebook §3; FIDE C.04.1). A sequence opts in with `roundBarrier: "end"`;
// absent (or "start") is today's start floor, unchanged.
//
// Scheduling is sport-agnostic (no sport module is read here), so there is no sport registry to sweep.
//
// Every expected time below is hand-computed in the comment beside it, from the placer's documented rule (earliest
// start, courts tried in order, the first strictly-earliest court wins) and the barrier itself, never read back from
// the code under test. T0 = 2026-08-08 09:00Z (10:00 in Europe/London); every case sits on that one local day.
import { describe, expect, it } from "vitest";
import {
  deltaConflicts,
  isBlockingConflict,
  roundOrderConflicts,
  slotFixtures,
  validateAssignments,
  type Assignment,
  type SchedulableFixture,
  type SlotConfig,
} from "./calendar.ts";
import { buildSchedule, TIER_COUNT, TIER_NAMES } from "./build.ts";
import { SchedulingConstraints } from "./constraints.ts";
import type { SolveBuildInput, SolveBuildOutcome } from "./solver-port.ts";
import { fakeSolver, recordingLogger, resolvingSolver, silentLogger, unavailableSolver } from "./__tests__/solver-fakes.ts";
import { mulberry32 } from "../core/rng.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 7, 8, 9, 0);
const TZ = "Europe/London";

type Cfg = SlotConfig & { courts: string[] };

const cfg = (over: Partial<Cfg> = {}): Cfg => ({
  startAt: T0,
  matchMinutes: 30,
  gapMinutes: 0,
  courts: ["C1", "C2", "C3", "C4"],
  perEntrantMinRest: 0,
  tz: TZ,
  // A window on every case: `buildSchedule` refuses a lattice that cannot reach the fixtures (build.test.ts's own cfg
  // says why), and the placer ignores it.
  window: { from: T0, to: T0 + 600 * MIN },
  ...over,
});

/** A Swiss round shell: TBD v TBD, the shape every Swiss round after the first has when it is scheduled (and the shape
 *  CP-SAT refuses, so production schedules it with the greedy placer). Division D1, stage S1 unless told otherwise. */
const shell = (id: string, roundNo: number, over: Partial<SchedulableFixture> = {}): SchedulableFixture => ({
  id,
  roundNo,
  divisionId: "D1",
  stageId: "S1",
  ...over,
});

const END = { roundBarrier: "end" } as const;

/** `{fixtureId: "court@+minutes"}` — a board in the units the hand derivations use. */
const slots = (board: readonly Assignment[]): Record<string, string> =>
  Object.fromEntries(board.map((a) => [a.fixtureId, `${a.court}@+${(a.startAt - T0) / MIN}`]));

const orderRows = (board: readonly Assignment[], config: Cfg) =>
  validateAssignments(board, config).filter((c) => c.reason === "order");

/** A hand-built verifier row: D1/S1, `endAt` given explicitly so a long board needs no placer. */
const row = (
  fixtureId: string,
  roundNo: number,
  court: string,
  fromMin: number,
  toMin: number,
  over: Partial<Assignment> = {},
): Assignment => ({
  fixtureId,
  court,
  startAt: T0 + fromMin * MIN,
  endAt: T0 + toMin * MIN,
  entrants: [],
  people: [],
  divisionId: "D1",
  stageId: "S1",
  roundNo,
  ...over,
});

const ROUND_TWO_OVER_ONE = ["r1-a", "r1-b", "r1-c", "r2-a", "r2-b"] as const;

describe("X-SW-31 a Swiss round starts only after the previous round ends", () => {
  it("X-SW-31 empty case first: a sequence with no roundBarrier is today's start floor — rounds 1 and 2 may overlap on spare courts", () => {
    // Round 1: three shells, round 2: two, four courts, 30-minute boards, nothing else.
    //   r1-a C1@+0, r1-b C2@+0 (C1 busy until +30), r1-c C3@+0;
    //   r2-a C4@+0 — the spare court, at the SAME instant round 1 starts (a start tie, legal under the start floor);
    //   r2-b C1@+30 (every court's earliest is +30 by then; C1 is tried first).
    const fixtures = ROUND_TWO_OVER_ONE.map((id) => shell(id, Number(id[1])));
    const config = cfg();
    const { assignments } = slotFixtures({ fixtures, config });
    expect(slots(assignments)).toEqual({ "r1-a": "C1@+0", "r1-b": "C2@+0", "r1-c": "C3@+0", "r2-a": "C4@+0", "r2-b": "C1@+30" });
    // The overlap is real: round 2 starts before round 1's boards end. That is what the barrier exists to stop, and
    // the start floor allows it: no order row.
    const r1End = Math.max(...assignments.filter((a) => a.roundNo === 1).map((a) => a.endAt));
    const r2Start = Math.min(...assignments.filter((a) => a.roundNo === 2).map((a) => a.startAt));
    expect(r2Start).toBeLessThan(r1End);
    expect(orderRows(assignments, config)).toEqual([]);
    // An explicit "start" is the absent value, placement for placement.
    const explicit = slotFixtures({ fixtures: fixtures.map((f) => ({ ...f, roundBarrier: "start" as const })), config });
    expect(slots(explicit.assignments)).toEqual(slots(assignments));
    expect(orderRows(explicit.assignments, config)).toEqual([]);
  });

  it("X-SW-31 an end-barrier sequence: round 2 never starts before round 1's LAST board ends (greedy placer)", async () => {
    // (i) The same five shells, flagged "end". Round 1 as before (C1-C3 @+0, ending +30). Round 2 may not start before
    //     +30: r2-a C1@+30 (C1 first), r2-b C2@+30 (C1 now busy +30..+60).
    const plain = ROUND_TWO_OVER_ONE.map((id) => shell(id, Number(id[1]), END));
    const plainBoard = slotFixtures({ fixtures: plain, config: cfg() }).assignments;
    expect(slots(plainBoard)).toEqual({ "r1-a": "C1@+0", "r1-b": "C2@+0", "r1-c": "C3@+0", "r2-a": "C1@+30", "r2-b": "C2@+30" });

    // (ii) One LATE board. The placer has one match length, so the "long" board is a late one: round 1 is seated (it
    //      is paired at Start) and E5's start window opens at +20.
    //   r1-a (E1-E2) C1@+0, r1-b (E3-E4) C2@+0;
    //   r1-c (E5-E6) ready +20: C1 and C2 are busy until +30, C3 is free at +20 → C3@+20, ending +50;
    //   r2-a: ready = max(round 1 end) = +50 → C1@+50 (free since +30);
    //   r2-b: C1 busy +50..+80, C2 free at +50 → C2@+50. min(round 2 start) = +50 = max(round 1 end): a tie, legal.
    const late: SchedulableFixture[] = [
      shell("r1-a", 1, { home: "E1", away: "E2", ...END }),
      shell("r1-b", 1, { home: "E3", away: "E4", ...END }),
      shell("r1-c", 1, { home: "E5", away: "E6", ...END }),
      shell("r2-a", 2, END),
      shell("r2-b", 2, END),
    ];
    const config = cfg({
      constraints: SchedulingConstraints.parse({
        startWindows: [{ target: { kind: "entrant", id: "E5" }, notBefore: T0 + 20 * MIN }],
      }),
    });
    const expected = { "r1-a": "C1@+0", "r1-b": "C2@+0", "r1-c": "C3@+20", "r2-a": "C1@+50", "r2-b": "C2@+50" };
    const { assignments } = slotFixtures({ fixtures: late, config });
    expect(slots(assignments)).toEqual(expected);
    const r1End = Math.max(...assignments.filter((a) => a.roundNo === 1).map((a) => a.endAt));
    const r2Start = Math.min(...assignments.filter((a) => a.roundNo === 2).map((a) => a.startAt));
    expect(r1End).toBe(T0 + 50 * MIN);
    expect(r2Start).toBeGreaterThanOrEqual(r1End);
    expect(orderRows(assignments, config)).toEqual([]);

    // The production road: Swiss shells are refused by CP-SAT, so `buildSchedule` answers with the greedy board.
    const built = await buildSchedule({ fixtures: late, config, solve: unavailableSolver, log: silentLogger });
    expect(built.engine).toBe("greedy");
    expect(slots(built.assignments)).toEqual(expected);
    expect(built.conflicts.filter((c) => c.reason === "order")).toEqual([]);
  });

  it("X-SW-31 the verifier flags an end-barrier violation, blamed on the later round (round_order_end)", () => {
    // Round 1: a1 C1 +0..+30 and a2 C2 +0..+90 (the long board). Round 2: b1 C3 +60..+90 starts 30 minutes before a2
    // ends; b2 C1 +90..+120 starts exactly as a2 ends (a tie, legal). Every start is on one day and no round-2 board
    // starts before a round-1 board starts, so the start floor raises nothing: the one row is the end barrier's, on b1.
    const board = [
      row("a1", 1, "C1", 0, 30, END),
      row("a2", 1, "C2", 0, 90, END),
      row("b1", 2, "C3", 60, 90, END),
      row("b2", 2, "C1", 90, 120, END),
    ];
    const rows = orderRows(board, cfg());
    expect(rows).toEqual([
      {
        fixtureId: "b1",
        reason: "order",
        direct: true,
        rule: "H6",
        // The two rounds only: the measured size (b1 starts 30 minutes before a2 ends) rides outside the identity.
        details: { kind: "round_order_end", roundNo: 2, otherRoundNo: 1 },
        shortfallMinutes: 30,
      },
    ]);
    // Blocking, so the apply gate and the build gate refuse to introduce one.
    expect(rows.every(isBlockingConflict)).toBe(true);
    // The differential: the same board as a start-floor sequence is clean.
    expect(orderRows(board.map(({ roundBarrier: _drop, ...a }) => a), cfg())).toEqual([]);
  });

  it("X-SW-31 start == end is legal (tie)", () => {
    // Verifier: round 1 ends at +30; a round-2 board starting at +30 is legal, one starting at +29 is not.
    const tie = [row("a", 1, "C1", 0, 30, END), row("b", 2, "C2", 30, 60, END)];
    expect(orderRows(tie, cfg())).toEqual([]);
    const early = [row("a", 1, "C1", 0, 30, END), row("b", 2, "C2", 29, 59, END)];
    expect(orderRows(early, cfg()).map((c) => [c.details, c.shortfallMinutes])).toEqual([
      [{ kind: "round_order_end", roundNo: 2, otherRoundNo: 1 }, 1],
    ]);

    // Placer, the upper side of the same tie: round 2 is pinned at C1@+30, so the movable round-1 board must END by
    // +30. Starting at +0 it ends exactly at +30 — legal. C1@+0 touches the pin without overlapping it.
    const fixtures = [shell("p2", 2, { ...END, locked: { court: "C1", startAt: T0 + 30 * MIN } }), shell("m1", 1, END)];
    const config = cfg({ courts: ["C1", "C2"] });
    const { assignments, conflicts } = slotFixtures({ fixtures, config });
    expect(slots(assignments)).toEqual({ p2: "C1@+30", m1: "C1@+0" });
    expect(conflicts.filter((c) => c.reason === "no_slot")).toEqual([]);
    expect(orderRows(assignments, config)).toEqual([]);
  });

  it("X-SW-31 pin-pin exempt; pin-movable still constrained", () => {
    const config = cfg();
    // Verifier. A pinned round-1 board +0..+30 and a pinned round-2 board at +10: neither can move, so the pair is
    // exempt, exactly as the start floor exempts it.
    const pinPin = [row("a", 1, "C1", 0, 30, { ...END, movable: false }), row("b", 2, "C2", 10, 40, { ...END, movable: false })];
    expect(orderRows(pinPin, config)).toEqual([]);
    // Either side movable: enforced, and still blamed on the later round (here the pinned one, when it is b).
    // b starts at +10, a ends at +30: 20 minutes short.
    const short20 = ["b", { kind: "round_order_end", roundNo: 2, otherRoundNo: 1 }, 20];
    const bMovable = [row("a", 1, "C1", 0, 30, { ...END, movable: false }), row("b", 2, "C2", 10, 40, END)];
    expect(orderRows(bMovable, config).map((c) => [c.fixtureId, c.details, c.shortfallMinutes])).toEqual([short20]);
    const aMovable = [row("a", 1, "C1", 0, 30, END), row("b", 2, "C2", 10, 40, { ...END, movable: false })];
    expect(orderRows(aMovable, config).map((c) => [c.fixtureId, c.details, c.shortfallMinutes])).toEqual([short20]);
    // The exemption is per PAIR, so it reaches the max: round 1 holds a pinned long board (+0..+90) and a movable short
    // one (+0..+30). A PINNED round-2 board at +60 is exempt from the pinned long board and clear of the short one;
    // a MOVABLE round-2 board at +60 answers to both, so to +90.
    const round1 = [row("long", 1, "C1", 0, 90, { ...END, movable: false }), row("short", 1, "C2", 0, 30, END)];
    expect(orderRows([...round1, row("b", 2, "C3", 60, 90, { ...END, movable: false })], config)).toEqual([]);
    // 30 minutes short of the long board's +90 (against the short one alone it would be clear: +60 >= +30).
    expect(orderRows([...round1, row("b", 2, "C3", 60, 90, END)], config).map((c) => [c.details, c.shortfallMinutes])).toEqual([
      [{ kind: "round_order_end", roundNo: 2, otherRoundNo: 1 }, 30],
    ]);

    // Placer, lower side: round 1 has a board pinned at C1@+60 (ending +90) and a movable shell m1a; round 2 has m2a.
    //   p1 is committed first; m1a C1@+0 (it ends at +30, clear of p1); m2a ready = max(+90, +30) = +90 → C1@+90.
    const two = cfg({ courts: ["C1", "C2"] });
    const lower = slotFixtures({
      fixtures: [shell("p1", 1, { ...END, locked: { court: "C1", startAt: T0 + 60 * MIN } }), shell("m1a", 1, END), shell("m2a", 2, END)],
      config: two,
    });
    expect(slots(lower.assignments)).toEqual({ p1: "C1@+60", m1a: "C1@+0", m2a: "C1@+90" });
    expect(orderRows(lower.assignments, two)).toEqual([]);

    // Placer, upper side: round 2 pinned at C1@+20, so the movable round-1 board must end by +20 — a 30-minute board
    // starting no earlier than +0 cannot. It is refused, never placed into a breach, and the refusal names the pin
    // that set the deadline (`no_slot_round_barrier`), not a bare exhausted horizon.
    const upperFixtures = [shell("p2", 2, { ...END, locked: { court: "C1", startAt: T0 + 20 * MIN } }), shell("m1", 1, END)];
    const upper = slotFixtures({ fixtures: upperFixtures, config: two });
    expect(slots(upper.assignments)).toEqual({ p2: "C1@+20" });
    expect(upper.conflicts.filter((c) => c.fixtureId === "m1").map((c) => [c.reason, c.details])).toEqual([
      ["no_slot", { kind: "no_slot_round_barrier", roundNo: 1, otherRoundNo: 2, otherFixtureId: "p2" }],
    ]);
    expect(orderRows(upper.assignments, two)).toEqual([]);
    // The differential: as a start-floor sequence m1 is placed (C1 is busy +20..+50 → C2@+0), start +0 <= +20.
    const upperStart = slotFixtures({ fixtures: upperFixtures.map(({ roundBarrier: _drop, ...f }) => f), config: two });
    expect(slots(upperStart.assignments)).toEqual({ p2: "C1@+20", m1: "C2@+0" });
  });

  it("X-SW-31 two Swiss stages in one division are independent sequences", () => {
    // Division D1 runs Swiss stages S1 and S2. S1's round 1 has a late board (E3's window opens at +20).
    //   s1-r1-a (E1-E2) C1@+0;
    //   s1-r1-b (E3-E4) ready +20: C1 busy until +30, C2 free → C2@+20, ending +50;
    //   s2-r1-a (F1-F2) C1 busy, C2 busy +20..+50 → C3@+0;
    //   s1-r2-a: ready = S1 round 1 end = +50 → C1@+50;
    //   s2-r2-a: ready = S2 round 1 end = +30 → C1 (blocked by s1-r2-a, next +80), C2 (+50), C3 (+30) → C3@+30.
    //   Read as ONE sequence, s2-r2-a would wait for S1's +50 and take C2@+50.
    const fixtures: SchedulableFixture[] = [
      shell("s1-r1-a", 1, { home: "E1", away: "E2", ...END }),
      shell("s1-r1-b", 1, { home: "E3", away: "E4", ...END }),
      shell("s1-r2-a", 2, END),
      shell("s2-r1-a", 1, { stageId: "S2", home: "F1", away: "F2", ...END }),
      shell("s2-r2-a", 2, { stageId: "S2", ...END }),
    ];
    const config = cfg({
      constraints: SchedulingConstraints.parse({
        startWindows: [{ target: { kind: "entrant", id: "E3" }, notBefore: T0 + 20 * MIN }],
      }),
    });
    const { assignments } = slotFixtures({ fixtures, config });
    expect(slots(assignments)).toEqual({
      "s1-r1-a": "C1@+0",
      "s1-r1-b": "C2@+20",
      "s2-r1-a": "C3@+0",
      "s1-r2-a": "C1@+50",
      "s2-r2-a": "C3@+30",
    });
    expect(orderRows(assignments, config)).toEqual([]);

    // Verifier: S1's round 1 runs long (+0..+90). S2's round 2 at +30 answers only to S2's round 1 (+0..+30); S1's
    // round 2 at +30 answers to S1's.
    const board = [
      row("s1-r1", 1, "C1", 0, 90, END),
      row("s2-r1", 1, "C2", 0, 30, { ...END, stageId: "S2" }),
      row("s2-r2", 2, "C3", 30, 60, { ...END, stageId: "S2" }),
      row("s1-r2", 2, "C4", 30, 60, END),
    ];
    expect(orderRows(board, cfg()).map((c) => [c.fixtureId, c.details, c.shortfallMinutes])).toEqual([
      // s1-r2 starts at +30, S1's round 1 ends at +90: 60 minutes short.
      ["s1-r2", { kind: "round_order_end", roundNo: 2, otherRoundNo: 1 }, 60],
    ]);
  });

  it("X-SW-31 mixed roundBarrier within one sequence → CONFIG_INVALID", async () => {
    const invalid = expect.objectContaining({ code: "CONFIG_INVALID" });
    // "end" beside an absent flag (absent = "start"), "end" beside "start", and a value outside the two.
    const mixedRows: Assignment[][] = [
      [row("a", 1, "C1", 0, 30, END), row("b", 2, "C2", 30, 60)],
      [row("a", 1, "C1", 0, 30, END), row("b", 2, "C2", 30, 60, { roundBarrier: "start" })],
      [row("a", 1, "C1", 0, 30, { roundBarrier: "END" as never })],
    ];
    let refused = 0;
    for (const board of mixedRows) {
      expect(() => validateAssignments(board, cfg())).toThrowError(invalid);
      // The widening callers run round order themselves on their widened set (`includeRoundOrder = false`).
      expect(() => roundOrderConflicts(board, TZ)).toThrowError(invalid);
      // Before the zone check: the guard is about the input, not the clock.
      expect(() => roundOrderConflicts(board, undefined)).toThrowError(invalid);
      refused++;
    }
    expect(refused).toBe(3);
    // Not mixed: two sequences, each constant. S1 is a Swiss stage, S2 a round robin in the same division.
    const twoSequences = [row("a", 1, "C1", 0, 30, END), row("b", 1, "C2", 0, 30, { stageId: "S2", roundBarrier: "start" })];
    expect(() => validateAssignments(twoSequences, cfg())).not.toThrow();
    // A row with no round is in no sequence, so its flag mixes with nothing.
    expect(() => validateAssignments([row("a", 1, "C1", 0, 30, END), { ...row("x", 1, "C2", 0, 30), roundNo: undefined }], cfg())).not.toThrow();

    // The placer and the build refuse the same input. The build REJECTS (it never throws synchronously).
    const fixtures = [shell("a", 1, END), shell("b", 2)];
    expect(() => slotFixtures({ fixtures, config: cfg() })).toThrowError(invalid);
    let pending: Promise<unknown> | undefined;
    expect(() => {
      pending = buildSchedule({ fixtures, config: cfg(), solve: unavailableSolver, log: silentLogger });
    }).not.toThrow();
    await expect(pending).rejects.toEqual(invalid);
    // The size gate's exit builds the greedy board SYNCHRONOUSLY, so this is the road where only `buildSchedule`'s own
    // up-front check keeps the refusal a rejection. Premise first: a 1 ms wall really takes that road.
    const valid = await buildSchedule({
      fixtures: [shell("a", 1, END), shell("b", 2, END)],
      config: cfg(),
      wallMs: 1,
      solve: unavailableSolver,
      log: silentLogger,
    });
    expect([valid.status, valid.notSearchedReason]).toEqual(["not_searched", "too_big"]);
    let gated: Promise<unknown> | undefined;
    expect(() => {
      gated = buildSchedule({ fixtures, config: cfg(), wallMs: 1, solve: unavailableSolver, log: silentLogger });
    }).not.toThrow();
    await expect(gated).rejects.toEqual(invalid);
  });

  it("X-SW-31 a second build over the first build's output is stable (no drift)", async () => {
    // Three Swiss rounds of shells (3, 2, 2 boards), four courts, flagged "end".
    //   round 1: C1, C2, C3 @+0 (end +30); round 2: C1, C2 @+30 (end +60); round 3: C1, C2 @+60.
    const fixtures = [
      shell("r1-a", 1, END), shell("r1-b", 1, END), shell("r1-c", 1, END),
      shell("r2-a", 2, END), shell("r2-b", 2, END),
      shell("r3-a", 3, END), shell("r3-b", 3, END),
    ];
    const expected = {
      "r1-a": "C1@+0", "r1-b": "C2@+0", "r1-c": "C3@+0",
      "r2-a": "C1@+30", "r2-b": "C2@+30",
      "r3-a": "C1@+60", "r3-b": "C2@+60",
    };
    const config = cfg();
    const first = await buildSchedule({ fixtures, config, solve: unavailableSolver, log: silentLogger });
    expect(slots(first.assignments)).toEqual(expected);
    expect(first.conflicts.filter((c) => c.reason === "order")).toEqual([]);

    // Re-run over its own board: nothing moves, nothing is lost.
    const second = await buildSchedule({ fixtures, config, current: first.assignments, solve: unavailableSolver, log: silentLogger });
    expect(slots(second.assignments)).toEqual(expected);
    expect(second.moved).toBe(0);
    expect(second.lost).toBe(0);

    // Round 1 PINNED where the first build put it (an organiser lock), rounds 2-3 re-scheduled: the barrier reads
    // round 1's end off the pins and lands every later round where it was. A PLAYED round does not reach the placer
    // this way — the app hands it over as obstacles in `existing`; the next test covers that shape.
    const pinnedRoundOne = fixtures.map((f) => {
      const at = first.assignments.find((a) => a.fixtureId === f.id)!;
      return f.roundNo === 1 ? { ...f, locked: { court: at.court, startAt: at.startAt } } : f;
    });
    const third = await buildSchedule({ fixtures: pinnedRoundOne, config, current: first.assignments, solve: unavailableSolver, log: silentLogger });
    expect(slots(third.assignments)).toEqual(expected);
    expect(third.moved).toBe(0);
    expect(third.conflicts.filter((c) => c.reason === "order")).toEqual([]);
  });

  it("X-SW-31 a played round arrives as obstacles in `existing`: the barrier reads it there, judged on the app's widened set", async () => {
    // Round 1 is played, so the app hands its three boards over as `existing` (C1-C3, +0..+30), never as pins.
    // Round 2's two shells are the movable set, four courts.
    //   Read off `existing`: ready = max(round 1 end) = +30 → r2-a C1@+30 (C1 is the first court free at +30), then
    //   r2-b C2@+30. Not read: r2-a would take the free C4@+0, beside a round still being played.
    const played = [row("r1-a", 1, "C1", 0, 30, END), row("r1-b", 1, "C2", 0, 30, END), row("r1-c", 1, "C3", 0, 30, END)];
    const roundTwo = [shell("r2-a", 2, END), shell("r2-b", 2, END)];
    const config = cfg();
    const expected = { "r2-a": "C1@+30", "r2-b": "C2@+30" };
    const placer = slotFixtures({ fixtures: roundTwo, config, existing: played });
    expect(slots(placer.assignments)).toEqual(expected);
    // The app's apply gate re-runs round order over the board widened with its same-sequence siblings: clean.
    expect(roundOrderConflicts([...placer.assignments, ...played], TZ)).toEqual([]);
    // The production road, `buildSchedule` with no solver (Swiss shells always land there).
    const built = await buildSchedule({ fixtures: roundTwo, config, existing: played, solve: unavailableSolver, log: silentLogger });
    expect(built.engine).toBe("greedy");
    expect(slots(built.assignments)).toEqual(expected);
    expect(roundOrderConflicts([...built.assignments, ...played], TZ)).toEqual([]);

    // The differential: as a start-floor sequence r2-a takes the spare C4@+0 (a start tie, legal there) and r2-b the
    // first court free after it, C1@+30.
    const unflagged = <T extends { roundBarrier?: unknown }>(xs: readonly T[]) => xs.map(({ roundBarrier: _drop, ...x }) => x);
    expect(slots(slotFixtures({ fixtures: unflagged(roundTwo), config, existing: unflagged(played) }).assignments)).toEqual({
      "r2-a": "C4@+0",
      "r2-b": "C1@+30",
    });
    // Keyed by sequence: the same boards played in another stage hold nothing back.
    const otherStage = played.map((a) => ({ ...a, stageId: "S2" }));
    expect(slots(slotFixtures({ fixtures: roundTwo, config, existing: otherStage }).assignments)).toEqual({
      "r2-a": "C4@+0",
      "r2-b": "C1@+30",
    });
    // The flag is read off the FIXTURES only. An `existing` row joins a sequence by its key, so a sibling that is
    // unflagged, or says "start", neither turns the build into CONFIG_INVALID nor unbinds the barrier.
    let siblingShapes = 0;
    for (const flag of [{}, { roundBarrier: "start" as const }]) {
      const siblings = unflagged(played).map((a) => ({ ...a, ...flag }));
      expect(slots(slotFixtures({ fixtures: roundTwo, config, existing: siblings }).assignments)).toEqual(expected);
      const again = await buildSchedule({ fixtures: roundTwo, config, existing: siblings, solve: unavailableSolver, log: silentLogger });
      expect(slots(again.assignments)).toEqual(expected);
      siblingShapes++;
    }
    expect(siblingShapes).toBe(2);

    // The upper bound reads `existing` too. Round 1 played on C1 (+0..+30), a round-4 board on C3 at +100 and a
    // round-3 board on C2 at +40: round 2's card may start no earlier than +30 and must end by +40 (the EARLIEST later
    // start, not the first one listed), which a 30-minute board cannot. It is refused, never placed into a breach, and
    // the refusal names the round-3 board that set the deadline.
    const squeezed = slotFixtures({
      fixtures: [shell("r2-a", 2, END)],
      config,
      existing: [row("r1-a", 1, "C1", 0, 30, END), row("r4-a", 4, "C3", 100, 130, END), row("r3-a", 3, "C2", 40, 70, END)],
    });
    expect(squeezed.assignments).toEqual([]);
    expect(squeezed.conflicts.map((c) => [c.fixtureId, c.reason, c.details])).toEqual([
      ["r2-a", "no_slot", { kind: "no_slot_round_barrier", roundNo: 2, otherRoundNo: 3, otherFixtureId: "r3-a" }],
    ]);
  });

  it("X-SW-31 the delta gate: a repair that shrinks a breach passes, one that grows it is refused (shortfallMinutes, outside the identity)", () => {
    // The verifier case's board: round 1 a1 C1 +0..+30 and a2 C2 +0..+90; round 2's b1 C3 +60..+90.
    const config = cfg();
    const refused = (before: Assignment[], after: Assignment[]) =>
      deltaConflicts(validateAssignments(before, config), validateAssignments(after, config)).filter(isBlockingConflict);
    const a1 = row("a1", 1, "C1", 0, 30, END);
    const before = [a1, row("a2", 1, "C2", 0, 90, END), row("b1", 2, "C3", 60, 90, END)];
    // Premise: the stored board carries the breach, b1 30 minutes short of a2's +90.
    expect(orderRows(before, config).map((c) => [c.fixtureId, c.shortfallMinutes])).toEqual([["b1", 30]]);
    // (a) The organiser pulls round 1's last board earlier: a2 now ends at +75, so b1 is 15 minutes short. Still a
    //     breach, but a smaller one: a repair, never refused. A measured value inside the identity would re-key the
    //     row and refuse exactly this move.
    const improved = [a1, row("a2", 1, "C2", 0, 75, END), row("b1", 2, "C3", 60, 90, END)];
    expect(orderRows(improved, config).map((c) => [c.fixtureId, c.shortfallMinutes])).toEqual([["b1", 15]]);
    expect(refused(before, improved)).toEqual([]);
    // (b) b1 dragged EARLIER, to +45: 45 minutes short. Same identity, bigger shortfall: refused.
    const worse = [a1, row("a2", 1, "C2", 0, 90, END), row("b1", 2, "C3", 45, 75, END)];
    expect(refused(before, worse).map((c) => [c.fixtureId, c.details, c.shortfallMinutes])).toEqual([
      ["b1", { kind: "round_order_end", roundNo: 2, otherRoundNo: 1 }, 45],
    ]);
    // (c) Nothing about the breach changes: nothing to refuse. A NEW breach on a clean board is refused outright.
    expect(refused(before, before)).toEqual([]);
    const clean = [a1, row("b1", 2, "C3", 30, 60, END)];
    const broken = [a1, row("b1", 2, "C3", 20, 50, END)];
    expect(refused(clean, broken).map((c) => [c.fixtureId, c.shortfallMinutes])).toEqual([["b1", 10]]);
  });

  it("X-SW-31 the end barrier needs no zone: it compares instants, not days", () => {
    // The start floor's day/same-day rows need a zone and are skipped without one; the end barrier compares two
    // instants, so it holds with or without `tz`. Same board as the verifier case: b1 starts at +60, round 1 ends +90.
    const board = [row("a1", 1, "C1", 0, 30, END), row("a2", 1, "C2", 0, 90, END), row("b1", 2, "C3", 60, 90, END)];
    expect(orderRows(board, cfg({ tz: undefined })).map((c) => [c.details, c.shortfallMinutes])).toEqual([
      [{ kind: "round_order_end", roundNo: 2, otherRoundNo: 1 }, 30],
    ]);
    // And the placer, the plain five shells: round 2 at +30 with no zone, exactly as with one.
    const fixtures = ROUND_TWO_OVER_ONE.map((id) => shell(id, Number(id[1]), END));
    expect(slots(slotFixtures({ fixtures, config: cfg({ tz: undefined }) }).assignments)).toEqual({
      "r1-a": "C1@+0", "r1-b": "C2@+0", "r1-c": "C3@+0", "r2-a": "C1@+30", "r2-b": "C2@+30",
    });
  });

  it("X-SW-31 the solver wire carries roundBarrier \"end\" beside every round it forwards, and nothing for a start-floor sequence", async () => {
    const capture = async (fixtures: SchedulableFixture[]): Promise<SolveBuildInput> => {
      let captured: SolveBuildInput | undefined;
      const solve = fakeSolver(async (input) => {
        captured = input;
        return proved([]);
      });
      await buildSchedule({ fixtures, config: cfg(), solve, log: silentLogger });
      expect(captured).toBeDefined();
      return captured!;
    };
    const pin = { court: "C2", startAt: T0 };
    // One Swiss sequence with a pinned round-1 board: the movable rows and the pin's row all carry the barrier.
    const swiss = await capture([shell("r1-a", 1, END), shell("r1-b", 1, { ...END, locked: pin }), shell("r2-a", 2, END)]);
    expect(swiss.fixtures.map((f) => [f.fixtureId, f.roundNo, f.roundBarrier])).toEqual([
      ["r1-a", 1, "end"],
      ["r2-a", 2, "end"],
    ]);
    expect(swiss.existing.map((e) => [e.fixtureId, e.roundNo, e.roundBarrier])).toEqual([["r1-b", 1, "end"]]);
    // A start-floor sequence, absent or explicit: the wire is today's, with no roundBarrier key anywhere.
    for (const flag of [{}, { roundBarrier: "start" as const }]) {
      const rr = await capture([shell("r1-a", 1, flag), shell("r1-b", 1, { ...flag, locked: pin }), shell("r2-a", 2, flag)]);
      expect(rr.fixtures.map((f) => [f.fixtureId, f.roundNo])).toEqual([["r1-a", 1], ["r2-a", 2]]);
      expect(rr.fixtures.some((f) => "roundBarrier" in f)).toBe(false);
      expect(rr.existing.some((e) => "roundBarrier" in e)).toBe(false);
    }
    // Where build.ts strips a division's rounds (two round-bearing stages share it: the wire has no stage index), the
    // barrier goes with them — a barrier without a round would be an order the service cannot place.
    const stripped = await capture([shell("a", 1, END), shell("b", 2, END), shell("c", 1, { ...END, stageId: "S2" })]);
    expect(stripped.fixtures.map((f) => [f.fixtureId, f.roundNo, f.roundBarrier])).toEqual([
      ["a", undefined, undefined],
      ["b", undefined, undefined],
      ["c", undefined, undefined],
    ]);
  });

  it("X-SW-31 the build gate refuses a solver board that breaks the barrier and ships the greedy board", async () => {
    // The service model is not in this repo and may not read the flag yet. Its board puts round 2 on the spare court
    // at +0, beside round 1 — legal under the start floor, a breach under the barrier.
    const solverBoard = proved([
      { fixtureId: "r1-a", court: "C1", startAtMs: T0 },
      { fixtureId: "r1-b", court: "C2", startAtMs: T0 },
      { fixtureId: "r2-a", court: "C3", startAtMs: T0 },
    ]);
    const swiss = [shell("r1-a", 1, END), shell("r1-b", 1, END), shell("r2-a", 2, END)];
    const { lines, log } = recordingLogger();
    const built = await buildSchedule({ fixtures: swiss, config: cfg(), solve: resolvingSolver(solverBoard), log });
    expect(built.status).toBe("verifier_rejected");
    expect(built.engine).toBe("greedy");
    // Greedy's board: round 1 C1, C2 @+0; round 2 after round 1 ends, C1@+30.
    expect(slots(built.assignments)).toEqual({ "r1-a": "C1@+0", "r1-b": "C2@+0", "r2-a": "C1@+30" });
    expect(lines.filter((l) => l.level === "error").map((l) => l.fields)).toEqual([{ rejected: ["r2-a:order"] }]);

    // The differential: the same reply for a start-floor sequence is legal — greedy places it identically (C3@+0) and
    // the proved ladder ties, so nothing is refused.
    const rr = swiss.map(({ roundBarrier: _drop, ...f }) => f);
    const plain = await buildSchedule({ fixtures: rr, config: cfg(), solve: resolvingSolver(solverBoard), log: silentLogger });
    expect(plain.status).not.toBe("verifier_rejected");
    expect(slots(plain.assignments)).toEqual({ "r1-a": "C1@+0", "r1-b": "C2@+0", "r2-a": "C3@+0" });
  });

  it("X-SW-31 placer and verifier agree (parity)", async ({ task }) => {
    // A fixed-seed corpus: 1-4 courts, 1-3 Swiss sequences (two divisions, a stage each, some pooled), 1-4 rounds of
    // 1-3 boards, half seated (entrants shared within a sequence, so rest bites) and half shells, ~12% pinned at a
    // random court and quarter-hour, a start window on one entrant in ~30%, no zone in ~15%, and round-less noise in a
    // third division. No feed dependencies: a Swiss stage has none.
    //
    // Three judges, each run on the placer's OWN output:
    //   1. the real verifier (`validateAssignments`) — no `order` row;
    //   2. the rule itself, read off the INPUT (never off the placer's output, so a placer that dropped the flag from
    //      its rows cannot pass by hiding it from judge 1): for every pair of an earlier and a later round of a flagged
    //      sequence, both on the board and not both pinned, the later starts no earlier than the earlier ends;
    //   3. the production road, `buildSchedule` with no solver (Swiss shells always land there) — no `order` row.
    let cases = 0;
    let placed = 0;
    let pairs = 0;
    let bites = 0;
    let refused = 0;
    let refusalsNamed = 0;
    let barrierNamed = 0;
    let existingCases = 0;
    let existingRows = 0;
    let crossPairs = 0;
    let existingBites = 0;
    let startEqualsAbsent = 0;
    for (let seed = 1; seed <= CORPUS_SIZE; seed++) {
      const { fixtures, config } = corpusCase(seed);
      const { assignments, conflicts } = slotFixtures({ fixtures, config });
      placed += assignments.length;
      // No silent drop: every fixture this run left off the board has its refusal row in this run's own conflicts.
      refusalsNamed += refusalsAccountedFor(fixtures, assignments, conflicts, `seed ${seed}`);
      barrierNamed += conflicts.filter((c) => c.details?.kind === "no_slot_round_barrier").length;
      expect(orderRows(assignments, config), `seed ${seed}: verifier`).toEqual([]);
      const judged = endBarrierBreaches(fixtures, assignments);
      expect(judged.breaches, `seed ${seed}: the rule`).toEqual([]);
      pairs += judged.pairs;
      // Carried through: every flagged fixture's row says so, or a re-verify of this board would read a start floor.
      const flagged = new Set(fixtures.filter((f) => f.roundBarrier === "end").map((f) => f.id));
      expect(assignments.filter((a) => flagged.has(a.fixtureId) && a.roundBarrier !== "end"), `seed ${seed}: carry`).toEqual([]);

      const built = await buildSchedule({ fixtures, config, solve: unavailableSolver, log: silentLogger });
      expect(built.conflicts.filter((c) => c.reason === "order"), `seed ${seed}: build`).toEqual([]);
      expect(endBarrierBreaches(fixtures, built.assignments).breaches, `seed ${seed}: build rule`).toEqual([]);

      // Does the barrier BITE here? The same input as a start-floor sequence, judged by the rule.
      const absent = fixtures.map(({ roundBarrier: _drop, ...f }) => f);
      const absentBoard = slotFixtures({ fixtures: absent, config });
      if (endBarrierBreaches(fixtures, absentBoard.assignments).breaches.length > 0) bites++;
      // The upper bound (a pin of a later round) at work: a card the start floor placed and the barrier refused.
      const onBoard = new Set(assignments.map((a) => a.fixtureId));
      refused += absentBoard.assignments.filter((a) => flagged.has(a.fixtureId) && !onBoard.has(a.fixtureId)).length;
      // A played round arrives as obstacles in `existing`, never as pins: move a seeded prefix of each sequence's
      // rounds off the fixture list and onto `existing`, exactly where this run placed them, and place the rest around
      // them. Judged as the app's apply gate judges it (round order over the board widened with its same-sequence
      // siblings) and by the rule off the input.
      const played = playedPrefix(seed, fixtures);
      if (played.size > 0) {
        const existing = assignments.filter((a) => played.has(a.fixtureId));
        const rest = fixtures.filter((f) => !played.has(f.id));
        const rerun = slotFixtures({ fixtures: rest, config, existing });
        refusalsNamed += refusalsAccountedFor(rest, rerun.assignments, rerun.conflicts, `seed ${seed} existing`);
        const widened = [...rerun.assignments, ...existing];
        expect(roundOrderConflicts(widened, config.tz), `seed ${seed}: existing, widened gate`).toEqual([]);
        expect(endBarrierBreaches(fixtures, widened).breaches, `seed ${seed}: existing, the rule`).toEqual([]);
        const rebuilt = await buildSchedule({ fixtures: rest, config, existing, solve: unavailableSolver, log: silentLogger });
        expect(roundOrderConflicts([...rebuilt.assignments, ...existing], config.tz), `seed ${seed}: existing, build`).toEqual([]);
        // Does reading `existing` BITE here? The same obstacles, re-keyed into a sequence of their own so they occupy
        // the courts and bind nothing: a board that breaches the widened rule is one only the read keeps legal.
        const blindTo = existing.map((a) => ({ ...a, stageId: `${a.stageId ?? ""}~` }));
        const blind = slotFixtures({ fixtures: rest, config, existing: blindTo });
        if (endBarrierBreaches(fixtures, [...blind.assignments, ...existing]).breaches.length > 0) existingBites++;
        existingCases++;
        existingRows += existing.length;
        crossPairs += crossingPairs(fixtures, existing, rerun.assignments);
      }
      // And "start" is the absent value, placement for placement and row for row.
      const start = slotFixtures({ fixtures: absent.map((f) => ({ ...f, roundBarrier: "start" as const })), config });
      expect(slots(start.assignments), `seed ${seed}: start = absent`).toEqual(slots(absentBoard.assignments));
      expect(start.conflicts, `seed ${seed}: start = absent conflicts`).toEqual(absentBoard.conflicts);
      startEqualsAbsent++;
      cases++;
    }
    Object.assign(task.meta, {
      corpus: { cases, placed, pairs, bites, refused, refusalsNamed, barrierNamed, existingCases, existingRows, crossPairs, existingBites, startEqualsAbsent },
    });
    // Anti-vacuity: every case judged, boards actually placed, cross-round pairs actually compared, and the barrier
    // actually moving boards in a real share of the corpus (floors set below the measured counts in the T10b report).
    expect(cases).toBe(CORPUS_SIZE);
    expect(startEqualsAbsent).toBe(CORPUS_SIZE);
    expect(placed).toBeGreaterThan(0);
    expect(pairs).toBeGreaterThanOrEqual(PAIRS_FLOOR);
    expect(bites).toBeGreaterThanOrEqual(BITES_FLOOR);
    expect(refused).toBeGreaterThanOrEqual(REFUSED_FLOOR);
    expect(refusalsNamed).toBeGreaterThanOrEqual(refused);
    expect(barrierNamed).toBeGreaterThanOrEqual(BARRIER_NAMED_FLOOR);
    expect(existingCases).toBeGreaterThanOrEqual(EXISTING_CASES_FLOOR);
    expect(crossPairs).toBeGreaterThanOrEqual(CROSS_PAIRS_FLOOR);
    expect(existingBites).toBeGreaterThanOrEqual(EXISTING_BITES_FLOOR);
  }, 120_000);
});

/** A fully proved placement reply: the ladder's own tier names, so `already_optimal` is reachable. */
function proved(assignments: SolveBuildOutcome["assignments"]): SolveBuildOutcome {
  return {
    assignments,
    status: "OPTIMAL",
    tiersCompleted: TIER_COUNT,
    objectiveValues: TIER_NAMES.map((name, i) => ({ name, value: i })),
    elapsedMs: 5,
    wallExhausted: false,
  };
}

const CORPUS_SIZE = 240;
/** Floors at about 80% of the measured corpus (seeds 1-240). 2026-10-31: 3,670 cross-round pairs judged, the barrier
 *  moving boards in 177 cases, 249 cards refused by a later round's pin. 2026-11-01 (T10b fix round 1): all 249
 *  refusals named `no_slot_round_barrier`; 171 cases with a played prefix in `existing` (601 rows, 1,617 pairs of an
 *  `existing` row against a later round placed around it), and in 82 of them a placer blind to `existing` breaches.
 *  Low enough that a legitimate placer change does not trip them, high enough that a corpus which stopped exercising
 *  the barrier, its upper bound, its refusal detail or its `existing` read does. */
const PAIRS_FLOOR = 3000;
const BITES_FLOOR = 140;
const REFUSED_FLOOR = 200;
const BARRIER_NAMED_FLOOR = 200;
const EXISTING_CASES_FLOOR = 135;
const CROSS_PAIRS_FLOOR = 1300;
const EXISTING_BITES_FLOOR = 65;

/** Asserts every fixture missing from `board` has a refusal row (`no_slot` or `start_window`) in `conflicts`, the
 *  same run's; returns how many it checked. */
function refusalsAccountedFor(
  fixtures: readonly SchedulableFixture[],
  board: readonly Assignment[],
  conflicts: readonly { fixtureId: string; reason: string }[],
  label: string,
): number {
  const onBoard = new Set(board.map((a) => a.fixtureId));
  const named = new Set(conflicts.filter((c) => c.reason === "no_slot" || c.reason === "start_window").map((c) => c.fixtureId));
  let checked = 0;
  for (const f of fixtures) {
    if (onBoard.has(f.id)) continue;
    expect(named.has(f.id), `${label}: ${f.id} left off the board with no refusal row`).toBe(true);
    checked++;
  }
  return checked;
}

/** The ids of a seeded prefix of rounds per flagged sequence (0 to all-but-the-last), standing for rounds already
 *  played. Its own stream, so `corpusCase` and every count measured before it are unchanged. */
function playedPrefix(seed: number, fixtures: readonly SchedulableFixture[]): Set<string> {
  const r = mulberry32(seed * 104729);
  const lastRound = new Map<string, number>();
  for (const f of fixtures) {
    if (f.roundBarrier !== "end" || f.roundNo === undefined) continue;
    lastRound.set(seqKeyOf(f), Math.max(lastRound.get(seqKeyOf(f)) ?? 0, f.roundNo));
  }
  const upTo = new Map([...lastRound].map(([key, last]) => [key, Math.floor(r() * last)]));
  return new Set(
    fixtures.filter((f) => f.roundNo !== undefined && f.roundNo <= (upTo.get(seqKeyOf(f)) ?? 0)).map((f) => f.id),
  );
}

/** Earlier-round `existing` rows against later-round rows of the rerun, same sequence, not both pins: the pairs only
 *  a placer that reads `existing` can keep apart. */
function crossingPairs(
  fixtures: readonly SchedulableFixture[],
  existing: readonly Assignment[],
  rerun: readonly Assignment[],
): number {
  const byId = new Map(fixtures.map((f) => [f.id, f]));
  let n = 0;
  for (const e of existing) {
    const ef = byId.get(e.fixtureId)!;
    for (const p of rerun) {
      const pf = byId.get(p.fixtureId)!;
      if (pf.roundBarrier !== "end" || seqKeyOf(ef) !== seqKeyOf(pf) || (ef.roundNo ?? 0) >= (pf.roundNo ?? 0)) continue;
      if (ef.locked !== undefined && pf.locked !== undefined) continue;
      n++;
    }
  }
  return n;
}

const seqKeyOf = (f: SchedulableFixture): string => `${f.divisionId ?? ""}|${f.stageId ?? ""}|${f.poolId ?? ""}`;

/** The rule, judged off the INPUT fixtures' own flags, rounds, sequences and pins. */
function endBarrierBreaches(
  fixtures: readonly SchedulableFixture[],
  board: readonly Assignment[],
): { pairs: number; breaches: string[] } {
  const byId = new Map(fixtures.map((f) => [f.id, f]));
  const rows = board.flatMap((a) => {
    const f = byId.get(a.fixtureId);
    return f?.roundNo !== undefined && f.roundBarrier === "end" ? [{ a, f, roundNo: f.roundNo }] : [];
  });
  let pairs = 0;
  const breaches: string[] = [];
  for (const earlier of rows) {
    for (const later of rows) {
      if (seqKeyOf(earlier.f) !== seqKeyOf(later.f) || earlier.roundNo >= later.roundNo) continue;
      if (earlier.f.locked !== undefined && later.f.locked !== undefined) continue;
      pairs++;
      if (later.a.startAt < earlier.a.endAt) breaches.push(`${later.f.id} starts before ${earlier.f.id} ends`);
    }
  }
  return { pairs, breaches };
}

function corpusCase(seed: number): { fixtures: SchedulableFixture[]; config: Cfg } {
  const r = mulberry32(seed * 7919);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const courts = ["C1", "C2", "C3", "C4"].slice(0, 1 + Math.floor(r() * 4));
  const fixtures: SchedulableFixture[] = [];
  const sequences = 1 + Math.floor(r() * 3);
  for (let s = 0; s < sequences; s++) {
    const seq = { divisionId: `D${1 + (s % 2)}`, stageId: `S${s}`, ...(r() < 0.3 ? { poolId: "P1" } : {}) };
    const rounds = 1 + Math.floor(r() * 4);
    for (let round = 1; round <= rounds; round++) {
      const boards = 1 + Math.floor(r() * 3);
      for (let b = 0; b < boards; b++) {
        const seated = r() < 0.5;
        // Home from one half of the sequence's entrants and away from the other, so a board never meets itself.
        const home = `s${s}e${Math.floor(r() * 4)}`;
        const away = `s${s}e${4 + Math.floor(r() * 4)}`;
        const pinned = r() < 0.12;
        const lockedAt = { court: pick(courts), startAt: T0 + Math.floor(r() * 12) * 15 * MIN };
        fixtures.push({
          id: `s${s}-r${round}-b${b}`,
          roundNo: round,
          roundBarrier: "end",
          ...seq,
          ...(seated ? { home, away } : {}),
          ...(pinned ? { locked: lockedAt } : {}),
        });
      }
    }
  }
  const noise = Math.floor(r() * 3);
  for (let n = 0; n < noise; n++) fixtures.push({ id: `x${n}`, home: `x${n}h`, away: `x${n}a`, divisionId: "D9" });
  const window = r() < 0.3 ? pick([15, 40, 75]) : undefined;
  return {
    fixtures,
    config: {
      startAt: T0,
      matchMinutes: pick([20, 30, 45]),
      gapMinutes: pick([0, 0, 5]),
      courts,
      perEntrantMinRest: pick([0, 0, 15]),
      ...(r() < 0.85 ? { tz: TZ } : {}),
      window: { from: T0, to: T0 + 24 * 60 * MIN },
      ...(window !== undefined
        ? {
            constraints: SchedulingConstraints.parse({
              startWindows: [{ target: { kind: "entrant", id: "s0e0" }, notBefore: T0 + window * MIN }],
            }),
          }
        : {}),
    },
  };
}
