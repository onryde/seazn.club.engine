// W5 catch-up for a late entrant into a started round robin — rulebook RB5-L3, RB5-L4, RB5-L6, RB5-L16, RB5-E9; rows
// X-CU-1..5 (rules/cross-sport.md). Every expected value below is derived from the rulebook text or from the circle
// method's own declarations (roundrobin.ts: the pivot is the BYE in an odd field, rotate() moves slot i to i+r), never
// from lateEntryFixtures itself; each pinned number carries its derivation.
//
// single-sport: round-robin code is sport-agnostic (reads no SportModule)
import { describe, expect, it } from "vitest";
import { EngineError } from "../core/errors.ts";
import {
  lateEntryFixtures,
  type ByeSlot,
  type CatchUpFixture,
  type CatchUpResult,
  type ExistingLine,
} from "./catch-up.ts";
import { generateRoundRobin, roundRobinLineKey } from "./roundrobin.ts";

const N = "n"; // the newcomer

interface Scene {
  lines: ExistingLine[];
  byes: ByeSlot[];
  lastRoundNo: number;
}

// A drawn round robin as the caller holds it: every line, every bye slot (started = roundNo ≤ startedThrough, the
// caller's K4 predicate), and the last drawn round.
function scene(entrants: readonly string[], legs: number, startedThrough: number): Scene {
  const s = generateRoundRobin({ entrants, config: { legs } });
  return {
    lines: s.fixtures.map((f) => ({ home: f.home, away: f.away, roundNo: f.roundNo, leg: f.leg })),
    byes: s.rounds.flatMap((r) =>
      r.bye === undefined ? [] : [{ entrantId: r.bye, roundNo: r.roundNo, leg: r.leg, started: r.roundNo <= startedThrough }],
    ),
    lastRoundNo: s.rounds.length,
  };
}

function refusalOf(fn: () => unknown): EngineError {
  try {
    fn();
  } catch (err) {
    if (err instanceof EngineError) return err;
    throw err;
  }
  throw new Error("expected a CONFIG_INVALID refusal, got a result");
}

// A compact, order-preserving view: "home v away @roundNo kind".
const view = (r: CatchUpResult): string[] =>
  r.fixtures.map((f) => `${f.home} v ${f.away} L${f.leg} @${f.placement.roundNo} ${f.placement.kind}`);

const sameSlot = (x: ByeSlot, y: ByeSlot): boolean =>
  x.entrantId === y.entrantId && x.roundNo === y.roundNo && x.leg === y.leg;

const opponent = (f: CatchUpFixture): string => (f.home === N ? f.away : f.home);

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value as object)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

const FIVE = ["a", "b", "c", "d", "e"];
const SIX = ["a", "b", "c", "d", "e", "f"];

