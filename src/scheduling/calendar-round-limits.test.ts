// X-SW-31 follow-on, W3 T10c (owner rulings 255 and 256, 2026-11-01): unpaired Swiss round slots, the round gap and
// rounds per day.
//
// Ruling 255: a Swiss round whose pairing is not drawn yet goes to the placement service as an UNPAIRED ROUND SLOT — no
// entrants, no people, a court and a time, flagged so the service does not refuse it (today it refuses a fixture with
// neither, and every Swiss auto-schedule falls back to greedy). The flag rides only beside a round the wire actually
// forwards: a slot whose round was stripped would make the service refuse the WHOLE request.
//
// Ruling 256: an unpaired slot carries no people, so person rest and per-person day caps cannot reach it. A Swiss
// sequence (`roundBarrier: "end"`) therefore keeps them as ROUND limits:
//   - `roundGapMinutes`: every board of round r starts no earlier than the last END of an earlier round of its sequence
//     PLUS this many minutes (the division's minimum rest). 0/absent = no gap: T10b's barrier.
//   - `roundsPerDayCap`: in one sequence, the distinct rounds with a board on one calendar day number at most this (the
//     division's per-player daily match cap: in a Swiss each player plays once per round, so rounds per day IS matches
//     per player per day). 0/absent = no cap. A calendar day needs the org zone, so without `tz` the cap is not read
//     (the house rule for every day-shaped rule).
//
// Scheduling is sport-agnostic (no sport module is read here), so there is no sport registry to sweep.
//
// Every expected time is hand-computed in the comment beside it from the placer's documented rule (earliest start,
// courts tried in order, the first strictly-earliest court wins) and the two limits above, never read back from the code
// under test. T0 = 2026-08-08 09:00Z = 10:00 in Europe/London (BST, UTC+1, no DST change in the corpus window). The
// next local midnight, 2026-08-09 00:00 BST, is 2026-08-08 23:00Z = T0 + 840 minutes. `sessions(n)` opens 10:00-18:00
// local on n days: day d = [T0 + d*1440, T0 + d*1440 + 480) minutes, so day 2 opens at +1440.
import { describe, expect, it } from "vitest";
import {
  deltaConflicts,
  isBlockingConflict,
  roundOrderConflicts,
  slotFixtures,
  validateAssignments,
  type Assignment,
  type Conflict,
  type SchedulableFixture,
  type SessionWindow,
  type SlotConfig,
} from "./calendar.ts";
import { buildSchedule, TIER_COUNT, TIER_NAMES } from "./build.ts";
import { SchedulingConstraints } from "./constraints.ts";
import type { BuildProblem, PlacementSolver, SolveBuildInput, SolveBuildOutcome } from "./solver-port.ts";
import { fakeSolver, recordingLogger, resolvingSolver, silentLogger, unavailableSolver } from "./__tests__/solver-fakes.ts";
import { mulberry32 } from "../core/rng.ts";

const MIN = 60_000;
const DAY = 1440;
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
  // `buildSchedule` refuses a lattice that cannot reach the fixtures; three days covers every hand case.
  window: { from: T0, to: T0 + 3 * DAY * MIN },
  ...over,
});

/** 10:00-18:00 local on `n` consecutive days from T0's. */
const sessions = (n: number): SessionWindow[] =>
  Array.from({ length: n }, (_, d) => ({ from: T0 + d * DAY * MIN, to: T0 + (d * DAY + 480) * MIN }));

/** A Swiss round shell (TBD v TBD), division D1, stage S1 unless told otherwise. */
const shell = (id: string, roundNo: number, over: Partial<SchedulableFixture> = {}): SchedulableFixture => ({
  id,
  roundNo,
  divisionId: "D1",
  stageId: "S1",
  ...over,
});

const END = { roundBarrier: "end" } as const;
const gap = (minutes: number) => ({ roundGapMinutes: minutes });
const cap = (rounds: number) => ({ roundsPerDayCap: rounds });

/** `{fixtureId: "court@+minutes"}`, the units the hand derivations use. */
const slots = (board: readonly Assignment[]): Record<string, string> =>
  Object.fromEntries(board.map((a) => [a.fixtureId, `${a.court}@+${(a.startAt - T0) / MIN}`]));

const orderRows = (board: readonly Assignment[], config: Cfg) =>
  validateAssignments(board, config).filter((c) => c.reason === "order");

/** A hand-built verifier row, D1/S1, `endAt` explicit. */
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

/** Removes the two limits from rows or fixtures, leaving everything else (the T10b shape). */
const withoutLimits = <T extends { roundGapMinutes?: unknown; roundsPerDayCap?: unknown }>(xs: readonly T[]) =>
  xs.map(({ roundGapMinutes: _g, roundsPerDayCap: _c, ...x }) => x);

/** The org-zone calendar day of an instant, computed with `Intl` — not with the engine's own tz helper. */
const localDay = (ms: number, tz: string): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));

const ROUND_TWO_OVER_ONE = ["r1-a", "r1-b", "r1-c", "r2-a", "r2-b"] as const;
/** Two boards a round, three rounds: the cap cases. */
const THREE_ROUNDS = ["r1-a", "r1-b", "r2-a", "r2-b", "r3-a", "r3-b"] as const;

