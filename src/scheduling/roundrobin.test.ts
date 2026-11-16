// Round-robin generation — spec 05 §2.1, invariants §6.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { EngineError } from "../core/errors.ts";
import {
  generateRoundRobin,
  roundRobinFixtureCount,
  roundRobinLineKey,
  type RoundRobinSchedule,
} from "./roundrobin.ts";

const field = (n: number): string[] => Array.from({ length: n }, (_, i) => `e${i}`);
const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

describe("generateRoundRobin — golden 6-team circle method (spec 05 §2.1)", () => {
  // The textbook circle-method schedule (fix team 1, rotate the rest): the
  // canonical published 6-team single round robin. Pair sets per round:
  const PUBLISHED: string[][] = [
    ["1|6", "2|5", "3|4"],
    ["1|5", "4|6", "2|3"],
    ["1|4", "3|5", "2|6"],
    ["1|3", "2|4", "5|6"],
    ["1|2", "3|6", "4|5"],
  ];
  const schedule = generateRoundRobin({ entrants: ["1", "2", "3", "4", "5", "6"], config: { legs: 2 } });

  const roundPairs = (roundNo: number): Set<string> =>
    new Set(
      (schedule.rounds.find((r) => r.roundNo === roundNo)?.fixtures ?? []).map((f) =>
        pairKey(f.home, f.away),
      ),
    );

  it("leg 1 rounds match the published circle-method table", () => {
    for (let r = 1; r <= 5; r++) {
      expect(roundPairs(r)).toEqual(new Set(PUBLISHED[r - 1]));
    }
  });

  it("leg 2 mirrors leg 1 (same pairings, home/away swapped)", () => {
    for (let r = 1; r <= 5; r++) {
      expect(roundPairs(r + 5)).toEqual(new Set(PUBLISHED[r - 1]));
    }
    // Each leg-1 fixture has an away/home-swapped twin in leg 2.
    const leg1 = schedule.fixtures.filter((f) => f.leg === 1).map((f) => `${f.home}>${f.away}`);
    const leg2Swapped = schedule.fixtures.filter((f) => f.leg === 2).map((f) => `${f.away}>${f.home}`);
    expect(new Set(leg1)).toEqual(new Set(leg2Swapped));
  });

  it("double round robin has n(n−1)/2·legs = 30 fixtures", () => {
    expect(schedule.fixtures).toHaveLength(30);
    expect(schedule.fixtures).toHaveLength(roundRobinFixtureCount(6, 2));
  });

  it("board assignment rotates — the pivot's game is not always court 1", () => {
    const pivotCourts = new Set(
      schedule.fixtures.filter((f) => f.home === "1" || f.away === "1").map((f) => f.court),
    );
    expect(pivotCourts.size).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// Property suites — spec 05 §6 (fast-check, n up to 64)
// ---------------------------------------------------------------------------

// Every entrant appears exactly once per round (playing or on the bye).
function eachEntrantOncePerRound(schedule: RoundRobinSchedule, entrants: string[]): void {
  for (const round of schedule.rounds) {
    const seen = new Set<string>();
    for (const f of round.fixtures) {
      expect(seen.has(f.home)).toBe(false);
      expect(seen.has(f.away)).toBe(false);
      seen.add(f.home);
      seen.add(f.away);
    }
    if (round.bye !== undefined) {
      expect(seen.has(round.bye)).toBe(false);
      seen.add(round.bye);
    }
    expect(seen).toEqual(new Set(entrants));
  }
}

describe("generateRoundRobin — invariants (spec 05 §6)", () => {
  const nArb = fc.integer({ min: 2, max: 64 });
  const legsArb = fc.constantFrom<1 | 2>(1, 2);

  it("completeness: fixture count is n(n−1)/2·legs", () => {
    fc.assert(
      fc.property(nArb, legsArb, (n, legs) => {
        const schedule = generateRoundRobin({ entrants: field(n), config: { legs } });
        expect(schedule.fixtures).toHaveLength(roundRobinFixtureCount(n, legs));
      }),
    );
  });

  // Heavy property test: sits near vitest's 5s default under full-suite
  // worker contention — budget it explicitly (chaos.test.ts precedent).
  //
  // 20s was still not enough. W4 (#415) saw it time out twice on a loaded
  // machine and pass in the same run's quiet rerun, which is a flake reporting
  // itself as a scheduling bug — the worst kind of red, because the next reader
  // goes looking for one. The work here is O(n²) per case across a
  // fast-check field, so its wall clock tracks how many other workers are
  // running, not the code under test.
  it("uniqueness: every pair meets exactly once per leg, ≤1 fixture per entrant per round", { timeout: 60_000 }, () => {
    fc.assert(
      fc.property(nArb, legsArb, (n, legs) => {
        const schedule = generateRoundRobin({ entrants: field(n), config: { legs } });
        eachEntrantOncePerRound(schedule, field(n));
        for (let leg = 1; leg <= legs; leg++) {
          const counts = new Map<string, number>();
          for (const f of schedule.fixtures.filter((x) => x.leg === leg)) {
            const key = pairKey(f.home, f.away);
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
          // n(n−1)/2 distinct pairs, each once.
          expect(counts.size).toBe((n * (n - 1)) / 2);
          for (const c of counts.values()) expect(c).toBe(1);
        }
      }),
    );
  });

  it("home/away balance: |home−away| ≤ 1 per entrant per leg", () => {
    fc.assert(
      fc.property(nArb, legsArb, (n, legs) => {
        const schedule = generateRoundRobin({ entrants: field(n), config: { legs } });
        for (let leg = 1; leg <= legs; leg++) {
          const home = new Map<string, number>();
          const away = new Map<string, number>();
          for (const f of schedule.fixtures.filter((x) => x.leg === leg)) {
            home.set(f.home, (home.get(f.home) ?? 0) + 1);
            away.set(f.away, (away.get(f.away) ?? 0) + 1);
          }
          for (const id of field(n)) {
            expect(Math.abs((home.get(id) ?? 0) - (away.get(id) ?? 0))).toBeLessThanOrEqual(1);
          }
        }
      }),
    );
  });

  it("idempotence: regeneration is byte-identical (spec 05 §6)", () => {
    fc.assert(
      fc.property(nArb, legsArb, fc.integer(), (n, legs, rngSeed) => {
        const a = generateRoundRobin({ entrants: field(n), config: { legs }, rngSeed });
        const b = generateRoundRobin({ entrants: field(n), config: { legs }, rngSeed });
        expect(a).toEqual(b);
      }),
    );
  });

  it("odd fields: exactly one bye per round, each entrant byes (n−1)/… times evenly", () => {
    fc.assert(
      fc.property(fc.integer({ min: 3, max: 63 }).filter((n) => n % 2 === 1), (n) => {
        const schedule = generateRoundRobin({ entrants: field(n) });
        const byeCounts = new Map<string, number>();
        for (const round of schedule.rounds) {
          expect(round.bye).toBeDefined();
          byeCounts.set(round.bye as string, (byeCounts.get(round.bye as string) ?? 0) + 1);
        }
        // Over a full single RR each entrant sits out exactly once.
        for (const id of field(n)) expect(byeCounts.get(id)).toBe(1);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// W5 — round-robin generation rows X-RR-1..5 (rules/cross-sport.md; rulebook RB5-G1..G3, RB5-G7, RB5-E3)
// ---------------------------------------------------------------------------

// single-sport: round-robin code is sport-agnostic (reads no SportModule)

/** The W5 sweep: every field n ∈ [2, 24] × legs ∈ {1, 2, 3} — 23 × 3 = 69 cases. */
const W5_FIELDS = Array.from({ length: 23 }, (_, i) => i + 2);
const W5_LEGS = [1, 2, 3] as const;
const W5_CASES = W5_FIELDS.length * W5_LEGS.length; // 69
// Σ_{n=2}^{24} C(n, 2) = C(25, 3) = 2300 (hockey-stick identity): the pairs the sweep's single legs hold.
const W5_PAIRS_PER_LEG_SUM = 2300;

function refusalOf(run: () => unknown): EngineError {
  try {
    run();
  } catch (err) {
    if (err instanceof EngineError) return err;
    throw err;
  }
  throw new Error("expected an EngineError, got none");
}

describe("W5 round-robin generation (R25)", () => {
  it("X-RR-1 a field under two is an empty schedule", () => {
    // RB5-G1: a round robin pairs entrants; a field of 0 or 1 has no pair, so nothing is scheduled (kept, roundrobin.ts:90).
    let checked = 0;
    for (const n of [0, 1]) {
      for (const legs of W5_LEGS) {
        expect(generateRoundRobin({ entrants: field(n), config: { legs } }), `n=${n} legs=${legs}`).toEqual({ rounds: [], fixtures: [] });
        checked++;
      }
    }
    expect(checked).toBe(6);
  });

  it("X-RR-1 every pair meets exactly once per leg (n ∈ [2, 24] × legs ∈ {1, 2, 3}, counted 69)", () => {
    let checked = 0;
    let keys = 0;
    for (const n of W5_FIELDS) {
      for (const legs of W5_LEGS) {
        const entrants = field(n);
        const schedule = generateRoundRobin({ entrants, config: { legs } });
        const seen = new Map<string, number>();
        for (const f of schedule.fixtures) {
          const key = roundRobinLineKey(f.home, f.away, f.leg);
          seen.set(key, (seen.get(key) ?? 0) + 1);
        }
        // RB5-G1: every unordered pair once per leg — the expected line set is built from the pairs, not read off the schedule.
        const expected = new Set<string>();
        for (let i = 0; i < n; i++) {
          for (let j = i + 1; j < n; j++) {
            for (let leg = 1; leg <= legs; leg++) expected.add(roundRobinLineKey(entrants[i] as string, entrants[j] as string, leg));
          }
        }
        // RB5-G1: n(n−1)/2 pairs × legs lines, each exactly once.
        expect(schedule.fixtures, `n=${n} legs=${legs}`).toHaveLength(((n * (n - 1)) / 2) * legs);
        expect(new Set(seen.keys()), `n=${n} legs=${legs}`).toEqual(expected);
        for (const [key, count] of seen) expect(count, `n=${n} legs=${legs} ${key}`).toBe(1);
        // Supporting property: the legs a schedule holds are 1..legs.
        expect(new Set(schedule.fixtures.map((f) => f.leg)), `n=${n} legs=${legs}`).toEqual(new Set(Array.from({ length: legs }, (_, i) => i + 1)));
        if (n === 2) {
          // RB5-E3: n = 2 is one fixture per leg and no bye.
          expect(schedule.rounds, `legs=${legs}`).toHaveLength(legs);
          for (const round of schedule.rounds) {
            expect(round.fixtures).toHaveLength(1);
            expect(round.bye).toBeUndefined();
          }
        }
        keys += seen.size;
        checked++;
      }
    }
    expect(checked).toBe(W5_CASES);
    // Σ C(n,2) × (1 + 2 + 3) = 2300 × 6.
    expect(keys).toBe(W5_PAIRS_PER_LEG_SUM * 6);
  });

  it("X-RR-2 home and away balance within a leg and alternate by leg (counted 69)", () => {
    let checked = 0;
    let transitions = 0;
    for (const n of W5_FIELDS) {
      for (const legs of W5_LEGS) {
        const entrants = field(n);
        const schedule = generateRoundRobin({ entrants, config: { legs } });
        // RB5-G2: within a leg, |home − away| ≤ 1 per entrant.
        for (let leg = 1; leg <= legs; leg++) {
          const home = new Map<string, number>();
          const away = new Map<string, number>();
          for (const f of schedule.fixtures.filter((x) => x.leg === leg)) {
            home.set(f.home, (home.get(f.home) ?? 0) + 1);
            away.set(f.away, (away.get(f.away) ?? 0) + 1);
          }
          for (const id of entrants) {
            expect(Math.abs((home.get(id) ?? 0) - (away.get(id) ?? 0)), `n=${n} legs=${legs} leg=${leg} ${id}`).toBeLessThanOrEqual(1);
          }
        }
        // RB5-G2: a pair's home side differs between consecutive legs.
        const homeOf = new Map<string, string>();
        for (const f of schedule.fixtures) homeOf.set(roundRobinLineKey(f.home, f.away, f.leg), f.home);
        for (let i = 0; i < n; i++) {
          for (let j = i + 1; j < n; j++) {
            const a = entrants[i] as string;
            const b = entrants[j] as string;
            for (let leg = 2; leg <= legs; leg++) {
              const before = homeOf.get(roundRobinLineKey(a, b, leg - 1));
              const after = homeOf.get(roundRobinLineKey(a, b, leg));
              expect(before, `n=${n} ${a}-${b} leg ${leg - 1}`).toBeDefined();
              expect(after, `n=${n} ${a}-${b} leg ${leg}`).not.toBe(before);
              transitions++;
            }
          }
        }
        checked++;
      }
    }
    expect(checked).toBe(W5_CASES);
    // Σ C(n,2) × ((1−1) + (2−1) + (3−1)) = 2300 × 3 leg-to-leg transitions.
    expect(transitions).toBe(W5_PAIRS_PER_LEG_SUM * 3);
  });

  it("X-RR-3 an odd field has exactly one bye per round, recorded on the round (counted 69)", () => {
    let checked = 0;
    let byeRounds = 0;
    let plainRounds = 0;
    for (const n of W5_FIELDS) {
      for (const legs of W5_LEGS) {
        const entrants = field(n);
        const schedule = generateRoundRobin({ entrants, config: { legs } });
        if (n % 2 === 1) {
          const held = new Map<string, number>();
          for (const round of schedule.rounds) {
            // RB5-G3: the bye is recorded on the round, and exactly one entrant sits out: (n − 1)/2 games seat the other n − 1.
            expect(round.bye, `n=${n} round ${round.roundNo}`).toBeDefined();
            const bye = round.bye as string;
            expect(entrants).toContain(bye);
            expect(round.fixtures, `n=${n} round ${round.roundNo}`).toHaveLength((n - 1) / 2);
            expect(round.fixtures.some((f) => f.home === bye || f.away === bye), `n=${n} round ${round.roundNo}`).toBe(false);
            held.set(bye, (held.get(bye) ?? 0) + 1);
            byeRounds++;
          }
          // Circle method: n rounds per leg, one bye each, every entrant once per leg — so `legs` byes each.
          for (const id of entrants) expect(held.get(id), `n=${n} legs=${legs} ${id}`).toBe(legs);
        } else {
          for (const round of schedule.rounds) {
            expect(round.bye, `n=${n} round ${round.roundNo}`).toBeUndefined();
            expect("bye" in round, `n=${n} round ${round.roundNo}`).toBe(false);
            expect(round.fixtures).toHaveLength(n / 2);
            plainRounds++;
          }
        }
        checked++;
      }
    }
    expect(checked).toBe(W5_CASES);
    // Odd n ∈ {3..23}: n rounds per leg, Σ = 143; × (1+2+3) = 858. Even n ∈ {2..24}: n − 1 per leg, Σ = 144; × 6 = 864.
    expect(byeRounds).toBe(858);
    expect(plainRounds).toBe(864);
  });

  it("X-RR-4 legs run 1–8: each leg count L ∈ 1..8 schedules L full legs (n ∈ [2, 9], counted 64)", () => {
    // RB5-G1: legs is the engine's input and runs 1–8 (signed 285); the engine stays generic (ruling 287 deletes triple_rr app-side).
    let checked = 0;
    for (let n = 2; n <= 9; n++) {
      for (let legs = 1; legs <= 8; legs++) {
        const schedule = generateRoundRobin({ entrants: field(n), config: { legs } });
        // Circle method: a field padded to even m = n + n % 2 needs m − 1 rounds per leg.
        const perLeg = n - 1 + (n % 2);
        expect(schedule.rounds, `n=${n} legs=${legs}`).toHaveLength(legs * perLeg);
        for (let leg = 1; leg <= legs; leg++) {
          expect(schedule.rounds.filter((r) => r.leg === leg), `n=${n} legs=${legs} leg=${leg}`).toHaveLength(perLeg);
          expect(schedule.fixtures.filter((f) => f.leg === leg), `n=${n} legs=${legs} leg=${leg}`).toHaveLength((n * (n - 1)) / 2);
        }
        expect(new Set(schedule.fixtures.map((f) => f.leg)), `n=${n} legs=${legs}`).toEqual(new Set(Array.from({ length: legs }, (_, i) => i + 1)));
        checked++;
      }
    }
    expect(checked).toBe(64);
  });

  it("X-RR-4 legs 3 holds legs {1, 2, 3} and 3 × (n − 1 + n % 2) rounds (n ∈ [2, 24], counted 23)", () => {
    // RB5-G1: legs is the engine's input; 3 is the largest swept by the X-RR-1..3 sweep.
    let checked = 0;
    for (const n of W5_FIELDS) {
      const schedule = generateRoundRobin({ entrants: field(n), config: { legs: 3 } });
      expect(new Set(schedule.fixtures.map((f) => f.leg)), `n=${n}`).toEqual(new Set([1, 2, 3]));
      expect(schedule.rounds, `n=${n}`).toHaveLength(3 * (n - 1 + (n % 2)));
      checked++;
    }
    expect(checked).toBe(23);
  });

  it("X-RR-5 the line key is the (unordered pair, leg): order-free, and its exact shape is rr:<lo>:<hi>:L<leg>", () => {
    // The interface block (plan "Interfaces"): `rr:${lo}:${hi}:L${leg}`, lo/hi in code-unit order.
    expect(roundRobinLineKey("b", "a", 1)).toBe(roundRobinLineKey("a", "b", 1));
    expect(roundRobinLineKey("b", "a", 1)).toBe("rr:a:b:L1");
    // Code-unit order, not locale order: "B" (U+0042) sorts before "a" (U+0061); localeCompare would put "a" first.
    expect(roundRobinLineKey("a", "B", 2)).toBe("rr:B:a:L2");
    expect(roundRobinLineKey("B", "a", 2)).toBe("rr:B:a:L2");
    // The leg is part of the identity: one pair, two legs, two lines.
    expect(roundRobinLineKey("a", "b", 1)).not.toBe(roundRobinLineKey("a", "b", 2));
    // A different pair is a different line.
    expect(roundRobinLineKey("a", "b", 1)).not.toBe(roundRobinLineKey("a", "c", 1));
  });

  it("X-RR-5 the line key refuses a self-pair and a leg that is not an integer ≥ 1: CONFIG_INVALID line_key_invalid", () => {
    let checked = 0;
    const cases: [string, string, number][] = [
      ["a", "a", 1],
      ["a", "b", 0],
      ["a", "b", -1],
      ["a", "b", 1.5],
      ["a", "b", Number.NaN],
      ["a", "b", Number.POSITIVE_INFINITY],
    ];
    for (const [a, b, leg] of cases) {
      const err = refusalOf(() => roundRobinLineKey(a, b, leg));
      expect(err.code, `${a} ${b} ${leg}`).toBe("CONFIG_INVALID");
      expect(err.data, `${a} ${b} ${leg}`).toEqual({ reason: "line_key_invalid" });
      checked++;
    }
    expect(checked).toBe(6);
    // The positive pair: the smallest valid leg is accepted.
    expect(roundRobinLineKey("a", "b", 1)).toBe("rr:a:b:L1");
  });

  it("X-RR-5 the line key survives a roster change, where the fixture id does not (a..e then a..f, and back after a withdrawal)", () => {
    const five = ["a", "b", "c", "d", "e"];
    const six = [...five, "f"];
    const s5 = generateRoundRobin({ entrants: five });
    const s6 = generateRoundRobin({ entrants: six });
    const byId = (s: RoundRobinSchedule, id: string) => s.fixtures.find((f) => f.id === id);
    // differential: today the only per-line key is id: rr-r1-c1 is a v d in the five-field [a..e] and a v f in [a..f]
    // (roundrobin.ts:94-152 — odd: pivot null, u0 = [a..e], column 1 = u[0] v u[3]; even: pivot a v u[4] = f).
    expect(byId(s5, "rr-r1-c1")).toMatchObject({ home: "a", away: "d" });
    expect(byId(s6, "rr-r1-c1")).toMatchObject({ home: "a", away: "f" });
    // The line key names the line, not the slot: a v d is the same key in both rosters.
    const keys5 = new Set(s5.fixtures.map((f) => roundRobinLineKey(f.home, f.away, f.leg)));
    const keys6 = new Set(s6.fixtures.map((f) => roundRobinLineKey(f.home, f.away, f.leg)));
    expect(keys5.has(roundRobinLineKey("a", "d", 1))).toBe(true);
    expect(keys6.has(roundRobinLineKey("a", "d", 1))).toBe(true);
    // Every line of the five-field survives into the six-field (C(5,2) = 10), and the six-field adds exactly f's five.
    let survived = 0;
    for (const k of keys5) { expect(keys6.has(k), k).toBe(true); survived++; }
    expect(survived).toBe(10);
    expect(keys6.size - keys5.size).toBe(5);
    // A withdrawal (f leaves a..f): the six-field's lines without f are the five-field's regenerated lines, key for key,
    // although their ids moved (rr-r1-c1 above) — so a reconcile by line key matches every surviving line.
    const withoutF = new Set(s6.fixtures.filter((f) => f.home !== "f" && f.away !== "f").map((f) => roundRobinLineKey(f.home, f.away, f.leg)));
    const regenerated = generateRoundRobin({ entrants: six.filter((e) => e !== "f") });
    expect(new Set(regenerated.fixtures.map((f) => roundRobinLineKey(f.home, f.away, f.leg)))).toEqual(withoutF);
  });

  it("X-RR-5 a second generation on the same input gives byte-equal line keys (sequence, n ∈ [2, 24] × legs ∈ {1, 2, 3}, counted 69)", () => {
    let checked = 0;
    for (const n of W5_FIELDS) {
      for (const legs of W5_LEGS) {
        const once = generateRoundRobin({ entrants: field(n), config: { legs } }).fixtures.map((f) => roundRobinLineKey(f.home, f.away, f.leg));
        const twice = generateRoundRobin({ entrants: field(n), config: { legs } }).fixtures.map((f) => roundRobinLineKey(f.home, f.away, f.leg));
        expect(twice, `n=${n} legs=${legs}`).toEqual(once);
        checked++;
      }
    }
    expect(checked).toBe(W5_CASES);
  });
});
