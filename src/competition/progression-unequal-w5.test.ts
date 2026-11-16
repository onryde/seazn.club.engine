// W5 Task 5 (rulebook RB5-U1..U8, RB5-E7; owner rulings 280, 285, 286, 291; rows X-UP-1..5) — best-Nth over unequal pools,
// always on. When a cut compares Nth-placed entrants across pools of different sizes, every candidate from a larger pool
// has their results against that pool's bottom k entrants left out, k = that pool's effective size minus the smallest
// effective size (effective = rows − expunged). `normaliseUnequalPools` is accepted and ignored (ruling 286); the reduced
// rows run the source's own cross-group cascade (RB5-U2; ruling 291: seed or stored lots, as the sport declares).
//
// Every scene runs the stage's own path: results paid by the sport's rule, pools ranked by `completeTableStage` (seated by
// `pools`, so an expunged entrant keeps its row), cross-group rules read by `crossGroupRulesOf`, the seats by
// `resolveProgression`. Expected values are derived by hand from the matches each scene declares (the derivation is the
// comment beside each pin), never read back from the code under test.
//
// Sequence (TEST-STRATEGY rule 1): one pool (no comparison) → equal pools → unequal pools → k per pool → the bottom by
// the pool's own lots → expunged entrants → the cascade of two sports → the basis on every entry → a second call → two
// flags colliding → after a withdrawal, a pool that becomes the minimum.
import { describe, expect, it } from "vitest";
import { EngineError } from "../core/errors.ts";
import type { EntrantId, MatchOutcome, StandingsDelta } from "../core/types.ts";
import type { AnySportModule } from "../sport/module.ts";
import { builtinModules } from "../sports/index.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { decidedInFor } from "./decided-in.ts";
import { payout, setsToWinOf } from "./points.ts";
import {
  PRE_W2D_CROSS_GROUP,
  resolveProgression,
  type ProgressionSpec,
  type ResolvedProgressionEntry,
  type SourceTables,
  type TakeRule,
} from "./progression.ts";
import { completeTableStage, crossGroupRulesOf, type TableFixture, type TableStage } from "./stage.ts";
import { foldResults, type FixtureResult } from "./standings.ts";
import { resolveTableRules, type TableRulesPin } from "./table-rules.ts";
import { rankStandings, type StoredLotsDraw } from "./tiebreakers.ts";

const moduleOf = (key: string): AnySportModule => {
  const m = builtinModules.find((x) => x.key === key);
  if (m === undefined) throw new Error(`no sport ${key}`);
  return m;
};
// single-sport: football's cross-group order ends in fair_play, lots — a basis tie goes to the STORED cross-group draw.
const football = moduleOf("football");
// single-sport: icehockey's cross-group order holds seed before lots — a basis tie goes to the SEED (ruling 291).
const icehockey = moduleOf("icehockey");
const cfgOf = (m: AnySportModule): unknown => declaredCfgs(m)[0]!.cfg;

interface Match {
  readonly home: EntrantId;
  readonly away: EntrantId;
  readonly hg: number;
  readonly ag: number;
  /** "void": the fixture was voided (an expunge, X-WDT-1) — it counts for nobody. */
  readonly status?: "void";
}
const g = (home: EntrantId, away: EntrantId, hg: number, ag: number): Match => ({ home, away, hg, ag });
const voided = (m: Match): Match => ({ ...m, status: "void" });

function rulesFor(module: AnySportModule): TableRulesPin {
  return resolveTableRules({
    module, stageKind: "group", mergedCfg: cfgOf(module),
    stageOwn: { points: null, tiebreakers: null, crossGroup: null }, divisionTiebreakers: null, pinned: null,
  });
}

function paid(module: AnySportModule, m: Match, rules: TableRulesPin): FixtureResult {
  const r = m.hg > m.ag ? "h" : m.hg < m.ag ? "a" : "d";
  const side = (id: EntrantId, won: boolean, lost: boolean, gf: number, ga: number): StandingsDelta => ({
    entrantId: id, played: 1, won: won ? 1 : 0, drawn: !won && !lost ? 1 : 0, lost: lost ? 1 : 0, points: 0,
    metrics: { gf, ga, gd: gf - ga },
  });
  const raw: FixtureResult = [side(m.home, r === "h", r === "a", m.hg, m.ag), side(m.away, r === "a", r === "h", m.ag, m.hg)];
  const outcome: MatchOutcome =
    r === "d" ? { kind: "draw" } : r === "h" ? { kind: "win", winner: m.home, loser: m.away } : { kind: "win", winner: m.away, loser: m.home };
  return payout(outcome, decidedInFor(module, outcome), raw, true, rules.points, module.awardScoreKeys, setsToWinOf(module, cfgOf(module)));
}

