// W2d Task 20 (MD-1, spec §14: W2d owns every survivor in competition/tiebreakers.ts): the tests that kill what
// Stryker left alive there. The mutants recorded as equivalent are in stryker-equivalent.json, each with its proof.
//
// Expected values are computed by hand from the rule each block cites — Buchholz, Cut-1 and Sonneborn-Berger as sums
// over a card (spec 04 §6.3), spec 05 §4.2 (direct encounter), spec 05 §4.3 (a ratio is compared by cross-multiplication;
// 0/0 is 0, "no data"), the ICC net run rate (runs for per over faced minus runs against per over bowled, spec 04 §5) —
// and from the engine's own declarations (`SwissGame`, `RATIO_LEDGERS`). Never from rankStandings or the Swiss readers
// under test. An unplayed game is scored by FIDE C.07 (2026) art. 16 (rulebook-W3-swiss.md §4; W3 replaced the
// superseded virtual opponent, SW-M1), so its values are absolute.
//
// Every table here is hand-built; the one sport read is the whole registry, swept (R26).
import { describe, expect, it } from "vitest";
import type { StandingsDelta } from "../core/types.ts";
import { mulberry32 } from "../core/rng.ts";
import { builtinModules } from "../sports/index.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { RATIO_LEDGERS } from "./display.ts";
import type { FixtureResult, StandingsRow } from "./standings.ts";
import { buchholz, buildSwissLedger, directEncounter, rankStandings, sonnebornBerger, type SwissGame, type SwissTable } from "./tiebreakers.ts";

const row = (entrantId: string, points: number, metrics: Record<string, number> = {}): StandingsRow => ({
  entrantId, played: 0, won: 0, drawn: 0, lost: 0, points, metrics,
});
const ids = (rows: readonly StandingsRow[]): string[] => rows.map((r) => r.entrantId);
/** One side of a decided game, in half-points (win 2, draw 1, loss 0). */
const side = (entrantId: string, r: "w" | "d" | "l"): StandingsDelta => ({
  entrantId, played: 1, won: r === "w" ? 1 : 0, drawn: r === "d" ? 1 : 0, lost: r === "l" ? 1 : 0,
  points: r === "w" ? 2 : r === "d" ? 1 : 0, metrics: {},
});
const beat = (winner: string, loser: string): FixtureResult => [side(winner, "w"), side(loser, "l")];

