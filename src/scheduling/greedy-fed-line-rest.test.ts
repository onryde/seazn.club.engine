// Greedy must start a FED line no earlier than its feeders' end PLUS the rest
// its own verifier owes it.
//
// D2 of the rest-placement investigation (2026-11-09). When the placement
// service refuses a bracket (a seatless later-round shell carries no entrants
// and no people, which the service rejects as an invalid request), the build
// falls back to greedy. `slotFixtures` bounded a dependent by its feeders' END
// only, while `validateAssignments` demands END + `effectiveRestMinutes(config,
// target)` and reports `order_inside_feeder_rest` otherwise. `greedySeed` runs
// that verifier over greedy's own seed and drops every fixture it flags, so at
// ANY rest above 0 every fed line vanished: 2 of 3 placed at n=4, 4 of 7 at n=8.
//
// The shapes come from the engine's own bracket generators, and the edges from
// their `homeFrom`/`awayFrom` refs, exactly the edges the app stores as
// `winner_to_fixture`/`loser_to_fixture` and hands back as `dependencies`. The
// rest each case owes is read off the CONFIG field that sets it (rest-floor's
// four sources), never off the code under test.
//
// One sport only, on purpose: the placer reads no sport field, so a registry
// sweep would vary nothing.
import { describe, expect, it } from "vitest";
import { buildSchedule } from "./build.ts";
import {
  generateDoubleElim,
  generatePagePlayoff,
  generateSingleElim,
  generateStepladder,
  type GeneratedBracket,
} from "./bracket.ts";
import {
  slotFixtures,
  validateAssignments,
  type Assignment,
  type OrderDependency,
  type SchedulableFixture,
  type SlotConfig,
} from "./calendar.ts";
import { SchedulingConstraints } from "./constraints.ts";
import { silentLogger, unavailableSolver } from "./__tests__/solver-fakes.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 9, 9, 0);
const MATCH = 30;

type Cfg = SlotConfig & { courts: string[] };

const cfg = (over: Partial<Cfg> = {}): Cfg => ({
  startAt: T0,
  matchMinutes: MATCH,
  gapMinutes: 0,
  courts: ["c1", "c2"],
  perEntrantMinRest: 0,
  window: { from: T0, to: T0 + 7 * 24 * 60 * MIN },
  ...over,
});

const entrants = (n: number): string[] => Array.from({ length: n }, (_, i) => `e${i + 1}`);

/** A generated bracket as the app hands it to the build: every line that is
 *  not a bye award, carrying its concrete seats only (a fed seat is unknown
 *  until its feeder is decided), and one direct edge per feed ref. `stageOf`
 *  lets a case put a line in another stage (a cross-stage feed). */
function schedulable(
  bracket: GeneratedBracket,
  stageOf: (id: string) => string = () => "s1",
): { fixtures: SchedulableFixture[]; dependencies: OrderDependency[] } {
  const lines = bracket.fixtures.filter((f) => f.award === undefined);
  const ids = new Set(lines.map((f) => f.id));
  const fixtures: SchedulableFixture[] = lines.map((f) => ({
    id: f.id,
    divisionId: "d1",
    stageId: stageOf(f.id),
    ...(f.home !== undefined ? { home: f.home } : {}),
    ...(f.away !== undefined ? { away: f.away } : {}),
  }));
  const dependencies: OrderDependency[] = lines.flatMap((f) =>
    [f.homeFrom, f.awayFrom]
      .filter((ref): ref is NonNullable<typeof ref> => ref !== undefined && ids.has(ref.fixtureId))
      .map((ref) => ({ fixtureId: f.id, dependsOn: ref.fixtureId, direct: true })),
  );
  return { fixtures, dependencies };
}

/** Every edge whose two ends are on the board: how many were checked, and the
 *  ones whose dependent starts inside `restMinutes` of its feeder's end. */
