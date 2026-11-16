// W5 cross-pool draw — rulebook RB5-D1..D8, RB5-D10, RB5-D11; rows X-PD-1..7 (rules/cross-sport.md). Every expected value
// below is derived from the rulebook text, from the fold's own declaration (`seedPositions`, the stepladder's first rung =
// the two lowest seeds, the page playoff's 1v2 / 3v4) or from the engine's declared generator (`shuffle`, core/rng.ts),
// never from crossPoolDraw itself. The separation oracle is an independent brute force over EXACTLY the orderings RB5-D10
// allows (tier 1 fixed, each later tier permuted only within itself), in lexicographic order of step-1 positions.
//
// single-sport: round-robin code is sport-agnostic (reads no SportModule)
// After a withdrawal or void: not this function's case — the caller resolves who qualified, the draw places them.
import { describe, expect, it } from "vitest";
import { EngineError } from "../core/errors.ts";
import { shuffle } from "../core/rng.ts";
import {
  crossPoolDraw,
  crossPoolSeedOrder,
  generateSingleElim,
  nextPowerOfTwo,
  seedPositions,
  type FirstRoundShape,
  type PooledSeed,
} from "./bracket.ts";

// "A1" → { entrantId "A1", pool "A", tier 1 }.
const ps = (id: string, opts: { tier?: number; tied?: boolean } = {}): PooledSeed => ({
  entrantId: id,
  pool: id.slice(0, 1),
  tier: opts.tier ?? Number(id.slice(1)),
  ...(opts.tied === undefined ? {} : { tied: opts.tied }),
});
const seeds = (...ids: string[]): PooledSeed[] => ids.map((id) => ps(id));

function refusalOf(fn: () => unknown): EngineError {
  try {
    fn();
  } catch (err) {
    if (err instanceof EngineError) return err;
    throw err;
  }
  throw new Error("expected a CONFIG_INVALID refusal, got a result");
}
const reasonOf = (fn: () => unknown): unknown => (refusalOf(fn).data as { reason?: unknown }).reason;

// The round-one pairs the fold declares, as 1-based seed numbers, both seeds real (a pair holding a seed > n is a bye
// line and never constrains, RB5-D6). single_elim: consecutive slots of seedPositions(nextPowerOfTwo(n)); stepladder:
// the first rung, seeds n−1 and n (bracket.ts generateStepladder game 0); page_playoff: 1v2 and 3v4.
function roundOnePairs(shape: FirstRoundShape, n: number): [number, number][] {
  if (shape === "stepladder") return n >= 2 ? [[n - 1, n]] : [];
  if (shape === "page_playoff") return [[1, 2], [3, 4]];
  const pos = seedPositions(nextPowerOfTwo(n));
  const out: [number, number][] = [];
  for (let i = 0; i < pos.length; i += 2) {
    const a = pos[i] as number;
    const b = pos[i + 1] as number;
    if (a <= n && b <= n) out.push([a, b]);
  }
  return out;
}

const poolOf = (id: string): string => id.slice(0, 1);
const separates = (order: readonly string[], shape: FirstRoundShape): boolean =>
  roundOnePairs(shape, order.length).every(([a, b]) => poolOf(order[a - 1] as string) !== poolOf(order[b - 1] as string));

// All permutations of `xs` in lexicographic order of their indices.
function permutations<T>(xs: readonly T[]): T[][] {
  if (xs.length <= 1) return [xs.slice()];
  const out: T[][] = [];
  xs.forEach((x, i) => {
    for (const rest of permutations([...xs.slice(0, i), ...xs.slice(i + 1)])) out.push([x, ...rest]);
  });
  return out;
}

