// W5 Task 8 — reasoned points adjustments (rulebook RB5-T7, RB5-T8, RB5-T15, RB5-E8; rulings 284, 285, 288; rows
// X-ADJ-1..3). An adjustment is a ledger row { entrantId, delta, reason, at }: refused by name when zero, reasonless,
// non-finite or for an entrant the stage does not declare; folded as an opening delta (played 0, points = delta) before
// the cascade; and noted on its pool's table so every surface can footnote it with its reason and date.
//
// Every scene runs the stage's own path (`completeTableStage`; best-Nth via `resolveProgression`). Expected values are
// derived by hand from the matches each scene declares and from the sport's own declared rule (`tablePointsRule`), never
// read back from the code under test. The empty case is stated first.
//
// single-sport: football is the scene's sport where a result's points matter (3/1/0 declared by its tablePointsRule);
// X-ADJ-2 sweeps every sport through forEachSport.
import { describe, expect, it } from "vitest";
import { EngineError } from "../core/errors.ts";
import type { EntrantId, MatchOutcome, StandingsDelta } from "../core/types.ts";
import type { AnySportModule } from "../sport/module.ts";
import { builtinModules } from "../sports/index.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { decidedInFor } from "./decided-in.ts";
import { payout, setsToWinOf, validatePointsAdjustments, type PointsAdjustment } from "./points.ts";
import { resolveProgression, type ResolvedProgressionEntry, type SourceTables } from "./progression.ts";
import { completeTableStage, crossGroupRulesOf, withdrawTableEntrant, type TableFixture, type TableStage } from "./stage.ts";
import type { FixtureResult, StandingsRow } from "./standings.ts";
import { resolveTableRules, type TableRulesPin } from "./table-rules.ts";

const moduleOf = (key: string): AnySportModule => {
  const m = builtinModules.find((x) => x.key === key);
  if (m === undefined) throw new Error(`no sport ${key}`);
  return m;
};
// single-sport: the X-ADJ-1 scenes need one sport whose result points matter (football 3/1/0); X-ADJ-2 sweeps every sport.
const football = moduleOf("football");
const cfgOf = (m: AnySportModule): unknown => declaredCfgs(m)[0]!.cfg;
const rulesFor = (module: AnySportModule, stageKind: "league" | "group" | "swiss" = "league"): TableRulesPin =>
  resolveTableRules({
    module, stageKind, mergedCfg: cfgOf(module),
    stageOwn: { points: null, tiebreakers: null, crossGroup: null }, divisionTiebreakers: null, pinned: null,
  });

// A football result paid by the sport's own rule (3/1/0: football's tablePointsRule), goals as metrics.
function paid(module: AnySportModule, home: EntrantId, away: EntrantId, hg: number, ag: number, rules: Pick<TableRulesPin, "points">): FixtureResult {
  const r = hg > ag ? "h" : hg < ag ? "a" : "d";
  const side = (id: EntrantId, won: boolean, lost: boolean, gf: number, ga: number): StandingsDelta => ({
    entrantId: id, played: 1, won: won ? 1 : 0, drawn: !won && !lost ? 1 : 0, lost: lost ? 1 : 0, points: 0,
    metrics: { gf, ga, gd: gf - ga },
  });
  const raw: FixtureResult = [side(home, r === "h", r === "a", hg, ag), side(away, r === "a", r === "h", ag, hg)];
  const outcome: MatchOutcome =
    r === "d" ? { kind: "draw" } : r === "h" ? { kind: "win", winner: home, loser: away } : { kind: "win", winner: away, loser: home };
  return payout(outcome, decidedInFor(module, outcome), raw, true, rules.points, module.awardScoreKeys, setsToWinOf(module, cfgOf(module)));
}

const adj = (entrantId: EntrantId, delta: number, reason = "late kit", at = "2026-11-16"): PointsAdjustment => ({ entrantId, delta, reason, at });

const reasonOf = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (e) {
    if (e instanceof EngineError) return { code: e.code, ...(e.data as object) };
    throw e;
  }
  throw new Error("expected a refusal, got a result");
};

