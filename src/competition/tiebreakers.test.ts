// Swiss tiebreak goldens — spec 05 §4 / chess.md §4, PROMPT-07 §5.
//
// Golden cross-table: a 6-player single round-robin (5 rounds, everyone meets
// everyone once) with a strict hierarchy A > B > C > D > E > F. A round-robin
// makes every tiebreak hand-verifiable: each player's opponents are ALL other
// players, so Buchholz = (Σ all scores) − own score, and Sonneborn-Berger is the
// sum of beaten opponents' scores. The golden's values are exact integers (half-points; SB in quarter-points). An
// art. 16 dummy can be x.5 (½ x win points), still exact: multiples of ½ add exactly in IEEE-754 (PROMPT-07).
import { describe, expect, it } from "vitest";
import type { StandingsDelta } from "../core/types.ts";
import type { FixtureResult } from "./standings.ts";
import {
  buchholz,
  buchholzCut1,
  buildSwissLedger,
  colorHistory,
  directEncounter,
  sonnebornBerger,
  swissTiebreaks,
  wins,
  type SwissGame,
  type SwissRow,
  type SwissTable,
} from "./tiebreakers.ts";

// win = 2 half-points, loss = 0. Colours cycle W,B,… per player's card.
function card(entrant: string, results: Array<[opp: string, won: boolean]>): SwissRow {
  const games: SwissGame[] = results.map(([opp, won], i) => ({
    round: i + 1,
    opponent: opp,
    result: won ? "win" : "loss",
    scored: won ? 2 : 0,
    color: (i % 2 === 0 ? "W" : "B"),
  }));
  return { entrant, score: games.reduce((s, g) => s + g.scored, 0), games };
}

// A beats everyone; B beats all but A; … F loses all.
const table: SwissTable = [
  card("A", [["B", true], ["C", true], ["D", true], ["E", true], ["F", true]]),
  card("B", [["A", false], ["C", true], ["D", true], ["E", true], ["F", true]]),
  card("C", [["A", false], ["B", false], ["D", true], ["E", true], ["F", true]]),
  card("D", [["A", false], ["B", false], ["C", false], ["E", true], ["F", true]]),
  card("E", [["A", false], ["B", false], ["C", false], ["D", false], ["F", true]]),
  card("F", [["A", false], ["B", false], ["C", false], ["D", false], ["E", false]]),
];

describe("Swiss cross-table golden (6-player round-robin)", () => {
  it("reproduces the published score column (half-points)", () => {
    const scores = Object.fromEntries(table.map((r) => [r.entrant, r.score]));
    expect(scores).toEqual({ A: 10, B: 8, C: 6, D: 4, E: 2, F: 0 });
  });

  it("Buchholz = Σ all − own (each plays the whole field)", () => {
    // Total = 30 half-points; Buchholz(X) = 30 − score(X).
    expect(buchholz(table, "A")).toBe(20);
    expect(buchholz(table, "B")).toBe(22);
    expect(buchholz(table, "C")).toBe(24);
    expect(buchholz(table, "D")).toBe(26);
    expect(buchholz(table, "E")).toBe(28);
    expect(buchholz(table, "F")).toBe(30);
  });

  it("Buchholz Cut-1 drops each player's lowest opponent", () => {
    // Everyone's weakest opponent is F (0) — except F, whose weakest is E (2).
    expect(buchholzCut1(table, "A")).toBe(20);
    expect(buchholzCut1(table, "B")).toBe(22);
    expect(buchholzCut1(table, "C")).toBe(24);
    expect(buchholzCut1(table, "D")).toBe(26);
    expect(buchholzCut1(table, "E")).toBe(28);
    expect(buchholzCut1(table, "F")).toBe(28); // 30 − 2
  });

  it("Sonneborn-Berger = Σ beaten opponents' scores (quarter-points)", () => {
    // SB_q = Σ scored·oppScore. A beat {8,6,4,2,0}: 2·20 = 40; F beat none: 0.
    expect(sonnebornBerger(table, "A")).toBe(40);
    expect(sonnebornBerger(table, "B")).toBe(24);
    expect(sonnebornBerger(table, "C")).toBe(12);
    expect(sonnebornBerger(table, "D")).toBe(4);
    expect(sonnebornBerger(table, "E")).toBe(0);
    expect(sonnebornBerger(table, "F")).toBe(0);
  });

  it("counts wins and reads colour history off the card", () => {
    expect(wins(table, "A")).toBe(5);
    expect(wins(table, "E")).toBe(1);
    expect(wins(table, "F")).toBe(0);
    expect(colorHistory(table[0] as SwissRow)).toBe("WBWBW");
  });

  it("resolves direct encounters head-to-head", () => {
    expect(directEncounter(table, "A", "F")).toBe(1);
    expect(directEncounter(table, "F", "A")).toBe(-1);
    expect(directEncounter(table, "C", "D")).toBe(1);
  });

  it("bundles every tiebreak as exact integers (no floats in the ledger)", () => {
    for (const row of table) {
      const tb = swissTiebreaks(table, row.entrant);
      for (const value of [tb.score, tb.buchholz, tb.buchholzCut1, tb.sonnebornBerger, tb.wins]) {
        expect(Number.isInteger(value)).toBe(true);
      }
    }
    expect(swissTiebreaks(table, "C")).toMatchObject({
      score: 6,
      buchholzCut1: 24,
      buchholz: 24,
      sonnebornBerger: 12,
      wins: 3,
      colorHistory: "WBWBW",
    });
  });
});