// RB5-D10's search space, enumerated independently: tier 1 keeps its positions, every later tier is permuted within its
// own block; the product is walked earliest block most significant, so the first hit is the lexicographically first
// ordering by step-1 positions. Returns that ordering, or null when no allowed ordering separates.
function bruteForce(step1: readonly PooledSeed[], shape: FirstRoundShape): string[] | null {
  const blocks: { tier: number; ids: string[] }[] = [];
  step1.forEach((s, i) => {
    const prev = step1[i - 1];
    if (prev !== undefined && prev.tier === s.tier) (blocks[blocks.length - 1] as { ids: string[] }).ids.push(s.entrantId);
    else blocks.push({ tier: s.tier, ids: [s.entrantId] });
  });
  const choices = blocks.map((b) => (b.tier === 1 ? [b.ids] : permutations(b.ids)));
  const walk = (k: number, acc: string[]): string[] | null => {
    if (k === choices.length) return separates(acc, shape) ? acc : null;
    for (const c of choices[k] as string[][]) {
      const hit = walk(k + 1, [...acc, ...c]);
      if (hit !== null) return hit;
    }
    return null;
  };
  return walk(0, []);
}

const supplies = (ids: readonly string[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const id of ids) out[poolOf(id)] = (out[poolOf(id)] ?? 0) + 1;
  return out;
};

// generateSingleElim over the draw, as the app will call it: seeds are the positions in `order`.
function bracketOf(order: readonly string[], slotOrder: readonly (number | null)[]) {
  return generateSingleElim({ entrants: order, seeds: new Map(order.map((e, i) => [e, i + 1])), slotOrder });
}
// Round-one fixtures as "home v away" or "X bye".
const roundOne = (order: readonly string[], slotOrder: readonly (number | null)[]): string[] =>
  bracketOf(order, slotOrder)
    .fixtures.filter((f) => f.round === 0)
    .map((f) => (f.award !== undefined ? `${f.award} bye` : `${f.home} v ${f.away}`));

// The slot order the fold declares for n entrants: seedPositions with the seeds beyond n as bye lines.
const foldSlots = (n: number): (number | null)[] =>
  seedPositions(nextPowerOfTwo(n)).map((s) => (s > n ? null : s));

describe("crossPoolDraw refusals (stated first — the empty and malformed inputs)", () => {
  it("no qualifiers → no_qualifiers", () => {
    expect(reasonOf(() => crossPoolDraw([], "single_elim", 1))).toBe("no_qualifiers");
    expect(refusalOf(() => crossPoolDraw([], "single_elim", 1)).code).toBe("CONFIG_INVALID");
  });

  it("tiers that go down along the input → tiers_out_of_order", () => {
    const input = [ps("A1"), ps("B2"), ps("C1")];
    expect(input.map((s) => s.tier)).toEqual([1, 2, 1]);
    expect(reasonOf(() => crossPoolDraw(input, "single_elim", 1))).toBe("tiers_out_of_order");
  });

  it("a draw seed that is not a finite integer → draw_seed_invalid", () => {
    const input = seeds("A1", "B1", "A2", "B2");
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      expect(reasonOf(() => crossPoolDraw(input, "single_elim", bad))).toBe("draw_seed_invalid");
    }
  });

  it("G3: a tie link on the first seed, or onto another tier → tie_link_invalid { entrantId }", () => {
    const first = [ps("A1", { tied: true }), ps("B1"), ps("A2"), ps("B2")];
    expect(refusalOf(() => crossPoolDraw(first, "single_elim", 1)).data).toEqual({
      reason: "tie_link_invalid",
      entrantId: "A1",
    });
    // seed 3 (A2) opens tier 2; its predecessor B1 is tier 1, so the link crosses tiers.
    const across = [ps("A1"), ps("B1"), ps("A2", { tied: true }), ps("B2")];
    expect(refusalOf(() => crossPoolDraw(across, "single_elim", 1)).data).toEqual({
      reason: "tie_link_invalid",
      entrantId: "A2",
    });
    // positive pair: the same link inside tier 2 (B2 onto A2) is accepted.
    const inside = [ps("A1"), ps("B1"), ps("A2"), ps("B2", { tied: true })];
    expect(() => crossPoolDraw(inside, "single_elim", 1)).not.toThrow();
  });

  it("a tier that is not a whole number ≥ 1 → tier_invalid; a qualifier listed twice → duplicate_entrant (B5–B6 m4)", () => {
    let checked = 0;
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(refusalOf(() => crossPoolDraw([ps("A1"), ps("B1", { tier: bad })], "single_elim", 1)).data, String(bad)).toEqual({
        reason: "tier_invalid",
        entrantId: "B1",
        tier: bad,
      });
      checked++;
    }
    expect(checked).toBe(4);
    expect(refusalOf(() => crossPoolDraw([ps("A1"), ps("B1"), ps("A1")], "single_elim", 1)).data).toEqual({
      reason: "duplicate_entrant",
      entrantId: "A1",
    });
  });

  it("a page playoff needs exactly four (plan's call: generatePagePlayoff's own count, refused by name)", () => {
    expect(refusalOf(() => crossPoolDraw(seeds("A1", "B1", "C1"), "page_playoff", 1)).data).toEqual({
      reason: "page_playoff_needs_four",
      entrants: 3,
    });
    expect(reasonOf(() => crossPoolDraw(seeds("A1", "B1", "C1", "A2", "B2"), "page_playoff", 1))).toBe(
      "page_playoff_needs_four",
    );
  });
});