interface Pool {
  readonly pool: string;
  readonly members: readonly EntrantId[];
  readonly matches: readonly Match[];
  /** Stored within-pool lots draws, by members key. */
  readonly lots?: Readonly<Record<string, readonly EntrantId[]>>;
  /** PoolTable.expunged — what app PR B's builders write from the withdrawal ledger's expunge mode. */
  readonly expunged?: readonly EntrantId[];
}
const draws = (lots: Readonly<Record<string, readonly EntrantId[]>>): Map<string, StoredLotsDraw> =>
  new Map(Object.entries(lots).map(([key, order]) => [key, { order, drawnAt: "2026-11-16" }]));

/** A completed group stage, seated by `pools` (T3): every pool paid by the sport's rule and ranked by
 *  `completeTableStage`; the cross-group rules read off the stage. */
function groupStage(
  module: AnySportModule,
  pools: readonly Pool[],
  opts: {
    seeds?: Readonly<Record<EntrantId, number>>;
    crossLots?: Readonly<Record<string, readonly EntrantId[]>>;
    /** Carried opening points by entrant (`TableStage.openingDeltas`, played 0) — a row component that is no result. */
    openings?: Readonly<Record<EntrantId, number>>;
  } = {},
): SourceTables {
  const rules = rulesFor(module);
  const fixtures: TableFixture[] = pools.flatMap((p) =>
    p.matches.map((m, i): TableFixture => ({ id: `${p.pool}-${i}`, poolId: p.pool, status: m.status ?? "decided", result: paid(module, m, rules) })),
  );
  const lotsDraws = new Map<string, Map<string, StoredLotsDraw>>();
  for (const p of pools) if (p.lots !== undefined) lotsDraws.set(p.pool, draws(p.lots));
  if (opts.crossLots !== undefined) lotsDraws.set("", draws(opts.crossLots));
  const stage: TableStage = {
    id: "groups", kind: "group", entrants: pools.flatMap((p) => p.members), rules,
    pools: new Map(pools.flatMap((p) => p.members.map((id) => [id, p.pool] as const))),
    ...(module.winsCount === undefined ? {} : { winsCount: module.winsCount }),
    ...(opts.seeds === undefined ? {} : { seeds: new Map(Object.entries(opts.seeds)) }),
    ...(lotsDraws.size === 0 ? {} : { lotsDraws }),
    ...(opts.openings === undefined
      ? {}
      : {
          openingDeltas: Object.entries(opts.openings).map(
            ([entrantId, points]): StandingsDelta => ({ entrantId, played: 0, won: 0, drawn: 0, lost: 0, points, metrics: {} }),
          ),
        }),
  };
  const done = completeTableStage(stage, fixtures);
  const expungedOf = new Map(pools.map((p) => [p.pool, p.expunged]));
  return {
    ...done.tables,
    pools: done.tables.pools.map((t) => {
      const expunged = expungedOf.get(t.pool);
      return expunged === undefined ? t : { ...t, expunged };
    }),
    crossGroup: crossGroupRulesOf(stage),
  };
}

const spec = (...take: TakeRule[]): ProgressionSpec => ({ sources: [{ stage: "previous", take }], placement: "rank_order" });
const resolve = (tables: SourceTables, ...take: TakeRule[]) =>
  resolveProgression(spec(...take), [{ poolKeys: tables.pools.map((p) => p.pool) }], [tables]);
const ids = (q: readonly ResolvedProgressionEntry[]): EntrantId[] => q.map((e) => e.entrantId);
const caught = (fn: () => unknown): EngineError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof EngineError) return e;
    throw e;
  }
  throw new Error("expected an EngineError");
};

// ── The X-UP-1 scene (football 3/1/0, single leg, 1-0 wins, 0-0 draws).
// Pool A (5): a1 beats all (12); a2 L a1, W a3, D a4, W a5 (7); a3 L a1, L a2, W a4, W a5 (6); a4 L a1, D a2, L a3,
// W a5 (4); a5 loses all (0).
const A5: Pool = {
  pool: "A",
  members: ["a1", "a2", "a3", "a4", "a5"],
  matches: [
    g("a1", "a2", 1, 0), g("a1", "a3", 1, 0), g("a1", "a4", 1, 0), g("a1", "a5", 1, 0),
    g("a2", "a3", 1, 0), g("a2", "a4", 0, 0), g("a2", "a5", 1, 0),
    g("a3", "a4", 1, 0), g("a3", "a5", 1, 0),
    g("a4", "a5", 1, 0),
  ],
};
// Pool B (4): b1 beats all (9); b2 L b1, W b3, W b4 (6); b3 L b1, L b2, W b4 (3); b4 loses all (0).
const B4: Pool = {
  pool: "B",
  members: ["b1", "b2", "b3", "b4"],
  matches: [
    g("b1", "b2", 1, 0), g("b1", "b3", 1, 0), g("b1", "b4", 1, 0),
    g("b2", "b3", 1, 0), g("b2", "b4", 1, 0),
    g("b3", "b4", 1, 0),
  ],
};