function feedGaps(board: readonly Assignment[], dependencies: readonly OrderDependency[], restMinutes: number) {
  const by = new Map(board.map((a) => [a.fixtureId, a] as const));
  let checked = 0;
  const short: string[] = [];
  for (const d of dependencies) {
    const target = by.get(d.fixtureId);
    const source = by.get(d.dependsOn);
    if (target === undefined || source === undefined) continue;
    checked += 1;
    if (target.startAt < source.endAt + restMinutes * MIN) {
      short.push(`${d.dependsOn} -> ${d.fixtureId}: ${(target.startAt - source.endAt) / MIN} min`);
    }
  }
  return { checked, short };
}

const build = (
  fixtures: SchedulableFixture[],
  config: Cfg,
  dependencies: OrderDependency[],
  existing: Assignment[] = [],
) => buildSchedule({ fixtures, config, dependencies, existing, solve: unavailableSolver, log: silentLogger });

describe("greedy fallback: a fed bracket line starts after its feeders' rest", () => {
  const four = schedulable(generateSingleElim({ entrants: entrants(4) }));
  const semis = four.dependencies.map((d) => d.dependsOn);
  const finalId = four.dependencies[0]!.fixtureId;

  it("places all 3 lines of a 4-entrant bracket at rest 30, the final exactly 30 min after the later semi", async () => {
    const REST = 30;
    expect(four.fixtures).toHaveLength(3);
    expect(new Set(semis).size).toBe(2);

    const built = await build(four.fixtures, cfg({ perEntrantMinRest: REST }), four.dependencies);

    expect(built.engine).toBe("greedy");
    expect(built.status).toBe("solver_unavailable");
    expect(built.metrics.placed).toBe(3);
    expect(built.conflicts.filter((c) => c.reason === "order")).toEqual([]);
    const by = new Map(built.assignments.map((a) => [a.fixtureId, a] as const));
    const laterSemiEnd = Math.max(...semis.map((id) => by.get(id)!.endAt));
    // Two free courts and nothing else on the board: the earliest legal start
    // is the floor itself, so anything later is an over-delay, not slack.
    expect(by.get(finalId)!.startAt).toBe(laterSemiEnd + REST * MIN);
  });

  it("rest 0 control: the final still starts at the later semi's final whistle", async () => {
    const built = await build(four.fixtures, cfg({ perEntrantMinRest: 0 }), four.dependencies);

    expect(built.metrics.placed).toBe(3);
    const by = new Map(built.assignments.map((a) => [a.fixtureId, a] as const));
    const laterSemiEnd = Math.max(...semis.map((id) => by.get(id)!.endAt));
    expect(by.get(finalId)!.startAt).toBe(laterSemiEnd);
  });

  it("places all 7 lines of an 8-entrant bracket at rest 30", async () => {
    const REST = 30;
    const eight = schedulable(generateSingleElim({ entrants: entrants(8) }));
    expect(eight.fixtures).toHaveLength(7);

    const built = await build(eight.fixtures, cfg({ perEntrantMinRest: REST }), eight.dependencies);

    expect(built.metrics.placed).toBe(7);
    const gaps = feedGaps(built.assignments, eight.dependencies, REST);
    expect(gaps.checked).toBe(6); // two edges into each of the 2 semis and the final
    expect(gaps.short).toEqual([]);
  });

  it("slotFixtures' own board passes its own verifier on the feed-order family (dependencies passed as dependencies)", () => {
    const REST = 30;
    const config = cfg({ perEntrantMinRest: REST });
    const out = slotFixtures({ fixtures: four.fixtures, config, dependencies: four.dependencies });

    expect(out.assignments).toHaveLength(3);
    const order = validateAssignments(out.assignments, config, [], four.dependencies).filter(
      (c) => c.reason === "order",
    );
    expect(order).toEqual([]);
  });
});