describe("X-SW-31 rulings 255-256: unpaired round slots, the round gap and rounds per day", () => {
  it("X-SW-31 ruling 256 empty case first: roundGapMinutes and roundsPerDayCap absent or 0 place, verify and wire exactly as T10b", async () => {
    // (i) T10b's plain five shells, flagged "end", four courts: round 1 C1-C3 @+0 (ending +30), round 2 waits for +30:
    //     r2-a C1@+30, r2-b C2@+30 (C1 now busy +30..+60). Explicit zeros place the same board.
    const t10b = { "r1-a": "C1@+0", "r1-b": "C2@+0", "r1-c": "C3@+0", "r2-a": "C1@+30", "r2-b": "C2@+30" };
    const plain = ROUND_TWO_OVER_ONE.map((id) => shell(id, Number(id[1]), END));
    expect(slots(slotFixtures({ fixtures: plain, config: cfg() }).assignments)).toEqual(t10b);
    const zeros = plain.map((f) => ({ ...f, ...gap(0), ...cap(0) }));
    const zeroBoard = slotFixtures({ fixtures: zeros, config: cfg() });
    expect(slots(zeroBoard.assignments)).toEqual(t10b);
    expect(orderRows(zeroBoard.assignments, cfg())).toEqual([]);

    // (ii) The differential over the whole corpus: the corpus with its limits removed against the same corpus with both
    //      set to an explicit 0. Same board, same conflicts, same verdict, and a wire with neither key on it.
    let cases = 0;
    let fixturesCompared = 0;
    let wireFixtures = 0;
    for (let seed = 1; seed <= CORPUS_SIZE; seed++) {
      const { fixtures, config } = corpusCase(seed);
      const absent = withoutLimits(fixtures);
      const zero = absent.map((f) => (f.roundNo !== undefined ? { ...f, ...gap(0), ...cap(0) } : f));
      const a = slotFixtures({ fixtures: absent, config });
      const z = slotFixtures({ fixtures: zero, config });
      expect(slots(z.assignments), `seed ${seed}: board`).toEqual(slots(a.assignments));
      expect(z.conflicts, `seed ${seed}: placer conflicts`).toEqual(a.conflicts);
      expect(validateAssignments(z.assignments, config), `seed ${seed}: verifier`).toEqual(
        validateAssignments(a.assignments, config),
      );
      const wireA = await wireIfAsked({ fixtures: absent, config });
      const wireZ = await wireIfAsked({ fixtures: zero, config });
      expect(JSON.stringify(wireZ), `seed ${seed}: wire bytes`).toBe(JSON.stringify(wireA));
      if (wireA !== undefined) {
        expect(JSON.stringify(wireA)).not.toMatch(/roundGapMinutes|roundsPerDayCap/);
        wireFixtures += wireA.fixtures.length;
      }
      fixturesCompared += fixtures.length;
      cases++;
    }
    expect(cases).toBe(CORPUS_SIZE);
    expect(fixturesCompared).toBeGreaterThan(0);
    expect(wireFixtures).toBeGreaterThan(0);
  }, 120_000);

  it("X-SW-31 ruling 256 the round gap pushes round 2 by exactly the gap (greedy placer, verifier, build)", async () => {
    // T10b's five shells with a 15-minute gap. Round 1 C1-C3 @+0, ending +30. Round 2 may start no earlier than
    // +30 + 15 = +45: r2-a C1@+45 (C1 has been free since +30), r2-b C2@+45 (C1 busy +45..+75). Against the gap-less
    // board (round 2 @+30) that is exactly the 15 minutes.
    const fixtures = ROUND_TWO_OVER_ONE.map((id) => shell(id, Number(id[1]), { ...END, ...gap(15) }));
    const expected = { "r1-a": "C1@+0", "r1-b": "C2@+0", "r1-c": "C3@+0", "r2-a": "C1@+45", "r2-b": "C2@+45" };
    const config = cfg();
    const { assignments } = slotFixtures({ fixtures, config });
    expect(slots(assignments)).toEqual(expected);
    const r1End = Math.max(...assignments.filter((a) => a.roundNo === 1).map((a) => a.endAt));
    const r2Start = Math.min(...assignments.filter((a) => a.roundNo === 2).map((a) => a.startAt));
    expect(r2Start - r1End).toBe(15 * MIN);
    expect(orderRows(assignments, config)).toEqual([]);
    // Carried through: every row says what its fixture said, or a re-verify would read no gap.
    expect(assignments.map((a) => a.roundGapMinutes)).toEqual([15, 15, 15, 15, 15]);
    const gapless = slotFixtures({ fixtures: withoutLimits(fixtures), config }).assignments;
    expect(slots(gapless)).toEqual({ ...expected, "r2-a": "C1@+30", "r2-b": "C2@+30" });
    // The production road (no solver).
    const built = await buildSchedule({ fixtures, config, solve: unavailableSolver, log: silentLogger });
    expect(slots(built.assignments)).toEqual(expected);
    expect(built.conflicts.filter((c) => c.reason === "order")).toEqual([]);

    // The verifier: round 1 ends at +30, so with a 15-minute gap round 2 may start at +45. At +30 (T10b's tie) it is
    // 15 minutes short; at +44, 1 minute short; at +45 legal. The gap rides in `shortfallMinutes`, the identity is
    // T10b's (the two rounds).
    const verdict = (fromMin: number) =>
      orderRows([row("a", 1, "C1", 0, 30, { ...END, ...gap(15) }), row("b", 2, "C2", fromMin, fromMin + 30, { ...END, ...gap(15) })], config).map(
        (c) => [c.fixtureId, c.details, c.shortfallMinutes, c.direct, c.rule],
      );
    const short = (n: number) => [["b", { kind: "round_order_end", roundNo: 2, otherRoundNo: 1 }, n, true, "H6"]];
    expect(verdict(30)).toEqual(short(15));
    expect(verdict(44)).toEqual(short(1));
    expect(verdict(45)).toEqual([]);
    // Without the gap, +30 is T10b's legal tie.
    expect(orderRows([row("a", 1, "C1", 0, 30, END), row("b", 2, "C2", 30, 60, END)], config)).toEqual([]);
    // The gap answers to EVERY earlier round, like the barrier: round 3 at +100 is clear of round 2's +60 end plus 15
    // (+75) but not of round 1's late board, ending +90: +90 + 15 = +105, 5 minutes short.
    const three = [
      row("a", 1, "C1", 0, 90, { ...END, ...gap(15) }),
      row("b", 2, "C2", 30, 60, { ...END, ...gap(15) }),
      row("c", 3, "C3", 100, 130, { ...END, ...gap(15) }),
    ];
    expect(orderRows(three, config).filter((c) => c.fixtureId === "c").map((c) => [c.details, c.shortfallMinutes])).toEqual([
      [{ kind: "round_order_end", roundNo: 3, otherRoundNo: 1 }, 5],
    ]);
  });

  it("X-SW-31 ruling 256 rounds per day: with cap 2 the third round moves to day 2 (greedy placer, verifier, build)", async () => {
    // Two courts, two boards a round, three rounds, open 10:00-18:00 local on three days, cap 2.
    //   r1-a C1@+0, r1-b C2@+0 (ending +30); r2-a C1@+30, r2-b C2@+30 (ending +60). Day 1 now holds rounds {1, 2}.
    //   r3-a: ready +60, but day 1 is full (round 3 would make 3 > 2): the next day starts at +840 (local midnight),
    //   which is closed until +1440 → C1@+1440 (C2 ties at +1440; C1 is tried first).
    //   r3-b: C1 is busy +1440..+1470 → C1's earliest is +1470; C2's is +1440, on day 2, which holds round 3 already
    //   → C2@+1440.
    const config = cfg({ courts: ["C1", "C2"], sessionWindows: sessions(3) });
    const fixtures = THREE_ROUNDS.map((id) => shell(id, Number(id[1]), { ...END, ...cap(2) }));
    const expected = {
      "r1-a": "C1@+0", "r1-b": "C2@+0",
      "r2-a": "C1@+30", "r2-b": "C2@+30",
      "r3-a": "C1@+1440", "r3-b": "C2@+1440",
    };
    const { assignments } = slotFixtures({ fixtures, config });
    expect(slots(assignments)).toEqual(expected);
    expect(orderRows(assignments, config)).toEqual([]);
    expect(assignments.map((a) => a.roundsPerDayCap)).toEqual([2, 2, 2, 2, 2, 2]);
    // The differential: with no cap round 3 follows round 2 on day 1, C1 and C2 @+60.
    const uncapped = slotFixtures({ fixtures: withoutLimits(fixtures), config }).assignments;
    expect(slots(uncapped)).toEqual({ ...expected, "r3-a": "C1@+60", "r3-b": "C2@+60" });

    // The verifier over that uncapped board, judged with cap 2: day 1 holds rounds {1, 2, 3}, three against a cap of
    // two. One row per movable board on that day (six), blamed on each, blocking. The identity is the day and the cap;
    // the count is MEASURED and rides outside it.
    const overDay = uncapped.map((a) => ({ ...a, ...cap(2) }));
    const rows = orderRows(overDay, config);
    expect(rows.map((c) => c.fixtureId)).toEqual([...THREE_ROUNDS]);
    for (const c of rows) {
      expect(c).toEqual({
        fixtureId: c.fixtureId,
        reason: "order",
        direct: true,
        rule: "H6",
        details: { kind: "rounds_per_day", day: "2026-08-08", requiredCount: 2 },
        measuredCount: 3,
      });
    }
    expect(rows.every(isBlockingConflict)).toBe(true);
    // The cap is a calendar-day rule: with no zone it is not read, by the placer or the verifier.
    const noZone = cfg({ courts: ["C1", "C2"], sessionWindows: sessions(3), tz: undefined });
    expect(slots(slotFixtures({ fixtures, config: noZone }).assignments)).toEqual(slots(uncapped));
    expect(orderRows(overDay, noZone)).toEqual([]);

    // The production road, and a second build over the first build's board: nothing moves.
    const built = await buildSchedule({ fixtures, config, solve: unavailableSolver, log: silentLogger });
    expect(slots(built.assignments)).toEqual(expected);
    expect(built.conflicts.filter((c) => c.reason === "order")).toEqual([]);
    const again = await buildSchedule({ fixtures, config, current: built.assignments, solve: unavailableSolver, log: silentLogger });
    expect(slots(again.assignments)).toEqual(expected);
    expect([again.moved, again.lost]).toEqual([0, 0]);
  });

  it("X-SW-31 ruling 256 the cap leaves no day: the card is refused no_slot_rounds_per_day, never placed into a breach", () => {
    // Two courts, a 600-minute horizon (+600 is 20:00 local, before the next day starts at +840), one board a round,
    // cap 2. r1-a C1@+0; r2-a C1@+30 (ready +30, C1 free again at +30); r3-a: day 1 holds {1, 2}, so the earliest
    // legal start is the next day, +840, past the horizon on both courts. Refused, naming the cap.
    const config = cfg({ courts: ["C1", "C2"], horizonMinutes: 600 });
    const fixtures = [shell("r1-a", 1, { ...END, ...cap(2) }), shell("r2-a", 2, { ...END, ...cap(2) }), shell("r3-a", 3, { ...END, ...cap(2) })];
    const { assignments, conflicts } = slotFixtures({ fixtures, config });
    expect(slots(assignments)).toEqual({ "r1-a": "C1@+0", "r2-a": "C1@+30" });
    expect(conflicts).toEqual([
      { fixtureId: "r3-a", reason: "no_slot", rule: "CAP", details: { kind: "no_slot_rounds_per_day", roundNo: 3, requiredCount: 2 } },
    ]);
    expect(orderRows(assignments, config)).toEqual([]);
    // The differential: uncapped, r3-a follows round 2 on day 1, C1@+60.
    expect(slots(slotFixtures({ fixtures: withoutLimits(fixtures), config }).assignments)).toEqual({
      "r1-a": "C1@+0", "r2-a": "C1@+30", "r3-a": "C1@+60",
    });
  });

  it("X-SW-31 ruling 256 pins bind both: played rounds in `existing` and locked boards floor the gap, cap it from above, and fill the day", async () => {
    // (a) The gap from a played round in `existing`. Round 1 played on C1-C3 (+0..+30); round 2's shells may start no
    //     earlier than +30 + 15 = +45: r2-a C1@+45, r2-b C2@+45. Widened as the app's apply gate widens it: clean.
    const played1 = [row("r1-a", 1, "C1", 0, 30), row("r1-b", 1, "C2", 0, 30), row("r1-c", 1, "C3", 0, 30)];
    const roundTwo = [shell("r2-a", 2, { ...END, ...gap(15) }), shell("r2-b", 2, { ...END, ...gap(15) })];
    const config = cfg();
    let siblingShapes = 0;
    // The sequence's limits are read off the FIXTURES: a sibling row stamped like them, unstamped, or saying "start"
    // binds the same way and never turns the build into CONFIG_INVALID.
    for (const stamp of [{ ...END, ...gap(15) }, {}, { roundBarrier: "start" as const }]) {
      const existing = played1.map((a) => ({ ...a, ...stamp }));
      expect(slots(slotFixtures({ fixtures: roundTwo, config, existing }).assignments), JSON.stringify(stamp)).toEqual({
        "r2-a": "C1@+45",
        "r2-b": "C2@+45",
      });
      const built = await buildSchedule({ fixtures: roundTwo, config, existing, solve: unavailableSolver, log: silentLogger });
      expect(slots(built.assignments)).toEqual({ "r2-a": "C1@+45", "r2-b": "C2@+45" });
      expect(roundOrderConflicts([...built.assignments, ...played1.map((a) => ({ ...a, ...END, ...gap(15) }))], TZ)).toEqual([]);
      siblingShapes++;
    }
    expect(siblingShapes).toBe(3);
    // Differential: no gap, round 2 at +30.
    expect(slots(slotFixtures({ fixtures: withoutLimits(roundTwo), config, existing: played1 }).assignments)).toEqual({
      "r2-a": "C1@+30",
      "r2-b": "C2@+30",
    });

    // (b) The gap from above: round 2 pinned at C1@+45, so the movable round-1 board must END by +45 - 15 = +30.
    //     m1 C1@+0 ends exactly at +30 (a tie, legal). With the pin at +44 it must end by +29, which a 30-minute
    //     board starting no earlier than +0 cannot: refused, naming the pin. Without the gap it is placed C1@+0.
    const two = cfg({ courts: ["C1", "C2"] });
    const upper = (pinAt: number, limits: object) =>
      slotFixtures({
        fixtures: [shell("p2", 2, { ...END, ...limits, locked: { court: "C1", startAt: T0 + pinAt * MIN } }), shell("m1", 1, { ...END, ...limits })],
        config: two,
      });
    expect(slots(upper(45, gap(15)).assignments)).toEqual({ p2: "C1@+45", m1: "C1@+0" });
    const refused = upper(44, gap(15));
    expect(slots(refused.assignments)).toEqual({ p2: "C1@+44" });
    expect(refused.conflicts.map((c) => [c.fixtureId, c.reason, c.details])).toEqual([
      ["m1", "no_slot", { kind: "no_slot_round_barrier", roundNo: 1, otherRoundNo: 2, otherFixtureId: "p2" }],
    ]);
    expect(slots(upper(44, {}).assignments)).toEqual({ p2: "C1@+44", m1: "C1@+0" });
    // The verifier, the same pair: a pinned round-2 board at +44 against a movable round 1 ending +30 is 1 minute
    // short of the gap (blamed on the later round, the pin); two pins are exempt.
    const pinRow = (at: number, movable: boolean) => row("p2", 2, "C1", at, at + 30, { ...END, ...gap(15), movable });
    expect(orderRows([row("m1", 1, "C2", 0, 30, { ...END, ...gap(15) }), pinRow(44, false)], two).map((c) => [c.fixtureId, c.shortfallMinutes])).toEqual([
      ["p2", 1],
    ]);
    expect(orderRows([row("m1", 1, "C2", 0, 30, { ...END, ...gap(15), movable: false }), pinRow(44, false)], two)).toEqual([]);

    // (c) The cap from played rounds in `existing`. Rounds 1 and 2 played on day 1 (C1, C2: +0..+30, +30..+60); round
    //     3's two shells, cap 2: day 1 is full, so round 3 opens day 2 at +1440, C1 then C2 (the cap case's own
    //     derivation). Again, sibling stamps never matter. Without the cap round 3 follows on day 1 at +60.
    const capCfg = cfg({ courts: ["C1", "C2"], sessionWindows: sessions(3) });
    const played12 = [row("r1-a", 1, "C1", 0, 30), row("r1-b", 1, "C2", 0, 30), row("r2-a", 2, "C1", 30, 60), row("r2-b", 2, "C2", 30, 60)];
    const roundThree = [shell("r3-a", 3, { ...END, ...cap(2) }), shell("r3-b", 3, { ...END, ...cap(2) })];
    const dayTwo = { "r3-a": "C1@+1440", "r3-b": "C2@+1440" };
    for (const stamp of [{ ...END, ...cap(2) }, {}, { roundBarrier: "start" as const }]) {
      const existing = played12.map((a) => ({ ...a, ...stamp }));
      expect(slots(slotFixtures({ fixtures: roundThree, config: capCfg, existing }).assignments), JSON.stringify(stamp)).toEqual(dayTwo);
      const built = await buildSchedule({ fixtures: roundThree, config: capCfg, existing, solve: unavailableSolver, log: silentLogger });
      expect(slots(built.assignments)).toEqual(dayTwo);
      expect(roundOrderConflicts([...built.assignments, ...played12.map((a) => ({ ...a, ...END, ...cap(2) }))], TZ)).toEqual([]);
      siblingShapes++;
    }
    expect(siblingShapes).toBe(6);
    expect(slots(slotFixtures({ fixtures: withoutLimits(roundThree), config: capCfg, existing: played12 }).assignments)).toEqual({
      "r3-a": "C1@+60",
      "r3-b": "C2@+60",
    });

    // (d) The same rounds 1 and 2 as organiser LOCKS rather than played rounds: the same day-2 placement.
    const locked = [
      ...played12.map((a) => shell(a.fixtureId, a.roundNo!, { ...END, ...cap(2), locked: { court: a.court, startAt: a.startAt } })),
      ...roundThree,
    ];
    expect(slots(slotFixtures({ fixtures: locked, config: capCfg }).assignments)).toEqual({ ...slots(played12), ...dayTwo });

    // (e) The verifier's pin exemption for the cap: a day filled past the cap by pins alone has nothing this run can
    //     move, so no row. A movable board on that day is blamed, and only it: day 1 holds {1, 2, 3}, 3 > 2.
    const pinned = [
      row("p1", 1, "C1", 0, 30, { ...END, ...cap(2), movable: false }),
      row("p2", 2, "C1", 30, 60, { ...END, ...cap(2), movable: false }),
      row("p3", 3, "C1", 60, 90, { ...END, ...cap(2), movable: false }),
    ];
    expect(orderRows(pinned, capCfg)).toEqual([]);
    expect(orderRows([...pinned, row("m2", 2, "C2", 30, 60, { ...END, ...cap(2) })], capCfg).map((c) => [c.fixtureId, c.details, c.measuredCount])).toEqual([
      ["m2", { kind: "rounds_per_day", day: "2026-08-08", requiredCount: 2 }, 3],
    ]);
  });

  it("X-SW-31 ruling 256 the build gate refuses a solver board that breaks the gap or the cap against played rounds, and ships greedy", async () => {
    // The service may not read the two fields yet. (a) The gap: round 1 played on C1-C3 (+0..+30), the seated final
    // round r2-a with a 15-minute gap. The reply C4@+30 is T10b-legal and 15 minutes short of the gap; greedy waits
    // for +45, C1 first.
    const played1 = [row("r1-a", 1, "C1", 0, 30, { ...END, ...gap(15) }), row("r1-b", 1, "C2", 0, 30, { ...END, ...gap(15) }), row("r1-c", 1, "C3", 0, 30, { ...END, ...gap(15) })];
    const gapLog = recordingLogger();
    const gapBuilt = await buildSchedule({
      fixtures: [shell("r2-a", 2, { home: "E0", away: "E1", ...END, ...gap(15) })],
      config: cfg(),
      existing: played1,
      solve: resolvingSolver(proved([{ fixtureId: "r2-a", court: "C4", startAtMs: T0 + 30 * MIN }])),
      log: gapLog.log,
    });
    expect([gapBuilt.status, gapBuilt.engine]).toEqual(["verifier_rejected", "greedy"]);
    expect(slots(gapBuilt.assignments)).toEqual({ "r2-a": "C1@+45" });
    expect(gapLog.lines.filter((l) => l.level === "error").map((l) => l.fields)).toEqual([{ rejected: ["r2-a:order"] }]);

    // (b) The cap: rounds 1 and 2 played on day 1, the seated round 3 with cap 2. The reply C3@+60 puts a third round
    //     on day 1. Widened, every board on that day is blamed: the reply's r3-a, then the four played rows. Greedy
    //     opens day 2: ready +60, day 1 full → +1440, C1 first.
    const played12 = [
      row("r1-a", 1, "C1", 0, 30, { ...END, ...cap(2) }),
      row("r1-b", 1, "C2", 0, 30, { ...END, ...cap(2) }),
      row("r2-a", 2, "C1", 30, 60, { ...END, ...cap(2) }),
      row("r2-b", 2, "C2", 30, 60, { ...END, ...cap(2) }),
    ];
    const capLog = recordingLogger();
    const capBuilt = await buildSchedule({
      fixtures: [shell("r3-a", 3, { home: "E0", away: "E1", ...END, ...cap(2) })],
      config: cfg({ sessionWindows: sessions(3) }),
      existing: played12,
      solve: resolvingSolver(proved([{ fixtureId: "r3-a", court: "C3", startAtMs: T0 + 60 * MIN }])),
      log: capLog.log,
    });
    expect([capBuilt.status, capBuilt.engine]).toEqual(["verifier_rejected", "greedy"]);
    expect(slots(capBuilt.assignments)).toEqual({ "r3-a": "C1@+1440" });
    expect(capLog.lines.filter((l) => l.level === "error").map((l) => l.fields)).toEqual([
      { rejected: ["r3-a:order", "r1-a:order", "r1-b:order", "r2-a:order", "r2-b:order"] },
    ]);

    // (c) The same as (a) with the played rows written by an older build: no limits and no barrier of their own. A
    //     sibling joins its sequence by KEY and is judged by the sequence's rules, read off this build's fixtures —
    //     its own fields are never read. So the gate still finds r2-a 15 minutes short of round 1's end (+30 + 15),
    //     refuses the reply exactly as in (a), and never reads the bare rows as a second, limit-free sequence
    //     (which would be a mixed-limits CONFIG_INVALID). Greedy: floor +30 + 15 = +45, C1 first.
    const bare1 = withoutLimits(played1).map(({ roundBarrier: _b, ...r }) => r);
    expect(bare1.every((r) => !("roundBarrier" in r) && !("roundGapMinutes" in r))).toBe(true);
    const bareLog = recordingLogger();
    const bareBuilt = await buildSchedule({
      fixtures: [shell("r2-a", 2, { home: "E0", away: "E1", ...END, ...gap(15) })],
      config: cfg(),
      existing: bare1,
      solve: resolvingSolver(proved([{ fixtureId: "r2-a", court: "C4", startAtMs: T0 + 30 * MIN }])),
      log: bareLog.log,
    });
    expect([bareBuilt.status, bareBuilt.engine]).toEqual(["verifier_rejected", "greedy"]);
    expect(slots(bareBuilt.assignments)).toEqual({ "r2-a": "C1@+45" });
    expect(bareLog.lines.filter((l) => l.level === "error").map((l) => l.fields)).toEqual([{ rejected: ["r2-a:order"] }]);

    // The differential: the same replies with the limits removed are legal, and nothing is refused.
    for (const [fixtures, existing, at, config] of [
      [[shell("r2-a", 2, { home: "E0", away: "E1", ...END })], withoutLimits(played1), { fixtureId: "r2-a", court: "C4", startAtMs: T0 + 30 * MIN }, cfg()],
      [[shell("r3-a", 3, { home: "E0", away: "E1", ...END })], withoutLimits(played12), { fixtureId: "r3-a", court: "C3", startAtMs: T0 + 60 * MIN }, cfg({ sessionWindows: sessions(3) })],
    ] as const) {
      const { lines, log } = recordingLogger();
      const plain = await buildSchedule({ fixtures: [...fixtures], config, existing: [...existing], solve: resolvingSolver(proved([at])), log });
      expect(plain.status).not.toBe("verifier_rejected");
      expect(lines.filter((l) => l.level === "error")).toEqual([]);
    }
  });

  it("X-SW-31 ruling 256 the delta gate: the day's count is outside the identity, so a partial repair passes and an added round is refused", () => {
    // Day 1 holds rounds {1, 2, 3, 4} against a cap of 2 (legacy data, or a cap lowered under a published board): one
    // board a round, round 4 twice, back to back so no other order rule fires.
    const config = cfg();
    const capped = (r: Assignment) => ({ ...r, ...END, ...cap(2) });
    const refused = (before: Assignment[], after: Assignment[]) =>
      deltaConflicts(validateAssignments(before, config), validateAssignments(after, config)).filter(isBlockingConflict);
    const a1 = capped(row("a1", 1, "C1", 0, 30));
    const a2 = capped(row("a2", 2, "C1", 30, 60));
    const a3 = capped(row("a3", 3, "C1", 60, 90));
    const a4 = capped(row("a4", 4, "C1", 90, 120));
    const a4b = capped(row("a4b", 4, "C2", 90, 120));
    const before = [a1, a2, a3, a4, a4b];
    expect(orderRows(before, config).map((c) => [c.fixtureId, c.measuredCount])).toEqual([
      ["a1", 4], ["a2", 4], ["a3", 4], ["a4", 4], ["a4b", 4],
    ]);
    // (a) One of round 4's two boards moves to day 2 (+1440): day 1 still holds 4 rounds. Nothing new.
    const movedOne = [a1, a2, a3, a4, capped(row("a4b", 4, "C2", DAY, DAY + 30))];
    expect(refused(before, movedOne)).toEqual([]);
    // (b) Then the other: day 1 now holds 3 rounds, still over 2, but fewer. A repair, never refused — a count inside
    //     the identity would re-key a1-a3 and refuse exactly this move.
    const movedBoth = [a1, a2, a3, capped(row("a4", 4, "C1", DAY, DAY + 30)), capped(row("a4b", 4, "C2", DAY, DAY + 30))];
    expect(orderRows(movedBoth, config).map((c) => [c.fixtureId, c.measuredCount])).toEqual([["a1", 3], ["a2", 3], ["a3", 3]]);
    expect(refused(movedOne, movedBoth)).toEqual([]);
    // (c) A fifth round dropped onto the full day: refused, on the board that arrived (it brings its own new row).
    const a5 = capped(row("a5", 5, "C1", 120, 150));
    expect(refused(before, [...before, a5]).map((c) => [c.fixtureId, c.details, c.measuredCount])).toEqual([
      ["a5", { kind: "rounds_per_day", day: "2026-08-08", requiredCount: 2 }, 5],
    ]);
    // (d) A third round dropped onto a day that was within the cap: every board of that day is new, all refused.
    expect(refused([a1, a2], [a1, a2, a3]).map((c) => c.fixtureId)).toEqual(["a1", "a2", "a3"]);
  });

  it("X-SW-31 ruling 256 mixed or impossible limits in one sequence are CONFIG_INVALID (verifier, placer, build)", async () => {
    const invalid = expect.objectContaining({ code: "CONFIG_INVALID" });
    // Each pair is one sequence (D1/S1). The first five mix values (absent = 0); the next six carry a value no
    // division setting can have; the last two put a limit on a start-floor sequence, which has no round barrier to
    // add it to (the limits are Swiss round limits, and a forgotten barrier is the likeliest cause).
    const swiss = { ...END };
    const pairs: [Partial<Assignment>, Partial<Assignment>][] = [
      [{ ...swiss, ...gap(15) }, swiss],
      [{ ...swiss, ...gap(15) }, { ...swiss, ...gap(30) }],
      [{ ...swiss, ...cap(2) }, swiss],
      [{ ...swiss, ...cap(2) }, { ...swiss, ...cap(3) }],
      [{ ...swiss, ...gap(15), ...cap(2) }, { ...swiss, ...gap(15), ...cap(1) }],
      [{ ...swiss, ...gap(-5) }, { ...swiss, ...gap(-5) }],
      [{ ...swiss, ...gap(7.5) }, { ...swiss, ...gap(7.5) }],
      [{ ...swiss, ...gap(Number.NaN) }, { ...swiss, ...gap(Number.NaN) }],
      [{ ...swiss, roundGapMinutes: "15" as never }, { ...swiss, roundGapMinutes: "15" as never }],
      [{ ...swiss, ...cap(-1) }, { ...swiss, ...cap(-1) }],
      [{ ...swiss, ...cap(1.5) }, { ...swiss, ...cap(1.5) }],
      [gap(15), gap(15)],
      [{ roundBarrier: "start", ...cap(2) }, { roundBarrier: "start", ...cap(2) }],
    ];
    let refused = 0;
    for (const [first, second] of pairs) {
      const label = JSON.stringify([first, second]);
      const board = [row("a", 1, "C1", 0, 30, first), row("b", 2, "C2", 30, 60, second)];
      expect(() => validateAssignments(board, cfg()), label).toThrowError(invalid);
      expect(() => roundOrderConflicts(board, TZ), label).toThrowError(invalid);
      expect(() => roundOrderConflicts(board, undefined), label).toThrowError(invalid);
      const fixtures = [shell("a", 1, first), shell("b", 2, second)];
      expect(() => slotFixtures({ fixtures, config: cfg() }), label).toThrowError(invalid);
      let pending: Promise<unknown> | undefined;
      expect(() => {
        pending = buildSchedule({ fixtures, config: cfg(), solve: unavailableSolver, log: silentLogger });
      }).not.toThrow();
      await expect(pending, label).rejects.toEqual(invalid);
      refused++;
    }
    expect(refused).toBe(pairs.length);
    expect(refused).toBe(13);
    // The synchronous size-gate road (a 1 ms wall) rejects too. Premise first: a valid input really takes that road.
    const valid = await buildSchedule({
      fixtures: [shell("a", 1, { ...END, ...gap(15) }), shell("b", 2, { ...END, ...gap(15) })],
      config: cfg(),
      wallMs: 1,
      solve: unavailableSolver,
      log: silentLogger,
    });
    expect([valid.status, valid.notSearchedReason]).toEqual(["not_searched", "too_big"]);
    let gated: Promise<unknown> | undefined;
    expect(() => {
      gated = buildSchedule({
        fixtures: [shell("a", 1, { ...END, ...gap(15) }), shell("b", 2, END)],
        config: cfg(),
        wallMs: 1,
        solve: unavailableSolver,
        log: silentLogger,
      });
    }).not.toThrow();
    await expect(gated).rejects.toEqual(invalid);

    // Not refused: two sequences each constant (a Swiss stage with limits, another without), and a row with no round
    // (it is in no sequence, so its value mixes with nothing).
    const twoSequences = [
      row("a", 1, "C1", 0, 30, { ...END, ...gap(15), ...cap(2) }),
      row("b", 1, "C2", 0, 30, { ...END, stageId: "S2" }),
      { ...row("x", 1, "C3", 0, 30, gap(99)), roundNo: undefined },
    ];
    expect(() => validateAssignments(twoSequences, cfg())).not.toThrow();
  });

  it("X-SW-31 ruling 255 the solver wire: an unpaired round slot is flagged only beside a forwarded Swiss round, with the sequence's gap and cap", async () => {
    const pin = { court: "C2", startAt: T0 };
    const limits = { ...END, ...gap(15), ...cap(2) };
    // One Swiss sequence: a shell, a seated board, a shell that names a person (not unpaired: it has someone in it),
    // a pinned shell and a round-2 shell. Free fixtures go out in input order, the pin as an `existing` row.
    const swiss = await wireOf({
      fixtures: [
        shell("r1-a", 1, limits),
        shell("r1-b", 1, { ...limits, home: "E1", away: "E2" }),
        shell("r1-c", 1, { ...limits, people: ["P1"] }),
        shell("r1-d", 1, { ...limits, locked: pin }),
        shell("r2-a", 2, limits),
      ],
      config: cfg(),
    });
    const swissRound = { roundBarrier: "end", roundGapMinutes: 15, roundsPerDayCap: 2 };
    expect(swiss.fixtures.map(wireRoundFields)).toEqual([
      { fixtureId: "r1-a", roundNo: 1, ...swissRound, unpairedRoundSlot: true },
      { fixtureId: "r1-b", roundNo: 1, ...swissRound },
      { fixtureId: "r1-c", roundNo: 1, ...swissRound },
      { fixtureId: "r2-a", roundNo: 2, ...swissRound, unpairedRoundSlot: true },
    ]);
    // The pin row keeps T10b's shape: its round and barrier. It binds by the limits of the one sequence it is forwarded
    // into (a pin's round goes out only when the request holds exactly one round sequence).
    expect(swiss.existing.map(wireRoundFields)).toEqual([{ fixtureId: "r1-d", roundNo: 1, roundBarrier: "end" }]);

    // No zone: the cap is a calendar-day rule and the wire's day index is 0 for every slot without one, so the cap
    // stays home (it would cap the WHOLE schedule at two rounds). The gap does not need a day.
    const noZone = await wireOf({ fixtures: [shell("r1-a", 1, limits), shell("r2-a", 2, limits)], config: cfg({ tz: undefined }) });
    expect(noZone.fixtures.map(wireRoundFields)).toEqual([
      { fixtureId: "r1-a", roundNo: 1, roundBarrier: "end", roundGapMinutes: 15, unpairedRoundSlot: true },
      { fixtureId: "r2-a", roundNo: 2, roundBarrier: "end", roundGapMinutes: 15, unpairedRoundSlot: true },
    ]);

    // A start-floor sequence of shells (a round robin's TBD fixtures, if one ever reached here): today's wire, no key.
    const rr = await wireOf({ fixtures: [shell("r1-a", 1), shell("r2-a", 2)], config: cfg() });
    expect(rr.fixtures.map(wireRoundFields)).toEqual([
      { fixtureId: "r1-a", roundNo: 1 },
      { fixtureId: "r2-a", roundNo: 2 },
    ]);

    // THE ORDERING TRAP. Where build.ts strips a division's rounds, the flag must go with them: a slot flagged without
    // a round makes the service refuse the whole request. (i) Two Swiss stages share division D1 (the wire has no stage
    // index); (ii) a feed dependency touches a round-bearing fixture of D1.
    const twoStages = await wireOf({
      fixtures: [shell("a", 1, limits), shell("b", 2, limits), shell("c", 1, { ...limits, stageId: "S2" })],
      config: cfg(),
    });
    const fed = await wireOf({
      fixtures: [shell("a", 1, limits), shell("b", 2, limits)],
      config: cfg(),
      dependencies: [{ fixtureId: "b", dependsOn: "a" }],
    });
    let strippedShells = 0;
    for (const wire of [twoStages, fed]) {
      for (const f of wire.fixtures) {
        expect(wireRoundFields(f), f.fixtureId).toEqual({ fixtureId: f.fixtureId });
        strippedShells++;
      }
    }
    expect(strippedShells).toBe(5);
  });

  it("X-SW-31 rulings 255-256 placer and verifier agree, and the wire keeps the service's contract (parity)", async ({ task }) => {
    // A fixed-seed corpus: 1-4 courts, 1-3 Swiss sequences (two divisions, a stage each, some pooled; three sequences
    // put two stages in D1, so its rounds are stripped on the wire), each with its own gap (0/0/10/25) and cap (0-3),
    // 1-5 rounds of 1-3 boards, half seated and half unpaired shells, ~10% pinned, 10:00-18:00 sessions on four days in
    // ~70%, a start window on one entrant in ~30%, no zone in ~15%, and round-less noise in a third division.
    //
    // Judges, each on the placer's OWN output:
    //   1. the real verifier (`validateAssignments`): no `order` row;
    //   2. the two limits read off the INPUT (never off the placer's rows): every later-round board starts no earlier
    //      than every earlier-round board's end plus the gap (pin-pin exempt); on every local day (computed with
    //      `Intl`) that holds a movable board of a capped sequence, its distinct rounds are at most the cap (with a
    //      zone);
    //   3. the production road, `buildSchedule` with a solver that captures the wire and then fails (so greedy ships):
    //      no `order` row, the limits hold, and every wire fixture keeps the service's contract — flagged unpaired
    //      exactly when it is an end-barrier fixture with a forwarded round and neither entrants nor people; the gap and
    //      cap beside a forwarded Swiss round only, the cap only with a zone;
    //   4. played rounds handed over in `existing`: the board widened with them (the app's apply gate) is clean and the
    //      limits hold over it.
    let cases = 0;
    let placed = 0;
    let gapPairs = 0;
    let capDays = 0;
    let gapBites = 0;
    let capBites = 0;
    let capRefusals = 0;
    let refusalsNamed = 0;
    let existingCases = 0;
    let wireChecked = 0;
    let wireUnpaired = 0;
    let wireStrippedShells = 0;
    let wireGap = 0;
    let wireCap = 0;
    for (let seed = 1; seed <= CORPUS_SIZE; seed++) {
      const { fixtures, config } = corpusCase(seed);
      const { assignments, conflicts } = slotFixtures({ fixtures, config });
      placed += assignments.length;
      refusalsNamed += refusalsAccountedFor(fixtures, assignments, conflicts, `seed ${seed}`);
      capRefusals += conflicts.filter((c) => c.details?.kind === "no_slot_rounds_per_day").length;
      expect(orderRows(assignments, config), `seed ${seed}: verifier`).toEqual([]);
      const judged = limitBreaches(fixtures, assignments, config.tz);
      expect(judged.breaches, `seed ${seed}: the limits`).toEqual([]);
      gapPairs += judged.gapPairs;
      capDays += judged.capDays;

      let wire: SolveBuildInput | undefined;
      const capture: PlacementSolver = (input) => {
        wire = input;
        return Promise.reject(Object.assign(new Error("captured (test fake)"), { failure: "unavailable" }));
      };
      const built = await buildSchedule({ fixtures, config, solve: capture, log: silentLogger });
      expect(built.conflicts.filter((c) => c.reason === "order"), `seed ${seed}: build`).toEqual([]);
      expect(limitBreaches(fixtures, built.assignments, config.tz).breaches, `seed ${seed}: build limits`).toEqual([]);
      if (wire !== undefined) {
        const counts = wireContract(fixtures, wire, config.tz, `seed ${seed}`);
        wireChecked += counts.checked;
        wireUnpaired += counts.unpaired;
        wireStrippedShells += counts.strippedShells;
        wireGap += counts.gap;
        wireCap += counts.cap;
      }

      // Do the limits BITE here? The same input with each limit removed, judged by the rule.
      const noGap = fixtures.map(({ roundGapMinutes: _g, ...f }) => f);
      if (limitBreaches(fixtures, slotFixtures({ fixtures: noGap, config }).assignments, config.tz).gapBreaches > 0) gapBites++;
      const noCap = fixtures.map(({ roundsPerDayCap: _c, ...f }) => f);
      if (limitBreaches(fixtures, slotFixtures({ fixtures: noCap, config }).assignments, config.tz).capBreaches > 0) capBites++;

      // Played rounds arrive as obstacles in `existing`: a seeded prefix of each sequence's rounds, where this run put
      // them, and the rest placed around them.
      const played = playedPrefix(seed, fixtures);
      if (played.size > 0) {
        const existing = assignments.filter((a) => played.has(a.fixtureId));
        const rest = fixtures.filter((f) => !played.has(f.id));
        const rerun = slotFixtures({ fixtures: rest, config, existing });
        refusalsNamed += refusalsAccountedFor(rest, rerun.assignments, rerun.conflicts, `seed ${seed} existing`);
        const widened = [...rerun.assignments, ...existing];
        expect(roundOrderConflicts(widened, config.tz), `seed ${seed}: existing, widened gate`).toEqual([]);
        expect(limitBreaches(fixtures, widened, config.tz).breaches, `seed ${seed}: existing, the limits`).toEqual([]);
        existingCases++;
      }
      cases++;
    }
    Object.assign(task.meta, {
      corpus: { cases, placed, gapPairs, capDays, gapBites, capBites, capRefusals, refusalsNamed, existingCases, wireChecked, wireUnpaired, wireStrippedShells, wireGap, wireCap },
    });
    // Anti-vacuity: every case judged, and each limit, its refusal, its `existing` read and each wire rule actually
    // exercised in a real share of the corpus (floors at about 80% of the counts measured 2026-11-01, below).
    expect(cases).toBe(CORPUS_SIZE);
    expect(placed).toBeGreaterThan(0);
    expect(gapPairs).toBeGreaterThanOrEqual(GAP_PAIRS_FLOOR);
    expect(capDays).toBeGreaterThanOrEqual(CAP_DAYS_FLOOR);
    expect(gapBites).toBeGreaterThanOrEqual(GAP_BITES_FLOOR);
    expect(capBites).toBeGreaterThanOrEqual(CAP_BITES_FLOOR);
    expect(capRefusals).toBeGreaterThanOrEqual(CAP_REFUSALS_FLOOR);
    expect(existingCases).toBeGreaterThanOrEqual(EXISTING_CASES_FLOOR);
    expect(wireChecked).toBeGreaterThanOrEqual(WIRE_CHECKED_FLOOR);
    expect(wireUnpaired).toBeGreaterThanOrEqual(WIRE_UNPAIRED_FLOOR);
    expect(wireStrippedShells).toBeGreaterThanOrEqual(WIRE_STRIPPED_FLOOR);
    expect(wireGap).toBeGreaterThanOrEqual(WIRE_GAP_FLOOR);
    expect(wireCap).toBeGreaterThanOrEqual(WIRE_CAP_FLOOR);
  }, 180_000);
});