describe("W5 T5 — best-Nth across pools: the empty case first (RB5-E7)", () => {
  it("one pool is no comparison: nothing is dropped, the candidate is compared on all it played", () => {
    // One pool: k = 4 − 4 = 0. b2 played 3 (v b1, b3, b4).
    const { qualifiers } = resolve(groupStage(football, [B4]), { kind: "bestNth", nth: 2, count: 1 });
    expect(ids(qualifiers)).toEqual(["b2"]);
    expect(qualifiers[0]!.basis).toEqual({ nth: 2, matchesCounted: 3, dropped: [], levelWith: [] });
    expect(qualifiers[0]!.pool).toBe("B");
  });
});

describe("W5 T5 — equal pools drop nothing (RB5-U6, RB5-E7; ruling 286)", () => {
  // Two pools of 4: A4 = a1 beats all, a2 beats a3 and a4, a3 beats a4 (strict); B4 as above.
  const A4: Pool = {
    pool: "A",
    members: ["a1", "a2", "a3", "a4"],
    matches: [g("a1", "a2", 1, 0), g("a1", "a3", 1, 0), g("a1", "a4", 1, 0), g("a2", "a3", 1, 0), g("a2", "a4", 1, 0), g("a3", "a4", 1, 0)],
  };

  it("X-UP-5 equal pools drop nothing, with or without the deprecated flag", () => {
    const tables = groupStage(football, [A4, B4]);
    for (const flag of [true, false, undefined]) {
      const take: TakeRule = flag === undefined ? { kind: "bestNth", nth: 2, count: 2 } : { kind: "bestNth", nth: 2, count: 2, normaliseUnequalPools: flag };
      const { qualifiers } = resolve(tables, take);
      // RB5-U6: k = 4 − 4 = 0 in both pools; each runner-up compared on its 3 matches.
      // differential: today the flag drops the bottom result even here (:652-664): the refolded row shows played 2.
      for (const q of qualifiers) expect(q.basis, `flag ${String(flag)} ${q.entrantId}`).toMatchObject({ dropped: [], matchesCounted: 3 });
      expect(qualifiers).toHaveLength(2);
    }
  });
});

