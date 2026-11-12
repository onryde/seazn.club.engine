// TN-TS-1 (owner ruling 233, Seazn Capture S2-7, 2026-11-12: "Toss event first") - `tennis.toss {serving}` records who
// serves first. Every describe/it title carries the row id as a whole token (test/rules-reference.ts reads them).
//
// Expected values come from the ITF Rules of Tennis 2026, written out as the rule says them, never from the code under test:
//  - Rule 9 (choice of ends and service): the toss decides who serves the first game, before the warm-up;
//  - Rule 14 (order of service): at the end of each standard game the receiver becomes the server; in doubles the team due
//    to serve a set's first game decides which partner serves it, the opponents decide for the second game, and the partner
//    of the first game's server serves the third (so the partners of a side alternate service games);
//  - Rule 5(b) (tie-break game): the player whose turn it is serves the first point, then each serves two points in turn, and
//    the player who served first in the tie-break receives in the first game of the following set;
//  - Appendix VI (match tie-break): the service order of the match carries into it, and its serve rotates as a tie-break's.
// The doubles fixture names each pair first-named first while `orderNo` runs the other way (serve-context.test.ts's fixture),
// so a reader that used `orderNo` would name the wrong partner.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EngineError } from "../../core/errors.ts";
import { foldMatch, type EventEnvelope } from "../../core/events.ts";
import type { Lineup, LineupPair } from "../../core/types.ts";
import type { ModuleEvent } from "../../sport/module.ts";
import { defaultLineupPair, makeEnvelope } from "../../testkit/helpers.ts";
import { tennis } from "../tennis/tennis.ts";
import { NestedEv, NestedToss, serveContext, tossOpen, type NestedState } from "./kernel.ts";

const STRICT_ALL = { strictFromSeq: 0 } as const;
const H = "H";
const A = "A";

const singles: LineupPair = defaultLineupPair(tennis.positions);
function pairSide(entrantId: string, first: string, second: string): Lineup {
  return {
    entrantId,
    slots: [
      { personId: second, slot: "starting", orderNo: 1, pairOrder: 2 },
      { personId: first, slot: "starting", orderNo: 2, pairOrder: 1 },
    ],
  };
}
const doubles: LineupPair = { home: pairSide(H, "H-first", "H-second"), away: pairSide(A, "A-first", "A-second") };

const cfgOf = (variant?: string) => tennis.configSchema.parse(variant === undefined ? {} : tennis.variants[variant]);

/** `[event, voids?]` - a `core.void` names its target's seq. */
type Spec = ModuleEvent | [ModuleEvent, number];
function envelopes(specs: readonly Spec[]): EventEnvelope[] {
  return specs.map((spec, i) => (Array.isArray(spec) ? makeEnvelope(i, spec[0], `e-${spec[1]}`) : makeEnvelope(i, spec)));
}
const fold = (specs: readonly Spec[], lineups: LineupPair = singles, cfg: unknown = cfgOf()): NestedState =>
  foldMatch(tennis, cfg as never, lineups, envelopes(specs), STRICT_ALL);

/** The code of the EngineError the strict fold throws, or null when it folds. */
function codeOf(specs: readonly Spec[], cfg: unknown = cfgOf()): string | null {
  try {
    fold(specs, singles, cfg);
    return null;
  } catch (error) {
    if (error instanceof EngineError) return error.code;
    throw error;
  }
}

const start: ModuleEvent = { type: "core.start", payload: {} };
const toss = (serving: unknown): ModuleEvent => ({ type: "tennis.toss", payload: { serving } });
const tossRaw = (payload: unknown): ModuleEvent => ({ type: "tennis.toss", payload });
const point = (by: string): ModuleEvent => ({ type: "tennis.point", payload: { by } });
/** A game to `by` from love: four straight points close it, ad or no-ad. */
const game = (by: string): ModuleEvent[] => [point(by), point(by), point(by), point(by)];
/** `n` games, alternating winners from `first`: no side ever leads by two, so a set reaches its tie-break at 6-all. */
const levelGames = (n: number, first: string = H): ModuleEvent[] =>
  Array.from({ length: n }, (_, i) => game(i % 2 === 0 ? first : first === H ? A : H)).flat();
const award = (winner: string): ModuleEvent => ({ type: "tennis.game.award", payload: { winner } });
const summary = (home: number, away: number): ModuleEvent => ({ type: "tennis.set_summary", payload: { home, away } });
const VOID: ModuleEvent = { type: "core.void", payload: {} };

