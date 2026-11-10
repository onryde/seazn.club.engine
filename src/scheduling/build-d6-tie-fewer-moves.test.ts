// D6's tie, measured against the organiser's board (seazn.club smoke #401).
//
// THE DEFECT. `solveBuild` ships greedy's seed whenever the solver's proved
// board ties it on every rung of the ladder (`already_optimal`). That is right
// for a BUILD — a tie is churn — but greedy ignores `current`: it orders sibling
// lines by fixture id (`slotFixtures`). Since 6.0.1 bounds a fed line by its
// existing feeders, the seed is LEGAL in a bracket repair where it used to be
// disqualified, so it reaches the tie and ships. When the organiser's board had
// the HIGHER-id sibling on the first court, the seed moves both siblings where
// the solver's tied board moves one — and the repair's minimality reads
// `upper_bound` instead of `proved`.
//
// THE RIG is the smoke's: a 4-entrant knockout, both semis played (caller-frozen),
// the final and the 3rd-place match — TBD, so each carries all four people — side
// by side on two courts at the same instant, a person clash. Repair window from
// 00:00 of the day. Run in BOTH id orders.
//
// WHY ONE MOVE. The two TBD lines share every person and sit at the same
// instant, so they cannot both stay; moving either one to the next half hour
// clears it. One collision, one move — that is the problem's own minimum, and
// `disjointConflictBound` must agree (asserted below, not assumed).
//
// Single-sport on purpose: the gate reads only board geometry and the ladder,
// never a sport rule, so a sport sweep would run the same arithmetic N times.
import { describe, expect, it } from "vitest";
import { buildSchedule, TIER_COUNT, TIER_NAMES } from "./build.ts";
import { isBlockingConflict, type Assignment, type OrderDependency, type SchedulableFixture, type SlotConfig } from "./calendar.ts";
import { repairDecomposedCpsat } from "./repair-decompose-cpsat.ts";
import type { PlacementSolver, SolveBuildOutcome } from "./solver-port.ts";
import { fakeSolver, silentLogger } from "./__tests__/solver-fakes.ts";

const MIN = 60_000;
const T = (h: number, m: number) => Date.UTC(2026, 9, 8, h, m);
const PEOPLE = ["pA", "pB", "pC", "pD"];

// "tbd-1" < "tbd-2": greedy places tbd-1 first.
const LO = "tbd-1";
const HI = "tbd-2";

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
const dependencies: OrderDependency[] = [
  { fixtureId: LO, dependsOn: "s1", direct: true },
  { fixtureId: LO, dependsOn: "s2", direct: true },
  { fixtureId: HI, dependsOn: "s1", direct: true },
  { fixtureId: HI, dependsOn: "s2", direct: true },
];
const tbdFixtures: SchedulableFixture[] = [
  { id: LO, people: PEOPLE, roundNo: 2 },
  { id: HI, people: PEOPLE, roundNo: 2 },
];
const allFixtures: SchedulableFixture[] = [
  { id: "s1", people: ["pA", "pD"], roundNo: 1 },
  { id: "s2", people: ["pB", "pC"], roundNo: 1 },
  ...tbdFixtures,
];

/** The organiser's clashing board: `first` on court A, `second` on court B, both at 09:30. */
const clashing = (first: string, second: string): Assignment[] => [
  row(first, "A", T(9, 30), PEOPLE),
  row(second, "B", T(9, 30), PEOPLE),
];

/** A proved reply on OUR ladder. */
const proved = (assignments: SolveBuildOutcome["assignments"]): SolveBuildOutcome => ({
  assignments,
  status: "OPTIMAL",
  tiersCompleted: TIER_COUNT,
  objectiveValues: TIER_NAMES.map((name, i) => ({ name, value: i })),
  elapsedMs: 5,
  wallExhausted: false,
});

/** The one-move board: the line already on court A stays, the other goes to the
 *  next half hour behind it. It is greedy's seed with the two ids swapped —
 *  the MIRROR, so it ties the seed on every rung by construction (no rung reads
 *  a fixture id), which is exactly the tie this file is about. */
const oneMoveReply = (stays: string, moves: string): PlacementSolver =>
  fakeSolver(() =>
    Promise.resolve(
      proved([
        { fixtureId: stays, court: "A", startAtMs: T(9, 30) },
        { fixtureId: moves, court: "A", startAtMs: T(10, 0) },
      ]),
    ),
  );
const noService: PlacementSolver = fakeSolver(() => Promise.reject(new Error("no service")));