describe("W5 T5 — unequal pools compare on k = size − min, always on (RB5-U1, RB5-U7, RB5-U8)", () => {
  it("X-UP-1 the larger pool's candidate is compared without the bottom result", () => {
    const tables = groupStage(football, [A5, B4]);
    const { qualifiers } = resolve(tables, { kind: "bestNth", nth: 2, count: 1 });
    // RB5-U1: k(A) = 5 − 4 = 1, k(B) = 0. a2 without v a5: L a1, W a3, D a4 = 4 points from 3; b2 = 6 from 3 → b2.
    // Raw rows would take a2 (7 > 6); today's flag (k = 1 everywhere: a2 4, b2 3) would take a2 too.
    // differential: today SEEDING_BESTNTH_UNEQUAL_POOLS (:825-836).
    expect(ids(qualifiers)).toEqual(["b2"]);
    expect(qualifiers[0]!.basis).toEqual({ nth: 2, matchesCounted: 3, dropped: [{ pool: "A", against: ["a5"] }], levelWith: [] }); // RB5-U1
    // The flag is accepted and ignored (RB5-U8): set, the answer is the same (the descriptor still carries it, read by nothing).
    const flagged = resolve(tables, { kind: "bestNth", nth: 2, count: 1, normaliseUnequalPools: true });
    const seat = ({ descriptor: _d, ...rest }: ResolvedProgressionEntry) => rest;
    expect(flagged.qualifiers.map(seat)).toStrictEqual(qualifiers.map(seat));
  });

  it("X-UP-1 k is the size difference to the smallest pool", () => {
    // Pools of 5, 4 and 3, each strict (the higher-listed beats every lower-listed 1-0).
    const strict = (pool: string, n: number): Pool => {
      const members = Array.from({ length: n }, (_, i) => `${pool.toLowerCase()}${i + 1}`);
      return { pool, members, matches: members.flatMap((h, i) => members.slice(i + 1).map((a) => g(h, a, 1, 0))) };
    };
    const tables = groupStage(football, [strict("A", 5), strict("B", 4), strict("C", 3)]);
    const { qualifiers } = resolve(tables, { kind: "bestNth", nth: 1, count: 3 });
    // RB5-U7: k(A) = 5 − 3 = 2 (a4, a5), k(B) = 4 − 3 = 1 (b4), k(C) = 0; every winner compared on 3 − 1 = 2 matches.
    // differential: today k = 1 for every pool with the flag (A would drop a5 alone and B b4, C c3).
    expect(qualifiers).toHaveLength(3);
    for (const q of qualifiers) {
      expect(q.basis).toMatchObject({ nth: 1, matchesCounted: 2, dropped: [{ pool: "A", against: ["a4", "a5"] }, { pool: "B", against: ["b4"] }] });
    }
  });

  it("X-UP-4 the bottom is the pool's own last, lots included", () => {
    // Pool A (5): a1 beats all; a2 L a1, W a3, D a4, W a5; a3 L a1, L a2, W a4, D a5; a4 L a1, D a2, L a3, D a5;
    // a5 L a1, L a2, D a3, D a4. a4 and a5: 2 points, 0-2 each, drew each other — level on every key of football's
    // group order, so the pool's stored lots draw orders them. B4 as above.
    const level: Pool = {
      pool: "A",
      members: ["a1", "a2", "a3", "a4", "a5"],
      matches: [
        g("a1", "a2", 1, 0), g("a1", "a3", 1, 0), g("a1", "a4", 1, 0), g("a1", "a5", 1, 0),
        g("a2", "a3", 1, 0), g("a2", "a4", 0, 0), g("a2", "a5", 1, 0),
        g("a3", "a4", 1, 0), g("a3", "a5", 0, 0),
        g("a4", "a5", 0, 0),
      ],
    };
    // Drawn [a4, a5]: a5 is the pool's last → dropped. a2 without v a5: L a1, W a3, D a4 = 4 < b2's 6 → b2.
    const a5Last = resolve(groupStage(football, [{ ...level, lots: { "a4,a5": ["a4", "a5"] } }, B4]), { kind: "bestNth", nth: 2, count: 1 });
    expect(a5Last.qualifiers[0]!.basis!.dropped).toEqual([{ pool: "A", against: ["a5"] }]); // RB5-U4
    expect(ids(a5Last.qualifiers)).toEqual(["b2"]);
    // Drawn [a5, a4]: a4 is the pool's last → dropped, whatever the id order says.
    const a4Last = resolve(groupStage(football, [{ ...level, lots: { "a4,a5": ["a5", "a4"] } }, B4]), { kind: "bestNth", nth: 2, count: 1 });
    expect(a4Last.qualifiers[0]!.basis!.dropped).toEqual([{ pool: "A", against: ["a4"] }]); // RB5-U4
  });
});

describe("W5 T5 — an expunged entrant is not dropped again (RB5-U5, RB5-U7)", () => {
  // X-WDT-1: a5 withdrew under half played — every fixture of hers voided; she keeps her seated row, played 0.
  const A5x: Pool = { ...A5, matches: A5.matches.map((m) => (m.home === "a5" || m.away === "a5" ? voided(m) : m)), expunged: ["a5"] };

  it("X-UP-5 an expunged entrant is not dropped again", () => {
    const { qualifiers } = resolve(groupStage(football, [A5x, B4]), { kind: "bestNth", nth: 2, count: 2 });
    // RB5-U5: effective A = 5 − 1 = 4, B = 4 → k = 0, nothing dropped. a2 (v a5 voided): L a1, W a3, D a4 = 4 from 3;
    // b2 6 from 3 → b2 then a2. Counting a5 in A's size would drop her (k(A) = 1) a second time.
    expect(ids(qualifiers)).toEqual(["b2", "a2"]);
    for (const q of qualifiers) expect(q.basis).toEqual({ nth: 2, matchesCounted: 3, dropped: [], levelWith: [] });
  });

  it("an expunged entrant the pool has no row for is refused by name (a wiring bug: effective size would be wrong)", () => {
    const tables = groupStage(football, [A5x, B4]);
    const broken: SourceTables = { ...tables, pools: tables.pools.map((p) => (p.pool === "B" ? { ...p, expunged: ["a5"] } : p)) };
    const err = caught(() => resolve(broken, { kind: "bestNth", nth: 2, count: 1 }));
    expect(err.code).toBe("CONFIG_INVALID");
    expect(err.data).toEqual({ reason: "expunged_not_in_pool", pool: "B", entrantId: "a5" });
  });

  it("an expunged entrant still named in its pool's results is refused by name (her results were to be removed)", () => {
    // A5 with a5 listed as expunged but her four results still counted.
    const err = caught(() => resolve(groupStage(football, [{ ...A5, expunged: ["a5"] }, B4]), { kind: "bestNth", nth: 2, count: 1 }));
    expect(err.code).toBe("CONFIG_INVALID");
    expect(err.data).toEqual({ reason: "expunged_has_results", pool: "A", entrantId: "a5" });
  });
});