// FIDE C.07 (2026) art. 16 (rulebook-W3-swiss.md §4; W3, X-SW-7): an unplayed round is scored against a dummy at the
// player's own score, capped (16.4): 16.4.1 at a forfeit's scheduled opponent's adjusted score, 16.4.2 at draw points ×
// rounds. These cards are hand-built, each carrying the cap the ledger writes (buildSwissLedger; the forfeit categories
// reach it in W3 Task 8), so they pin the readers: Buchholz and SB score an unplayed round min(own score, cap).
describe("W2d T20 MD-1 — C.07 2026 art. 16: an unplayed game is scored against a dummy at the player's own score, capped (absolute values, W3)", () => {
  // X: R1 beat Y; R2 a game X did not play; R3 beat Z — 3 rounds. Half-points: X 6, Y 3, Z 1; V, the R2 absentee, 8.
  const SCORE = { X: 6, Y: 3, Z: 1, V: 8 } as const;
  const withRound2 = (game: SwissGame): SwissTable => [
    { entrant: "X", score: SCORE.X, games: [{ round: 1, opponent: "Y", result: "win", scored: 2 }, game, { round: 3, opponent: "Z", result: "win", scored: 2 }] },
    { entrant: "Y", score: SCORE.Y, games: [] },
    { entrant: "Z", score: SCORE.Z, games: [] },
    { entrant: "V", score: SCORE.V, games: [{ round: 2, opponent: "X", result: "loss", scored: 0, unplayed: "forfeit_loss", cap: SCORE.X }] },
  ];

  it("a FORFEIT win (16.2.2) is scored against the dummy capped at the absentee's adjusted score (16.4.1), never at the absentee's own score", () => {
    // Reading V's real score would give Y 3 + V 8 + Z 1 = 12. 16.4.1: X's own 6 capped at V's adjusted 8 is 6, so
    // 3 + 6 + 1 = 10. With V adjusted to 4 the cap binds: min(6, 4) = 4, so 3 + 4 + 1 = 8.
    const forfeit = (cap: number): SwissGame => ({ round: 2, opponent: "V", result: "win", scored: 2, unplayed: "forfeit_win", cap });
    expect(buchholz(withRound2(forfeit(SCORE.V)), "X")).toBe(10);
    expect(buchholz(withRound2(forfeit(4)), "X")).toBe(8);
  });

  it("a BYE (16.2.1) is scored against the dummy capped at draw points × rounds (16.4.2); a card with no opponent and no category, or no cap, is refused", () => {
    // 16.4.2 with draw 1 half-point × 3 rounds: min(6, 3) = 3, so Buchholz 3 + 3 + 1 = 7 and SB (a bye is a win, ×2) 14.
    const bye = withRound2({ round: 2, opponent: null, result: "win", scored: 2, unplayed: "bye", cap: 3 });
    expect(buchholz(bye, "X")).toBe(7);
    expect(sonnebornBerger(bye, "X")).toBe(14);
    // Art. 16 scores a round by its category, so a card that names neither an opponent nor a category is refused, not
    // read as a bye (the pre-W3 reading); and an unplayed round without its cap has no dummy to score.
    const malformed: Array<[SwissGame, RegExp]> = [
      [{ round: 2, opponent: null, result: "win", scored: 2 }, /no opponent and no unplayed category/],
      [{ round: 2, opponent: null, result: "win", scored: 2, unplayed: "bye" }, /no 16\.4 cap/],
    ];
    for (const [game, message] of malformed) {
      for (const read of [buchholz, sonnebornBerger]) {
        expect(() => read(withRound2(game), "X")).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
        expect(() => read(withRound2(game), "X")).toThrow(message);
      }
    }
  });
});

describe("W2d T20 MD-1 — spec 05 §4.2 direct encounter: a drawn meeting is level", () => {
  it("two who drew their game are level both ways (0), not split by the half-points each scored", () => {
    const table: SwissTable = [
      { entrant: "A", score: 1, games: [{ round: 1, opponent: "B", result: "draw", scored: 1 }] },
      { entrant: "B", score: 1, games: [{ round: 1, opponent: "A", result: "draw", scored: 1 }] },
    ];
    expect(directEncounter(table, "A", "B")).toBe(0);
    expect(directEncounter(table, "B", "A")).toBe(0);
  });
});

// A 6-player Swiss, two rounds. R1: P beat X, Q beat Y, Z beat W. R2: Z beat P, X beat Q. Half-points: Z 4; P, X, Q 2;
// Y, W 0. By hand (C.07), in half-points:
//   Buchholz  P = X 2 + Z 4 = 6; X = P 2 + Q 2 = 4; Q = Y 0 + X 2 = 2; Z = W 0 + P 2 = 2; Y = Q 2; W = Z 4.
//   Cut-1     drops the lowest: P 4; X 2; Q 2; Z 2; Y 0 (its one game); W 0.
//   SB (×4)   2 × each beaten opponent's score: P beat X → 4; X beat Q → 4; Z beat W and P → 0 + 4; Q beat Y → 0; Y, W 0.
const SWISS_FIXTURES = [
  { round: 1, result: beat("P", "X") }, { round: 1, result: beat("Q", "Y") }, { round: 1, result: beat("Z", "W") },
  { round: 2, result: beat("Z", "P") }, { round: 2, result: beat("X", "Q") },
] as const;
/** The two rounds' ledger. Its stage rounds (2) and draw (1 half-point) are read only for an unplayed round: none here. */
const swissTable = (): SwissTable => buildSwissLedger(SWISS_ENTRANTS, SWISS_FIXTURES, { rounds: 2, drawPoints: 1 });
const SWISS_ENTRANTS = ["P", "Q", "W", "X", "Y", "Z"];
const SCORES: Readonly<Record<string, number>> = { P: 2, Q: 2, W: 0, X: 2, Y: 0, Z: 4 };

