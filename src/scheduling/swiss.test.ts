// Swiss pairing — spec 05 §2.2, invariants §6; W3 X-SW-1 (rulebook-W3-swiss §2.1 P-A1/P-A3/P-A4/P-A6, §2.3).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  pairKey,
  pairRound,
  SWISS_NO_LEGAL_PAIRING,
  type Colour,
  type SwissConstraints,
  type SwissHistory,
  type SwissPairResult,
  type SwissRefusal,
  type SwissStanding,
} from "./swiss.ts";
import {
  colourCompatible,
  colourHistoryLegal,
  judgeRound,
  lowerScoredPairableByes,
  mayTake,
  ORACLE_MAX_FIELD,
  oraclePairKey,
  perfectMatchingExists,
  perfectMatchings,
  roundAfter,
  ruleSides,
  seatedRoundViolations,
  type OracleRound,
} from "../testkit/swiss-oracle.ts";

const field = (n: number): string[] => Array.from({ length: n }, (_, i) => `p${i}`);

// A tiny seeded PRNG so simulated results are reproducible but realistic.
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Simulate a Swiss event: `rank[i] = i+1` (p0 strongest). Results favour the
// stronger side but allow upsets (~30%) — like a real field, this keeps colour
// history from perfectly stratifying by score. Returns the per-round pairings
// plus the accumulated history — enough to assert every invariant. A refused
// round (SWISS_NO_LEGAL_PAIRING) seats nothing: the event stops there, and the
// refusal is returned beside the rounds that were paired (`refusals` holds at
// most that one), so a property can tell a short event from a full one.
interface SimRound {
  pairings: { home: string; away: string }[];
  bye?: string;
}
interface SimEvent {
  rounds: SimRound[];
  refusals: SwissRefusal[];
  colours: Map<string, Colour[]>;
  played: Set<string>;
  byes: Set<string>;
}
// `lookAhead` sets the stage's one-round look-ahead (X-SW-10): `true` on every round, the last included (to read the last
// round's own verdict); "app" as the app sets it, by appLookAhead. `onRound` sees each round as it is paired, with the
// standings and the history it was paired from, before the round's results move them.
interface PairedRoundSeen {
  standings: SwissStanding[];
  history: SwissHistory;
  constraints: SwissConstraints;
  result: SwissPairResult;
}
// The app's rule (X-SW-10; P13): the one-round look-ahead is on for every round but the last of a stage that plays more
// rounds than the safe maximum ⌊n/2⌋. The last round has no next round to protect.
function appLookAhead(n: number, rounds: number, round: number): boolean {
  return rounds > Math.floor(n / 2) && round < rounds;
}
function simulate(
  n: number,
  rounds: number,
  opts: {
    chess?: boolean;
    seed?: number;
    pairing?: SwissConstraints["pairing"];
    lookAhead?: boolean | "app";
    onRound?: (seen: PairedRoundSeen) => void;
  } = {},
): SimEvent {
  const ids = field(n);
  const rank = new Map(ids.map((id, i) => [id, i + 1]));
  const score = new Map(ids.map((id) => [id, 0]));
  const colours = new Map<string, Colour[]>();
  const played = new Set<string>();
  const byes = new Set<string>();
  const out: SimRound[] = [];
  const rng = prng(opts.seed ?? 1);
  const pushColour = (id: string, c: Colour): void => {
    const seq = colours.get(id) ?? [];
    seq.push(c);
    colours.set(id, seq);
  };

  for (let r = 0; r < rounds; r++) {
    const standings: SwissStanding[] = ids.map((id) => ({
      entrantId: id,
      score: score.get(id) as number,
      rank: rank.get(id) as number,
    }));
    const history: SwissHistory = { played, colours, byes };
    const constraints: SwissConstraints = { chess: opts.chess === true, byeScore: 1 };
    if (opts.pairing !== undefined) constraints.pairing = opts.pairing;
    if (opts.lookAhead === true || (opts.lookAhead === "app" && appLookAhead(n, rounds, r + 1))) constraints.lookAhead = true;
    const round = pairRound(standings, history, constraints);
    opts.onRound?.({ standings, history, constraints, result: round });
    if (!round.ok) return { rounds: out, refusals: [round], colours, played, byes };

    for (const p of round.pairings) {
      played.add(pairKey(p.home, p.away));
      if (opts.chess === true) {
        pushColour(p.home, "W");
        pushColour(p.away, "B");
      }
      // Stronger side usually wins; 30% upset keeps colours decorrelated from score.
      const strong = (rank.get(p.home) as number) < (rank.get(p.away) as number) ? p.home : p.away;
      const weak = strong === p.home ? p.away : p.home;
      const winner = rng() < 0.7 ? strong : weak;
      score.set(winner, (score.get(winner) as number) + 1);
    }
    if (round.bye !== undefined) {
      byes.add(round.bye);
      score.set(round.bye, (score.get(round.bye) as number) + 1);
    }
    out.push({ pairings: round.pairings, ...(round.bye === undefined ? {} : { bye: round.bye }) });
  }
  return { rounds: out, refusals: [], colours, played, byes };
}

