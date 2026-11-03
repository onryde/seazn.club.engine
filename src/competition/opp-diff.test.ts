// W3 Task 9 (rulebook-W3-swiss.md §5 T10; ruling R15): `opp_diff`, the opponents' collective goal difference — the goals
// family's sixth Swiss key, after Buchholz (UEFA CL league phase, art. 18 order, A7: "superior collective goal difference
// of the league phase opponents"). An entrant's `opp_diff` is the sum, over its PLAYED cards, of that opponent's final goal
// difference as the table records it (`DIFF_KEYS`: gd, run_diff or diff). An unplayed card adds nothing: a bye, a forfeit
// win or loss, a double walkover and an absence (the FIDE C.07 (2026) 16.2 categories). That exclusion is a W3 product
// rule, consistent with X-SW-7's "a forfeit is not a meeting"; the T10 row records it. Higher ranks first. Swiss only
// (validateCascade rule 3) and only on a sport that records a goal difference (rule 2). It is no points unit, so it is
// never halved.
// W3 Task 10 (X-SW-9; FB-TB-5, HK-TB-3, IH-TB-3): the goals family's Swiss DEFAULT, rulebook §5's full chain (points,
// goal difference, goals for, wins, Buchholz, opp_diff, direct encounter, lots), reaches opp_diff on a real stage in each
// of the three sports (Scene G, the last block).
//
// Every expected number is derived by hand from those rules and from FB-WO-1 ("Football walkover = 3-0", FDC 2025 Art.
// 28.1) in the comment beside its scene, never from the engine. Everything ranks through the real consumer,
// completeTableStage, on fixtures the real producers make: football's own standingsDelta (a played board is its state at
// full time, the score and no cards; a walkover and a bye its award fold), the stage rule's payout and unplayedSidesOf.
// The shown value is read through the real display path (DERIVED_METRICS, derivedMetricText, and the tie what-if's
// tieKeyValue), so a key that ranked but printed nothing would fail here (inert-seam class 1).
import { describe, expect, it } from "vitest";
import { foldMatchWithStoppage, outcomeOf } from "../core/events.ts";
import { EngineError } from "../core/errors.ts";
import { MatchOutcome, StageKind, type EntrantId, type LineupPair, type StandingsDelta } from "../core/types.ts";
import type { AnySportModule, TiebreakerKey } from "../sport/module.ts";
import { boardgame } from "../sports/boardgame/index.ts"; // single-sport: chess is a sport that records no goal difference, the read side of rule 2's refusal
import { football } from "../sports/football/index.ts"; // single-sport: the hand-built goals stages are football's (FB-WO-1); the sport sweeps run over forEachSport
import { builtinModules } from "../sports/index.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { buildStream, lineupFromCatalog, tableRulesOf } from "../testkit/helpers.ts";
import { validateCascade, type CascadeContext, type CascadeRefusal } from "./cascade-rules.ts";
import { decidedInFor } from "./decided-in.ts";
import { DERIVED_METRICS, derivedMetricText } from "./display.ts";
import { payout, setsToWinOf, swissDrawFactsOf, unplayedSidesOf, type PointsRule } from "./points.ts";
import { completeTableStage, type TableFixture, type TableStage } from "./stage.ts";
import type { FixtureResult, StandingsRow } from "./standings.ts";
import { resolveTableRules } from "./table-rules.ts";
import { tieKeyValue } from "./tie-what-if.ts";
import { buildSwissLedger, DIFF_KEYS, rankStandings, type SwissTable } from "./tiebreakers.ts";

const SPORTS = builtinModules.length;
const KINDS = StageKind.options;
/** The goals family of rulebook §5's chains: "Goals (football, hockey, ice hockey)". */
// single-sport: the rulebook names these three; the registry sweep below must accept each of them
const GOALS_FAMILY = ["football", "hockey", "icehockey"] as const;

const FB_CFG = football.configSchema.parse({});
/** Football's own Swiss rule (pinned below: win 3, draw 1, loss 0, whole points). */
const FB_RULE: PointsRule = football.tablePointsRule(FB_CFG, "swiss");
const FB_DRAW = swissDrawFactsOf(football, {});

const seats = (home: EntrantId, away: EntrantId) => ({ home: { entrantId: home, slots: [] }, away: { entrantId: away, slots: [] } });
const paid = (outcome: MatchOutcome, raw: FixtureResult, played: boolean): FixtureResult =>
  payout(outcome, decidedInFor(football, outcome), raw, played, FB_RULE, football.awardScoreKeys, setsToWinOf(football, FB_CFG));

/** A played football board, `hg`-`ag` at full time: football's standingsDelta over its state holding that score (no
 *  cards), paid by the stage rule. */
function game(round: number, home: EntrantId, away: EntrantId, hg: number, ag: number): TableFixture {
  const state = { ...football.init(FB_CFG, seats(home, away)), goals: { home: hg, away: ag } };
  const outcome = MatchOutcome.parse(
    hg === ag ? { kind: "draw" } : { kind: "win", winner: hg > ag ? home : away, loser: hg > ag ? away : home, method: "regulation" },
  );
  return { id: `r${round}-${home}-${away}`, roundNo: round, status: "decided", result: paid(outcome, football.standingsDelta(outcome, FB_CFG, { kind: "swiss" }, state), true), unplayed: null };
}
/** A walkover on a seated board (`loser` never arrived): football's award fold (FB-WO-1), the rule's payout with nothing
 *  played, and unplayedSidesOf — the one authority the app fills `TableFixture.unplayed` from. */