describe("every fed shape the generators make, under every rest source", () => {
  const shapes: { name: string; make: () => ReturnType<typeof schedulable> }[] = [
    { name: "single elimination, 4", make: () => schedulable(generateSingleElim({ entrants: entrants(4) })) },
    { name: "single elimination, 8", make: () => schedulable(generateSingleElim({ entrants: entrants(8) })) },
    {
      name: "single elimination + third place (loser feeds)",
      make: () => schedulable(generateSingleElim({ entrants: entrants(4), thirdPlace: true })),
    },
    {
      name: "third place in a second stage (cross-stage loser feed)",
      make: () =>
        schedulable(generateSingleElim({ entrants: entrants(4), thirdPlace: true }), (id) =>
          id.endsWith("-3p") ? "s2" : "s1",
        ),
    },
    {
      name: "double elimination + bracket reset",
      make: () => schedulable(generateDoubleElim({ entrants: entrants(4), bracketReset: true })),
    },
    { name: "page playoff", make: () => schedulable(generatePagePlayoff({ entrants: entrants(4) })) },
    { name: "stepladder (fed rungs carry a seated home)", make: () => schedulable(generateStepladder({ entrants: entrants(5) })) },
  ];

  // Each source alone, so the expected minutes are that field's own value —
  // and three of them differ from `perEntrantMinRest`, so a floor that read
  // only the Settings field would be caught.
  const sources: { name: string; config: Cfg; restMinutes: number }[] = [
    { name: "perEntrantMinRest 30", config: cfg({ perEntrantMinRest: 30 }), restMinutes: 30 },
    {
      name: "constraints.restMin 45",
      config: cfg({ constraints: SchedulingConstraints.parse({ restMin: 45 }) }),
      restMinutes: 45,
    },
    {
      name: "constraints.restByGroup d1 40",
      config: cfg({ constraints: SchedulingConstraints.parse({ restByGroup: { d1: 40 } }) }),
      restMinutes: 40,
    },
    {
      // "At least one whole fixture in between": the match plus the court gap.
      name: "constraints.noBackToBack (30 + gap 5)",
      config: cfg({ gapMinutes: 5, constraints: SchedulingConstraints.parse({ noBackToBack: true }) }),
      restMinutes: MATCH + 5,
    },
  ];

  let totalChecked = 0;
  for (const shape of shapes) {
    for (const source of sources) {
      it(`${shape.name} — ${source.name}: every line placed, every fed line after its feeders' rest`, async () => {
        const { fixtures, dependencies } = shape.make();
        expect(dependencies.length).toBeGreaterThan(0);

        const built = await build(fixtures, source.config, dependencies);

        expect(built.engine).toBe("greedy");
        expect(built.metrics.placed).toBe(fixtures.length);
        const gaps = feedGaps(built.assignments, dependencies, source.restMinutes);
        expect(gaps.short).toEqual([]);
        expect(gaps.checked).toBe(dependencies.length);
        expect(
          validateAssignments(built.assignments, source.config, [], dependencies).filter((c) => c.reason === "order"),
        ).toEqual([]);
        totalChecked += gaps.checked;
      });
    }
  }

  it("anti-vacuity: the sweep above checked fed edges in every case", () => {
    // Runs after the sweep (file order, isolate:false does not reorder a file).
    expect(totalChecked).toBeGreaterThan(shapes.length * sources.length);
  });
});