describe("pairRound — golden 5-round Swiss on 9 entrants (spec 05 acceptance)", () => {
  const sim = simulate(9, 5, { seed: 7 });

  it("pairs every round with exactly one bye (odd field)", () => {
    expect(sim.refusals).toEqual([]);
    expect(sim.rounds).toHaveLength(5);
    for (const round of sim.rounds) {
      expect(round.pairings).toHaveLength(4);
      expect(round.bye).toBeDefined();
    }
  });

  it("gives a distinct bye each round (lowest-ranked not-yet-byed)", () => {
    const byes = sim.rounds.map((r) => r.bye);
    expect(new Set(byes).size).toBe(5);
  });

  it("has zero rematches across the whole event", () => {
    const seen = new Set<string>();
    for (const round of sim.rounds) {
      for (const p of round.pairings) {
        const key = pairKey(p.home, p.away);
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
  });
});

describe("pairRound — bye selection (spec 05 §2.2)", () => {
  it("byes the lowest-ranked entrant not yet byed", () => {
    const standings: SwissStanding[] = field(5).map((id, i) => ({ entrantId: id, score: 0, rank: i + 1 }));
    // p4 already byed ⇒ next-lowest un-byed is p3.
    const round = pairRound(standings, { played: new Set(), byes: new Set(["p4"]) });
    expect(round.ok).toBe(true);
    if (!round.ok) return;
    expect(round.bye).toBe("p3");
    expect(round.pairings).toHaveLength(2);
  });

  it("round 1 on an even field pairs the upper board as White (chess)", () => {
    const standings: SwissStanding[] = field(4).map((id, i) => ({ entrantId: id, score: 0, rank: i + 1 }));
    const round = pairRound(standings, { played: new Set() }, { chess: true });
    expect(round.ok).toBe(true);
    if (!round.ok) return;
    // Fold 1v3, 2v4; the stronger side of each pair takes White (home).
    expect(round.bye).toBeUndefined();
    expect(round.pairings).toHaveLength(2);
    for (const p of round.pairings) {
      expect(Number(p.home.slice(1))).toBeLessThan(Number(p.away.slice(1)));
    }
  });
});

// ---------------------------------------------------------------------------
// X-SW-1 — the invariants every simulated event owes (spec 05 §6; rulebook-W3 §2.1, §3.1)
// ---------------------------------------------------------------------------

// What a whole event owes, round by round, and its round count: every round asked for is paired, or the event stopped at a
// refusal the rules allow (T1 review: a refusal may never silently shorten what a property checks).
interface EventTally {
  events: number;
  rounds: number;
  boards: number;
  byes: number;
  refused: number;
  refusalsProved: number;
  withinSafeMax: number; // refusals at or before the safe maximum ⌊n/2⌋: only chess may have one (the Dirac clause below)
}
const newTally = (): EventTally => ({ events: 0, rounds: 0, boards: 0, byes: 0, refused: 0, refusalsProved: 0, withinSafeMax: 0 });

// An event built from boards already played (White first) with the engine's real answer for the next round, for a case the
// simulation's own events do not reach. Even fields only (no byes); every score is 0, which existence does not read.
function eventFrom(n: number, boards: readonly (readonly (readonly [string, string])[])[]): SimEvent {
  const colours = new Map<string, Colour[]>(field(n).map((id) => [id, []]));
  const played = new Set<string>();
  const rounds: SimRound[] = boards.map((round) => ({
    pairings: round.map(([home, away]) => {
      (colours.get(home) as Colour[]).push("W");
      (colours.get(away) as Colour[]).push("B");
      played.add(pairKey(home, away));
      return { home, away };
    }),
  }));
  const next = pairRound(field(n).map((id, i) => ({ entrantId: id, score: 0, rank: i + 1 })), { played, colours, byes: new Set() }, { chess: true });
  return { rounds, refusals: next.ok ? [] : [next], colours, played, byes: new Set() };
}

function checkEvent(sim: SimEvent, n: number, asked: number, chess: boolean, t: EventTally): void {
  t.events++;
  const seen = new Set<string>();
  const byed = new Set<string>();
  for (const round of sim.rounds) {
    t.rounds++;
    t.boards += round.pairings.length;
    if (round.bye !== undefined) t.byes++;
    const seated = [...round.pairings.flatMap((p) => [p.home, p.away]), ...(round.bye === undefined ? [] : [round.bye])];
    expect(new Set(seated).size).toBe(n); // P-A3: every active entrant…
    expect(seated).toHaveLength(n); // …exactly once
    expect(round.pairings).toHaveLength(Math.floor(n / 2));
    expect(round.bye !== undefined).toBe(n % 2 === 1); // a bye exactly when the field is odd
    for (const p of round.pairings) {
      const k = pairKey(p.home, p.away);
      expect(seen.has(k)).toBe(false); // P-A1
      seen.add(k);
    }
    if (round.bye !== undefined) {
      expect(byed.has(round.bye)).toBe(false); // P-A4
      byed.add(round.bye);
    }
  }
  const [refusal] = sim.refusals;
  if (refusal === undefined) {
    expect(sim.rounds).toHaveLength(asked); // the round count: nothing was cut short
    return;
  }
  t.refused++;
  expect(sim.refusals).toHaveLength(1);
  const roundNo = sim.rounds.length + 1;
  expect(roundNo).toBeLessThanOrEqual(asked);
  expect(refusal.field).toBe(n);
  // P-A6 at harness sizes (rulebook §2.3 bound): the search budget decides a field this small, never "ran out"
  expect(refusal.reason).not.toBe("search_limit");
  // Rulebook §3.1: up to the safe maximum ⌊n/2⌋ a rematch-free round exists whatever was paired before (Dirac), with a bye
  // candidate to spare, so only the chess colour limits can refuse a round there
  if (roundNo <= Math.floor(n / 2)) {
    t.withinSafeMax++;
    expect({ roundNo, n, chess }).toEqual({ roundNo, n, chess: true });
    expect(refusal.reason).toBe("colour");
  }
  // n ≤ 12: the oracle proves the refusal: no legal round exists, for the reason it names (rulebook §2.3 item 3)
  if (n <= ORACLE_MAX_FIELD) {
    const v = judgeRound({
      field: field(n).map((id) => ({ id, score: 0 })),
      played: sim.rounds.flatMap((r) => r.pairings.map((p): [string, string] => [p.home, p.away])),
      byeIneligible: sim.byes,
      ...(chess ? { colours: sim.colours } : {}),
    });
    expect(v.exists).toBe(false);
    expect(refusal.reason).toBe(v.reason);
    t.refusalsProved++;
  }
}

// Per-test time budgets, SIZED from measured cost (controller ruling, T3 fix round 1: a derived budget is sizing, not
// masking; only the --testTimeout flag is banned). budget = max(FLOOR_MS, ceil((runs × p99 + max) × LOAD_SLACK)): the run's
// typical cost at its 99th-percentile case, plus room for the one slowest case it may draw, under load.
// CASE_MS: the cost of ONE case of each property, timed inside this harness with its assertions: a probe copy of this file
// that timed every fc.property case at 10× RUNS, run six times on the T4b tree (2026-10-31, load average 4–8; task-4b-report.md).
// p99 is over all six runs' cases; max is the slowest single case seen in any of them. Fix round 1 changed the invariant,
// rank_adjacent, chess and look-ahead properties (the look-ahead now off on an event's last round; two more oracle checks)
// and re-measured those four the same way, six more runs: each constant is the larger of the two measurements. The chess
// max is T1's big-field search (n 37–64, the look-ahead off there), not the look-ahead: the look-ahead's own calls in that
// property cost ≤ 2.7 ms.
// LOAD_SLACK: the review run at load average 114 took 9–14× the unloaded time; runs × p99 already sits well above each
// property's mean-cost total, so × 5 covers it.
const FLOOR_MS = 5_000; // vitest's default: no property gets less than any other test
const LOAD_SLACK = 5;
const CASE_MS = {
  invariant: { p99: 4.76, max: 35.0 },
  rankAdjacent: { p99: 2.85, max: 25.4 },
  chess: { p99: 12.98, max: 2338.3 },
  lookAhead: { p99: 15.8, max: 96.6 },
  determinism: { p99: 2.89, max: 36.7 },
  existence: { p99: 2.44, max: 81.1 },
  byeMinimality: { p99: 2.44, max: 59.6 },
  byeMinimalityLookAhead: { p99: 4.76, max: 38.2 },
} as const;
const budgetMs = (runs: number, cost: { p99: number; max: number }): number =>
  Math.max(FLOOR_MS, Math.ceil((runs * cost.p99 + cost.max) * LOAD_SLACK));
const RUNS = { invariant: 200, rankAdjacent: 200, chess: 100, lookAhead: 100, freshRounds: 100, historyRounds: 200, existence: 1000, byeMinimality: 500 } as const;

// The properties below pair as the app does (appLookAhead, above simulate): with the look-ahead on for every round but the
// last of an event that plays more rounds than ⌊n/2⌋. Each counts the rounds it paired that way.
const countLookAhead = (count: { rounds: number }) => ({ constraints }: PairedRoundSeen): void => {
  if (constraints.lookAhead === true) count.rounds++;
};

describe("X-SW-1 every paired round seats each active entrant exactly once, with no rematch and no second bye (spec 05 §6; rulebook §2.1)", () => {
  it("X-SW-1 every paired round seats each active entrant exactly once: ⌊n/2⌋ boards, one bye iff n odd, no rematch, no second bye (n 2–64, counted)", () => {
    const runs = RUNS.invariant;
    const t = newTally();
    const lookAheadRounds = { rounds: 0 };
    fc.assert(
      fc.property(
        // half the events at n ≤ 12, where the rounds asked for pass the safe maximum and the oracle proves the refusal
        fc.oneof(fc.integer({ min: 2, max: ORACLE_MAX_FIELD }), fc.integer({ min: 2, max: 64 })),
        fc.integer({ min: 1, max: 6 }),
        fc.integer(),
        (n, r, seed) => checkEvent(simulate(n, r, { seed, lookAhead: "app", onRound: countLookAhead(lookAheadRounds) }), n, r, false, t),
      ),
      { numRuns: runs },
    );
    expect(t.events).toBe(runs); // anti-vacuity: every event ran, every round counted, and both endings were reached
    expect(lookAheadRounds.rounds).toBeGreaterThan(0); // some rounds past the safe maximum, paired with the look-ahead on
    expect(t.rounds).toBeGreaterThan(0);
    expect(t.boards).toBeGreaterThan(0);
    expect(t.byes).toBeGreaterThan(0);
    expect(t.refused).toBeGreaterThan(0);
    expect(t.refusalsProved).toBeGreaterThan(0);
  }, budgetMs(RUNS.invariant, CASE_MS.invariant));

  it("X-SW-1 another sport's shape: rank_adjacent pairing keeps the same invariant (counted)", () => {
    // the swiss_playoff / swiss_knockout templates pair rank-adjacent from round 2 (rulebook P-Q4, RB3-12)
    const runs = RUNS.rankAdjacent;
    const t = newTally();
    let differsFromFold = 0; // the shape reached the engine: the same seed paired by fold gives other boards
    const lookAheadRounds = { rounds: 0 };
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 20 }), fc.integer({ min: 1, max: 6 }), fc.integer(), (n, r, seed) => {
        const adjacent = simulate(n, r, { seed, pairing: "rank_adjacent", lookAhead: "app", onRound: countLookAhead(lookAheadRounds) });
        checkEvent(adjacent, n, r, false, t);
        if (JSON.stringify(adjacent.rounds) !== JSON.stringify(simulate(n, r, { seed, lookAhead: "app" }).rounds)) differsFromFold++;
      }),
      { numRuns: runs },
    );
    expect(t.events).toBe(runs);
    expect(t.rounds).toBeGreaterThan(0);
    expect(t.boards).toBeGreaterThan(0);
    expect(t.byes).toBeGreaterThan(0);
    expect(t.refused).toBeGreaterThan(0);
    expect(t.refusalsProved).toBeGreaterThan(0);
    expect(differsFromFold).toBeGreaterThan(0);
    expect(lookAheadRounds.rounds).toBeGreaterThan(0); // some rounds paired with the look-ahead on, as the app would
  }, budgetMs(RUNS.rankAdjacent, CASE_MS.rankAdjacent));

  it("X-SW-1 chess on: every paired round seats each entrant once, and the colour bounds hold: |W−B| ≤ 2, never three in a row; refusals counted, the colour refusal at the safe maximum witnessed (n 2–64, counted)", () => {
    const runs = RUNS.chess;
    const t = newTally();
    let sequences = 0;
    const lookAheadRounds = { rounds: 0 };
    fc.assert(
      // half the events at n ≤ 12, where refusals come (past the safe maximum) and the oracle proves them
      fc.property(fc.oneof(fc.integer({ min: 2, max: ORACLE_MAX_FIELD }), fc.integer({ min: 2, max: 64 })), fc.integer({ min: 1, max: 7 }), fc.integer(), (n, rounds, seed) => {
        const sim = simulate(n, rounds, { chess: true, seed, lookAhead: "app", onRound: countLookAhead(lookAheadRounds) });
        checkEvent(sim, n, rounds, true, t);
        for (const [, seq] of sim.colours) {
          sequences++;
          const w = seq.filter((c) => c === "W").length;
          const b = seq.length - w;
          expect(Math.abs(w - b)).toBeLessThanOrEqual(2);
          for (let i = 2; i < seq.length; i++) {
            expect(seq[i] === seq[i - 1] && seq[i - 1] === seq[i - 2]).toBe(false);
          }
        }
      }),
      { numRuns: runs },
    );
    expect(t.events).toBe(runs);
    expect(t.rounds).toBeGreaterThan(0);
    expect(sequences).toBeGreaterThan(0); // anti-vacuity: colour sequences were read
    expect(lookAheadRounds.rounds).toBeGreaterThan(0); // and some rounds past the safe maximum ran with the look-ahead on
    expect(t.refused).toBeGreaterThan(0); // the refusal half of checkEvent ran for chess…
    expect(t.refusalsProved).toBeGreaterThan(0); // …and the oracle proved some
    // The chess half of the Dirac clause, witnessed. The simulation's own events reached no refusal at or before ⌊n/2⌋ in
    // 15,000 chess events (2026-10-31): the engine's colour allocation steers clear of it. So this event is fixed: a legal
    // 8-entrant history found by a search over random legal matchings. After rounds 1–3, p0, p2 and p3 must have White (…BB)
    // and p4, p5 and p7 must have Black (…WW). p3, p5 and p7 can then each meet only p1 or p6, so round 4 = ⌊8/2⌋ has no
    // colour-legal pairing, although a rematch-free one exists (Dirac).
    const before = t.withinSafeMax;
    const witness = eventFrom(8, [
      [["p0", "p7"], ["p3", "p5"], ["p1", "p4"], ["p2", "p6"]],
      [["p1", "p0"], ["p7", "p3"], ["p4", "p6"], ["p5", "p2"]],
      [["p6", "p1"], ["p7", "p2"], ["p5", "p0"], ["p4", "p3"]],
    ]);
    expect(witness.refusals.map((r) => r.reason)).toEqual(["colour"]);
    const played = witness.rounds.flatMap((r) => r.pairings.map((p): [string, string] => [p.home, p.away]));
    expect(judgeRound({ field: field(8).map((id) => ({ id, score: 0 })), played, byeIneligible: new Set() }).exists).toBe(true); // colours lifted: Dirac
    checkEvent(witness, 8, 4, true, t);
    expect(t.withinSafeMax).toBe(before + 1);
  }, budgetMs(RUNS.chess, CASE_MS.chess));

  it("X-SW-1 X-SW-10 with lookAhead on every round keeps the invariant, and each round's nextRound is the next round's own outcome: 'pairable' is followed by a paired round, 'unpairable' by a refusal, as the oracle judges; boards move only when the plain seating dead-ends the next round (n 6–12, 5 rounds up to past the hard maximum, chess on and off, counted)", () => {
    const runs = RUNS.lookAhead;
    const t = newTally();
    const v = { verdicts: 0, pairable: 0, unpairable: 0, followedPaired: 0, followedRefused: 0, lastRound: 0, oracleAgreed: 0,
      noCompletionKeeps: 0, chessNoCompletionKeeps: 0, seatingsJudged: 0, keptFirst: 0, firstDeadEnds: 0, moved: 0, chessMoved: 0 };
    fc.assert(
      // 5 rounds at least; up to n + 1, past every field's hard maximum (rulebook §3.1), so the rounds where the next one
      // cannot pair, and the refusal that follows, are reached as well
      fc.property(fc.integer({ min: 6, max: ORACLE_MAX_FIELD }), fc.integer({ min: 5, max: ORACLE_MAX_FIELD + 1 }), fc.boolean(), fc.integer(), (n, asked, chess, seed) => {
        const verdicts: (string | undefined)[] = [];
        const sim = simulate(n, asked, {
          chess,
          seed,
          lookAhead: true,
          onRound: ({ standings, history, constraints, result }) => {
            if (!result.ok) {
              expect("nextRound" in result).toBe(false); // a refusal looks past nothing
              return;
            }
            verdicts.push(result.nextRound);
            v.verdicts++;
            expect(["pairable", "unpairable"]).toContain(result.nextRound); // n ≤ 12: the budget decides, never "unknown"
            // the oracle, from the rulebook: after this round as seated, does a legal next round exist?
            const round: OracleRound = {
              field: standings.map((s) => ({ id: s.entrantId, score: s.score })),
              played: [...history.played].map((k) => k.split("|") as [string, string]),
              byeIneligible: new Set(history.byes),
              ...(chess ? { colours: new Map(history.colours) } : {}),
            };
            expect({ seed, n, chess, next: judgeRound(roundAfter(round, result)).exists }).toEqual({ seed, n, chess, next: result.nextRound === "pairable" });
            v.oracleAgreed++;
            v[result.nextRound === "pairable" ? "pairable" : "unpairable"]++;
            // ruling R1 and the look-ahead's reach: the same bye as without it; count the rounds where it moved boards
            const plain = pairRound(standings, history, { ...constraints, lookAhead: false });
            expect({ ok: plain.ok, bye: plain.ok ? plain.bye : undefined }).toEqual({ ok: true, bye: result.bye });
            if (plain.ok && JSON.stringify(plain.pairings) !== JSON.stringify(result.pairings)) v[chess ? "chessMoved" : "moved"]++;
            // boards move only when they must: when the plain seating already leaves a legal next round (the oracle's
            // reading), the look-ahead keeps it, boards and sides
            if (plain.ok && judgeRound(roundAfter(round, plain)).exists) {
              expect({ seed, n, chess, result }).toEqual({ seed, n, chess, result: { ...plain, nextRound: "pairable" } });
              v.keptFirst++;
            } else {
              v.firstDeadEnds++;
            }
            if (result.nextRound !== "unpairable") return;
            // "unpairable" means no seating of this bye's remainder keeps the next round pairable: every one, judged. A
            // seating's sides are the rule's (the oracle's ruleSides: with chess, a colour P-A5 forces, else the record's
            // preferences), each board turned upper side first; with chess a pair that may not meet is no seating (P-A5)
            const of = new Map(standings.map((s) => [s.entrantId, s]));
            const above = (x: string, y: string): boolean => {
              const [a, b] = [of.get(x) as SwissStanding, of.get(y) as SwissStanding];
              return a.score !== b.score ? a.score > b.score : a.rank < b.rank;
            };
            const recordOf = (id: string): readonly Colour[] => history.colours?.get(id) ?? [];
            const rest = round.field.map((e) => e.id).filter((id) => id !== result.bye);
            let seatings = 0;
            for (const boards of perfectMatchings(rest, new Set(round.played.map(([a, b]) => oraclePairKey(a, b))))) {
              const sides = boards.map(([x, y]) => (above(x, y) ? ruleSides(x, y, recordOf, chess) : ruleSides(y, x, recordOf, chess)));
              const pairings = sides.filter((p) => p !== undefined);
              if (pairings.length < sides.length) continue;
              const seatedHere = { pairings, ...(result.bye === undefined ? {} : { bye: result.bye }) };
              expect({ seed, n, chess, boards, next: judgeRound(roundAfter(round, seatedHere)).exists }).toEqual({ seed, n, chess, boards, next: false });
              seatings++;
            }
            expect(seatings).toBeGreaterThan(0); // the seated round is one of them
            v.seatingsJudged += seatings;
            v[chess ? "chessNoCompletionKeeps" : "noCompletionKeeps"]++;
          },
        });
        checkEvent(sim, n, asked, chess, t);
        // each verdict against what the next round did: paired, or refused (the event stops there)
        verdicts.forEach((verdict, k) => {
          if (k + 1 < sim.rounds.length) {
            expect(verdict).toBe("pairable");
            v.followedPaired++;
          } else if (sim.refusals.length === 1) {
            expect(verdict).toBe("unpairable");
            v.followedRefused++;
          } else {
            v.lastRound++; // the last round asked: nothing after it
          }
        });
      }),
      { numRuns: runs },
    );
    // anti-vacuity: every event ran and was checked; both verdicts were reached and each was followed by the outcome it
    // names; the oracle judged every verdict; and the look-ahead moved boards, chess on and off
    expect(t.events).toBe(runs);
    expect(t.rounds).toBeGreaterThan(0);
    expect(v.verdicts).toBe(t.rounds);
    expect(v.pairable + v.unpairable).toBe(v.verdicts);
    expect(v.oracleAgreed).toBe(v.verdicts);
    expect(v.followedPaired + v.followedRefused + v.lastRound).toBe(v.verdicts);
    for (const [k, x] of Object.entries(v)) expect([k, x > 0]).toEqual([k, true]);
  }, budgetMs(RUNS.lookAhead, CASE_MS.lookAhead));

  it("X-SW-1 is deterministic: identical inputs yield identical results, a refusal included (counted)", () => {
    let fresh = 0;
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 32 }), (n) => {
        const standings: SwissStanding[] = field(n).map((id, i) => ({
          entrantId: id,
          score: i % 3,
          rank: i + 1,
        }));
        const a = pairRound(standings, { played: new Set() }, { chess: true });
        const b = pairRound(standings, { played: new Set() }, { chess: true });
        expect(a).toEqual(b);
        fresh++;
      }),
      { numRuns: RUNS.freshRounds },
    );
    expect(fresh).toBe(RUNS.freshRounds);
    // with a history (n ≤ 12): the second call agrees whether the round pairs or is refused
    const seenOutcome = { paired: 0, refused: 0 };
    fc.assert(
      fc.property(fc.integer({ min: 2, max: ORACLE_MAX_FIELD }), fc.boolean(), fc.integer(), (n, chess, seed) => {
        const c = randomRound(n, chess, seed);
        const a = pairRound(c.standings, c.history, { chess });
        expect(pairRound(c.standings, c.history, { chess })).toEqual(a);
        seenOutcome[a.ok ? "paired" : "refused"]++;
      }),
      { numRuns: RUNS.historyRounds },
    );
    expect(seenOutcome.paired + seenOutcome.refused).toBe(RUNS.historyRounds);
    expect(seenOutcome.paired).toBeGreaterThan(0);
    expect(seenOutcome.refused).toBeGreaterThan(0);
  }, budgetMs(RUNS.freshRounds + RUNS.historyRounds, CASE_MS.determinism));
});

