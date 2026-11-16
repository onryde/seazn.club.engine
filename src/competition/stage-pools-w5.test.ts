// W5 Task 3 (B2; X-PO-1, X-PO-2, X-PO-3; rulebook RB5-P1, RB5-P2, RB5-P5, RB5-E4; rulings 279, 285): a pool's membership is
// its SEATING (`TableStage.pools`), not the results it has so far; a pool under two is refused with a count that works; a rank
// lock is validated per pool, at write, never thrown at a later recompute.
//
// single-sport: stage code is sport-agnostic (reads no SportModule); the deltas below are hand-built 3/1/0 results.
import { describe, expect, it } from "vitest";
import { EngineError } from "../core/errors.ts";
import type { EntrantId, StandingsDelta } from "../core/types.ts";
import { tableRulesOf } from "../testkit/helpers.ts";
import type { RankLock } from "./points.ts";
import type { FixtureResult } from "./standings.ts";
import {
  completeTableStage,
  validatePoolSizes,
  validateRankLocks,
  withdrawTableEntrant,
  type CompletedTableStage,
  type TableFixture,
  type TableStage,
} from "./stage.ts";

function fb(home: string, away: string, hg: number, ag: number): FixtureResult {
  const draw = hg === ag;
  const homeWon = hg > ag;
  const side = (id: string, gf: number, ga: number, w: number, d: number, l: number, pts: number): StandingsDelta => ({
    entrantId: id,
    played: 1,
    won: w,
    drawn: d,
    lost: l,
    points: pts,
    metrics: { gf, ga, gd: gf - ga },
  });
  return [
    side(home, hg, ag, homeWon ? 1 : 0, draw ? 1 : 0, !draw && !homeWon ? 1 : 0, draw ? 1 : homeWon ? 3 : 0),
    side(away, ag, hg, !draw && !homeWon ? 1 : 0, draw ? 1 : 0, homeWon ? 1 : 0, draw ? 1 : homeWon ? 0 : 3),
  ];
}

const award = (id: string): StandingsDelta => ({ entrantId: id, played: 1, won: 1, drawn: 0, lost: 0, points: 3, metrics: {} });

function refusalOf(fn: () => unknown): EngineError {
  try {
    fn();
  } catch (err) {
    if (err instanceof EngineError) return err;
    throw err;
  }
  throw new Error("expected a CONFIG_INVALID refusal, got a result");
}

const A = ["a", "b", "c", "d"];
const B = ["e", "f", "g"];
/** The seating: a..d in pool A (4), e..g in pool B (3). */
const SEATED: ReadonlyMap<EntrantId, string> = new Map([...A.map((id) => [id, "A"] as const), ...B.map((id) => [id, "B"] as const)]);

/** Every pair of a pool, scheduled and unplayed, carrying the pool's id — a single round robin's lines. */
function poolFixtures(pool: string, ids: readonly string[]): TableFixture[] {
  const out: TableFixture[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) out.push({ id: `${pool}-${ids[i]}-${ids[j]}`, poolId: pool, status: "scheduled" });
  }
  return out;
}

/** The fixture list with `id` decided as `result`. */
function decide(fixtures: readonly TableFixture[], id: string, result: FixtureResult): TableFixture[] {
  let hit = 0;
  const out = fixtures.map((f) => {
    if (f.id !== id) return f;
    hit++;
    return { ...f, status: "decided" as const, result };
  });
  expect(hit, `fixture ${id} exists`).toBe(1);
  return out;
}

const ALL_LINES = [...poolFixtures("A", A), ...poolFixtures("B", B)];
/** One decided result in A (a 2–0 b); every other line scheduled. */
const ONE_IN_A = decide(ALL_LINES, "A-a-b", fb("a", "b", 2, 0));
/** One decided result in each pool (a 2–0 b, e 1–0 f). */
const ONE_EACH = decide(ONE_IN_A, "B-e-f", fb("e", "f", 1, 0));