describe("W5 T5 — the reduced rows run the source's own cross-group cascade (RB5-U2; ruling 291)", () => {
  // Pool A (5), strict: a1 beats all; a2 beats a3, a4, a5; a3 beats a4, a5; a4 beats a5. B4 as above.
  // Reduced (k(A) = 1, a5 dropped): a2 = L a1, W a3, W a4 = 6 points, 2-1 (+1), 2 for — b2 = 6, 2-1 (+1), 2 for.
  // Level on points, diff and for; raw, a2 has 9 (> 6).
  const strictA: Pool = {
    pool: "A",
    members: ["a1", "a2", "a3", "a4", "a5"],
    matches: [
      g("a1", "a2", 1, 0), g("a1", "a3", 1, 0), g("a1", "a4", 1, 0), g("a1", "a5", 1, 0),
      g("a2", "a3", 1, 0), g("a2", "a4", 1, 0), g("a2", "a5", 1, 0),
      g("a3", "a4", 1, 0), g("a3", "a5", 1, 0),
      g("a4", "a5", 1, 0),
    ],
  };
  // The same seeds and the same stored cross-group draw handed to both sports: a2 seeded above b2; the draw puts b2 first.
  const opts = { seeds: { a1: 1, b1: 2, a2: 3, b2: 4, a3: 5, b3: 6, a4: 7, b4: 8, a5: 9 }, crossLots: { "a2,b2": ["b2", "a2"] } };

  it("X-UP-2 then the cross-pool cascade: football's ends in lots — the stored cross-group draw decides", () => {
    const tables = groupStage(football, [strictA, B4], opts);
    expect(tables.crossGroup!.order).toEqual(["points", "diff", "for", "fair_play", "lots"]); // premise: football's declaration
    const { qualifiers, newLotsDraws } = resolve(tables, { kind: "bestNth", nth: 2, count: 2 });
    // Level on points, diff, for, fair_play → lots, the stored draw: b2 then a2. (Raw: a2 on 9 points.)
    expect(ids(qualifiers)).toEqual(["b2", "a2"]);
    expect(newLotsDraws).toEqual([]);
    expect(qualifiers.map((q) => q.basis!.levelWith)).toEqual([["a2"], ["b2"]]);
  });

  it("X-UP-2 then the cross-pool cascade: icehockey's holds seed before lots — the seed decides", () => {
    // single-sport pair with the case above: the two cascades differ only in their tail (ruling 291).
    const tables = groupStage(icehockey, [strictA, B4], opts);
    expect(tables.crossGroup!.order).toEqual(["points", "diff", "for", "seed", "lots"]); // premise: icehockey's declaration
    const { qualifiers } = resolve(tables, { kind: "bestNth", nth: 2, count: 2 });
    // Level on points, diff, for → seed: a2 (3) above b2 (4). The stored draw is never reached.
    expect(ids(qualifiers)).toEqual(["a2", "b2"]);
    expect(qualifiers.map((q) => q.basis!.dropped)).toEqual([[{ pool: "A", against: ["a5"] }], [{ pool: "A", against: ["a5"] }]]);
  });
});