// ---------------------------------------------------------------------------
// X-SW-1 — existence and bye minimality against the independent brute-force oracle (rulebook §2.3 items 3–4; RB3-24, n ≤ 12)
// ---------------------------------------------------------------------------

const otherColour = (c: Colour): Colour => (c === "W" ? "B" : "W");

// Fisher–Yates on a copy, driven by `rng`.
function shuffled<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

// One round as an event of n ≤ 12 can present it. 0..n earlier rounds are actually run: each is a random matching of pairs that
// have not met, and with chess colours on each board takes a colour assignment P-A5 allows both sides (a pair no assignment suits
// does not meet). So every colour history is one a legal event produces, at EVERY step (T2 report, concern 3), and `played` and
// the colours agree. `repeat` tilts boards toward repeating a side's last colour, which makes the absolute preferences — and the
// colour clashes — a tight field has. Scores are random in {0, 1, 2} (several score groups), and a random share of the field is
// bye-ineligible (P-A4). The engine gets its own history (swiss.ts's pairKey); the oracle gets the same facts as pairs.
interface RoundCase {
  standings: SwissStanding[];
  history: SwissHistory;
  judged: OracleRound;
}
function randomRound(n: number, chess: boolean, seed: number): RoundCase {
  const rng = prng(seed);
  const ids = field(n);
  const met: [string, string][] = [];
  const metKeys = new Set<string>();
  const colours = new Map(ids.map((id) => [id, [] as Colour[]]));
  const seq = (id: string): Colour[] => colours.get(id) as Colour[];
  const repeat = rng();
  const earlier = Math.floor(rng() * (n + 1));
  for (let k = 0; k < earlier; k++) {
    const order = shuffled(ids, rng);
    const seated = new Set<string>();
    for (const a of order) {
      if (seated.has(a)) continue;
      const b = order.find(
        (x) => x !== a && !seated.has(x) && !metKeys.has(oraclePairKey(a, x)) && (!chess || colourCompatible(seq(a), seq(x))),
      );
      if (b === undefined) continue; // a sits this round out
      seated.add(a);
      seated.add(b);
      met.push([a, b]);
      metKeys.add(oraclePairKey(a, b));
      if (chess) {
        const options = (["W", "B"] as const).filter((c) => mayTake(seq(a), c) && mayTake(seq(b), otherColour(c)));
        const last = seq(a).at(-1);
        const c: Colour =
          options.length === 1
            ? (options[0] as Colour)
            : last !== undefined && rng() < repeat
              ? last
              : rng() < 0.5
                ? "W"
                : "B";
        seq(a).push(c);
        seq(b).push(otherColour(c));
      }
    }
  }
  const standings: SwissStanding[] = ids.map((id, i) => ({ entrantId: id, score: Math.floor(rng() * 3), rank: i + 1 }));
  const byeRate = rng();
  const byes = new Set(ids.filter(() => rng() < byeRate));
  return {
    standings,
    history: { played: new Set(met.map(([a, b]) => pairKey(a, b))), byes, ...(chess ? { colours } : {}) },
    judged: {
      field: standings.map((s) => ({ id: s.entrantId, score: s.score })),
      played: met,
      byeIneligible: byes,
      ...(chess ? { colours } : {}),
    },
  };
}