function walkover(round: number, home: EntrantId, away: EntrantId, winner: EntrantId, loser: EntrantId): TableFixture {
  const outcome = MatchOutcome.parse({ kind: "award", winner, loser, reason: "walkover" });
  const result = paid(outcome, football.standingsDelta(outcome, FB_CFG, { kind: "swiss" }, football.init(FB_CFG, seats(home, away))), false);
  const unplayed = unplayedSidesOf(outcome, false, result);
  return { id: `r${round}-${home}-${away}`, roundNo: round, status: "walkover", result, unplayed };
}
/** A double walkover on a seated board (both sides absent, rulebook §4 M2): the same producer chain as `walkover`. X-DW-4
 *  credits nothing, so each side's goal difference moves by 0 here. */
function doubleWalkover(round: number, home: EntrantId, away: EntrantId): TableFixture {
  const outcome = MatchOutcome.parse({ kind: "double_walkover" });
  const result = paid(outcome, football.standingsDelta(outcome, FB_CFG, { kind: "swiss" }, football.init(FB_CFG, seats(home, away))), false);
  const unplayed = unplayedSidesOf(outcome, false, result);
  return { id: `r${round}-${home}-${away}`, roundNo: round, status: "walkover", result, unplayed };
}
/** A pairing-allocated bye as the app writes it (X-SW-5): the award fold opposite a phantom seat, the winner's half. */
function bye(round: number, entrant: EntrantId): TableFixture {
  const outcome = MatchOutcome.parse({ kind: "award", winner: entrant, loser: null, reason: "bye" });
  const raw = football.standingsDelta(outcome, FB_CFG, { kind: "swiss" }, football.init(FB_CFG, seats(entrant, "__bye__")));
  const awardDelta = paid(outcome, raw, false).find((d) => d.entrantId === entrant);
  if (awardDelta === undefined) throw new Error("the paid bye names no winner");
  return { id: `r${round}-bye-${entrant}`, roundNo: round, status: "walkover", awardDelta };
}

/** A Swiss ledger stage's absences when nobody was absent (final review m3: the stage names them, an empty map for none). */
const NOBODY_ABSENT: ReadonlyMap<EntrantId, readonly number[]> = new Map();

interface Scene {
  readonly entrants: readonly EntrantId[];
  readonly rounds: number;
  readonly fixtures: readonly TableFixture[];
  readonly absent?: ReadonlyMap<EntrantId, readonly number[]>;
  readonly cascade?: readonly TiebreakerKey[];
}
/** The goals chain's two keys this task can witness alone: points, then opp_diff, then lots. */
const OPP: readonly TiebreakerKey[] = ["points", "opp_diff", "lots"];
function stageOf(s: Scene): TableStage {
  return {
    id: "sw", kind: "swiss", swiss: true, swissDraw: FB_DRAW, entrants: s.entrants, rules: tableRulesOf(s.cascade ?? OPP, FB_RULE),
    rngSeed: 7, rounds: s.rounds, swissAbsentRounds: s.absent ?? NOBODY_ABSENT,
  };
}
function tableOf(s: Scene): readonly StandingsRow[] {
  const rows = completeTableStage(stageOf(s), s.fixtures).tables.overall;
  if (rows === undefined) throw new Error("a one-pool stage has an overall table");
  expect(rows, "anti-vacuity: one row per entrant").toHaveLength(s.entrants.length);
  return rows;
}
/** One number per entrant off the ranked rows, in the scene's entrant order. */
function column(rows: readonly StandingsRow[], read: (row: StandingsRow) => unknown): Record<EntrantId, unknown> {
  return Object.fromEntries(rows.map((row) => [row.entrantId, read(row)]));
}
const oppDiff = (row: StandingsRow): number | undefined => row.metrics["opp_diff"];
const gd = (row: StandingsRow): number | undefined => row.metrics["gd"];

/** A thrown EngineError, or null when the call returns. */
function refusal(f: () => unknown): EngineError | null {
  try {
    f();
  } catch (e) {
    if (e instanceof EngineError) return e;
    throw e;
  }
  return null;
}

// Scene F: a forfeit. Football's Swiss rule (win 3, draw 1, loss 0), R = 3.
//   R1: A v B, B walks over: A is awarded 3-0 (FB-WO-1), the board's cards are a forfeit win and a forfeit loss.
//       C 2-1 D.   R2: A 1-1 C, B 3-0 D.   R3: A 0-2 D, B 1-0 C.
//   Final goal difference (goals for − against, the walkover at its awarded 3-0):
//     A = +3 + 0 − 2 = +1.   B = −3 + 3 + 1 = +1.   C = +1 + 0 − 1 = 0.   D = −1 − 3 + 2 = −2.   (Σ = 0.)
//   Points: A 3 + 1 + 0 = 4, B 0 + 3 + 3 = 6, C 3 + 1 + 0 = 4, D 0 + 0 + 3 = 3.
//   opp_diff, over the PLAYED cards only (A's and B's round-1 cards are the forfeit):
//     A = C 0 + D −2 = −2.   B = D −2 + C 0 = −2.   C = D −2 + A +1 + B +1 = 0.   D = C 0 + B +1 + A +1 = +2.
//   differential: summing the forfeit card too gives A −2 + B 1 = −1 and B −2 + A 1 = −1; reading the opponents' points
//   instead of their goal difference gives A = C 4 + D 3 = 7.
//   Order on points → opp_diff → lots: B 6; A and C level on 4, and C's 0 is above A's −2; D 3. So B, C, A, D.
function sceneF(cascade?: readonly TiebreakerKey[]): Scene {
  return {
    entrants: ["A", "B", "C", "D"], rounds: 3, ...(cascade === undefined ? {} : { cascade }),
    fixtures: [
      walkover(1, "A", "B", "A", "B"), game(1, "C", "D", 2, 1),
      game(2, "A", "C", 1, 1), game(2, "B", "D", 3, 0),
      game(3, "A", "D", 0, 2), game(3, "B", "C", 1, 0),
    ],
  };
}

