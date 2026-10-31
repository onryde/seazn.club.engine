// W3 Task 5 — X-SW-5 (owner ruling 251; rulebook RB3-7(a); the SW-M6 remainder). A pairing-allocated bye pays the
// stage's win points, in every sport: under a points rule keyed by set score, the clean-sweep score's points. It never
// pays the rule's forfeit row and never earns a bonus, and it records no set, game, point, goal or run for or against.
// Ruling 251 replaces the W2c reading "a bye keeps the forfeit row's points" (points-w2c.test.ts, re-pointed here).
//
// The bye is built exactly as the app's one producer builds it — apps/web `src/server/engine-db/competition.ts`
// `awardByeDelta`: the TYPED bye (`byeAward`: no loser, reason "bye"), the cfg parsed, an `init` state with the phantom
// seat opposite the winner, the module's own `standingsDelta`, then `payout(bye, decidedInFor(bye), pair, false, rule,
// awardScoreKeys, setsToWinOf(cfg))` — nothing played, as a bye is written with no event — and the winner's half kept.
//
// Expected values come from the rule row and the rule's OWN fields — each sport's DECLARED rule
// (`tablePointsRule(cfg, "swiss")`) or a custom rule typed here — never from `payout`. The clean sweep of a best-of-N
// set match is ⌈N/2⌉-0, the sets a best-of-N match is won on (the rulebook's arithmetic, read off `cfg.bestOf`).
import { describe, expect, it } from "vitest";
import { MatchOutcome, type StandingsDelta } from "../core/types.ts";
import type { AnySportModule } from "../sport/module.ts";
import { builtinModules } from "../sports/index.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { defaultLineupPair } from "../testkit/helpers.ts";
import { decidedInFor } from "./decided-in.ts";
import { PointsRule, payout, setsToWinOf } from "./points.ts";
import type { FixtureResult } from "./standings.ts";

const WINNER = "W";
/** awardByeDelta's phantom seat (`BYE_PHANTOM`). */
const BYE_PHANTOM = "__bye__";
const SEATS = ["home", "away"] as const;
type Seat = (typeof SEATS)[number];
const BYE: MatchOutcome = MatchOutcome.parse({ kind: "award", winner: WINNER, loser: null, reason: "bye" });

/** awardByeDelta, step for step. `raw` is the module's own pair (the ledger before the rule), `pair` the pair the rule
 *  pays, `paid` the winner's half of it (the half the app keeps). A pair with no winner throws, as the app's does. */
function awardBye(m: AnySportModule, rawCfg: unknown, rule: PointsRule, seat: Seat): { raw: FixtureResult; pair: FixtureResult; paid: StandingsDelta } {
  const cfg = m.configSchema.parse(rawCfg);
  const home = seat === "home";
  const state = m.init(cfg, {
    home: { entrantId: home ? WINNER : BYE_PHANTOM, slots: [] },
    away: { entrantId: home ? BYE_PHANTOM : WINNER, slots: [] },
  });
  const raw = m.standingsDelta(BYE, cfg, { kind: "swiss" }, state) as FixtureResult;
  const pair = payout(BYE, decidedInFor(m, BYE), raw, false, rule, m.awardScoreKeys, setsToWinOf(m, cfg));
  const paid = pair.find((d) => d.entrantId === WINNER);
  if (paid === undefined) throw new Error(`${m.key}: the paid bye names no winner`);
  return { raw, pair, paid };
}

/** The sets a best-of-N match is won on, ⌈N/2⌉, read off the cfg; `undefined` for a sport whose cfg names no `bestOf`. */
function setsToWinByRulebook(m: AnySportModule, rawCfg: unknown): number | undefined {
  const bestOf = (m.configSchema.parse(rawCfg) as { bestOf?: unknown }).bestOf;
  return typeof bestOf === "number" ? Math.ceil(bestOf / 2) : undefined;
}

/** The rule row's "win points": the rule's win, or under a set-score map the clean-sweep score's pair ("W-0", else "*"). */
function winPoints(rule: PointsRule, setsToWin: number | undefined): number {
  const map = rule.bySetScore;
  if (map === undefined) return rule.win.regulation;
  // Assumptions are guards: a set-score map on a sport with no best-of is no rule a stage can hold.
  if (setsToWin === undefined) throw new Error("a set-score map on a cfg with no bestOf");
  const key = `${setsToWin}-0`;
  const pair = Object.hasOwn(map, key) ? map[key] : map["*"];
  if (pair === undefined) throw new Error(`the map prices neither ${key} nor "*"`);
  return pair[0];
}

