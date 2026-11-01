// W3 Task 7: the Swiss ledger by round (SW-M1, SW-L2, late entry; RB3-6 part 1). X-SW-7's own unplayed rounds, and
// X-SW-8. W3 Task 8 (SW-L1; RB3-6 part 2): forfeits and double walkovers, withdrawals, and Cut-1 (the X-SW-7 block at
// the end). This is FIDE C.07 (2026) art. 16 as rulebook-W3-swiss.md §4 adopts it, scaled to the stage's table points:
//   - 16.2 names an unplayed round's category:
//     - 16.2.1 is a pairing-allocated bye.
//     - 16.2.3 is a zero-point round followed by at least one round that is not a VUR (a VUR is a requested bye or a
//       forfeit loss).
//     - 16.2.5 is one followed only by VURs, or in the last round.
//     - A late entrant's missed rounds are zero-point rounds (FIDE C.04.2 2.4; ruling 251).
//   - 16.3: as somebody else's opponent, categories 1-4 count at their real result, and 16.2.5 counts as a draw. That is
//     the ADJUSTED score: own score + D for each 16.2.5 round.
//   - 16.4.2: the entrant's OWN unplayed round is scored against a dummy at its own score, capped at D x R.
//   - 16.2.2 / 16.2.4 and 16.4.1: a forfeit win or loss (nothing played; a double walkover is a forfeit loss for both
//     sides, rulebook §4 M2) is unplayed too, its dummy capped at the SCHEDULED opponent's adjusted score. A forfeit is
//     not a meeting (P-A2): direct encounter never reads it.
//   - 16.1 / 16.5: a VUR is a zero-point round (an absence, a round after a withdrawal) or a forfeit loss. Buchholz Cut-1
//     on an entrant with a VUR cuts its lowest VUR contribution; otherwise the lowest contribution.
//   - D is the table's draw points where a draw can stand in the stage, else half the win points (rulebook §4
//     "Non-chess scaling"; C.07 7.7; ruling R4: a draw the rule declares but no Swiss stage of the sport can reach is no
//     draw). Under a set-score rule the win points are the clean sweep's (design §5). R is the stage's rounds, never the
//     length of the entrant's card.
//   - Sonneborn-Berger weighs each round's contribution win 2 / draw 1 / loss 0; a bye is a win (rulebook §4).
//   - Buchholz and SB are shown in the table's own points (SW-L2): half-points are halved only on a half-point table.
// Every expected number is derived by hand from those rules in the comment beside its test, never from the engine. Each
// `differential:` is what the pre-W3 engine gave (the superseded A6 virtual opponent: the player's score before the
// round + half a point per round to the end, with byes appended after every result and "rounds" = the card's length).
// Everything runs through the real consumer, completeTableStage, on hand-built TableFixtures.
// W3 Task 10 (X-SW-9; T8 review m2 ruling): the Swiss default chains rank a real stage (Buchholz early, head-to-head late),
// and a head-to-head step on a Swiss stage reads played games only: a forfeit is never a meeting, as `direct` already reads
// it (the X-SW-9 block at the end, with its league control).
import { describe, expect, it } from "vitest";
import { AWARD_REASONS, MatchOutcome, OUTCOME_KINDS, type EntrantId, type StandingsDelta } from "../core/types.ts";
import type { AnySportModule, TiebreakerKey } from "../sport/module.ts";
import { boardgame } from "../sports/boardgame/index.ts"; // single-sport: S1–S4 are the rulebook's chess cases (C.07 is FIDE's); the every-sport test sweeps the registry
import { builtinModules } from "../sports/index.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { tableRulesOf } from "../testkit/helpers.ts";
import { decidedInFor } from "./decided-in.ts";
import { PointsRule, payout, setsToWinOf, swissDrawFactsOf, swissDrawPoints, unplayedSidesOf, type SwissDrawFacts } from "./points.ts";
import { completeTableStage, type TableFixture, type TableStage } from "./stage.ts";
import type { FixtureResult, StandingsRow } from "./standings.ts";
import { resolveTableRules } from "./table-rules.ts";
import { buchholz, buildSwissLedger, directEncounter, rankStandings, type SwissTable } from "./tiebreakers.ts";

/** Every Swiss column the ledger feeds, so each is materialised on every row. */
const CASCADE: TiebreakerKey[] = ["points", "buchholz_cut1", "buchholz", "sberger", "lots"];

/** FIDE's 1 / ½ / 0 in boardgame's half-points (chess.md §2): the sport's own declared Swiss rule, pinned in a test below. */
const CHESS = boardgame.tablePointsRule(boardgame.configSchema.parse({}), "swiss");
/** Boardgame's Swiss draw facts under its default cfg, from its own declarations (pinned in the premise test below). */
const CHESS_DRAW = swissDrawFactsOf(boardgame, {});
/** S5's custom stage rule: win 3, loss 0 and no draw, in whole points. */
const NO_DRAW = PointsRule.parse({ win: { regulation: 3 }, loss: { regulation: 0 }, shootoutAs: "result", unit: "whole", bonuses: [] });
/** S5's sport: one where no draw stands and no set score is kept. */
const NO_DRAW_FACTS: SwissDrawFacts = { drawReachable: false, setsToWin: undefined };

type Side = "w" | "d" | "l";
/** One side of a decided game, paid by `rule`: a win `win.regulation`, a draw `draw`, a loss `loss.regulation`. */
function sideOf(entrantId: EntrantId, side: Side, rule: PointsRule): StandingsDelta {
  if (side === "d" && rule.draw === undefined) throw new Error("a drawn game under a rule that prices no draw");
  const points = side === "w" ? rule.win.regulation : side === "d" ? (rule.draw as number) : rule.loss.regulation;
  return { entrantId, played: 1, won: side === "w" ? 1 : 0, drawn: side === "d" ? 1 : 0, lost: side === "l" ? 1 : 0, points, metrics: {} };
}
/** A decided board in `round`: "h" the home side won, "a" the away side, "d" a draw. */
function board(rule: PointsRule, round: number, home: EntrantId, away: EntrantId, r: "h" | "a" | "d"): TableFixture {
  const [h, a]: [Side, Side] = r === "h" ? ["w", "l"] : r === "a" ? ["l", "w"] : ["d", "d"];
  return { id: `r${round}-${home}-${away}`, roundNo: round, status: "decided", result: [sideOf(home, h, rule), sideOf(away, a, rule)] };
}
/** A pairing-allocated bye as the app writes it: a walkover holding a one-sided award of the win (X-SW-5). */
function bye(rule: PointsRule, round: number, entrantId: EntrantId): TableFixture {
  return {
    id: `r${round}-bye-${entrantId}`, roundNo: round, status: "walkover",
    awardDelta: { entrantId, played: 1, won: 1, drawn: 0, lost: 0, points: rule.win.regulation, metrics: {} },
  };
}

interface Scene {
  readonly rule: PointsRule;
  readonly entrants: readonly EntrantId[];
  readonly rounds: number | undefined;
  readonly fixtures: readonly TableFixture[];
  readonly absent?: ReadonlyMap<EntrantId, readonly number[]>;
  /** The sport's Swiss draw facts (`TableStage.swissDraw`); undefined = not passed. */
  readonly draw: SwissDrawFacts | undefined;
  /** The stage's tie-break order; absent = CASCADE. */
  readonly cascade?: readonly TiebreakerKey[];
}
function stageOf(s: Scene): TableStage {
  const stage = {
    id: "sw", kind: "swiss", swiss: true, entrants: s.entrants, rules: tableRulesOf(s.cascade ?? CASCADE, s.rule), rngSeed: 7,
    ...(s.rounds === undefined ? {} : { rounds: s.rounds }),
    ...(s.absent === undefined ? {} : { swissAbsentRounds: s.absent }),
    ...(s.draw === undefined ? {} : { swissDraw: s.draw }),
  } as const;
  // A Swiss ledger stage with no draw facts is a type error for every caller (N1); a scene builds one only to prove the
  // run-time refusal behind the type.
  return stage as TableStage;
}
function tableOf(s: Scene): readonly StandingsRow[] {
  const rows = completeTableStage(stageOf(s), s.fixtures).tables.overall;
  if (rows === undefined) throw new Error("a one-pool stage has an overall table");
  return rows;
}
function rowsOf(s: Scene): Map<EntrantId, StandingsRow> {
  const rows = tableOf(s);
  expect(rows, "anti-vacuity: one row per entrant").toHaveLength(s.entrants.length);
  return new Map(rows.map((r) => [r.entrantId, r]));
}
function metricOf(rows: ReadonlyMap<EntrantId, StandingsRow>, id: EntrantId, key: string): number {
  const value = rows.get(id)?.metrics[key];
  if (value === undefined) throw new Error(`${id} has no ${key} column`);
  return value;
}
/** Each entrant's Buchholz column, in the scene's entrant order. */
const column = (s: Scene, key: string): Record<EntrantId, number> => {
  const rows = rowsOf(s);
  return Object.fromEntries(s.entrants.map((id) => [id, metricOf(rows, id, key)]));
};
const LEDGER_OPTS = { rounds: 3, drawPoints: 1 } as const;

// S1: boardgame half-points (win 2, draw 1, loss 0), R = 3, so D = 1 and the dummy cap is D x R = 3 (16.4.2).
//   R1: A beats B, C draws D, E bye.   R2: A beats E, B beats D, C bye.   R3: A draws D, C beats E, B bye.
//   Scores (a bye pays the win, 2: X-SW-5, FIDE C.04.1 r.3): A 2+2+1 = 5, B 0+2+2 = 4, C 1+2+2 = 5, D 1+0+1 = 2,
//   E 2+0+0 = 2. Nobody is absent, so every adjusted score is the score (16.3.1: a bye counts at its awarded result).
//   Buchholz (half-points), each own bye scored min(own score, 3):
//     A = B 4 + E 2 + D 2 = 8.           B = A 5 + D 2 + bye min(4, 3) 3 = 10.   C = D 2 + bye min(5, 3) 3 + E 2 = 7.
//     D = C 5 + B 4 + A 5 = 14.          E = bye min(2, 3) 2 + A 5 + C 5 = 12.
//   Cut-1 drops each card's lowest: A 8-2 = 6, B 10-2 = 8, C 7-2 = 5, D 14-4 = 10, E 12-2 = 10.
//   Sonneborn-Berger (quarter-points, weight x contribution): A = 2·4 + 2·2 + 1·2 = 14; B = 0 + 2·2 + 2·3 = 10;
//     C = 1·2 + 2·3 + 2·2 = 12; D = 1·5 + 0 + 1·5 = 10; E = 2·2 + 0 + 0 = 4.
//   Shown on a half-point table: Buchholz and Cut-1 ÷ 2, SB ÷ 4.
const S1: Scene = {
  rule: CHESS, draw: CHESS_DRAW, entrants: ["A", "B", "C", "D", "E"], rounds: 3,
  fixtures: [
    board(CHESS, 1, "A", "B", "h"), board(CHESS, 1, "C", "D", "d"), bye(CHESS, 1, "E"),
    board(CHESS, 2, "A", "E", "h"), board(CHESS, 2, "B", "D", "h"), bye(CHESS, 2, "C"),
    board(CHESS, 3, "A", "D", "d"), board(CHESS, 3, "C", "E", "h"), bye(CHESS, 3, "B"),
  ],
};

// S4: late entry; boardgame half-points, R = 3, D = 1, cap 3. L is declared absent in round 1 (FIDE C.04.2 2.4: a late
// entry scores 0 for each missed round; ruling 251).
//   R1: A beats B, C bye (L absent).   R2: A beats C, L beats B.   R3: L beats A, B draws C.
//   Scores: A 2+2+0 = 4, B 0+0+1 = 1, C 2+0+1 = 3, L 0+2+2 = 4.
//   Play follows L's round 1, so it is 16.2.3, not 16.2.5. Opponents read L at its real 4 (16.3.1), and L's own dummy is
//   min(4, 3) = 3 (16.4.2).
//   Buchholz: L = 3 + B 1 + A 4 = 8. B = A 4 + L 4 + C 3 = 11 (misread as 16.2.5, L is adjusted to 4 + 1 = 5, giving 12).
//     A = B 1 + C 3 + L 4 = 8. C = bye min(3, 3) 3 + A 4 + B 1 = 8.
const S4: Scene = {
  rule: CHESS, draw: CHESS_DRAW, entrants: ["A", "B", "C", "L"], rounds: 3, absent: new Map([["L", [1]]]),
  fixtures: [
    board(CHESS, 1, "A", "B", "h"), bye(CHESS, 1, "C"),
    board(CHESS, 2, "A", "C", "h"), board(CHESS, 2, "L", "B", "h"),
    board(CHESS, 3, "L", "A", "h"), board(CHESS, 3, "B", "C", "d"),
  ],
};