describe("W2d T20 MD-1 — a Swiss table's Buchholz Cut-1, and the columns it materialises", () => {
  const table = swissTable();
  const rows = SWISS_ENTRANTS.map((id) => row(id, SCORES[id]!));

  it("premise: the ledger holds the scores the results give (the table the hand counts read)", () => {
    expect(Object.fromEntries(table.map((r) => [r.entrant, r.score]))).toEqual(SCORES);
  });

  it("buchholz_cut1 orders the 2-point class P (4) above X and Q (2 each), then Buchholz X (4) above Q (2) — in either input order", () => {
    const cascade = ["points", "buchholz_cut1", "buchholz", "sberger"] as const;
    for (const input of [rows, [...rows].reverse()]) {
      const ranked = rankStandings(input, { cascade: [...cascade], swiss: table, pointsUnit: "half" }).rows;
      expect(ids(ranked)).toEqual(["Z", "P", "X", "Q", "W", "Y"]);
      expect(ranked.find((r) => r.entrantId === "P")?.tieBreak?.key).toBe("buchholz_cut1");
      expect(ranked.find((r) => r.entrantId === "X")?.tieBreak?.key).toBe("buchholz");
    }
  });

  it("the Swiss columns the cascade uses are written in display points: Buchholz and Cut-1 ÷ 2, Sonneborn-Berger ÷ 4", () => {
    const ranked = rankStandings(rows, { cascade: ["points", "buchholz", "buchholz_cut1", "sberger", "lots"], swiss: table, pointsUnit: "half" }).rows;
    const shown = Object.fromEntries(ranked.map((r) => [r.entrantId, [r.metrics.buchholz, r.metrics.buchholz_cut1, r.metrics.sberger]]));
    expect(shown).toEqual({
      P: [3, 2, 1], X: [2, 1, 1], Q: [1, 1, 0], Z: [1, 1, 1], Y: [1, 0, 0], W: [2, 0, 0],
    });
    expect(ranked, "anti-vacuity: every row checked").toHaveLength(6);
    // the negative pair: a column the cascade does not use is not written
    const plain = rankStandings(rows, { cascade: ["points", "buchholz"], swiss: table, pointsUnit: "half" }).rows;
    expect(plain, "anti-vacuity: every row of the negative pair checked").toHaveLength(SWISS_ENTRANTS.length);
    for (const r of plain) {
      expect(Object.keys(r.metrics).sort(), r.entrantId).toEqual(["buchholz"]);
    }
  });
});

describe("W2d T20 MD-1 — buildSwissLedger: the card a result writes (SwissGame), and a bye on top of played games", () => {
  it("a loser's card reads 'loss', and a bye adds to the score the played games already hold (score = Σ scored)", () => {
    // R = 2 rounds and a draw of 1 half-point, so the bye's 16.4.2 cap is 1 × 2 = 2 (C.07 2026 art. 16, rulebook-W3 §4).
    const award: StandingsDelta = { entrantId: "A", played: 1, won: 1, drawn: 0, lost: 0, points: 2, metrics: {} };
    expect(buildSwissLedger(["A", "B"], [{ round: 1, result: beat("A", "B") }, { round: 2, award }], { rounds: 2, drawPoints: 1 })).toStrictEqual([
      {
        entrant: "A", score: 4,
        games: [
          { round: 1, opponent: "B", result: "win", scored: 2 },
          { round: 2, opponent: null, result: "win", scored: 2, unplayed: "bye", cap: 2 },
        ],
      },
      { entrant: "B", score: 0, games: [{ round: 1, opponent: "A", result: "loss", scored: 0 }] },
    ]);
  });
});