// Scene W: a withdrawal. Football's Swiss rule, R = 3. B withdraws after round 1 and is not paired again: rounds 2 and 3 are
// its zero-point rounds (C.07 16.1), declared absent; with three left, each later round has a bye (X-SW-5: the win
// points, no goal recorded).
//   R1: A 2-0 B, C 1-1 D.   R2: C 1-0 A, D bye.   R3: A 3-1 D, C bye.
//   Final goal difference: A = +2 − 1 + 2 = +3.  B = −2 (it played once).  C = 0 + 1 = +1.  D = 0 − 2 = −2.  (Σ = 0.)
//   opp_diff: A = B −2 + C +1 + D −2 = −3 (the withdrawn B stays A's opponent: its card was played).
//     B = A +3; its two absences add nothing → +3.   C = D −2 + A +3, the bye nothing → +1.   D = C +1 + A +3 → +4.
//   differential: dropping the withdrawn opponent gives A = +1 − 2 = −1.
function sceneW(): Scene {
  return {
    entrants: ["A", "B", "C", "D"], rounds: 3, absent: new Map([["B", [2, 3]]]),
    fixtures: [
      game(1, "A", "B", 2, 0), game(1, "C", "D", 1, 1),
      game(2, "C", "A", 1, 0), bye(2, "D"),
      game(3, "A", "D", 3, 1), bye(3, "C"),
    ],
  };
}

// Scene DW: a double walkover (rulebook §4 M2: both sides absent; each takes a forfeit_loss card). Football's Swiss rule, R = 2.
//   R1: A v B double walkover — each paid the loss, 0 points, and X-DW-4 credits nothing, so neither goal difference moves.
//       C 3-0 D.   R2: A 2-0 C, D 3-1 B.
//   Final goal difference: A = 0 + 2 = +2.  B = 0 − 2 = −2.  C = +3 − 2 = +1.  D = −3 + 2 = −1.  (Σ = 0.)
//   Points: A 0 + 3 = 3, B 0 + 0 = 0, C 3 + 0 = 3, D 0 + 3 = 3.
//   opp_diff, over the PLAYED cards only (both round-1 cards are unplayed):
//     A = C +1 = +1.   B = D −1 = −1.   C = D −1 + A +2 = +1.   D = C +1 + B −2 = −1.
//   A's and B's own final goal differences still feed their other opponents as the table records them: C reads A's +2,
//   D reads B's −2.
//   differential: counting the double-walkover card gives A = B −2 + C +1 = −1 and B = A +2 + D −1 = +1.
function sceneDW(): Scene {
  return {
    entrants: ["A", "B", "C", "D"], rounds: 2,
    fixtures: [doubleWalkover(1, "A", "B"), game(1, "C", "D", 3, 0), game(2, "A", "C", 2, 0), game(2, "D", "B", 3, 1)],
  };
}