describe("W5 T5 — the basis rides on every best_nth entry (RB5-U3)", () => {
  it("X-UP-3 the basis rides on every best_nth entry, and .pool names each candidate's source pool", () => {
    const tables = groupStage(football, [A5, B4]);
    const { qualifiers } = resolve(tables, { kind: "topNPerGroup", n: 1 }, { kind: "bestNth", nth: 2, count: 2 });
    // Winners first (pool order), then the runners-up by the reduced comparison: b2 (6) above a2 (4).
    expect(qualifiers.map((q) => [q.entrantId, q.pool, q.descriptor.kind])).toEqual([
      ["a1", "A", "group_rank"],
      ["b1", "B", "group_rank"],
      ["b2", "B", "best_nth"],
      ["a2", "A", "best_nth"],
    ]);
    // "compared on 3 matches; results v 5th in Pool A not counted" — the basis, on both runners-up; none on a winner.
    const basis = { nth: 2, matchesCounted: 3, dropped: [{ pool: "A", against: ["a5"] }], levelWith: [] };
    expect(qualifiers.map((q) => q.basis)).toEqual([undefined, undefined, basis, basis]);
  });

  it("X-UP-3 levelWith names the cross-pool residual class", () => {
    // Three pools of 3 (equal: k = 0). B: all three draw 1-1 — level on everything, B's stored draw b1, b2, b3: b2 second
    // on a within-pool lots tie (2 points). A: a1 beat a2 1-0 and a3 2-0, a2 drew a3 → a2 second on diff (1 point, −1,
    // 0 for); C the same. a2 and c2 are level on every key of football's cross-group order and split by the stored
    // cross-group draw (c2, a2); b2 is ahead on points.
    const B3: Pool = { pool: "B", members: ["b1", "b2", "b3"], matches: [g("b1", "b2", 1, 1), g("b1", "b3", 1, 1), g("b2", "b3", 1, 1)], lots: { "b1,b2,b3": ["b1", "b2", "b3"] } };
    const like = (p: string): Pool => ({ pool: p.toUpperCase(), members: [`${p}1`, `${p}2`, `${p}3`], matches: [g(`${p}1`, `${p}2`, 1, 0), g(`${p}1`, `${p}3`, 2, 0), g(`${p}2`, `${p}3`, 0, 0)] });
    const tables = groupStage(football, [like("a"), B3, like("c")], { crossLots: { "a2,c2": ["c2", "a2"] } });
    const { qualifiers } = resolve(tables, { kind: "bestNth", nth: 2, count: 3 });
    expect(ids(qualifiers)).toEqual(["b2", "c2", "a2"]);
    const byId = new Map(qualifiers.map((q) => [q.entrantId, q]));
    expect(byId.get("a2")!.basis!.levelWith).toEqual(["c2"]);
    expect(byId.get("c2")!.basis!.levelWith).toEqual(["a2"]);
    // differential: b2's own pool row is a within-pool lots tie — the entry keeps tieUnbroken, yet no cross-pool level.
    expect(byId.get("b2")!.tieUnbroken).toBe(true);
    expect(byId.get("b2")!.basis!.levelWith).toEqual([]);
  });
});

describe("W5 T5 — refusals (Review Focus 4)", () => {
  it("k > 0 with the pool's results absent or empty is refused, naming the pool", () => {
    const tables = groupStage(football, [A5, B4]);
    for (const results of [undefined, []] as const) {
      const stripped: SourceTables = {
        ...tables,
        pools: tables.pools.map(({ results: _r, ...p }) => (results === undefined ? p : { ...p, results })),
      };
      const err = caught(() => resolve(stripped, { kind: "bestNth", nth: 2, count: 1 }));
      expect(err.code).toBe("STAGE_NOT_READY");
      // k(A) = 5 − 4 = 1: A is the first pool with k > 0.
      expect(err.data).toMatchObject({ reason: "pool_results_missing", pool: "A" });
    }
    // k = 0 everywhere needs no results: equal pools without results compare their rows as they are.
    const noResults: SourceTables = { ...tables, pools: tables.pools.map(({ results: _r, ...p }) => (p.pool === "A" ? { ...p, rows: p.rows.slice(0, 4) } : p)) };
    expect(resolve(noResults, { kind: "bestNth", nth: 2, count: 1 }).qualifiers).toHaveLength(1);
  });
});

describe("W5 T5 fix round 1 — the reduced row is the full row minus the dropped results (ruling 280)", () => {
  it("X-UP-1 a carried component on a larger pool's candidate survives the reduction", () => {
    // X-UP-1's scene with 3 carried opening points on a2 (played 0). Full a2 = 7 + 3 = 10 points from 4; ruling 280
    // drops only the result v a5 (a W 1-0, 3 points): reduced a2 = 10 − 3 = 7 points from 3, goals 1-1 → above b2's 6
    // → a2, b2.
    // differential: before this ruling the carry was lost — the refold from results gave a2 4 points, b2 first.
    const { qualifiers } = resolve(groupStage(football, [A5, B4], { openings: { a2: 3 } }), { kind: "bestNth", nth: 2, count: 2 });
    expect(ids(qualifiers)).toEqual(["a2", "b2"]);
    for (const q of qualifiers) expect(q.basis).toEqual({ nth: 2, matchesCounted: 3, dropped: [{ pool: "A", against: ["a5"] }], levelWith: [] });
  });

  it("control: over equal pools (k = 0) the compared row is the pool's row as ranked, carry included", () => {
    // 4/4, nothing dropped. A4: a2 = L a1, W a3, D a4 = 4 points, + 3 carried = 7 > b2's 6 → a2, b2; without the carry
    // b2 (6) is above a2 (4).
    const A4: Pool = {
      pool: "A",
      members: ["a1", "a2", "a3", "a4"],
      matches: [g("a1", "a2", 1, 0), g("a1", "a3", 1, 0), g("a1", "a4", 1, 0), g("a2", "a3", 1, 0), g("a2", "a4", 0, 0), g("a3", "a4", 1, 0)],
    };
    const carried = resolve(groupStage(football, [A4, B4], { openings: { a2: 3 } }), { kind: "bestNth", nth: 2, count: 2 });
    expect(ids(carried.qualifiers)).toEqual(["a2", "b2"]);
    expect(ids(resolve(groupStage(football, [A4, B4]), { kind: "bestNth", nth: 2, count: 2 }).qualifiers)).toEqual(["b2", "a2"]);
    for (const q of carried.qualifiers) expect(q.basis).toMatchObject({ dropped: [], matchesCounted: 3 });
  });
});