describe("TN-TS-1 tennis.toss: the toss decides who serves the first game (ITF Rule 9)", () => {
  it("TN-TS-1 an away toss after the Start hands away the first service game: side, turn 0, the walk agrees", () => {
    const state = fold([start, toss(A)]);
    expect(state.serving).toBe("away");
    expect(state.opener).toBe("away");
    expect(serveContext(state)).toEqual({ side: "away", serviceTurn: 0, personId: null, serveOrderKnown: true });
    expect((tennis.summary(state).detail as { serving?: unknown } | undefined)?.serving).toBe("away");
  });

  it("TN-TS-1 a toss before the Start is the same fact: away serves the first game once play starts", () => {
    const before = fold([toss(A)]);
    expect(before.phase).toBe("pre");
    expect(before.serving).toBe("away");
    expect(serveContext(fold([toss(A), start]))).toEqual({ side: "away", serviceTurn: 0, personId: null, serveOrderKnown: true });
  });

  it("TN-TS-1 games rotate from the toss's side (Rule 14): away, home, away, ... game by game, each side's turn counted", () => {
    const events: ModuleEvent[] = [start, toss(A)];
    let checked = 0;
    for (let g = 0; g <= 9; g++) {
      // the server of game g+1 (1-based): away serves the odd games, home the even ones
      expect(serveContext(fold(events)), `before game ${g + 1}`).toEqual({
        side: g % 2 === 0 ? "away" : "home",
        serviceTurn: Math.floor(g / 2),
        personId: null,
        serveOrderKnown: true,
      });
      events.push(...game(g % 2 === 0 ? H : A)); // who WINS a game never moves the serve
      checked++;
    }
    expect(checked).toBe(10);
  });

  it("TN-TS-1 the serve still follows the toss after a closed set: 6-4 is ten games, so away opens set 2", () => {
    // home takes five, away four, home the tenth: 6-4 with no lead of two before it
    const state = fold([start, toss(A), ...levelGames(8), ...game(H), ...game(H)]);
    expect(state.sets).toEqual([{ home: 6, away: 4 }]);
    expect(serveContext(state)).toEqual({ side: "away", serviceTurn: 5, personId: null, serveOrderKnown: true });
  });

  it("TN-TS-1 tie-break (Rule 5(b)): away, who tossed to serve, serves its first point after 12 games; two each after; home opens the next set", () => {
    const sixAll = [start, toss(A), ...levelGames(12)];
    const atTb = fold(sixAll);
    expect(atTb.points.kind).toBe("tiebreak");
    expect(atTb.tbFirstServer).toBe("away");
    expect(serveContext(atTb)).toMatchObject({ side: "away", serveOrderKnown: true });
    // one point by away, then home serves points 2 and 3, away 4 and 5
    const servers = [1, 2, 3, 4, 5].map((n) => fold([...sixAll, ...Array<ModuleEvent>(n).fill(point(H))]).serving);
    expect(servers).toEqual(["home", "home", "away", "away", "home"]);
    // home takes the tie-break 7-0: the tie-break's first server (away) receives first in set 2, so home serves it
    const set2 = fold([...sixAll, ...Array<ModuleEvent>(7).fill(point(H))]);
    expect(set2.sets).toEqual([{ home: 7, away: 6, tb: { home: 7, away: 0 } }]);
    expect(serveContext(set2)).toMatchObject({ side: "home", serveOrderKnown: true });
  });

  it("TN-TS-1 match tie-break (App VI): the order carries in from the toss and rotates one, then two each; the walk agrees to the end", () => {
    const cfg = cfgOf("doubles-noad-mtb10");
    // 6-0, 0-6 by awards: six games each set, so the opener never changes and away serves the match tie-break's first point
    const setAll = [start, toss(A), ...Array<ModuleEvent>(6).fill(award(H)), ...Array<ModuleEvent>(6).fill(award(A))];
    const atMtb = fold(setAll, singles, cfg);
    expect(atMtb.points.kind).toBe("matchTiebreak");
    expect(serveContext(atMtb)).toMatchObject({ side: "away", serveOrderKnown: true });
    const servers = [1, 2, 3, 4, 5].map((n) => fold([...setAll, ...Array<ModuleEvent>(n).fill(point(H))], singles, cfg).serving);
    expect(servers).toEqual(["home", "home", "away", "away", "home"]);
    for (const n of [1, 2, 3, 6, 9]) {
      expect(serveContext(fold([...setAll, ...Array<ModuleEvent>(n).fill(point(H))], singles, cfg)).serveOrderKnown, `${n} points in`).toBe(true);
    }
    // decided 10-0 and 10-1: the walk follows the fold past the decider (an even and an odd count of serve turns)
    for (const extra of [[], [point(A)]]) {
      const done = fold([...setAll, ...extra, ...Array<ModuleEvent>(10).fill(point(H))], singles, cfg);
      expect(done.phase).toBe("done");
      expect(serveContext(done).serveOrderKnown, `decided after ${10 + extra.length} points`).toBe(true);
    }
  });

  it("TN-TS-1 doubles (Rule 14): away's first-named partner serves game 1, home's game 2, then the partners alternate", () => {
    const cfg = cfgOf("doubles-noad-mtb10");
    const expected: [side: "home" | "away", turn: number, person: string][] = [
      ["away", 0, "A-first"],
      ["home", 0, "H-first"],
      ["away", 1, "A-second"],
      ["home", 1, "H-second"],
      ["away", 2, "A-first"],
      ["home", 2, "H-first"],
    ];
    const events: ModuleEvent[] = [start, toss(A)];
    expected.forEach(([side, serviceTurn, personId], g) => {
      expect(serveContext(fold(events, doubles, cfg)), `before game ${g + 1}`).toEqual({ side, serviceTurn, personId, serveOrderKnown: true });
      events.push(...game(g % 2 === 0 ? H : A));
    });
  });

  it("TN-TS-1 a home toss is recorded too, and serves exactly as no toss does", () => {
    const tossed = fold([start, toss(H)]);
    const untossed = fold([start]);
    expect(tossed.opener).toBe("home");
    expect(serveContext(tossed)).toEqual(serveContext(untossed));
    const { opener: _opener, ...rest } = tossed;
    expect(rest).toEqual(untossed);
  });

  it("TN-TS-1 no toss: home serves first as before, and the state carries no opener key (every recorded state stays byte for byte)", () => {
    const state = fold([start, ...game(H)]);
    expect("opener" in state).toBe(false);
    expect(serveContext(fold([start]))).toEqual({ side: "home", serviceTurn: 0, personId: null, serveOrderKnown: true });
    expect(JSON.stringify(Object.keys(fold([start])))).not.toContain("opener");
  });
});