describe("X-PD-2 rank then rotation", () => {
  it("X-PD-2 rank then rotation: A1, B1, A2, B2 into 4 → A1 v B2, A2 v B1, order unchanged", () => {
    // RB5-D2: the fold already separates (seedPositions(4) = [1,4,3,2]: 1v4 = A1 v B2, 3v2 = A2 v B1); a pin.
    const d = crossPoolDraw(seeds("A1", "B1", "A2", "B2"), "single_elim", 1);
    expect(d.order).toEqual(["A1", "B1", "A2", "B2"]);
    expect(d.slotOrder).toEqual([1, 4, 3, 2]);
    expect(roundOne(d.order, d.slotOrder as (number | null)[])).toEqual(["A1 v B2", "A2 v B1"]);
  });
});

describe("X-PD-1 no pool-mates in round one", () => {
  it("X-PD-1 no pool-mates in round one: three pools top two into 8 → A1, B1, C1, A2, C2, B2", () => {
    const input = seeds("A1", "B1", "C1", "A2", "B2", "C2");
    // differential: today the fold gives C1 v C2 (seedPositions(8) = [1,8,5,4,3,6,7,2], pair 3v6)
    const today = crossPoolSeedOrder([["A1", "A2"], ["B1", "B2"], ["C1", "C2"]]);
    expect(roundOne(today, foldSlots(6))).toContain("C1 v C2");
    // Hand derivation (RB5-D10): tier 2 holds seeds 4–6; real pairs are 5v4 and 3v6. Lexicographic search: seed 4 = A2,
    // seed 5 = B2 passes 5v4, seed 6 = C2 fails 3v6 (C1 v C2); seed 5 = C2, seed 6 = B2 → C2 v A2, C1 v B2.
    const d = crossPoolDraw(input, "single_elim", 1);
    expect(d.order).toEqual(["A1", "B1", "C1", "A2", "C2", "B2"]);
    expect(d.slotOrder).toEqual([1, null, 5, 4, 3, 6, null, 2]);
    expect(roundOne(d.order, d.slotOrder as (number | null)[])).toEqual(["A1 bye", "C2 v A2", "C1 v B2", "B1 bye"]);
  });

  it("X-PD-1 property: pools 2–6, top 1–2 per pool, every shape — separates exactly when RB5-D10 allows, else refuses", () => {
    const POOLS = "ABCDEF";
    const tally = { checked: 0, separated: 0, refused: 0 };
    const byShape: Record<FirstRoundShape, number> = { single_elim: 0, stepladder: 0, page_playoff: 0 };
    for (let p = 2; p <= 6; p++) {
      for (let mask = 0; mask < 1 << p; mask++) {
        // pool i supplies its top two when bit i is set, else its winner only; group_rank order: winners in pool
        // order, then runners-up in pool order.
        const pools = POOLS.slice(0, p).split("");
        const ids = [...pools.map((x) => `${x}1`), ...pools.filter((_, i) => (mask >> i) & 1).map((x) => `${x}2`)];
        const input = seeds(...ids);
        const shapes: FirstRoundShape[] = ids.length === 4 ? ["single_elim", "stepladder", "page_playoff"] : ["single_elim", "stepladder"];
        for (const shape of shapes) {
          tally.checked++;
          byShape[shape]++;
          const expected = bruteForce(input, shape);
          if (expected === null) {
            tally.refused++;
            expect(refusalOf(() => crossPoolDraw(input, shape, 1)).data, `${shape} ${ids.join(",")}`).toEqual({
              reason: "pool_separation_impossible",
              shape,
              entrants: ids.length,
              supplies: supplies(ids),
            });
          } else {
            tally.separated++;
            const d = crossPoolDraw(input, shape, 1);
            expect(d.order, `${shape} ${ids.join(",")}`).toEqual(expected);
            expect(separates(d.order, shape)).toBe(true);
            expect(d.slotOrder).toEqual(shape === "single_elim" ? foldSlots(ids.length) : null);
          }
        }
      }
    }
    // 2^p masks for p = 2..6 → 4+8+16+32+64 = 124 per shape for single_elim and stepladder; page_playoff only where
    // n = 4: p = 2 both doubled (1), p = 3 one doubled (3), p = 4 none doubled (1) → 5.
    expect(byShape).toEqual({ single_elim: 124, stepladder: 124, page_playoff: 5 });
    expect(tally.checked).toBe(253);
    expect(tally.separated).toBeGreaterThan(0);
    expect(tally.refused).toBeGreaterThan(0);
    expect(tally.separated + tally.refused).toBe(tally.checked);
  });
});

