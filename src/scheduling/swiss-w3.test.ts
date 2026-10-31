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
      .toEqual({ ok: false, code: "SWISS_NO_LEGAL_PAIRING", reason: "colour", field: 2 });
    // the same two without the chess colour limits pair: the refusal is the colour limit's, not a rematch
    const open = pairRound(st(["a", "b"]), { played: new Set(), colours });
    expect(open.ok && open.pairings.length).toBe(1);
  });

  it("X-SW-3 a budget the search exhausts is search_limit, not a claim that no pairing exists", () => {
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
    expect(() => pairRound(st(["a", "a"]), { played: new Set() })).toThrow(/CONFIG_INVALID|twice/);
    expect(() => pairRound(st(["a", "b", "a"]), { played: new Set() })).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
  });
});
