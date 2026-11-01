// W3 Task 6 — X-SW-6 (owner ruling 251; W3 design §5, which supersedes RB3-7(b); SW-M8 / SC-O7). The bye's value is not
// a setting: a pairing-allocated bye is always the win (X-SW-5), boardgame has no `byeScore`, and a stored `byeScore` is
// ignored on read, not rejected. Until W3 boardgame carried `byeScore` (default 2) in its cfg and its ruleKeys, and
// SwissConstraints carried it too, yet no fold, payout or pairing ever read it (`boardgame.ts`'s award arm said so).
//
// Expected values come from the rulebook, never from the code under test: FIDE C.04.1 scores a pairing-allocated bye
// as a win, 1 point, and boardgame stores points as HALF-points throughout (chess.md §2: 1 / ½ / 0 are 2 / 1 / 0), so the
// paid bye is 2. The bye is built as the app's one producer builds it (apps/web `src/server/engine-db/competition.ts`
// `awardByeDelta`, the same steps `competition/points-w3-bye.test.ts` follows): the TYPED bye, the cfg parsed, an `init`
// state with the phantom seat opposite the winner, the module's own `standingsDelta`, then `payout` under the sport's
// DECLARED Swiss rule, and the winner's half kept.
import { describe, expect, it } from "vitest";
import { decidedInFor } from "../../competition/decided-in.ts";
import { payout, setsToWinOf } from "../../competition/points.ts";
import type { FixtureResult } from "../../competition/standings.ts";
import { MatchOutcome, type StandingsDelta } from "../../core/types.ts";
import { pairRound, type SwissConstraints, type SwissHistory, type SwissStanding } from "../../scheduling/swiss.ts";
import { declaredCfgs } from "../../testkit/declared-cfgs.ts";
import { forEachSport } from "../../testkit/for-each-sport.ts";
import { schemaHasPath } from "../../testkit/schema-paths.ts";
import { builtinModules } from "../index.ts";
import { boardgame } from "./boardgame.ts";

const KEY = "byeScore";
const WINNER = "W";
/** awardByeDelta's phantom seat (`BYE_PHANTOM`). */
const BYE_PHANTOM = "__bye__";
const BYE: MatchOutcome = MatchOutcome.parse({ kind: "award", winner: WINNER, loser: null, reason: "bye" });
/** FIDE C.04.1: a pairing-allocated bye scores a win, 1 point; in boardgame's half-points (chess.md §2) that is 2. */
const FIDE_BYE_HALF_POINTS = 2;
/** The values a stored cfg can hold: the old default (2, FIDE's full-point bye), the half-point bye an organiser could
 *  set (1), and 0. The parse strips the key before any reader sees it, so the two below the win bite only on a schema
 *  that lets it through: a strict one rejects them, and a loose one with a reader that honoured the key would pay them. */
const STORED_BYE_SCORES = [2, 1, 0] as const;

/** The paid bye, step for step as awardByeDelta builds it, with the winner in `seat`. */
function paidBye(rawCfg: unknown, seat: "home" | "away"): { paid: StandingsDelta; unit: string; win: number } {
  const cfg = boardgame.configSchema.parse(rawCfg);
  const home = seat === "home";
  const state = boardgame.init(cfg, {
    home: { entrantId: home ? WINNER : BYE_PHANTOM, slots: [] },
    away: { entrantId: home ? BYE_PHANTOM : WINNER, slots: [] },
  });
  const raw = boardgame.standingsDelta(BYE, cfg, { kind: "swiss" }, state) as FixtureResult;
  const rule = boardgame.tablePointsRule(cfg, "swiss");
  const pair = payout(BYE, decidedInFor(boardgame, BYE), raw, false, rule, boardgame.awardScoreKeys, setsToWinOf(boardgame, cfg));
  const paid = pair.find((d) => d.entrantId === WINNER);
  if (paid === undefined) throw new Error("the paid bye names no winner");
  return { paid, unit: rule.unit, win: rule.win.regulation };
}