const stage: TableStage = {
  id: "g1",
  kind: "group",
  entrants: [...A, ...B],
  rules: tableRulesOf(["points", "diff", "for", "lots"]),
  rngSeed: 7,
};
const seated = (pools: ReadonlyMap<EntrantId, string>, extra: Partial<TableStage> = {}): TableStage => ({ ...stage, pools, ...extra }) as TableStage;

/** pool → its rows' entrant ids, in table order. */
function rowsByPool(done: CompletedTableStage): Map<string, string[]> {
  return new Map(done.tables.pools.map((p) => [p.pool, p.rows.map((r) => r.entrantId)]));
}
const sorted = (ids: readonly string[]): string[] => [...ids].sort();
function rowOf(done: CompletedTableStage, pool: string, id: string) {
  const table = done.tables.pools.find((p) => p.pool === pool);
  const row = table?.rows.find((r) => r.entrantId === id);
  if (row === undefined) throw new Error(`no row ${id} in pool ${pool}`);
  return row;
}

describe("TableStage.pools — membership is seating (X-PO-1; RB5-P1)", () => {
  // ── the empty case first ────────────────────────────────────────────────────────────────────────────────────────
  it("X-PO-1 an empty pools map behaves as absent; absent keeps today's membership (two result entrants per pool, nobody else)", () => {
    const absent = completeTableStage(stage, ONE_EACH);
    expect(completeTableStage(seated(new Map()), ONE_EACH)).toEqual(absent);
    // Pinned (today's rule, stage.ts entrantsOfPool): a pool's members are the entrants of its results.
    const byPool = rowsByPool(absent);
    expect([...byPool.keys()]).toEqual(["A", "B"]);
    expect(sorted(byPool.get("A") ?? [])).toEqual(["a", "b"]);
    expect(sorted(byPool.get("B") ?? [])).toEqual(["e", "f"]);
    expect([...byPool.values()].flat()).toHaveLength(4);
  });

  it("X-PO-1 a pool lists every seated member with zero played", () => {
    const done = completeTableStage(seated(SEATED), ONE_IN_A);
    const byPool = rowsByPool(done);
    expect([...byPool.keys()]).toEqual(["A", "B"]);
    expect(sorted(byPool.get("A") ?? [])).toEqual(A);
    expect(sorted(byPool.get("B") ?? [])).toEqual(B);
    // The one result: a won 2–0 (3 points), b lost; c and d are rows with nothing played.
    expect(rowOf(done, "A", "a")).toMatchObject({ played: 1, won: 1, points: 3, rank: 1 });
    expect(rowOf(done, "A", "b")).toMatchObject({ played: 1, lost: 1, points: 0 });
    let zeroPlayed = 0;
    for (const id of ["c", "d"]) {
      expect(rowOf(done, "A", id).played, id).toBe(0);
      zeroPlayed++;
    }
    for (const id of B) {
      const row = rowOf(done, "B", id);
      expect(row.played, id).toBe(0);
      expect(row.points, id).toBe(0);
      expect(row.level, id).toBe(true); // nothing counted in B: a level table (W2d §5.8 step 1)
      zeroPlayed++;
    }
    expect(zeroPlayed).toBe(5);
    // finalRanks covers every seated entrant exactly once.
    const ranked = done.events.find((e) => e.type === "stage_completed");
    const ids = ranked?.type === "stage_completed" ? ranked.finalRanks.map((p) => p.entrantId) : [];
    expect(sorted(ids)).toEqual([...A, ...B]);
    // differential: today B has 0 rows (no result in B: entrantsOfPool keeps only result/award entrants, stage.ts:296-306)
    const today = rowsByPool(completeTableStage(stage, ONE_IN_A));
    expect(today.get("B")).toEqual([]);
    expect(sorted(today.get("A") ?? [])).toEqual(["a", "b"]);
  });

  it("X-PO-1 pool order: first appearance among fixtures, then seated pools with no fixture in stage.entrants order", () => {
    // Only B has lines: B first (fixtures), then A (no fixture).
    const onlyB = completeTableStage(seated(SEATED), poolFixtures("B", B));
    expect(onlyB.tables.pools.map((p) => [p.pool, p.rows.length])).toEqual([["B", 3], ["A", 4]]);
    // No fixture at all (the empty input): every seated pool, in stage.entrants order — e..g are declared first here.
    const none = completeTableStage(seated(SEATED, { entrants: [...B, ...A] }), []);
    expect(none.tables.pools.map((p) => [p.pool, p.rows.length])).toEqual([["B", 3], ["A", 4]]);
    let rows = 0;
    for (const p of none.tables.pools) {
      for (const r of p.rows) {
        expect(r.played, r.entrantId).toBe(0);
        rows++;
      }
    }
    expect(rows).toBe(7);
    // differential: today an empty fixture list is one pool "" holding every declared entrant (poolNames, stage.ts:280).
    expect(completeTableStage(stage, []).tables.pools.map((p) => [p.pool, p.rows.length])).toEqual([["", 7]]);
  });

  it("X-PO-1 a seated entrant in another pool's result is refused (fixture_pool_mismatch)", () => {
    const cases: { name: string; fixtures: TableFixture[]; data: Record<string, unknown> }[] = [
      { name: "e (B) in an A result", fixtures: decide(ALL_LINES, "A-a-b", fb("a", "e", 1, 0)), data: { reason: "fixture_pool_mismatch", entrantId: "e", fixtureId: "A-a-b", pool: "B" } },
      { name: "a (A) in a B result", fixtures: decide(ALL_LINES, "B-e-f", fb("a", "f", 1, 0)), data: { reason: "fixture_pool_mismatch", entrantId: "a", fixtureId: "B-e-f", pool: "A" } },
      {
        name: "a (A) awarded a B bye",
        fixtures: [...ALL_LINES, { id: "B-bye", poolId: "B", status: "walkover", awardDelta: award("a") }],
        data: { reason: "fixture_pool_mismatch", entrantId: "a", fixtureId: "B-bye", pool: "A" },
      },
    ];
    let checked = 0;
    for (const c of cases) {
      const err = refusalOf(() => completeTableStage(seated(SEATED), c.fixtures));
      expect(err.code, c.name).toBe("CONFIG_INVALID");
      expect(err.data, c.name).toEqual(c.data);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("X-PO-1 a result or award naming an entrant missing from pools is refused (entrant_unseated)", () => {
    const withH = seated(SEATED, { entrants: [...A, ...B, "h"] });
    const cases: { name: string; stage: TableStage; fixtures: TableFixture[]; data: Record<string, unknown> }[] = [
      { name: "declared, unseated h in a result", stage: withH, fixtures: decide(ALL_LINES, "A-a-b", fb("a", "h", 1, 0)), data: { reason: "entrant_unseated", entrantId: "h", fixtureId: "A-a-b" } },
      { name: "undeclared z in a result", stage: seated(SEATED), fixtures: decide(ALL_LINES, "A-a-b", fb("z", "b", 1, 0)), data: { reason: "entrant_unseated", entrantId: "z", fixtureId: "A-a-b" } },
      {
        name: "unseated h awarded a bye",
        stage: withH,
        fixtures: [...ALL_LINES, { id: "A-bye", poolId: "A", status: "walkover", awardDelta: award("h") }],
        data: { reason: "entrant_unseated", entrantId: "h", fixtureId: "A-bye" },
      },
      {
        // A voided line that kept its outcome still names its entrants (today it still made them members).
        name: "unseated h in a voided result",
        stage: withH,
        fixtures: ALL_LINES.map((f) => (f.id === "A-a-b" ? { ...f, status: "void" as const, result: fb("a", "h", 1, 0) } : f)),
        data: { reason: "entrant_unseated", entrantId: "h", fixtureId: "A-a-b" },
      },
    ];
    let checked = 0;
    for (const c of cases) {
      const err = refusalOf(() => completeTableStage(c.stage, c.fixtures));
      expect(err.code, c.name).toBe("CONFIG_INVALID");
      expect(err.data, c.name).toEqual(c.data);
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("X-PO-1 a waiting arrival with no result is not a row and not refused (F9)", () => {
    const done = completeTableStage(seated(SEATED, { entrants: [...A, ...B, "h"] }), ONE_IN_A);
    const byPool = rowsByPool(done);
    expect(sorted(byPool.get("A") ?? [])).toEqual(A);
    expect(sorted(byPool.get("B") ?? [])).toEqual(B);
    expect([...byPool.values()].flat()).not.toContain("h");
    const ranked = done.events.find((e) => e.type === "stage_completed");
    const ids = ranked?.type === "stage_completed" ? ranked.finalRanks.map((p) => p.entrantId) : [];
    expect(ids).toHaveLength(7);
    expect(ids).not.toContain("h");
  });

  it("X-PO-1 a seated entrant the stage does not declare is refused (entrant_undeclared)", () => {
    const pools = new Map([...SEATED, ["x", "B"]]);
    const err = refusalOf(() => completeTableStage(seated(pools), ONE_IN_A));
    expect(err.code).toBe("CONFIG_INVALID");
    expect(err.data).toEqual({ reason: "entrant_undeclared", entrantId: "x", pool: "B" });
  });

  it("X-PO-1 sequence: the same seated input folded twice gives equal tables", () => {
    const first = completeTableStage(seated(SEATED), ONE_EACH);
    const second = completeTableStage(seated(SEATED), ONE_EACH);
    expect(second).toEqual(first);
    expect(first.tables.pools.map((p) => p.rows.length)).toEqual([4, 3]);
  });

  it("X-PO-1 sequence: after a withdrawal (the leaver's fixtures voided) the leaver stays a row of its pool", () => {
    // b played one (lost to a) of three: 1/3 < 0.5 → expunge, every b line voided (spec 05 §5, stage.ts withdrawTableEntrant).
    const pending = [
      { id: "A-b-c", opponent: "c" },
      { id: "A-b-d", opponent: "d" },
    ];
    const played = ONE_IN_A.filter((f) => f.id === "A-a-b");
    const out = withdrawTableEntrant(stage, "b", { played, pending });
    expect(out.events[0]).toMatchObject({ type: "entrant_withdrawn", entrantId: "b", mode: "expunge" });
    const voided = new Set(out.updates.map((u) => u.fixtureId));
    expect([...voided].sort()).toEqual(["A-a-b", "A-b-c", "A-b-d"]);
    // The adapter may keep a voided line's result or drop it; both read the same seated table.
    const kept = ONE_IN_A.map((f) => (voided.has(f.id) ? { ...f, status: "void" as const } : f));
    const dropped = kept.map((f) => (voided.has(f.id) ? { id: f.id, poolId: f.poolId, status: f.status } : f));
    let checked = 0;
    for (const [name, fixtures] of [["kept", kept], ["dropped", dropped]] as const) {
      const done = completeTableStage(seated(SEATED), fixtures);
      expect(sorted(rowsByPool(done).get("A") ?? []), name).toEqual(A);
      expect(rowOf(done, "A", "b").played, name).toBe(0);
      expect(rowOf(done, "A", "a").played, name).toBe(0); // the expunged result no longer counts
      checked++;
    }
    expect(checked).toBe(2);
    // differential: today, with the voided result dropped, A has no member at all (no result left in A).
    expect(rowsByPool(completeTableStage(stage, dropped)).get("A")).toEqual([]);
  });
});

describe("validatePoolSizes — the pool floor is two (X-PO-2; RB5-E4, RB5-P2)", () => {
  const poolsOf = (layout: Record<string, readonly string[]>): Map<EntrantId, string> =>
    new Map(Object.entries(layout).flatMap(([pool, ids]) => ids.map((id) => [id, pool] as const)));
  const SEVEN_INTO_FOUR = poolsOf({ A: ["a", "b"], B: ["c", "d"], C: ["e", "f"], D: ["g"] });

  it("X-PO-2 an empty seating has no pool to refuse", () => {
    expect(() => validatePoolSizes(new Map())).not.toThrow();
  });

  it("X-PO-2 a pool under two is refused, naming a count that works", () => {
    const err = refusalOf(() => validatePoolSizes(SEVEN_INTO_FOUR));
    expect(err.code).toBe("CONFIG_INVALID");
    // RB5-E4: 7 into 3 is 3, 2, 2 — every pool at least 2; 7 into 4 leaves one pool of 1.
    expect(err.data).toEqual({ reason: "pool_too_small", pool: "D", size: 1, entrants: 7, pools: 4, suggestedPools: 3 });
    // Sequence: the second call refuses the same.
    expect(refusalOf(() => validatePoolSizes(SEVEN_INTO_FOUR)).data).toEqual(err.data);
  });

  it("X-PO-2 completeTableStage refuses the same seating before folding", () => {
    const stage7: TableStage = { ...stage, entrants: ["a", "b", "c", "d", "e", "f", "g"], pools: SEVEN_INTO_FOUR };
    // A result that would also be refused (a in a C line) — the size refusal comes first.
    const mixed: TableFixture[] = [{ id: "C-e-f", poolId: "C", status: "decided", result: fb("a", "f", 1, 0) }];
    let checked = 0;
    for (const fixtures of [[], mixed]) {
      const err = refusalOf(() => completeTableStage(stage7, fixtures));
      expect(err.code).toBe("CONFIG_INVALID");
      expect(err.data).toEqual({ reason: "pool_too_small", pool: "D", size: 1, entrants: 7, pools: 4, suggestedPools: 3 });
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("X-PO-2 4 into 2 passes", () => {
    // RB5-P2: floor 2 — two pools of two are the smallest legal pooled field.
    const four = poolsOf({ A: ["a", "b"], B: ["c", "d"] });
    expect(() => validatePoolSizes(four)).not.toThrow();
    const done = completeTableStage({ ...stage, entrants: ["a", "b", "c", "d"], pools: four }, []);
    expect(done.tables.pools.map((p) => [p.pool, p.rows.length])).toEqual([["A", 2], ["B", 2]]);
  });

  it("X-PO-2 1 entrant in 1 pool names no count (suggestedPools null)", () => {
    // RB5-P2: no c ≥ 1 gives floor(1 / c) ≥ 2.
    const err = refusalOf(() => validatePoolSizes(poolsOf({ A: ["a"] })));
    expect(err.data).toEqual({ reason: "pool_too_small", pool: "A", size: 1, entrants: 1, pools: 1, suggestedPools: null });
  });

  it("X-PO-2 the suggested count is the largest pool count, no more than asked, whose floor holds", () => {
    const cases: { layout: Record<string, readonly string[]>; min?: number; pool: string; size: number; suggestedPools: number | null }[] = [
      // 5 into 3 is 2, 2, 1; 5 into 2 is 3, 2.
      { layout: { A: ["a", "b"], B: ["c", "d"], C: ["e"] }, pool: "C", size: 1, suggestedPools: 2 },
      // 9 into 5 is 2, 2, 2, 2, 1; 9 into 4 is 3, 2, 2, 2.
      { layout: { A: ["a", "b"], B: ["c", "d"], C: ["e", "f"], D: ["g", "h"], E: ["i"] }, pool: "E", size: 1, suggestedPools: 4 },
      // 3 into 2 is 2, 1; 3 into 1 is 3.
      { layout: { A: ["a", "b"], B: ["c"] }, pool: "B", size: 1, suggestedPools: 1 },
      // 3 into 3 is 1, 1, 1 (A is named first); 3 into 1 is 3.
      { layout: { A: ["a"], B: ["b"], C: ["c"] }, pool: "A", size: 1, suggestedPools: 1 },
      // min 3: 7 into 3 is 3, 2, 2 (B is under 3); 7 into 2 is 4, 3.
      { layout: { A: ["a", "b", "c"], B: ["d", "e"], C: ["f", "g"] }, min: 3, pool: "B", size: 2, suggestedPools: 2 },
    ];
    let checked = 0;
    for (const c of cases) {
      const pools = poolsOf(c.layout);
      const err = refusalOf(() => (c.min === undefined ? validatePoolSizes(pools) : validatePoolSizes(pools, c.min)));
      expect(err.data, JSON.stringify(c.layout)).toEqual({
        reason: "pool_too_small",
        pool: c.pool,
        size: c.size,
        entrants: pools.size,
        pools: Object.keys(c.layout).length,
        suggestedPools: c.suggestedPools,
      });
      checked++;
    }
    expect(checked).toBe(5);
  });
});

describe("validateRankLocks — a rank may be pinned once per pool (X-PO-3; RB5-P5)", () => {
  const ENTRANTS = [...A, ...B];
  const lock = (entrantId: string, rank: number): RankLock => ({ entrantId, rank });

  it("X-PO-3 no locks pass", () => {
    expect(() => validateRankLocks([], ENTRANTS, SEATED)).not.toThrow();
    expect(() => validateRankLocks([], [])).not.toThrow();
  });

  it("X-PO-3 a rank may be pinned once per pool: {a: 1} in A and {e: 1} in B pass", () => {
    const locks = [lock("a", 1), lock("e", 1)];
    expect(() => validateRankLocks(locks, ENTRANTS, SEATED)).not.toThrow();
    // Locks that move someone: b (lost to a) pinned 1st of A, g (nothing played) pinned 1st of B.
    const moved = [lock("b", 1), lock("g", 1)];
    const done = completeTableStage(seated(SEATED, { rankLocks: moved }), ONE_IN_A);
    expect(rowOf(done, "A", "b")).toMatchObject({ rank: 1, rankLocked: true });
    expect(rowOf(done, "B", "g")).toMatchObject({ rank: 1, rankLocked: true });
    // Pinned (already true today, stage.ts:376-378): without pools, locks are filtered to each pool's members.
    const legacy = completeTableStage({ ...stage, rankLocks: [lock("b", 1), lock("f", 1)] }, ONE_EACH);
    expect(rowOf(legacy, "A", "b")).toMatchObject({ rank: 1, rankLocked: true });
    expect(rowOf(legacy, "B", "f")).toMatchObject({ rank: 1, rankLocked: true });
  });

  it("X-PO-3 a second pin of a rank in one pool is refused (rank_lock_duplicate_in_pool)", () => {
    const cases: { name: string; locks: RankLock[]; data: Record<string, unknown> }[] = [
      { name: "a and b both 1st of A", locks: [lock("a", 1), lock("b", 1)], data: { reason: "rank_lock_duplicate_in_pool", entrantId: "b", rank: 1, pool: "A" } },
      { name: "a pinned twice", locks: [lock("a", 1), lock("a", 2)], data: { reason: "rank_lock_duplicate_in_pool", entrantId: "a", rank: 2, pool: "A" } },
    ];
    let checked = 0;
    for (const c of cases) {
      const err = refusalOf(() => validateRankLocks(c.locks, ENTRANTS, SEATED));
      expect(err.code, c.name).toBe("CONFIG_INVALID");
      expect(err.data, c.name).toEqual(c.data);
      expect(refusalOf(() => completeTableStage(seated(SEATED, { rankLocks: c.locks }), ONE_IN_A)).data, c.name).toEqual(c.data);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("X-PO-3 a rank above the pool's size is refused at write (rank_lock_out_of_range), never thrown at recompute", () => {
    // Pool A seats 4: rank 4 is its last place, rank 5 is past it.
    expect(() => validateRankLocks([lock("a", 4)], ENTRANTS, SEATED)).not.toThrow();
    const cases: { rank: number }[] = [{ rank: 5 }, { rank: 0 }, { rank: 1.5 }];
    let checked = 0;
    for (const { rank } of cases) {
      const data = { reason: "rank_lock_out_of_range", entrantId: "a", rank, pool: "A" };
      const err = refusalOf(() => validateRankLocks([lock("a", rank)], ENTRANTS, SEATED));
      expect(err.code, `${rank}`).toBe("CONFIG_INVALID");
      expect(err.data, `${rank}`).toEqual(data);
      expect(refusalOf(() => completeTableStage(seated(SEATED, { rankLocks: [lock("a", rank)] }), ONE_IN_A)).data, `${rank}`).toEqual(data);
      checked++;
    }
    expect(checked).toBe(3);
    // differential: today {a: 5} with a result throws at recompute with context { entrantId } and no reason (points.ts:688-692).
    // Now the no-pools path names it too, scoped to the pool its results make (a and b: size 2).
    const legacy = refusalOf(() => completeTableStage({ ...stage, rankLocks: [lock("a", 5)] }, ONE_IN_A));
    expect(legacy.code).toBe("CONFIG_INVALID");
    expect(legacy.data).toEqual({ reason: "rank_lock_out_of_range", entrantId: "a", rank: 5 });
    const legacyDup = refusalOf(() => completeTableStage({ ...stage, rankLocks: [lock("a", 1), lock("b", 1)] }, ONE_IN_A));
    expect(legacyDup.data).toEqual({ reason: "rank_lock_duplicate_in_pool", entrantId: "b", rank: 1 });
  });

  it("X-PO-3 a lock on an entrant the stage does not seat is refused (rank_lock_unknown_entrant)", () => {
    const cases: { name: string; entrants: string[]; id: string }[] = [
      { name: "undeclared z", entrants: ENTRANTS, id: "z" },
      { name: "declared, unseated h", entrants: [...ENTRANTS, "h"], id: "h" },
    ];
    let checked = 0;
    for (const c of cases) {
      const err = refusalOf(() => validateRankLocks([lock(c.id, 1)], c.entrants, SEATED));
      expect(err.code, c.name).toBe("CONFIG_INVALID");
      expect(err.data, c.name).toEqual({ reason: "rank_lock_unknown_entrant", entrantId: c.id, rank: 1 });
      expect(
        refusalOf(() => completeTableStage(seated(SEATED, { entrants: c.entrants, rankLocks: [lock(c.id, 1)] }), ONE_IN_A)).data,
        c.name,
      ).toEqual({ reason: "rank_lock_unknown_entrant", entrantId: c.id, rank: 1 });
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("X-PO-3 old path: a lock on an entrant with no result is still skipped", () => {
    // differential: today's behaviour, unchanged — without pools, c (no result) is in no pool's membership, so its lock is
    // filtered out (stage.ts:376-378) and the fold neither refuses nor applies it.
    const done = completeTableStage({ ...stage, rankLocks: [lock("c", 1)] }, ONE_IN_A);
    const rows = done.tables.pools.flatMap((p) => p.rows);
    expect(rows.map((r) => r.entrantId)).not.toContain("c");
    expect(rows.filter((r) => r.rankLocked === true)).toHaveLength(0);
    expect(rowOf(done, "A", "a").rank).toBe(1);
  });

  it("X-PO-3 without pools the whole body is one pool", () => {
    // Seven entrants, no seating: ranks 1..7 exist once each.
    expect(() => validateRankLocks([lock("a", 7)], ENTRANTS)).not.toThrow();
    expect(refusalOf(() => validateRankLocks([lock("a", 8)], ENTRANTS)).data).toEqual({ reason: "rank_lock_out_of_range", entrantId: "a", rank: 8 });
    expect(refusalOf(() => validateRankLocks([lock("a", 1), lock("e", 1)], ENTRANTS)).data).toEqual({
      reason: "rank_lock_duplicate_in_pool",
      entrantId: "e",
      rank: 1,
    });
    expect(refusalOf(() => validateRankLocks([lock("z", 1)], ENTRANTS)).data).toEqual({ reason: "rank_lock_unknown_entrant", entrantId: "z", rank: 1 });
    // An empty pools map is the whole body too.
    expect(refusalOf(() => validateRankLocks([lock("a", 1), lock("e", 1)], ENTRANTS, new Map())).data).toEqual({
      reason: "rank_lock_duplicate_in_pool",
      entrantId: "e",
      rank: 1,
    });
  });
});
