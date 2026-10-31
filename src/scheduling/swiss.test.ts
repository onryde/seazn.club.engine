// Swiss pairing — spec 05 §2.2, invariants §6.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  pairKey,
  pairRound,
  type Colour,
  type SwissHistory,
  type SwissRefusal,
  type SwissStanding,
} from "./swiss.ts";

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
// round (SWISS_NO_LEGAL_PAIRING) seats nothing: the event stops there and the
// refusal is returned beside the rounds that were paired.
interface SimRound {
  pairings: { home: string; away: string }[];
  bye?: string;
}
function simulate(
  n: number,
  rounds: number,
  opts: { chess?: boolean; seed?: number } = {},
): {
  rounds: SimRound[];
  colours: Map<string, Colour[]>;
  played: Set<string>;
  byes: Set<string>;
  refusal?: SwissRefusal;
} {
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
    const round = pairRound(standings, history, { chess: opts.chess === true, byeScore: 1 });
    if (!round.ok) return { rounds: out, colours, played, byes, refusal: round };

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
  return { rounds: out, colours, played, byes };
}

describe("pairRound — golden 5-round Swiss on 9 entrants (spec 05 acceptance)", () => {
  const sim = simulate(9, 5, { seed: 7 });

  it("pairs every round with exactly one bye (odd field)", () => {
    expect(sim.refusal).toBeUndefined();
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
// Properties — spec 05 §6
// ---------------------------------------------------------------------------

// Brute-force: does a rematch-free perfect matching of `pool` exist given the
// forbidden `played` pairs? (spec 05 §2.2 verify-via-brute-force, n ≤ 10.)
function perfectMatchingExists(pool: string[], played: ReadonlySet<string>): boolean {
  if (pool.length === 0) return true;
  const [a, ...rest] = pool as [string, ...string[]];
  for (let i = 0; i < rest.length; i++) {
    const b = rest[i] as string;
    if (played.has(pairKey(a, b))) continue;
    const remaining = rest.filter((_, j) => j !== i);
    if (perfectMatchingExists(remaining, played)) return true;
  }
  return false;
}

describe("pairRound — invariants (spec 05 §6)", () => {
  it("no rematch ever, across a simulated tournament (n up to 64)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 64 }),
        fc.integer({ min: 1, max: 6 }),
        fc.integer(),
        (n, rounds, seed) => {
          const sim = simulate(n, rounds, { seed });
          const seen = new Set<string>();
          for (const round of sim.rounds) {
            for (const p of round.pairings) {
              const key = pairKey(p.home, p.away);
              expect(seen.has(key)).toBe(false);
              seen.add(key);
            }
          }
        },
      ),
    );
  });

  it(
    "chess colour bounds hold: |W−B| ≤ 2 and never 3 in a row (n up to 64)",
    () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 2, max: 64 }),
          fc.integer({ min: 1, max: 7 }),
          fc.integer(),
          (n, rounds, seed) => {
            const sim = simulate(n, rounds, { chess: true, seed });
            for (const [, seq] of sim.colours) {
              const w = seq.filter((c) => c === "W").length;
              const b = seq.length - w;
              expect(Math.abs(w - b)).toBeLessThanOrEqual(2);
              for (let i = 2; i < seq.length; i++) {
                expect(seq[i] === seq[i - 1] && seq[i - 1] === seq[i - 2]).toBe(false);
              }
            }
          },
        ),
      );
    },
    30_000,
  );

  it("finds a total pairing whenever a rematch-free matching exists (brute force, n ≤ 10)", () => {
    let paired = 0;
    let refused = 0;
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }).map((k) => 2 * k), // even n ∈ {2,4,6,8,10}
        fc.integer(), // seed for the random `played` history
        (n, seed) => {
          const ids = field(n);
          // Build a random forbidden-pair set deterministically from `seed`.
          const played = new Set<string>();
          let x = seed >>> 0;
          for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
              x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
              if (x % 3 === 0) played.add(pairKey(ids[i] as string, ids[j] as string));
            }
          }
          const standings: SwissStanding[] = ids.map((id, i) => ({ entrantId: id, score: 0, rank: i + 1 }));
          const round = pairRound(standings, { played });
          const exists = perfectMatchingExists(ids, played);
          if (exists) {
            paired++;
            expect(round).toMatchObject({ ok: true }); // a refusal shows its reason here
            if (!round.ok) return;
            expect(round.pairings).toHaveLength(n / 2);
            // and it must respect the no-rematch constraint
            for (const p of round.pairings) expect(played.has(pairKey(p.home, p.away))).toBe(false);
          } else {
            refused++;
            // no rematch-free perfect matching (the brute force above): the named refusal, never an empty round (X-SW-3)
            expect(round).toEqual({ ok: false, code: "SWISS_NO_LEGAL_PAIRING", reason: "rematch", field: n });
          }
        },
      ),
    );
    // anti-vacuity: both branches ran
    expect(paired).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
  });

  it("is deterministic — identical inputs yield identical pairings", () => {
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
      }),
    );
  });
});

// P-A5 (rulebook-W3 §2.1), read pairwise as the reference does (§2.3 item 2): after the round an entrant's colour
// difference is within [−2, +2] and it has not had the same colour three times running.
function canPlay(seq: readonly Colour[], c: Colour): boolean {
  const after = [...seq, c];
  const white = after.filter((x) => x === "W").length;
  if (Math.abs(white - (after.length - white)) > 2) return false;
  const k = after.length;
  return !(k >= 3 && after[k - 1] === after[k - 2] && after[k - 2] === after[k - 3]);
}

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
      const played = new Set<string>();
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) if (rng() < density) played.add(pairKey(ids[i] as string, ids[j] as string));
      }
      const byes = new Set(ids.filter(() => rng() < byeRate));
      // a colour history a legal event can produce: every round's colour met P-A5 (a random colour, else the other one,
      // which a legal prefix always allows)
      const history = (): Colour[] => {
        const seq: Colour[] = [];
        for (let k = Math.floor(rng() * 5); k > 0; k--) {
          const c: Colour = rng() < 0.5 ? "W" : "B";
          seq.push(canPlay(seq, c) ? c : c === "W" ? "B" : "W");
        }
        return seq;
      };
      const colours = new Map(ids.map((id) => [id, history()]));
      const seq = (id: string): Colour[] => colours.get(id) as Colour[];
      // every pair the round may not seat: a rematch (P-A1), or (chess) no colour assignment suits both (P-A5)
      const forbidden = new Set(played);
      if (chess) {
        for (let i = 0; i < n; i++) {
          for (let j = i + 1; j < n; j++) {
            const a = ids[i] as string, b = ids[j] as string;
            const ok = (canPlay(seq(a), "W") && canPlay(seq(b), "B")) || (canPlay(seq(a), "B") && canPlay(seq(b), "W"));
            if (!ok) forbidden.add(pairKey(a, b));
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
          coloursLegal: !chess || r.pairings.every((p) => canPlay(seq(p.home), "W") && canPlay(seq(p.away), "B")), // P-A5, as seated
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
          const reason = chess && candidates.some((c) => perfectMatchingExists(without(c), played)) ? "colour" : "rematch";
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