describe("W5 T5 fix round 1 — a candidate inside its own pool's bottom k is refused", () => {
  it("expunges that leave the minimum below nth put B's rank-3 finisher among B's bottom 1: refused, never compared", () => {
    // A: a1 beat a2; a3 expunged (no results, row kept) → effective 2. B: b1 > b2 > b3, strict → effective 3. nth 3:
    // k(B) = 3 − 2 = 1, B's bottom 1 is b3 — the candidate itself.
    const win = (h: EntrantId, a: EntrantId): FixtureResult => [
      { entrantId: h, played: 1, won: 1, drawn: 0, lost: 0, points: 3, metrics: {} },
      { entrantId: a, played: 1, won: 0, drawn: 0, lost: 1, points: 0, metrics: {} },
    ];
    const ranked = (pool: string, members: EntrantId[], results: FixtureResult[]) => ({
      pool, results, rows: rankStandings(foldResults(members, results), { cascade: ["points"], results }).rows,
    });
    const tables: SourceTables = {
      pools: [
        { ...ranked("A", ["a1", "a2", "a3"], [win("a1", "a2")]), expunged: ["a3"] },
        ranked("B", ["b1", "b2", "b3"], [win("b1", "b2"), win("b1", "b3"), win("b2", "b3")]),
      ],
    };
    const err = caught(() => resolve(tables, { kind: "bestNth", nth: 3, count: 1 }));
    expect(err.code).toBe("STAGE_NOT_READY");
    expect(err.data).toEqual({ candidateId: "b3" });
  });
});

describe("W5 T5 — the sweep (RB5-U1, RB5-E7)", () => {
  // single-sport: progression reads no SportModule — results are hand-folded 3/1/0 rows.
  it("X-UP-1 every candidate is compared on the smallest pool's matches; at least one case is unequal", () => {
    const win = (h: EntrantId, a: EntrantId): FixtureResult => [
      { entrantId: h, played: 1, won: 1, drawn: 0, lost: 0, points: 3, metrics: { gf: 1, ga: 0, gd: 1 } },
      { entrantId: a, played: 1, won: 0, drawn: 0, lost: 1, points: 0, metrics: { gf: 0, ga: 1, gd: -1 } },
    ];
    const poolOf = (key: string, n: number) => {
      const members = Array.from({ length: n }, (_, i) => `${key}${i + 1}`);
      const results = members.flatMap((h, i) => members.slice(i + 1).map((a) => win(h, a)));
      return { pool: key, rows: rankStandings(foldResults(members, results), { cascade: ["points", "diff", "for"], results }).rows, results };
    };
    // Non-decreasing size tuples over 2..6 for 2, 3 and 4 pools: C(6,2) + C(7,3) + C(8,4) = 15 + 35 + 70 = 120; × nth 1..2.
    const tuples: number[][] = [];
    const grow = (prefix: number[], count: number) => {
      if (prefix.length === count) return void tuples.push(prefix);
      for (let s = prefix.at(-1) ?? 2; s <= 6; s++) grow([...prefix, s], count);
    };
    for (const count of [2, 3, 4]) grow([], count);
    let cases = 0;
    let candidates = 0;
    let unequal = 0;
    for (const sizes of tuples) {
      for (const nth of [1, 2]) {
        const keys = sizes.map((_, i) => String.fromCharCode(65 + i));
        const tables: SourceTables = { pools: sizes.map((n, i) => poolOf(keys[i]!, n)), crossGroup: { order: PRE_W2D_CROSS_GROUP } };
        const min = Math.min(...sizes);
        const { qualifiers } = resolveProgression(spec({ kind: "bestNth", nth, count: sizes.length }), [{ poolKeys: keys }], [tables]);
        // RB5-U7: k(pool) = size − min; the bottom k by rank. RB5-U1: every candidate on min − 1 matches — the largest
        // played is min − 1, and since each candidate beats everyone below it 1-0, equal played makes them level on every
        // key, so each one's residual class is all the others.
        const dropped = sizes.flatMap((n, i) => (n > min ? [{ pool: keys[i]!, against: Array.from({ length: n - min }, (_, j) => `${keys[i]}${min + j + 1}`) }] : []));
        for (const q of qualifiers) {
          expect(q.basis, `${sizes.join("/")} nth ${nth} ${q.entrantId}`).toEqual({
            nth, matchesCounted: min - 1, dropped,
            levelWith: qualifiers.map((o) => o.entrantId).filter((id) => id !== q.entrantId).sort(),
          });
          candidates++;
        }
        cases++;
        if (new Set(sizes).size > 1) unequal++;
      }
    }
    expect(cases, "anti-vacuity: cases").toBe(240);
    expect(candidates, "anti-vacuity: candidates — 2 × (15·2 + 35·3 + 70·4)").toBe(830);
    expect(unequal, "anti-vacuity: unequal cases — 240 minus 2 × 15 equal tuples").toBe(210);
  });
});