const rowsOf = (stage: TableStage, fixtures: readonly TableFixture[]): StandingsRow[] =>
  completeTableStage(stage, fixtures).tables.pools[0]!.rows as StandingsRow[];
const order = (rows: readonly StandingsRow[]): EntrantId[] => rows.map((r) => r.entrantId);
const row = (rows: readonly StandingsRow[], id: EntrantId): StandingsRow => rows.find((r) => r.entrantId === id)!;

// The X-ADJ-1 league (football 3/1/0): A beat B 1-0 (A 3), B drew C 0-0 (B 1, C 1). A leads on 3.
const ftRules = rulesFor(football);
const league: TableStage = { id: "lg", kind: "league", entrants: ["A", "B", "C"], rules: ftRules, rngSeed: 7 };
const leagueFixtures: TableFixture[] = [
  { id: "f1", status: "decided", result: paid(football, "A", "B", 1, 0, ftRules) },
  { id: "f2", status: "decided", result: paid(football, "B", "C", 0, 0, ftRules) },
];

describe("W5 points adjustments — the empty case first", () => {
  it("no adjustments, absent or [], folds today's table and writes no notes", () => {
    const today = completeTableStage(league, leagueFixtures);
    const empty = completeTableStage({ ...league, adjustments: [] }, leagueFixtures);
    expect(empty).toEqual(today);
    for (const t of empty.tables.pools) expect("notes" in t).toBe(false);
    // the scene's own premise, derived from the matches: A 3, B 1, C 1, A first.
    const rows = today.tables.pools[0]!.rows;
    expect(row(rows, "A").points).toBe(3);
    expect(row(rows, "B").points).toBe(1);
    expect(order(rows)[0]).toBe("A");
  });

  it("validatePointsAdjustments accepts an empty list", () => {
    expect(() => validatePointsAdjustments([], ["A"])).not.toThrow();
  });
});

describe("X-ADJ-3 a zero or reasonless adjustment is refused", () => {
  it("X-ADJ-3 a zero or reasonless adjustment is refused, by name, before any fold", () => {
    // differential: today a zero opening delta folds silently and carries no reason (stage.ts:477-481)
    const zeroOpening: StandingsDelta = { entrantId: "A", played: 0, won: 0, drawn: 0, lost: 0, points: 0, metrics: {} };
    expect(() => completeTableStage({ ...league, openingDeltas: [zeroOpening] }, leagueFixtures)).not.toThrow();

    const cases: [PointsAdjustment, string][] = [
      [adj("A", 0), "adjustment_zero"],
      [adj("A", -3, "  "), "adjustment_reason_missing"],
      [adj("A", -3, ""), "adjustment_reason_missing"],
      [adj("A", Number.NaN), "adjustment_not_finite"],
      [adj("A", Number.POSITIVE_INFINITY), "adjustment_not_finite"],
      [adj("Z", -3), "adjustment_unknown_entrant"],
    ];
    let checked = 0;
    for (const [a, reason] of cases) {
      expect(reasonOf(() => validatePointsAdjustments([a], league.entrants)), reason).toEqual({
        code: "CONFIG_INVALID", reason, entrantId: a.entrantId, index: 0,
      });
      // the stage refuses it too, whatever its fixtures
      expect(reasonOf(() => completeTableStage({ ...league, adjustments: [a] }, leagueFixtures))).toMatchObject({ code: "CONFIG_INVALID", reason });
      checked++;
    }
    expect(checked).toBe(6);
    // the index names the offending ledger row, not the first
    expect(reasonOf(() => validatePointsAdjustments([adj("A", -1), adj("B", 0)], league.entrants))).toMatchObject({ reason: "adjustment_zero", index: 1, entrantId: "B" });
    // positive pair: a non-zero, reasoned adjustment for a declared entrant is accepted
    expect(() => validatePointsAdjustments([adj("A", -3)], league.entrants)).not.toThrow();
  });
});