// S5: scaling with no draw. Whole points, the stage rule win 3 / loss 0 and no draw, so D = ½ x 3 = 1.5 (rulebook §4:
// "for a sport with no draw, the cap uses ½ x win points x rounds"); R = 3, cap 4.5.
//   R1: X beats Y, Z bye.   R2: X beats Z, Y bye.   R3: Y beats Z, X bye.   Scores: X 9, Y 0+3+3 = 6, Z 3+0+0 = 3.
//   Buchholz: X = Y 6 + Z 3 + bye min(9, 4.5) 4.5 = 13.5. Y = X 9 + bye min(6, 4.5) 4.5 + Z 3 = 16.5.
//     Z = bye min(3, 4.5) 3 + X 9 + Y 6 = 18.
//   SB in table points (a win counts the opponent's whole contribution, a draw half): X = 6 + 3 + 4.5 = 13.5.
//   Shown on a whole-point table: unhalved (multiples of ½ are exact in IEEE-754, Review Focus 4).
const S5: Scene = {
  rule: NO_DRAW, draw: NO_DRAW_FACTS, entrants: ["X", "Y", "Z"], rounds: 3,
  fixtures: [
    board(NO_DRAW, 1, "X", "Y", "h"), bye(NO_DRAW, 1, "Z"),
    board(NO_DRAW, 2, "X", "Z", "h"), bye(NO_DRAW, 2, "Y"),
    board(NO_DRAW, 3, "Y", "Z", "h"), bye(NO_DRAW, 3, "X"),
  ],
};

/** The fixture with no round number. */
function withoutRound(f: TableFixture): TableFixture {
  const { roundNo: _roundNo, ...rest } = f;
  return rest;
}
/** The ledger fixtures a stage's counted fixtures map to (stage.ts does the same, with its guards): a decided or walked-over
 *  fixture's round, result, award and unplayed side(s). */
function ledgerFixtures(s: Scene) {
  return s.fixtures
    .filter((f) => f.status === "decided" || f.status === "walkover")
    .map((f) => ({
      round: f.roundNo!,
      ...(f.result ? { result: f.result } : {}),
      ...(f.awardDelta ? { award: f.awardDelta } : {}),
      ...(f.unplayed ? { unplayed: f.unplayed } : {}),
    }));
}

/** A thrown EngineError's code and message, or null when the call returns. */
function refusal(f: () => unknown): { code: string; message: string } | null {
  try {
    f();
  } catch (e) {
    const err = e as { code?: unknown; message?: unknown };
    return { code: String(err.code), message: String(err.message) };
  }
  return null;
}