describe("the rig's premises, asserted", () => {
  it("greedy's seed puts the LOWER id on court A at 09:30 whatever the organiser had", async () => {
    let checked = 0;
    for (const [first, second] of [
      [HI, LO],
      [LO, HI],
    ] as const) {
      const seed = await buildSchedule({
        fixtures: tbdFixtures,
        config,
        existing: semis,
        dependencies,
        current: clashing(first, second),
        solve: noService,
        log: silentLogger,
      });
      expect(seed.engine).toBe("greedy");
      const at = (id: string) => seed.assignments.find((a) => a.fixtureId === id);
      expect(at(LO)).toMatchObject({ court: "A", startAt: T(9, 30) });
      expect(at(HI)).toMatchObject({ court: "A", startAt: T(10, 0) });
      checked++;
    }
    expect(checked).toBe(2);
  });
});

describe("a repair whose proved board ties greedy ships the board that moves fewer fixtures", () => {
  const cases = [
    { name: "(a) the HIGHER-id sibling on the first court", first: HI, second: LO },
    { name: "(b) the LOWER-id sibling on the first court", first: LO, second: HI },
  ] as const;

  for (const { name, first, second } of cases) {
    it(`${name}: moved 1, minimality proved`, async () => {
      const current = clashing(first, second);
      const proposal = [...semis, ...current];

      const r = await repairDecomposedCpsat({
        fixtures: allFixtures,
        proposal,
        callerFrozen: new Set(["s1", "s2"]),
        config,
        dependencies,
        solve: oneMoveReply(first, second),
        log: silentLogger,
      });

      // The problem's own minimum, agreed by the independent bound.
      expect(r.minimality.lowerBound).toBe(1);
      expect(r.status).toBe("repaired");
      expect(r.k).toBe(1);
      expect(r.moved).toEqual([second]);
      expect(r.minimality.verdict).toBe("proved");
      // The line that was on court A did not move.
      expect(r.assignments.find((a) => a.fixtureId === first)).toMatchObject({ court: "A", startAt: T(9, 30) });
    });

    it(`${name}: buildSchedule reports moved 1 against current, and the ladder is no worse than greedy`, async () => {
      const current = clashing(first, second);
      const seed = await buildSchedule({
        fixtures: tbdFixtures,
        config,
        existing: semis,
        dependencies,
        current,
        solve: noService,
        log: silentLogger,
      });
      const out = await buildSchedule({
        fixtures: tbdFixtures,
        config,
        existing: semis,
        dependencies,
        current,
        solve: oneMoveReply(first, second),
        log: silentLogger,
      });

      expect(out.moved).toBe(1);
      expect(out.lost).toBe(0);
      expect(out.conflicts.filter(isBlockingConflict)).toEqual([]);
      // D6: never worse than greedy on the ladder. A tie on every rung.
      expect(out.metrics.placed).toBe(seed.metrics.placed);
      expect(out.metrics.placed).toBe(2);
      expect(out.tiersCompleted).toBe(TIER_COUNT);
    });
  }
});

describe("no current: the gate behaves exactly as before", () => {
  it("keeps greedy's seed as already_optimal on the same tied reply", async () => {
    // The empty case. With nothing to have moved from, both boards move 0, so
    // the tie keeps today's preference: the seed, `already_optimal`.
    const out = await buildSchedule({
      fixtures: tbdFixtures,
      config,
      existing: semis,
      dependencies,
      solve: oneMoveReply(HI, LO),
      log: silentLogger,
    });

    expect(out.engine).toBe("greedy");
    expect(out.status).toBe("already_optimal");
    expect(out.moved).toBe(0);
    expect(out.assignments.find((a) => a.fixtureId === LO)).toMatchObject({ court: "A", startAt: T(9, 30) });
  });

  it("with current EQUAL to the seed, the tie keeps the seed (it is the board that moves fewer)", async () => {
    // (b)'s board after greedy: the seed moves 0 from it, the mirror moves 2.
    const current = [row(LO, "A", T(9, 30), PEOPLE), row(HI, "A", T(10, 0), PEOPLE)];
    const out = await buildSchedule({
      fixtures: tbdFixtures,
      config,
      existing: semis,
      dependencies,
      current,
      solve: oneMoveReply(HI, LO),
      log: silentLogger,
    });

    expect(out.engine).toBe("greedy");
    expect(out.status).toBe("already_optimal");
    expect(out.moved).toBe(0);
  });
});