describe("C.07 2026 art. 16: an own unplayed round is scored against a dummy at the player's own score, capped (rulebook-W3 §4)", () => {
  // Half-points (win 2, draw 1, loss 0), R = 3 rounds, so D = 1 and the dummy cap is D × R = 3 (16.4.2).
  // X: R1 beat Y, R2 a pairing-allocated bye (16.2.1, the win: X-SW-5), R3 beat Z. The others: R2 Y drew Z, R3 Y beat V.
  // Scores: X 2+2+2 = 6, Y 0+1+2 = 3, Z 1+0 = 1, V 0. No 16.2.5 round, so every adjusted score is the score (16.3).
  // X's bye scores a dummy at X's own 6, capped at 3: min(6, 3) = 3. (The superseded A6 virtual opponent of the old
  // engine gave the score before the round plus ½ a point per round to the end: 2 + (3 − 1) = 4.)
  const side = (entrantId: string, r: "w" | "d" | "l"): StandingsDelta => ({
    entrantId, played: 1, won: r === "w" ? 1 : 0, drawn: r === "d" ? 1 : 0, lost: r === "l" ? 1 : 0, points: r === "w" ? 2 : r === "d" ? 1 : 0, metrics: {},
  });
  const game = (home: string, away: string, r: "h" | "d"): FixtureResult => (r === "h" ? [side(home, "w"), side(away, "l")] : [side(home, "d"), side(away, "d")]);
  const ledger: SwissTable = buildSwissLedger(
    ["X", "Y", "Z", "V"],
    [
      { round: 1, result: game("X", "Y", "h") },
      { round: 2, award: { ...side("X", "w"), played: 1 } },
      { round: 2, result: game("Y", "Z", "d") },
      { round: 3, result: game("X", "Z", "h") },
      { round: 3, result: game("Y", "V", "h") },
    ],
    { rounds: 3, drawPoints: 1 },
  );

  it("scores the bye round against min(own score, draw points × rounds)", () => {
    expect(ledger.map((r) => [r.entrant, r.score])).toEqual([["X", 6], ["Y", 3], ["Z", 1], ["V", 0]]);
    // Buchholz = Y 3 + dummy 3 + Z 1 = 7 (A6: 8).
    expect(buchholz(ledger, "X")).toBe(7);
    // Cut-1 drops the lowest contribution (Z 1) → 3 + 3 = 6 (A6: 7).
    expect(buchholzCut1(ledger, "X")).toBe(6);
    // SB counts the bye as a win against the same dummy, each win weighted 2: 2·(3 + 3 + 1) = 14 (A6: 16).
    expect(sonnebornBerger(ledger, "X")).toBe(14);
  });
});