describe("opp_diff — the opponents' collective goal difference (rulebook-W3 §5 T10, Swiss only)", () => {
  it("opp_diff empty case first: an entrant with no played card has 0", () => {
    // single-sport: football is the goals representative of the hand-built stages; the sport sweeps are below
    // Nothing counted yet: every card is empty, so every entrant's sum is over nothing — 0, and shown "0".
    const empty = tableOf({ entrants: ["A", "B", "C"], rounds: 1, fixtures: [{ id: "r1-A-B", roundNo: 1, status: "scheduled" }] });
    expect(column(empty, oppDiff)).toEqual({ A: 0, B: 0, C: 0 });
    expect(empty.map((row) => derivedMetricText(row, "opp_diff"))).toEqual(["0", "0", "0"]);
    // One round: A 2-0 B, C has the bye. C holds no played card (a bye has no opponent goals): 0. A reads B's −2, B A's +2.
    const one = tableOf({ entrants: ["A", "B", "C"], rounds: 1, fixtures: [game(1, "A", "B", 2, 0), bye(1, "C")] });
    expect(column(one, gd), "premise: the fold's goal difference").toEqual({ A: 2, B: -2, C: 0 });
    expect(column(one, oppDiff)).toEqual({ A: -2, B: 2, C: 0 });
    // An entrant whose only card is a forfeit (walked over, or awarded the walkover) holds no played card either: 0.
    const forfeitOnly = tableOf({ entrants: ["A", "B"], rounds: 1, fixtures: [walkover(1, "A", "B", "A", "B")] });
    expect(column(forfeitOnly, gd), "premise: the walkover is 3-0 (FB-WO-1)").toEqual({ A: 3, B: -3 });
    expect(column(forfeitOnly, oppDiff)).toEqual({ A: 0, B: 0 }); // differential: reading the forfeit card gives A −3, B +3
  });

  it("opp_diff = Σ played opponents' final GD, forfeits excluded", () => {
    // single-sport: football is the goals representative (FB-WO-1 prices the forfeit); the sport sweeps are below
    expect([FB_RULE.win.regulation, FB_RULE.draw, FB_RULE.loss.regulation, FB_RULE.unit], "premise: football's Swiss rule").toEqual([3, 1, 0, "whole"]);
    const f = sceneF();
    expect(f.fixtures[0]?.unplayed, "premise: the producer marks the side that never arrived").toBe("away");
    const rows = tableOf(f);
    expect(column(rows, gd), "premise: the hand goal differences, the walkover at 3-0").toEqual({ A: 1, B: 1, C: 0, D: -2 });
    expect(column(rows, (r) => r.points), "premise: the hand points").toEqual({ A: 4, B: 6, C: 4, D: 3 });
    // differential: the forfeit card summed gives A −1, B −1; the opponents' points give A 7
    expect(column(rows, oppDiff)).toEqual({ A: -2, B: -2, C: 0, D: 2 });
    // Higher first: A and C are level on points, and C's 0 ranks above A's −2, the split traced to opp_diff.
    expect(rows.map((r) => r.entrantId)).toEqual(["B", "C", "A", "D"]);
    expect(rows.filter((r) => r.entrantId === "A" || r.entrantId === "C").map((r) => [r.entrantId, r.tieBreak?.key])).toEqual([
      ["C", "opp_diff"],
      ["A", "opp_diff"],
    ]);
    // The pair: without opp_diff, A and C go to lots (a drawing of lots, not the key, decides them).
    const lots = tableOf(sceneF(["points", "lots"]));
    expect(lots.filter((r) => r.entrantId === "A" || r.entrantId === "C").map((r) => r.tieBreak?.key)).toEqual(["lots", "lots"]);
    expect(lots.every((r) => r.metrics["opp_diff"] === undefined), "no column where the order does not hold the key").toBe(true);
  });

  it("opp_diff second call: ranking the same stage twice gives identical rows, and neither call writes to its input", () => {
    // single-sport: football is the goals representative; the sport sweeps are below
    const f = sceneF();
    const before = JSON.stringify(f.fixtures);
    const first = completeTableStage(stageOf(f), f.fixtures);
    const second = completeTableStage(stageOf(f), f.fixtures);
    expect(second).toStrictEqual(first);
    expect(column(first.tables.overall ?? [], oppDiff)).toEqual({ A: -2, B: -2, C: 0, D: 2 });
    expect(JSON.stringify(f.fixtures)).toBe(before);
    // and re-ranking the ranked rows (they now carry their opp_diff column) gives the same column
    const again = rankStandings(first.tables.overall ?? [], {
      cascade: OPP, swiss: ledgerOf(f), pointsUnit: "whole", rngSeed: 7, countedFixtures: f.fixtures.length,
    }).rows;
    expect(column(again, oppDiff)).toEqual({ A: -2, B: -2, C: 0, D: 2 });
  });

  it("opp_diff after a withdrawal: the withdrawn opponent's played card still counts; its own absent rounds add nothing", () => {
    // single-sport: football is the goals representative; the sport sweeps are below
    const w = sceneW();
    const ledger = ledgerOf(w);
    expect(
      Object.fromEntries(ledger.map((row) => [row.entrant, row.games.map((g) => g.unplayed ?? "played")])),
      "premise: B's rounds 2 and 3 are its absences, C's and D's byes are unplayed",
    ).toEqual({ A: ["played", "played", "played"], B: ["played", "absent_last", "absent_last"], C: ["played", "played", "bye"], D: ["played", "bye", "played"] });
    const rows = tableOf(w);
    expect(column(rows, gd), "premise: the hand goal differences").toEqual({ A: 3, B: -2, C: 1, D: -2 });
    // differential: dropping the withdrawn B from A's opponents gives A −1
    expect(column(rows, oppDiff)).toEqual({ A: -3, B: 3, C: 1, D: 4 });
  });

  it("opp_diff after a double walkover: neither side's card counts; both sides' final GD still feeds their other opponents", () => {
    // single-sport: football is the goals representative; the sport sweeps are below
    const d = sceneDW();
    expect(d.fixtures[0]?.unplayed, "premise: the producer marks both sides").toBe("both");
    const roundOne = ledgerOf(d).flatMap((row) =>
      row.games.filter((g) => g.round === 1 && (row.entrant === "A" || row.entrant === "B")).map((g) => [row.entrant, g.opponent, g.unplayed]),
    );
    expect(roundOne, "premise: both round-1 cards are forfeit losses (rulebook §4 M2)").toEqual([["A", "B", "forfeit_loss"], ["B", "A", "forfeit_loss"]]);
    const rows = tableOf(d);
    expect(column(rows, gd), "premise: the hand goal differences, the double walkover moving neither (X-DW-4)").toEqual({ A: 2, B: -2, C: 1, D: -1 });
    expect(column(rows, (r) => r.points), "premise: the hand points").toEqual({ A: 3, B: 0, C: 3, D: 3 });
    // differential: counting the double-walkover card gives A −1, B +1
    expect(column(rows, oppDiff)).toEqual({ A: 1, B: -1, C: 1, D: -1 });
    expect(column(rows, (r) => derivedMetricText(r, "opp_diff"))).toEqual({ A: "1", B: "-1", C: "1", D: "-1" });
  });

  it("opp_diff is shown: a DERIVED_METRICS column beside Buchholz, printed by derivedMetricText as the ranker materialised it", () => {
    // single-sport: football is the goals representative; the column list is sport-agnostic
    const specs = DERIVED_METRICS.filter((m) => m.key === "opp_diff");
    expect(specs, "exactly one opp_diff column").toHaveLength(1);
    const spec = specs[0];
    expect(spec?.label.trim(), "a header to print").not.toBe("");
    // Rule 2 admits the key on every sport recording any DIFF_KEYS alias, so the header names no one family's unit: it
    // takes the neutral difference form of its neighbours ("Diff", "Pts diff"), never "GD" or "runs".
    const aliases = new Set<string>();
    forEachSport(({ module }) => {
      for (const alias of DIFF_KEYS) if (module.metrics.some((m) => m.key === alias)) aliases.add(alias);
    });
    expect(aliases.size, "premise: more than one family's difference reaches this column").toBeGreaterThan(1);
    expect(spec?.label).toMatch(/\bdiff\b/i);
    expect(spec?.label, "a goal-only or run-only header").not.toMatch(/\bGD\b|goal|run/i);
    expect(spec?.decimals, "a goal difference is a whole number").toBe(0);
    const keys = DERIVED_METRICS.map((m) => m.key);
    expect(keys.indexOf("opp_diff"), "directly after Buchholz, its neighbour in the goals chain").toBe(keys.indexOf("buchholz") + 1);
    // The real display path, on scene F's ranked rows: the cell, and the tie what-if's "yours / theirs" value.
    const rows = tableOf(sceneF());
    expect(column(rows, (r) => derivedMetricText(r, "opp_diff"))).toEqual({ A: "-2", B: "-2", C: "0", D: "2" });
    expect(column(rows, (r) => tieKeyValue(r, "opp_diff"))).toEqual({ A: "-2", B: "-2", C: "0", D: "2" });
    // Swiss only, read side: a league stage holding the key neither splits on it nor shows it (no ledger to read).
    const league: TableStage = { id: "lg", kind: "league", entrants: ["A", "B", "C", "D"], rules: tableRulesOf(OPP, FB_RULE), rngSeed: 7 };
    const leagueRows = completeTableStage(league, sceneF().fixtures).tables.overall ?? [];
    expect(leagueRows).toHaveLength(4);
    expect(leagueRows.map((r) => derivedMetricText(r, "opp_diff"))).toEqual([null, null, null, null]);
    expect(leagueRows.filter((r) => r.entrantId === "A" || r.entrantId === "C").map((r) => r.tieBreak?.key)).toEqual(["lots", "lots"]);
  });

  it("opp_diff is never halved: a goal difference is no points unit, so a half-point table shows the same column", () => {
    // single-sport: the unit is the table's, not the sport's; scene F's ledger and rows stand for any goals table
    const f = sceneF();
    const rows = tableOf(f);
    const ledger = ledgerOf(f);
    const cascade: TiebreakerKey[] = ["points", "buchholz", "opp_diff", "lots"];
    const [whole, half] = (["whole", "half"] as const).map((pointsUnit) => rankStandings(rows, { cascade, swiss: ledger, pointsUnit, rngSeed: 7 }).rows);
    // the witness that the unit is read at all: Buchholz halves on the half-point table
    expect(column(half ?? [], (r) => r.metrics["buchholz"])).not.toEqual(column(whole ?? [], (r) => r.metrics["buchholz"]));
    // differential: halving gives A −1, D 1
    expect(column(half ?? [], oppDiff)).toEqual({ A: -2, B: -2, C: 0, D: 2 });
    expect(column(whole ?? [], oppDiff)).toEqual({ A: -2, B: -2, C: 0, D: 2 });
    expect(column(half ?? [], (r) => derivedMetricText(r, "opp_diff"))).toEqual({ A: "-2", B: "-2", C: "0", D: "2" });
  });

  it("opp_diff outside swiss → stage_format refusal; on a sport with no diff ledger → sport refusal (validateCascade)", () => {
    // Rule 3 (Swiss only) and rule 2 (the sport records the ledger the step reads, `DIFF_KEYS`), over every sport and kind.
    // Whether a sport records a goal difference is read from its own declared metrics, never from the validator.
    let checked = 0;
    let stageFormat = 0;
    let sport = 0;
    const n = forEachSport(({ module }) => {
      for (const stageKind of KINDS) {
        const want: CascadeRefusal[] = [];
        if (!recordsDiff(module)) want.push({ index: 1, key: "opp_diff", reason: "sport", need: "gd or run_diff or diff" });
        if (stageKind !== "swiss") want.push({ index: 1, key: "opp_diff", reason: "stage_format", need: "swiss" });
        expect(sorted(validateCascade([module.primaryTableKey, "opp_diff", "lots"], ctxOf(module, stageKind))), `${module.key} ${stageKind}`).toEqual(sorted(want));
        if (stageKind !== "swiss") stageFormat++;
        if (!recordsDiff(module)) sport++;
        checked++;
      }
    });
    expect(n).toBe(SPORTS);
    expect(checked).toBe(SPORTS * KINDS.length);
    expect(stageFormat, "anti-vacuity: refused outside swiss").toBe(SPORTS * (KINDS.length - 1));
    expect(sport, "anti-vacuity: some sport records no goal difference").toBeGreaterThan(0);
    expect(sport, "…and some does").toBeLessThan(SPORTS * KINDS.length);
  });

  it("opp_diff every goals sport accepts it on swiss (football, hockey, icehockey; counted)", () => {
    const accepted: string[] = [];
    const n = forEachSport(({ key, module }) => {
      const got = validateCascade([module.primaryTableKey, "opp_diff", "lots"], ctxOf(module, "swiss"));
      expect(got.length === 0, `${key}: accepted iff it records a goal difference`).toBe(recordsDiff(module));
      if (got.length === 0) accepted.push(key);
    });
    expect(n).toBe(SPORTS);
    for (const goals of GOALS_FAMILY) expect(accepted, `rulebook §5's goals family: ${goals}`).toContain(goals);
    expect(accepted.length, "anti-vacuity: the goals family at least").toBeGreaterThanOrEqual(GOALS_FAMILY.length);
  });

  it("opp_diff reads each sport's own goal-difference alias through its real fold (gd, run_diff, diff; counted)", () => {
    // Every sport that records a goal difference: one real generated win, H over A, through the module's own fold, its
    // standingsDelta and its Swiss rule's payout, ranked on a one-round Swiss stage. Each side's opp_diff is the OTHER
    // side's row, read under the sport's own declared alias.
    const aliases = new Set<string>();
    let checked = 0;
    const n = forEachSport(({ key, module: m }) => {
      const alias = DIFF_KEYS.find((k) => m.metrics.some((metric) => metric.key === k));
      if (alias === undefined) return;
      const raw = (declaredCfgs(m)[0] as { cfg: unknown }).cfg;
      const cfg = m.configSchema.parse(raw);
      const result = playedWin(m, cfg);
      expect(result, `${key}: a real played win within the seeds tried`).not.toBeNull();
      if (result === null) return;
      const rule = m.tablePointsRule(cfg, "swiss");
      const stage: TableStage = {
        id: "sw", kind: "swiss", swiss: true, swissDraw: swissDrawFactsOf(m, raw), entrants: ["H", "A"],
        rules: tableRulesOf(OPP, rule), rngSeed: 7, rounds: 1, swissAbsentRounds: NOBODY_ABSENT,
      };
      const rows = completeTableStage(stage, [{ id: "r1", roundNo: 1, status: "decided", result, unplayed: null }]).tables.overall ?? [];
      const by = new Map(rows.map((r) => [r.entrantId, r]));
      const diffOf = (id: EntrantId): number | undefined => by.get(id)?.metrics[alias];
      expect(diffOf("H"), `${key}: the winner's ${alias} is recorded and not 0, so a misread shows`).not.toBe(0);
      expect(diffOf("H"), key).toBeTypeOf("number");
      expect([by.get("H")?.metrics["opp_diff"], by.get("A")?.metrics["opp_diff"]], `${key} (${alias})`).toEqual([diffOf("A"), diffOf("H")]);
      aliases.add(alias);
      checked++;
    });
    expect(n).toBe(SPORTS);
    expect(checked, "anti-vacuity: every sport recording a goal difference").toBe(builtinModules.filter(recordsDiff).length);
    expect(checked).toBeGreaterThanOrEqual(GOALS_FAMILY.length);
    // every alias the comparator reads is some sport's own
    expect([...aliases].sort()).toEqual([...DIFF_KEYS].sort());
  });

  it("opp_diff guards: a played card with no opponent, an opponent with no row, an opponent whose row records no goal difference → CONFIG_INVALID", () => {
    // single-sport: each refusal needs one ledger; chess is the sport with no goal difference (the real-path refusal)
    const row = (id: EntrantId, metrics: Record<string, number>): StandingsRow => ({ entrantId: id, played: 1, won: 0, drawn: 0, lost: 0, points: 0, metrics });
    const rank = (rows: readonly StandingsRow[], swiss: SwissTable) => () => rankStandings(rows, { cascade: OPP, swiss, pointsUnit: "whole", rngSeed: 7 });
    // A played card (no `unplayed`) that names nobody: a ledger the stage did not build.
    const noOpponent: SwissTable = [{ entrant: "A", score: 0, games: [{ round: 1, opponent: null, result: "loss", scored: 0 }] }];
    const e1 = refusal(rank([row("A", { gd: 0 })], noOpponent));
    expect([e1?.code, e1?.data]).toEqual(["CONFIG_INVALID", { entrantId: "A", round: 1 }]);
    expect(e1?.message).toMatch(/names no opponent/);
    // An opponent with no row in the table being ranked: the ledger and the table were built from different entrants.
    const ghost: SwissTable = [{ entrant: "A", score: 3, games: [{ round: 1, opponent: "Z", result: "win", scored: 3 }] }];
    const e2 = refusal(rank([row("A", { gd: 1 })], ghost));
    expect([e2?.code, e2?.data]).toEqual(["CONFIG_INVALID", { entrantId: "A", opponent: "Z" }]);
    // An opponent whose row records no goal difference: chess, through the real path (validateCascade refuses the order
    // on the write side, rule 2; this is the ranker's own refusal, never a silent 0).
    expect(recordsDiff(boardgame), "premise: chess records no goal difference").toBe(false);
    const chessRule = boardgame.tablePointsRule(boardgame.configSchema.parse({}), "swiss");
    const side = (id: EntrantId, won: number, points: number): StandingsDelta => ({ entrantId: id, played: 1, won, drawn: 0, lost: 1 - won, points, metrics: {} });
    const chess = (cascade: readonly TiebreakerKey[]): TableStage => ({
      id: "sw", kind: "swiss", swiss: true, swissDraw: swissDrawFactsOf(boardgame, {}), entrants: ["A", "B"], rules: tableRulesOf(cascade, chessRule), rngSeed: 7, rounds: 1, swissAbsentRounds: NOBODY_ABSENT,
    });
    const fixtures: TableFixture[] = [{ id: "r1", roundNo: 1, status: "decided", result: [side("A", 1, chessRule.win.regulation), side("B", 0, chessRule.loss.regulation)], unplayed: null }];
    const e3 = refusal(() => completeTableStage(chess(OPP), fixtures));
    expect([e3?.code, e3?.data]).toEqual(["CONFIG_INVALID", { entrantId: "A", opponent: "B", need: "gd or run_diff or diff" }]);
    expect(e3?.message).toMatch(/records no goal difference/);
    // The positive pairs: the same chess stage ranks without the key, and each football ledger above ranks with a real one.
    expect(refusal(() => completeTableStage(chess(["points", "lots"]), fixtures))).toBeNull();
    const fine: SwissTable = [
      { entrant: "A", score: 3, games: [{ round: 1, opponent: "B", result: "win", scored: 3 }] },
      { entrant: "B", score: 0, games: [{ round: 1, opponent: "A", result: "loss", scored: 0 }] },
    ];
    const ok = rankStandings([row("A", { gd: 1 }), row("B", { gd: -1 })], { cascade: OPP, swiss: fine, pointsUnit: "whole", rngSeed: 7 }).rows;
    expect(column(ok, oppDiff)).toEqual({ A: -1, B: 1 });
  });
});