/** A fully proved placement reply: the ladder's own tier names. */
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

/** The request `buildSchedule` sends the solver, `wallSeconds` dropped (it reads the clock); `undefined` when the build
 *  never asked (contradictory pins, say). */
async function wireIfAsked(input: BuildProblem): Promise<Omit<SolveBuildInput, "wallSeconds"> | undefined> {
  let captured: SolveBuildInput | undefined;
  const solve = fakeSolver(async (req) => {
    captured = req;
    return proved([]);
  });
  await buildSchedule({ ...input, solve, log: silentLogger });
  if (captured === undefined) return undefined;
  const { wallSeconds: _clock, ...rest } = captured;
  return rest;
}

/** `wireIfAsked` for a case built to reach the solver. */
async function wireOf(input: BuildProblem): Promise<Omit<SolveBuildInput, "wallSeconds">> {
  const wire = await wireIfAsked(input);
  expect(wire, "the build asked the solver").toBeDefined();
  return wire!;
}

/** The round-order fields of one wire row, absent keys left absent. */
function wireRoundFields(f: { fixtureId: string } & Record<string, unknown>): Record<string, unknown> {
  const keys = ["roundNo", "roundBarrier", "roundGapMinutes", "roundsPerDayCap", "unpairedRoundSlot"];
  return Object.fromEntries([["fixtureId", f.fixtureId], ...keys.filter((k) => f[k] !== undefined).map((k) => [k, f[k]])]);
}