// The same floor when the feeder is not this pass's to place. A PINNED feeder
// (`locked`, the organiser's own slot) and a feeder already on the board
// (`existing`, another pass's or another division's row) both bind the
// verifier's feed check, which reads the whole board. The placer used to read
// only feeds between two MOVABLE lines, so with the semis pinned at 11:00 Auto
// put the final at 09:00, the verifier reported `order_before_feeder`, and
// the seed dropped the final: at rest 0 as much as at rest 30.
describe("a fed line whose feeders are pinned or already on the board", () => {
  const four = schedulable(generateSingleElim({ entrants: entrants(4) }));
  const semis = [...new Set(four.dependencies.map((d) => d.dependsOn))];
  const finalId = four.dependencies[0]!.fixtureId;
  /** Two hours after the build may start: well clear of where greedy would put
   *  an unbounded final, so "placed before its feeders" cannot pass by luck. */
  const PIN = T0 + 120 * MIN;
  const pinnedEnd = PIN + MATCH * MIN;
  const checked = { pinned: 0, existing: 0 };

  /** The edges whose feeder is a row this pass did not place. */
  const feedsFrom = (rows: readonly Assignment[]) => {
    const fixed = new Set(rows.filter((a) => a.movable === false).map((a) => a.fixtureId));
    return four.dependencies.filter((d) => fixed.has(d.dependsOn));
  };

  for (const REST of [0, 30]) {
    it(`both semis pinned, rest ${REST}: the final starts exactly at the pinned semis' end + ${REST} min`, async () => {
      expect(semis).toHaveLength(2);
      const fixtures = four.fixtures.map((f) => {
        const i = semis.indexOf(f.id);
        return i === -1 ? f : { ...f, locked: { court: `c${i + 1}`, startAt: PIN } };
      });

      const built = await build(fixtures, cfg({ perEntrantMinRest: REST }), four.dependencies);

      expect(built.engine).toBe("greedy");
      expect(built.metrics.placed).toBe(3);
      const pinnedFeeds = feedsFrom(built.assignments);
      expect(pinnedFeeds).toHaveLength(2);
      const by = new Map(built.assignments.map((a) => [a.fixtureId, a] as const));
      expect(by.get(finalId)!.startAt).toBe(pinnedEnd + REST * MIN);
      expect(feedGaps(built.assignments, four.dependencies, REST).short).toEqual([]);
      expect(built.conflicts.filter((c) => c.reason === "order")).toEqual([]);
      checked.pinned += pinnedFeeds.length;
    });
  }

  it("one semi pinned late, one movable: the later of the two ends decides, plus rest", async () => {
    const REST = 30;
    const fixtures = four.fixtures.map((f) => (f.id === semis[0] ? { ...f, locked: { court: "c1", startAt: PIN } } : f));

    const built = await build(fixtures, cfg({ perEntrantMinRest: REST }), four.dependencies);

    expect(built.metrics.placed).toBe(3);
    const pinnedFeeds = feedsFrom(built.assignments);
    expect(pinnedFeeds).toHaveLength(1);
    const by = new Map(built.assignments.map((a) => [a.fixtureId, a] as const));
    // The movable semi takes the morning; the pinned one ends later and binds.
    expect(by.get(semis[1]!)!.endAt).toBeLessThan(pinnedEnd);
    expect(by.get(finalId)!.startAt).toBe(pinnedEnd + REST * MIN);
    expect(feedGaps(built.assignments, four.dependencies, REST).short).toEqual([]);
    checked.pinned += pinnedFeeds.length;
  });

  for (const REST of [0, 30]) {
    it(`both semis already on the board (existing), rest ${REST}: the final starts at their end + ${REST} min`, async () => {
      const existing: Assignment[] = semis.map((id, i) => {
        const line = four.fixtures.find((f) => f.id === id)!;
        return {
          fixtureId: id,
          court: `c${i + 1}`,
          startAt: PIN,
          endAt: pinnedEnd,
          entrants: [line.home!, line.away!],
          people: [],
          divisionId: "d1",
          movable: false,
        };
      });
      const fixtures = four.fixtures.filter((f) => f.id === finalId);

      const built = await build(fixtures, cfg({ perEntrantMinRest: REST }), four.dependencies, existing);

      expect(built.metrics.placed).toBe(1);
      const existingFeeds = feedsFrom(existing);
      expect(existingFeeds).toHaveLength(2);
      const board = [...existing, ...built.assignments];
      const by = new Map(board.map((a) => [a.fixtureId, a] as const));
      expect(by.get(finalId)!.startAt).toBe(pinnedEnd + REST * MIN);
      const gaps = feedGaps(board, four.dependencies, REST);
      expect(gaps.checked).toBe(2);
      expect(gaps.short).toEqual([]);
      expect(built.conflicts.filter((c) => c.reason === "order")).toEqual([]);
      checked.existing += existingFeeds.length;
    });
  }

  it("anti-vacuity: the cases above checked feeds from pinned and from existing rows", () => {
    // 2 rests x 2 pinned semis + the mixed case's 1; 2 rests x 2 existing semis.
    expect(checked).toEqual({ pinned: 5, existing: 4 });
  });
});