const recordsDiff = (module: AnySportModule): boolean => module.metrics.some((m) => (DIFF_KEYS as readonly string[]).includes(m.key));
const ctxOf = (module: AnySportModule, stageKind: StageKind): CascadeContext => ({
  module, cfg: (declaredCfgs(module)[0] as { cfg: unknown }).cfg, stageKind, crossGroup: false,
});
/** Refusals in a fixed order (index, then reason): the test pins the SET of faults, not the validator's emit order. */
const sorted = (refusals: readonly CascadeRefusal[]): CascadeRefusal[] => [...refusals].sort((a, b) => a.index - b.index || a.reason.localeCompare(b.reason));

/** The Swiss ledger a scene's counted fixtures build, as completeTableStage builds it (stage.ts `swissLedgerOf`). */
function ledgerOf(s: Scene): SwissTable {
  const counted = s.fixtures.filter((f) => f.status === "decided" || f.status === "walkover");
  return buildSwissLedger(
    s.entrants,
    counted.map((f) => ({
      round: f.roundNo as number,
      ...(f.result === undefined ? {} : { result: f.result }),
      ...(f.awardDelta === undefined ? {} : { award: f.awardDelta }),
      ...(f.unplayed == null ? {} : { unplayed: f.unplayed }),
    })),
    { rounds: s.rounds, drawPoints: FB_RULE.draw, ...(s.absent === undefined ? {} : { absent: s.absent }) },
  );
}