const CORPUS_SIZE = 240;
/** Floors at about 80% of the corpus measured 2026-11-01 (seeds 1-240, identical over three runs): 2,630 cross-round
 *  pairs judged under a gap and 540 capped days with a movable board; the gap binding in 99 cases and the cap in 112 (a
 *  board placed without it breaks it); 28 cards refused `no_slot_rounds_per_day`; 173 cases with played rounds in
 *  `existing`; 2,528 wire fixtures judged, 767 flagged unpaired, 387 unpaired shells whose round was stripped going out
 *  unflagged, 833 carrying a gap and 967 a cap. Low enough that a legitimate placer change does not trip them, high
 *  enough that a corpus which stopped exercising a limit, its refusal, its `existing` read or a wire rule does. */
const GAP_PAIRS_FLOOR = 2100;
const CAP_DAYS_FLOOR = 430;
const GAP_BITES_FLOOR = 80;
const CAP_BITES_FLOOR = 90;
const CAP_REFUSALS_FLOOR = 22;
const EXISTING_CASES_FLOOR = 138;
const WIRE_CHECKED_FLOOR = 2000;
const WIRE_UNPAIRED_FLOOR = 610;
const WIRE_STRIPPED_FLOOR = 310;
const WIRE_GAP_FLOOR = 660;
const WIRE_CAP_FLOOR = 770;