/** The rule row's "records no set, game, point, goal or run for or against", read off each sport's OWN declaration: every
 *  ledger field the module declares (`metrics`: the score, NRR's ball counts, the goal sub-tallies, the discipline and
 *  colour counts) and every further key its bye ledger carries, each read as the tables read it (absent ⇒ 0, display.ts
 *  `metric`, tiebreakers.ts `ledgerOf`). Nothing was played, so each reads 0. No declaration marks a field that counts the
 *  RESULT rather than a score, so the one such field is typed here and pinned against the modules (some sport declares
 *  it, a bye meets it, and there it reads exactly the win the bye is booked). */
const RESULT_TALLIES: ReadonlySet<string> = new Set(["wins"]); // boardgame's wins, the W column's twin (BG tie-break)
const declaredKeys = (m: AnySportModule): string[] => m.metrics.map((s) => s.key);

/** A whole-points rule (no set-score map) a custom stage could hold: win 3, loss 0, and every level result priced. */
const custom = (extra: Record<string, unknown> = {}): PointsRule =>
  PointsRule.parse({ win: { regulation: 3 }, loss: { regulation: 0 }, draw: 1, tie: 1, noResult: 0, shootoutAs: "result", unit: "whole", bonuses: [], ...extra });
/** Ruling 251's case: a forfeit row that outpays the win, with an awarded score a bye must never take. */
const ROW = custom({ forfeit: { winnerPoints: 5, loserPoints: 0, awardScore: [7, 0] } });
/** The bonus case: the same row, plus a forfeit-win bonus and a margin bonus a 0-0 ledger meets (margin 0 ≥ 0). */
const BONUSED = custom({
  forfeit: { winnerPoints: 5, loserPoints: 0 },
  bonuses: [
    { when: "forfeit_win", points: 1 },
    { when: "win_margin_gte", param: 0, points: 1 },
  ],
});

/** Sweeps every sport × every declared cfg × the winner seated home and away; returns the number of byes checked. A sweep
 *  that met no sport, or a sport with no bye, is refused here, so no caller can pass on nothing. */
function everyBye(body: (m: AnySportModule, name: string, cfg: unknown, seat: Seat) => void): { sports: number; byes: number } {
  let byes = 0;
  const perSport = new Map<string, number>();
  const sports = forEachSport(({ module: m }) => {
    for (const { name, cfg } of declaredCfgs(m as never)) {
      for (const seat of SEATS) {
        body(m, name, cfg, seat);
        byes++;
        perSport.set(m.key, (perSport.get(m.key) ?? 0) + 1);
      }
    }
  });
  if (sports === 0 || perSport.size !== sports) throw new Error(`everyBye: ${perSport.size} of ${sports} sports met a bye`);
  return { sports, byes };
}

