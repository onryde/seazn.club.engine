// Greedy's seed honours `current` (seazn.club smoke #401, engine 6.0.x).
//
// THE DEFECT. A knockout repair: both semis played and caller-frozen, the final
// and the 3rd-place match — TBD, so each carries all four people — clashing side
// by side at 09:30 on courts A and B. `build.ts` forwards a dependency edge to the
// solver only when BOTH ends are movable, so with the semis frozen the solver
// never hears "after the semis" and proposes a board with both lines BEFORE them.
// The verifier rejects it and the repair ships `greedy("verifier_rejected")`.
// That seed (`slotFixtures`) ordered same-round lines by fixture id and ignored
// `current`; fixture ids are random uuids, so in about half of all draws it put
// the line the organiser had on court B onto court A — moving BOTH lines (moved 2,
// minimality `upper_bound`) where the problem's own minimum is one move.
//
// THE FIX. With `current`, the seed orders same-round lines by their slot there
// (start, then court order in `config.courts`) before falling back to the id.
//
// THE SOLVER here is a fake that enumerates the free lines' placements over the
// earliest court-free slots of the wire grid and takes the earliest board —
// exactly the frozen-feeder straddle the real CP-SAT produced in the
// investigation (both lines at 08:00/08:30, before the semis), so the path under
// test is the real `verifier_rejected` fallback (asserted from the log).
//
// Single-sport on purpose: the seed's order reads only `roundNo`, the board and
// the court list, never a sport rule.
import { describe, expect, it } from "vitest";
import { buildSchedule, TIER_NAMES } from "../build.ts";
import { slotFixtures, type Assignment, type OrderDependency, type SchedulableFixture, type SlotConfig } from "../calendar.ts";
import { repairDecomposedCpsat } from "../repair-decompose-cpsat.ts";
import type { PlacementSolver, SolveBuildInput } from "../solver-port.ts";
import { fakeSolver, recordingLogger, silentLogger } from "./solver-fakes.ts";

const MIN = 60_000;
const T = (h: number, m: number) => Date.UTC(2026, 9, 8, h, m);
const PEOPLE = ["pA", "pB", "pC", "pD"];
// "aaa" < "zzz": an id-ordered seed always places aaa first.
const LO = "aaa";
const HI = "zzz";

const config: SlotConfig & { courts: string[] } = {
  startAt: T(0, 0),
  matchMinutes: 30,
  gapMinutes: 0,
  courts: ["A", "B"],
  perEntrantMinRest: 0,
  tz: "UTC",
};

const row = (fixtureId: string, court: string, startAt: number, people: string[], entrants: string[] = []): Assignment => ({
  fixtureId,
  court,
  startAt,
  endAt: startAt + 30 * MIN,
  entrants,
  people,
});

const semis: Assignment[] = [
  row("s1", "A", T(9, 0), ["pA", "pD"], ["eA", "eD"]),
  row("s2", "B", T(9, 0), ["pB", "pC"], ["eB", "eC"]),
];
const fixtures: SchedulableFixture[] = [
  { id: "s1", home: "eA", away: "eD", people: ["pA", "pD"] },
  { id: "s2", home: "eB", away: "eC", people: ["pB", "pC"] },
  { id: LO, people: PEOPLE },
  { id: HI, people: PEOPLE },
];
const lines = fixtures.filter((f) => f.id === LO || f.id === HI);
const dependencies: OrderDependency[] = [LO, HI].flatMap((fixtureId) =>
  ["s1", "s2"].map((dependsOn) => ({ fixtureId, dependsOn, direct: true })),
);

/** The organiser's clashing board: `first` on court A, `second` on court B, both at 09:30. */
const clashing = (first: string, second: string): Assignment[] => [row(first, "A", T(9, 30), PEOPLE), row(second, "B", T(9, 30), PEOPLE)];

/** A proved, earliest-first solver that sees only what the wire carries: court
 *  clashes with `existing` and person clashes among the free lines. It is never
 *  told the frozen semis feed the lines, so its board straddles them. */