describe("X-ADJ-1 an adjustment folds before the cascade and is noted", () => {
  it("X-ADJ-1 an adjustment folds before the cascade and is noted: the leader on 3 takes −3", () => {
    // RB5-T7: A 3 − 3 = 0, below B and C (1 each) → A ranks last; played/won unchanged (the delta plays nothing).
    const { tables } = completeTableStage({ ...league, adjustments: [adj("A", -3, "fielded an ineligible player", "2026-11-10")] }, leagueFixtures);
    const pool = tables.pools[0]!;
    expect(row(pool.rows, "A")).toMatchObject({ points: 0, played: 1, won: 1, drawn: 0, lost: 0 });
    expect(order(pool.rows)[2]).toBe("A");
    expect(pool.notes).toEqual([{ kind: "adjustment", entrantId: "A", delta: -3, reason: "fielded an ineligible player", at: "2026-11-10" }]);
  });

  it("X-ADJ-1 an adjustment folds before the cascade and is noted: nothing played, C −3 ranks last (Review Focus 5)", () => {
    // C listed first so a level (empty) table — input order — would put C first; the adjustment counts as a counted
    // component like a carried opening with points, so the cascade runs and C (−3) is below A and B (0).
    const stage: TableStage = { id: "lg0", kind: "league", entrants: ["C", "A", "B"], rules: ftRules, rngSeed: 7, adjustments: [adj("C", -3)] };
    const { tables, events } = completeTableStage(stage, []);
    const rows = tables.pools[0]!.rows;
    expect(order(rows)[2]).toBe("C");
    expect(row(rows, "C")).toMatchObject({ points: -3, played: 0 });
    expect(tables.pools[0]!.notes).toHaveLength(1);
    // Counted, the table is not an empty one (W2d §5.8: an empty table is every row level, no lots): C is not level with
    // anyone, and A and B — level on every key with nothing played — reach football's last step, lots.
    expect(row(rows, "C").level).not.toBe(true);
    const lots = events.filter((e) => e.type === "rank_lock_required").map((e) => [...(e as { group: readonly string[] }).group].sort());
    expect(lots).toEqual([["A", "B"]]);
  });

  it("X-ADJ-1 an adjustment folds before the cascade and is noted: each pool notes only its own entrants", () => {
    // Two pools seated: P = A, B; Q = C, D. One adjustment in Q.
    const stage: TableStage = {
      id: "grp", kind: "group", entrants: ["A", "B", "C", "D"], rules: rulesFor(football, "group"), rngSeed: 3,
      pools: new Map([["A", "P"], ["B", "P"], ["C", "Q"], ["D", "Q"]]),
      adjustments: [adj("D", 2, "bonus", "2026-11-12")],
    };
    const fixtures: TableFixture[] = [
      { id: "p1", poolId: "P", status: "decided", result: paid(football, "A", "B", 1, 0, stage.rules) },
      { id: "q1", poolId: "Q", status: "decided", result: paid(football, "C", "D", 1, 0, stage.rules) },
    ];
    const { tables } = completeTableStage(stage, fixtures);
    const P = tables.pools.find((t) => t.pool === "P")!;
    const Q = tables.pools.find((t) => t.pool === "Q")!;
    expect("notes" in P).toBe(false);
    expect(Q.notes).toEqual([{ kind: "adjustment", entrantId: "D", delta: 2, reason: "bonus", at: "2026-11-12" }]);
    // D lost 0-1 (0 points) + 2 = 2, still below C's 3: the order stands and D moved by exactly 2.
    expect(row(Q.rows, "D").points).toBe(2);
    expect(order(Q.rows)).toEqual(["C", "D"]);
  });
});

describe("X-ADJ-2 N is a match's worth where points are matches won", () => {
  it("X-ADJ-2 N is a match's worth where points are matches won: every sport, N = its declared regulation win", () => {
    let cfgs = 0;
    const visited = forEachSport(({ module }) => {
      const cfg = cfgOf(module);
      // RB5-T15: N is in the sport's own points unit — one regulation win as the sport's table pays it.
      const N = module.tablePointsRule(cfg, "league").win.regulation;
      expect(N, `${module.key}: a win pays something`).not.toBe(0);
      const rules = rulesFor(module);
      const base: TableStage = { id: `x-${module.key}`, kind: "league", entrants: ["x", "y"], rules, rngSeed: 1 };
      const without = rowsOf(base, []);
      const withAdj = rowsOf({ ...base, adjustments: [adj("y", N)] }, []);
      expect(row(withAdj, "y").points - row(without, "y").points, module.key).toBe(N);
      expect(row(withAdj, "x").points, module.key).toBe(row(without, "x").points);
      expect(row(withAdj, "y").played, module.key).toBe(0);
      cfgs++;
    });
    expect(visited).toBe(builtinModules.length);
    expect(visited).toBeGreaterThan(0);
    expect(cfgs).toBe(visited);
  });
});