// Rulebook §2.3 item 4 (P-Q2's hard core; A3 [C5] outranks every other quality criterion): on every paired odd round, no
// eligible entrant with a strictly LOWER score than the bye leaves a pairable remainder. `extra` is the stage's other
// constraints: ruling R1 binds the look-ahead (X-SW-10) to this too. With `lookAhead` on, each case is also paired without
// it, and R1 is read directly: the same answer and the same bye; `moved` counts the cases where the look-ahead moved boards.
function byeMinimality(
  extra: SwissConstraints,
  runs: number,
): { byeCases: number; chessByes: number; openByes: number; climbed: number; lowerChecked: number; refused: number; moved: number } {
  const t = { byeCases: 0, chessByes: 0, openByes: 0, climbed: 0, lowerChecked: 0, refused: 0, moved: 0 };
  fc.assert(
    fc.property(fc.integer({ min: 1, max: Math.floor((ORACLE_MAX_FIELD - 1) / 2) }), fc.boolean(), fc.integer(), (k, chess, seed) => {
      const n = 2 * k + 1; // odd: 3..11
      const c = randomRound(n, chess, seed);
      const r = pairRound(c.standings, c.history, { ...extra, chess });
      if (extra.lookAhead === true) {
        const plain = pairRound(c.standings, c.history, { chess });
        expect({ seed, n, chess, ok: r.ok, bye: r.ok ? r.bye : undefined }).toEqual({ seed, n, chess, ok: plain.ok, bye: plain.ok ? plain.bye : undefined });
        if (r.ok && plain.ok && JSON.stringify(r.pairings) !== JSON.stringify(plain.pairings)) t.moved++;
      }
      if (!r.ok) {
        t.refused++; // whether it should have paired is the existence property's question
        return;
      }
      expect(r.bye).toBeDefined();
      const bye = r.bye as string;
      const v = judgeRound(c.judged);
      expect(v.pairableByes).toContain(bye);
      expect({ seed, n, chess, bye, lowerPairable: lowerScoredPairableByes(c.judged, v, bye) }).toEqual({ seed, n, chess, bye, lowerPairable: [] });
      const score = new Map(c.standings.map((s) => [s.entrantId, s.score]));
      const lower = v.eligible.filter((id) => (score.get(id) as number) < (score.get(bye) as number));
      t.byeCases++;
      t[chess ? "chessByes" : "openByes"]++;
      t.lowerChecked += lower.length;
      if (lower.length > 0) t.climbed++; // the bye climbed past lower-scored candidates, each proved unpairable
    }),
    { numRuns: runs },
  );
  return t;
}

