// W4 test driver (plan 2026-11-05-w4-knockout-engine.md, Task 6): plays a generated bracket out into the `BracketFixture`
// rows the app's `bracketWinnerLoser` writes (apps/web/src/server/engine-db/competition.ts), so a ranking test folds the
// GENERATOR's own output rather than a hand-typed fixture list. Not exported from the testkit index: a test imports it
// by path. It reads only the generator's shape (types) and writes only stage-shaped rows (types).
//
// Feeds resolve round by round, in the generator's order (every feed names an earlier fixture):
//   - a bye `award` is a walkover with a winner and no loser (the app's row for a bye);
//   - `forfeit`: the named entrant forfeits — a walkover the other side wins, `walkedOver: "loser"`; the forfeiter is out
//     there, so its onward LOSER feeds (a third-place play-off, a page playoff's Qualifier 2, a losers'-bracket seat) are
//     dead (X-DE-1; controller ruling B3-10);
//   - `doubleWalkover`: both sides walked over — `walkedOver: "both"`, no winner and no loser, every onward seat dead;
//   - `voided`: the fixture is void, nobody advances from it;
//   - `jointFinal`: the final, both sides seated, is decided with no winner — `jointWinners: true` (Q4, X-CH-1) — so a
//     double-elimination bracket reset after it has no one to seat and is void;
//   - a fixture with one seat dead is a walkover to the side present (no loser); with both dead it is void;
//   - a double-elim bracket reset (`conditional`) is played only when the losers'-bracket champion won the grand final,
//     and voided otherwise (spec 05 §2.4);
//   - otherwise it is decided by `winner(home, away)`, by default the better seed (the lower seed number; home on a tie).
import type { EntrantId } from "../core/types.ts";
import type { BracketFixture } from "../competition/stage.ts";
import type { BracketSlotRef, GeneratedBracket } from "../scheduling/bracket.ts";

export interface PlayOutOptions {
  /** Who wins a fixture played between two seated sides. Default: the better seed (lower number), home on a tie. */
  winner?: (home: EntrantId, away: EntrantId) => EntrantId;
  /** The seeds the default winner reads. Absent = every side unseeded (home wins). */
  seeds?: ReadonlyMap<EntrantId, number>;
  /** Fixture id → the entrant who forfeits it (the loser, `walkedOver: "loser"`). */
  forfeit?: ReadonlyMap<string, EntrantId>;
  /** Fixture ids both sides walked over (`walkedOver: "both"`). */
  doubleWalkover?: ReadonlySet<string>;
  /** Fixture ids voided. */
  voided?: ReadonlySet<string>;
  /** The final (both sides seated) ends in joint winners: `status: "decided"`, `jointWinners: true`, no winner or loser. */
  jointFinal?: boolean;
}

export function playOutBracket(gen: GeneratedBracket, opts: PlayOutOptions = {}): BracketFixture[] {
  const seedOf = (id: EntrantId): number => opts.seeds?.get(id) ?? Number.MAX_SAFE_INTEGER;
  const winnerOf = opts.winner ?? ((home: EntrantId, away: EntrantId): EntrantId => (seedOf(away) < seedOf(home) ? away : home));
  const byId = new Map<string, BracketFixture>();
  const rows: BracketFixture[] = [];

  const feed = (ref: BracketSlotRef | undefined): EntrantId | undefined => {
    if (ref === undefined) return undefined;
    const source = byId.get(ref.fixtureId);
    if (source === undefined) throw new Error(`playOutBracket: "${ref.fixtureId}" is fed before it is played`);
    if (ref.side === "winner") return source.winner;
    // A forfeiter is out at the fixture it forfeited: it never takes a loser's seat onward (B3-10).
    return source.walkedOver === "loser" ? undefined : source.loser;
  };

  for (const g of gen.fixtures) {
    const home = g.home ?? feed(g.homeFrom);
    const away = g.away ?? feed(g.awayFrom);
    const base: BracketFixture = {
      id: g.id,
      round: g.round,
      ...(g.bracket === undefined ? {} : { bracket: g.bracket }),
      ...(g.isFinal === undefined ? {} : { isFinal: g.isFinal }),
      ...(g.thirdPlace === undefined ? {} : { thirdPlace: g.thirdPlace }),
      ...(home === undefined ? {} : { home }),
      ...(away === undefined ? {} : { away }),
      status: "scheduled",
    };
    let row: BracketFixture;
    const resetNotNeeded = g.conditional === true && (() => {
      const gf = g.homeFrom === undefined ? undefined : byId.get(g.homeFrom.fixtureId);
      return gf?.winner !== undefined && gf.winner === gf.home;
    })();
    const forfeiter = opts.forfeit?.get(g.id);
    const present = home ?? away; // the one side seated, when only one is
    if (g.award !== undefined) {
      row = { ...base, status: "walkover", winner: g.award };
    } else if (opts.voided?.has(g.id) === true || resetNotNeeded) {
      row = { ...base, status: "void" };
    } else if (home !== undefined && away !== undefined && opts.doubleWalkover?.has(g.id) === true) {
      row = { ...base, status: "walkover", walkedOver: "both" };
    } else if (home !== undefined && away !== undefined && forfeiter !== undefined) {
      if (forfeiter !== home && forfeiter !== away) throw new Error(`playOutBracket: "${forfeiter}" is not seated in ${g.id}`);
      row = { ...base, status: "walkover", winner: forfeiter === home ? away : home, loser: forfeiter, walkedOver: "loser" };
    } else if (home !== undefined && away !== undefined && opts.jointFinal === true && g.isFinal === true) {
      row = { ...base, status: "decided", jointWinners: true };
    } else if (home !== undefined && away !== undefined) {
      const winner = winnerOf(home, away);
      row = { ...base, status: "decided", winner, loser: winner === home ? away : home };
    } else if (present !== undefined) {
      row = { ...base, status: "walkover", winner: present };
    } else {
      row = { ...base, status: "void" };
    }
    byId.set(g.id, row);
    rows.push(row);
  }
  return rows;
}
