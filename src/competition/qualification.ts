// Standings qualification status — spec
// docs/superpowers/specs/2026-09-22-standings-qualification-status-design.md §3.
// Pure. Independent-rival bound (R3): each rival is allowed its own best and
// worst case regardless of whom it plays. That admits outcomes that cannot
// happen (two rivals who meet cannot both win), so every Through/Out it prints
// also holds over the real outcomes; it can only be too cautious.
import type { EntrantId } from "../core/types.ts";
import type { MatchPointsBounds } from "../sport/module.ts";

export type QualStatus =
  | { kind: "through" }
  | { kind: "out" }
  | { kind: "win_k"; k: number }
  | { kind: "needs_help" }
  /** W5 (X-QS-1, RB5-T2): the frozen marker of a complete stage's row that went through. Its pair is `out`. */
  | { kind: "qualified" };

export interface QualRow {
  entrantId: EntrantId;
  /** The table's match points (carry-over included). */
  points: number;
  /** false for a withdrawn/disqualified entrant: no status of its own, but
   *  still a rival — and NOT frozen at `points`. A status-only departure (a DQ
   *  by PATCH, a registrant's self-cancel) leaves its fixtures scheduled, and a
   *  later forfeit pays it the loser's points, which can be above 0 or below
   *  it; so its `remaining` (its unplayed fixtures) is read like any row's,
   *  bounded by the full per-match [min, max] (final review I1). */
  active: boolean;
}

export interface QualificationInput {
  rows: readonly QualRow[];
  /** entrant → matches left in THIS table (Swiss: rounds not yet settled). A
   *  departed row's too: its unplayed fixtures here (0 once they are voided or
   *  walked over). Every row needs one; a missing count fails closed. */
  remaining: ReadonlyMap<EntrantId, number>;
  perMatch: MatchPointsBounds;
  /** Places that go through from this table (a pool's quota under topNPerGroup). */
  cut: number;
  anyPlayed: boolean;
  complete: boolean;
  /** Read only when `complete` (RB5-T14): who actually went through — the confirmed proposal or `config.qualified`.
   *  Wins over `order`. */
  qualified?: ReadonlySet<EntrantId>;
  /** Read only when `complete` and `qualified` is absent: the final table in rank order; its first `cut` ACTIVE ids
   *  are Qualified, the other active rows Out. Every active row must appear exactly once, else no markers. */
  order?: readonly EntrantId[];
}

export interface QualRowResult {
  status: QualStatus;
  /** Status after losing the next match — only for the two open statuses. */
  ifYouLose: QualStatus | null;
}

function remainingOf(input: QualificationInput, row: QualRow): number {
  return Math.max(0, input.remaining.get(row.entrantId) ?? 0);
}
export function bestCase(input: QualificationInput, row: QualRow): number {
  return row.points + remainingOf(input, row) * input.perMatch.max;
}
export function worstCase(input: QualificationInput, row: QualRow): number {
  return row.points + remainingOf(input, row) * input.perMatch.min;
}

/** `lo`/`hi`: the least/most the row can already be sure of; `r`: matches left. */
interface Own { lo: number; hi: number; r: number }

function statusFor(input: QualificationInput, entrantId: EntrantId, own: Own): QualStatus {
  const rivals = input.rows.filter((row) => row.entrantId !== entrantId);
  const count = (pred: (row: QualRow) => boolean) => rivals.filter(pred).length;
  const { max, min, winFloor } = input.perMatch;
  const myWorst = own.lo + own.r * min;
  const myBest = own.hi + own.r * max;
  // R4: `≥` — a rival who can draw level counts as a rival who can beat you.
  if (count((j) => bestCase(input, j) >= myWorst) < input.cut) return { kind: "through" };
  if (count((j) => worstCase(input, j) > myBest) >= input.cut) return { kind: "out" };
  for (let k = 1; k <= own.r; k++) {
    const target = own.lo + k * winFloor + (own.r - k) * min;
    if (count((j) => bestCase(input, j) >= target) < input.cut) return { kind: "win_k", k };
  }
  return { kind: "needs_help" };
}

