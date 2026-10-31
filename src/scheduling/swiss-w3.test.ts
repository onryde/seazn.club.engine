// W3 Swiss pairing (rulebook-W3-swiss §2.1 P-A6, §3.3; FIDE C.04.3 [C4]). A round with no legal pairing is a named
// refusal, never an empty or partial round reported as success.
import { describe, expect, it } from "vitest";
import { pairKey, pairRound, SWISS_SEARCH_BUDGET, type Colour, type SwissStanding } from "./swiss.ts";

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
    // without the colour limits the same field pairs, with the bye retried up to b
    expect(pairRound(st(["a", "b", "c"]), { played, colours })).toEqual({ ok: true, pairings: [{ home: "a", away: "c" }], bye: "b", floated: [] });
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

describe("X-SW-2 score groups first, bounded floats, a whole-field search only when the groups cannot (RB3-1, P-Q1/P-Q2)", () => {
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
    // score 2: t0..t3 (fresh); score 1: u0..u9 have all met each other; score 0: l0..l9 (fresh). Every u must play an l, so
    // the score-group pass (at most 4 floats per group) is dead under every one of the top group's choices, and walking
    // them all costs more than this budget; the whole-field search seats u v l at once
    const ts = ["t0", "t1", "t2", "t3"];
    const us = Array.from({ length: 10 }, (_, i) => `u${i}`), ls = Array.from({ length: 10 }, (_, i) => `l${i}`);
    const played = new Set(us.flatMap((x, i) => us.slice(i + 1).map((y) => pairKey(x, y))));
    const field: SwissStanding[] = [
      ...ts.map((id, i) => ({ entrantId: id, score: 2, rank: i + 1 })),
      ...us.map((id, i) => ({ entrantId: id, score: 1, rank: 5 + i })),
      ...ls.map((id, i) => ({ entrantId: id, score: 0, rank: 15 + i })),
    ];
    for (const chess of [false, true]) {
      const r = pairRound(field, { played }, { chess }, 5_000); // differential: today search_limit (the group pass spends all 5,000)
      expect(r.ok && r.pairings).toHaveLength(12); // ⌊24/2⌋ boards (P-A3)
      if (!r.ok) continue;
      const boards = r.pairings.map((p) => [p.home, p.away].sort().join(" v "));
      expect(boards.filter((b) => /^l\d v u\d$/.test(b))).toHaveLength(10); // every u v an l
      expect(boards.filter((b) => /^t\d v t\d$/.test(b))).toHaveLength(2); // the top group pairs within itself
      expect([...r.floated].sort()).toEqual([...us].sort());
    }
  });
  it("X-SW-2 after a withdrawal (one entrant leaves the standings) the next round still seats everyone once", () => {
    const r = pairRound(st(["a", "b", "c", "d", "e"]).filter((s) => s.entrantId !== "c"), { played: new Set([pairKey("a", "b")]) });
    expect(r.ok && r.pairings.flatMap((p) => [p.home, p.away]).sort()).toEqual(["a", "b", "d", "e"]);
    expect(r.ok && r.pairings.some((p) => pairKey(p.home, p.away) === pairKey("a", "b"))).toBe(false);
  });
});