const earliestSolver: PlacementSolver = fakeSolver((input: SolveBuildInput) => {
  const span = 30 * MIN;
  type Pick = { i: number; court: string; s: number };
  const boards: Pick[][] = [];
  const busy = (court: string, s: number, taken: readonly Pick[]) =>
    [...input.existing.map((e) => ({ court: e.court, s: e.startAtMs })), ...taken].some((o) => o.court === court && Math.abs(o.s - s) < span);
  // Earliest-first never needs a late slot: the free lines number at most two
  // here, so the first few court-free slots hold the optimum. Enumerating the
  // whole day's grid made one repair take ~20 s.
  const early = [...input.grid.slots]
    .filter((sl) => !busy(sl.court, sl.startAtMs, []))
    .sort((a, b) => a.startAtMs - b.startAtMs)
    .slice(0, 4 * input.fixtures.length + 4);
  const rec = (i: number, taken: Pick[]) => {
    if (i === input.fixtures.length) return void boards.push(taken);
    for (const sl of early) {
      if (busy(sl.court, sl.startAtMs, taken)) continue;
      const mine = input.fixtures[i]!.people ?? [];
      if (taken.some((t) => Math.abs(t.s - sl.startAtMs) < span && (input.fixtures[t.i]!.people ?? []).some((p) => mine.includes(p)))) continue;
      rec(i + 1, [...taken, { i, court: sl.court, s: sl.startAtMs }]);
    }
  };
  rec(0, []);
  expect(boards.length).toBeGreaterThan(0);
  const key = (b: readonly Pick[]): (number | string)[] => {
    const starts = b.map((t) => t.s);
    return [Math.min(...starts), Math.max(...starts) - Math.min(...starts), -new Set(b.map((t) => t.court)).size, ...starts, ...b.map((t) => t.court)];
  };
  const cmp = (a: readonly (number | string)[], b: readonly (number | string)[]) => {
    for (let k = 0; k < a.length; k++) if (a[k]! !== b[k]!) return a[k]! < b[k]! ? -1 : 1;
    return 0;
  };
  const best = boards.sort((a, b) => cmp(key(a), key(b)))[0]!;
  return Promise.resolve({
    assignments: best.map((t) => ({ fixtureId: input.fixtures[t.i]!.fixtureId, court: t.court, startAtMs: t.s })),
    status: "OPTIMAL" as const,
    tiersCompleted: TIER_NAMES.length,
    objectiveValues: TIER_NAMES.map((name) => ({ name, value: 0 })),
    elapsedMs: 5,
    wallExhausted: false,
  });
});
const noService: PlacementSolver = fakeSolver(() => Promise.reject(new Error("no service")));

/** Both id orders: the organiser's court-A line is the lower id, then the higher. */
const ORDERS = [
  [LO, HI],
  [HI, LO],
] as const;

describe("a knockout repair whose solver board straddles frozen feeders moves one line in either id order (#401)", () => {
  it("moved 1, minimality proved, the court-A line stays — checked 2 orders", async () => {
    let checked = 0;
    for (const [first, second] of ORDERS) {
      const { lines: logged, log } = recordingLogger();
      const r = await repairDecomposedCpsat({
        fixtures,
        proposal: [...semis, ...clashing(first, second)],
        callerFrozen: new Set(["s1", "s2"]),
        dependencies,
        config,
        budgetMs: 20_000,
        solve: earliestSolver,
        log,
      });
      // The seed shipped because the verifier rejected the solver's board —
      // not because a legal solver board happened to be the one-move board.
      expect(logged.filter((l) => l.level === "error" && l.message.includes("verifier rejected")).length).toBe(1);
      expect({ first, status: r.status, moved: r.moved, verdict: r.minimality.verdict, lowerBound: r.minimality.lowerBound }).toEqual({
        first,
        status: "repaired",
        moved: [second],
        verdict: "proved",
        lowerBound: 1,
      });
      expect(r.assignments.find((a) => a.fixtureId === first)).toMatchObject({ court: "A", startAt: T(9, 30) });
      checked++;
    }
    expect(checked).toBe(2);
  });
});