const seqKeyOf = (f: { divisionId?: string; stageId?: string; poolId?: string }): string =>
  `${f.divisionId ?? ""}|${f.stageId ?? ""}|${f.poolId ?? ""}`;

/** The two limits, judged off the INPUT fixtures' own rounds, sequences, pins and values. A board with no fixture in
 *  `fixtures` is ignored. */
function limitBreaches(
  fixtures: readonly SchedulableFixture[],
  board: readonly Assignment[],
  tz: string | undefined,
): { gapPairs: number; capDays: number; gapBreaches: number; capBreaches: number; breaches: string[] } {
  const byId = new Map(fixtures.map((f) => [f.id, f]));
  const rows = board.flatMap((a) => {
    const f = byId.get(a.fixtureId);
    return f?.roundNo !== undefined && f.roundBarrier === "end" ? [{ a, f, roundNo: f.roundNo }] : [];
  });
  let gapPairs = 0;
  let capDays = 0;
  let gapBreaches = 0;
  let capBreaches = 0;
  const breaches: string[] = [];
  for (const earlier of rows) {
    for (const later of rows) {
      if (seqKeyOf(earlier.f) !== seqKeyOf(later.f) || earlier.roundNo >= later.roundNo) continue;
      if (earlier.f.locked !== undefined && later.f.locked !== undefined) continue;
      const g = later.f.roundGapMinutes ?? 0;
      if (g > 0) gapPairs++;
      if (later.a.startAt < earlier.a.endAt + g * MIN) {
        gapBreaches++;
        breaches.push(`${later.f.id} starts before ${earlier.f.id} ends + ${g}`);
      }
    }
  }
  if (tz !== undefined) {
    const days = new Map<string, { cap: number; rounds: Set<number>; movable: boolean }>();
    for (const { a, f, roundNo } of rows) {
      const k = `${seqKeyOf(f)}#${localDay(a.startAt, tz)}`;
      const d = days.get(k) ?? { cap: f.roundsPerDayCap ?? 0, rounds: new Set<number>(), movable: false };
      d.rounds.add(roundNo);
      if (f.locked === undefined) d.movable = true;
      days.set(k, d);
    }
    for (const [k, d] of days) {
      if (d.cap === 0 || !d.movable) continue;
      capDays++;
      if (d.rounds.size > d.cap) {
        capBreaches++;
        breaches.push(`${k} holds ${d.rounds.size} rounds, cap ${d.cap}`);
      }
    }
  }
  return { gapPairs, capDays, gapBreaches, capBreaches, breaches };
}