describe("X-PD-3 property: tied tier-2 runs over the X-PD-1 sweep (B5–B6 m5)", () => {
  it("X-PD-3 property: every pooled shape with its runners-up level separates from shuffle(seed, run) or refuses", () => {
    // The X-PD-1 sweep's masks with two or more runners-up, every runner-up after the first `tied` (one level run,
    // a best-Nth tier). Step 1 per RB5-D3 is shuffle(seed, run) from core/rng.ts; the brute force then searches from it.
    const POOLS = "ABCDEF";
    const SEEDS = [1, 2, 7];
    let checked = 0;
    let refused = 0;
    let varied = 0; // (mask, shape) cases whose three seeds gave at least two different draws: the seed is live
    for (let p = 2; p <= 6; p++) {
      for (let mask = 0; mask < 1 << p; mask++) {
        const pools = POOLS.slice(0, p).split("");
        const runners = pools.filter((_, i) => (mask >> i) & 1).map((x) => `${x}2`);
        if (runners.length < 2) continue;
        const winners = pools.map((x) => `${x}1`);
        const input = [...seeds(...winners), ...runners.map((id, i) => ps(id, { tied: i > 0 }))];
        const n = input.length;
        const shapes: FirstRoundShape[] = n === 4 ? ["single_elim", "stepladder", "page_playoff"] : ["single_elim", "stepladder"];
        for (const shape of shapes) {
          const draws = new Set<string>();
          for (const drawSeed of SEEDS) {
            const base = [...seeds(...winners), ...shuffle(drawSeed, runners).map((id) => ps(id))];
            const expected = bruteForce(base, shape);
            if (expected === null) {
              refused++;
              expect(reasonOf(() => crossPoolDraw(input, shape, drawSeed))).toBe("pool_separation_impossible");
            } else {
              const got = crossPoolDraw(input, shape, drawSeed).order;
              expect(got, `${shape} ${runners.join(",")} seed ${drawSeed}`).toEqual(expected);
              draws.add(got.join(","));
            }
            checked++;
          }
          if (draws.size >= 2) varied++;
        }
      }
    }
    // masks with ≥ 2 runners-up: Σ (2^p − 1 − p) for p = 2..6 = 1 + 4 + 11 + 26 + 57 = 99; × 2 shapes, + 1 page playoff
    // (p = 2, both doubled → n = 4) = 199; × 3 seeds = 597.
    expect(checked).toBe(597);
    // Refusals are counted, not required: with two or more runners-up a separating permutation usually exists, and the
    // refusal half is the X-PD-1 sweep's. The seed must move the draw somewhere.
    expect(refused).toBeLessThan(checked);
    expect(varied).toBeGreaterThan(0);
  });
});