describe("W2d T20 MD-1 — ratio keys: spec 05 §4.3 (0/0 is 0, 'no data') and the ICC net run rate", () => {
  it("set_ratio: a row with sets 1-2 (0.5) ranks above a row with no sets at all (0/0 = 0)", () => {
    const [won, lost] = RATIO_LEDGERS.set_ratio;
    // Named so the residual order (seed, then id) would put the no-data row first: a level verdict reads A, B.
    // Both input orders: the sort hands the 0/0 row to the comparator as either side, so each side's 0/0 arm is reached.
    const a = row("A", 3);
    const b = row("B", 3, { [won]: 1, [lost]: 2 });
    for (const input of [[a, b], [b, a]]) {
      const ranked = rankStandings(input, { cascade: ["points", "set_ratio"] }).rows;
      expect(ids(ranked), ids(input).join(",")).toEqual(["B", "A"]);
      expect(ranked[0]?.tieBreak?.key).toBe("set_ratio");
    }
  });

  it("nrr: equal runs conceded per over, so the runs scored decide — 12.0 − 9.0 above 10.0 − 9.0 runs per over", () => {
    // A: 100 runs in 60 balls (10 overs), 90 conceded in 60 balls → NRR +1.0. B: 120 in 60 → +3.0.
    const nrr = (rf: number) => ({ runs_for: rf, balls_faced_eff: 60, runs_against: 90, balls_bowled_eff: 60 });
    const ranked = rankStandings([row("A", 2, nrr(100)), row("B", 2, nrr(120))], { cascade: ["points", "nrr"] }).rows;
    expect(ids(ranked)).toEqual(["B", "A"]);
    expect(ranked[0]?.tieBreak?.key).toBe("nrr");
  });

  it("nrr: a side yet to play (no runs, no balls: 0/0 = 0) ranks above a side that lost on net run rate, level on points (both input orders)", () => {
    // Round one, cascade points → wins → nrr (T20WC 16.10.4): A has not played; B lost, 90 off 60 balls against 120
    // off 60 → NRR 9.0 − 12.0 = −3.0, below A's 0 (spec 05 §4.3: 0/0 is 0, "no data").
    const a = row("A", 0);
    const b = row("B", 0, { runs_for: 90, balls_faced_eff: 60, runs_against: 120, balls_bowled_eff: 60 });
    for (const input of [[a, b], [b, a]]) {
      const ranked = rankStandings(input, { cascade: ["points", "wins", "nrr"] }).rows;
      expect(ids(ranked), ids(input).join(",")).toEqual(["A", "B"]);
      expect(ranked[0]?.tieBreak?.key).toBe("nrr");
    }
  });
});