describe("W5 points adjustments — sequence", () => {
  it("two ledger rows for one entrant both apply, and both are noted in ledger order", () => {
    const { tables } = completeTableStage({ ...league, adjustments: [adj("B", -1, "first", "2026-11-01"), adj("B", -2, "second", "2026-11-02")] }, leagueFixtures);
    const pool = tables.pools[0]!;
    // B 1 − 1 − 2 = −2
    expect(row(pool.rows, "B").points).toBe(-2);
    expect(pool.notes?.map((n) => n.reason)).toEqual(["first", "second"]);
  });

  it("the same list folded twice gives equal tables (a second call)", () => {
    const stage = { ...league, adjustments: [adj("A", -3)] };
    expect(completeTableStage(stage, leagueFixtures)).toEqual(completeTableStage(stage, leagueFixtures));
  });

  it("an adjustment for an entrant who later withdrew (results expunged) still applies and is still noted", () => {
    // Seated league A, B, C, D. D played 1 of 3 (lost to A) and withdrew: 1/3 < 1/2 → expunge (X-WDT-1), the played
    // fixture and both pending ones void. D keeps its row (seating) at played 0, and its −1 adjustment still stands.
    const rules = rulesFor(football);
    const stage: TableStage = {
      id: "wd", kind: "league", entrants: ["A", "B", "C", "D"], rules, rngSeed: 2,
      pools: new Map([["A", ""], ["B", ""], ["C", ""], ["D", ""]]),
      adjustments: [adj("D", -1, "unpaid fee", "2026-11-03")],
    };
    const ad: TableFixture = { id: "ad", status: "decided", result: paid(football, "A", "D", 1, 0, rules) };
    const ab: TableFixture = { id: "ab", status: "decided", result: paid(football, "A", "B", 1, 0, rules) };
    const w = withdrawTableEntrant(stage, "D", { played: [ad], pending: [{ id: "bd", opponent: "B" }, { id: "cd", opponent: "C" }] });
    expect(w.events[0]).toMatchObject({ mode: "expunge", played: 1, scheduled: 3 });
    const voided = new Set(w.updates.filter((u) => u.status === "void").map((u) => u.fixtureId));
    expect([...voided].sort()).toEqual(["ad", "bd", "cd"]);
    const fixtures: TableFixture[] = [ab, { ...ad, status: "void" }, { id: "bd", status: "void" }, { id: "cd", status: "void" }];
    const { tables } = completeTableStage(stage, fixtures);
    const pool = tables.pools[0]!;
    expect(row(pool.rows, "D")).toMatchObject({ played: 0, points: -1 });
    expect(row(pool.rows, "A")).toMatchObject({ played: 1, points: 3 }); // the A v D win is gone
    expect(pool.notes).toEqual([{ kind: "adjustment", entrantId: "D", delta: -1, reason: "unpaid fee", at: "2026-11-03" }]);
  });

  it("a Swiss ledger stage folds the adjustment into its points (RB5-T8: the adjusted score drives the next pairing)", () => {
    // Round 1: A beat B 1-0 (A 3, B 0). B +3 → B 3, level with A on points; the Swiss table reads it.
    const rules = rulesFor(football, "swiss");
    const swiss: TableStage = {
      id: "sw", kind: "swiss", swiss: true, entrants: ["A", "B"], rules, rounds: 1, rngSeed: 1,
      swissDraw: { drawReachable: true, setsToWin: undefined }, swissAbsentRounds: new Map(),
      adjustments: [adj("B", 3, "appeal upheld", "2026-11-05")],
    };
    const fixtures: TableFixture[] = [{ id: "r1", roundNo: 1, status: "decided", result: paid(football, "A", "B", 1, 0, rules), unplayed: null }];
    const { tables } = completeTableStage(swiss, fixtures);
    const rows = tables.pools[0]!.rows;
    expect(row(rows, "B")).toMatchObject({ points: 3, played: 1, lost: 1 });
    expect(row(rows, "A").points).toBe(3);
    expect(tables.pools[0]!.notes).toHaveLength(1);
  });
});