describe("X-PD-3 rank ties are drawn with the stored draw seed", () => {
  // A1, B1, C1 tier 1 with B1 and C1 level across pools (C1 carries the link); A2, B2, C2 tier 2.
  const input = [ps("A1"), ps("B1"), ps("C1", { tied: true }), ps("A2"), ps("B2"), ps("C2")];
  // Step 1 (RB5-D3) from the engine's declared generator, not from crossPoolDraw: the tied run reordered by shuffle.
  const step1 = (drawSeed: number): PooledSeed[] => {
    const run = shuffle(drawSeed, ["B1", "C1"]);
    return [ps("A1"), ...run.map((id) => ps(id)), ps("A2"), ps("B2"), ps("C2")];
  };

  it("X-PD-3 rank ties are drawn with the stored draw seed: draw seed 7, then the search separates", () => {
    // RB5-D3: the tied run takes shuffle(7, [B1, C1]); RB5-D10 then searches tier 2 from that base.
    const expected = bruteForce(step1(7), "single_elim");
    expect(expected).not.toBeNull();
    const d = crossPoolDraw(input, "single_elim", 7);
    expect(d.order).toEqual(expected);
    expect(d.order.slice(0, 3)).toEqual(["A1", ...shuffle(7, ["B1", "C1"])]);
    expect(separates(d.order, "single_elim")).toBe(true);
  });

  it("X-PD-3 rank ties are drawn with the stored draw seed: sweep over draw seeds 1..50", () => {
    let checked = 0;
    const tierOne = new Set<string>();
    for (let s = 1; s <= 50; s++) {
      const d = crossPoolDraw(input, "single_elim", s);
      expect(d.order, `seed ${s}`).toEqual(bruteForce(step1(s), "single_elim"));
      expect(separates(d.order, "single_elim")).toBe(true);
      tierOne.add(d.order.slice(0, 3).join(","));
      checked++;
    }
    expect(checked).toBe(50);
    // the seed is live, not ignored: both orders of the tied pair occur.
    expect(tierOne.size).toBeGreaterThanOrEqual(2);
  });

  it("X-PD-3 rank ties are drawn with the stored draw seed: a tied best-Nth run in a later tier", () => {
    // Tier 2 is a best-Nth tier whose four runners-up are all level (B2, C2, D2 each linked to its predecessor): one run.
    const later = [...seeds("A1", "B1", "C1", "D1"), ps("A2"), ps("B2", { tied: true }), ps("C2", { tied: true }), ps("D2", { tied: true })];
    let checked = 0;
    const tierTwo = new Set<string>();
    for (let s = 1; s <= 50; s++) {
      const base = [...seeds("A1", "B1", "C1", "D1"), ...shuffle(s, ["A2", "B2", "C2", "D2"]).map((id) => ps(id))];
      const d = crossPoolDraw(later, "single_elim", s);
      expect(d.order, `seed ${s}`).toEqual(bruteForce(base, "single_elim"));
      tierTwo.add(d.order.slice(4).join(","));
      checked++;
    }
    expect(checked).toBe(50);
    expect(tierTwo.size).toBeGreaterThanOrEqual(2);
  });

  it("X-PD-3 deterministic: the same input twice is equal; with no tie the seed is unused", () => {
    // RB5-D7: Rebuild with the stored seed reproduces the draw — a second call.
    expect(crossPoolDraw(input, "single_elim", 7)).toEqual(crossPoolDraw(input, "single_elim", 7));
    // RB5-D2: the rotation is not randomised — with no `tied` anywhere every seed gives the same draw.
    const plain = seeds("A1", "B1", "C1", "D1", "A2", "B2", "C2", "D2");
    const first = crossPoolDraw(plain, "single_elim", 1);
    let checked = 0;
    for (let s = 2; s <= 20; s++) {
      expect(crossPoolDraw(plain, "single_elim", s), `seed ${s}`).toEqual(first);
      checked++;
    }
    expect(checked).toBe(19);
  });
});

