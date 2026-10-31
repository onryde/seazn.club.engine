// W3 Swiss pairing (rulebook-W3-swiss §2.1 P-A6, §3.3; FIDE C.04.3 [C4]). A round with no legal pairing is a named
// refusal, never an empty or partial round reported as success.
import { describe, expect, it } from "vitest";
import { mulberry32 } from "../core/rng.ts";
import {
  judgeRound,
  oraclePairKey,
  perfectMatchings,
  roundAfter,
  rulebookSides,
  ruleSides,
  seatedRoundViolations,
  type OracleRound,
} from "../testkit/swiss-oracle.ts";
import {
  pairKey,
  pairRound,
  SWISS_SEARCH_BUDGET,
  type Colour,
  type SwissConstraints,
  type SwissPairResult,
  type SwissRound,
  type SwissStanding,
} from "./swiss.ts";

// Everyone on 0 points; rank follows the list order (index 0 = rank 1, the strongest).
const st = (ids: string[]): SwissStanding[] => ids.map((id, i) => ({ entrantId: id, score: 0, rank: i + 1 }));

describe("X-SW-3 no legal pairing is a named refusal, never an empty success (rulebook §3.3, P-A6)", () => {
  it("X-SW-3 the empty case first: 0 and 1 entrants are refused field_too_small", () => {
    // field = standings.length (interface: "for the message"); differential: today 0 → {pairings: []}, 1 → a bye-only round
    expect(pairRound([], { played: new Set() })).toEqual({ ok: false, code: "SWISS_NO_LEGAL_PAIRING", reason: "field_too_small", field: 0 });
    expect(pairRound(st(["a"]), { played: new Set() })).toEqual({ ok: false, code: "SWISS_NO_LEGAL_PAIRING", reason: "field_too_small", field: 1 });
  });

  it("X-SW-3 4 entrants who have all met: round 4 is past the even hard maximum n−1 (rulebook §3.1) → rematch", () => {
    const ids = ["a", "b", "c", "d"];
    const played = new Set(ids.flatMap((x, i) => ids.slice(i + 1).map((y) => pairKey(x, y))));
    expect(pairRound(st(ids), { played })).toEqual({ ok: false, code: "SWISS_NO_LEGAL_PAIRING", reason: "rematch", field: 4 }); // differential: today {pairings: []}
  });

  it("X-SW-3 an odd field that cannot pair writes no bye (rulebook §3.3: 'writes nothing, not even the bye')", () => {
    // a, b, c have all met: no bye choice leaves a rematch-free pair
    const played = new Set([pairKey("a", "b"), pairKey("a", "c"), pairKey("b", "c")]);
    const r = pairRound(st(["a", "b", "c"]), { played });
    expect(r).toEqual({ ok: false, code: "SWISS_NO_LEGAL_PAIRING", reason: "rematch", field: 3 });
    expect("bye" in r).toBe(false); // differential: today {pairings: [], bye: "c"}
  });

  it("X-SW-3 chess: two who never met, each White twice running → colour (P-A5: never three in a row)", () => {
    const colours = new Map([["a", ["W", "W"] as Colour[]], ["b", ["W", "W"] as Colour[]]]);
    expect(pairRound(st(["a", "b"]), { played: new Set(), colours }, { chess: true }))
      .toEqual({ ok: false, code: "SWISS_NO_LEGAL_PAIRING", reason: "colour", field: 2 }); // differential: today {pairings: []}
    // the same two without the chess colour limits pair: the refusal is the colour limit's, not a rematch
    const open = pairRound(st(["a", "b"]), { played: new Set(), colours });
    expect(open.ok && open.pairings.length).toBe(1);
  });

  it("X-SW-3 a budget the search exhausts is search_limit, not a claim that no pairing exists", () => {
    // differential: today the budget argument is ignored and a–c, b–d pair
    expect(pairRound(st(["a", "b", "c", "d"]), { played: new Set() }, {}, 0)).toMatchObject({ ok: false, reason: "search_limit" });
    expect(pairRound(st(["a", "b", "c", "d"]), { played: new Set() }, {}, 0))
      .toEqual({ ok: false, code: "SWISS_NO_LEGAL_PAIRING", reason: "search_limit", field: 4 });
    // the same field under the default budget pairs (⌊4/2⌋ = 2 boards, P-A3): the refusal was the budget's alone
    const full = pairRound(st(["a", "b", "c", "d"]), { played: new Set() });
    expect(full.ok && full.pairings.length).toBe(2);
    expect(SWISS_SEARCH_BUDGET).toBe(1_000_000); // the interface's per-call budget
  });

  it("X-SW-3 a budget that runs out anywhere, the reason probe included, is search_limit, never a false rematch (ruling R2)", () => {
    // the chess colour case above ("colour") and the all-met case ("rematch") under every small budget: each answer is
    // either the proved reason or search_limit, and the sweep reaches both answers
    const colours = new Map([["a", ["W", "W"] as Colour[]], ["b", ["W", "W"] as Colour[]]]);
    const allMet = new Set([pairKey("a", "b"), pairKey("a", "c"), pairKey("b", "c")]);
    const cases = [
      { run: (b: number) => pairRound(st(["a", "b"]), { played: new Set(), colours }, { chess: true }, b), proved: "colour" },
      { run: (b: number) => pairRound(st(["a", "b", "c"]), { played: allMet }, { chess: true }, b), proved: "rematch" },
    ];
    const seen = new Set<string>();
    let checked = 0;
    for (const c of cases) {
      for (let budget = 0; budget <= 12; budget++) {
        const r = c.run(budget);
        expect(r.ok).toBe(false);
        if (r.ok) continue;
        expect([c.proved, "search_limit"]).toContain(r.reason);
        seen.add(`${c.proved}:${r.reason}`);
        checked++;
      }
    }
    expect(checked).toBe(26); // anti-vacuity: 2 cases × 13 budgets
    expect([...seen].sort()).toEqual(["colour:colour", "colour:search_limit", "rematch:rematch", "rematch:search_limit"]);
  });

  it("X-SW-3 success is ok:true with ⌊n/2⌋ boards; a second call returns the same (determinism)", () => {
    const a = pairRound(st(["a", "b", "c", "d", "e"]), { played: new Set() });
    expect(a.ok && a.pairings.length).toBe(2); // ⌊5/2⌋ boards and one bye (P-A3)
    expect(a.ok && a.bye).toBe("e"); // the lowest-ranked eligible entrant (P-Q2)
    expect(pairRound(st(["a", "b", "c", "d", "e"]), { played: new Set() })).toEqual(a);
  });

  it("X-SW-3 after a withdrawal: the same history pairs once the field shrinks, and a refusal names the field paired", () => {
    // a has met b, c and d: with all four, a has no legal opponent (P-A1)
    const played = new Set([pairKey("a", "b"), pairKey("a", "c"), pairKey("a", "d")]);
    expect(pairRound(st(["b", "c", "d", "a"]), { played })).toEqual({ ok: false, code: "SWISS_NO_LEGAL_PAIRING", reason: "rematch", field: 4 });
    // d withdraws: the field is odd, a (the lowest-ranked eligible) takes the bye and b–c never met (P-Q2, P-A3)
    const after = pairRound(st(["b", "c", "a"]), { played });
    expect(after.ok && after.bye).toBe("a");
    expect(after.ok && after.pairings.map((p) => pairKey(p.home, p.away))).toEqual([pairKey("b", "c")]);
    // c withdraws too: two left who already met; the refusal counts the active field (2), not the field at entry (4)
    expect(pairRound(st(["b", "a"]), { played })).toEqual({ ok: false, code: "SWISS_NO_LEGAL_PAIRING", reason: "rematch", field: 2 });
  });

  it("X-SW-3 a duplicated entrant is refused CONFIG_INVALID (assumption → guard)", () => {
    // differential: today a, a pairs "a" against itself, and a, b, a returns an empty round with "a" on the bye
    expect(() => pairRound(st(["a", "a"]), { played: new Set() })).toThrow(/CONFIG_INVALID|twice/);
    expect(() => pairRound(st(["a", "b", "a"]), { played: new Set() })).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
  });

  it("X-SW-3 an odd field where every entrant is bye-ineligible is refused no_bye_candidate, never a second bye (P-A4)", () => {
    // two score groups; every entrant has had the bye (or won a walkover)
    const field: SwissStanding[] = [
      { entrantId: "a", score: 2, rank: 1 }, { entrantId: "b", score: 2, rank: 2 },
      { entrantId: "c", score: 1, rank: 3 }, { entrantId: "d", score: 1, rank: 4 }, { entrantId: "e", score: 0, rank: 5 },
    ];
    const allByed = new Set(["a", "b", "c", "d", "e"]);
    const refusal = { ok: false, code: "SWISS_NO_LEGAL_PAIRING", reason: "no_bye_candidate", field: 5 };
    const r = pairRound(field, { played: new Set(), byes: allByed });
    expect(r).toEqual(refusal); // differential: today e takes a second bye
    expect("bye" in r).toBe(false);
    expect(pairRound(field, { played: new Set(), byes: allByed }, { chess: true })).toEqual(refusal); // chess on: the same
    // the other direction: an even field needs no bye, so the same history pairs everyone (P-A3)
    const even = pairRound(field.slice(0, 4), { played: new Set(), byes: allByed });
    expect(even.ok && even.pairings.length).toBe(2);
    expect("bye" in even).toBe(false);
    // and one entrant made eligible again (the top one) takes the bye: eligibility, not score, decides
    const one = pairRound(field, { played: new Set(), byes: new Set(["b", "c", "d", "e"]) });
    expect(one.ok && one.bye).toBe("a");
  });

  it("X-SW-3 a NaN or negative budget is a caller defect → CONFIG_INVALID (assumption → guard)", () => {
    // differential: today NaN disables the cap (the round pairs, unbounded) and −1 is an instant search_limit
    for (const budget of [Number.NaN, -1, Number.NEGATIVE_INFINITY]) {
      expect(() => pairRound(st(["a", "b", "c", "d"]), { played: new Set() }, {}, budget))
        .toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
    }
    // 0 is a budget (nothing may be searched), not a defect: it refuses search_limit
    expect(pairRound(st(["a", "b", "c", "d"]), { played: new Set() }, {}, 0)).toMatchObject({ ok: false, reason: "search_limit" });
  });

  it("X-SW-3 several score groups: the only rematch-free pairings lie beyond the old float cap and all break the chess colour limits → colour", () => {
    // score 1: p0..p7 have all met; score 0: q0..q7 have met nobody. Rematch-free ⇒ every board is p v q, and with every
    // entrant White twice running no p v q board has a legal colour (P-A5): the reason is the colours', not a rematch
    const ps = Array.from({ length: 8 }, (_, i) => `p${i}`), qs = Array.from({ length: 8 }, (_, i) => `q${i}`);
    const played = new Set(ps.flatMap((x, i) => ps.slice(i + 1).map((y) => pairKey(x, y))));
    const field = [...ps.map((id, i) => ({ entrantId: id, score: 1, rank: i + 1 })), ...qs.map((id, i) => ({ entrantId: id, score: 0, rank: 9 + i }))];
    const colours = new Map([...ps, ...qs].map((id) => [id, ["W", "W"] as Colour[]]));
    expect(pairRound(field, { played, colours }, { chess: true }))
      .toEqual({ ok: false, code: "SWISS_NO_LEGAL_PAIRING", reason: "colour", field: 16 }); // differential: today rematch (the probe capped floats at 4)
  });

  it("X-SW-3 chess, odd field: the lowest bye candidate leaves a rematch, the next leaves only a colour clash → colour (ruling R2: any candidate)", () => {
    // bye c leaves a–b (met); bye b leaves a–c, who never met but are each White twice running (P-A5); bye a leaves b–c (met)
    const played = new Set([pairKey("a", "b"), pairKey("b", "c")]);
    const colours = new Map([["a", ["W", "W"] as Colour[]], ["c", ["W", "W"] as Colour[]]]);
    const r = pairRound(st(["a", "b", "c"]), { played, colours }, { chess: true });
    expect(r).toEqual({ ok: false, code: "SWISS_NO_LEGAL_PAIRING", reason: "colour", field: 3 }); // differential: today rematch (only bye c probed)
    expect("bye" in r).toBe(false);
    // without the colour limits the same field pairs, with the bye retried up to b; a and c were each home twice, equal
    // claims, so the upper board a plays away (X-SW-4)
    expect(pairRound(st(["a", "b", "c"]), { played, colours })).toEqual({ ok: true, pairings: [{ home: "c", away: "a" }], bye: "b", floated: [] });
  });

  it("X-SW-3 several score groups: a top group with more mutual rematches than the field below can absorb → rematch", () => {
    // score 1: p0..p3 have all met, so each needs a q; score 0 holds only q0, q1. No rematch-free matching exists.
    const field: SwissStanding[] = [
      ...["p0", "p1", "p2", "p3"].map((id, i) => ({ entrantId: id, score: 1, rank: i + 1 })),
      { entrantId: "q0", score: 0, rank: 5 }, { entrantId: "q1", score: 0, rank: 6 },
    ];
    const ids = ["p0", "p1", "p2", "p3"];
    const played = new Set(ids.flatMap((x, i) => ids.slice(i + 1).map((y) => pairKey(x, y))));
    const refusal = { ok: false, code: "SWISS_NO_LEGAL_PAIRING", reason: "rematch", field: 6 };
    expect(pairRound(field, { played })).toEqual(refusal);
    expect(pairRound(field, { played }, { chess: true })).toEqual(refusal); // lifting the colour limits does not help: rematch
  });
});