describe("X-SW-8 the Swiss ledger by round: FIDE C.07 (2026) art. 16 (rulebook-W3 §4)", () => {
  it("X-SW-8 empty case first: a Swiss stage with no counted fixture has empty cards and no dummy (X-TB-6)", () => {
    // The ledger itself: no counted fixture and no absence is an empty card for every entrant, score 0, nothing adjusted.
    expect(buildSwissLedger(["A", "B", "C"], [], LEDGER_OPTS)).toStrictEqual([
      { entrant: "A", score: 0, games: [] },
      { entrant: "B", score: 0, games: [] },
      { entrant: "C", score: 0, games: [] },
    ]);
    // Through the stage: nothing counted (no fixture at all, then only boards still to play), so every column is 0 (no
    // card, no dummy) and every row is level, an empty table (X-TB-6).
    let checked = 0;
    const pending = S1.fixtures.filter((f) => f.result !== undefined).map((f): TableFixture => ({ id: f.id, roundNo: f.roundNo!, status: "scheduled" }));
    for (const fixtures of [[], pending]) {
      const rows = tableOf({ ...S1, fixtures });
      expect(rows).toHaveLength(S1.entrants.length);
      for (const row of rows) {
        expect([row.metrics.buchholz, row.metrics.buchholz_cut1, row.metrics.sberger, row.level], row.entrantId).toEqual([0, 0, 0, true]);
        checked++;
      }
    }
    expect(checked).toBe(2 * S1.entrants.length);
  });

  it("X-SW-8 premise: boardgame's declared Swiss rule is FIDE's 1 / ½ / 0 in half-points (the scale S1 and S4 are derived in)", () => {
    expect([CHESS.win.regulation, CHESS.draw, CHESS.loss.regulation, CHESS.unit]).toEqual([2, 1, 0, "half"]);
    // and a game of chess may be drawn in a Swiss (FIDE), with no set score: D is the declared draw, 1 half-point
    expect(CHESS_DRAW).toEqual({ drawReachable: true, setsToWin: undefined });
  });

  it("X-SW-7 own bye = dummy at own score capped at draw×rounds: E (bye in round 1) Buchholz 2+5+5 = 12 half-points (16.4.2)", () => {
    const rows = rowsOf(S1);
    const bh = (id: EntrantId) => metricOf(rows, id, "buchholz");
    expect(bh("E")).toBe(12 / 2); // display points; differential: today 11/2 (A6 virtual opponent, award appended after results)
    // The card in round order: the round-1 bye is E's first card, a 16.2.1 bye capped at D x R = 3, not appended last.
    const ledger = buildSwissLedger(S1.entrants, ledgerFixtures(S1), LEDGER_OPTS);
    expect(ledger.find((r) => r.entrant === "E")).toStrictEqual({
      entrant: "E", score: 2,
      games: [
        { round: 1, opponent: null, result: "win", scored: 2, unplayed: "bye", cap: 3 },
        { round: 2, opponent: "A", result: "loss", scored: 0 },
        { round: 3, opponent: "C", result: "loss", scored: 0 },
      ],
    });
  });

  it("X-SW-7 the cap binds: C (score 5) gets min(5, 3) = 3 for its round-2 bye → 2+3+2 = 7", () => {
    const rows = rowsOf(S1);
    expect(metricOf(rows, "C", "buchholz")).toBe(7 / 2); // differential: today 8/2
  });

  it("X-SW-7 the whole S1 table: Buchholz, Cut-1 and Sonneborn-Berger, each bye a win against its capped dummy", () => {
    expect(column(S1, "buchholz")).toEqual({ A: 8 / 2, B: 10 / 2, C: 7 / 2, D: 14 / 2, E: 12 / 2 });
    expect(column(S1, "buchholz_cut1")).toEqual({ A: 6 / 2, B: 8 / 2, C: 5 / 2, D: 10 / 2, E: 10 / 2 });
    expect(column(S1, "sberger")).toEqual({ A: 14 / 4, B: 10 / 4, C: 12 / 4, D: 10 / 4, E: 4 / 4 });
    // The scores the hand count read: a bye pays the win (X-SW-5).
    const rows = rowsOf(S1);
    expect(Object.fromEntries(S1.entrants.map((id) => [id, rows.get(id)?.points]))).toEqual({ A: 5, B: 4, C: 5, D: 2, E: 2 });
  });

  it("X-SW-8 a late entrant's missed round scores 0 and records no score: L has points 4, played 2, no round-1 row", () => {
    const rows = rowsOf(S4);
    const l = rows.get("L");
    expect(l && [l.points, l.played, l.won, l.drawn, l.lost]).toEqual([4, 2, 2, 0, 0]);
    // The folded row (the W/D/L, the points and every ledger column but the Swiss tie-breaks) is that of the same stage
    // with no absence declared: the absence writes nothing to the table. Its rank may move, as its Buchholz does.
    const strip = (r: StandingsRow | undefined) =>
      r && {
        fold: [r.played, r.won, r.drawn, r.lost, r.points],
        metrics: Object.fromEntries(Object.entries(r.metrics).filter(([k]) => !CASCADE.includes(k as TiebreakerKey))),
      };
    const { absent: _absent, ...undeclared } = S4;
    const bare = new Map(tableOf(undeclared).map((r) => [r.entrantId, r]));
    expect(strip(l)).toEqual(strip(bare.get("L")));
    // On the card, round 1 is a zero-point unplayed round, never a played game against anybody.
    const ledger = buildSwissLedger(S4.entrants, ledgerFixtures(S4), { ...LEDGER_OPTS, absent: S4.absent! });
    expect(ledger.find((r) => r.entrant === "L")).toStrictEqual({
      entrant: "L", score: 4,
      games: [
        { round: 1, opponent: null, result: "loss", scored: 0, unplayed: "absent", cap: 3 },
        { round: 2, opponent: "B", result: "win", scored: 2 },
        { round: 3, opponent: "A", result: "win", scored: 2 },
      ],
    });
  });

  it("X-SW-8 a missed round followed by play is 16.2.3: L's own dummy min(4, 3) = 3 → Buchholz 3+1+4 = 8", () => {
    expect(metricOf(rowsOf(S4), "L", "buchholz")).toBe(8 / 2); // differential: today 5/2 (no card for the missed round)
  });

  it("X-SW-8 …and opponents read L at its real 4, not as a draw: B's Buchholz 4+4+3 = 11 (16.3.1; 12 if misread as 16.2.5)", () => {
    expect(column(S4, "buchholz")).toEqual({ A: 8 / 2, B: 11 / 2, C: 8 / 2, L: 8 / 2 });
  });

  it("X-SW-8 a missed LAST round is 16.2.5: opponents read it as a draw (16.3.2), the entrant's own dummy is still min(own, 3)", () => {
    // S4 with L also absent in round 3, so round 3 is B draws C and A takes the bye. Then:
    //   Scores: A 2+2+2 = 6, B 0+0+1 = 1, C 2+0+1 = 3, L 0+2+0 = 2. A played round 2 follows L's round 1, so that one
    //   stays 16.2.3. L's round 3 is the last round, so it is 16.2.5, and L's adjusted score is 2 + D 1 = 3.
    //   L = dummy min(2, 3) 2 + B 1 + dummy 2 = 5. B = A 6 + L adjusted 3 + C 3 = 12 (read at the real 2: 11).
    //   A = B 1 + C 3 + bye min(6, 3) 3 = 7. C = bye min(3, 3) 3 + A 6 + B 1 = 10.
    const lastAbsent: Scene = {
      ...S4, absent: new Map([["L", [1, 3]]]),
      fixtures: [...S4.fixtures.filter((f) => f.id !== "r3-L-A"), bye(CHESS, 3, "A")],
    };
    expect(lastAbsent.fixtures).toHaveLength(S4.fixtures.length);
    expect(column(lastAbsent, "buchholz")).toEqual({ A: 7 / 2, B: 12 / 2, C: 10 / 2, L: 5 / 2 });
  });

  it("X-SW-8 two missed rounds, then play: BOTH are 16.2.3 (any later played card, not the next one, decides), so A reads L at its real 2", () => {
    // The commonest late entry: L joins in round 3 of 3 (absent [1, 2]). Boardgame half-points, D = 1, cap 3.
    //   R1: A beats B, C bye.   R2: A beats C, B bye.   R3: L beats A, B draws C.
    //   Scores: A 2+2+0 = 4, B 0+2+1 = 3, C 2+0+1 = 3, L 0+0+2 = 2.
    //   Each of L's missed rounds is followed by a played card (round 3), so both are 16.2.3 (round 1's NEXT card is the
    //   round-2 absence, a VUR, but a later card is not): nothing is 16.2.5, and L's adjusted score is its real 2.
    //   A = B 3 + C 3 + L 2 = 8 (9 if round 1 were 16.2.5, L adjusted 3; 10 if both were).
    //   B = A 4 + bye min(3, 3) 3 + C 3 = 10.   C = bye min(3, 3) 3 + A 4 + B 3 = 10.   L = dummy min(2, 3) 2 + 2 + A 4 = 8.
    const lateTwo: Scene = {
      rule: CHESS, draw: CHESS_DRAW, entrants: ["A", "B", "C", "L"], rounds: 3, absent: new Map([["L", [1, 2]]]),
      fixtures: [
        board(CHESS, 1, "A", "B", "h"), bye(CHESS, 1, "C"),
        board(CHESS, 2, "A", "C", "h"), bye(CHESS, 2, "B"),
        board(CHESS, 3, "L", "A", "h"), board(CHESS, 3, "B", "C", "d"),
      ],
    };
    expect(column(lateTwo, "buchholz")).toEqual({ A: 8 / 2, B: 10 / 2, C: 10 / 2, L: 8 / 2 });
    expect(Object.fromEntries([...rowsOf(lateTwo)].map(([id, r]) => [id, r.points]))).toEqual({ A: 4, B: 3, C: 3, L: 2 });
  });

  it("X-SW-7 non-chess scale: X's dummy is min(9, 1.5×3) = 4.5 → Buchholz 6+3+4.5 = 13.5, displayed unhalved (SW-L2)", () => {
    const rows = rowsOf(S5);
    const bh = (id: EntrantId) => metricOf(rows, id, "buchholz");
    expect(bh("X")).toBe(13.5); // differential: today (6+3+7)/2 = 8
    expect(column(S5, "buchholz")).toEqual({ X: 13.5, Y: 16.5, Z: 18 });
    // SB in table points: 13.5 (today 2·(6+3+7)/4 = 8).
    expect(metricOf(rows, "X", "sberger")).toBe(13.5);
  });

  it("X-SW-7 every sport: a bye dummy is min(own, D×R) with D from the declared rule (its draw where a draw stands, R4; else ½ win) (counted)", () => {
    // Per sport and declared cfg, S5's shape in that sport's own Swiss points, each bye built as the app's one producer
    // builds it (`awardByeDelta`: the typed bye, the module's standingsDelta, the stage rule's payout), and the stage's
    // draw facts as the app passes them (`swissDrawFactsOf`). Expected, by hand from rulebook §4 and ruling R4: D = the
    // rule's draw where a draw can stand in this sport's Swiss stage, read off the sport's OWN declarations
    // (`reachableResultKinds` / `supportsDraws`), else ½ x the win points (a set-score map's clean-sweep pair, design §5,
    // with the sets a match is won on read off its bestOf); R = 3. X = win + win + bye, Y = loss + bye + win,
    // Z = bye + loss + loss. Nobody is absent, so adjusted = score, and
    //   Buchholz X = Y + Z + min(X, 3D), Y = X + min(Y, 3D) + Z, Z = min(Z, 3D) + X + Y,
    // shown ÷ 2 on a half-point table and unhalved otherwise.
    let checked = 0;
    let capBound = 0; // the cap is below the entrant's score, so the min takes the cap
    let ownBound = 0; // the entrant's own score is the min
    let drawD = 0; // cfgs whose D is the draw (a draw stands)
    let halfWinD = 0; // cfgs whose D is ½ x win (no draw stands)
    let declaredUnreachable = 0; // cfgs whose rule declares a draw no Swiss stage of the sport reaches (R4's case)
    const perSport = new Map<string, number>();
    const sports = forEachSport(({ module: m }) => {
      for (const { name, cfg } of declaredCfgs(m as never)) {
        const where = `${m.key}/${name}`;
        const parsed = m.configSchema.parse(cfg);
        const rule = m.tablePointsRule(parsed, "swiss");
        const sets = setsToWinByRulebook(m, cfg);
        const [win, loss] = cleanSweep(rule, sets);
        const drawStands = m.reachableResultKinds(parsed, "swiss").has("draw") || m.supportsDraws(parsed, "swiss");
        if (drawStands) expect(rule.draw, `${where}: a draw stands, so the rule prices one`).toBeDefined();
        const d = drawStands ? (rule.draw as number) : win / 2;
        if (drawStands) drawD++;
        else halfWinD++;
        if (!drawStands && rule.draw !== undefined) declaredUnreachable++;
        const cap = d * 3;
        const won = (id: EntrantId): StandingsDelta => ({ entrantId: id, played: 1, won: 1, drawn: 0, lost: 0, points: win, metrics: {} });
        const lost = (id: EntrantId): StandingsDelta => ({ entrantId: id, played: 1, won: 0, drawn: 0, lost: 1, points: loss, metrics: {} });
        const byeOf = (round: number, id: EntrantId): TableFixture => ({ id: `r${round}-bye`, roundNo: round, status: "walkover", awardDelta: paidBye(m, cfg, rule, id) });
        const fixtures: TableFixture[] = [
          { id: "r1", roundNo: 1, status: "decided", result: [won("X"), lost("Y")] }, byeOf(1, "Z"),
          { id: "r2", roundNo: 2, status: "decided", result: [won("X"), lost("Z")] }, byeOf(2, "Y"),
          { id: "r3", roundNo: 3, status: "decided", result: [won("Y"), lost("Z")] }, byeOf(3, "X"),
        ];
        const paid = (id: EntrantId) => (fixtures.find((f) => f.awardDelta?.entrantId === id)?.awardDelta?.points ?? NaN);
        const score = { X: win + win + paid("X"), Y: loss + paid("Y") + win, Z: paid("Z") + loss + loss };
        const dummy = (id: "X" | "Y" | "Z") => Math.min(score[id], cap);
        const expected = { X: score.Y + score.Z + dummy("X"), Y: score.X + dummy("Y") + score.Z, Z: dummy("Z") + score.X + score.Y };
        const scale = rule.unit === "half" ? 2 : 1;
        const rows = rowsOf({ rule, draw: swissDrawFactsOf(m, cfg), entrants: ["X", "Y", "Z"], rounds: 3, fixtures });
        for (const id of ["X", "Y", "Z"] as const) {
          expect(rows.get(id)?.points, `${where} ${id}: the score the hand count reads`).toBe(score[id]);
          expect(metricOf(rows, id, "buchholz"), `${where} ${id}`).toBe(expected[id] / scale);
          if (cap < score[id]) capBound++;
          else ownBound++;
          checked++;
          perSport.set(m.key, (perSport.get(m.key) ?? 0) + 1);
        }
      }
    });
    expect(sports).toBe(builtinModules.length);
    expect(perSport.size, "every sport checked").toBe(sports);
    expect(checked).toBeGreaterThanOrEqual(3 * sports);
    expect(capBound, "some entrant's cap binds").toBeGreaterThan(0);
    expect(ownBound, "some entrant's own score binds").toBeGreaterThan(0);
    expect(drawD, "some cfg's D is its draw").toBeGreaterThan(0);
    expect(halfWinD, "some cfg's D is half its win").toBeGreaterThan(0);
    expect(declaredUnreachable, "some cfg declares a draw its Swiss stage cannot reach (R4)").toBeGreaterThan(0);
  });

  it("X-SW-7 R4: a draw the rule declares but no Swiss stage can reach is no draw: IIHF ice hockey and generic win/loss take D = ½ × 3 = 1.5", () => {
    // single-sport: the two declared cfgs whose rule prices a draw (1) no Swiss stage of theirs can reach — the IIHF's
    // overtime and shoot-out decide every game, and generic's win/loss mode allows no draw — named by hand; the every-sport
    // test sweeps the registry.
    // Each in S5's shape under the sport's own declared Swiss rule (win 3, loss 0, draw 1, whole points) and the app's
    // paid bye (the win, 3): scores X 3+3+3 = 9, Y 0+3+3 = 6, Z 3+0+0 = 3. No draw stands, so D = ½ x 3 = 1.5 and the
    // cap is 4.5 (rulebook §4 "for a sport with no draw, ½ x win points x rounds"):
    //   X = Y 6 + Z 3 + min(9, 4.5) 4.5 = 13.5.   Y = X 9 + min(6, 4.5) 4.5 + Z 3 = 16.5.   Z = min(3, 4.5) 3 + X 9 + Y 6 = 18.
    // differential: D = the declared draw 1 gives cap 3, so X 6+3+3 = 12, Y 9+3+3 = 15, Z 18.
    let checked = 0;
    for (const [key, cfgName] of [["icehockey", "iihf"], ["generic", "win_loss"]] as const) {
      const m = builtinModules.find((x) => x.key === key);
      const cfg = m === undefined ? undefined : declaredCfgs(m as never).find((c) => c.name === cfgName)?.cfg;
      if (m === undefined || cfg === undefined) throw new Error(`${key}/${cfgName} is not declared`);
      const rule = m.tablePointsRule(m.configSchema.parse(cfg), "swiss");
      expect([rule.win.regulation, rule.loss.regulation, rule.draw, rule.unit], key).toEqual([3, 0, 1, "whole"]);
      const facts = swissDrawFactsOf(m, cfg);
      expect(facts, key).toEqual({ drawReachable: false, setsToWin: undefined });
      const byeOf = (round: number, id: EntrantId): TableFixture => ({ id: `r${round}-bye`, roundNo: round, status: "walkover", awardDelta: paidBye(m, cfg, rule, id) });
      expect(byeOf(1, "Z").awardDelta?.points, `${key}: the bye pays the win`).toBe(3);
      const scene: Scene = {
        rule, draw: facts, entrants: ["X", "Y", "Z"], rounds: 3,
        fixtures: [
          board(rule, 1, "X", "Y", "h"), byeOf(1, "Z"), board(rule, 2, "X", "Z", "h"), byeOf(2, "Y"), board(rule, 3, "Y", "Z", "h"), byeOf(3, "X"),
        ],
      };
      expect(column(scene, "buchholz"), key).toEqual({ X: 13.5, Y: 16.5, Z: 18 });
      checked++;
    }
    expect(checked).toBe(2);
    // R4's two declarations, each alone: a draw is reachable when the stage's reachable results hold one OR the sport stands
    // draws in the stage (generic win/loss answers no to both; each stub answers yes to one).
    const generic = builtinModules.find((x) => x.key === "generic");
    const winLoss = generic === undefined ? undefined : declaredCfgs(generic as never).find((c) => c.name === "win_loss")?.cfg;
    if (generic === undefined || winLoss === undefined) throw new Error("generic/win_loss is not declared");
    const draws = { ...generic, supportsDraws: () => true } as AnySportModule;
    const reaches = { ...generic, reachableResultKinds: () => new Set(["draw"] as const) } as AnySportModule;
    expect([generic, draws, reaches].map((m) => swissDrawFactsOf(m, winLoss).drawReachable)).toEqual([false, true, true]);
  });

  it("X-SW-7 design §5: under a set-score rule the win points are the clean sweep's, so D = ½ × 4 = 2 (not ½ × win.regulation 2)", () => {
    // single-sport: badminton stands for every set sport (no draw; a best-of-3 is won on 2 sets); the every-sport test
    // sweeps the registry.
    // An organiser's set map on a best-of-3: 2-0 pays 4/0, 2-1 pays 3/1; win.regulation 2 (the schema asks for one).
    // design §5: "win points" under a score-keyed rule are the clean sweep's, 4; a bye pays them (X-SW-5). No draw stands,
    // so D = ½ x 4 = 2 and the cap is 2 x 3 = 6.
    //   R1: X beats Y 2-0, Z bye.   R2: X beats Z 2-0, Y bye.   R3: Y beats Z 2-1, X bye.
    //   Scores: X 4+4+4 = 12, Y 0+4+3 = 7, Z 4+0+1 = 5.
    //   Buchholz X = Y 7 + Z 5 + min(12, 6) 6 = 18.   Y = X 12 + min(7, 6) 6 + Z 5 = 23.   Z = min(5, 6) 5 + X 12 + Y 7 = 24.
    // differential: D = ½ x win.regulation 2 = 1 gives cap 3, so X 7+5+3 = 15, Y 12+3+5 = 20, Z 3+12+7 = 22.
    const m = builtinModules.find((x) => x.key === "badminton");
    if (m === undefined) throw new Error("badminton is not registered");
    const rule = PointsRule.parse({
      win: { regulation: 2 }, loss: { regulation: 0 }, shootoutAs: "result", unit: "whole", bonuses: [],
      bySetScore: { "2-0": [4, 0], "2-1": [3, 1] },
    });
    const facts = swissDrawFactsOf(m, {});
    expect(facts).toEqual({ drawReachable: false, setsToWin: 2 });
    const byeOf = (round: number, id: EntrantId): TableFixture => ({ id: `r${round}-bye`, roundNo: round, status: "walkover", awardDelta: paidBye(m, {}, rule, id) });
    expect(byeOf(1, "Z").awardDelta?.points, "the bye pays the clean sweep's 4").toBe(4);
    const game = (round: number, winner: EntrantId, loser: EntrantId, [w, l]: readonly [number, number]): TableFixture => ({
      id: `r${round}-${winner}-${loser}`, roundNo: round, status: "decided",
      result: [
        { entrantId: winner, played: 1, won: 1, drawn: 0, lost: 0, points: w, metrics: {} },
        { entrantId: loser, played: 1, won: 0, drawn: 0, lost: 1, points: l, metrics: {} },
      ],
    });
    const scene: Scene = {
      rule, draw: facts, entrants: ["X", "Y", "Z"], rounds: 3,
      fixtures: [game(1, "X", "Y", [4, 0]), byeOf(1, "Z"), game(2, "X", "Z", [4, 0]), byeOf(2, "Y"), game(3, "Y", "Z", [3, 1]), byeOf(3, "X")],
    };
    expect(column(scene, "buchholz")).toEqual({ X: 18, Y: 23, Z: 24 });
    // a set-score rule on a sport that keeps no set score has no clean sweep: refused, never guessed
    const noSets = refusal(() => swissDrawPoints(rule, { drawReachable: false, setsToWin: undefined }));
    expect(noSets?.code).toBe("CONFIG_INVALID");
    expect(noSets?.message).toMatch(/keeps no set score/);
  });

  it("X-SW-8 mid-round: a pending round-3 board adds no card and no dummy (Review Focus 1)", () => {
    // S1 with round 3's A-D board not yet counted (still to play, live, or voided). Scores: A 2+2 = 4, B 0+2+2 = 4,
    // C 1+2+2 = 5, D 1+0 = 1, E 2+0+0 = 2. A and D hold no round-3 card and no dummy for it:
    //   A = B 4 + E 2 = 6 (a dummy for the pending board would add min(4, 3) = 3, giving 9).
    //   D = C 5 + B 4 = 9 (with a dummy: + min(1, 3) = 1, giving 10).
    //   B = A 4 + D 1 + bye min(4, 3) 3 = 8.   C = D 1 + bye min(5, 3) 3 + E 2 = 6.   E = bye min(2, 3) 2 + A 4 + C 5 = 11.
    let checked = 0;
    for (const status of ["scheduled", "in_play", "void"] as const) {
      const fixtures = S1.fixtures.map((f) => (f.id === "r3-A-D" ? { ...f, status } : f));
      expect(fixtures.filter((f) => f.status === status), status).toHaveLength(1);
      expect(column({ ...S1, fixtures }, "buchholz"), status).toEqual({ A: 6 / 2, B: 8 / 2, C: 6 / 2, D: 9 / 2, E: 11 / 2 });
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("X-SW-8 two cards in one round (a stored ad-hoc match) rank without throwing (Review Focus 2)", () => {
    // S1 plus a stored ad-hoc round-2 match, D beats E: D and E each hold two round-2 cards. Scores: A 5, B 4, C 5,
    // D 2+2 = 4, E 2. Buchholz (cap 3):
    //   A = B 4 + E 2 + D 4 = 10.   B = A 5 + D 4 + bye min(4, 3) 3 = 12.   C = D 4 + bye min(5, 3) 3 + E 2 = 9.
    //   D = C 5 + B 4 + E 2 + A 5 = 16.   E = bye min(2, 3) 2 + A 5 + D 4 + C 5 = 16.
    const twice: Scene = { ...S1, fixtures: [...S1.fixtures, board(CHESS, 2, "D", "E", "h")] };
    expect(column(twice, "buchholz")).toEqual({ A: 10 / 2, B: 12 / 2, C: 9 / 2, D: 16 / 2, E: 16 / 2 });
  });

  it("X-SW-8 guards: missing roundNo / rounds / absent round out of range / absent where a card exists / unknown entrant → CONFIG_INVALID", () => {
    const run = (s: Scene) => () => tableOf(s);
    const cases: Array<[string, Scene, RegExp]> = [
      // a counted Swiss fixture with no round: art. 16 reads a card's place among the rounds
      ["no roundNo", { ...S4, fixtures: S4.fixtures.map((f) => (f.id === "r2-L-B" ? withoutRound(f) : f)) }, /roundNo/],
      // an unplayed card (a bye, an absence) needs the stage's rounds for its cap (16.4.2): none, or not a positive count
      ["no rounds", { ...S4, rounds: undefined }, /rounds/],
      ["rounds 0", { ...S4, rounds: 0 }, /rounds/],
      ["a bye and no rounds", { ...S1, rounds: undefined }, /rounds/],
      // an unplayed card needs D for its cap, and a Swiss ledger stage names its draw facts (ruling R4) — refused at once
      // since T8 (N1), whether or not a round is unplayed: the even-field case is the X-SW-7 N1 test
      ["no draw facts", { ...S4, draw: undefined }, /swissDraw/],
      ["a bye and no draw facts", { ...S1, draw: undefined }, /swissDraw/],
      // an absent round outside 1..R
      ["round 0", { ...S4, absent: new Map([["L", [0]]]) }, /outside/],
      ["round 4 of 3", { ...S4, absent: new Map([["L", [4]]]) }, /outside/],
      ["round 1.5", { ...S4, absent: new Map([["L", [1.5]]]) }, /outside/],
      // an absent round the entrant holds a card in (a played board, then the same absence twice)
      ["absent where L played", { ...S4, absent: new Map([["L", [1, 2]]]) }, /holds a card/],
      ["absent twice", { ...S4, absent: new Map([["L", [1, 1]]]) }, /holds a card/],
      // an absence naming an entrant the table does not hold
      ["unknown entrant", { ...S4, absent: new Map([["L", [1]], ["ghost", [1]]]) }, /"ghost" outside the entrant set/],
      ["unknown entrant, no round", { ...S4, absent: new Map([["L", [1]], ["ghost", []]]) }, /"ghost" outside the entrant set/],
    ];
    let checked = 0;
    for (const [what, scene, message] of cases) {
      const got = refusal(run(scene));
      expect(got?.code, what).toBe("CONFIG_INVALID");
      expect(got?.message, what).toMatch(message);
      checked++;
    }
    expect(checked).toBe(cases.length);
    // The ledger's own D guard, for a caller with no stage (a stage refuses first, above): an unplayed card and no D.
    const noD = refusal(() => buildSwissLedger(S1.entrants, ledgerFixtures(S1), { rounds: 3, drawPoints: undefined }));
    expect(noD?.code).toBe("CONFIG_INVALID");
    expect(noD?.message).toMatch(/draw points/);
    // The positive pairs: S4 itself ranks; a board still to play may carry no round (it is no card); a Swiss with no
    // unplayed card ranks with no rounds; the last round may be absent.
    expect(refusal(run(S4))).toBeNull();
    expect(refusal(run({ ...S4, fixtures: [...S4.fixtures, { id: "later", status: "scheduled" }] }))).toBeNull();
    // and a counted fixture carrying neither a result nor an award writes no card, so it needs no round either
    expect(refusal(run({ ...S4, fixtures: [...S4.fixtures, { id: "empty", status: "decided" }] }))).toBeNull();
    expect(refusal(run({ ...S1, rounds: undefined, fixtures: S1.fixtures.filter((f) => f.awardDelta === undefined) }))).toBeNull();
    expect(refusal(run({ ...S4, absent: new Map([["L", [1]], ["B", []]]) }))).toBeNull();
  });

  it("X-SW-8 a Swiss table names its points unit: without it the ranker refuses (CONFIG_INVALID), the columns being in the table's own points", () => {
    const table: SwissTable = buildSwissLedger(["A", "B"], [{ round: 1, result: board(CHESS, 1, "A", "B", "h").result! }], LEDGER_OPTS);
    const rows: StandingsRow[] = [
      { entrantId: "A", played: 1, won: 1, drawn: 0, lost: 0, points: 2, metrics: {} },
      { entrantId: "B", played: 1, won: 0, drawn: 0, lost: 1, points: 0, metrics: {} },
    ];
    const got = refusal(() => rankStandings(rows, { cascade: ["points", "buchholz"], swiss: table }));
    expect(got?.code).toBe("CONFIG_INVALID");
    expect(got?.message).toMatch(/pointsUnit/);
    // the positive pair, and the unit read: B's Buchholz is A's 2 half-points, 1 point on a half-point table, 2 on a
    // whole-point one
    const half = rankStandings(rows, { cascade: ["points", "buchholz"], swiss: table, pointsUnit: "half" }).rows;
    const whole = rankStandings(rows, { cascade: ["points", "buchholz"], swiss: table, pointsUnit: "whole" }).rows;
    expect([half, whole].map((r) => r.find((x) => x.entrantId === "B")?.metrics.buchholz)).toEqual([1, 2]);
  });

  it("X-SW-8 second call: ranking the same stage twice gives identical rows", () => {
    const before = JSON.stringify(S4.fixtures);
    const first = completeTableStage(stageOf(S4), S4.fixtures);
    const second = completeTableStage(stageOf(S4), S4.fixtures);
    expect(second).toStrictEqual(first);
    expect(first.tables.overall).toHaveLength(S4.entrants.length);
    // and neither call wrote to its input
    expect(JSON.stringify(S4.fixtures)).toBe(before);
    expect([...S4.absent!]).toEqual([["L", [1]]]);
  });
});

/** A forfeit: `winner` is paid, `loser` never played (FORFEIT_REASONS; walkover by default). */
const forfeit = (winner: EntrantId, loser: EntrantId, reason: "walkover" | "withdrew" = "walkover"): MatchOutcome =>
  MatchOutcome.parse({ kind: "award", winner, loser, reason });
const DOUBLE_WALKOVER: MatchOutcome = MatchOutcome.parse({ kind: "double_walkover" });
/** Each entrant's cards as their categories, "played" for a played game. */
const categoriesOf = (ledger: SwissTable): Record<EntrantId, string[]> =>
  Object.fromEntries(ledger.map((row) => [row.entrant, row.games.map((game) => game.unplayed ?? "played")]));

// S2: a forfeit. Boardgame half-points (win 2, draw 1, loss 0), R = 2, D = 1.
//   R1: A v B, B forfeits with nothing played (a walkover: A is paid the win 2, B the loss 0; unplayed "away");
//       C beats D.   R2: A beats C, B beats D.
//   Scores: A 2+2 = 4, B 0+2 = 2, C 2+0 = 2, D 0+0 = 0. Nobody is absent, so every adjusted score is the score.
//   A's round 1 is a forfeit win (16.2.2), B's a forfeit loss (16.2.4). Each is scored against a dummy at its own score,
//   capped at its SCHEDULED opponent's adjusted score (16.4.1): A min(4, B 2) = 2, B min(2, A 4) = 2. C and D read A and
//   B at their scores (16.3.1: a forfeit counts at its awarded result).
//   Buchholz: A = dummy 2 + C 2 = 4.  B = dummy 2 + D 0 = 2.  C = D 0 + A 4 = 4.  D = C 2 + B 2 = 4.
//   Cut-1 (16.5.1; B's forfeit loss is its one VUR, 16.1; nobody else has one):
//     A {2, 2} → 2.  B cuts its VUR's 2 → 0 (the lowest overall is D's 0, leaving 2).  C {0, 4} → 4.  D {2, 2} → 2.
//   Sonneborn-Berger (weight x contribution; a forfeit win is a win against its dummy): A = 2·2 + 2·2 = 8,
//     B = 0·2 + 2·0 = 0, C = 2·0 + 0·4 = 0, D = 0·2 + 0·2 = 0.
//   Shown on a half-point table: Buchholz and Cut-1 ÷ 2, SB ÷ 4.
//   differential: HEAD (T7) reads the forfeit as a game B lost to A, so B = A 4 + D 0 = 4 and its Cut-1 cuts D's 0 → 4.
function sceneS2(): Scene {
  return {
    rule: CHESS, draw: CHESS_DRAW, entrants: ["A", "B", "C", "D"], rounds: 2,
    fixtures: [
      walkedOver(boardgame, {}, CHESS, 1, "A", "B", forfeit("A", "B")), board(CHESS, 1, "C", "D", "h"),
      board(CHESS, 2, "A", "C", "h"), board(CHESS, 2, "B", "D", "h"),
    ],
  };
}

// S3: a withdrawal. Boardgame half-points, R = 3, D = 1, so a bye's or a zero-point round's cap is D x R = 3.
//   R1: A beats B, C beats D. B then withdraws and is not paired again: rounds 2 and 3 are its zero-point rounds (16.1:
//   "any round after a participant withdraws is a zero-point-bye"), declared to the stage as `absent: [2, 3]`.
//   R2: A beats C, D bye.   R3: A draws D, C bye.
//   Scores: A 2+2+1 = 5, B 0, C 2+0+2 = 4, D 0+2+1 = 3.
//   B's rounds 2 and 3 are followed only by VURs (or are the last), so both are 16.2.5: its opponents read it at its
//   ADJUSTED score, a draw for each (16.3.2): 0 + 1 + 1 = 2. Its own dummies are min(0, 3) = 0 (16.4.2).
//   Buchholz: A = B 2 + C 4 + D 3 = 9.  B = A 5 + 0 + 0 = 5.  C = D 3 + A 5 + bye min(4, 3) 3 = 11.
//     D = C 4 + bye min(3, 3) 3 + A 5 = 12.
//   Cut-1: A {2, 4, 3}, no VUR → 7.  B's two zero-point rounds are VURs (16.1), each 0: it cuts one → 5 (its lowest
//     overall is a 0 as well, so the two rules agree here; S2 is where they differ).  C {3, 5, 3} → 8.  D {4, 3, 5} → 9.
//   differential: reading B at its real 0 (mutant (c); the pre-W3 engine had no adjusted score), A = 0 + 4 + 3 = 7.
function sceneS3(): Scene {
  return {
    rule: CHESS, draw: CHESS_DRAW, entrants: ["A", "B", "C", "D"], rounds: 3, absent: new Map([["B", [2, 3]]]),
    fixtures: [
      board(CHESS, 1, "A", "B", "h"), board(CHESS, 1, "C", "D", "h"),
      board(CHESS, 2, "A", "C", "h"), bye(CHESS, 2, "D"),
      board(CHESS, 3, "A", "D", "d"), bye(CHESS, 3, "C"),
    ],
  };
}

describe("X-SW-7 forfeits, double walkovers and withdrawals: FIDE C.07 (2026) art. 16.2.2/16.2.4, 16.3.2, 16.4.1, 16.5 (rulebook-W3 §4)", () => {
  it("X-SW-7 empty case first: unplayedSidesOf is undefined for a played win and for a bye", () => {
    const pair = board(CHESS, 1, "A", "B", "h").result!; // A (home) beat B
    const won = MatchOutcome.parse({ kind: "win", winner: "A", loser: "B", method: "regulation" });
    const byeAward = MatchOutcome.parse({ kind: "award", winner: "A", loser: null, reason: "bye" });
    let checked = 0;
    for (const played of [true, false]) {
      expect(unplayedSidesOf(won, played, pair), `a played win, played=${played}`).toBeUndefined();
      expect(unplayedSidesOf(byeAward, played, pair), `a bye, played=${played}`).toBeUndefined();
      checked += 2;
    }
    expect(checked).toBe(4);
  });

  it("X-SW-7 unplayedSidesOf over every outcome kind, award reason, played fact and seat: the side that lost without playing (counted)", () => {
    // By hand, from rulebook §4 (M1 walkover, M2 double walkover, M3 retirement) and X-PT-1 (P-3 "A"):
    //   - a double walkover: "both", played or not (both sides absent);
    //   - a walkover (an award, or a pre-W2b win by walkover): the loser's seat, played or not — a walkover is nothing
    //     played by its own reason;
    //   - any other forfeit (retired, disqualified, withdrew; a pre-W2b win by forfeit): the loser's seat while nothing was
    //     played, and none after play (a played game, M3);
    //   - a bye (16.2.1: the award's own unplayed round, nobody forfeited), a played win, a draw, a tie, a no result: none.
    const cases: Array<{ outcome: MatchOutcome; played: boolean; pair: FixtureResult; expected: "home" | "away" | "both" | undefined; what: string }> = [];
    // the winner is always A, and B the side that forfeits; `home` is who holds the home seat
    for (const home of ["A", "B"] as const) {
      const pair: FixtureResult = home === "A" ? board(CHESS, 1, "A", "B", "h").result! : board(CHESS, 1, "B", "A", "a").result!;
      const loserSeat = home === "A" ? "away" : "home";
      for (const played of [false, true]) {
        const add = (outcome: unknown, expected: "home" | "away" | "both" | undefined, what: string) =>
          cases.push({ outcome: MatchOutcome.parse(outcome), played, pair, expected, what: `${what}, A ${home === "A" ? "home" : "away"}, played=${played}` });
        add({ kind: "double_walkover" }, "both", "double walkover");
        add({ kind: "draw" }, undefined, "draw");
        add({ kind: "tie" }, undefined, "tie");
        add({ kind: "no_result" }, undefined, "no result");
        for (const reason of AWARD_REASONS) {
          const loser = reason === "bye" ? null : "B";
          const expected = reason === "bye" ? undefined : reason === "walkover" || !played ? loserSeat : undefined;
          add({ kind: "award", winner: "A", loser, reason }, expected, `award ${reason}`);
        }
        for (const method of ["regulation", "walkover", "forfeit"] as const) {
          const expected = method === "walkover" || (method === "forfeit" && !played) ? loserSeat : undefined;
          add({ kind: "win", winner: "A", loser: "B", method }, expected, `win by ${method}`);
        }
      }
    }
    let checked = 0;
    const kinds = new Set<string>();
    const reasons = new Set<string>();
    for (const { outcome, played, pair, expected, what } of cases) {
      expect(unplayedSidesOf(outcome, played, pair), what).toBe(expected);
      kinds.add(outcome.kind);
      if (outcome.kind === "award") reasons.add(outcome.reason);
      checked++;
    }
    // anti-vacuity: every outcome kind and every award reason, both seats and both played facts
    expect(checked).toBe(2 * 2 * (4 + AWARD_REASONS.length + 3));
    expect([...kinds].sort()).toEqual([...OUTCOME_KINDS].sort());
    expect([...reasons].sort()).toEqual([...AWARD_REASONS].sort());
    expect(cases.filter((c) => c.expected === "home").length, "the loser sits home in some case").toBeGreaterThan(0);
    expect(cases.filter((c) => c.expected === "away").length, "the loser sits away in some case").toBeGreaterThan(0);
  });

  it("X-SW-7 a forfeit loss is scored against a dummy capped at the scheduled opponent's adjusted score: B = min(2, 4) + 0 = 2 (16.4.1)", () => {
    const s2 = sceneS2();
    // premise: the producer chain marks the side that never arrived, B, away, and pays A the win, B the loss
    const [walked] = s2.fixtures;
    expect([walked?.unplayed, walked?.result?.map((d) => [d.entrantId, d.points])]).toEqual(["away", [["A", 2], ["B", 0]]]);
    const rows = rowsOf(s2);
    const bh = (id: EntrantId) => metricOf(rows, id, "buchholz");
    expect(bh("B")).toBe(2 / 2); // differential: HEAD 4/2 — the forfeit read as a game B lost to A (SW-L1)
    expect(column(s2, "buchholz")).toEqual({ A: 4 / 2, B: 2 / 2, C: 4 / 2, D: 4 / 2 });
    expect(column(s2, "sberger")).toEqual({ A: 8 / 4, B: 0, C: 0, D: 0 });
    expect(Object.fromEntries(s2.entrants.map((id) => [id, rows.get(id)?.points]))).toEqual({ A: 4, B: 2, C: 2, D: 0 });
    // The cards: each forfeit card names its scheduled opponent and is capped at that opponent's adjusted score.
    const ledger = buildSwissLedger(s2.entrants, ledgerFixtures(s2), { rounds: 2, drawPoints: 1 });
    expect(ledger.filter((r) => r.entrant === "A" || r.entrant === "B")).toStrictEqual([
      {
        entrant: "A", score: 4,
        games: [
          { round: 1, opponent: "B", result: "win", scored: 2, unplayed: "forfeit_win", cap: 2 },
          { round: 2, opponent: "C", result: "win", scored: 2 },
        ],
      },
      {
        entrant: "B", score: 2,
        games: [
          { round: 1, opponent: "A", result: "loss", scored: 0, unplayed: "forfeit_loss", cap: 4 },
          { round: 2, opponent: "D", result: "win", scored: 2 },
        ],
      },
    ]);
  });

  it("X-SW-7 Cut-1 cuts the lowest VUR first: B's Buchholz Cut-1 = 0, not 2 (16.5.1)", () => {
    const s2 = sceneS2();
    const cut1 = (id: EntrantId) => metricOf(rowsOf(s2), id, "buchholz_cut1");
    // differential: HEAD 4/2 (the forfeit read as a game v A, D's 0 cut); cutting the lowest overall gives 2/2
    expect(cut1("B")).toBe(0);
    expect(column(s2, "buchholz_cut1")).toEqual({ A: 2 / 2, B: 0, C: 4 / 2, D: 2 / 2 });
    // 16.5.2: a Cut-k repeats it, each cut taking the lowest VUR left, then the lowest contribution left. On a hand card
    // (half-points, R = 4, D = 1): X, score 4, beat P (score 0), forfeited to Q (score 3: dummy min(4, Q 3) = 3, a VUR),
    // missed round 3 before playing again (16.2.3, cap D x R = 4: dummy min(4, 4) = 4, a VUR), beat R (score 5).
    //   Contributions {P 0, VUR 3, VUR 4, R 5}, Buchholz 12.
    //   Cut-1 cuts the lowest VUR, 3 → 9 (the lowest overall, P's 0, would leave 12; the highest VUR 8).
    //   Cut-2 cuts both VURs → 5 (the two lowest overall would leave 9).   Cut-3 has no VUR left for its third cut, so it
    //   takes the lowest left, P's 0 → 5.
    const hand: SwissTable = [
      {
        entrant: "X", score: 4,
        games: [
          { round: 1, opponent: "P", result: "win", scored: 2 },
          { round: 2, opponent: "Q", result: "loss", scored: 0, unplayed: "forfeit_loss", cap: 3 },
          { round: 3, opponent: null, result: "loss", scored: 0, unplayed: "absent", cap: 4 },
          { round: 4, opponent: "R", result: "win", scored: 2 },
        ],
      },
      { entrant: "P", score: 0, games: [] },
      { entrant: "Q", score: 3, games: [] },
      { entrant: "R", score: 5, games: [] },
    ];
    expect([0, 1, 2, 3].map((cut) => buchholz(hand, "X", { cut }))).toEqual([12, 9, 5, 5]);
    // 16.1: a forfeit WIN (16.2.2) and a pairing-allocated bye (16.2.1) are unplayed but NOT VURs, so a Cut-1 on a card
    // with no VUR passes over them to the lowest contribution (16.5.1). Hand card (half-points, R = 4, D = 1): Y, score 8,
    // beat P (score 1), won by forfeit v F (score 4: dummy min(8, F 4) = 4, 16.4.1), had the round-3 bye (dummy
    // min(8, D x R = 4) = 4, 16.4.2), beat S (score 5).
    //   Contributions {P 1, forfeit win 4, bye 4, S 5}, Buchholz 14.
    //   Cut-1 has no VUR to cut, so it cuts the lowest, P's 1 → 13 (reading the forfeit win or the bye as a VUR cuts a 4 → 10).
    const noVur: SwissTable = [
      {
        entrant: "Y", score: 8,
        games: [
          { round: 1, opponent: "P", result: "win", scored: 2 },
          { round: 2, opponent: "F", result: "win", scored: 2, unplayed: "forfeit_win", cap: 4 },
          { round: 3, opponent: null, result: "win", scored: 2, unplayed: "bye", cap: 4 },
          { round: 4, opponent: "S", result: "win", scored: 2 },
        ],
      },
      { entrant: "P", score: 1, games: [] },
      { entrant: "F", score: 4, games: [] },
      { entrant: "S", score: 5, games: [] },
    ];
    expect([0, 1].map((cut) => buchholz(noVur, "Y", { cut }))).toEqual([14, 13]);
  });

  it("X-SW-7 a forfeit is not a meeting: direct encounter A v B is level (P-A2)", () => {
    const s2 = sceneS2();
    // A and B on the ledger: neither card names the other as a game played (A's round 1 is a forfeit win).
    const ledger = buildSwissLedger(s2.entrants, ledgerFixtures(s2), { rounds: 2, drawPoints: 1 });
    expect([directEncounter(ledger, "A", "B"), directEncounter(ledger, "B", "A")]).toEqual([0, 0]); // differential: HEAD [1, -1]
    // Through the stage, ranked by direct encounter alone: each entrant's points in played games against the others are
    // A 2 (beat C), B 2 (beat D), C 2 (beat D), D 0, so A, B and C stay level for the lots and D is last.
    // differential: HEAD counts A's forfeit win as 2 more against B, so A 4 ranks alone and only B, C go to lots.
    const done = completeTableStage(stageOf({ ...s2, cascade: ["direct", "lots"] }), s2.fixtures);
    const lotGroups = done.events.flatMap((e) => (e.type === "rank_lock_required" ? [[...e.group].sort()] : []));
    expect(lotGroups).toEqual([["A", "B", "C"]]);
    expect(done.tables.overall?.at(-1)?.entrantId).toBe("D");
  });

  it("X-SW-7 a double walkover gives both sides a forfeit_loss card (rulebook §4 M2)", () => {
    // S2 with round 1's A v B a double walkover (both absent) and round 2's lower board the other way round.
    //   R1: A v B double walkover (each paid the loss 0; unplayed "both"); C beats D.   R2: A beats C, D beats B.
    //   Scores: A 0+2 = 2, B 0+0 = 0, C 2+0 = 2, D 0+2 = 2.
    //   Both round-1 cards are forfeit losses (16.2.4), each capped at the other's adjusted score (16.4.1):
    //   A min(2, B 0) = 0, B min(0, A 2) = 0.
    //   Buchholz: A = 0 + C 2 = 2.  B = 0 + D 2 = 2.  C = D 2 + A 2 = 4.  D = C 2 + B 0 = 2.
    //   Cut-1: A cuts its VUR's 0 → 2.  B cuts its VUR's 0 → 2.  C {2, 2} → 2.  D {2, 0} → 2.
    //   differential: HEAD reads it as a game both lost, so B = A 2 + D 2 = 4; a cap of D x R (= 2) for a forfeit, A = 4.
    const dw: Scene = {
      rule: CHESS, draw: CHESS_DRAW, entrants: ["A", "B", "C", "D"], rounds: 2,
      fixtures: [
        walkedOver(boardgame, {}, CHESS, 1, "A", "B", DOUBLE_WALKOVER), board(CHESS, 1, "C", "D", "h"),
        board(CHESS, 2, "A", "C", "h"), board(CHESS, 2, "D", "B", "h"),
      ],
    };
    expect(dw.fixtures[0]?.unplayed, "the producer marks both sides").toBe("both");
    expect(column(dw, "buchholz")).toEqual({ A: 2 / 2, B: 2 / 2, C: 4 / 2, D: 2 / 2 });
    expect(column(dw, "buchholz_cut1")).toEqual({ A: 2 / 2, B: 2 / 2, C: 2 / 2, D: 2 / 2 });
    // X-DW-4: each played and lost it, 0 points
    const rows = rowsOf(dw);
    expect(["A", "B"].map((id) => { const r = rows.get(id); return r && [r.played, r.lost, r.points]; })).toEqual([[2, 1, 2], [2, 2, 0]]);
    const ledger = buildSwissLedger(dw.entrants, ledgerFixtures(dw), { rounds: 2, drawPoints: 1 });
    expect(ledger.flatMap((r) => r.games.filter((g) => g.round === 1 && (r.entrant === "A" || r.entrant === "B")))).toStrictEqual([
      { round: 1, opponent: "B", result: "loss", scored: 0, unplayed: "forfeit_loss", cap: 0 },
      { round: 1, opponent: "A", result: "loss", scored: 0, unplayed: "forfeit_loss", cap: 2 },
    ]);
  });

  it("X-SW-7 a withdrawn entrant stays in its opponents' Buchholz at its adjusted score: A = 2+4+3 = 9 (16.3.2)", () => {
    const s3 = sceneS3();
    const bh = (id: EntrantId) => metricOf(rowsOf(s3), id, "buchholz");
    expect(bh("A")).toBe(9 / 2); // differential: 7/2 — B read at its real 0 (mutant (c)); HEAD (T7) already reads `adjusted`
    expect(column(s3, "buchholz")).toEqual({ A: 9 / 2, B: 5 / 2, C: 11 / 2, D: 12 / 2 });
    const rows = rowsOf(s3);
    expect(Object.fromEntries(s3.entrants.map((id) => [id, rows.get(id)?.points]))).toEqual({ A: 5, B: 0, C: 4, D: 3 });
  });

  it("X-SW-7 after a withdrawal its post-withdrawal rounds are VURs on its own card: B's Cut-1 cuts a 0, Buchholz 5", () => {
    const s3 = sceneS3();
    // B's card: its one played round, then two 16.2.5 zero-point rounds (VURs), each a dummy min(0, 3) = 0; adjusted 2.
    const ledger = buildSwissLedger(s3.entrants, ledgerFixtures(s3), { rounds: 3, drawPoints: 1, absent: s3.absent! });
    expect(ledger.find((r) => r.entrant === "B")).toStrictEqual({
      entrant: "B", score: 0, adjusted: 2,
      games: [
        { round: 1, opponent: "A", result: "loss", scored: 0 },
        { round: 2, opponent: null, result: "loss", scored: 0, unplayed: "absent_last", cap: 3 },
        { round: 3, opponent: null, result: "loss", scored: 0, unplayed: "absent_last", cap: 3 },
      ],
    });
    const rows = rowsOf(s3);
    expect([metricOf(rows, "B", "buchholz"), metricOf(rows, "B", "buchholz_cut1")]).toEqual([5 / 2, 5 / 2]);
    expect(column(s3, "buchholz_cut1")).toEqual({ A: 7 / 2, B: 5 / 2, C: 8 / 2, D: 9 / 2 });
  });

  it("X-SW-7 a withdrawal with its next board paired: that board walks over (a forfeit loss), and the walkover winner's dummy is capped at the withdrawn side's ADJUSTED score (16.4.1, 16.3.2)", () => {
    // Boardgame half-points, R = 3, D = 1. B withdraws after round 1 with its round-2 board already paired: that board
    // walks over to C (reason "withdrew", nothing played; rulebook §4 "Withdrawal with a paired, undecided board"), and
    // B is not paired in round 3.
    //   R1: A beats B, C beats D.   R2: B v C walks over to C (unplayed "home"), A beats D.   R3: A draws C, D bye; B absent.
    //   Scores: A 2+2+1 = 5, B 0, C 2+2+1 = 5, D 0+0+2 = 2.
    //   B's card: R1 played, R2 a forfeit loss (16.2.4, a VUR), R3 a zero-point round followed by nothing: 16.2.5, so B's
    //   adjusted score is 0 + 1 = 1 (16.3.2). C's R2 is a forfeit win capped at B's ADJUSTED 1 (16.4.1): min(5, 1) = 1.
    //   Buchholz: A = B 1 + D 2 + C 5 = 8.  B = A 5 + min(0, C 5) 0 + min(0, 3) 0 = 5.  C = D 2 + 1 + A 5 = 8.
    //     D = C 5 + A 5 + bye min(2, 3) 2 = 12.
    //   Cut-1: A {1, 2, 5} → 7.  B's VURs (0, 0) → cut a 0 → 5.  C {2, 1, 5} (a forfeit WIN is no VUR) → 7.  D {5, 5, 2} → 10.
    //   differential: the cap at B's real 0 gives C = 2 + 0 + 5 = 7; at D x R (16.4.2's cap) 2 + 3 + 5 = 10.
    const wd: Scene = {
      rule: CHESS, draw: CHESS_DRAW, entrants: ["A", "B", "C", "D"], rounds: 3, absent: new Map([["B", [3]]]),
      fixtures: [
        board(CHESS, 1, "A", "B", "h"), board(CHESS, 1, "C", "D", "h"),
        walkedOver(boardgame, {}, CHESS, 2, "B", "C", forfeit("C", "B", "withdrew")), board(CHESS, 2, "A", "D", "h"),
        board(CHESS, 3, "A", "C", "d"), bye(CHESS, 3, "D"),
      ],
    };
    expect(wd.fixtures[2]?.unplayed, "the withdrawn side sits home").toBe("home");
    expect(column(wd, "buchholz")).toEqual({ A: 8 / 2, B: 5 / 2, C: 8 / 2, D: 12 / 2 });
    expect(column(wd, "buchholz_cut1")).toEqual({ A: 7 / 2, B: 5 / 2, C: 7 / 2, D: 10 / 2 });
    const ledger = buildSwissLedger(wd.entrants, ledgerFixtures(wd), { rounds: 3, drawPoints: 1, absent: wd.absent! });
    expect(categoriesOf(ledger)).toEqual({
      A: ["played", "played", "played"],
      B: ["played", "forfeit_loss", "absent_last"],
      C: ["played", "forfeit_win", "played"],
      D: ["played", "played", "bye"],
    });
    expect(ledger.find((r) => r.entrant === "B")?.adjusted).toBe(1);
  });

  it("X-SW-7 after a void: a voided round-2 board is not on either card and adds no dummy", () => {
    // S3 with round 2's A v C voided. Scores: A 2+1 = 3, B 0, C 2+2 = 4, D 0+2+1 = 3; B adjusted 0 + 2 = 2.
    //   A = B 2 + D 3 = 5 (a dummy for the void round would add min(3, 3) = 3, giving 8).
    //   B = A 3 + 0 + 0 = 3.   C = D 3 + bye min(4, 3) 3 = 6 (with a dummy: + min(4, 3) = 3, giving 9).
    //   D = C 4 + bye min(3, 3) 3 + A 3 = 10.
    const s3 = sceneS3();
    const voided: Scene = { ...s3, fixtures: s3.fixtures.map((f) => (f.id === "r2-A-C" ? { ...f, status: "void" } : f)) };
    expect(voided.fixtures.filter((f) => f.status === "void")).toHaveLength(1);
    expect(column(voided, "buchholz")).toEqual({ A: 5 / 2, B: 3 / 2, C: 6 / 2, D: 10 / 2 });
    const ledger = buildSwissLedger(voided.entrants, ledgerFixtures(voided), { rounds: 3, drawPoints: 1, absent: voided.absent! });
    expect(Object.fromEntries(ledger.map((r) => [r.entrant, r.games.map((g) => g.round)]))).toEqual({
      A: [1, 3], B: [1, 2, 3], C: [1, 3], D: [1, 2, 3],
    });
  });

  it("X-SW-7 another sport: S2's shape on football's declared rule (D = draw points) gives the same categories", () => {
    // single-sport: football is the goals representative; the sweep is Task 7's
    // S2 in football's own Swiss points: win 3, draw 1, loss 0, whole points; a draw stands in a football Swiss, so D is
    // the rule's draw, 1 (ruling R4); R = 2. The forfeit runs through football's standingsDelta (its walkover credit) and
    // the rule's payout: A is paid 3, B 0.
    //   Scores: A 3+3 = 6, B 0+3 = 3, C 3+0 = 3, D 0.
    //   Dummies (16.4.1): A min(6, B 3) = 3, B min(3, A 6) = 3.
    //   Buchholz: A = 3 + C 3 = 6.  B = 3 + D 0 = 3.  C = D 0 + A 6 = 6.  D = C 3 + B 3 = 6.
    //   Cut-1: A {3, 3} → 3.  B cuts its forfeit loss's 3 → 0 (the lowest overall, D's 0, would leave 3).  C {0, 6} → 6.
    //     D {3, 3} → 3.   Shown unhalved (whole points).
    //   differential: a cap of D x R = 2 for the forfeit gives A 2 + 3 = 5.
    const m = builtinModules.find((x) => x.key === "football");
    if (m === undefined) throw new Error("football is not registered");
    const rule = m.tablePointsRule(m.configSchema.parse({}), "swiss");
    const facts = swissDrawFactsOf(m, {});
    expect([rule.win.regulation, rule.draw, rule.loss.regulation, rule.unit, swissDrawPoints(rule, facts)]).toEqual([3, 1, 0, "whole", 1]);
    const scene: Scene = {
      rule, draw: facts, entrants: ["A", "B", "C", "D"], rounds: 2,
      fixtures: [
        walkedOver(m, {}, rule, 1, "A", "B", forfeit("A", "B")), board(rule, 1, "C", "D", "h"),
        board(rule, 2, "A", "C", "h"), board(rule, 2, "B", "D", "h"),
      ],
    };
    expect([scene.fixtures[0]?.unplayed, scene.fixtures[0]?.result?.map((d) => d.points)]).toEqual(["away", [3, 0]]);
    expect(column(scene, "buchholz")).toEqual({ A: 6, B: 3, C: 6, D: 6 });
    expect(column(scene, "buchholz_cut1")).toEqual({ A: 3, B: 0, C: 6, D: 3 });
    // the same categories as S2 in chess, card for card
    const s2 = sceneS2();
    const chess = categoriesOf(buildSwissLedger(s2.entrants, ledgerFixtures(s2), { rounds: 2, drawPoints: 1 }));
    const goals = categoriesOf(buildSwissLedger(scene.entrants, ledgerFixtures(scene), { rounds: 2, drawPoints: 1 }));
    expect(goals).toEqual({ A: ["forfeit_win", "played"], B: ["forfeit_loss", "played"], C: ["played", "played"], D: ["played", "played"] });
    expect(goals).toEqual(chess);
  });

  it("X-SW-7 N1: a Swiss ledger stage that names no swissDraw is refused at once (CONFIG_INVALID), even with an even field and no unplayed card", () => {
    // An even field, every board played: no card is unplayed, so D is never read — and the stage is still refused, so a
    // caller that forgets the draw facts fails on its first ranking, not on the first odd round (T7 re-review N1).
    const even: Scene = {
      rule: CHESS, draw: undefined, entrants: ["A", "B", "C", "D"], rounds: 2,
      fixtures: [board(CHESS, 1, "A", "B", "h"), board(CHESS, 1, "C", "D", "d"), board(CHESS, 2, "A", "C", "h"), board(CHESS, 2, "B", "D", "a")],
    };
    let checked = 0;
    for (const fixtures of [even.fixtures, []]) {
      const got = refusal(() => tableOf({ ...even, fixtures }));
      expect(got?.code, `${fixtures.length} fixtures`).toBe("CONFIG_INVALID");
      expect(got?.message, `${fixtures.length} fixtures`).toMatch(/names no swissDraw/);
      checked++;
    }
    expect(checked).toBe(2);
    // the positive pair: with the facts, the same stage ranks
    expect(refusal(() => tableOf({ ...even, draw: CHESS_DRAW }))).toBeNull();
    expect(rowsOf({ ...even, draw: CHESS_DRAW }).size).toBe(4);
    // and the type says so first: a Swiss ledger stage with no draw facts does not compile
    // @ts-expect-error — N1: TableStage's Swiss arm requires `swissDraw`, so a caller that leaves it out fails to compile
    const untyped: TableStage = { id: "sw", kind: "swiss", swiss: true, entrants: [], rules: tableRulesOf(CASCADE, CHESS) };
    expect(refusal(() => completeTableStage(untyped, []))?.message).toMatch(/names no swissDraw/);
  });

  it("X-SW-7 guards: an unplayed side on a fixture with no result, a forfeit side that did not lose, a forfeit whose winner or loser is not a seat → CONFIG_INVALID", () => {
    const s2 = sceneS2();
    const walked = s2.fixtures[0]!;
    const pair = walked.result!; // [A (home) paid the win, B (away) the loss]
    const swapped = (f: TableFixture): Scene => ({ ...s2, fixtures: s2.fixtures.map((x) => (x.id === walked.id ? f : x)) });
    const cases: Array<[string, () => unknown, RegExp]> = [
      // the producer names the WINNER's seat, or both seats of a won fixture: a forfeit-loss card would hold a win
      ["unplayed home on A's win", () => tableOf(swapped({ ...walked, unplayed: "home" })), /"A"'s round 1 is a forfeit_loss, but its result is a win/],
      ["unplayed both on A's win", () => tableOf(swapped({ ...walked, unplayed: "both" })), /"A"'s round 1 is a forfeit_loss, but its result is a win/],
      // …or the loser's seat of a fixture the other side won: the forfeit-win card would hold a loss
      ["unplayed away on B's win", () => tableOf(swapped({ ...board(CHESS, 1, "A", "B", "a"), unplayed: "away" })), /"A"'s round 1 is a forfeit_win, but its result is a loss/],
      // an unplayed side on a one-sided award (a bye is its own unplayed round, 16.2.1; it has no [home, away])
      ["unplayed on a bye", () => tableOf({ ...S1, fixtures: S1.fixtures.map((f) => (f.awardDelta ? { ...f, unplayed: "away" as const } : f)) }), /no \[home, away\] result/],
      // unplayedSidesOf: the forfeit's winner holds neither seat; its typed loser holds neither the other seat
      ["winner in neither seat", () => unplayedSidesOf(forfeit("X", "B"), false, pair), /is not a seat/],
      ["loser not the other seat", () => unplayedSidesOf(forfeit("A", "C"), false, pair), /is not a seat/],
    ];
    let checked = 0;
    for (const [what, run, message] of cases) {
      const got = refusal(run);
      expect(got?.code, what).toBe("CONFIG_INVALID");
      expect(got?.message, what).toMatch(message);
      checked++;
    }
    expect(checked).toBe(cases.length);
    // The positive pairs: S2 ranks; a pre-W2b award (no typed loser, its reason in `method`) is charged to the seat that is
    // not the winner's; a forfeit's caps read the scheduled opponent, never R, so a forfeit-only stage ranks with no rounds.
    expect(refusal(() => tableOf(s2))).toBeNull();
    expect(unplayedSidesOf({ kind: "award", winner: "A", method: "walkover" } as never, false, pair)).toBe("away");
    expect(unplayedSidesOf(forfeit("A", "B"), false, pair)).toBe("away");
    expect(refusal(() => tableOf({ ...s2, rounds: undefined }))).toBeNull();
  });

  it("X-SW-7 second call: ranking S2 twice gives identical rows and leaves its fixtures as they were", () => {
    const s2 = sceneS2();
    const before = JSON.stringify(s2.fixtures);
    const first = completeTableStage(stageOf(s2), s2.fixtures);
    const second = completeTableStage(stageOf(s2), s2.fixtures);
    expect(second).toStrictEqual(first);
    expect(first.tables.overall).toHaveLength(s2.entrants.length);
    expect(JSON.stringify(s2.fixtures)).toBe(before);
  });
});

/** The sets a best-of-N match is won on, ⌈N/2⌉, read off the cfg; undefined for a sport whose cfg names no `bestOf`. */
function setsToWinByRulebook(m: AnySportModule, rawCfg: unknown): number | undefined {
  const bestOf = (m.configSchema.parse(rawCfg) as { bestOf?: unknown }).bestOf;
  return typeof bestOf === "number" ? Math.ceil(bestOf / 2) : undefined;
}

/** The rule's [win, loss] for a clean sweep: its win and loss, or under a set-score map the "W-0" pair (else "*"). */
function cleanSweep(rule: PointsRule, setsToWin: number | undefined): readonly [number, number] {
  const map = rule.bySetScore;
  if (map === undefined) return [rule.win.regulation, rule.loss.regulation];
  if (setsToWin === undefined) throw new Error("a set-score map on a cfg with no bestOf");
  const pair = Object.hasOwn(map, `${setsToWin}-0`) ? map[`${setsToWin}-0`] : map["*"];
  if (pair === undefined) throw new Error(`the map prices neither ${setsToWin}-0 nor "*"`);
  return pair;
}

/** The app's `awardByeDelta`, step for step (points-w3-bye.test.ts): the typed bye, an init state with the phantom seat
 *  opposite the winner, the module's own standingsDelta, the stage rule's payout with nothing played; the winner's half. */
function paidBye(m: AnySportModule, rawCfg: unknown, rule: PointsRule, winner: EntrantId): StandingsDelta {
  const cfg = m.configSchema.parse(rawCfg);
  const outcome = MatchOutcome.parse({ kind: "award", winner, loser: null, reason: "bye" });
  const state = m.init(cfg, { home: { entrantId: winner, slots: [] }, away: { entrantId: "__bye__", slots: [] } });
  const raw = m.standingsDelta(outcome, cfg, { kind: "swiss" }, state) as FixtureResult;
  const pair = payout(outcome, decidedInFor(m, outcome), raw, false, rule, m.awardScoreKeys, setsToWinOf(m, cfg));
  const paid = pair.find((d) => d.entrantId === winner);
  if (paid === undefined) throw new Error(`${m.key}: the paid bye names no winner`);
  return paid;
}

/** A forfeit or a double walkover on a seated Swiss board, through the producer chain the app runs for a walked-over
 *  table fixture: the module's own standingsDelta over the fixture's two seats, the stage rule's payout with nothing
 *  played, and `unplayedSidesOf` — the one authority the app calls to fill `TableFixture.unplayed`. */
function walkedOver(m: AnySportModule, rawCfg: unknown, rule: PointsRule, round: number, home: EntrantId, away: EntrantId, outcome: MatchOutcome): TableFixture {
  const cfg = m.configSchema.parse(rawCfg);
  const state = m.init(cfg, { home: { entrantId: home, slots: [] }, away: { entrantId: away, slots: [] } });
  const raw = m.standingsDelta(outcome, cfg, { kind: "swiss" }, state) as FixtureResult;
  const result = payout(outcome, decidedInFor(m, outcome), raw, false, rule, m.awardScoreKeys, setsToWinOf(m, cfg));
  const unplayed = unplayedSidesOf(outcome, false, result);
  return { id: `r${round}-${home}-${away}`, roundNo: round, status: "walkover", result, ...(unplayed === undefined ? {} : { unplayed }) };
}

/** A played set-sport board: `games` [home, away] (the side that takes more games wins), each game 21-15 to its winner,
 *  as the sides' game and rally ledgers (`sets_*`, `points_*`); paid by the stage rule through the real payout. */
function setBoard(m: AnySportModule, rawCfg: unknown, rule: PointsRule, round: number, home: EntrantId, away: EntrantId, games: readonly [number, number]): TableFixture {
  const [hs, as] = games;
  const rallies = (won: number, lost: number) => 21 * won + 15 * lost;
  const side = (id: EntrantId, won: boolean, sw: number, sl: number): StandingsDelta => ({
    entrantId: id, played: 1, won: won ? 1 : 0, drawn: 0, lost: won ? 0 : 1, points: 0,
    metrics: { sets_won: sw, sets_lost: sl, points_won: rallies(sw, sl), points_lost: rallies(sl, sw) },
  });
  const homeWon = hs > as;
  const raw: FixtureResult = [side(home, homeWon, hs, as), side(away, !homeWon, as, hs)];
  const outcome = MatchOutcome.parse({ kind: "win", winner: homeWon ? home : away, loser: homeWon ? away : home });
  const cfg = m.configSchema.parse(rawCfg);
  const result = payout(outcome, decidedInFor(m, outcome), raw, true, rule, m.awardScoreKeys, setsToWinOf(m, cfg));
  return { id: `r${round}-${home}-${away}`, roundNo: round, status: "decided", result };
}

/** Each ranked row's entrant, in table order. */
const orderOf = (rows: readonly StandingsRow[]): EntrantId[] => rows.map((r) => r.entrantId);
/** The tie-break key that placed each named entrant. */
const splitKeys = (rows: readonly StandingsRow[], ids: readonly EntrantId[]): Record<EntrantId, string | undefined> =>
  Object.fromEntries(ids.map((id) => [id, rows.find((r) => r.entrantId === id)?.tieBreak?.key]));

// Scene H (X-SW-9, the T8 review m2 ruling): two level on points whose ONLY game was a forfeit. In each sport's own Swiss
// points, R = 2, built through the producers the app runs (`walkedOver`: the module's standingsDelta, the rule's payout,
// unplayedSidesOf):
//   R1: A v B, B forfeits (A is paid the win, W);  C v D, D forfeits (C is paid W).
//   R2: C v A, A forfeits (C is paid W);           B beats D (played).
//   Points: A = W + 0 = W, B = 0 + W = W, C = 2W, D = 0 + the rule's played loss (0, or table tennis's 1). A and B are
//   level in every sport (premise asserted, with W the rule's win), and between them stands only the round-1 forfeit.
//   A head-to-head step on the class {A, B}: on a Swiss stage their mini-table has no meeting, so it cannot split them and
//   lots decide (X-SW-7: a forfeit is not a meeting). On a league stage the forfeit IS their result (unchanged): A, paid the
//   win against B, ranks above B on the step.
function sceneH(m: AnySportModule, rawCfg: unknown, rule: PointsRule, cascade: readonly TiebreakerKey[]): Scene {
  return {
    rule, draw: swissDrawFactsOf(m, rawCfg), entrants: ["A", "B", "C", "D"], rounds: 2, cascade,
    fixtures: [
      walkedOver(m, rawCfg, rule, 1, "A", "B", forfeit("A", "B")), walkedOver(m, rawCfg, rule, 1, "C", "D", forfeit("C", "D")),
      walkedOver(m, rawCfg, rule, 2, "C", "A", forfeit("C", "A")), board(rule, 2, "B", "D", "h"),
    ],
  };
}
/** Scene H's positive pair: the same pairings, every game PLAYED except C v D. R1: A beats B, C v D (D forfeits).
 *  R2: C beats A, B beats D. A = W + L, B = L + W (L the rule's played loss), level in every sport; A beat B. */
function sceneHPlayed(m: AnySportModule, rawCfg: unknown, rule: PointsRule, cascade: readonly TiebreakerKey[]): Scene {
  return {
    rule, draw: swissDrawFactsOf(m, rawCfg), entrants: ["A", "B", "C", "D"], rounds: 2, cascade,
    fixtures: [
      board(rule, 1, "A", "B", "h"), walkedOver(m, rawCfg, rule, 1, "C", "D", forfeit("C", "D")),
      board(rule, 2, "C", "A", "h"), board(rule, 2, "B", "D", "h"),
    ],
  };
}
/** The three head-to-head steps, each pinned behind points and before lots: an h2h block, "between two", direct encounter. */
const H2H_CHAINS: readonly (readonly TiebreakerKey[])[] = [
  ["points", "h2h_points", "lots"],
  ["points", "h2h_two", "lots"],
  ["points", "direct", "lots"],
];
/** Scene H as a league stage: no Swiss ledger, the same fixtures paid by the sport's league rule. */
function leagueOf(s: Scene): TableStage {
  return { id: "lg", kind: "league", entrants: s.entrants, rules: tableRulesOf(s.cascade ?? CASCADE, s.rule), rngSeed: 7 };
}

describe("X-SW-9 the Swiss default chains on a real stage, and head-to-head on a Swiss stage (rulebook-W3 §5; T8 review m2)", () => {
  it("X-SW-9 badminton Swiss: two entrants level on points who never met split on Buchholz, not head-to-head", () => {
    // single-sport: badminton is the rulebook's set-sport case and production's one Swiss sport; defaults-sweep.test.ts
    // holds every sport's chain
    // The stage ranks by badminton's DECLARED Swiss default, through the one resolver (no order of its own, no pin).
    // Badminton's Swiss rule pays any win 2 and a loss 0 (premise below); R = 2; six entrants, nobody unplayed.
    //   R1: A beats B 2-0, C beats D 2-0, E beats F 2-0.   R2: A beats C 2-1, E beats B 2-0, D beats F 2-1.
    //   Points: A 4, E 4, C 2, D 2, B 0, F 0. A and E are level and never met; so are B and F.
    //   Buchholz (opponents' points): A = B 0 + C 2 = 2.  B = A 4 + E 4 = 8.  C = D 2 + A 4 = 6.  D = C 2 + F 0 = 2.
    //     E = F 0 + B 0 = 0.  F = E 4 + D 2 = 6.
    //   Cut-1 (no unplayed round, so each drops its lowest): A 2, B 4, C 4, D 2, E 0, F 4.
    //   Chain points → Buchholz Cut-1 → Buchholz → …: {A, E}: Cut-1 2 > 0, A above E.  {C, D}: Cut-1 4 > 2, C above D.
    //     {B, F}: Cut-1 4 = 4, then Buchholz 8 > 6, B above F. No head-to-head step is reached.
    //   Order: A, E, C, D, B, F.
    //   differential: the pre-W3 order (points, wins, set ratio, point ratio, h2h points) splits each pair on set ratio:
    //     A 4-1 against E 4-0 (unbeaten), so E above A; C 3-2 against D 2-3, C above D; B 0-4 against F 1-4, F above B:
    //     E, A, C, D, F, B.
    const m = builtinModules.find((x) => x.key === "badminton");
    if (m === undefined) throw new Error("badminton is not registered");
    const cfg = m.configSchema.parse({});
    const rule = m.tablePointsRule(cfg, "swiss");
    expect([rule.win.regulation, rule.loss.regulation], "premise: badminton's Swiss rule pays a win 2, a loss 0").toEqual([2, 0]);
    const resolve = (pinned: readonly TiebreakerKey[] | null) =>
      resolveTableRules({
        module: m, stageKind: "swiss", mergedCfg: cfg, stageOwn: { points: null, tiebreakers: null, crossGroup: null }, divisionTiebreakers: null,
        pinned: pinned === null ? null : { points: rule, tiebreakers: pinned, crossGroup: [], sources: { points: "migrated", tiebreakers: "migrated", crossGroup: "migrated" } },
      }).tiebreakers;
    const scene = (cascade: readonly TiebreakerKey[]): Scene => ({
      rule, draw: swissDrawFactsOf(m, cfg), entrants: ["A", "B", "C", "D", "E", "F"], rounds: 2, cascade,
      fixtures: [
        setBoard(m, cfg, rule, 1, "A", "B", [2, 0]), setBoard(m, cfg, rule, 1, "C", "D", [2, 0]), setBoard(m, cfg, rule, 1, "E", "F", [2, 0]),
        setBoard(m, cfg, rule, 2, "A", "C", [2, 1]), setBoard(m, cfg, rule, 2, "E", "B", [2, 0]), setBoard(m, cfg, rule, 2, "D", "F", [2, 1]),
      ],
    });
    const declared = scene(resolve(null));
    const met = (a: EntrantId, b: EntrantId) => declared.fixtures.some((f) => [f.result?.[0].entrantId, f.result?.[1].entrantId].sort().join() === [a, b].sort().join());
    expect([met("A", "E"), met("B", "F")], "premise: neither level pair met").toEqual([false, false]);
    const rows = tableOf(declared);
    expect(Object.fromEntries(rows.map((r) => [r.entrantId, r.points])), "premise: the hand points").toEqual({ A: 4, E: 4, C: 2, D: 2, B: 0, F: 0 });
    expect(column(declared, "buchholz")).toEqual({ A: 2, B: 8, C: 6, D: 2, E: 0, F: 6 });
    expect(column(declared, "buchholz_cut1")).toEqual({ A: 2, B: 4, C: 4, D: 2, E: 0, F: 4 });
    expect(orderOf(rows)).toEqual(["A", "E", "C", "D", "B", "F"]);
    expect(splitKeys(rows, ["A", "E", "C", "D", "B", "F"])).toEqual({ A: "buchholz_cut1", E: "buchholz_cut1", C: "buchholz_cut1", D: "buchholz_cut1", B: "buchholz", F: "buchholz" });
    expect(rows.some((r) => r.tieBreak?.key === "direct" || r.tieBreak?.key === "lots"), "no head-to-head step or lots decided anyone").toBe(false);
    // The differential, ranked: the same table under a stage pinned to the pre-W3 order (X-TB-2) splits on set ratio.
    const pre = tableOf(scene(resolve(["points", "wins", "set_ratio", "point_ratio", "h2h_points"])));
    expect(orderOf(pre)).toEqual(["E", "A", "C", "D", "F", "B"]);
    expect(splitKeys(pre, ["A", "E", "B", "F"])).toEqual({ A: "set_ratio", E: "set_ratio", B: "set_ratio", F: "set_ratio" });
  });

  it("X-SW-9 a forfeit is not a meeting for any head-to-head step: on a Swiss stage pinned to an h2h block, between-two or direct, two level on points whose only game was a forfeit are not split by it, and a played game between them still splits them (every sport; counted)", () => {
    let checked = 0;
    const perSport = new Map<string, number>();
    const n = forEachSport(({ module: m }) => {
      for (const { name, cfg } of declaredCfgs(m as never)) {
        const rule = m.tablePointsRule(m.configSchema.parse(cfg), "swiss");
        for (const cascade of H2H_CHAINS) {
          const where = `${m.key}/${name} [${cascade.join(", ")}]`;
          const s = sceneH(m, cfg, rule, cascade);
          expect(s.fixtures.map((f) => f.unplayed), `${where}: premise, the producer marks the three forfeits`).toEqual(["away", "away", "away", undefined]);
          const done = completeTableStage(stageOf(s), s.fixtures);
          const rows = done.tables.overall ?? [];
          const a = rows.find((r) => r.entrantId === "A");
          const b = rows.find((r) => r.entrantId === "B");
          expect(a?.points, `${where}: premise, A and B level on points`).toBe(b?.points);
          expect(a?.points, `${where}: premise, at the win`).toBe(rule.win.regulation);
          // differential: before X-SW-9 the h2h block and between-two read the forfeit as A's win: A above B, keyed to the step
          expect(splitKeys(rows, ["A", "B"]), where).toEqual({ A: "lots", B: "lots" });
          const lots = done.events.flatMap((e) => (e.type === "rank_lock_required" ? [[...e.group].sort()] : []));
          expect(lots, `${where}: a drawing of lots decides them`).toEqual([["A", "B"]]);
          // The positive pair: a PLAYED game between them is their meeting on the same Swiss stage, and the step splits it.
          const p = sceneHPlayed(m, cfg, rule, cascade);
          expect(p.fixtures.map((f) => f.unplayed), `${where} played: premise, one forfeit (C v D)`).toEqual([undefined, "away", undefined, undefined]);
          const played = completeTableStage(stageOf(p), p.fixtures);
          const prow = played.tables.overall ?? [];
          expect(prow.find((r) => r.entrantId === "A")?.points, `${where} played: premise, level`).toBe(prow.find((r) => r.entrantId === "B")?.points);
          const pids = orderOf(prow);
          expect(pids.indexOf("A"), `${where} played: A, who beat B, above B`).toBeLessThan(pids.indexOf("B"));
          expect(splitKeys(prow, ["A", "B"]), `${where} played`).toEqual({ A: cascade[1], B: cascade[1] });
          checked++;
          perSport.set(m.key, (perSport.get(m.key) ?? 0) + 1);
        }
      }
    });
    expect(n).toBe(builtinModules.length);
    expect(perSport.size, "every sport checked").toBe(n);
    expect(checked).toBeGreaterThanOrEqual(n * H2H_CHAINS.length);
  });

  it("X-SW-9 control: on a league stage the same forfeit IS their meeting, as before W3 — each head-to-head step ranks A, paid the win, above B (every sport; counted)", () => {
    let checked = 0;
    const perSport = new Map<string, number>();
    const n = forEachSport(({ module: m }) => {
      for (const { name, cfg } of declaredCfgs(m as never)) {
        const rule = m.tablePointsRule(m.configSchema.parse(cfg), "league");
        for (const cascade of H2H_CHAINS) {
          const where = `${m.key}/${name} [${cascade.join(", ")}]`;
          const s = sceneH(m, cfg, rule, cascade);
          expect(s.fixtures[0]?.unplayed, `${where}: premise, the fixture still says the forfeit was unplayed`).toBe("away");
          const done = completeTableStage(leagueOf(s), s.fixtures);
          const rows = done.tables.overall ?? [];
          const a = rows.find((r) => r.entrantId === "A");
          const b = rows.find((r) => r.entrantId === "B");
          expect(a?.points, `${where}: premise, A and B level on points`).toBe(b?.points);
          const ids = orderOf(rows);
          expect(ids.indexOf("A"), `${where}: A above B`).toBeLessThan(ids.indexOf("B"));
          expect(splitKeys(rows, ["A", "B"]), where).toEqual({ A: cascade[1], B: cascade[1] });
          expect(done.events.some((e) => e.type === "rank_lock_required"), `${where}: no lots`).toBe(false);
          checked++;
          perSport.set(m.key, (perSport.get(m.key) ?? 0) + 1);
        }
      }
    });
    expect(n).toBe(builtinModules.length);
    expect(perSport.size, "every sport checked").toBe(n);
    expect(checked).toBeGreaterThanOrEqual(n * H2H_CHAINS.length);
  });

  it("X-SW-9 guard: an unplayed result the table does not count (a copy, not the counted tuple) → CONFIG_INVALID, and so does one on a table with no Swiss ledger; the counted tuple itself ranks", () => {
    // single-sport: the guard reads tuple identity, never a sport's ledger; chess is S2's sport
    // The ranker reads `unplayedResults` by identity, so a set built from copies would skip nothing, silently. Refused.
    const s2 = sceneS2();
    const results = s2.fixtures.flatMap((f) => (f.result === undefined ? [] : [f.result]));
    const forfeited = s2.fixtures[0]?.result;
    if (forfeited === undefined) throw new Error("S2's round-1 board holds the forfeit");
    const rows = tableOf(s2);
    const ledger = buildSwissLedger(s2.entrants, ledgerFixtures(s2), { rounds: 2, drawPoints: 1 });
    const rank = (unplayed: ReadonlySet<FixtureResult>) => () =>
      rankStandings(rows, { cascade: ["points", "h2h_points", "lots"], results, swiss: ledger, pointsUnit: "half", unplayedResults: unplayed });
    const copy: FixtureResult = [{ ...forfeited[0] }, { ...forfeited[1] }];
    expect(refusal(rank(new Set([copy])))?.code).toBe("CONFIG_INVALID");
    expect(refusal(rank(new Set([copy])))?.message).toMatch(/not one of the table's counted results/);
    expect(refusal(rank(new Set([forfeited])))).toBeNull();
    expect(refusal(rank(new Set()))).toBeNull();
    // A league or group table reads a forfeit as the meeting it was paid as (the control above): the set is Swiss-only.
    const league = () => rankStandings(rows, { cascade: ["points", "h2h_points", "lots"], results, unplayedResults: new Set([forfeited]) });
    expect(refusal(league)?.code).toBe("CONFIG_INVALID");
    expect(refusal(league)?.message).toMatch(/only on a Swiss table/);
    expect(refusal(() => rankStandings(rows, { cascade: ["points", "h2h_points", "lots"], results }))).toBeNull();
  });
});