describe("W5 points adjustments survive unequal-pool normalisation (ruling 280)", () => {
  // The X-UP-1 scene (progression-unequal-w5.test.ts), football 3/1/0, 1-0 wins, 0-0 draws.
  // Pool A (5): a1 beats all; a2 L a1, W a3, D a4, W a5 (7); a3 L a1, L a2, W a4, W a5 (6); a4 L a1, D a2, L a3, W a5;
  // a5 loses all. Pool B (4): b1 beats all; b2 L b1, W b3, W b4 (6); b3 W b4; b4 loses all.
  const A = {
    pool: "A", members: ["a1", "a2", "a3", "a4", "a5"],
    matches: [["a1", "a2", 1, 0], ["a1", "a3", 1, 0], ["a1", "a4", 1, 0], ["a1", "a5", 1, 0], ["a2", "a3", 1, 0], ["a2", "a4", 0, 0],
      ["a2", "a5", 1, 0], ["a3", "a4", 1, 0], ["a3", "a5", 1, 0], ["a4", "a5", 1, 0]] as const,
  };
  const B = {
    pool: "B", members: ["b1", "b2", "b3", "b4"],
    matches: [["b1", "b2", 1, 0], ["b1", "b3", 1, 0], ["b1", "b4", 1, 0], ["b2", "b3", 1, 0], ["b2", "b4", 1, 0], ["b3", "b4", 1, 0]] as const,
  };
  const tablesWith = (adjustments: readonly PointsAdjustment[]): SourceTables => {
    const rules = rulesFor(football, "group");
    const fixtures: TableFixture[] = [A, B].flatMap((p) =>
      p.matches.map(([h, a, hg, ag], i): TableFixture => ({ id: `${p.pool}-${i}`, poolId: p.pool, status: "decided", result: paid(football, h, a, hg, ag, rules) })),
    );
    const stage: TableStage = {
      id: "groups", kind: "group", entrants: [...A.members, ...B.members], rules,
      pools: new Map([...A.members.map((id) => [id, "A"] as const), ...B.members.map((id) => [id, "B"] as const)]),
      adjustments,
    };
    return { ...completeTableStage(stage, fixtures).tables, crossGroup: crossGroupRulesOf(stage) };
  };
  const bestSecond = (tables: SourceTables): readonly ResolvedProgressionEntry[] =>
    resolveProgression({ sources: [{ stage: "previous", take: [{ kind: "bestNth", nth: 2, count: 2 }] }], placement: "rank_order" },
      [{ poolKeys: tables.pools.map((p) => p.pool) }], [tables]).qualifiers;

  it("a larger pool's candidate keeps its adjustment in the reduced row", () => {
    // k(A) = 5 − 4 = 1: a2 is compared without her result v a5 (a W, 3 points). Without an adjustment a2 = 7 − 3 = 4
    // < b2's 6 → b2, a2. With +3: a2 = 10 − 3 = 7 > 6 → a2, b2. (A −3 would leave the order as it is, so +3 is the
    // case where keeping and losing the adjustment answer differently.)
    expect(bestSecond(tablesWith([])).map((q) => q.entrantId)).toEqual(["b2", "a2"]);
    const kept = bestSecond(tablesWith([adj("a2", 3, "appeal upheld")]));
    expect(kept.map((q) => q.entrantId)).toEqual(["a2", "b2"]);
    for (const q of kept) expect(q.basis).toMatchObject({ nth: 2, matchesCounted: 3, dropped: [{ pool: "A", against: ["a5"] }] });
  });
});