/** A real decided win of H over A from the module's own generator and fold (no forfeit, no abandon): its standingsDelta
 *  pair. Null when no seed tried yields one. */
function playedWin(m: AnySportModule, cfg: unknown): FixtureResult | null {
  const lineups: LineupPair = { home: lineupFromCatalog(m.positions, "H"), away: lineupFromCatalog(m.positions, "A") };
  for (let seed = 1; seed <= 60; seed++) {
    const stream = buildStream(m as never, cfg as never, lineups, seed, 400);
    if (stream.some((e) => e.type === "core.forfeit" || e.type === "core.abandon")) continue;
    const folded = foldMatchWithStoppage(m as never, cfg as never, lineups, stream);
    const outcome = outcomeOf(m as never, folded as never);
    if (outcome?.kind !== "win" || outcome.winner !== "H") continue;
    const raw = m.standingsDelta(outcome, cfg, { kind: "swiss" }, folded.state) as FixtureResult;
    return payout(outcome, decidedInFor(m, outcome), raw, true, m.tablePointsRule(cfg, "swiss"), m.awardScoreKeys, setsToWinOf(m, cfg));
  }
  return null;
}

// Scene G (X-SW-9; FB-TB-5, HK-TB-3, IH-TB-3): the goals family's full Swiss default reaches opp_diff. In each goals sport,
// every board a played regulation win (a win pays 3, premise asserted), R = 2, six entrants, nobody unplayed:
//   R1: X 1-0 P, Y 1-0 R, S 1-0 Q.   R2: Q 1-0 X, S 1-0 Y, P 5-0 R.
//   Points: S 6; X, Y, P, Q 3 each; R 0.
//   Goals for − against: X 1−1 = 0, Y 1−1 = 0, P 5−1 = +4, Q 1−1 = 0, R 0−6 = −6, S 2−0 = +2.   Wins: S 2, R 0, others 1.
//   Buchholz (opponents' points): X = P 3 + Q 3 = 6, Y = R 0 + S 6 = 6, Q = S 6 + X 3 = 9, P = X 3 + R 0 = 3,
//     S = Q 3 + Y 3 = 6, R = Y 3 + P 3 = 6.
//   opp_diff (opponents' final goal difference, every card played): X = P +4 + Q 0 = +4, Y = R −6 + S +2 = −4,
//     P = X 0 + R −6 = −6, Q = S +2 + X 0 = +2, S = Q 0 + Y 0 = 0, R = Y 0 + P +4 = +4.
//   The chain on {X, Y, P, Q}: goal difference lifts P (+4); X, Y, Q are level on it (0), on goals for (1) and on wins
//   (1); Buchholz lifts Q (9); X and Y are level on Buchholz (6) and split on opp_diff, X above Y. No direct encounter
//   (X and Y never met) or lots is reached.
//   Order: S, P, Q, X, Y, R.
//   differential: a chain without opp_diff leaves X and Y to direct encounter, which has no game between them, and so to
//   lots.
const GOALS_G: readonly (readonly [number, EntrantId, EntrantId, number, number])[] = [
  [1, "X", "P", 1, 0], [1, "Y", "R", 1, 0], [1, "S", "Q", 1, 0],
  [2, "Q", "X", 1, 0], [2, "S", "Y", 1, 0], [2, "P", "R", 5, 0],
];

