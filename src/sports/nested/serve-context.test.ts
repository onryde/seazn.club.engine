// R4-3 (owner ruling, R4 dispatch) — the ITF doubles serve rotation lives in
// the engine, not the pad: a pad-side copy would fork from the fold the
// moment either one drifts. `serveContext` answers "who serves the current
// service game" by side and (in a declared doubles fixture) by person, for
// the state as folded so far.
//
// Every test names a concrete side/turn/personId, never just checks a field
// is present — a fold that stored the right numbers under the wrong key
// would still pass a shape-only assertion.
import { describe, expect, it } from "vitest";
import { foldMatch, type EventEnvelope } from "../../core/events.ts";
import type { Lineup, LineupPair } from "../../core/types.ts";
import { defaultLineupPair, makeEnvelope } from "../../testkit/helpers.ts";
import type { ModuleEvent } from "../../sport/module.ts";
import { tennis } from "../tennis/tennis.ts";
import { serveContext, type NestedState } from "./kernel.ts";

const STRICT_ALL = { strictFromSeq: 0 } as const;

const H = "H";
const A = "A";

// No declared pair order — `defaultLineupPair` puts one player per side.
const singles: LineupPair = defaultLineupPair(tennis.positions);

// A declared doubles order, first-named first — `orderNo` runs the OTHER
// way, matching `lineup.test.ts`'s fixture, so a reader that quietly used
// `orderNo` instead answers with the wrong player.
function pairSide(entrantId: string, first: string, second: string): Lineup {
  return {
    entrantId,
    slots: [
      { personId: second, slot: "starting", orderNo: 1, pairOrder: 2 },
      { personId: first, slot: "starting", orderNo: 2, pairOrder: 1 },
    ],
  };
}
const doubles: LineupPair = {
  home: pairSide(H, "H-first", "H-second"),
  away: pairSide(A, "A-first", "A-second"),
};

function cfgFor(variant?: string, extra?: Record<string, unknown>) {
  const preset = variant === undefined ? {} : tennis.variants[variant];
  return tennis.configSchema.parse({ ...preset, ...(extra ?? {}) });
}

function envelopes(events: ModuleEvent[]): EventEnvelope[] {
  return events.map((event, i) => makeEnvelope(i, event));
}

function fold(lineups: LineupPair, cfg: unknown, events: ModuleEvent[]): NestedState {
  return foldMatch(tennis, cfg, lineups, envelopes(events), STRICT_ALL);
}

const start: ModuleEvent = { type: "core.start", payload: {} };
const point = (by: string): ModuleEvent => ({ type: "tennis.point", payload: { by } });
const straight = (by: string, n: number): ModuleEvent[] => Array(n).fill(point(by));
// A clean 4-straight-point game — noAd or not, 4 straight points for one
// side never reaches a contested deuce, so it always closes the game.
const game = (by: string): ModuleEvent[] => straight(by, 4);
const gamesFor = (by: string, n: number): ModuleEvent[] =>
  Array.from({ length: n }, () => game(by)).flat();
const summary = (home: number, away: number, tb?: { home: number; away: number }): ModuleEvent => ({
  type: "tennis.set_summary",
  payload: { home, away, ...(tb === undefined ? {} : { tb }) },
});