describe("TN-TS-1 tennis.toss is refused while a toss is held, once the match is over, and when it is malformed", () => {
  it("TN-TS-1 a second toss is WRONG_PHASE, whichever side it names", () => {
    expect(codeOf([start, toss(A), toss(H)])).toBe("WRONG_PHASE");
    expect(codeOf([start, toss(A), toss(A)])).toBe("WRONG_PHASE");
    expect(codeOf([toss(H), start, toss(A)])).toBe("WRONG_PHASE");
    expect(() => fold([start, toss(A), toss(H)])).toThrow(/toss not allowed: a toss is already recorded/);
  });

  it("TN-TS-1 play does not close the toss (fix round 3, option B): one after a point, a game award or a set score is taken and seats the serve for the whole match", () => {
    for (const played of [[point(H)], [point(A)], [award(A)], [summary(6, 4)], levelGames(3)]) {
      const late = fold([start, ...played, toss(A)]);
      expect(late, JSON.stringify(played[0])).toEqual(fold([toss(A), start, ...played]));
    }
    // a second toss is still refused after play
    expect(codeOf([start, point(H), toss(A), point(H), toss(H)])).toBe("WRONG_PHASE");
  });

  it("TN-TS-1 a toss once the match is over is refused: the fold's ALREADY_DECIDED for a decided match, the module's WRONG_PHASE for an abandoned one or a done state handed to apply", () => {
    expect(codeOf([start, summary(6, 4), summary(6, 4), toss(A)])).toBe("ALREADY_DECIDED");
    expect(codeOf([start, { type: "core.abandon", payload: { reason: "rain" } }, toss(A)])).toBe("WRONG_PHASE");
    const done = fold([start, summary(6, 4), summary(6, 4)]);
    expect(done.phase).toBe("done");
    expect(() => tennis.apply(done, makeEnvelope(3, toss(A)) as never, undefined as never)).toThrow(/toss not allowed: the match is over \(phase "done"\)/);
  });

  it("TN-TS-1 a record that moves no score does not close the toss: a break before the first point", () => {
    const state = fold([start, { type: "tennis.interruption", payload: { kind: "other" } }, toss(A)]);
    expect(state.serving).toBe("away");
  });

  it("TN-TS-1 a code violation leaves the toss open, and so does the penalty point entered for it (fix round 3: play no longer closes it)", () => {
    const sanction = (level: string): ModuleEvent => ({ type: "tennis.sanction", payload: { by: H, level } });
    expect(fold([start, sanction("warning"), toss(A)]).serving).toBe("away");
    expect(fold([start, sanction("point_penalty"), toss(A)]).serving).toBe("away");
    // after the penalty point the server is still the one due: home served it (home first), so away now; the toss re-seats it
    const late = fold([start, sanction("point_penalty"), point(A), toss(A)]);
    expect(late.opener).toBe("away");
    expect(late).toEqual(fold([toss(A), start, sanction("point_penalty"), point(A)]));
  });

  it("TN-TS-1 a toss while play is suspended is refused by the core's stoppage guard (WRONG_PHASE)", () => {
    expect(codeOf([start, { type: "core.suspend", payload: {} }, toss(A)])).toBe("WRONG_PHASE");
  });

  it("TN-TS-1 a toss naming a non-entrant, or malformed, is INVALID_EVENT", () => {
    expect(codeOf([start, toss("X")])).toBe("INVALID_EVENT");
    expect(codeOf([start, tossRaw({})])).toBe("INVALID_EVENT");
    expect(codeOf([start, toss("")])).toBe("INVALID_EVENT");
    expect(codeOf([start, toss(7)])).toBe("INVALID_EVENT");
    expect(codeOf([start, tossRaw({ serving: A, elected: "serve" })])).toBe("INVALID_EVENT");
    expect(codeOf([start, tossRaw({ by: A })])).toBe("INVALID_EVENT");
  });

  it("TN-TS-1 the payload is one strict branch of NestedEv: {serving} parses against exactly one, and no sibling's shape against it", () => {
    expect(NestedEv.options.filter((branch) => branch.safeParse({ serving: A }).success)).toEqual([NestedToss]);
    for (const sibling of [{ by: A }, { home: 6, away: 4 }, { by: A, level: "warning" }, { kind: "medical" }, { winner: A }]) {
      expect(NestedToss.safeParse(sibling).success, JSON.stringify(sibling)).toBe(false);
    }
  });
});