describe("X-PD-4 impossible separation is refused", () => {
  it("X-PD-4 impossible separation is refused: A1, B1, B2 single_elim (Review Focus 1, ruling 288)", () => {
    // seedPositions(4) = [1,4,3,2]: 1v4 is a bye; 3v2 = B2 v B1; tier 2 holds B2 alone and tier 1 is fixed.
    expect(refusalOf(() => crossPoolDraw(seeds("A1", "B1", "B2"), "single_elim", 1)).data).toEqual({
      reason: "pool_separation_impossible",
      shape: "single_elim",
      entrants: 3,
      supplies: { A: 1, B: 2 },
    });
  });

  it("X-PD-4 impossible separation is refused: A1, B1, A2, A3 into 4 (one pool supplies more than half)", () => {
    // seedPositions(4) pairs 1v4 and 2v3; tiers 2 and 3 hold one entrant each, so A1 v A3 is forced.
    const err = refusalOf(() => crossPoolDraw(seeds("A1", "B1", "A2", "A3"), "single_elim", 1));
    expect(err.code).toBe("CONFIG_INVALID");
    expect(err.data).toEqual({
      reason: "pool_separation_impossible",
      shape: "single_elim",
      entrants: 4,
      supplies: { A: 3, B: 1 },
    });
  });
});

describe("X-PD-5 round two follows the fold", () => {
  it("X-PD-5 round two follows the fold: pool-mates may meet after round one", () => {
    const d = crossPoolDraw(seeds("A1", "B1", "C1", "A2", "B2", "C2"), "single_elim", 1);
    const b = bracketOf(d.order, d.slotOrder as (number | null)[]);
    // RB5-D5: round two is the standard fold's wiring — game i feeds from round-one games 2i and 2i+1.
    const r1 = b.fixtures.filter((f) => f.round === 1);
    expect(r1.map((f) => [f.homeFrom?.fixtureId, f.awayFrom?.fixtureId])).toEqual([
      ["se-r0-i0", "se-r0-i1"],
      ["se-r0-i2", "se-r0-i3"],
    ]);
    // r0-i0 is A1's bye and r0-i1 is C2 v A2: A1 can meet A2 in round two.
    const r0 = new Map(b.fixtures.filter((f) => f.round === 0).map((f) => [f.id, f]));
    const reach = (id: string): string[] => {
      const f = r0.get(id);
      return f === undefined ? [] : [f.home, f.away].filter((x): x is string => x !== undefined);
    };
    expect([...reach("se-r0-i0"), ...reach("se-r0-i1")].filter((e) => poolOf(e) === "A").sort()).toEqual(["A1", "A2"]);
  });
});

describe("X-PD-6 byes stay on the top seeds and never force a pair", () => {
  it("X-PD-6 byes stay on the top seeds and never force a pair: the 8-draw's byes are seeds 1–2", () => {
    const d = crossPoolDraw(seeds("A1", "B1", "C1", "A2", "B2", "C2"), "single_elim", 1);
    const b = bracketOf(d.order, d.slotOrder as (number | null)[]);
    // RB4-D2: 8 − 6 = 2 byes, to seeds 1 and 2 (A1, B1), which are tier 1 and never move.
    expect(b.fixtures.filter((f) => f.award !== undefined).map((f) => f.award).sort()).toEqual(["A1", "B1"]);
    // A bye line never constrains: A1 (bye) and A2 share a pool and both stay in the draw unrefused.
    expect(d.order.slice(0, 2)).toEqual(["A1", "B1"]);
  });

  it("X-PD-6 byes stay on the top seeds and never force a pair: an all-tier-2 draw whose search moves the bye", () => {
    // Three runners-up, no pool winner (tier 2 permutes in full, plan's call): B2, A2, A9 (A9 a second A entrant of tier 2)
    // into 4. seedPositions(4) = [1,4,3,2]: seed 1 has the bye, 3v2 is real. Identity: A9 v A2 ✗. Lexicographic search:
    // seed 1 = B2 → seed 2 = A2 → A9 v A2 ✗; seed 2 = A9 → A2 v A9 ✗; seed 1 = A2 → seed 2 = B2 → A9 v B2 ✓.
    // The bye moves from B2 to A2: it still goes to seed 1, and it never forces a pair.
    const d = crossPoolDraw([ps("B2"), ps("A2"), ps("A9", { tier: 2 })], "single_elim", 1);
    expect(d.order).toEqual(["A2", "B2", "A9"]);
    expect(roundOne(d.order, d.slotOrder as (number | null)[])).toEqual(["A2 bye", "A9 v B2"]);
  });

  it("X-PD-6 byes stay on the top seeds and never force a pair: A1, B1, A2 into 4 is not refused", () => {
    // seedPositions(4) = [1,4,3,2]: 1v4 is A1's bye (seed 4 > n); 3v2 = A2 v B1. A bye opposite A1 is no A-v-A pair.
    const d = crossPoolDraw(seeds("A1", "B1", "A2"), "single_elim", 1);
    expect(d.order).toEqual(["A1", "B1", "A2"]);
    expect(roundOne(d.order, d.slotOrder as (number | null)[])).toEqual(["A1 bye", "A2 v B1"]);
  });
});