describe("the seed reads current's slot order for same-round lines", () => {
  it("buildSchedule's greedy seed keeps current's court-A line at 09:30 and moves only the other — checked 2 orders", async () => {
    let checked = 0;
    for (const [first, second] of ORDERS) {
      const seed = await buildSchedule({
        fixtures: lines,
        config,
        existing: semis,
        dependencies,
        current: clashing(first, second),
        solve: noService,
        log: silentLogger,
      });
      expect(seed.engine).toBe("greedy");
      expect(seed.moved).toBe(1);
      const at = (id: string) => seed.assignments.find((a) => a.fixtureId === id);
      expect(at(first)).toMatchObject({ court: "A", startAt: T(9, 30) });
      expect(at(second)).toMatchObject({ court: "A", startAt: T(10, 0) });
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("orders by start before court: a later court-A line follows an earlier court-B line", () => {
    // HI sits earlier (on B), LO later (on A): start wins over court order.
    const current = [row(LO, "A", T(10, 0), PEOPLE), row(HI, "B", T(9, 30), PEOPLE)];
    const seed = slotFixtures({ fixtures: lines, config, existing: semis, dependencies, current });
    expect(seed.assignments.map((a) => a.fixtureId)).toEqual([HI, LO]);
  });

  it("orders by court order in config.courts, not court label, at one start", () => {
    // Courts listed B before A: the line on B at 09:30 ranks first.
    const reversed = { ...config, courts: ["B", "A"] };
    const seed = slotFixtures({ fixtures: lines, config: reversed, existing: semis, dependencies, current: clashing(LO, HI) });
    expect(seed.assignments.map((a) => a.fixtureId)).toEqual([HI, LO]);
  });

  it("lines absent from current sort after those present, still by id among themselves", () => {
    const three: SchedulableFixture[] = [
      { id: "mmm", people: ["p1", "p2"] },
      { id: "bbb", people: ["p3", "p4"] },
      { id: "yyy", people: ["p5", "p6"] },
    ];
    const oneCourt = { ...config, courts: ["A"] };
    const seed = slotFixtures({ fixtures: three, config: oneCourt, current: [row("yyy", "A", T(9, 0), ["p5", "p6"])] });
    expect(seed.assignments.map((a) => a.fixtureId)).toEqual(["yyy", "bbb", "mmm"]);
  });

  it("never crosses rounds: current's order applies only within one roundNo", () => {
    const rounds: SchedulableFixture[] = [
      { id: "r1", people: ["p1", "p2"], roundNo: 1 },
      { id: "r2", people: ["p3", "p4"], roundNo: 2 },
    ];
    const oneCourt = { ...config, courts: ["A"] };
    // current puts round 2 first; round order still wins.
    const current = [row("r2", "A", T(9, 0), ["p3", "p4"]), row("r1", "A", T(9, 30), ["p1", "p2"])];
    const seed = slotFixtures({ fixtures: rounds, config: oneCourt, current });
    expect(seed.assignments.map((a) => a.fixtureId)).toEqual(["r1", "r2"]);
  });
});

describe("current's guards: an unlisted court and a repeated id", () => {
  it("a court not in config.courts ranks after every listed court at one start", () => {
    // LO on "X" (deleted from config, still on the organiser's board), HI on B.
    const current = [row(LO, "X", T(9, 30), PEOPLE), row(HI, "B", T(9, 30), PEOPLE)];
    const seed = slotFixtures({ fixtures: lines, config, existing: semis, dependencies, current });
    expect(seed.assignments.map((a) => a.fixtureId)).toEqual([HI, LO]);
  });

  it("a repeated id ranks by its FIRST row", () => {
    // LO listed twice: first at 10:00, then at 09:00. HI at 09:30. First row wins ⇒ HI, LO.
    const current = [row(LO, "A", T(10, 0), PEOPLE), row(HI, "A", T(9, 30), PEOPLE), row(LO, "A", T(9, 0), PEOPLE)];
    const seed = slotFixtures({ fixtures: lines, config, existing: semis, dependencies, current });
    expect(seed.assignments.map((a) => a.fixtureId)).toEqual([HI, LO]);
  });
});

describe("no current: the seed is exactly as before", () => {
  it("absent and empty current both give the id-ordered seed (aaa on A 09:30, zzz on A 10:00)", async () => {
    let checked = 0;
    for (const current of [undefined, []] as const) {
      const seed = await buildSchedule({
        fixtures: lines,
        config,
        existing: semis,
        dependencies,
        ...(current === undefined ? {} : { current }),
        solve: noService,
        log: silentLogger,
      });
      expect(seed.engine).toBe("greedy");
      expect(seed.assignments.map((a) => `${a.fixtureId}@${a.court}${a.startAt}`)).toEqual([`${LO}@A${T(9, 30)}`, `${HI}@A${T(10, 0)}`]);
      expect(seed.moved).toBe(0);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("slotFixtures with current omitted and with current: [] place identically", () => {
    const a = slotFixtures({ fixtures: lines, config, existing: semis, dependencies });
    const b = slotFixtures({ fixtures: lines, config, existing: semis, dependencies, current: [] });
    expect(b).toEqual(a);
    expect(a.assignments.map((x) => x.fixtureId)).toEqual([LO, HI]);
  });
});