describe("TN-TS-1 Undo of the toss is core.void", () => {
  it("TN-TS-1 voiding the toss returns the match to home serving first, with no opener, and reopens the toss", () => {
    const voided = fold([start, toss(A), [VOID, 1]]);
    expect(voided).toEqual(fold([start]));
    expect(serveContext(voided)).toEqual({ side: "home", serviceTurn: 0, personId: null, serveOrderKnown: true });
    expect(tossOpen(voided)).toBe(true);
    expect(fold([start, toss(A), [VOID, 1], toss(H)]).opener).toBe("home");
  });

  it("TN-TS-1 with no toss held the toss stays open whatever is voided: after the only point is voided, and after a later one (fix round 3)", () => {
    expect(tossOpen(fold([start, point(H), [VOID, 1]]))).toBe(true);
    const retossed = fold([start, point(H), [VOID, 1], toss(A)]);
    expect(retossed.serving).toBe("away");
    expect(serveContext(retossed)).toEqual({ side: "away", serviceTurn: 0, personId: null, serveOrderKnown: true });
    expect(tossOpen(fold([start, point(H), point(H), [VOID, 2]]))).toBe(true);
    expect(fold([start, point(H), point(H), [VOID, 2], toss(A)])).toEqual(fold([toss(A), start, point(H)]));
  });

  it("TN-TS-1 a wrong toss voided mid-match may be recorded again, and the new one re-seats the serve for the whole match", () => {
    // home was tossed by mistake; three games and a point later the scorer voids it and records away
    const played = [...levelGames(3), point(A)];
    const corrected = fold([start, toss(H), ...played, [VOID, 1], toss(A)]);
    const right = fold([start, toss(A), ...played]);
    expect(corrected).toEqual(right);
    expect(serveContext(corrected)).toEqual(serveContext(right));
    // games 1-3 were served away, home, away: home serves game 4
    expect(serveContext(corrected)).toEqual({ side: "home", serviceTurn: 1, personId: null, serveOrderKnown: true });
    // while the wrong toss is still held, the right one is refused
    expect(codeOf([start, toss(H), ...played, toss(A)])).toBe("WRONG_PHASE");
  });
});

