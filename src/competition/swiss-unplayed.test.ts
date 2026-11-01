// W3 Task 7: the Swiss ledger by round (SW-M1, SW-L2, late entry; RB3-6 part 1). X-SW-7's own unplayed rounds, and
// X-SW-8. This is FIDE C.07 (2026) art. 16 as rulebook-W3-swiss.md §4 adopts it, scaled to the stage's table points:
//   - 16.2 names an unplayed round's category:
//     - 16.2.1 is a pairing-allocated bye.
//     - 16.2.3 is a zero-point round followed by at least one round that is not a VUR (a VUR is a requested bye or a
//       forfeit loss).
//     - 16.2.5 is one followed only by VURs, or in the last round.
//     - A late entrant's missed rounds are zero-point rounds (FIDE C.04.2 2.4; ruling 251).
//   - 16.3: as somebody else's opponent, categories 1-4 count at their real result, and 16.2.5 counts as a draw. That is
//     the ADJUSTED score: own score + D for each 16.2.5 round.
//   - 16.4.2: the entrant's OWN unplayed round is scored against a dummy at its own score, capped at D x R.
//   - D is the table's draw points, else half the win points (rulebook §4 "Non-chess scaling"; C.07 7.7). R is the
//     stage's rounds, never the length of the entrant's card.
//   - Sonneborn-Berger weighs each round's contribution win 2 / draw 1 / loss 0; a bye is a win (rulebook §4).
//   - Buchholz and SB are shown in the table's own points (SW-L2): half-points are halved only on a half-point table.
// Every expected number is derived by hand from those rules in the comment beside its test, never from the engine. Each
// `differential:` is what the pre-W3 engine gave (the superseded A6 virtual opponent: the player's score before the
// round + half a point per round to the end, with byes appended after every result and "rounds" = the card's length).
// Everything runs through the real consumer, completeTableStage, on hand-built TableFixtures.
import { describe, expect, it } from "vitest";
import { MatchOutcome, type EntrantId, type StandingsDelta } from "../core/types.ts";
import type { AnySportModule, TiebreakerKey } from "../sport/module.ts";
import { boardgame } from "../sports/boardgame/index.ts"; // single-sport: S1 and S4 are the rulebook's chess cases (C.07 is FIDE's); the every-sport test sweeps the registry
import { builtinModules } from "../sports/index.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { tableRulesOf } from "../testkit/helpers.ts";
import { decidedInFor } from "./decided-in.ts";
import { PointsRule, payout, setsToWinOf } from "./points.ts";
import { completeTableStage, type TableFixture, type TableStage } from "./stage.ts";
import type { FixtureResult, StandingsRow } from "./standings.ts";
import { buildSwissLedger, rankStandings, type SwissTable } from "./tiebreakers.ts";

/** Every Swiss column the ledger feeds, so each is materialised on every row. */
const CASCADE: TiebreakerKey[] = ["points", "buchholz_cut1", "buchholz", "sberger", "lots"];

/** FIDE's 1 / ½ / 0 in boardgame's half-points (chess.md §2): the sport's own declared Swiss rule, pinned in a test below. */
const CHESS = boardgame.tablePointsRule(boardgame.configSchema.parse({}), "swiss");
/** S5's custom stage rule: win 3, loss 0 and no draw, in whole points. */
const NO_DRAW = PointsRule.parse({ win: { regulation: 3 }, loss: { regulation: 0 }, shootoutAs: "result", unit: "whole", bonuses: [] });

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
}
function stageOf(s: Scene): TableStage {
  return {
    id: "sw", kind: "swiss", swiss: true, entrants: s.entrants, rules: tableRulesOf(CASCADE, s.rule), rngSeed: 7,
    ...(s.rounds === undefined ? {} : { rounds: s.rounds }),
    ...(s.absent === undefined ? {} : { swissAbsentRounds: s.absent }),
  };
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
  rule: CHESS, entrants: ["A", "B", "C", "D", "E"], rounds: 3,
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
  rule: CHESS, entrants: ["A", "B", "C", "L"], rounds: 3, absent: new Map([["L", [1]]]),
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
  rule: NO_DRAW, entrants: ["X", "Y", "Z"], rounds: 3,
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
/** The ledger fixtures a stage's counted fixtures map to (stage.ts does the same, with its guards). */
function ledgerFixtures(s: Scene) {
  return s.fixtures.map((f) => ({ round: f.roundNo!, ...(f.result ? { result: f.result } : {}), ...(f.awardDelta ? { award: f.awardDelta } : {}) }));
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

  it("X-SW-7 non-chess scale: X's dummy is min(9, 1.5×3) = 4.5 → Buchholz 6+3+4.5 = 13.5, displayed unhalved (SW-L2)", () => {
    const rows = rowsOf(S5);
    const bh = (id: EntrantId) => metricOf(rows, id, "buchholz");
    expect(bh("X")).toBe(13.5); // differential: today (6+3+7)/2 = 8
    expect(column(S5, "buchholz")).toEqual({ X: 13.5, Y: 16.5, Z: 18 });
    // SB in table points: 13.5 (today 2·(6+3+7)/4 = 8).
    expect(metricOf(rows, "X", "sberger")).toBe(13.5);
  });

  it("X-SW-7 every sport: a bye dummy is min(own, D×R) with D from the declared rule (draw, else ½ win) (counted)", () => {
    // Per sport and declared cfg, S5's shape in that sport's own Swiss points, each bye built as the app's one producer
    // builds it (`awardByeDelta`: the typed bye, the module's standingsDelta, the stage rule's payout). Expected, by hand
    // from rulebook §4: D = the rule's draw, else ½ x the win points (a set-score map's clean-sweep pair, design §5);
    // R = 3. X = win + win + bye, Y = loss + bye + win, Z = bye + loss + loss. Nobody is absent, so adjusted = score, and
    //   Buchholz X = Y + Z + min(X, 3D), Y = X + min(Y, 3D) + Z, Z = min(Z, 3D) + X + Y,
    // shown ÷ 2 on a half-point table and unhalved otherwise.
    let checked = 0;
    let capBound = 0; // the cap is below the entrant's score, so the min takes the cap
    let ownBound = 0; // the entrant's own score is the min
    const perSport = new Map<string, number>();
    const sports = forEachSport(({ module: m }) => {
      for (const { name, cfg } of declaredCfgs(m as never)) {
        const where = `${m.key}/${name}`;
        const parsed = m.configSchema.parse(cfg);
        const rule = m.tablePointsRule(parsed, "swiss");
        const sets = setsToWinByRulebook(m, cfg);
        const [win, loss] = cleanSweep(rule, sets);
        const d = rule.draw !== undefined ? rule.draw : win / 2;
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
        const rows = rowsOf({ rule, entrants: ["X", "Y", "Z"], rounds: 3, fixtures });
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