/** Malformed input fails CLOSED (review fix 1, controller ruling). Read
 *  leniently, each of these prints a false status: a missing count reads as
 *  "final", NaN as "never reaches" (every comparison false), a negative count
 *  as points taken away. A departed row's count is read too — it is a rival
 *  whose unplayed fixtures can still pay it points (final review I1) — so a
 *  missing one would be the old frozen guess. */
function wellFormed(input: QualificationInput): boolean {
  return input.rows.every((row) => {
    if (!Number.isFinite(row.points)) return false;
    const r = input.remaining.get(row.entrantId) ?? Number.NaN; // missing → not a count
    return Number.isInteger(r) && r >= 0;
  });
}

/** W5 frozen markers (X-QS-1; RB5-T1, T2, T14): a complete stage stops the live computation and reads Qualified / Out
 *  from who went through (`qualified`), else the final table's cut (`order`). No order source, or a malformed one, fails
 *  closed (null for the table). A departed row stays null; no marker carries an if-you-lose. */
function frozenStatus(input: QualificationInput): ReadonlyMap<EntrantId, QualRowResult | null> | null {
  if (input.rows.length === 0) return null;
  let through: ReadonlySet<EntrantId>;
  if (input.qualified !== undefined) {
    through = input.qualified;
  } else if (input.order !== undefined) {
    if (!Number.isInteger(input.cut) || input.cut < 1) return null;
    const active = new Set(input.rows.filter((row) => row.active).map((row) => row.entrantId));
    const ranked = input.order.filter((id) => active.has(id));
    // every active row ranked exactly once, or the cut cannot be placed
    if (ranked.length !== active.size || new Set(ranked).size !== ranked.length) return null;
    through = new Set(ranked.slice(0, input.cut));
  } else {
    return null;
  }
  const out = new Map<EntrantId, QualRowResult | null>();
  for (const row of input.rows) {
    if (!row.active) {
      out.set(row.entrantId, null);
      continue;
    }
    out.set(row.entrantId, { status: through.has(row.entrantId) ? { kind: "qualified" } : { kind: "out" }, ifYouLose: null });
  }
  return out;
}

/** Per-row status for one table, or null when the table shows none (§3.3). A complete stage reads its frozen markers
 *  (W5, X-QS-1); an open one with nothing played shows none. */
export function qualificationStatus(
  input: QualificationInput,
): ReadonlyMap<EntrantId, QualRowResult | null> | null {
  if (input.complete) return frozenStatus(input);
  if (!input.anyPlayed) return null;
  if (!Number.isInteger(input.cut) || input.cut < 1 || input.rows.length === 0) return null;
  if (!wellFormed(input)) return null;
  const out = new Map<EntrantId, QualRowResult | null>();
  for (const row of input.rows) {
    if (!row.active) {
      out.set(row.entrantId, null);
      continue;
    }
    const r = remainingOf(input, row);
    const status = statusFor(input, row.entrantId, { lo: row.points, hi: row.points, r });
    const open = status.kind === "win_k" || status.kind === "needs_help";
    const ifYouLose =
      open && r >= 1
        ? statusFor(input, row.entrantId, {
            lo: row.points + input.perMatch.min,
            hi: row.points + input.perMatch.lossCeil,
            r: r - 1,
          })
        : null;
    out.set(row.entrantId, { status, ifYouLose });
  }
  return out;
}

/** §3.4 step 4: the nearest entrant across the line with whom a tie on points
 *  is still reachable. `orderedIds` is the table in rank order. */
export function tieRival(
  input: QualificationInput,
  orderedIds: readonly EntrantId[],
  entrantId: EntrantId,
): EntrantId | null {
  const byId = new Map(input.rows.map((row) => [row.entrantId, row]));
  const me = byId.get(entrantId);
  const i = orderedIds.indexOf(entrantId);
  if (!me || i < 0) return null;
  const across = i < input.cut ? orderedIds.slice(input.cut) : orderedIds.slice(0, input.cut).reverse();
  const lo = worstCase(input, me);
  const hi = bestCase(input, me);
  for (const id of across) {
    const j = byId.get(id);
    if (j && Math.max(lo, worstCase(input, j)) <= Math.min(hi, bestCase(input, j))) return id;
  }
  return null;
}