describe("X-SW-5 a bye pays the stage's win points: never the forfeit row, never a bonus, no score (ruling 251)", () => {
  it("X-SW-5 empty case first: a rule with no forfeit row and no bonus pays the bye exactly the win (generic, declared)", () => {
    // single-sport: generic is the empty case — its declared rule has no forfeit row, no bonus and no set table; the sweeps below cover every sport
    const generic = builtinModules.find((m) => m.key === "generic");
    if (generic === undefined) throw new Error("no generic module");
    let checked = 0;
    for (const { name, cfg } of declaredCfgs(generic as never)) {
      const rule = generic.tablePointsRule(generic.configSchema.parse(cfg), "swiss");
      expect([rule.forfeit, rule.bonuses, rule.bySetScore], `${name}: precondition, the empty rule`).toEqual([undefined, [], undefined]);
      for (const seat of SEATS) {
        const { raw, paid } = awardBye(generic, cfg, rule, seat);
        expect(paid.points, `${name}/${seat}`).toBe(rule.win.regulation);
        expect(paid.metrics, `${name}/${seat}: the ledger as the module wrote it`).toEqual(raw.find((d) => d.entrantId === WINNER)!.metrics);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(SEATS.length);
  });

  it("X-SW-5 every sport: a bye pays the declared win points (clean sweep under a set-score map) and records no score: every field the sport declares or its ledger carries reads 0 but the win itself (counted per sport)", () => {
    const perSport = new Map<string, number>();
    const fieldsPerSport = new Map<string, number>();
    let setMaps = 0;
    let tallies = 0;
    const { sports, byes } = everyBye((m, name, cfg, seat) => {
      const where = `${m.key}/${name}/${seat}`;
      const rule = m.tablePointsRule(m.configSchema.parse(cfg), "swiss");
      const setsToWin = setsToWinByRulebook(m, cfg);
      if (rule.bySetScore !== undefined) {
        // Premise: the producer's setsToWin is the rulebook's, so the clean sweep the rule prices is the one paid.
        expect(setsToWinOf(m, cfg), `${where}: setsToWin`).toBe(setsToWin);
        setMaps++;
      }
      const { raw, paid } = awardBye(m, cfg, rule, seat);
      expect(paid.points, where).toBe(winPoints(rule, setsToWin));
      expect([paid.played, paid.won, paid.drawn, paid.lost], `${where}: booked a win`).toEqual([1, 1, 0, 0]);
      expect(paid.metrics, `${where}: the ledger as the module wrote it`).toEqual(raw.find((d) => d.entrantId === WINNER)!.metrics);
      for (const k of new Set([...declaredKeys(m), ...Object.keys(paid.metrics)])) {
        const value = paid.metrics[k] ?? 0;
        if (RESULT_TALLIES.has(k)) {
          expect(value, `${where}: ${k} counts the result`).toBe(paid.won);
          tallies++;
          continue;
        }
        expect(value, `${where}: ${k}`).toBe(0);
        fieldsPerSport.set(m.key, (fieldsPerSport.get(m.key) ?? 0) + 1);
      }
      perSport.set(m.key, (perSport.get(m.key) ?? 0) + 1);
    });
    expect(sports).toBeGreaterThan(0);
    expect(perSport.size, "every sport checked").toBe(sports);
    expect(byes).toBeGreaterThanOrEqual(sports * SEATS.length);
    expect(setMaps, "a set-score map was met").toBeGreaterThan(0);
    // per sport, not summed: every sport's byes read at least one field the sport records
    for (const m of builtinModules) expect(fieldsPerSport.get(m.key) ?? 0, `${m.key}: fields read`).toBeGreaterThan(0);
    // the typed exception is pinned against the modules: some sport declares each tally, and a bye met it
    for (const k of RESULT_TALLIES) expect(builtinModules.some((m) => declaredKeys(m).includes(k)), `${k} is declared`).toBe(true);
    expect(tallies, "a result tally was met").toBeGreaterThan(0);
  });

  it("X-SW-5 a custom rule's forfeit row {winnerPoints: 5} does not pay a bye: the win (3) does — and never its awarded score (every sport, counted)", () => {
    // differential: before ruling 251 the bye was paid the row's 5
    expect(ROW.forfeit!.winnerPoints).not.toBe(ROW.win.regulation);
    const { sports, byes } = everyBye((m, name, cfg, seat) => {
      const { raw, paid } = awardBye(m, cfg, ROW, seat);
      expect(paid.points, `${m.key}/${name}/${seat}`).toBe(ROW.win.regulation);
      expect(paid.metrics, `${m.key}/${name}/${seat}: never the awarded 7-0`).toEqual(raw.find((d) => d.entrantId === WINNER)!.metrics);
    });
    expect(sports).toBeGreaterThan(0);
    expect(byes).toBeGreaterThanOrEqual(sports * SEATS.length);
  });

  it("X-SW-5 a bye earns no bonus: forfeit_win +1 and win_margin_gte(0) +1 leave it at the win (every sport, counted)", () => {
    // differential: before ruling 251 the bye was paid 6 (the row's 5 + forfeit_win 1); a margin bonus let in pays 4
    const { sports, byes } = everyBye((m, name, cfg, seat) => {
      expect(awardBye(m, cfg, BONUSED, seat).paid.points, `${m.key}/${name}/${seat}`).toBe(BONUSED.win.regulation);
    });
    expect(sports).toBeGreaterThan(0);
    expect(byes).toBeGreaterThanOrEqual(sports * SEATS.length);
  });

  it("X-SW-5 a set-score map {2-0: [3,0], 2-1: [2,1]} pays a best-of-3 bye the 2-0 pair's 3, forfeit row or not (every set sport, counted)", () => {
    const MAP = { "2-0": [3, 0], "2-1": [2, 1] };
    const mapped = (extra: Record<string, unknown> = {}): PointsRule =>
      PointsRule.parse({ win: { regulation: 9 }, loss: { regulation: 0 }, bySetScore: MAP, shootoutAs: "result", unit: "whole", bonuses: [], ...extra });
    const setSports: string[] = [];
    let checked = 0;
    forEachSport(({ module: m }) => {
      if (m.reachableSetScores === undefined) return; // a sport with no set table holds no set-score map
      const cfg = { bestOf: 3 };
      // Premise: a best-of-3 match is won on 2 sets, so the bye's clean sweep is 2-0.
      expect(setsToWinByRulebook(m, cfg), m.key).toBe(2);
      expect(setsToWinOf(m, cfg), `${m.key}: the producer agrees`).toBe(2);
      for (const rule of [mapped(), mapped({ forfeit: { winnerPoints: 5, loserPoints: 0 } })]) {
        for (const seat of SEATS) {
          // differential: the forfeit row's 5 (before ruling 251), the 2-1 pair's 2, the rule's flat win 9
          expect(awardBye(m, cfg, rule, seat).paid.points, `${m.key}/${seat}/${rule.forfeit === undefined ? "no row" : "row"}`).toBe(MAP["2-0"][0]);
          checked++;
        }
      }
      setSports.push(m.key);
    });
    expect(setSports.length, "a set sport was met").toBeGreaterThan(0);
    expect(checked).toBe(setSports.length * 2 * SEATS.length);
  });

  it("X-SW-5 a walkover still pays the forfeit row and its forfeit bonus (X-PT-1 unchanged; every sport, counted)", () => {
    // The other side of the split: only the bye leaves the row. Expected: the row's 5 + forfeit_win 1, the loser the row's 0.
    const expected = [BONUSED.forfeit!.winnerPoints + 1, BONUSED.forfeit!.loserPoints];
    let checked = 0;
    const sports = forEachSport(({ module: m }) => {
      for (const { name, cfg } of declaredCfgs(m as never)) {
        for (const winner of ["H", "A"] as const) {
          const walkover = MatchOutcome.parse({ kind: "award", winner, loser: winner === "H" ? "A" : "H", reason: "walkover" });
          const state = m.init(cfg, defaultLineupPair(m.positions));
          const pair = m.standingsDelta(walkover, cfg, { kind: "swiss" }, state) as FixtureResult;
          const paid = payout(walkover, decidedInFor(m, walkover), pair, false, BONUSED, m.awardScoreKeys, setsToWinOf(m, cfg));
          const [w, l] = winner === "H" ? [paid[0], paid[1]] : [paid[1], paid[0]];
          expect([w.points, l.points], `${m.key}/${name}/${winner}`).toEqual(expected);
          checked++;
        }
      }
    });
    expect(sports).toBeGreaterThan(0);
    expect(checked).toBeGreaterThanOrEqual(sports * 2);
  });

  it("X-SW-5 second call: paying the same bye twice gives the same delta, and the rule laid over its own result changes nothing (every sport, counted)", () => {
    let checked = 0;
    const { sports, byes } = everyBye((m, name, cfg, seat) => {
      for (const rule of [m.tablePointsRule(m.configSchema.parse(cfg), "swiss"), ROW, BONUSED]) {
        const once = awardBye(m, cfg, rule, seat);
        expect(awardBye(m, cfg, rule, seat), `${m.key}/${name}/${seat}: again`).toEqual(once);
        const again = payout(BYE, decidedInFor(m, BYE), once.pair, false, rule, m.awardScoreKeys, setsToWinOf(m, cfg));
        expect(again, `${m.key}/${name}/${seat}: over its own result`).toEqual(once.pair);
        checked++;
      }
    });
    expect(sports).toBeGreaterThan(0);
    expect(byes).toBeGreaterThanOrEqual(sports * SEATS.length);
    expect(checked).toBe(byes * 3);
  });
});