describe("X-SW-2 score groups first, bounded floats, a whole-field search only when the groups cannot within their budget share (RB3-1, P-Q1/P-Q2)", () => {
  it("X-SW-2 bye retried: the lowest eligible's removal leaves a rematch, so the next one up takes the bye (P-Q2; SW-L3)", () => {
    const r = pairRound(st(["p0", "p1", "p2"]), { played: new Set([pairKey("p0", "p1")]) });
    expect(r).toEqual({ ok: true, pairings: [{ home: "p0", away: "p2" }], bye: "p1", floated: [] }); // differential: today rematch (bye p2 only)
    // a second call returns the same, and chess on (no colour history) picks the same bye and board, upper board White
    expect(pairRound(st(["p0", "p1", "p2"]), { played: new Set([pairKey("p0", "p1")]) })).toEqual(r);
    expect(pairRound(st(["p0", "p1", "p2"]), { played: new Set([pairKey("p0", "p1")]) }, { chess: true })).toEqual(r);
  });
  it("X-SW-2 every entrant already bye-ineligible on an odd field → no_bye_candidate, never a second bye (P-A4; NEW-2)", () => {
    expect(pairRound(st(["p0", "p1", "p2"]), { played: new Set(), byes: new Set(["p0", "p1", "p2"]) }))
      .toEqual({ ok: false, code: "SWISS_NO_LEGAL_PAIRING", reason: "no_bye_candidate", field: 3 }); // differential: today bye p2
  });
  it("X-SW-2 the bye goes to the lowest SCORE first, and climbs a score group only when every lower candidate leaves a rematch (P-Q2)", () => {
    // x is the best-ranked but the lowest-scored: it is the first candidate, whatever its rank
    const field: SwissStanding[] = [
      { entrantId: "x", score: 0, rank: 1 }, { entrantId: "y", score: 1, rank: 2 }, { entrantId: "z", score: 1, rank: 3 },
    ];
    const open = pairRound(field, { played: new Set() });
    expect(open.ok && open.bye).toBe("x");
    // y and z have met: x's removal leaves a rematch, so the bye climbs to the score-1 group's lowest-ranked, z
    const blocked = pairRound(field, { played: new Set([pairKey("y", "z")]) });
    expect(blocked).toEqual({ ok: true, pairings: [{ home: "y", away: "x" }], bye: "z", floated: ["y"] }); // differential: today rematch
    // z already had the bye: y is next
    const zByed = pairRound(field, { played: new Set([pairKey("y", "z")]), byes: new Set(["z"]) });
    expect(zByed.ok && zByed.bye).toBe("y");
  });
  it("X-SW-2 a blocked top-of-group entrant floats with the group's lowest-ranked: 2 floaters, not a dead end (SW-L4)", () => {
    // score 1: p0..p9 (ranks 1–10), p0 has met p1..p9; score 0: q0, q1 (ranks 11, 12)
    const top = Array.from({ length: 10 }, (_, i) => ({ entrantId: `p${i}`, score: 1, rank: i + 1 }));
    const low = [{ entrantId: "q0", score: 0, rank: 11 }, { entrantId: "q1", score: 0, rank: 12 }];
    const played = new Set(top.slice(1).map((t) => pairKey("p0", t.entrantId)));
    const r = pairRound([...top, ...low], { played });
    expect(r.ok && r.pairings).toHaveLength(6); // differential: today rematch
    expect(r.ok && new Set(r.floated)).toEqual(new Set(["p0", "p9"])); // fewest floats (2), the second the group's lowest-ranked
  });
  it("X-SW-2 a group that must send down more floaters than the cap: the whole-field search still pairs it (P-A6)", () => {
    // score 1: p0..p7 have all met each other; score 0: q0..q7 have met nobody
    const ps = Array.from({ length: 8 }, (_, i) => `p${i}`), qs = Array.from({ length: 8 }, (_, i) => `q${i}`);
    const played = new Set(ps.flatMap((x, i) => ps.slice(i + 1).map((y) => pairKey(x, y))));
    const field = [...ps.map((id, i) => ({ entrantId: id, score: 1, rank: i + 1 })), ...qs.map((id, i) => ({ entrantId: id, score: 0, rank: 9 + i }))];
    const r = pairRound(field, { played });
    expect(r.ok && r.pairings.every((p) => ps.includes(p.home) !== ps.includes(p.away))).toBe(true); // each board p v q
    expect(r.ok && r.pairings).toHaveLength(8); // differential: today rematch
    expect(r.ok && [...r.floated].sort()).toEqual([...ps].sort()); // every p played down a score group
  });
  it("X-SW-2 the score-group pass keeps to its share of the budget: one that could spend it all still leaves the whole-field search enough to pair the round (P-A6)", () => {
    // score 2: t0..t3 (fresh); score 1: u0..u(k−1) have all met each other; score 0: l0..l(k−1) (fresh). Every u must play
    // an l, so the score-group pass (at most 4 floats per group) is dead under every one of the top group's choices, and
    // walking them all costs more than this budget; the whole-field search seats u v l at once. k = 16 also pins that the
    // pass stops at its share: a node it is refused still counts, so a walk that went on past its share would carry the
    // count past the budget before the whole-field search began
    let checked = 0;
    for (const k of [10, 16]) {
      const ts = ["t0", "t1", "t2", "t3"];
      const us = Array.from({ length: k }, (_, i) => `u${i}`), ls = Array.from({ length: k }, (_, i) => `l${i}`);
      const played = new Set(us.flatMap((x, i) => us.slice(i + 1).map((y) => pairKey(x, y))));
      const field: SwissStanding[] = [
        ...ts.map((id, i) => ({ entrantId: id, score: 2, rank: i + 1 })),
        ...us.map((id, i) => ({ entrantId: id, score: 1, rank: 5 + i })),
        ...ls.map((id, i) => ({ entrantId: id, score: 0, rank: 5 + k + i })),
      ];
      for (const chess of [false, true]) {
        const r = pairRound(field, { played }, { chess }, 5_000); // differential: today search_limit (the group pass spends all 5,000)
        expect(r.ok && r.pairings).toHaveLength(2 + k); // ⌊(4 + 2k)/2⌋ boards (P-A3)
        if (!r.ok) continue;
        const boards = r.pairings.map((p) => [p.home, p.away].sort().join(" v "));
        expect(boards.filter((b) => /^l\d+ v u\d+$/.test(b))).toHaveLength(k); // every u v an l
        expect(boards.filter((b) => /^t\d v t\d$/.test(b))).toHaveLength(2); // the top group pairs within itself
        expect([...r.floated].sort()).toEqual([...us].sort());
        checked++;
      }
    }
    expect(checked).toBe(4); // anti-vacuity: 2 field sizes × chess off and on, each paired
  });
  it("X-SW-2 the floater is the lowest-ranked among the LEAST-FLOATED: the top seed floats when everyone below it floated last round (P-Q1)", () => {
    // FIDE C.04.3 ranks avoiding a repeat float above rank (controller ruling). Score 1: p0..p4 (odd, one must float);
    // score 0: q0..q2. p1..p4 floated last round, p0 did not.
    const field: SwissStanding[] = [
      ...["p0", "p1", "p2", "p3", "p4"].map((id, i) => ({ entrantId: id, score: 1, rank: i + 1 })),
      ...["q0", "q1", "q2"].map((id, i) => ({ entrantId: id, score: 0, rank: 6 + i })),
    ];
    const floats = new Map([["p1", 1], ["p2", 1], ["p3", 1], ["p4", 1]]);
    for (const chess of [false, true]) {
      const r = pairRound(field, { played: new Set(), floats }, { chess });
      expect(r.ok && r.floated).toEqual(["p0"]); // differential: today ["p4"] (p0 sat outside the bottom window)
      expect(r.ok && r.pairings.some((p) => pairKey(p.home, p.away) === pairKey("p0", "q0"))).toBe(true);
    }
    // the other direction: with no float history the group's lowest-ranked floats, as before
    const fresh = pairRound(field, { played: new Set() });
    expect(fresh.ok && fresh.floated).toEqual(["p4"]);
  });
  it("X-SW-2 X-SW-1 after a withdrawal (one entrant leaves the standings) the next round still seats everyone once (P-A3, P-A7)", () => {
    const r = pairRound(st(["a", "b", "c", "d", "e"]).filter((s) => s.entrantId !== "c"), { played: new Set([pairKey("a", "b")]) });
    expect(r.ok && r.pairings.flatMap((p) => [p.home, p.away]).sort()).toEqual(["a", "b", "d", "e"]);
    expect(r.ok && r.pairings.some((p) => pairKey(p.home, p.away) === pairKey("a", "b"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// X-SW-4 — outside chess, home and away alternate where they can (rulebook RB3-11, P-Q6; SW-L5)
// ---------------------------------------------------------------------------

// The rule's sides (rulebookSides, ruleSides) live in the oracle, src/testkit/swiss-oracle.ts: read from the rulebook and
// never from the engine.

// The sweep's time budget, SIZED from measured cost by the formula swiss.test.ts's properties use (T3 controller ruling: a
// derived budget is sizing; the --testTimeout flag is banned): max(FLOOR, ceil((cases × p99 + max) × LOAD_SLACK)), a case
// being one simulated event or one constructed fallback round. SWEEP_CASE_MS: a probe copy of this test that timed every
// case at 10× SWEEP_EVENTS and FALLBACK_ROUNDS, run six times on the T4b fix-round tree (13,200 cases; 2026-10-31, load
// average 5–6; task-4b-report.md, fix round 1): p99 over all of them, max the slowest one. 200 events reach every counted
// bucket (the rarest, a retried bye, 3 rounds in 200 events); real events never take the fallback, so FALLBACK_ROUNDS
// constructed rounds do.
const SWEEP_EVENTS = 200;
const FALLBACK_ROUNDS = 20;
const SWEEP_CASE_MS = { p99: 3.85, max: 34.6 } as const;
const SWEEP_BUDGET_MS = Math.max(5_000, Math.ceil(((SWEEP_EVENTS + FALLBACK_ROUNDS) * SWEEP_CASE_MS.p99 + SWEEP_CASE_MS.max) * 5));

describe("X-SW-4 outside chess, a Swiss board's home side alternates where it can, and never refuses a pairing (rulebook RB3-11, P-Q6; SW-L5)", () => {
  // Pairing is sport-blind: pairRound sees only `chess`, never a sport. So the "another sport" axis here is chess on, whose
  // hard colour limits are untouched (the chess tests in this file and swiss.test.ts stay green unchanged); every non-chess
  // sport takes the soft path, which the sweep below drives with both pairing shapes. In each hand case both sides score 0,
  // and p0 is rank 1 (the upper board), p1 rank 2.
  const rec = (entries: [string, Colour[]][]) => new Map(entries);

  it("X-SW-4 the empty case first: round 1 (no history), the upper board is home", () => {
    expect(pairRound(st(["p0", "p1"]), { played: new Set() })).toMatchObject({ ok: true, pairings: [{ home: "p0", away: "p1" }] });
    // an empty record is no history either
    expect(pairRound(st(["p0", "p1"]), { played: new Set(), colours: rec([["p0", []], ["p1", []]]) }))
      .toMatchObject({ ok: true, pairings: [{ home: "p0", away: "p1" }] });
  });

  it("X-SW-4 non-chess: home last round meets away last round → the sides swap (P-Q6)", () => {
    const r = pairRound(st(["p0", "p1"]), { played: new Set(), colours: rec([["p0", ["W"]], ["p1", ["B"]]]) });
    expect(r.ok && r.pairings).toEqual([{ home: "p1", away: "p0" }]); // differential: today p0 home
  });

  it("X-SW-4 soft: three homes running is still paired outside chess (no hard limit)", () => {
    const colours = rec([["p0", ["W", "W", "W"]], ["p1", ["W", "W", "W"]]]);
    const r = pairRound(st(["p0", "p1"]), { played: new Set(), colours });
    expect(r.ok).toBe(true);
    // both ask away with equal claims, so the upper board p0 takes its ask (away)
    expect(r.ok && r.pairings).toEqual([{ home: "p1", away: "p0" }]); // differential: today p0 home
    // the other direction: chess colours on, the same two may not meet (never three of one colour running, P-A5)
    expect(pairRound(st(["p0", "p1"]), { played: new Set(), colours }, { chess: true })).toMatchObject({ ok: false, reason: "colour" });
  });

  it("X-SW-4 the side home more often plays away, even when it was away last; a level record alternates from the last", () => {
    // p0: two homes, one away (away last) → asks away; p1 has no record. A last-only rule would send p0 home
    const more = pairRound(st(["p0", "p1"]), { played: new Set(), colours: rec([["p0", ["W", "W", "B"]]]) });
    expect(more.ok && more.pairings).toEqual([{ home: "p1", away: "p0" }]); // differential: today p0 home
    // level records: the last decides
    const homeLast = pairRound(st(["p0", "p1"]), { played: new Set(), colours: rec([["p0", ["B", "W"]]]) });
    expect(homeLast.ok && homeLast.pairings).toEqual([{ home: "p1", away: "p0" }]); // differential: today p0 home
    const awayLast = pairRound(st(["p0", "p1"]), { played: new Set(), colours: rec([["p0", ["W", "B"]]]) });
    expect(awayLast.ok && awayLast.pairings).toEqual([{ home: "p0", away: "p1" }]);
  });

  it("X-SW-4 the same ask goes to the larger imbalance, then the upper board; a lone ask from the lower board is granted", () => {
    // both ask away: p0 (+2) has the larger imbalance, so p0 plays away
    const larger = pairRound(st(["p0", "p1"]), { played: new Set(), colours: rec([["p0", ["W", "W"]], ["p1", ["W"]]]) });
    expect(larger.ok && larger.pairings).toEqual([{ home: "p1", away: "p0" }]); // differential: today p0 home
    // the other direction: p1 (+2) has it, so p1 plays away
    const smaller = pairRound(st(["p0", "p1"]), { played: new Set(), colours: rec([["p0", ["W"]], ["p1", ["W", "W"]]]) });
    expect(smaller.ok && smaller.pairings).toEqual([{ home: "p0", away: "p1" }]);
    // both ask home with equal claims: the upper board p0 is home
    const tied = pairRound(st(["p0", "p1"]), { played: new Set(), colours: rec([["p0", ["B"]], ["p1", ["B"]]]) });
    expect(tied.ok && tied.pairings).toEqual([{ home: "p0", away: "p1" }]);
    // only the lower board asks (home): it is granted
    const lone = pairRound(st(["p0", "p1"]), { played: new Set(), colours: rec([["p1", ["B"]]]) });
    expect(lone.ok && lone.pairings).toEqual([{ home: "p1", away: "p0" }]); // differential: today p0 home
  });

  it("X-SW-4 no hard limit outside chess: the larger claim is granted where chess's limit would override it", () => {
    // both ask home: p1 (one away) leans further than p0 (level, away last). Outside chess p1 is home. With chess colours
    // on, p0 may not take a third Black running (P-A5), so chess must seat p0 White whatever the claims say
    const colours = rec([["p0", ["W", "W", "B", "B"]], ["p1", ["B"]]]);
    const soft = pairRound(st(["p0", "p1"]), { played: new Set(), colours });
    expect(soft.ok && soft.pairings).toEqual([{ home: "p1", away: "p0" }]); // differential: today p0 home
    const hard = pairRound(st(["p0", "p1"]), { played: new Set(), colours }, { chess: true });
    expect(hard.ok && hard.pairings).toEqual([{ home: "p0", away: "p1" }]);
    // the mirror, the larger claim on the upper board: outside chess p0 is home; chess must seat p0 Black, since p1 may not
    // take a third Black running
    const mirror = rec([["p0", ["B"]], ["p1", ["W", "W", "B", "B"]]]);
    const softMirror = pairRound(st(["p0", "p1"]), { played: new Set(), colours: mirror });
    expect(softMirror.ok && softMirror.pairings).toEqual([{ home: "p0", away: "p1" }]);
    const hardMirror = pairRound(st(["p0", "p1"]), { played: new Set(), colours: mirror }, { chess: true });
    expect(hardMirror.ok && hardMirror.pairings).toEqual([{ home: "p1", away: "p0" }]);
  });

  it("X-SW-4 a second call with the same input gives the same sides", () => {
    const history = { played: new Set<string>(), colours: rec([["p0", ["W"]], ["p1", ["B"]], ["p2", ["W", "W"]], ["p3", ["B", "W"]]]) };
    const first = pairRound(st(["p0", "p1", "p2", "p3"]), history);
    expect(first.ok && first.pairings.length).toBe(2);
    expect(pairRound(st(["p0", "p1", "p2", "p3"]), history)).toEqual(first);
  });

  it("X-SW-4 after a withdrawal: the next round's sides still follow each entrant's record", () => {
    // round 1, five entrants, no history: p4 takes the bye, the fold seats p0 v p2 and p1 v p3, upper boards home
    const r1 = pairRound(st(["p0", "p1", "p2", "p3", "p4"]), { played: new Set() });
    expect(r1).toEqual({ ok: true, pairings: [{ home: "p0", away: "p2" }, { home: "p1", away: "p3" }], bye: "p4", floated: [] });
    // p0 and p1 won, p4's bye paid a win; then p2 withdraws, and the field of four pairs p0 v p1 and p4 (floated) v p3
    const field: SwissStanding[] = [
      { entrantId: "p0", score: 1, rank: 1 }, { entrantId: "p1", score: 1, rank: 2 },
      { entrantId: "p3", score: 0, rank: 4 }, { entrantId: "p4", score: 1, rank: 5 },
    ];
    const history = {
      played: new Set([pairKey("p0", "p2"), pairKey("p1", "p3")]),
      colours: rec([["p0", ["W"]], ["p1", ["W"]], ["p2", ["B"]], ["p3", ["B"]]]),
      byes: new Set(["p4"]),
    };
    // p0 and p1 were both home: equal claims, so the upper board p0 plays away; p4 (bye, no record) meets p3 (away last), so
    // p3 is home
    expect(pairRound(field, history)).toEqual({
      ok: true,
      pairings: [{ home: "p1", away: "p0" }, { home: "p3", away: "p4" }], // differential: today p0 and p4 home
      floated: ["p4"],
    });
  });

  it("X-SW-4 every board of every simulated non-chess event takes the rule's sides, fold and rank-adjacent, before and after a withdrawal, a retried bye, the whole-field fallback and the look-ahead; a second call agrees (counted)", () => {
    // Each event is RUN: every record is the sides earlier rounds actually seated (a bye seats no side), so every history is
    // one a real event produces. Results: the higher-ranked side wins 60%, an upset 25%, a draw 15%, on football-like table
    // points (win 3, draw 1; a bye pays the win) so score groups form and split. In 40% of events one entrant withdraws
    // before a round after the first and is never paired again (P-A7). The upper board is the side above the other in the
    // pairing order the rulebook defines (score, then rank). As the app does, an event asking for more rounds than the safe
    // maximum ⌊n/2⌋ pairs every round but its last with the one-round look-ahead on (X-SW-10). Two paths no real event here reaches often enough are
    // counted on their own: a retried bye (the bye is not the lowest eligible entrant, P-Q2) and the whole-field fallback
    // (some score boundary is crossed by more boards than the score-group pass may float across it, parity + 4: so the
    // boards cannot be the pass's). Real events never cross that bound, so FALLBACK_ROUNDS constructed rounds that must
    // cross it (below) are judged by the same rule.
    const EVENTS = SWEEP_EVENTS;
    const t = { events: 0, rounds: 0, boards: 0, refused: 0, rankAdjacent: 0, afterWithdrawal: 0, lowerHome: 0,
      neutral: 0, both: 0, imbalance: 0, upperBoard: 0, upperOnly: 0, lowerOnly: 0, byeRetry: 0, fallback: 0, lookAhead: 0 };
    // judge one seated round: every board against the rule's sides; and the two path witnesses
    const judge = (
      r: SwissRound,
      field: readonly SwissStanding[],
      colours: ReadonlyMap<string, readonly Colour[]>,
      byes: ReadonlySet<string>,
      at: Record<string, unknown>,
    ): { lowerHome: number } => {
      const of = new Map(field.map((s) => [s.entrantId, s]));
      const above = (x: string, y: string): boolean => {
        const [a, b] = [of.get(x) as SwissStanding, of.get(y) as SwissStanding];
        return a.score !== b.score ? a.score > b.score : a.rank < b.rank;
      };
      let lowerHome = 0;
      for (const p of r.pairings) {
        const [upper, lower] = above(p.home, p.away) ? [p.home, p.away] : [p.away, p.home];
        const want = rulebookSides(upper, lower, (id) => colours.get(id) ?? []);
        expect({ ...at, board: [p.home, p.away] }).toEqual({ ...at, board: [want.home, want.away] });
        t.boards++;
        t[want.why]++;
        if (want.home === lower) lowerHome++; // the rule seats the lower board home: "stronger side always home" would not
      }
      // the bye: the lowest eligible entrant in the pairing order is the first candidate (P-Q2); any other was retried
      const eligible = field.filter((s) => !byes.has(s.entrantId));
      const lowest = eligible.reduce<SwissStanding | undefined>((lo, s) => (lo === undefined || above(lo.entrantId, s.entrantId) ? s : lo), undefined);
      if (r.bye !== undefined && r.bye !== lowest?.entrantId) t.byeRetry++;
      // the fallback: below each score boundary of the paired remainder, count the boards that cross it
      const paired = field.filter((s) => s.entrantId !== r.bye);
      const scores = [...new Set(paired.map((s) => s.score))].sort((a, b) => b - a);
      const scoreOf = (id: string): number => (of.get(id) as SwissStanding).score;
      const crossesBound = scores.slice(0, -1).some((cut) => {
        const aboveCut = paired.filter((s) => s.score >= cut).length;
        const crossing = r.pairings.filter((p) => (scoreOf(p.home) >= cut) !== (scoreOf(p.away) >= cut)).length;
        return crossing > (aboveCut % 2) + 4;
      });
      if (crossesBound) t.fallback++;
      return { lowerHome };
    };
    for (let seed = 1; seed <= EVENTS; seed++) {
      const rng = mulberry32(seed);
      const n = 2 + Math.floor(rng() * 23); // 2..24
      const roundsAsked = 1 + Math.floor(rng() * 8); // 1..8
      const pairing: SwissConstraints["pairing"] = rng() < 0.5 ? "fold" : "rank_adjacent";
      const withdrawBefore = roundsAsked >= 2 && rng() < 0.4 ? 2 + Math.floor(rng() * (roundsAsked - 1)) : undefined;
      const ids = Array.from({ length: n }, (_, i) => `p${i}`);
      const rank = new Map(ids.map((id, i) => [id, i + 1]));
      const score = new Map(ids.map((id) => [id, 0]));
      const colours = new Map<string, Colour[]>();
      const played = new Set<string>();
      const byes = new Set<string>();
      let active = [...ids];
      t.events++;
      for (let round = 1; round <= roundsAsked; round++) {
        if (round === withdrawBefore) active = active.filter((id) => id !== active[Math.floor(rng() * active.length)]);
        const standings: SwissStanding[] = active.map((id) => ({ entrantId: id, score: score.get(id) as number, rank: rank.get(id) as number }));
        const history = { played, colours, byes };
        // the app's rule (X-SW-10): the look-ahead on every round but the last of an event past the safe maximum
        const lookAhead = roundsAsked > Math.floor(n / 2) && round < roundsAsked;
        const constraints: SwissConstraints = lookAhead ? { pairing, lookAhead } : { pairing };
        const r = pairRound(standings, history, constraints);
        expect(pairRound(standings, history, constraints)).toEqual(r); // the second call
        if (!r.ok) {
          t.refused++; // past what the field can pair: the event stops (its legality is X-SW-1's)
          break;
        }
        t.rounds++;
        t.lowerHome += judge(r, standings, colours, byes, { seed, round }).lowerHome;
        const boards = r.pairings.length;
        if (pairing === "rank_adjacent") t.rankAdjacent += boards;
        if (withdrawBefore !== undefined && round >= withdrawBefore) t.afterWithdrawal += boards;
        if (lookAhead) t.lookAhead += boards;
        for (const p of r.pairings) {
          played.add(pairKey(p.home, p.away));
          colours.set(p.home, [...(colours.get(p.home) ?? []), "W"]);
          colours.set(p.away, [...(colours.get(p.away) ?? []), "B"]);
          const [hi, lo] = (rank.get(p.home) as number) < (rank.get(p.away) as number) ? [p.home, p.away] : [p.away, p.home];
          const roll = rng();
          if (roll < 0.15) {
            score.set(hi, (score.get(hi) as number) + 1);
            score.set(lo, (score.get(lo) as number) + 1);
          } else {
            const winner = roll < 0.75 ? hi : lo;
            score.set(winner, (score.get(winner) as number) + 3);
          }
        }
        if (r.bye !== undefined) {
          byes.add(r.bye);
          score.set(r.bye, (score.get(r.bye) as number) + 3);
        }
      }
    }
    // The constructed fallback rounds: score 1, p0..p(k−1), have all met each other; score 0, q0..q(k−1), have met nobody.
    // Every p must play a q, so k > 4 boards cross the one boundary and the score-group pass cannot seat them (X-SW-2).
    // Each entrant brings a random home/away record of 0–4 rounds; with k odd, the boundary takes an odd count.
    const fallbackBefore = t.fallback;
    for (let seed = 1; seed <= FALLBACK_ROUNDS; seed++) {
      const rng = mulberry32(10_000 + seed);
      const k = 6 + Math.floor(rng() * 3); // 6..8
      const ps = Array.from({ length: k }, (_, i) => `p${i}`), qs = Array.from({ length: k }, (_, i) => `q${i}`);
      const field: SwissStanding[] = [
        ...ps.map((id, i) => ({ entrantId: id, score: 1, rank: i + 1 })),
        ...qs.map((id, i) => ({ entrantId: id, score: 0, rank: k + 1 + i })),
      ];
      const played = new Set(ps.flatMap((x, i) => ps.slice(i + 1).map((y) => pairKey(x, y))));
      const colours = new Map<string, Colour[]>(
        [...ps, ...qs].map((id) => [id, Array.from({ length: Math.floor(rng() * 5) }, () => (rng() < 0.5 ? "W" : "B"))]),
      );
      const pairing: SwissConstraints["pairing"] = rng() < 0.5 ? "fold" : "rank_adjacent";
      const r = seated(pairRound(field, { played, colours }, { pairing }));
      expect(pairRound(field, { played, colours }, { pairing })).toEqual(r); // the second call
      t.rounds++;
      t.lowerHome += judge(r, field, colours, new Set(), { fallbackSeed: seed }).lowerHome;
      if (pairing === "rank_adjacent") t.rankAdjacent += r.pairings.length;
    }
    expect(t.fallback - fallbackBefore).toBe(FALLBACK_ROUNDS); // every constructed round took the whole-field search
    // anti-vacuity: every event ran; boards were judged in every branch of the rule, under both pairing shapes, after a
    // withdrawal, after a retried bye, from the whole-field fallback, with the look-ahead on, and with the lower board home
    // (where "stronger side always home" differs); refusals were reached too
    expect(t.events).toBe(EVENTS);
    expect(t.neutral + t.both + t.imbalance + t.upperBoard + t.upperOnly + t.lowerOnly).toBe(t.boards);
    for (const [k, v] of Object.entries(t)) expect([k, v > 0]).toEqual([k, true]);
  }, SWEEP_BUDGET_MS);
});

// ---------------------------------------------------------------------------
// X-SW-10 — above the safe maximum, a one-round look-ahead (rulebook §3.3 prevention, RB3-4; not a FIDE criterion)
// ---------------------------------------------------------------------------

// The look-ahead's question, answered by the oracle from the rulebook and never by the engine: once this round is seated as `r`
// seats it, can the next round be paired at all? The same field, with this round's boards played, its bye no longer eligible
// (P-A4), and with chess colours on, its sides appended (P-A5).
function seated(r: SwissPairResult): SwissRound {
  if (!r.ok) throw new Error(`expected a seated round, got the refusal ${r.reason}`);
  return r;
}
const nextPairs = (round: OracleRound, r: SwissPairResult): boolean => judgeRound(roundAfter(round, seated(r))).exists;
const boardsOf = (r: SwissPairResult): string[] => (r.ok ? r.pairings.map((p) => pairKey(p.home, p.away)).sort() : []);
const keysOf = (pairs: readonly (readonly [string, string])[]): string[] => pairs.map(([a, b]) => pairKey(a, b)).sort();
const flat = (ids: readonly string[]): OracleRound["field"] => ids.map((id) => ({ id, score: 0 }));

// Example S6 (found by brute force over 6 entrants): rounds 1–2 played a 6-cycle, R1 {p0-p1, p2-p3, p4-p5} and
// R2 {p0-p5, p1-p2, p3-p4}; every score is 0.
const S6_IDS = ["p0", "p1", "p2", "p3", "p4", "p5"];
const S6_PLAYED: [string, string][] = [["p0", "p1"], ["p2", "p3"], ["p4", "p5"], ["p0", "p5"], ["p1", "p2"], ["p3", "p4"]];
const S6 = { played: new Set(S6_PLAYED.map(([a, b]) => pairKey(a, b))) };
const S6_ROUND: OracleRound = { field: flat(S6_IDS), played: S6_PLAYED };

describe("X-SW-10 above the safe maximum, a round is paired so that the next round can still pair, where a choice exists (rulebook §3.3 prevention, RB3-4)", () => {
  it("X-SW-10 empty case first: without lookAhead the result carries no nextRound, and a refusal carries none with it", () => {
    expect("nextRound" in (pairRound(st(S6_IDS), S6) as object)).toBe(false);
    expect("nextRound" in (pairRound(st(S6_IDS), S6, { lookAhead: false }) as object)).toBe(false);
    // a round that cannot be paired is the bare refusal (X-SW-3): there is no seated round to look past
    const ids = ["a", "b", "c", "d"];
    const allMet = new Set(ids.flatMap((x, i) => ids.slice(i + 1).map((y) => pairKey(x, y))));
    const refused = pairRound(st(ids), { played: allMet }, { lookAhead: true });
    expect(refused).toEqual({ ok: false, code: "SWISS_NO_LEGAL_PAIRING", reason: "rematch", field: 4 });
    expect("nextRound" in refused).toBe(false);
  });

  it("X-SW-10 above the safe maximum, round 3 of 6 entrants is paired so that round 4 still pairs (rulebook §3.3 prevention)", () => {
    // differential: without the look-ahead the fold seats the three diameters, after which the unplayed pairs are two
    // triangles {p0,p2,p4} and {p1,p3,p5}, so round 4 has no rematch-free pairing (rulebook §3.1's 6 × 5 audit case)
    const today = pairRound(st(S6_IDS), S6);
    expect(boardsOf(today)).toEqual(keysOf([["p0", "p3"], ["p1", "p4"], ["p2", "p5"]]));
    expect(nextPairs(S6_ROUND, today)).toBe(false);
    const r = pairRound(st(S6_IDS), S6, { lookAhead: true });
    expect(r.ok && r.nextRound).toBe("pairable");
    expect(seatedRoundViolations(S6_ROUND, seated(r))).toEqual([]); // still a legal round 3
    expect(nextPairs(S6_ROUND, r)).toBe(true); // the oracle agrees: round 4 pairs after it
    expect(boardsOf(r)).not.toEqual(boardsOf(today));
  });

  it("X-SW-10 when no pairing keeps the next round alive it still pairs, and says so: 4 entrants, round 3 → nextRound 'unpairable'", () => {
    // R1 {a-b, c-d}, R2 {a-c, b-d}: round 3 is forced {a-d, b-c}; a round 4 cannot exist (even hard maximum n − 1 = 3)
    const played: [string, string][] = [["a", "b"], ["c", "d"], ["a", "c"], ["b", "d"]];
    const round: OracleRound = { field: flat(["a", "b", "c", "d"]), played };
    expect(perfectMatchings(["a", "b", "c", "d"], new Set(played.map(([x, y]) => oraclePairKey(x, y))))).toHaveLength(1); // forced
    const r = pairRound(st(["a", "b", "c", "d"]), { played: new Set(played.map(([x, y]) => pairKey(x, y))) }, { lookAhead: true });
    expect(r).toMatchObject({ ok: true, nextRound: "unpairable" }); // a soft preference: never a refusal
    expect(boardsOf(r)).toEqual(keysOf([["a", "d"], ["b", "c"]]));
    expect(nextPairs(round, r)).toBe(false);
  });

  it("X-SW-10 odd field: the next round's bye eligibility counts this round's bye — 5 entrants where only this round's bye holder could take the next bye", () => {
    // R1 {a-d, b-e} bye c; R2 {a-e, b-c} bye d. Round 3: every score is 0, so e is the lowest eligible, and its remainder pairs
    // (P-Q2). The remainder {a, b, c, d} can be seated two ways: {a-c, b-d} (the fold's) or {a-b, c-d}.
    const ids = ["a", "b", "c", "d", "e"];
    const played: [string, string][] = [["a", "d"], ["b", "e"], ["a", "e"], ["b", "c"]];
    const round: OracleRound = { field: flat(ids), played, byeIneligible: new Set(["c", "d"]) };
    const history = { played: new Set(played.map(([x, y]) => pairKey(x, y))), byes: new Set(["c", "d"]) };
    expect(perfectMatchings(["a", "b", "c", "d"], new Set(played.map(([x, y]) => oraclePairKey(x, y)))).map(keysOf).sort())
      .toEqual([keysOf([["a", "b"], ["c", "d"]]), keysOf([["a", "c"], ["b", "d"]])]);
    const today = pairRound(st(ids), history);
    expect(today.ok && today.bye).toBe("e");
    expect(boardsOf(today)).toEqual(keysOf([["a", "c"], ["b", "d"]]));
    // the constructed differential: after the fold's seating, round 4 pairs ONLY with e on the bye again. Its eligible a and b
    // each leave a rematch-only remainder; the counterfactual that forgets this round's bye (e eligible) would pair
    expect(nextPairs(round, today)).toBe(false);
    expect(judgeRound({ ...roundAfter(round, seated(today)), byeIneligible: new Set(["c", "d"]) }).exists).toBe(true);
    // the look-ahead keeps the bye on e (ruling R1) and seats the other way, after which a or b can take round 4's bye
    const r = pairRound(st(ids), history, { lookAhead: true });
    expect(r.ok && r.bye).toBe("e");
    expect(r.ok && r.nextRound).toBe("pairable");
    expect(boardsOf(r)).toEqual(keysOf([["a", "b"], ["c", "d"]])); // the only other way to seat e's remainder
    expect(nextPairs(round, r)).toBe(true);
    expect(judgeRound(roundAfter(round, seated(r))).pairableByes).toEqual(["a", "b"]);
  });

  it("X-SW-10 the look-ahead never moves the bye (ruling R1): the lowest bye's only seating dead-ends round 5, a higher bye would not, and the bye stays put with nextRound 'unpairable'", () => {
    // six entrants a..f played R1 {a-b, c-d, e-f}, R2 {a-e, b-c, d-f}, R3 {a-f, b-d, c-e}; then f withdraws. Round 4 of the five
    // left: d has the lowest score, so d is the first bye candidate (P-Q2), and its remainder seats only {a-c, b-e}
    const ids = ["a", "b", "c", "d", "e"];
    const played: [string, string][] = [["a", "b"], ["c", "d"], ["a", "e"], ["b", "c"], ["b", "d"], ["c", "e"]];
    const field: SwissStanding[] = [
      { entrantId: "a", score: 3, rank: 1 }, { entrantId: "b", score: 1, rank: 2 }, { entrantId: "c", score: 2, rank: 3 },
      { entrantId: "d", score: 0, rank: 4 }, { entrantId: "e", score: 1, rank: 5 },
    ];
    const round: OracleRound = { field: field.map((s) => ({ id: s.entrantId, score: s.score })), played };
    const met = new Set(played.map(([x, y]) => oraclePairKey(x, y)));
    expect(perfectMatchings(["a", "b", "c", "e"], met).map(keysOf)).toEqual([keysOf([["a", "c"], ["b", "e"]])]);
    // the trade R1 forbids, shown to exist: a higher-scored bye (c) has a seating after which round 5 still pairs
    const viaC = perfectMatchings(["a", "b", "d", "e"], met).filter((boards) =>
      judgeRound(roundAfter(round, { pairings: boards.map(([home, away]) => ({ home, away })), bye: "c" })).exists);
    expect(viaC.length).toBeGreaterThan(0);
    const r = pairRound(field, { played: new Set(played.map(([x, y]) => pairKey(x, y))) }, { lookAhead: true });
    expect(r).toMatchObject({ ok: true, bye: "d", nextRound: "unpairable" });
    expect(boardsOf(r)).toEqual(keysOf([["a", "c"], ["b", "e"]]));
    expect(nextPairs(round, r)).toBe(false);
    // the bye is the plain search's own (R1: the look-ahead never moves it), and d's remainder pairs (P-Q2)
    const plain = pairRound(field, { played: new Set(played.map(([x, y]) => pairKey(x, y))) });
    expect(plain.ok && plain.bye).toBe("d");
    expect(judgeRound(round).pairableByes).toContain("d");
    expect(seatedRoundViolations(round, seated(r))).toEqual([]);
    expect(round.field.map((e) => e.id)).toEqual(ids);
  });

  it("X-SW-10 second call is identical; chess on reads this round's colours into the next-round check", () => {
    // six entrants, White first: R1 {p0-p2, p1-p5, p3-p4}, R2 {p0-p1, p2-p3, p5-p4}, R3 {p5-p0, p3-p1, p4-p2}; every score is
    // 0. Round 4 can be seated two rematch-free ways
    const rounds: [string, string][][] = [
      [["p0", "p2"], ["p1", "p5"], ["p3", "p4"]],
      [["p0", "p1"], ["p2", "p3"], ["p5", "p4"]],
      [["p5", "p0"], ["p3", "p1"], ["p4", "p2"]],
    ];
    const colours = new Map<string, Colour[]>(S6_IDS.map((id) => [id, []]));
    for (const round of rounds) {
      for (const [w, b] of round) {
        (colours.get(w) as Colour[]).push("W");
        (colours.get(b) as Colour[]).push("B");
      }
    }
    const played = rounds.flat();
    const round: OracleRound = { field: flat(S6_IDS), played, colours };
    const history = { played: new Set(played.map(([x, y]) => pairKey(x, y))), colours };
    expect(perfectMatchings(S6_IDS, new Set(played.map(([x, y]) => oraclePairKey(x, y))))).toHaveLength(2);
    const today = pairRound(st(S6_IDS), history, { chess: true });
    expect(boardsOf(today)).toEqual(keysOf([["p0", "p3"], ["p1", "p4"], ["p2", "p5"]]));
    // the constructed differential: after the fold's seating round 5 has no colour-legal pairing, but only because of round
    // 4's own colours; judged on rounds 1–3's colours alone (the check that forgets this round's sides) it would pair
    expect(nextPairs(round, today)).toBe(false);
    expect(judgeRound({ ...roundAfter(round, seated(today)), colours }).exists).toBe(true);
    const r = pairRound(st(S6_IDS), history, { chess: true, lookAhead: true });
    expect(r.ok && r.nextRound).toBe("pairable");
    expect(boardsOf(r)).toEqual(keysOf([["p0", "p4"], ["p1", "p2"], ["p3", "p5"]]));
    expect(seatedRoundViolations(round, seated(r))).toEqual([]); // P-A5 as seated
    expect(nextPairs(round, r)).toBe(true); // with the colours it seated
    // the second call
    expect(pairRound(st(S6_IDS), history, { chess: true, lookAhead: true })).toEqual(r);
    expect(pairRound(st(S6_IDS), S6, { lookAhead: true })).toEqual(pairRound(st(S6_IDS), S6, { lookAhead: true }));
  });

  it("X-SW-10 chess: boards of two floaters the search reaches upside down are still seated upper board first, so the look-ahead never takes the first pairing again with its colours swapped, and floated names each board's upper side", () => {
    // A real event: six entrants, White first, R1 {p3-p0, p1-p2, p5-p4}, R2 {p0-p2, p5-p1, p4-p3}, R3 {p1-p0, p2-p4, p3-p5};
    // a win pays 2, a draw 1. Round 4's pairing order is p1, p3 (5), p4 (4), p0 (2), p2, p5 (1).
    const rounds: [string, string][][] = [
      [["p3", "p0"], ["p1", "p2"], ["p5", "p4"]],
      [["p0", "p2"], ["p5", "p1"], ["p4", "p3"]],
      [["p1", "p0"], ["p2", "p4"], ["p3", "p5"]],
    ];
    const colours = new Map<string, Colour[]>(S6_IDS.map((id) => [id, []]));
    for (const round of rounds) {
      for (const [w, b] of round) {
        (colours.get(w) as Colour[]).push("W");
        (colours.get(b) as Colour[]).push("B");
      }
    }
    const scores: Record<string, number> = { p0: 2, p1: 5, p2: 1, p3: 5, p4: 4, p5: 1 };
    const field: SwissStanding[] = S6_IDS.map((id, i) => ({ entrantId: id, score: scores[id] as number, rank: i + 1 }));
    const played = rounds.flat();
    const round: OracleRound = { field: field.map((s) => ({ id: s.entrantId, score: s.score })), played, colours };
    const history = { played: new Set(played.map(([x, y]) => pairKey(x, y))), colours };
    // the rule's sides on one board: a colour only one assignment allows is forced (rulebook P-A5), else the preferences
    // decide in rulebookSides' order (an approximation of FIDE C.04.3 art. 5.2)
    const above = (x: string, y: string): boolean => (scores[x] !== scores[y] ? (scores[x] as number) > (scores[y] as number) : x < y);
    const recordOf = (id: string): Colour[] => colours.get(id) ?? [];
    const sidesOf = (x: string, y: string): { home: string; away: string } => {
      const [upper, lower] = above(x, y) ? [x, y] : [y, x];
      const sides = ruleSides(upper, lower, recordOf, true);
      if (sides === undefined) throw new Error(`${upper} and ${lower} may not meet (P-A5): not a board to judge`);
      return sides;
    };
    const ruleFloated = (r: SwissPairResult): string[] =>
      seated(r).pairings.filter((p) => scores[p.home] !== scores[p.away]).map((p) => (above(p.home, p.away) ? p.home : p.away)).sort();

    // without the look-ahead: p1 v p3 within the top group, p4 down to p0, p2 v p5; after it round 5 cannot pair
    const today = pairRound(field, history, { chess: true });
    expect(boardsOf(today)).toEqual(keysOf([["p1", "p3"], ["p0", "p4"], ["p2", "p5"]]));
    expect(seated(today).pairings).toEqual(seated(today).pairings.map((p) => sidesOf(p.home, p.away)));
    expect(nextPairs(round, today)).toBe(false);
    // the trap: the look-ahead reaches the same three boards again with p1, p3 floated together and p4, p0 floated together,
    // each pair the wrong way up (lower board first). Seated as reached, the colours on both boards swap, which would leave
    // round 5 pairable, but it is the rule's colouring turned over (and would name p0, not p4, as the one who floated)
    const swapped = seated(today).pairings.map((p) => (pairKey(p.home, p.away) === pairKey("p2", "p5") ? p : { home: p.away, away: p.home }));
    expect(judgeRound(roundAfter(round, { pairings: swapped })).exists).toBe(true);
    expect(swapped).not.toEqual(swapped.map((p) => sidesOf(p.home, p.away)));

    // the look-ahead seats the only other way, with the rule's colours, after which round 5 pairs
    expect(perfectMatchings(S6_IDS, new Set(played.map(([x, y]) => oraclePairKey(x, y))))).toHaveLength(2);
    const r = pairRound(field, history, { chess: true, lookAhead: true });
    expect(r.ok && r.nextRound).toBe("pairable");
    expect(boardsOf(r)).toEqual(keysOf([["p1", "p4"], ["p0", "p5"], ["p2", "p3"]]));
    expect(seated(r).pairings).toEqual(seated(r).pairings.map((p) => sidesOf(p.home, p.away)));
    expect([...seated(r).floated].sort()).toEqual(ruleFloated(r)); // each cross-score board's upper side floated down
    expect(ruleFloated(r)).toEqual(["p0", "p1", "p3"]);
    expect(nextPairs(round, r)).toBe(true);
  });

  it("X-SW-10 a part of the field whose seatings were all turned down after one board is tried again after another: 7 entrants, the one keeper lies behind it", () => {
    // p4 leads on 2, the rest are on 0; p0, p4 and p6 have had byes. P-Q2: p5, the lowest eligible, leaves a rematch-only
    // remainder, so the bye retries up to p3. Its remainder seats three ways, and the oracle finds one keeper
    const sc: [string, number][] = [["p0", 0], ["p1", 0], ["p2", 0], ["p3", 0], ["p4", 2], ["p5", 0], ["p6", 0]];
    const played: [string, string][] = [
      ["p0", "p1"], ["p0", "p2"], ["p0", "p3"], ["p0", "p4"], ["p1", "p3"], ["p1", "p4"], ["p1", "p5"], ["p2", "p3"], ["p2", "p6"],
      ["p3", "p4"], ["p3", "p6"],
    ];
    const byes = new Set(["p0", "p4", "p6"]);
    const round: OracleRound = { field: sc.map(([id, score]) => ({ id, score })), played, byeIneligible: byes };
    const standings: SwissStanding[] = sc.map(([id, score], i) => ({ entrantId: id, score, rank: i + 1 }));
    const history = { played: new Set(played.map(([x, y]) => pairKey(x, y))), byes };
    const remainder = sc.map(([id]) => id).filter((id) => id !== "p3");
    const seatings = perfectMatchings(remainder, new Set(played.map(([x, y]) => oraclePairKey(x, y))));
    const keepers = seatings.filter((m) => judgeRound(roundAfter(round, { pairings: m.map(([home, away]) => ({ home, away })), bye: "p3" })).exists);
    expect([seatings.length, keepers.map(keysOf)]).toEqual([3, [keysOf([["p0", "p5"], ["p1", "p2"], ["p4", "p6"]])]]);
    const today = pairRound(standings, history);
    expect(today.ok && today.bye).toBe("p3");
    expect(nextPairs(round, today)).toBe(false); // differential: today's seating dead-ends the next round
    const r = pairRound(standings, history, { lookAhead: true });
    expect(r.ok && r.bye).toBe("p3");
    // P-Q2: of the two byes whose remainder pairs, the lower in the pairing order takes it (equal scores, p3 ranked below p1)
    expect(judgeRound(round).pairableByes).toEqual(["p1", "p3"]);
    expect(r.ok && r.nextRound).toBe("pairable");
    expect(boardsOf(r)).toEqual(keysOf(keepers[0] ?? []));
  });

  it("X-SW-10 chess: the search stops early only when the next round cannot pair whatever this round seats, read with the colour limits lifted, since this round's colours can ease them (5 entrants)", () => {
    // p2 leads on 2 and is the only bye whose remainder pairs (P-Q2). p3 has had two Blacks, so may not take a third (P-A5)
    const sc: [string, number][] = [["p0", 0], ["p1", 0], ["p2", 2], ["p3", 0], ["p4", 0]];
    const played: [string, string][] = [["p1", "p2"], ["p2", "p4"], ["p3", "p4"]];
    const byes = new Set(["p1", "p3", "p4"]);
    const colours = new Map<string, Colour[]>([["p2", ["B", "B"]], ["p3", ["B", "B"]], ["p4", ["W"]]]);
    const round: OracleRound = { field: sc.map(([id, score]) => ({ id, score })), played, byeIneligible: byes, colours };
    const standings: SwissStanding[] = sc.map(([id, score], i) => ({ entrantId: id, score, rank: i + 1 }));
    const history = { played: new Set(played.map(([x, y]) => pairKey(x, y))), byes, colours };
    expect(judgeRound(round).pairableByes).toEqual(["p2"]);
    // the next round, read before this one adds anything (p2's bye spent): with today's colours it cannot pair, with the
    // colour limits lifted it can. A stop read with the colours kept would give up here
    const before = { ...round, byeIneligible: new Set([...byes, "p2"]) };
    expect([judgeRound(before).exists, judgeRound({ ...before, colours: undefined }).exists]).toEqual([false, true]);
    const today = pairRound(standings, history, { chess: true });
    expect(nextPairs(round, today)).toBe(false); // differential: the first seating dead-ends the next round
    const r = pairRound(standings, history, { chess: true, lookAhead: true });
    expect(r.ok && r.bye).toBe("p2");
    expect(r.ok && r.nextRound).toBe("pairable");
    expect(seatedRoundViolations(round, seated(r))).toEqual([]);
    expect(nextPairs(round, r)).toBe(true); // the oracle agrees, with this round's colours read in
  });

  it("X-SW-10 the look-ahead draws on the call's one budget (the T2 cap): at the smallest budget the search needs without it, the same round comes back 'unknown' (round 1 of 4, 6, 8 and 10 entrants, counted)", () => {
    let checked = 0;
    for (const n of [4, 6, 8, 10]) {
      const ids = Array.from({ length: n }, (_, i) => `p${i}`);
      const history = { played: new Set<string>() };
      let least = 0;
      while (!pairRound(st(ids), history, {}, least).ok) least++;
      const plain = pairRound(st(ids), history, {}, least);
      // relational: the look-ahead's own nodes come out of the same budget, so it has none left at the plain search's least
      expect(pairRound(st(ids), history, { lookAhead: true }, least)).toEqual({ ...plain, nextRound: "unknown" });
      // and with enough, round 1's first seating keeps round 2 pairable (n ≥ 4)
      expect(pairRound(st(ids), history, { lookAhead: true })).toEqual({ ...plain, nextRound: "pairable" });
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("X-SW-10 X-SW-2 without lookAhead, a score group whose floaters leave the group below dead tries its next floater choice, not its other pairings: 16 at score 2 over two who met, P-Q1's two lowest-ranked float within a budget of 5,000", () => {
    // score 2: t0..t15 (fresh); score 1: u0, u1, who have met. The top group must float two (fewest floats, the lowest-ranked,
    // P-Q1) to meet u0 and u1. Its 2,027,025 pairings with no floater all leave u0 v u1, a rematch: once one of them shows
    // that, the pass moves on to the floaters, as it always has; walking the rest would spend its share of this budget first
    const ts = Array.from({ length: 16 }, (_, i) => `t${i}`);
    const field: SwissStanding[] = [
      ...ts.map((id, i) => ({ entrantId: id, score: 2, rank: i + 1 })),
      { entrantId: "u0", score: 1, rank: 17 }, { entrantId: "u1", score: 1, rank: 18 },
    ];
    let checked = 0;
    for (const chess of [false, true]) {
      const r = pairRound(field, { played: new Set([pairKey("u0", "u1")]) }, { chess }, 5_000);
      expect(r.ok && [...r.floated].sort()).toEqual(["t14", "t15"]);
      const boards = r.ok ? r.pairings.map((p) => [p.home, p.away].sort().join(" v ")) : [];
      expect(boards.filter((b) => /^t\d+ v t\d+$/.test(b))).toHaveLength(7); // the other 14 pair within the group
      expect(boards.filter((b) => /^t1[45] v u[01]$/.test(b))).toHaveLength(2);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("X-SW-10 an exhausted budget during the look-ahead returns the first legal pairing with nextRound 'unknown'", () => {
    // S6 under every budget from 0 to 5,000: the search runs out before any legal pairing (search_limit, the bare refusal),
    // or after the first legal pairing and before the look-ahead finished (that pairing, 'unknown'), or it finishes: then it
    // is the answer the default budget gives, however its nodes fell between the score-group pass and the whole-field search
    const first = pairRound(st(S6_IDS), S6); // the first legal pairing: the diameters
    expect(first.ok).toBe(true);
    const full = pairRound(st(S6_IDS), S6, { lookAhead: true });
    expect(full.ok && full.nextRound).toBe("pairable");
    expect(nextPairs(S6_ROUND, full)).toBe(true);
    const seen = { search_limit: 0, unknown: 0, pairable: 0 };
    for (let budget = 0; budget <= 5_000; budget++) {
      const r = pairRound(st(S6_IDS), S6, { lookAhead: true }, budget);
      if (!r.ok) {
        expect(r).toEqual({ ok: false, code: "SWISS_NO_LEGAL_PAIRING", reason: "search_limit", field: 6 });
        expect({ budget, after: seen.unknown + seen.pairable }).toEqual({ budget, after: 0 }); // never after a legal pairing
        seen.search_limit++;
      } else if (r.nextRound === "unknown") {
        expect({ budget, r }).toEqual({ budget, r: { ...first, nextRound: "unknown" } });
        seen.unknown++;
      } else {
        expect({ budget, r }).toEqual({ budget, r: full });
        seen.pairable++;
      }
    }
    expect(seen.search_limit).toBeGreaterThan(0);
    expect(seen.unknown).toBeGreaterThan(0);
    expect(seen.pairable).toBeGreaterThan(0); // reached, under budgets far below the default
    expect(seen.search_limit + seen.unknown + seen.pairable).toBe(5_001);
  });
});

// ---------------------------------------------------------------------------
// X-SW-11 — the topscorer colour exception in the final round (RB3-10; FIDE C.04.3 A.6, [C3])
// ---------------------------------------------------------------------------

describe("X-SW-11 in the final round a board with a topscorer is exempt from the colour limits; two non-topscorers still are not (RB3-10, C.04.3 [C3])", () => {
  // Chess on throughout but where a case says otherwise. a and b each played White twice running, so both have an absolute
  // preference for Black (C.04.3 A.6): under the colour limits they may not meet (never three of one colour running, P-A5).
  // finalRoundMaxScore 4 is the most either could have scored before the final round; a topscorer has over half of it.
  const ww = new Map([["a", ["W", "W"] as Colour[]], ["b", ["W", "W"] as Colour[]]]);
  const at = (sa: number, sb: number): SwissStanding[] => [{ entrantId: "a", score: sa, rank: 1 }, { entrantId: "b", score: sb, rank: 2 }];

  it("X-SW-11 empty case first: no finalRoundMaxScore → the colour limits bind as before (refused 'colour')", () => {
    expect(pairRound(at(3, 3), { played: new Set(), colours: ww }, { chess: true })).toMatchObject({ ok: false, reason: "colour" });
  });

  it("X-SW-11 two topscorers (3 > ½·4) may meet in the final round despite the same absolute preference (C.04.3 [C3])", () => {
    const r = pairRound(at(3, 3), { played: new Set(), colours: ww }, { chess: true, finalRoundMaxScore: 4 });
    expect(r).toMatchObject({ ok: true }); // differential: today refused
    // their sides: neither has a limit left to keep, so the preferences decide. Both ask Black with the same colour
    // difference (+2), so the higher-ranked a gets its preference (C.04.3 art. 5.2: the wider difference, then the rank)
    expect(r.ok && r.pairings).toEqual([{ home: "b", away: "a" }]);
  });

  it("X-SW-11 two non-topscorers (1, 1) stay refused in the final round", () => {
    expect(pairRound(at(1, 1), { played: new Set(), colours: ww }, { chess: true, finalRoundMaxScore: 4 })).toMatchObject({ ok: false, reason: "colour" });
  });

  it("X-SW-11 exactly half is not a topscorer (A.6 'over 50%'): 2 and 2 of 4 are refused", () => {
    expect(pairRound(at(2, 2), { played: new Set(), colours: ww }, { chess: true, finalRoundMaxScore: 4 })).toMatchObject({ ok: false, reason: "colour" });
    // and just over half is: 2 of 3.5 makes both topscorers, so they meet
    expect(pairRound(at(2, 2), { played: new Set(), colours: ww }, { chess: true, finalRoundMaxScore: 3.5 })).toMatchObject({ ok: true });
  });

  it("X-SW-11 a topscorer v a non-topscorer: the non-topscorer keeps its limit (b, score 1, gets Black; a takes a third White)", () => {
    const r = pairRound(at(3, 1), { played: new Set(), colours: ww }, { chess: true, finalRoundMaxScore: 4 });
    expect(r.ok && r.pairings).toEqual([{ home: "a", away: "b" }]);
    // the mirror, the topscorer on the lower board: a (score 1) keeps its limit and gets Black, b takes a third White
    const mirror = pairRound(at(1, 3), { played: new Set(), colours: ww }, { chess: true, finalRoundMaxScore: 4 });
    expect(mirror.ok && mirror.pairings).toEqual([{ home: "b", away: "a" }]);
  });

  it("X-SW-11 non-chess is unaffected (no hard colour limit to relax); a second call is identical", () => {
    let checked = 0;
    for (const [sa, sb] of [[3, 3], [3, 1], [1, 1], [2, 2]] as const) {
      const plain = pairRound(at(sa, sb), { played: new Set(), colours: ww });
      const final = pairRound(at(sa, sb), { played: new Set(), colours: ww }, { finalRoundMaxScore: 4 });
      expect({ sa, sb, final }).toEqual({ sa, sb, final: plain });
      expect(pairRound(at(sa, sb), { played: new Set(), colours: ww }, { finalRoundMaxScore: 4 })).toEqual(final); // the second call
      checked++;
    }
    expect(checked).toBe(4);
    // outside chess both ask away with equal claims, so the upper board a plays away (X-SW-4): paired, never refused
    expect(pairRound(at(3, 3), { played: new Set(), colours: ww }, { finalRoundMaxScore: 4 })).toMatchObject({ ok: true, pairings: [{ home: "b", away: "a" }] });
    // chess on, a second call is identical too
    const chess = pairRound(at(3, 3), { played: new Set(), colours: ww }, { chess: true, finalRoundMaxScore: 4 });
    expect(pairRound(at(3, 3), { played: new Set(), colours: ww }, { chess: true, finalRoundMaxScore: 4 })).toEqual(chess);
  });

  it("X-SW-11 a non-finite or non-positive finalRoundMaxScore is CONFIG_INVALID", () => {
    let checked = 0;
    for (const chess of [true, false]) {
      for (const finalRoundMaxScore of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1]) {
        expect(() => pairRound(at(3, 3), { played: new Set(), colours: ww }, { chess, finalRoundMaxScore }))
          .toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
        checked++;
      }
    }
    expect(checked).toBe(10);
    // a positive maximum below one point is a maximum, not a defect
    expect(pairRound(at(3, 3), { played: new Set(), colours: ww }, { chess: true, finalRoundMaxScore: 0.5 })).toMatchObject({ ok: true });
  });

  it("X-SW-11 X-SW-10 both flags in one call: the look-ahead judges the next round under the full colour limits, never under this round's topscorer exception, so it moves a board the exception would have kept (controller ruling)", () => {
    // Six entrants, White first: R1 {p3-p1, p4-p0, p2-p5}, R2 {p0-p5, p1-p2, p4-p3}, R3 {p5-p1, p3-p0, p2-p4} (found by a search
    // over legal events). Scores p0 3, p1 3, p2 0, p3 0, p4 2, p5 2, with finalRoundMaxScore 3: p0, p1, p4 and p5 have over
    // half (1.5), so they are this round's topscorers. Round 4 can be seated two rematch-free ways.
    const rounds: [string, string][][] = [
      [["p3", "p1"], ["p4", "p0"], ["p2", "p5"]],
      [["p0", "p5"], ["p1", "p2"], ["p4", "p3"]],
      [["p5", "p1"], ["p3", "p0"], ["p2", "p4"]],
    ];
    const colours = new Map<string, Colour[]>(S6_IDS.map((id) => [id, []]));
    for (const round of rounds) {
      for (const [w, b] of round) {
        (colours.get(w) as Colour[]).push("W");
        (colours.get(b) as Colour[]).push("B");
      }
    }
    const scores: Record<string, number> = { p0: 3, p1: 3, p2: 0, p3: 0, p4: 2, p5: 2 };
    const field: SwissStanding[] = S6_IDS.map((id, i) => ({ entrantId: id, score: scores[id] as number, rank: i + 1 }));
    const played = rounds.flat();
    const round: OracleRound = { field: field.map((s) => ({ id: s.entrantId, score: s.score })), played, colours };
    const history = { played: new Set(played.map(([x, y]) => pairKey(x, y))), colours };
    const both = { chess: true, lookAhead: true, finalRoundMaxScore: 3 } as const;
    expect(perfectMatchings(S6_IDS, new Set(played.map(([x, y]) => oraclePairKey(x, y)))).map(keysOf).sort())
      .toEqual([keysOf([["p0", "p1"], ["p2", "p3"], ["p4", "p5"]]), keysOf([["p0", "p2"], ["p1", "p4"], ["p3", "p5"]])].sort());
    // without the look-ahead: p0 v p1, p2 v p3, p4 v p5. After it, round 5 has only the other seating left, and under the
    // full colour limits a pair of it may not meet; read with this round's topscorers exempt (the next round's are not known
    // yet), it would pair
    const plain = pairRound(field, history, { chess: true, finalRoundMaxScore: 3 });
    expect(boardsOf(plain)).toEqual(keysOf([["p0", "p1"], ["p2", "p3"], ["p4", "p5"]]));
    expect(nextPairs(round, plain)).toBe(false);
    expect(judgeRound({ ...roundAfter(round, seated(plain)), finalRoundMaxScore: 3 }).exists).toBe(true); // differential
    // with both flags the look-ahead takes the full limits' answer: it moves to the other seating, after which round 5 pairs
    const r = pairRound(field, history, both);
    expect(r.ok && r.nextRound).toBe("pairable");
    expect(boardsOf(r)).toEqual(keysOf([["p0", "p2"], ["p1", "p4"], ["p3", "p5"]]));
    expect(seatedRoundViolations({ ...round, finalRoundMaxScore: 3 }, seated(r))).toEqual([]); // a legal final round
    expect(nextPairs(round, r)).toBe(true);
    expect(pairRound(field, history, both)).toEqual(r); // the second call
  });
});