describe("X-SW-9 the goals family's full Swiss default reaches opp_diff (rulebook-W3 §5; FB-TB-5, HK-TB-3, IH-TB-3)", () => {
  it("FB-TB-5 HK-TB-3 IH-TB-3 X-SW-9 the full goals Swiss default reaches opp_diff: level on points, goal difference, goals for, wins and Buchholz, X and Y split on their opponents' goal difference (each goals sport; counted)", () => {
    let checked = 0;
    for (const key of GOALS_FAMILY) {
      const m = builtinModules.find((x) => x.key === key);
      if (m === undefined) throw new Error(`${key} is not registered`);
      const raw = (declaredCfgs(m)[0] as { cfg: unknown }).cfg;
      const cfg = m.configSchema.parse(raw);
      const rule = m.tablePointsRule(cfg, "swiss");
      // The stage ranks by the sport's DECLARED Swiss default, through the one resolver (no order of its own, no pin).
      const tiebreakers = resolveTableRules({
        module: m, stageKind: "swiss", mergedCfg: cfg, stageOwn: { points: null, tiebreakers: null, crossGroup: null }, divisionTiebreakers: null, pinned: null,
      }).tiebreakers;
      // A played board: the sport's own standingsDelta over its state at full time holding the score, paid by the rule.
      const board = ([round, home, away, hg, ag]: readonly [number, EntrantId, EntrantId, number, number]): TableFixture => {
        const state = { ...m.init(cfg, seats(home, away)), goals: { home: hg, away: ag } };
        const outcome = MatchOutcome.parse({ kind: "win", winner: hg > ag ? home : away, loser: hg > ag ? away : home, method: "regulation" });
        const deltas = m.standingsDelta(outcome, cfg, { kind: "swiss" }, state as never) as FixtureResult;
        const result = payout(outcome, decidedInFor(m, outcome), deltas, true, rule, m.awardScoreKeys, setsToWinOf(m, cfg));
        return { id: `r${round}-${home}-${away}`, roundNo: round, status: "decided", result, unplayed: null };
      };
      const stage = (order: readonly TiebreakerKey[]): TableStage => ({
        id: "sw", kind: "swiss", swiss: true, swissDraw: swissDrawFactsOf(m, raw), entrants: ["X", "Y", "P", "Q", "R", "S"],
        rules: tableRulesOf(order, rule), rngSeed: 7, rounds: 2, swissAbsentRounds: NOBODY_ABSENT,
      });
      const fixtures = GOALS_G.map(board);
      const rows = completeTableStage(stage(tiebreakers), fixtures).tables.overall ?? [];
      expect(rows, `${key}: anti-vacuity, one row per entrant`).toHaveLength(6);
      const alias = DIFF_KEYS.find((k) => m.metrics.some((metric) => metric.key === k));
      if (alias === undefined) throw new Error(`${key} records no goal difference`);
      expect(rule.win.regulation, `${key}: premise, a regulation win pays 3`).toBe(3);
      expect(column(rows, (r) => r.points), `${key}: premise, the hand points`).toEqual({ S: 6, X: 3, Y: 3, P: 3, Q: 3, R: 0 });
      expect(column(rows, (r) => r.metrics[alias]), `${key}: premise, the hand goal difference (${alias})`).toEqual({ S: 2, X: 0, Y: 0, P: 4, Q: 0, R: -6 });
      expect(column(rows, (r) => r.metrics["buchholz"]), key).toEqual({ S: 6, X: 6, Y: 6, P: 3, Q: 9, R: 6 });
      expect(column(rows, oppDiff), key).toEqual({ S: 0, X: 4, Y: -4, P: -6, Q: 2, R: 4 });
      expect(rows.map((r) => r.entrantId), key).toEqual(["S", "P", "Q", "X", "Y", "R"]);
      expect(Object.fromEntries(rows.filter((r) => r.entrantId !== "S" && r.entrantId !== "R").map((r) => [r.entrantId, r.tieBreak?.key])), key).toEqual({
        P: "diff", Q: "buchholz", X: "opp_diff", Y: "opp_diff",
      });
      // differential: the same chain without opp_diff hands X and Y to direct encounter, then to lots
      const without = completeTableStage(stage(tiebreakers.filter((k) => k !== "opp_diff")), fixtures).tables.overall ?? [];
      expect(without.filter((r) => r.entrantId === "X" || r.entrantId === "Y").map((r) => r.tieBreak?.key), key).toEqual(["lots", "lots"]);
      checked++;
    }
    expect(checked, "the goals family").toBe(GOALS_FAMILY.length);
  });
});