describe("W2d T20 MD-1 — the guards behind the recorded equivalents (assumptions are guards)", () => {
  it("buchholz refuses a negative cut, typed: a cut drops the lowest opponents' scores, so the cut-0 branch's equivalents assume none", () => {
    const table = swissTable();
    for (const cut of [-1, -3]) {
      expect(() => buchholz(table, "P", { cut })).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID", data: { cut } }));
      expect(() => buchholz(table, "P", { cut })).toThrow(/never negative/);
    }
    // the positive pair, from the hand count above (half-points): P's Buchholz 6, Cut-1 4
    expect(buchholz(table, "P", { cut: 0 })).toBe(6);
    expect(buchholz(table, "P", { cut: 1 })).toBe(4);
    expect(buchholz(table, "P")).toBe(6);
  });

  it("rankStandings refuses a table naming an entrant twice, typed: one row per entrant is what bySeedThenId's id-tail equivalents assume", () => {
    const cascade = ["points"] as const;
    for (const rows of [[row("A", 3), row("B", 3), row("A", 1)], [row("B", 0), row("B", 0)]]) {
      const twice = rows.find((r, i) => rows.findIndex((o) => o.entrantId === r.entrantId) !== i)!.entrantId;
      expect(() => rankStandings(rows, { cascade: [...cascade] })).toThrowError(
        expect.objectContaining({ code: "CONFIG_INVALID", data: { entrantId: twice } }),
      );
      expect(() => rankStandings(rows, { cascade: [...cascade] })).toThrow(/two rows/);
    }
    // the positive pair (distinct ids rank), and the empty table, which names nobody twice
    expect(ids(rankStandings([row("A", 3), row("B", 3), row("C", 1)], { cascade: [...cascade] }).rows)).toEqual(["A", "B", "C"]);
    expect(rankStandings([], { cascade: [...cascade] }).rows).toEqual([]);
  });

  it("this runtime's sort asks the comparator only (later, earlier) and reads only whether the answer is negative — the premise of the V8-sort equivalents (counted, with a control)", () => {
    // stryker-equivalent.json records mutants that change only a comparator's NON-negative answers as the sort sees them:
    // sgn's negative arm and compareRatio's `lhs < rhs` arm (both under groupBySort's `-sgn(cmp)`), bySeedThenId's id
    // tail, and (unrecorded, its key shared) compareRecorded's `va === undefined` arm. They hold only while
    // Array.prototype.sort is V8's TimSort, which compares an element only against an EARLIER one and moves it only on a
    // negative answer. Another engine's sort (SpiderMonkey's insertion sort asks (earlier, later) and moves on > 0)
    // turns this red, and those rows must then be re-checked, never kept.
    const rng = mulberry32(0x5eed2020);
    const int = (n: number) => Math.floor(rng() * n);
    type El = { readonly k: number; readonly i: number };
    const orderOf = (els: readonly El[], cmp: (a: El, b: El) => number) => [...els].sort(cmp).map((e) => e.i).join(",");
    const byKey = (a: El, b: El) => a.k - b.k;
    let inputs = 0;
    let merged = 0; // inputs long enough that TimSort merges runs (and gallops), not only binary insertion
    let calls = 0;
    let askedEarlierFirst = 0;
    let signOnlyChecks = 0;
    let signOnlyDiffer = 0;
    let controlDiffer = 0;
    for (let trial = 0; trial < 3000; trial++) {
      const n = trial % 5 === 0 ? 64 + int(237) : 2 + int(40);
      const keys = Array.from({ length: n }, () => int(6));
      // every third input is built of presorted runs, so merges meet long runs and gallop
      if (trial % 3 === 0) {
        for (let from = 0; from < n; from += 8 + int(40)) {
          const run = keys.slice(from, from + 8 + int(40)).sort((x, y) => x - y);
          keys.splice(from, run.length, ...run);
        }
      }
      const els: El[] = keys.map((k, i) => ({ k, i }));
      inputs++;
      if (n >= 64) merged++;
      [...els].sort((a, b) => {
        calls++;
        if (a.i < b.i) askedEarlierFirst++;
        return byKey(a, b);
      });
      const want = orderOf(els, byKey);
      // a positive answer read as 0, and a 0 read as positive: neither moves anything
      for (const signOnly of [(a: El, b: El) => (byKey(a, b) < 0 ? -1 : 0), (a: El, b: El) => (byKey(a, b) < 0 ? -1 : 1)]) {
        signOnlyChecks++;
        if (orderOf(els, signOnly) !== want) signOnlyDiffer++;
      }
      // the control: a comparator that answers negative where the true one answers 0 DOES move elements
      if (orderOf(els, (a, b) => (byKey(a, b) <= 0 ? -1 : 1)) !== want) controlDiffer++;
    }
    expect(askedEarlierFirst, "the comparator is never asked (earlier, later)").toBe(0);
    expect(signOnlyDiffer, "only the negative answers move elements").toBe(0);
    expect(inputs, "anti-vacuity: inputs sorted").toBe(3000);
    expect(merged, "anti-vacuity: inputs long enough to merge runs").toBeGreaterThanOrEqual(500);
    expect(calls, "anti-vacuity: comparator calls checked").toBeGreaterThan(100_000);
    expect(signOnlyChecks).toBe(2 * inputs);
    expect(controlDiffer, "the control: a comparator wrong on a negative answer is seen").toBeGreaterThan(inputs / 2);
  });

  it("no sport declares a metric keyed 'undefined' — metricOf's `key === undefined` arm (its stryker-equivalent.json row) reads the same as row.metrics[undefined] only while none does (every sport, counted)", () => {
    let metrics = 0;
    const visited = forEachSport(({ module }) => {
      for (const metric of module.metrics) {
        metrics++;
        expect(metric.key, module.key).not.toBe("undefined");
      }
    });
    expect(visited).toBe(builtinModules.length);
    expect(metrics, "anti-vacuity: metrics checked").toBeGreaterThan(builtinModules.length);
  });
});