describe("X-SW-1 existence and bye minimality against an independent brute-force oracle (rulebook §2.3 items 3–4; RB3-24, n ≤ 12)", () => {
  it("X-SW-1 (P-A6) pairs whenever a legal pairing exists and refuses only when none does — odd and even, several score groups, chess on and off (brute force n ≤ 12, counted)", () => {
    const runs = RUNS.existence; // a colour refusal is ~1.8% of cases: 1000 leave P(none) ≈ 1e-8
    const t = { cases: 0, paired: 0, refused: 0, rematch: 0, colour: 0, noBye: 0, evenPaired: 0, oddPaired: 0, chessPaired: 0, openPaired: 0, multiGroupPaired: 0, multiGroupRefused: 0, matchings: 0 };
    fc.assert(
      fc.property(fc.integer({ min: 2, max: ORACLE_MAX_FIELD }), fc.boolean(), fc.integer(), (n, chess, seed) => {
        const c = randomRound(n, chess, seed);
        const r = pairRound(c.standings, c.history, { chess });
        const v = judgeRound(c.judged);
        t.cases++;
        t.matchings += v.matchingsChecked;
        const multiGroup = new Set(c.standings.map((s) => s.score)).size > 1;
        expect({ seed, n, chess, ok: r.ok }).toEqual({ seed, n, chess, ok: v.exists });
        if (r.ok) {
          expect(seatedRoundViolations(c.judged, r)).toEqual([]); // P-A1, P-A3, P-A4, P-A5 as seated
          t.paired++;
          t[n % 2 === 0 ? "evenPaired" : "oddPaired"]++;
          t[chess ? "chessPaired" : "openPaired"]++;
          if (multiGroup) t.multiGroupPaired++;
          return;
        }
        // the refusal names the reason (§3.3, ruling R2): no_bye_candidate iff the field is odd and nobody is eligible, else
        // colour or rematch
        expect(r).toEqual({ ok: false, code: SWISS_NO_LEGAL_PAIRING, reason: v.reason, field: n });
        expect(r.reason === "no_bye_candidate").toBe(n % 2 === 1 && v.eligible.length === 0);
        t.refused++;
        if (r.reason === "rematch") t.rematch++;
        if (r.reason === "colour") t.colour++;
        if (r.reason === "no_bye_candidate") t.noBye++;
        if (multiGroup) t.multiGroupRefused++;
      }),
      { numRuns: runs },
    );
    // anti-vacuity: every case ran; both outcomes, every refusal reason, odd and even, chess on and off and several score
    // groups were reached; and the oracle answered matchings
    expect(t.cases).toBe(runs);
    expect(t.paired + t.refused).toBe(runs);
    for (const [k, v] of Object.entries(t)) expect([k, v > 0]).toEqual([k, true]);
  }, budgetMs(RUNS.existence, CASE_MS.existence));

  it("X-SW-1 bye minimality: no eligible entrant with a strictly lower score leaves a pairable remainder (rulebook §2.3 item 4, n ≤ 12, counted)", () => {
    const t = byeMinimality({}, RUNS.byeMinimality); // a climbed bye is ~4% of cases: 500 leave P(none) ≈ 1e-9
    expect(t.byeCases).toBeGreaterThan(0);
    expect(t.chessByes).toBeGreaterThan(0); // chess on…
    expect(t.openByes).toBeGreaterThan(0); // …and off
    expect(t.refused).toBeGreaterThan(0); // refusals reached too (their existence is the property above's)
    expect(t.climbed).toBeGreaterThan(0); // the check met lower-scored candidates and proved each one unpairable
    expect(t.lowerChecked).toBeGreaterThan(0);
  }, budgetMs(RUNS.byeMinimality, CASE_MS.byeMinimality));

  // Ruling R1: the look-ahead ranks completions only WITHIN the bye candidate the property above pins; it never moves the bye.
  it("X-SW-1 X-SW-10 bye minimality holds with lookAhead on (ruling R1): the same bye as without it, minimal, while the look-ahead moves boards (n ≤ 12, counted)", () => {
    const t = byeMinimality({ lookAhead: true }, RUNS.byeMinimality);
    expect(t.byeCases).toBeGreaterThan(0);
    expect(t.chessByes).toBeGreaterThan(0);
    expect(t.openByes).toBeGreaterThan(0);
    expect(t.refused).toBeGreaterThan(0);
    expect(t.climbed).toBeGreaterThan(0);
    expect(t.lowerChecked).toBeGreaterThan(0);
    expect(t.moved).toBeGreaterThan(0); // the look-ahead was live: it moved boards, and never the bye
  }, budgetMs(RUNS.byeMinimality, CASE_MS.byeMinimalityLookAhead));

  it("X-SW-1 the oracle is independent: src/testkit/swiss-oracle.ts imports nothing from scheduling or competition", () => {
    const source = readFileSync(fileURLToPath(new URL("../testkit/swiss-oracle.ts", import.meta.url)), "utf8");
    // the read is of the oracle, not of an empty or moved file
    expect(source).toMatch(/export function judgeRound\(/);
    expect(source).toMatch(/export function perfectMatchingExists\(/);
    // every module specifier the file names: static imports, re-exports and dynamic imports
    const named = (text: string): string[] =>
      [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g)]
        .map((m) => m[1] as string)
        .filter((s) => /scheduling|competition|swiss/.test(s));
    expect(named(source)).toEqual([]);
    // the scan sees such an import when there is one
    expect(named(`${source}\nimport { pairRound } from "../scheduling/swiss.ts";\n`)).toEqual(["../scheduling/swiss.ts"]);
    // and it copies none of swiss.ts's colour and search helpers by name (review M5)
    for (const helper of ["canTake", "colourLegal", "hardLegal", "assignColours", "preferredColour", "colourState", "orderCandidates", "matchWithin", "pairFrom", "floaterChoices"]) {
      expect([helper, source.includes(helper)]).toEqual([helper, false]);
    }
  });
});

describe("X-SW-1 the brute-force oracle answers hand-worked cases from the rulebook (RB3-24, the n ≤ 12 half)", () => {
  const W = "W" as const;
  const B = "B" as const;

  it("X-SW-1 oracle colour limits (P-A5; C.04.1 r.6–7, C.04.3 [C3]): |W−B| ≤ 2 after the round and never three of one colour running, read pairwise", () => {
    expect([mayTake([], W), mayTake([], B)]).toEqual([true, true]);
    expect([mayTake([W, W], W), mayTake([W, W], B)]).toEqual([false, true]); // three running
    expect([mayTake([B, B], B), mayTake([B, B], W)]).toEqual([false, true]);
    expect([mayTake([W, B, W, W], W), mayTake([W, B, W, W], B)]).toEqual([false, true]); // +2 now: White would make +3
    expect(mayTake([W, B, W], W)).toBe(true); // +2 after, two running: within both limits
    expect(mayTake([B, W, B, B], B)).toBe(false); // −2 now: Black would make −3
    // [C3]: two with the same absolute preference cannot meet; any other pair has an assignment
    expect(colourCompatible([W, W], [W, W])).toBe(false);
    expect(colourCompatible([W, B, W, W], [W, W])).toBe(false);
    expect(colourCompatible([W, W], [B, B])).toBe(true);
    expect(colourCompatible([W, W], [])).toBe(true);
    expect(colourCompatible([W, B, W, W], [B, W, B, B])).toBe(true);
    // a history a legal event produces holds both limits after every round of it
    expect([colourHistoryLegal([]), colourHistoryLegal([W, W, B, B]), colourHistoryLegal([W, B, W, W, B])]).toEqual([true, true, true]);
    expect([colourHistoryLegal([W, W, W]), colourHistoryLegal([B, B, W, B, B]), colourHistoryLegal([B, B, B, B])]).toEqual([false, false, false]);
  });

  it("X-SW-1 oracle matching (P-A6): K4 splits into three perfect matchings; a 6-cycle's three diameters leave two triangles (rulebook §3.1, §3.2)", () => {
    const k = (pairs: [string, string][]): Set<string> => new Set(pairs.map(([a, b]) => oraclePairKey(a, b)));
    expect(perfectMatchingExists([], new Set())).toBe(true); // nobody to seat
    expect(perfectMatchingExists(["a", "b"], k([["a", "b"]]))).toBe(false);
    expect(perfectMatchingExists(["a", "b", "c"], new Set())).toBe(false); // an odd pool has no perfect matching
    // K4 = {a-b, c-d} ∪ {a-c, b-d} ∪ {a-d, b-c}: after two of them the third is left; after all three nothing
    const k4 = ["a", "b", "c", "d"];
    expect(perfectMatchingExists(k4, k([["a", "b"], ["c", "d"]]))).toBe(true);
    expect(perfectMatchingExists(k4, k([["a", "b"], ["c", "d"], ["a", "c"], ["b", "d"]]))).toBe(true);
    expect(perfectMatchingExists(k4, k([["a", "b"], ["c", "d"], ["a", "c"], ["b", "d"], ["a", "d"], ["b", "c"]]))).toBe(false);
    // rulebook §3.1's 6 × 5 audit case: rounds 1–2 a 6-cycle, round 3 the diameters ⇒ the unplayed pairs are two triangles
    const six = field(6);
    const cycle: [string, string][] = [["p0", "p1"], ["p2", "p3"], ["p4", "p5"], ["p0", "p5"], ["p1", "p2"], ["p3", "p4"]];
    expect(perfectMatchingExists(six, k(cycle))).toBe(true);
    expect(perfectMatchingExists(six, k([...cycle, ["p0", "p3"], ["p1", "p4"], ["p2", "p5"]]))).toBe(false);
    expect(perfectMatchingExists(six, k([...cycle, ["p0", "p2"], ["p1", "p4"], ["p3", "p5"]]))).toBe(true);
  });

  it("X-SW-1 oracle verdicts: an odd field's pairable byes, the reason when none pairs, and bye minimality (rulebook §2.3 items 3–4, §3.3, ruling R2)", () => {
    const at = (scores: Record<string, number>): OracleRound["field"] => Object.entries(scores).map(([id, score]) => ({ id, score }));
    // a, b, c with a–b met: removing a or b leaves a fresh pair, removing c leaves the rematch
    const one = judgeRound({ field: at({ a: 0, b: 0, c: 0 }), played: [["a", "b"]] });
    expect(one).toMatchObject({ exists: true, eligible: ["a", "b", "c"], pairableByes: ["a", "b"] });
    expect(one.reason).toBeUndefined();
    expect(one.matchingsChecked).toBe(3);
    // all three met: no bye leaves a pair ⇒ rematch
    expect(judgeRound({ field: at({ a: 0, b: 0, c: 0 }), played: [["a", "b"], ["a", "c"], ["b", "c"]] })).toMatchObject({ exists: false, pairableByes: [], reason: "rematch" });
    // the three rotated the bye (rulebook §3.1: an odd field's impossibility starts at n + 1) ⇒ no_bye_candidate
    expect(judgeRound({ field: at({ a: 0, b: 0, c: 0 }), played: [], byeIneligible: new Set(["a", "b", "c"]) })).toMatchObject({ exists: false, eligible: [], reason: "no_bye_candidate" });
    // chess: two who never met, each White twice running ⇒ colour; colours off, the same two pair
    const ww = new Map([["a", [W, W]], ["b", [W, W]]]);
    expect(judgeRound({ field: at({ a: 0, b: 0 }), played: [], colours: ww })).toMatchObject({ exists: false, reason: "colour" });
    expect(judgeRound({ field: at({ a: 0, b: 0 }), played: [] })).toMatchObject({ exists: true });
    // bye minimality: x (0) below y, z (1). With y–z met x's removal leaves the rematch, so a bye on z is minimal…
    const blocked = { field: at({ x: 0, y: 1, z: 1 }), played: [["y", "z"]] as [string, string][] };
    const vb = judgeRound(blocked);
    expect(vb.pairableByes).toEqual(["y", "z"]);
    expect(lowerScoredPairableByes(blocked, vb, "z")).toEqual([]);
    // …and with y–z fresh, x leaves a pair, so a bye on z is not
    const open = { field: at({ x: 0, y: 1, z: 1 }), played: [] as [string, string][] };
    expect(lowerScoredPairableByes(open, judgeRound(open), "z")).toEqual(["x"]);
    // a seated round is judged rule by rule
    expect(seatedRoundViolations(blocked, { pairings: [{ home: "y", away: "x" }], bye: "z" })).toEqual([]);
    expect(seatedRoundViolations(blocked, { pairings: [{ home: "y", away: "z" }], bye: "x" })).toEqual(["P-A1 y v z have met"]);
    expect(seatedRoundViolations({ ...blocked, byeIneligible: new Set(["z"]) }, { pairings: [{ home: "y", away: "x" }], bye: "z" })).toEqual(["P-A4 z may not take the bye"]);
    expect(seatedRoundViolations(blocked, { pairings: [{ home: "y", away: "x" }] })).toEqual(["P-A3 z is seated 0 times", "P-A3 a bye is owed exactly when the field is odd"]);
    expect(seatedRoundViolations({ field: at({ a: 0, b: 0 }), played: [], colours: new Map([["a", [W, W]]]) }, { pairings: [{ home: "a", away: "b" }] })).toEqual(["P-A5 a may not take W"]);
  });

  it("X-SW-1 oracle guards: a field outside 2 ≤ n ≤ 12, a duplicated or unkeyable entrant, a foreign pair key, an unknown bye or a colour history no legal event produces is refused by name (assumptions → guards)", () => {
    const flat = (n: number): OracleRound["field"] => field(n).map((id) => ({ id, score: 0 }));
    expect(() => judgeRound({ field: flat(ORACLE_MAX_FIELD + 1), played: [] })).toThrow(/2 ≤ n ≤ 12/);
    expect(() => judgeRound({ field: flat(1), played: [] })).toThrow(/2 ≤ n ≤ 12/);
    expect(judgeRound({ field: flat(ORACLE_MAX_FIELD), played: [] }).exists).toBe(true); // the bound itself is in range
    expect(() => perfectMatchingExists(field(ORACLE_MAX_FIELD + 2), new Set())).toThrow(/n ≤ 12/);
    expect(() => judgeRound({ field: [{ id: "a", score: 0 }, { id: "a", score: 1 }], played: [] })).toThrow(/twice/);
    expect(() => perfectMatchingExists(["a", "b|c"], new Set())).toThrow(/"\|"/);
    // a key the oracle did not build (another order, another separator) would silently forbid nothing
    expect(() => perfectMatchingExists(["a", "b"], new Set(["b|a"]))).toThrow(/pair key/);
    expect(() => perfectMatchingExists(["a", "b"], new Set(["a-b"]))).toThrow(/pair key/);
    expect(perfectMatchingExists(["a", "b"], new Set([oraclePairKey("b", "a")]))).toBe(false);
    expect(() => lowerScoredPairableByes({ field: flat(3), played: [] }, judgeRound({ field: flat(3), played: [] }), "q9")).toThrow(/not in the field/);
    // BBBB (−4) is outside the limits already; the oracle refuses it rather than judge a round no legal event reaches
    expect(() => judgeRound({ field: flat(2), played: [], colours: new Map([["p0", [B, B, B, B]]]) })).toThrow(/colour history/);
    // a colour that is neither W nor B would count as Black and pass unnoticed
    expect(() => mayTake(["X" as unknown as Colour], W)).toThrow(/neither "W" nor "B"/);
  });
});

describe("X-SW-2 bye retry and the whole-field search against a brute-force oracle (P-Q2, P-A6, ruling R2)", () => {
  it("X-SW-2 several score groups, odd and even, chess on and off: pairs iff a legal round exists, byes the first candidate from the bottom whose removal leaves one, else names the reason", () => {
    const CASES = 1500;
    const tally = { paired: 0, retried: 0, noBye: 0, rematch: 0, colour: 0, multiGroupPaired: 0, multiGroupRefused: 0 };
    for (let seed = 1; seed <= CASES; seed++) {
      const rng = prng(seed);
      const n = 2 + Math.floor(rng() * 8); // 2..9
      const ids = field(n);
      const chess = seed % 2 === 0;
      const standings: SwissStanding[] = ids.map((id, i) => ({ entrantId: id, score: Math.floor(rng() * 3), rank: i + 1 }));
      const density = rng() * 0.6;
      const byeRate = rng();
      const met: [string, string][] = [];
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) if (rng() < density) met.push([ids[i] as string, ids[j] as string]);
      }
      const played = new Set(met.map(([a, b]) => pairKey(a, b))); // the engine's history
      const metForOracle = new Set(met.map(([a, b]) => oraclePairKey(a, b))); // the same facts, keyed by the oracle
      const byes = new Set(ids.filter(() => rng() < byeRate));
      // a colour history a legal event can produce: every round's colour met P-A5 (a random colour, else the other one,
      // which a legal prefix always allows)
      const history = (): Colour[] => {
        const seq: Colour[] = [];
        for (let k = Math.floor(rng() * 5); k > 0; k--) {
          const c: Colour = rng() < 0.5 ? "W" : "B";
          seq.push(mayTake(seq, c) ? c : c === "W" ? "B" : "W");
        }
        return seq;
      };
      const colours = new Map(ids.map((id) => [id, history()]));
      const seq = (id: string): Colour[] => colours.get(id) as Colour[];
      // every pair the round may not seat: a rematch (P-A1), or (chess) no colour assignment suits both (P-A5)
      const forbidden = new Set(metForOracle);
      if (chess) {
        for (let i = 0; i < n; i++) {
          for (let j = i + 1; j < n; j++) {
            const a = ids[i] as string, b = ids[j] as string;
            if (!colourCompatible(seq(a), seq(b))) forbidden.add(oraclePairKey(a, b));
          }
        }
      }
      // P-Q2's candidates: the eligible entrants (P-A4), lowest score first, then lowest-ranked; an even field has none
      const bottomUp = [...standings].sort((a, b) => a.score - b.score || b.rank - a.rank);
      const candidates: (string | undefined)[] =
        n % 2 === 0 ? [undefined] : bottomUp.filter((s) => !byes.has(s.entrantId)).map((s) => s.entrantId);
      const without = (id: string | undefined): string[] => ids.filter((x) => x !== id);
      const multiGroup = new Set(standings.map((s) => s.score)).size > 1;

      // One comparison per case, tagged with its seed: a round is compared through what the rules ask of it.
      const seen = (r: ReturnType<typeof pairRound>): unknown => {
        if (!r.ok) return r;
        const seated = [...r.pairings.flatMap((p) => [p.home, p.away]), ...(r.bye === undefined ? [] : [r.bye])];
        return {
          bye: "bye" in r ? r.bye : "(none)",
          seatsEachOnce: seated.length === n && new Set(seated).size === n && seated.every((id) => ids.includes(id)), // P-A3
          noRematch: r.pairings.every((p) => !played.has(pairKey(p.home, p.away))), // P-A1
          coloursLegal: !chess || r.pairings.every((p) => mayTake(seq(p.home), "W") && mayTake(seq(p.away), "B")), // P-A5, as seated
        };
      };
      const r = pairRound(standings, { played, colours, byes }, { chess });
      let want: unknown;
      if (candidates.length === 0) {
        want = { ok: false, code: "SWISS_NO_LEGAL_PAIRING", reason: "no_bye_candidate", field: n };
        tally.noBye++;
      } else {
        const winner = candidates.findIndex((c) => perfectMatchingExists(without(c), forbidden));
        if (winner >= 0) {
          // P-Q2: the bye is the first candidate from the bottom whose removal leaves a legal round
          want = { bye: n % 2 === 1 ? candidates[winner] : "(none)", seatsEachOnce: true, noRematch: true, coloursLegal: true };
          tally.paired++;
          if (winner > 0) tally.retried++;
          if (multiGroup) tally.multiGroupPaired++;
        } else {
          // ruling R2: "colour" iff some candidate's remainder pairs once the colour limits are lifted, else "rematch"
          const reason = chess && candidates.some((c) => perfectMatchingExists(without(c), metForOracle)) ? "colour" : "rematch";
          want = { ok: false, code: "SWISS_NO_LEGAL_PAIRING", reason, field: n };
          tally[reason]++;
          if (multiGroup) tally.multiGroupRefused++;
        }
      }
      expect({ seed, round: seen(r) }).toEqual({ seed, round: want });
    }
    // anti-vacuity: every case lands in exactly one outcome, and every outcome (and the retry) is reached
    expect(tally.paired + tally.noBye + tally.rematch + tally.colour).toBe(CASES);
    for (const [k, v] of Object.entries(tally)) expect([k, v > 0]).toEqual([k, true]);
  });
});