describe("lateEntryFixtures — W5 catch-up (RB5-L3, L6, L16)", () => {
  // ── empty and refusals first ────────────────────────────────────────────────────────────────────────────────────
  it("X-CU-1 an empty member list is a named refusal (nothing_to_add), never an empty success", () => {
    const err = refusalOf(() => lateEntryFixtures({ members: [], newcomer: N, legs: 1, lines: [], byes: [], lastRoundNo: 0 }));
    expect(err.code).toBe("CONFIG_INVALID");
    expect(err.data).toEqual({ reason: "nothing_to_add" });
  });

  it("X-CU-1 a newcomer already seated against everyone is a named refusal (nothing_to_add): the second call adds nothing (sequence)", () => {
    // Each scene's first call succeeds; feeding its fixtures back as lines (and dropping the consumed byes, as the
    // caller does) must leave nothing owed (RB5-E9).
    const scenes: [string[], number, number][] = [[FIVE, 1, 2], [FIVE, 2, 2], [SIX, 1, 3], [SIX, 3, 0]];
    let checked = 0;
    for (const [entrants, legs, started] of scenes) {
      const s = scene(entrants, legs, started);
      const first = lateEntryFixtures({ members: entrants, newcomer: N, legs, ...s });
      expect(first.fixtures.length, `${entrants.length}/${legs}`).toBe(entrants.length * legs);
      const lines = [
        ...s.lines,
        ...first.fixtures.map((f) => ({ home: f.home, away: f.away, roundNo: f.placement.roundNo, leg: f.leg })),
      ];
      const byes = s.byes.filter((b) => !first.consumedByes.some((c) => sameSlot(b, c)));
      const err = refusalOf(() =>
        lateEntryFixtures({ members: entrants, newcomer: N, legs, lines, byes, lastRoundNo: s.lastRoundNo + first.appendedRounds }),
      );
      expect(err.code).toBe("CONFIG_INVALID");
      expect(err.data, `${entrants.length}/${legs}`).toEqual({ reason: "nothing_to_add" });
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("a newcomer listed among the members is refused: newcomer_is_member", () => {
    const s = scene(FIVE, 1, 2);
    const err = refusalOf(() => lateEntryFixtures({ members: [...FIVE, N], newcomer: N, legs: 1, ...s }));
    expect(err.code).toBe("CONFIG_INVALID");
    expect(err.data).toEqual({ reason: "newcomer_is_member" });
  });

  it("legs that are not an integer ≥ 1 are refused: legs_invalid", () => {
    const s = scene(FIVE, 1, 2);
    let checked = 0;
    for (const legs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const err = refusalOf(() => lateEntryFixtures({ members: FIVE, newcomer: N, legs, ...s }));
      expect(err.code, `${legs}`).toBe("CONFIG_INVALID");
      expect(err.data, `${legs}`).toEqual({ reason: "legs_invalid" });
      checked++;
    }
    expect(checked).toBe(5);
    // positive pair: legs 1 on the same scene succeeds
    expect(lateEntryFixtures({ members: FIVE, newcomer: N, legs: 1, ...s }).fixtures).toHaveLength(5);
  });

  it("a line or a bye beyond lastRoundNo is refused: last_round_below_lines", () => {
    const base = { members: ["a", "b"], newcomer: N, legs: 1 };
    const line = refusalOf(() =>
      lateEntryFixtures({ ...base, lines: [{ home: "a", away: "b", roundNo: 9, leg: 1 }], byes: [], lastRoundNo: 5 }),
    );
    expect(line.code).toBe("CONFIG_INVALID");
    expect(line.data).toEqual({ reason: "last_round_below_lines" });
    const bye = refusalOf(() =>
      lateEntryFixtures({ ...base, lines: [], byes: [{ entrantId: "a", roundNo: 6, leg: 1, started: false }], lastRoundNo: 5 }),
    );
    expect(bye.code).toBe("CONFIG_INVALID");
    expect(bye.data).toEqual({ reason: "last_round_below_lines" });
    // boundary: a line and a bye AT lastRoundNo are fine
    const ok = lateEntryFixtures({
      ...base,
      lines: [{ home: "a", away: "b", roundNo: 5, leg: 1 }],
      byes: [{ entrantId: "a", roundNo: 5, leg: 1, started: false }],
      lastRoundNo: 5,
    });
    expect(view(ok)).toEqual(["a v n L1 @5 bye_slot", "n v b L1 @6 catch_up_round"]);
  });

  // ── X-CU-1 ──────────────────────────────────────────────────────────────────────────────────────────────────────
  it("X-CU-1 one fixture per member per leg: members a..e, legs 2, no line with the newcomer → 10 fixtures, 10 distinct line keys", () => {
    const s = scene(FIVE, 2, 0);
    const r = lateEntryFixtures({ members: FIVE, newcomer: N, legs: 2, lines: s.lines, byes: [], lastRoundNo: s.lastRoundNo });
    // RB5-L3: 5 members × 2 legs; the expected set is built from the rule, not from the result.
    const expected = FIVE.flatMap((m) => [1, 2].map((leg) => roundRobinLineKey(N, m, leg))).sort();
    const got = r.fixtures.map((f) => roundRobinLineKey(f.home, f.away, f.leg));
    expect(got).toHaveLength(10);
    expect(new Set(got).size).toBe(10);
    expect([...got].sort()).toEqual(expected);
    // byes: [] → every fixture is appended; lastRoundNo = 2 legs × 5 rounds = 10, so rounds 11..20.
    // Order (RB5-L6): earliest round a, b, c, d = 1 (round 1 is a v d, b v c; e holds its bye), e = 2; ties by listed
    // order; then leg. Sides: leg 1 alternates along a..e from away (n away, home, away, home, away); leg 2 flips each.
    expect(view(r)).toEqual([
      "a v n L1 @11 catch_up_round",
      "n v a L2 @12 catch_up_round",
      "n v b L1 @13 catch_up_round",
      "b v n L2 @14 catch_up_round",
      "c v n L1 @15 catch_up_round",
      "n v c L2 @16 catch_up_round",
      "n v d L1 @17 catch_up_round",
      "d v n L2 @18 catch_up_round",
      "e v n L1 @19 catch_up_round",
      "n v e L2 @20 catch_up_round",
    ]);
    expect(r.appendedRounds).toBe(10);
    expect(r.consumedByes).toEqual([]);
  });

  it("X-CU-1 a line already present for a key is not owed again, in either orientation", () => {
    const s = scene(FIVE, 2, 0);
    const lines = [
      ...s.lines,
      { home: "a", away: N, roundNo: 10, leg: 1 }, // newcomer away
      { home: N, away: "b", roundNo: 10, leg: 2 }, // newcomer home
    ];
    const r = lateEntryFixtures({ members: FIVE, newcomer: N, legs: 2, lines, byes: [], lastRoundNo: s.lastRoundNo });
    const got = r.fixtures.map((f) => roundRobinLineKey(f.home, f.away, f.leg)).sort();
    const expected = FIVE.flatMap((m) => [1, 2].map((leg) => roundRobinLineKey(N, m, leg)))
      .filter((k) => k !== roundRobinLineKey("a", N, 1) && k !== roundRobinLineKey(N, "b", 2))
      .sort();
    expect(got).toEqual(expected);
    expect(got).toHaveLength(8);
  });

  it("X-CU-1 a member listed twice is owed once", () => {
    const r = lateEntryFixtures({ members: ["a", "b", "a"], newcomer: N, legs: 1, lines: [], byes: [], lastRoundNo: 0 });
    expect(view(r)).toEqual(["a v n L1 @1 catch_up_round", "n v b L1 @2 catch_up_round"]);
  });

  it("X-CU-1 after a withdrawal the departed member is owed nothing and their bye stays put (sequence)", () => {
    // b withdrew: the caller lists a, c, d, e. b's round-4 bye is not the newcomer's to take.
    const s = scene(FIVE, 1, 2);
    const r = lateEntryFixtures({ members: ["a", "c", "d", "e"], newcomer: N, legs: 1, ...s });
    // c byes r3, a byes r5 (future, unstarted); d (earliest round 1) then e (earliest round 2) appended at 6, 7.
    // Sides along a, c, d, e from away: a away, c home, d away, e home.
    expect(view(r)).toEqual([
      "n v c L1 @3 bye_slot",
      "a v n L1 @5 bye_slot",
      "d v n L1 @6 catch_up_round",
      "n v e L1 @7 catch_up_round",
    ]);
    expect(r.consumedByes.map((b) => b.entrantId)).toEqual(["c", "a"]);
  });

  // ── X-CU-2 ──────────────────────────────────────────────────────────────────────────────────────────────────────
  it("X-CU-2 a future bye holder's fixture lands in that round", () => {
    // Premise, from the circle method (pivot = BYE, column 0 = pivot v u[n−2], rotate by r): byes r1 e, r2 d, r3 c,
    // r4 b, r5 a. Rounds 1–2 started.
    const s = scene(FIVE, 1, 2);
    expect(s.byes.map((b) => `${b.entrantId}@${b.roundNo}`)).toEqual(["e@1", "d@2", "c@3", "b@4", "a@5"]);
    const r = lateEntryFixtures({ members: FIVE, newcomer: N, legs: 1, ...s });
    const byeSlots = r.fixtures.filter((f) => f.placement.kind === "bye_slot");
    // RB5-L3: c → round 3, b → round 4, a → round 5.
    expect(byeSlots.map((f) => `${opponent(f)}@${f.placement.roundNo}`)).toEqual(["c@3", "b@4", "a@5"]);
    expect(r.consumedByes).toEqual([
      { entrantId: "c", roundNo: 3, leg: 1, started: false },
      { entrantId: "b", roundNo: 4, leg: 1, started: false },
      { entrantId: "a", roundNo: 5, leg: 1, started: false },
    ]);
  });

  it("X-CU-2 with no round started every member's fixture takes their bye: odd n 3..23 × legs 1..3 (33 cases)", () => {
    let cases = 0;
    let fixtures = 0;
    let balancedLegs = 0;
    let flips = 0;
    for (let n = 3; n <= 23; n += 2) {
      for (const legs of [1, 2, 3]) {
        const members = Array.from({ length: n }, (_, i) => `m${i}`);
        const s = scene(members, legs, 0);
        const r = lateEntryFixtures({ members, newcomer: N, legs, ...s });
        // RB5-L3: an odd field gives each member one bye per leg (X-RR-3), all in the future here.
        expect(r.consumedByes.length, `${n}/${legs}`).toBe(n * legs);
        expect(r.appendedRounds, `${n}/${legs}`).toBe(0);
        for (const f of r.fixtures) {
          const bye = s.byes.find((b) => b.entrantId === opponent(f) && b.leg === f.leg);
          expect(f.placement, `${n}/${legs} ${opponent(f)} L${f.leg}`).toEqual({ kind: "bye_slot", roundNo: bye?.roundNo });
          fixtures++;
        }
        // RB5-G2: per leg the newcomer's |home − away| ≤ 1, and each pair's side flips between consecutive legs.
        for (let leg = 1; leg <= legs; leg++) {
          const home = r.fixtures.filter((f) => f.leg === leg && f.home === N).length;
          expect(Math.abs(home - (n - home)), `${n}/${legs}/L${leg}`).toBeLessThanOrEqual(1);
          balancedLegs++;
          if (leg === 1) continue;
          for (const m of members) {
            const prev = r.fixtures.find((f) => f.leg === leg - 1 && opponent(f) === m);
            const cur = r.fixtures.find((f) => f.leg === leg && opponent(f) === m);
            expect(cur?.home, `${n}/${legs} ${m} L${leg}`).toBe(prev?.away);
            flips++;
          }
        }
        cases++;
      }
    }
    // 11 odd values in [3, 23] × 3 leg counts = 33; fixtures Σn × (1+2+3) = 143 × 6 = 858.
    expect(cases).toBe(33);
    expect(fixtures).toBe(858);
    // legs checked 11 × (1+2+3) = 66; flips Σn × (0+1+2) = 143 × 3 = 429.
    expect(balancedLegs).toBe(66);
    expect(flips).toBe(429);
  });

  // ── X-CU-3 ──────────────────────────────────────────────────────────────────────────────────────────────────────
  it("X-CU-3 the rest are appended after the last drawn round, one fixture per round, in the order the opponents played", () => {
    const s = scene(FIVE, 1, 2);
    const r = lateEntryFixtures({ members: FIVE, newcomer: N, legs: 1, ...s });
    // RB5-L6: d's earliest round is 1 (a v d), e's is 2 (e held round 1's bye) → d round 6, e round 7 after lastRoundNo 5.
    // Sides along a..e from away: a away, b home, c away, d home, e away.
    expect(view(r)).toEqual([
      "c v n L1 @3 bye_slot",
      "n v b L1 @4 bye_slot",
      "a v n L1 @5 bye_slot",
      "n v d L1 @6 catch_up_round",
      "e v n L1 @7 catch_up_round",
    ]);
    expect(r.appendedRounds).toBe(2);
  });

  it("X-CU-3 an earliest-round tie follows the listed (seed) order, not the id", () => {
    // Listed f, e, d, c, b, a: an even field has no bye, so every member plays round 1 and only the listed order can
    // decide (F5). Id order would give a..f: the scene where the two differ.
    const listed = ["f", "e", "d", "c", "b", "a"];
    const s = scene(listed, 1, 3);
    expect(s.byes).toEqual([]);
    const r = lateEntryFixtures({ members: listed, newcomer: N, legs: 1, ...s });
    expect(r.fixtures.map((f) => `${opponent(f)}@${f.placement.roundNo}`)).toEqual([
      "f@6", "e@7", "d@8", "c@9", "b@10", "a@11",
    ]);
  });

  it("X-CU-3 catch-up rounds follow each opponent's FIRST played round, and a member with no line comes last", () => {
    // Hand-built so the first round and the latest round disagree: a plays rounds 1 and 4, b plays 2 and 3, c has no line.
    // RB5-L6 orders by the round each opponent first played: a (1), then b (2), then c (none, last) — although c is
    // listed first and b's latest round (3) is before a's (4).
    const lines: ExistingLine[] = [
      { home: "a", away: "x", roundNo: 1, leg: 1 },
      { home: "b", away: "y", roundNo: 2, leg: 1 },
      { home: "x", away: "b", roundNo: 3, leg: 1 },
      { home: "y", away: "a", roundNo: 4, leg: 1 },
    ];
    const r = lateEntryFixtures({ members: ["c", "b", "a"], newcomer: N, legs: 1, lines, byes: [], lastRoundNo: 4 });
    // Sides along the listed c, b, a from away: c away, b home, a away.
    expect(view(r)).toEqual(["a v n L1 @5 catch_up_round", "n v b L1 @6 catch_up_round", "c v n L1 @7 catch_up_round"]);
  });

  it("X-CU-3 Review Focus 2: an even league with no byes appends six catch-up rounds 6–11 in members order, none in a played round", () => {
    const s = scene(SIX, 1, 3);
    const r = lateEntryFixtures({ members: SIX, newcomer: N, legs: 1, lines: s.lines, byes: [], lastRoundNo: 5 });
    // RB5-L3: 6 members × 1 leg, all appended (no bye in an even field); sides alternate from away along a..f.
    expect(view(r)).toEqual([
      "a v n L1 @6 catch_up_round",
      "n v b L1 @7 catch_up_round",
      "c v n L1 @8 catch_up_round",
      "n v d L1 @9 catch_up_round",
      "e v n L1 @10 catch_up_round",
      "n v f L1 @11 catch_up_round",
    ]);
    expect(r.consumedByes).toEqual([]);
    expect(r.appendedRounds).toBe(6);
  });

  it("X-CU-3 home and away alternate as RB5-G2: per leg the newcomer's balance is within 1 and each pair flips by leg", () => {
    let cases = 0;
    let transitions = 0;
    let balancedLegs = 0;
    for (let n = 2; n <= 13; n++) {
      for (const legs of [1, 2, 3]) {
        const members = Array.from({ length: n }, (_, i) => `m${i}`);
        const s = scene(members, legs, 1);
        const r = lateEntryFixtures({ members, newcomer: N, legs, ...s });
        for (let leg = 1; leg <= legs; leg++) {
          const inLeg = r.fixtures.filter((f) => f.leg === leg);
          const home = inLeg.filter((f) => f.home === N).length;
          expect(inLeg.length, `${n}/${legs}/L${leg}`).toBe(n);
          expect(Math.abs(home - (n - home)), `${n}/${legs}/L${leg}`).toBeLessThanOrEqual(1);
          balancedLegs++;
          if (leg === 1) {
            // first away: the first listed member hosts the newcomer in leg 1
            expect(inLeg.find((f) => opponent(f) === "m0")?.home, `${n}/${legs}`).toBe("m0");
          } else {
            for (const m of members) {
              const prev = r.fixtures.find((f) => f.leg === leg - 1 && opponent(f) === m);
              const cur = inLeg.find((f) => opponent(f) === m);
              expect(cur?.home, `${n}/${legs} ${m} L${leg}`).toBe(prev?.away);
              transitions++;
            }
          }
        }
        cases++;
      }
    }
    // n ∈ 2..13 (12 values) × 3 leg counts; legs checked 12 × (1+2+3) = 72; transitions Σn × (0+1+2) = 90 × 3 = 270.
    expect(cases).toBe(36);
    expect(balancedLegs).toBe(72);
    expect(transitions).toBe(270);
  });

  it("X-CU-3 a..f, six owed in one leg: the newcomer is home three times and away three, alternating along the set (RB5-G2, RB5-L6)", () => {
    // differential: before this ruling 0 home / 6 away — the reading the controller ruled out (2026-11-16): an always-away
    // leg 1. RB5-G2's within-leg bound |home − away| ≤ 1 with 6 owed forces exactly 3 / 3; RB5-L6's alternation forces
    // away, home, away, … along the set.
    const s = scene(SIX, 1, 3);
    const r = lateEntryFixtures({ members: SIX, newcomer: N, legs: 1, lines: s.lines, byes: [], lastRoundNo: 5 });
    let checked = 0;
    r.fixtures.forEach((f, i) => {
      expect(f.home === N ? "home" : "away", `${i}`).toBe(i % 2 === 0 ? "away" : "home");
      checked++;
    });
    expect(checked).toBe(6);
    expect(r.fixtures.filter((f) => f.home === N)).toHaveLength(3);
    expect(r.fixtures.filter((f) => f.away === N)).toHaveLength(3);
  });

  // ── X-CU-4 ──────────────────────────────────────────────────────────────────────────────────────────────────────
  it("X-CU-4 nothing lands in a started round, a started bye is never consumed, and the drawn rounds are left as they are", () => {
    const s = deepFreeze(scene(FIVE, 1, 2));
    const before = JSON.stringify(s);
    const r = lateEntryFixtures({ members: FIVE, newcomer: N, legs: 1, ...s });
    expect(r.fixtures.filter((f) => f.placement.roundNo <= 2)).toEqual([]);
    expect(r.consumedByes.every((b) => !b.started)).toBe(true);
    expect(r.consumedByes.map((b) => b.entrantId)).not.toContain("e"); // r1 bye, started
    expect(r.consumedByes.map((b) => b.entrantId)).not.toContain("d"); // r2 bye, started
    expect(JSON.stringify(s)).toBe(before);
    // A future bye already called to a court (started by K4) is not taken either: b goes to a catch-up round.
    const called = s.byes.map((b) => (b.entrantId === "b" ? { ...b, started: true } : b));
    const r2 = lateEntryFixtures({ members: FIVE, newcomer: N, legs: 1, lines: s.lines, byes: called, lastRoundNo: s.lastRoundNo });
    expect(r2.fixtures.find((f) => opponent(f) === "b")?.placement).toEqual({ kind: "catch_up_round", roundNo: 6 });
    expect(r2.consumedByes.map((b) => b.entrantId)).toEqual(["c", "a"]);
  });

  it("X-CU-4 differential: regenerating over six rewrites the played round 1; catch-up keeps it and adds only the sixth's lines", () => {
    // differential: today the only engine path to a sixth entrant's fixtures is generateRoundRobin over six, whose
    // round 1 (a v f, b v e, c v d) shares no pair with the five-field's played round 1 (a v d, b v c).
    const pairs = (fs: readonly { home: string; away: string }[]): string[] =>
      fs.map((f) => [f.home, f.away].sort().join("|")).sort();
    const five = generateRoundRobin({ entrants: FIVE });
    const six = generateRoundRobin({ entrants: SIX });
    const fiveR1 = pairs(five.rounds[0]?.fixtures ?? []);
    const sixR1 = pairs(six.rounds[0]?.fixtures ?? []);
    expect(fiveR1).toEqual(["a|d", "b|c"]);
    expect(sixR1).toEqual(["a|f", "b|e", "c|d"]);
    expect(sixR1.filter((p) => fiveR1.includes(p))).toEqual([]);
    const s = scene(FIVE, 1, 2);
    const r = lateEntryFixtures({ members: FIVE, newcomer: "f", legs: 1, ...s });
    expect(r.fixtures.every((f) => f.home === "f" || f.away === "f")).toBe(true);
    expect(r.fixtures.every((f) => f.placement.roundNo > 2)).toBe(true);
  });

  // ── X-CU-5 ──────────────────────────────────────────────────────────────────────────────────────────────────────
  it("X-CU-5 two newcomers owe each other: the second owes the first, placed by the same policy", () => {
    const s = scene(FIVE, 1, 2);
    const first = lateEntryFixtures({ members: FIVE, newcomer: "n1", legs: 1, ...s });
    const lines = [
      ...s.lines,
      ...first.fixtures.map((f) => ({ home: f.home, away: f.away, roundNo: f.placement.roundNo, leg: f.leg })),
    ];
    const byes = s.byes.filter((b) => !first.consumedByes.some((c) => sameSlot(b, c)));
    const r = lateEntryFixtures({
      members: [...FIVE, "n1"],
      newcomer: "n2",
      legs: 1,
      lines,
      byes,
      lastRoundNo: s.lastRoundNo + first.appendedRounds,
    });
    // n1 took c, b, a's byes (rounds 3–5) and rounds 6–7; e and d's byes are started → n2's six are all appended after
    // round 7. Earliest rounds: a, b, c, d 1; e 2; n1 3 (c v n1) → a 8, b 9, c 10, d 11, e 12, n1 13.
    // Sides along a, b, c, d, e, n1 from away.
    expect(r.fixtures.map((f) => `${f.home} v ${f.away} @${f.placement.roundNo} ${f.placement.kind}`)).toEqual([
      "a v n2 @8 catch_up_round",
      "n2 v b @9 catch_up_round",
      "c v n2 @10 catch_up_round",
      "n2 v d @11 catch_up_round",
      "e v n2 @12 catch_up_round",
      "n2 v n1 @13 catch_up_round",
    ]);
    expect(r.consumedByes).toEqual([]);
  });
});