describe("X-PD-7 a stepladder or page playoff takes the same rotation", () => {
  it("X-PD-7 a stepladder or page playoff takes the same rotation: stepladder of six", () => {
    // RB5-D8: the first rung is the two lowest seeds, 5 and 6 (B2, C2): already different pools.
    const d = crossPoolDraw(seeds("A1", "B1", "C1", "A2", "B2", "C2"), "stepladder", 1);
    expect(d.order).toEqual(["A1", "B1", "C1", "A2", "B2", "C2"]);
    expect(d.slotOrder).toBeNull();
  });

  it("X-PD-7 a stepladder or page playoff takes the same rotation: a rung that needs the search", () => {
    // A1, B1, C1, A2, B2, B3 (tiers 1,1,1,2,2,3): the rung 5v6 is B2 v B3. Tier 3 is B3 alone, so tier 2 must move:
    // the lexicographic search tries A2 at seed 4 (rung B2 v B3, fails), then B2 at seed 4 → rung A2 v B3.
    const input = [ps("A1"), ps("B1"), ps("C1"), ps("A2"), ps("B2"), ps("B3")];
    const d = crossPoolDraw(input, "stepladder", 1);
    expect(d.order).toEqual(["A1", "B1", "C1", "B2", "A2", "B3"]);
  });

  it("X-PD-7 a stepladder or page playoff takes the same rotation: page playoff A1, B1, A2, B2", () => {
    // 1v2 = A1 v B1, 3v4 = A2 v B2.
    const d = crossPoolDraw(seeds("A1", "B1", "A2", "B2"), "page_playoff", 1);
    expect(d.order).toEqual(["A1", "B1", "A2", "B2"]);
    expect(d.slotOrder).toBeNull();
  });

  it("X-PD-7 a stepladder or page playoff takes the same rotation: stepladder A1, B1, B2 is refused", () => {
    // Review Focus 1: the rung is 2v3 = B1 v B2 and tier 1 cannot move.
    expect(refusalOf(() => crossPoolDraw(seeds("A1", "B1", "B2"), "stepladder", 1)).data).toEqual({
      reason: "pool_separation_impossible",
      shape: "stepladder",
      entrants: 3,
      supplies: { A: 1, B: 2 },
    });
  });
});

describe("crossPoolDraw sequence and edge cases", () => {
  it("n = 2 from two pools is one separated final; n = 2 from one pool is refused", () => {
    expect(crossPoolDraw(seeds("A1", "B1"), "single_elim", 1)).toEqual({ order: ["A1", "B1"], slotOrder: [1, 2] });
    expect(refusalOf(() => crossPoolDraw(seeds("A1", "A2"), "single_elim", 1)).data).toEqual({
      reason: "pool_separation_impossible",
      shape: "single_elim",
      entrants: 2,
      supplies: { A: 2 },
    });
  });

  it("tier 1 means the pool winners (plan's call): a draw with no tier 1 permutes its top tier", () => {
    // A2, B2, B3 (tiers 2,2,3) as a 3-stepladder: rung 2v3 = B2 v B3; tier 2 may move (RB5-D10 fixes pool winners
    // only), so B2, A2, B3 separates.
    const d = crossPoolDraw([ps("A2"), ps("B2"), ps("B3")], "stepladder", 1);
    expect(d.order).toEqual(["B2", "A2", "B3"]);
  });

  it("the input is never mutated", () => {
    const input = [ps("A1"), ps("B1"), ps("C1", { tied: true }), ps("A2"), ps("B2"), ps("C2")];
    const before = JSON.stringify(input);
    crossPoolDraw(input, "single_elim", 7);
    expect(JSON.stringify(input)).toBe(before);
  });
});
