// W3 Swiss pairing (rulebook-W3-swiss §2.1 P-A6, §3.3; FIDE C.04.3 [C4]). A round with no legal pairing is a named
// refusal, never an empty or partial round reported as success.
import { describe, expect, it } from "vitest";
import { mulberry32 } from "../core/rng.ts";
import { pairKey, pairRound, SWISS_SEARCH_BUDGET, type Colour, type SwissConstraints, type SwissStanding } from "./swiss.ts";

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

// The rule, read from the rulebook and never from the engine: an entrant's home/away record (home = "W", as the app stores
// it for every sport) asks for a side. More homes than aways asks away and more aways asks home; a level record asks the
// side it did not have last; no record asks nothing. On a board both asks are granted when they differ; the same ask goes
// to the larger imbalance, then to the upper board; a lone ask is granted; with none, the upper board is home (the order of
// rulebook P-Q5 for colours, applied as a soft preference: nothing here is ever a reason to refuse a pairing).
type Side = "home" | "away";
type Why = "neutral" | "both" | "imbalance" | "upperBoard" | "upperOnly" | "lowerOnly";
const asks = (record: readonly Colour[]): { side: Side | null; imbalance: number } => {
  const homes = record.filter((c) => c === "W").length;
  const lean = homes - (record.length - homes);
  if (lean !== 0) return { side: lean > 0 ? "away" : "home", imbalance: Math.abs(lean) };
  const last = record.at(-1);
  return { side: last === undefined ? null : last === "W" ? "away" : "home", imbalance: 0 };
};
function rulebookSides(upper: string, lower: string, recordOf: (id: string) => readonly Colour[]): { home: string; away: string; why: Why } {
  const u = asks(recordOf(upper));
  const l = asks(recordOf(lower));
  const seat = (upperSide: Side, why: Why) =>
    upperSide === "home" ? { home: upper, away: lower, why } : { home: lower, away: upper, why };
  const flip = (s: Side): Side => (s === "home" ? "away" : "home");
  if (u.side !== null && l.side !== null) {
    if (u.side !== l.side) return seat(u.side, "both");
    if (u.imbalance !== l.imbalance) return seat(u.imbalance > l.imbalance ? u.side : flip(u.side), "imbalance");
    return seat(u.side, "upperBoard");
  }
  if (u.side !== null) return seat(u.side, "upperOnly");
  if (l.side !== null) return seat(flip(l.side), "lowerOnly");
  return seat("home", "neutral");
}

// The sweep's time budget, SIZED from measured cost as swiss.test.ts's properties are (T3 controller ruling: a derived budget
// is sizing; the --testTimeout flag is banned): max(5 s default, events × p99.9 cost of one event × 5 load slack). One event
// cost 0.90 ms mean, 8.39 ms p99.9, 42 ms max over 4,000 events of this sweep (a probe copy, 2026-10-31, load average ~6;
// task-4-report.md). 200 events reach every counted bucket (the rarest, a lone ask, ~1 board in 5 events).
const SWEEP_EVENTS = 200;
const SWEEP_BUDGET_MS = Math.max(5_000, Math.ceil(SWEEP_EVENTS * 8.4 * 5));

describe("X-SW-4 outside chess, a Swiss board's home side alternates where it can, and never refuses a pairing (rulebook RB3-11, P-Q6; SW-L5)", () => {
  // Pairing is sport-blind: pairRound sees only `chess`, never a sport. So the "another sport" axis here is chess on, whose
  // hard colour limits are untouched (the chess tests in this file and swiss.test.ts stay green unchanged); every non-chess
  // sport takes the soft path, which the sweep below drives with both pairing shapes. In each hand case both sides score 0,
  // and p0 is rank 1 (the upper board), p1 rank 2.
  const rec = (entries: [string, Colour[]][]) => new Map(entries);

  it("X-SW-4 non-chess: home last round meets away last round → the sides swap (P-Q6)", () => {
    const r = pairRound(st(["p0", "p1"]), { played: new Set(), colours: rec([["p0", ["W"]], ["p1", ["B"]]]) });
    expect(r.ok && r.pairings).toEqual([{ home: "p1", away: "p0" }]); // differential: today p0 home
  });

  it("X-SW-4 round 1 (no history): the upper board is home", () => {
    expect(pairRound(st(["p0", "p1"]), { played: new Set() })).toMatchObject({ ok: true, pairings: [{ home: "p0", away: "p1" }] });
    // an empty record is no history either
    expect(pairRound(st(["p0", "p1"]), { played: new Set(), colours: rec([["p0", []], ["p1", []]]) }))
      .toMatchObject({ ok: true, pairings: [{ home: "p0", away: "p1" }] });
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

  it("X-SW-4 every board of every simulated non-chess event takes the rule's sides, fold and rank-adjacent, before and after a withdrawal; a second call agrees (counted)", () => {
    // Each event is RUN: every record is the sides earlier rounds actually seated (a bye seats no side), so every history is
    // one a real event produces. Results: the higher-ranked side wins 60%, an upset 25%, a draw 15%, on football-like table
    // points (win 3, draw 1; a bye pays the win) so score groups form and split. In 40% of events one entrant withdraws
    // before a round after the first and is never paired again (P-A7). The upper board is the side above the other in the
    // pairing order the rulebook defines (score, then rank).
    const EVENTS = SWEEP_EVENTS;
    const t = { events: 0, rounds: 0, boards: 0, refused: 0, rankAdjacent: 0, afterWithdrawal: 0, lowerHome: 0,
      neutral: 0, both: 0, imbalance: 0, upperBoard: 0, upperOnly: 0, lowerOnly: 0 };
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
        const r = pairRound(standings, history, { pairing });
        expect(pairRound(standings, history, { pairing })).toEqual(r); // the second call
        if (!r.ok) {
          t.refused++; // past what the field can pair: the event stops (its legality is X-SW-1's)
          break;
        }
        t.rounds++;
        const above = (x: string, y: string): boolean =>
          (score.get(x) as number) !== (score.get(y) as number)
            ? (score.get(x) as number) > (score.get(y) as number)
            : (rank.get(x) as number) < (rank.get(y) as number);
        for (const p of r.pairings) {
          const [upper, lower] = above(p.home, p.away) ? [p.home, p.away] : [p.away, p.home];
          const want = rulebookSides(upper, lower, (id) => colours.get(id) ?? []);
          expect({ seed, round, board: [p.home, p.away] }).toEqual({ seed, round, board: [want.home, want.away] });
          t.boards++;
          t[want.why]++;
          if (want.home === lower) t.lowerHome++; // the rule seats the lower board home: "stronger side always home" would not
          if (pairing === "rank_adjacent") t.rankAdjacent++;
          if (withdrawBefore !== undefined && round >= withdrawBefore) t.afterWithdrawal++;
        }
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
    // anti-vacuity: every event ran; boards were judged in every branch of the rule, under both pairing shapes, after a
    // withdrawal, and with the lower board home (where "stronger side always home" differs); refusals were reached too
    expect(t.events).toBe(EVENTS);
    expect(t.neutral + t.both + t.imbalance + t.upperBoard + t.upperOnly + t.lowerOnly).toBe(t.boards);
    for (const [k, v] of Object.entries(t)) expect([k, v > 0]).toEqual([k, true]);
  }, SWEEP_BUDGET_MS);
});