describe("W5 T5 — sequence (TEST-STRATEGY rule 1)", () => {
  it("the same spec resolved twice gives equal entries", () => {
    const tables = groupStage(football, [A5, B4]);
    const take: TakeRule = { kind: "bestNth", nth: 2, count: 2 };
    expect(resolve(tables, take)).toStrictEqual(resolve(tables, take));
  });

  it("two bestNth rules at one nth with different flags share one ordering and collide on the entrant dedupe, as two equal rules do", () => {
    const tables = groupStage(football, [A5, B4]);
    const mixed = caught(() => resolve(tables, { kind: "bestNth", nth: 2, count: 1, normaliseUnequalPools: true }, { kind: "bestNth", nth: 2, count: 1 }));
    const same = caught(() => resolve(tables, { kind: "bestNth", nth: 2, count: 1 }, { kind: "bestNth", nth: 2, count: 1 }));
    // Both rules read position 1 of the one reduced ordering: b2, twice.
    expect(mixed.code).toBe("QUALIFICATION_INVALID");
    expect(mixed.data).toEqual({ entrantId: "b2" });
    expect(same.code).toBe(mixed.code);
    expect(same.data).toEqual(mixed.data);
  });

  it("after a withdrawal: a pool that becomes the minimum moves k onto the other pool", () => {
    // Pool A (4): a1 beats all; a2 L a1, W a3 2-0, D a4; a3 L a1, L a2, W a4; a4 L a1, D a2, L a3. B4 as above.
    const A4: Pool = {
      pool: "A",
      members: ["a1", "a2", "a3", "a4"],
      matches: [g("a1", "a2", 1, 0), g("a1", "a3", 1, 0), g("a1", "a4", 1, 0), g("a2", "a3", 2, 0), g("a2", "a4", 0, 0), g("a3", "a4", 1, 0)],
    };
    const before = resolve(groupStage(football, [A4, B4]), { kind: "bestNth", nth: 2, count: 2 });
    // 4 / 4, k = 0: a2 = 4 points (L, W, D) from 3; b2 = 6 from 3 → b2, a2.
    expect(ids(before.qualifiers)).toEqual(["b2", "a2"]);
    expect(before.qualifiers[0]!.basis).toMatchObject({ matchesCounted: 3, dropped: [] });
    // a4 withdraws under half played and is expunged (her three fixtures voided): A's effective size 3 is the new minimum,
    // so k(B) = 4 − 3 = 1 and B drops b4. a2 = L a1 0-1, W a3 2-0 → 3 points, +1; b2 without v b4 = L b1, W b3 → 3
    // points, 0 → a2 above b2 on diff.
    const A4x: Pool = { ...A4, matches: A4.matches.map((m) => (m.home === "a4" || m.away === "a4" ? voided(m) : m)), expunged: ["a4"] };
    const after = resolve(groupStage(football, [A4x, B4]), { kind: "bestNth", nth: 2, count: 2 });
    expect(ids(after.qualifiers)).toEqual(["a2", "b2"]);
    for (const q of after.qualifiers) expect(q.basis).toEqual({ nth: 2, matchesCounted: 2, dropped: [{ pool: "B", against: ["b4"] }], levelWith: [] });
  });

  it("after a withdrawal the X-UP-1 scene compares on 4 / 4, k = 0", () => {
    const A5x: Pool = { ...A5, matches: A5.matches.map((m) => (m.home === "a5" || m.away === "a5" ? voided(m) : m)), expunged: ["a5"] };
    const { qualifiers } = resolve(groupStage(football, [A5x, B4]), { kind: "bestNth", nth: 2, count: 1 });
    // Same pick as with the drop (b2), now with nothing dropped: a5's results are already gone.
    expect(ids(qualifiers)).toEqual(["b2"]);
    expect(qualifiers[0]!.basis).toMatchObject({ matchesCounted: 3, dropped: [] });
  });
});