/** The service's contract, judged on one captured request against the INPUT fixtures. Returns what it checked. */
function wireContract(
  fixtures: readonly SchedulableFixture[],
  wire: SolveBuildInput,
  tz: string | undefined,
  label: string,
): { checked: number; unpaired: number; strippedShells: number; gap: number; cap: number } {
  const byId = new Map(fixtures.map((f) => [f.id, f]));
  let checked = 0;
  let unpaired = 0;
  let strippedShells = 0;
  let gapN = 0;
  let capN = 0;
  for (const w of wire.fixtures) {
    const f = byId.get(w.fixtureId)!;
    const at = `${label}: ${w.fixtureId}`;
    const empty = w.entrantIds.length === 0 && (w.people ?? []).length === 0;
    const swiss = w.roundNo !== undefined && w.roundBarrier === "end";
    // The service refuses a flagged slot without a round, and refuses an unflagged fixture with nobody in it.
    expect(w.unpairedRoundSlot === true, at).toBe(swiss && empty);
    if (w.unpairedRoundSlot === true) unpaired++;
    if (f.roundBarrier === "end" && f.roundNo !== undefined && w.roundNo === undefined && empty) strippedShells++;
    expect(w.roundGapMinutes, `${at} gap`).toBe(swiss && (f.roundGapMinutes ?? 0) > 0 ? f.roundGapMinutes : undefined);
    expect(w.roundsPerDayCap, `${at} cap`).toBe(
      swiss && tz !== undefined && (f.roundsPerDayCap ?? 0) > 0 ? f.roundsPerDayCap : undefined,
    );
    if (w.roundGapMinutes !== undefined) gapN++;
    if (w.roundsPerDayCap !== undefined) capN++;
    checked++;
  }
  return { checked, unpaired, strippedShells, gap: gapN, cap: capN };
}

