// W4 knockout engine, Task 9 (owner ruling 265, plate option B): the plate's field, read off a single-elimination main
// draw. RB4-P1 (X-PL-3): the plate holds everyone's first loss — every round-1 loser, plus every bye holder who loses their
// first match (in round 2). RB4-P2 (X-PL-4): a first loss by walkover, withdrawal, retirement or disqualification is left
// out. RB4-P3: the field is known after round 2 and never waits for the main final. Pure: it reads the caller's rows and
// no sport module.
//
// The engine's round 0 is the product's "round 1", its round 1 the product's "round 2" (the rows' `round`, as the
// generator numbers it). An entrant's FIRST MATCH is their round-0 line when they played it; when they did not (a bye
// award, a walkover win, a voided line) it is their round-1 fixture, and there is no first match after that — a bye
// holder who walks through round 2 has won its first match, and its later loss is no first loss.
import { EngineError } from "../core/errors.ts";
import type { EntrantId } from "../core/types.ts";
import type { BracketFixtureRow } from "./progression.ts";
import { SETTLED_FIXTURE_STATUSES, type FixtureStatus } from "./stage.ts";

/** One entrant's first loss: the fixture it came in and that fixture's (engine) round. */
export interface FirstLoss {
  readonly entrantId: EntrantId;
  readonly fixtureId: string;
  readonly round: number;
}

/** The plate's field. `losers` are the eligible first losses (RB4-P1), `excluded` the first losses by forfeit (RB4-P2),
 *  both ordered by round, then by the fixture's place in the caller's rows (bracket order; the caller is the ordering
 *  authority, as for `roundLosers`), home before away. `pending` names every fixture a first match still waits on, in row
 *  order. `complete` is true once the main draw exists and nothing is pending: the field is final. No rows at all is no
 *  main draw yet, so never complete (controller ruling B4-2): "too small" is the app's to decide once it is (X-PL-2). */
export interface FirstLossField {
  readonly complete: boolean;
  readonly losers: readonly FirstLoss[];
  readonly excluded: readonly FirstLoss[];
  readonly pending: readonly string[];
}

type FieldRow = BracketFixtureRow & { readonly id: string; readonly status: FixtureStatus };

/** Assumptions are guards: the field needs each row's id and status, and only a single-elimination draw has one first
 *  match per entrant in its first two rounds — a double elimination's losers' bracket and grand final are refused. */
function fieldRows(rows: readonly BracketFixtureRow[]): FieldRow[] {
  return rows.map((row, index) => {
    if (row.id === undefined) {
      throw new EngineError("CONFIG_INVALID", `firstLossField: bracket row ${index} has no id`, { reason: "first_loss_row_without_id", index });
    }
    if (row.status === undefined) {
      throw new EngineError("CONFIG_INVALID", `firstLossField: bracket row "${row.id}" has no status`, {
        reason: "first_loss_row_without_status",
        fixtureId: row.id,
      });
    }
    if (row.bracket === "LB" || row.bracket === "GF") {
      throw new EngineError("CONFIG_INVALID", `firstLossField: "${row.id}" is a ${row.bracket} row — the plate is fed by a single-elimination draw`, {
        reason: "first_loss_not_single_elimination",
        fixtureId: row.id,
        bracket: row.bracket,
      });
    }
    return row as FieldRow;
  });
}

const settled = (row: FieldRow): boolean => SETTLED_FIXTURE_STATUSES.has(row.status);
const seats = (row: FieldRow, entrant: EntrantId): boolean => row.home === entrant || row.away === entrant;
/** Played: settled, both seats, a winner and a loser, and no walkover. */
const played = (row: FieldRow): boolean =>
  settled(row) && row.home !== undefined && row.away !== undefined && row.winner !== undefined && row.loser !== undefined && row.walkedOver === undefined;
/** Lost without playing (RB4-P2): the forfeiting loser — `walkedOver: "loser"`, whatever the app's reason (walkover,
 *  retirement, disqualification, withdrawal) — or either seated side of a double walkover. */
const forfeitedBy = (row: FieldRow, entrant: EntrantId): boolean =>
  settled(row) && seats(row, entrant) && ((row.walkedOver === "loser" && row.loser === entrant) || row.walkedOver === "both");

export function firstLossField(rows: readonly BracketFixtureRow[]): FirstLossField {
  const all = fieldRows(rows);
  const place = new Map(all.map((row, i) => [row.id, i]));
  const opening = all.filter((row) => row.round === 0);
  const second = all.filter((row) => row.round === 1);
  const losers: FirstLoss[] = [];
  const excluded: FirstLoss[] = [];
  const pending = new Set<string>();

  // `entrant`'s first match is `row`: a played loss is a first loss, a forfeit an excluded one, anything else (a win, by
  // play or by walkover, a voided line) none. An unsettled first match leaves the field open.
  const judge = (row: FieldRow, entrant: EntrantId): void => {
    if (!settled(row)) {
      pending.add(row.id);
      return;
    }
    const loss: FirstLoss = { entrantId: entrant, fixtureId: row.id, round: row.round };
    if (played(row)) {
      if (row.loser === entrant) losers.push(loss);
    } else if (forfeitedBy(row, entrant)) {
      excluded.push(loss);
    }
  };

  for (const line of opening) {
    for (const entrant of [line.home, line.away]) {
      if (entrant === undefined) continue;
      if (!settled(line) || played(line) || forfeitedBy(line, entrant)) {
        judge(line, entrant);
        continue;
      }
      // Not played in round 0 (a bye award, a walkover win, a voided line): the first match is round 1's.
      const next = second.find((row) => seats(row, entrant));
      if (next !== undefined) judge(next, entrant);
      // Advanced, but not yet seated in round 1: its first match is still to come.
      else if (line.winner === entrant) pending.add(line.id);
      // Otherwise nobody advances from this line (a void, controller ruling B4-5): no first loss to wait for (R13).
    }
  }

  const byRound = (a: FirstLoss, b: FirstLoss): number => a.round - b.round || (place.get(a.fixtureId) ?? 0) - (place.get(b.fixtureId) ?? 0);
  return {
    complete: opening.length > 0 && pending.size === 0,
    losers: losers.sort(byRound),
    excluded: excluded.sort(byRound),
    pending: [...pending].sort((a, b) => (place.get(a) ?? 0) - (place.get(b) ?? 0)),
  };
}