describe("X-SW-6 the bye's value is not a setting (ruling 251)", () => {
  it("X-SW-6 a stored byeScore is ignored, not rejected: parse strips it and the rest of the cfg stands", () => {
    // single-sport: `byeScore` was only ever boardgame's key, so only a boardgame cfg can hold a stored copy.
    let checked = 0;
    for (const value of STORED_BYE_SCORES) {
      const stored = { [KEY]: value, variant: "rapid" };
      const result = boardgame.configSchema.safeParse(stored);
      expect(result.success, `byeScore ${value} must not be rejected`).toBe(true);
      const parsed = boardgame.configSchema.parse(stored);
      expect(KEY in parsed).toBe(false);
      expect(parsed.variant).toBe("rapid");
      // The rest of the cfg is exactly what the same cfg without the key parses to.
      expect(JSON.stringify(parsed)).toBe(JSON.stringify(boardgame.configSchema.parse({ variant: "rapid" })));
      // A second read of the stripped cfg is the same cfg: nothing reappears.
      expect(JSON.stringify(boardgame.configSchema.parse(parsed))).toBe(JSON.stringify(parsed));
      checked++;
    }
    expect(checked).toBe(STORED_BYE_SCORES.length);
  });

  it("X-SW-6 the bye is not a setting: no ruleKeys entry, no config path, in any sport", () => {
    // The positive pair, so the negatives below cannot pass on a reader that sees nothing: boardgame's real points key
    // is visible to both.
    expect(Object.keys(boardgame.ruleKeys ?? {})).toContain("scoring");
    expect(schemaHasPath(boardgame.configSchema, ["scoring"])).toBe(true);
    const visited = forEachSport(({ module }) => {
      expect(Object.keys(module.ruleKeys ?? {})).not.toContain(KEY);
      expect(schemaHasPath(module.configSchema, [KEY])).toBe(false);
    });
    expect(visited).toBe(builtinModules.length);
    expect(visited).toBeGreaterThan(0);
  });

  it("X-SW-6 SwissConstraints carries no byeScore, and the pairer names the bye whatever a caller sends", () => {
    // single-sport: the pairer is sport-blind; the field it drops was boardgame's.
    const standings: SwissStanding[] = ["a", "b", "c"].map((entrantId, i) => ({ entrantId, score: 0, rank: i + 1 }));
    const history: SwissHistory = { played: new Set() };
    const stale = {
      chess: true,
      // @ts-expect-error X-SW-6: `byeScore` is gone from SwissConstraints; if this line compiles, the inert field is back.
      byeScore: 1,
    } satisfies SwissConstraints;
    const clean: SwissConstraints = { chess: true };
    const withStale = pairRound(standings, history, stale);
    const without = pairRound(standings, history, clean);
    expect(withStale.ok).toBe(true);
    expect(withStale).toEqual(without);
    // The bye goes to the lowest-ranked of an all-zero field (FIDE C.04.1 / rulebook-W3 §2.3: the bye's holder is the
    // bottom of the lowest score group), and the pairer reports no value for it.
    expect(withStale.ok && withStale.bye).toBe("c");
  });

  it("X-SW-6 a boardgame bye still pays the win (2 half-points) under the declared Swiss rule, whatever byeScore was stored", () => {
    // single-sport: the stored key exists only in boardgame cfgs; every sport's bye is X-SW-5's sweep (points-w3-bye.test.ts).
    let checked = 0;
    for (const value of STORED_BYE_SCORES) {
      for (const seat of ["home", "away"] as const) {
        const { paid, unit, win } = paidBye({ [KEY]: value }, seat);
        expect(unit).toBe("half");
        expect(paid.points, `stored byeScore ${value}, winner ${seat}`).toBe(FIDE_BYE_HALF_POINTS);
        // X-SW-5: the bye pays the rule's own win, and that win is FIDE's.
        expect(win).toBe(FIDE_BYE_HALF_POINTS);
        expect(paid.won).toBe(1);
        checked++;
      }
    }
    expect(checked).toBe(STORED_BYE_SCORES.length * 2);
  });

  it("X-SW-6 empty cfg parses with no byeScore (the default is gone, not just the input), in every declared cfg and its state", () => {
    const empty = boardgame.configSchema.parse({});
    expect(KEY in empty).toBe(false);
    expect(JSON.stringify(empty)).not.toContain(KEY);
    // Every state embeds its cfg (the golden corpus's states lost the key with this change): the init state carries none.
    const state = boardgame.init(empty, {
      home: { entrantId: "H", slots: [] },
      away: { entrantId: "A", slots: [] },
    });
    expect(JSON.stringify(state)).not.toContain(KEY);
    // Every cfg every sport declares, the schema default included.
    let checked = 0;
    forEachSport(({ module }) => {
      for (const { name, cfg } of declaredCfgs(module)) {
        expect(JSON.stringify(cfg), `${module.key} ${name}`).not.toContain(`"${KEY}"`);
        checked++;
      }
    });
    expect(checked).toBeGreaterThanOrEqual(builtinModules.length);
  });
});