/** Every fixture missing from `board` has a refusal row in `conflicts`; returns how many it checked. */
function refusalsAccountedFor(
  fixtures: readonly SchedulableFixture[],
  board: readonly Assignment[],
  conflicts: readonly Conflict[],
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

/** A seeded prefix of rounds per sequence (0 to all-but-the-last), standing for rounds already played. */
function playedPrefix(seed: number, fixtures: readonly SchedulableFixture[]): Set<string> {
  const r = mulberry32(seed * 104729);
  const lastRound = new Map<string, number>();
  for (const f of fixtures) {
    if (f.roundBarrier !== "end" || f.roundNo === undefined) continue;
    lastRound.set(seqKeyOf(f), Math.max(lastRound.get(seqKeyOf(f)) ?? 0, f.roundNo));
  }
  const upTo = new Map([...lastRound].map(([key, last]) => [key, Math.floor(r() * last)]));
  return new Set(fixtures.filter((f) => f.roundNo !== undefined && f.roundNo <= (upTo.get(seqKeyOf(f)) ?? 0)).map((f) => f.id));
}

function corpusCase(seed: number): { fixtures: SchedulableFixture[]; config: Cfg } {
  const r = mulberry32(seed * 6151);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const courts = ["C1", "C2", "C3", "C4"].slice(0, 1 + Math.floor(r() * 4));
  const withSessions = r() < 0.7;
  const fixtures: SchedulableFixture[] = [];
  const sequences = 1 + Math.floor(r() * 3);
  for (let s = 0; s < sequences; s++) {
    const seq = { divisionId: `D${1 + (s % 2)}`, stageId: `S${s}`, ...(r() < 0.3 ? { poolId: "P1" } : {}) };
    const g = pick([0, 0, 10, 25]);
    const k = pick([0, 1, 2, 3]);
    const limits = { ...(g > 0 ? gap(g) : {}), ...(k > 0 ? cap(k) : {}) };
    const rounds = 1 + Math.floor(r() * 5);
    for (let round = 1; round <= rounds; round++) {
      const boards = 1 + Math.floor(r() * 3);
      for (let b = 0; b < boards; b++) {
        const seated = r() < 0.5;
        const home = `s${s}e${Math.floor(r() * 4)}`;
        const away = `s${s}e${4 + Math.floor(r() * 4)}`;
        const pinned = r() < 0.1;
        // A pin inside the first three days' sessions when there are sessions, else in the first three hours.
        const lockedAt = {
          court: pick(courts),
          startAt: withSessions
            ? T0 + (Math.floor(r() * 3) * DAY + Math.floor(r() * 28) * 15) * MIN
            : T0 + Math.floor(r() * 12) * 15 * MIN,
        };
        fixtures.push({
          id: `s${s}-r${round}-b${b}`,
          roundNo: round,
          roundBarrier: "end",
          ...seq,
          ...limits,
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
      ...(withSessions ? { sessionWindows: sessions(4) } : {}),
      window: { from: T0, to: T0 + 5 * DAY * MIN },
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