describe("serveContext", () => {
  describe("side and service-game turn (singles, no declared pair order)", () => {
    it("starts the match with the initial server, turn 0, no personId", () => {
      const state = fold(singles, cfgFor(), [start]);
      expect(serveContext(state)).toEqual({ side: "home", serviceTurn: 0, personId: null, serveOrderKnown: true });
    });

    it("floor(completed games / 2) matches the fold's own alternation, game by game", () => {
      // Serve alternates every game regardless of who WINS it, so who scores
      // each game is irrelevant here — only the count matters.
      const events: ModuleEvent[] = [start];
      for (let g = 0; g <= 7; g++) {
        const state = fold(singles, cfgFor(), events);
        expect(serveContext(state)).toEqual({
          side: g % 2 === 0 ? "home" : "away",
          serviceTurn: Math.floor(g / 2),
          personId: null,
          serveOrderKnown: true,
        });
        events.push(...game(g % 2 === 0 ? H : A));
      }
    });

    it("keeps counting across a closed-set boundary", () => {
      // Same fixture as nested.test.ts's "wins a 6-4 set" — 10 games total,
      // banked as ONE closed set, not left sitting in `state.games`.
      const seq = [start, ...gamesFor(H, 5), ...gamesFor(A, 4), ...game(H)];
      const state = fold(singles, cfgFor(), seq);
      expect(state.sets).toEqual([{ home: 6, away: 4 }]); // sanity: set banked
      expect(state.games).toEqual({ home: 0, away: 0 }); // sanity: new set fresh
      // 10 games completed (an even count) → serve is back with the side that
      // opened the match.
      expect(serveContext(state)).toEqual({ side: "home", serviceTurn: 5, personId: null, serveOrderKnown: true });
    });
  });

  describe("personId via the declared doubles pair order", () => {
    it("names the pair member due, advancing the rotation as games are played", () => {
      const cfg = cfgFor("doubles-noad-mtb10");
      expect(serveContext(fold(doubles, cfg, [start]))).toEqual({
        side: "home",
        serviceTurn: 0,
        personId: "H-first",
        serveOrderKnown: true,
      });
      expect(serveContext(fold(doubles, cfg, [start, ...game(H)]))).toEqual({
        side: "away",
        serviceTurn: 0,
        personId: "A-first",
        serveOrderKnown: true,
      });
      expect(serveContext(fold(doubles, cfg, [start, ...game(H), ...game(A)]))).toEqual({
        side: "home",
        serviceTurn: 1,
        personId: "H-second",
        serveOrderKnown: true,
      });
      expect(
        serveContext(fold(doubles, cfg, [start, ...game(H), ...game(A), ...game(H), ...game(A)])),
      ).toEqual({ side: "home", serviceTurn: 2, personId: "H-first", serveOrderKnown: true }); // rotation cycles back
    });
  });

  describe("a tie-break counts as one game", () => {
    it("flips side and continues the pair rotation across a closed tie-break", () => {
      const cfg = cfgFor("doubles-noad-mtb10");
      const to66Events = [start, ...gamesFor(H, 5), ...gamesFor(A, 5), ...game(H), ...game(A)];
      const atTB = fold(doubles, cfg, to66Events);
      expect(atTB.points.kind).toBe("tiebreak"); // sanity
      expect(atTB.serving).toBe("home"); // sanity — matches nested.test.ts's own fixture
      expect(serveContext(atTB)).toEqual({ side: "home", serviceTurn: 6, personId: "H-first", serveOrderKnown: true });

      const done = fold(doubles, cfg, [...to66Events, ...straight(H, 7)]); // H takes the TB 7-0
      expect(done.sets).toEqual([{ home: 7, away: 6, tb: { home: 7, away: 0 } }]); // sanity
      expect(done.serving).toBe("away"); // sanity — ITF: TB's first server receives next
      // R4 defect 1 fix: 6 standard-game turns each in the set, then the
      // 7-point (4-turn, 2-per-side) breaker — 8 turns each once it closes.
      // Still "A-first": 6 (the pre-fix value) and 8 share a parity, the
      // coincidence the next test's OWN following game does not get.
      expect(serveContext(done)).toEqual({ side: "away", serviceTurn: 8, personId: "A-first", serveOrderKnown: true });
    });

    // R4 defect 1 (HIGH) — a 7-point breaker is really 4 ITF turns (1, then
    // 2-2-2), 2 per side, not the one "game" `nestedGamesOf` credits it. The
    // set 2 game 1 case above still names the right partner because 6 and
    // the real 8 share a parity by coincidence; ONE more game crosses a
    // floor(_/2) boundary the old formula cannot see, and the rotation
    // desyncs for the rest of the match. Real turns per side once the
    // breaker closes: 6 standard games + 2 breaker turns = 8 each — home's
    // NEXT turn (index 8, home's 9th) is even, so H-first is due again,
    // same as their pre-breaker turn 6; the old formula's index 7 is odd,
    // naming H-second instead.
    it("does not desync the doubles rotation for the game after a closed tie-break", () => {
      const cfg = cfgFor("doubles-noad-mtb10");
      const to66Events = [start, ...gamesFor(H, 5), ...gamesFor(A, 5), ...game(H), ...game(A)];
      const afterTb = [...to66Events, ...straight(H, 7)]; // H takes the TB 7-0

      const setTwoGameTwo = fold(doubles, cfg, [...afterTb, ...game(A)]); // away opens set 2
      expect(setTwoGameTwo.serving).toBe("home"); // sanity — alternation continues normally
      // Today's code answers floor(14/2) = 7 (odd), naming H-second — the
      // wrong partner, and the defect this test pins.
      expect(serveContext(setTwoGameTwo)).toEqual({
        side: "home",
        serviceTurn: 8,
        personId: "H-first",
        serveOrderKnown: true,
      });
    });

    it("scopes personId to the service game, not the point, inside a live tie-break", () => {
      const cfg = cfgFor();
      const to66Events = [start, ...gamesFor(H, 5), ...gamesFor(A, 5), ...game(H), ...game(A)];
      const opening = fold(doubles, cfg, to66Events);
      expect(serveContext(opening)).toEqual({ side: "home", serviceTurn: 6, personId: "H-first", serveOrderKnown: true });

      // 3 TB points in: real service has already passed to home's SECOND
      // partner for this (4th) point (ITF: 1 point then 2-each rotating
      // through all four players) — `side` tracks that correctly...
      const afterP3 = fold(doubles, cfg, [...to66Events, point(H), point(H), point(H)]);
      expect(afterP3.serving).toBe("home"); // sanity — point 4 is home's turn again
      // ...but `serviceTurn` is a service-GAME count (completed games are
      // unchanged mid-tie-break) and does not advance point by point, so
      // `personId` still names whoever opened home's spell in this
      // tie-break, not the individual actually due this rally. Documented
      // scope, not a silent miss — see serveContext's doc comment.
      expect(serveContext(afterP3)).toEqual({ side: "home", serviceTurn: 6, personId: "H-first", serveOrderKnown: true });
    });

    it("stays known one point into a tie-break, where `serving` has rotated", () => {
      // ITF hands the breaker's second point to the other side, so after
      // exactly one point `state.serving` is NOT the side the walk expects
      // to be serving this set — the breaker's FIRST server is. Comparing
      // `serving` alone here would report a drift in a match that has never
      // been anything but rally-scored, and would kill the serve pip for
      // half of every tie-break. `tbFirstServer` is what makes that right.
      // Mutation-proved: dropping the `tbFirstServer ?? …` fallback fails
      // this test alone.
      const cfg = cfgFor();
      const to66Events = [start, ...gamesFor(H, 5), ...gamesFor(A, 5), ...game(H), ...game(A)];
      const afterP1 = fold(doubles, cfg, [...to66Events, point(H)]);
      expect(afterP1.serving).toBe("away"); // sanity — point 2 is away's
      expect(serveContext(afterP1)).toEqual({
        side: "away",
        serviceTurn: 6,
        personId: "A-first",
        serveOrderKnown: true,
      });
    });
  });

  describe("the match-tie-break trap", () => {
    // 6-4 then 3-6, both banked via a `*.set_summary`. 6-4 is ten games, so
    // home opens set 2 as it opened set 1; 3-6 is nine, so the serve passes
    // to away, who opens the match tie-break (Rule 14; Appendix VI carries
    // the order in). Until T12-F2 a summary left `serving` where it was, so
    // this fixture used to pin a desync (home at the MTB, `serveOrderKnown`
    // false); a summary now hands the serve on like the games it records,
    // and these two tests pin the MTB turn arithmetic on a known order.
    const oneSetAll = [start, summary(6, 4), summary(3, 6)];

    it("adds nothing for an MTB still in progress, same as any other current game", () => {
      const cfg = cfgFor("doubles-noad-mtb10");
      const atDecider = fold(doubles, cfg, oneSetAll);
      expect(atDecider.points.kind).toBe("matchTiebreak"); // sanity: reached the decider

      const midMtb = fold(doubles, cfg, [...oneSetAll, ...straight(H, 3)]);
      // 10 (6-4, even, no flip) + 9 (3-6, odd, home stays ahead) standard-
      // game turns credit home 10, away 9 before the live (still open, so
      // not yet counted) MTB — unaffected by the 3 MTB points already
      // played, same as any other live breaker (see the live-tie-break
      // test above).
      // Away opens the MTB (the fixture comment): point 1 is away's, points
      // 2 and 3 home's, so away is due again after three. Away's pair has
      // served nine standard games (A-first on 0, 2, 4, 6, 8), so its
      // tenth turn, index 9, is A-second's.
      expect(serveContext(midMtb)).toEqual({
        side: "away",
        serviceTurn: 9,
        personId: "A-second",
        serveOrderKnown: true,
      });
    });

    it("does not inflate completed games by a banked MTB's raw point score", () => {
      const cfg = cfgFor("doubles-noad-mtb10");
      // MTB closes 10-0: 6 real turns (1, then 2-2-2-2), split 3-3 since 6
      // is even — not its 10 raw points and not zero. Either wrong count
      // changes `serviceTurn` here (10 raw turns/side inflates it further;
      // 0 turns leaves it at 10/9) — proven by mutation testing on the
      // production line, not re-derived in this file. Away opened it and
      // the serve turned after points 1, 3, 5, 7 and 9 (five times), so
      // home is due: its turn 10 + 3 = 13, H-second.
      const done = fold(doubles, cfg, [...oneSetAll, ...straight(H, 10)]);
      expect(done.sets[2]).toEqual({ home: 10, away: 0, mtb: true }); // sanity
      expect(serveContext(done)).toEqual({
        side: "home",
        serviceTurn: 13,
        personId: "H-second",
        serveOrderKnown: true,
      });
    });

    it("still names the partner into an MTB when both summary sets are even", () => {
      // The even case: 6-4 (10 games) and 2-6 (8) both leave the opener
      // where it was, so home opens the decider and a scorer who backfilled
      // two sets gets a serve pip there — the most common real use, a
      // late-arriving scorer entering the sets already played.
      const cfg = cfgFor("doubles-noad-mtb10");
      const atDecider = fold(doubles, cfg, [start, summary(6, 4), summary(2, 6)]);
      expect(atDecider.points.kind).toBe("matchTiebreak"); // sanity
      expect(serveContext(atDecider)).toEqual({
        side: "home",
        serviceTurn: 9,
        personId: "H-second",
        serveOrderKnown: true,
      });
    });

    // A match tie-break is NOT handed off under ITF 5b — there is no next set
    // to hand off to, and `applyTbPoint` skips the `serving:
    // opponent(tbFirstServer)` overwrite it applies to an ordinary breaker,
    // banking the raw point-by-point rotation instead. The walk must mirror
    // that rotation, not assume a handoff.
    //
    // Pinned across EVERY reachable 10-N scoreline rather than one of them,
    // because the two rules agree on a coincidence: an unconditional flip is
    // right exactly when `ceil(points / 2)` is odd, so 10-0 — the obvious
    // fixture, and the only one this file used to carry — passes under both.
    // 10-1, 10-2, 10-5 and 10-6 are where they part.
    //
    // The domain claim under the whole table, independent of the arithmetic:
    // once a match is OVER, its serve rotation is fully determined. There is
    // no honest reason for `serveOrderKnown` to be false on any row.
    const MTB_ROTATION: Array<{ lost: number; side: "home" | "away"; serviceTurn: number; personId: string }> = [
      { lost: 0, side: "away", serviceTurn: 12, personId: "A-first" },
      { lost: 1, side: "home", serviceTurn: 12, personId: "H-first" },
      { lost: 2, side: "home", serviceTurn: 13, personId: "H-second" },
      { lost: 3, side: "away", serviceTurn: 12, personId: "A-first" },
      { lost: 4, side: "away", serviceTurn: 13, personId: "A-second" },
      { lost: 5, side: "home", serviceTurn: 13, personId: "H-second" },
      { lost: 6, side: "home", serviceTurn: 14, personId: "H-first" },
      { lost: 7, side: "away", serviceTurn: 13, personId: "A-second" },
      { lost: 8, side: "away", serviceTurn: 14, personId: "A-first" },
    ];

    for (const row of MTB_ROTATION) {
      it(`tracks the fold's own rotation across a CLOSED match tie-break won 10-${row.lost}`, () => {
        const cfg = cfgFor("doubles-noad-mtb10");
        // Point ORDER cannot matter — the ITF handoff counts points, not who
        // won them — so the loser's points are taken first, then the winner's.
        const done = fold(doubles, cfg, [
          start,
          summary(6, 4),
          summary(2, 6),
          ...straight(A, row.lost),
          ...straight(H, 10),
        ]);
        expect(done.sets[2]).toEqual({ home: 10, away: row.lost, mtb: true }); // sanity
        expect(done.phase).toBe("done"); // sanity — the walk is answering for a finished match
        expect(serveContext(done)).toEqual({
          side: row.side,
          serviceTurn: row.serviceTurn,
          personId: row.personId,
          serveOrderKnown: true,
        });
      });
    }
  });

  // T12-F2 (seen on a phone, Seazn Capture S2-7). A tier-0 `*.set_summary` used to bank a set without advancing
  // `state.serving` while the turn walk advanced across it, so after any summary set with an ODD number of games
  // `serveOrderKnown` was false, and `personId` null, for the rest of the match. A summary set now hands the serve on
  // exactly as the same set played point by point would. Every expected value below is worked from the ITF Rules of
  // Tennis, never read off the code:
  //  - Rule 14: the serve alternates every game, whoever wins it; in doubles each pair's partners alternate their
  //    service games, first-named first.
  //  - Rule 5(b): the side due serves the tie-break's first point, then each side serves two in turn; the player (side)
  //    who served first in the tie-break receives in the first game of the next set. In doubles the pair order runs on
  //    through the tie-break's turns.
  //  - Appendix VI: the match tie-break carries the order in and rotates by the same 1-then-2 rule; it ends the match.
  describe("a summary-banked set hands the serve on like the games it records (T12-F2)", () => {
    const toss = (serving: string): ModuleEvent => ({ type: "tennis.toss", payload: { serving } });

    it("Grand Slam, away tossed to serve, set 1 entered as 7-6 (7-5): home serves set 2 game 1, and the order is known", () => {
      // Away served set 1's games 1, 3, …, 11 and, as the side due at 6-all, the tie-break's first point (Rule 5(b)).
      // The tie-break's first server receives first in set 2, so home serves set 2 game 1, then away game 2.
      const set1 = [start, toss(A), summary(7, 6, { home: 7, away: 5 })];
      const atSet2 = fold(singles, cfgFor("grand-slam"), set1);
      expect(atSet2.sets).toEqual([{ home: 7, away: 6, tb: { home: 7, away: 5 } }]); // sanity
      expect(serveContext(atSet2)).toMatchObject({ side: "home", serveOrderKnown: true });
      const game2 = fold(singles, cfgFor("grand-slam"), [...set1, ...game(H)]);
      expect(serveContext(game2)).toMatchObject({ side: "away", serveOrderKnown: true });
    });

    it("an ODD-game summary set (6-3, home first): away opens set 2, and the doubles partner is named", () => {
      // Nine games: home served 1, 3, 5, 7, 9 (H-first, H-second, H-first, H-second, H-first), away 2, 4, 6, 8
      // (A-first, A-second, A-first, A-second). Set 2 game 1 goes to the receiver of game 9, away, on its fifth turn:
      // A-first. Game 2 is home's sixth turn: H-second.
      const atSet2 = fold(doubles, cfgFor(), [start, summary(6, 3)]);
      expect(serveContext(atSet2)).toEqual({ side: "away", serviceTurn: 4, personId: "A-first", serveOrderKnown: true });
      const game2 = fold(doubles, cfgFor(), [start, summary(6, 3), ...game(H)]);
      expect(serveContext(game2)).toEqual({ side: "home", serviceTurn: 5, personId: "H-second", serveOrderKnown: true });
    });

    it("an ODD-game summary after an away toss (6-1): home opens set 2 with its fourth turn, H-second", () => {
      // Seven games from away: away served 1, 3, 5, 7 (four turns), home 2, 4, 6 (H-first, H-second, H-first).
      // Set 2 game 1 is home's fourth turn (index 3): H-second.
      const state = fold(doubles, cfgFor(), [start, toss(A), summary(6, 1)]);
      expect(serveContext(state)).toEqual({ side: "home", serviceTurn: 3, personId: "H-second", serveOrderKnown: true });
    });

    it("still names the partner after an EVEN-game summary set, unchanged", () => {
      // 6-2 is eight games, four turns each, so home opens set 2 as it opened set 1, on its fifth turn: H-first.
      const state = fold(doubles, cfgFor(), [start, summary(6, 2)]);
      expect(serveContext(state)).toEqual({ side: "home", serviceTurn: 4, personId: "H-first", serveOrderKnown: true });
    });

    it("a tie-break summary set (7-6, 7-5, home first): the tie-break's first server, home, receives set 2", () => {
      // Twelve games: six turns each (indices 0-5). Home, due at 6-all, serves the tie-break's first point; its twelve
      // points are seven turns, H A A H H A A H H A A H by point, so home 6, 7, 8, 9 (H-first, H-second, H-first,
      // H-second) and away 6, 7, 8 (A-first, A-second, A-first). Rule 5(b): away serves set 2 game 1, its turn 9:
      // A-second.
      const state = fold(doubles, cfgFor(), [start, summary(7, 6, { home: 7, away: 5 })]);
      expect(serveContext(state)).toEqual({ side: "away", serviceTurn: 9, personId: "A-second", serveOrderKnown: true });
    });

    it("a tie-break summary set agrees with the same set played point by point", () => {
      // The same 7-6 (7-5) set, rallied: home serves first, the sides trade games to 6-all, then the tie-break goes
      // 5-5 alternately and home takes the last two. Both ledgers must leave the serve in the same place.
      const sixAll = Array.from({ length: 12 }, (_, i) => game(i % 2 === 0 ? H : A)).flat();
      const tb = [...Array.from({ length: 10 }, (_, i) => point(i % 2 === 0 ? H : A)), point(H), point(H)];
      const rallied = fold(doubles, cfgFor(), [start, ...sixAll, ...tb]);
      expect(rallied.sets).toEqual([{ home: 7, away: 6, tb: { home: 7, away: 5 } }]); // sanity
      const summarised = fold(doubles, cfgFor(), [start, summary(7, 6, { home: 7, away: 5 })]);
      expect(summarised.serving).toBe(rallied.serving);
      expect(serveContext(summarised)).toEqual(serveContext(rallied));
    });

    it("the deciding match tie-break opens with the side the summary sets leave due", () => {
      // 6-4 (ten games) keeps home as opener; 3-6 (nine games) hands set 3 to away, so away serves the match
      // tie-break's first point (Appendix VI: the order carries in).
      const atMtb = fold(doubles, cfgFor("doubles-noad-mtb10"), [start, summary(6, 4), summary(3, 6)]);
      expect(atMtb.points.kind).toBe("matchTiebreak"); // sanity
      expect(atMtb.tbFirstServer).toBe("away");
      expect(serveContext(atMtb)).toMatchObject({ side: "away", serveOrderKnown: true });
    });

    // A match tie-break entered as its summary ends the match where the same breaker rallied would: home opens it
    // (both sets even) and the server turns after points 1, 3, 5, …, so the serve has passed iff the turns of serve,
    // ceil(points / 2), are odd: 10-0 (five turns) and 10-7 (nine) leave away due, 10-1 (six) and 10-6 (eight) home.
    // 10-0 and 10-1 are where that differs from the parity of the points themselves. The rows are MTB_ROTATION's.
    const MTB_SUMMARY: Array<{ lost: number; side: "home" | "away"; serviceTurn: number; personId: string }> = [
      { lost: 0, side: "away", serviceTurn: 12, personId: "A-first" },
      { lost: 1, side: "home", serviceTurn: 12, personId: "H-first" },
      { lost: 6, side: "home", serviceTurn: 14, personId: "H-first" },
      { lost: 7, side: "away", serviceTurn: 13, personId: "A-second" },
    ];
    for (const row of MTB_SUMMARY) {
      it(`a match tie-break summary 10-${row.lost} leaves the serve where the rallied breaker does`, () => {
        const done = fold(doubles, cfgFor("doubles-noad-mtb10"), [start, summary(6, 4), summary(2, 6), summary(10, row.lost)]);
        expect(done.phase).toBe("done"); // sanity
        expect(serveContext(done)).toEqual({
          side: row.side,
          serviceTurn: row.serviceTurn,
          personId: row.personId,
          serveOrderKnown: true,
        });
      });
    }

    it("reports a rally-scored match as known throughout, live tie-break included", () => {
      const state = fold(doubles, cfgFor(), [start, ...gamesFor(H, 6), ...gamesFor(A, 6)]);
      expect(serveContext(state).serveOrderKnown).toBe(true);
    });
  });

  // Review L1 of engine PR #47 (9.0.0). The summary rows above are checked against hand-worked values only. Here the
  // oracle is the fold itself on the other path: the same set (or match tie-break) entered as one `tennis.set_summary`
  // must leave the serve, the breaker's first server, the walk's answer and the result exactly where the same set
  // rallied point by point leaves them. No expected value in this block is written by hand.
  describe("summary path agrees with the rally path (parity, review L1 of #47)", () => {
    const toss = (serving: string): ModuleEvent => ({ type: "tennis.toss", payload: { serving } });
    const other = (side: string): string => (side === H ? A : H);

    // A unit (game or breaker point) sequence reaching `won`-`lost` for `winner`: the sides alternate, winner first,
    // until each has `lost`, then the winner takes the rest. The lead never exceeds one before the last run, so the
    // unit closes exactly at the score asked for, never early.
    function alternating(winner: string, won: number, lost: number, unit: (by: string) => ModuleEvent[]): ModuleEvent[] {
      const seq: ModuleEvent[] = [];
      for (let i = 0; i < lost; i++) seq.push(...unit(winner), ...unit(other(winner)));
      for (let i = lost; i < won; i++) seq.push(...unit(winner));
      return seq;
    }
    const pointUnit = (by: string): ModuleEvent[] => [point(by)];

    // `won`-`lost` from the winner's side, with an optional tie-break (also from the winner's side).
    type SetScore = { won: number; lost: number; tb?: { won: number; lost: number } };
    function ralliedSet(winner: string, s: SetScore): ModuleEvent[] {
      if (s.tb === undefined) return alternating(winner, s.won, s.lost, game);
      // To 6-all by alternating games, then the breaker.
      return [...alternating(winner, s.lost, s.lost, game), ...alternating(winner, s.tb.won, s.tb.lost, pointUnit)];
    }
    function summarisedSet(winner: string, s: SetScore): ModuleEvent {
      const flip = <T>(w: T, l: T) => (winner === H ? { home: w, away: l } : { home: l, away: w });
      const games = flip(s.won, s.lost);
      return summary(games.home, games.away, s.tb === undefined ? undefined : flip(s.tb.won, s.tb.lost));
    }

    function expectParity(lineups: LineupPair, cfg: unknown, rallied: ModuleEvent[], summarised: ModuleEvent[]) {
      const r = fold(lineups, cfg, rallied);
      const s = fold(lineups, cfg, summarised);
      // Sanity: both paths banked the same score — otherwise the parity below compares two different matches.
      expect(s.sets).toEqual(r.sets);
      expect(s.setsWon).toEqual(r.setsWon);
      expect(s.phase).toBe(r.phase);
      expect(s.outcome).toEqual(r.outcome);
      expect(s.serving).toBe(r.serving);
      expect(s.tbFirstServer).toBe(r.tbFirstServer);
      expect(serveContext(s)).toEqual(serveContext(r));
      return r;
    }

    const LINEUPS: Array<[string, LineupPair]> = [
      ["singles", singles],
      ["doubles (declared pair order)", doubles],
    ];
    const OPENERS: Array<[string, ModuleEvent[]]> = [
      ["home first", []],
      ["away tossed to serve", [toss(A)]],
    ];
    const WINNERS = [H, A];

    describe("a set entered as a summary vs the same set rallied", () => {
      const SETS: Array<[string, SetScore]> = [
        ["6-3", { won: 6, lost: 3 }],
        ["6-4", { won: 6, lost: 4 }],
        ["7-6 (7-5)", { won: 7, lost: 6, tb: { won: 7, lost: 5 } }],
        ["7-6 (12-10)", { won: 7, lost: 6, tb: { won: 12, lost: 10 } }],
      ];
      // The tour default and the doubles no-ad preset (its first two sets are ordinary sets).
      const CFGS: Array<[string, unknown]> = [
        ["tour", cfgFor()],
        ["doubles-noad-mtb10", cfgFor("doubles-noad-mtb10")],
      ];
      for (const [lineupName, lineups] of LINEUPS)
        for (const [cfgName, cfg] of CFGS)
          for (const [openerName, opener] of OPENERS)
            for (const winner of WINNERS)
              for (const [setName, score] of SETS) {
                it(`${lineupName}, ${cfgName}, ${openerName}: set 1 ${setName} to ${winner}, and the game after it`, () => {
                  const head = [start, ...opener];
                  const rallied = [...head, ...ralliedSet(winner, score)];
                  const summarised = [...head, summarisedSet(winner, score)];
                  const r = expectParity(lineups, cfg, rallied, summarised);
                  expect(r.sets).toHaveLength(1); // sanity — the rallied set really closed
                  // One more game on top: the next server must agree too, not only the banked state.
                  expectParity(lineups, cfg, [...rallied, ...game(H)], [...summarised, ...game(H)]);
                  // And a second set entered the other way round (summary after rally, rally after summary).
                  expectParity(
                    lineups,
                    cfg,
                    [...rallied, ...ralliedSet(other(winner), score)],
                    [...summarised, summarisedSet(other(winner), score)],
                  );
                });
              }
    });

    describe("a match tie-break entered as a summary vs the same breaker rallied", () => {
      // The doubles no-ad MTB10 preset, and a singles tour config with the same App VI decider.
      const CFGS: Array<[string, LineupPair, unknown]> = [
        ["doubles, doubles-noad-mtb10", doubles, cfgFor("doubles-noad-mtb10")],
        ["singles, MTB10 decider", singles, cfgFor(undefined, { finalSet: { matchTiebreakTo: 10 } })],
      ];
      // Two rallied routes to one set all: an even total (6-4, 4-6: home opens the MTB as it opened the match) and an
      // odd one (6-4, 3-6: the opener changes). Both ledgers share this prefix verbatim.
      const ROUTES: Array<[string, ModuleEvent[]]> = [
        ["6-4 4-6", [...ralliedSet(H, { won: 6, lost: 4 }), ...ralliedSet(A, { won: 6, lost: 4 })]],
        ["6-4 3-6", [...ralliedSet(H, { won: 6, lost: 4 }), ...ralliedSet(A, { won: 6, lost: 3 })]],
      ];
      const MTBS: Array<[number, number]> = [
        [10, 0],
        [10, 1],
        [10, 8],
        [12, 10],
      ];
      for (const [cfgName, lineups, cfg] of CFGS)
        for (const [openerName, opener] of OPENERS)
          for (const [routeName, route] of ROUTES)
            for (const winner of WINNERS)
              for (const [won, lost] of MTBS) {
                it(`${cfgName}, ${openerName}, ${routeName}: MTB ${won}-${lost} to ${winner}`, () => {
                  const head = [start, ...opener, ...route];
                  const atDecider = fold(lineups, cfg, head);
                  expect(atDecider.points.kind).toBe("matchTiebreak"); // sanity — both ledgers reach the decider
                  const r = expectParity(
                    lineups,
                    cfg,
                    [...head, ...alternating(winner, won, lost, pointUnit)],
                    [...head, summarisedSet(winner, { won, lost })],
                  );
                  expect(r.phase).toBe("done"); // sanity — the rallied breaker really ended the match
                  expect(r.sets[2]).toMatchObject({ mtb: true });
                });
              }
    });
  });
});