describe("TN-TS-1 tossOpen: the one predicate the fold and the pad read", () => {
  it("TN-TS-1 open before and after the Start while no toss is held, play or not; closed while one is held and once the match is over", () => {
    expect(tossOpen(fold([]))).toBe(true);
    expect(tossOpen(fold([start]))).toBe(true);
    expect(tossOpen(fold([start, toss(A)]))).toBe(false);
    expect(tossOpen(fold([start, toss(H)]))).toBe(false);
    expect(tossOpen(fold([start, point(H)]))).toBe(true);
    expect(tossOpen(fold([start, award(H)]))).toBe(true);
    expect(tossOpen(fold([start, summary(6, 4)]))).toBe(true);
    expect(tossOpen(fold([start, point(H), toss(A), point(H)]))).toBe(false);
    expect(tossOpen(fold([start, summary(6, 4), summary(6, 4)]))).toBe(false);
    expect(tossOpen(fold([start, { type: "core.abandon", payload: { reason: "rain" } }]))).toBe(false);
    expect(tossOpen(fold([{ type: "core.forfeit", payload: { by: A, reason: "walkover" } }]))).toBe(false);
  });
});

describe("TN-TS-1 a late toss seats the serve for the whole match: every prefix of every tennis golden stream", () => {
  type Golden = { configs: Record<string, unknown>; streams: { config: string; seed: number; lineups?: LineupPair; events: ModuleEvent[] }[] };
  const corpus = JSON.parse(readFileSync(new URL("../tennis/tennis.golden.json", import.meta.url), "utf8")) as Golden;
  const SCORING = new Set(["tennis.point", "tennis.game.award", "tennis.set_summary"]);
  /** The whole state with its keys sorted (key order is where the toss arrived, not a fact), and its serve context. */
  const view = (state: NestedState): string => JSON.stringify([Object.fromEntries(Object.entries(state).sort()), serveContext(state)]);
  const plain = (lineups: LineupPair, cfg: unknown, events: readonly ModuleEvent[]): NestedState =>
    foldMatch(tennis, cfg as never, lineups, events.map((e, i) => makeEnvelope(i, e)));

  it("TN-TS-1 a toss inserted after the first score or at the end equals the same toss before play: whole state and serveContext, singles and doubles, through breakers and match tie-breaks (counted)", () => {
    const counts = { compared: 0, early: 0, late: 0, doubles: 0, breaker: 0, mtb: 0, away: 0, home: 0 };
    for (const stream of corpus.streams) {
      if (stream.events.some((e) => e.type === "tennis.toss" || e.type === "core.void")) continue;
      const cfg = tennis.configSchema.parse(corpus.configs[stream.config]);
      const asRecorded = stream.lineups ?? singles;
      const pairs: LineupPair = { home: pairSide(asRecorded.home.entrantId, "H-first", "H-second"), away: pairSide(asRecorded.away.entrantId, "A-first", "A-second") };
      for (const lineups of [asRecorded, pairs]) {
        const firstScore = stream.events.findIndex((e) => SCORING.has(e.type));
        for (let n = 1; n <= stream.events.length; n++) {
          const prefix = stream.events.slice(0, n);
          for (const [where, at] of [["early", firstScore + 1], ["late", n]] as const) {
            if (firstScore < 0 || at > n || (where === "early" && at === n)) continue;
            for (const side of ["home", "away"] as const) {
              const t = toss(lineups[side].entrantId);
              let before: NestedState, after: NestedState;
              try {
                before = plain(lineups, cfg, [t, ...prefix]);
                after = plain(lineups, cfg, [...prefix.slice(0, at), t, ...prefix.slice(at)]);
              } catch (error) {
                // a prefix already decided refuses the late toss; a ledger the doubles sheet cannot carry is not this test's
                if (error instanceof EngineError) continue;
                throw error;
              }
              expect(view(after), `${stream.config}#${stream.seed} @${n} ${where} ${side}`).toBe(view(before));
              counts.compared++;
              counts[where]++;
              counts[side]++;
              if (lineups === pairs) counts.doubles++;
              if (before.points.kind === "tiebreak" || before.sets.some((set) => set.tb !== undefined)) counts.breaker++;
              if (before.points.kind === "matchTiebreak" || before.sets.some((set) => set.mtb === true)) counts.mtb++;
            }
          }
        }
      }
    }
    // eslint-disable-next-line no-console -- the sweep reports what it compared; the same counts are asserted below
    console.info(`[toss] late-toss states compared: ${JSON.stringify(counts)}`);
    expect(counts.compared).toBeGreaterThan(1000);
    for (const key of ["early", "late", "doubles", "breaker", "mtb", "away", "home"] as const) expect(counts[key], key).toBeGreaterThan(0);
  });
});
