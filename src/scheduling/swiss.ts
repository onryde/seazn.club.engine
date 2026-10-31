// Swiss pairing — spec 05 §2.2. Chess-correct, sport-generic, behind the
// `pairRound(standings, history, constraints)` interface so the algorithm can be
// swapped without touching callers (full FIDE Dutch via weighted matching is a
// later refinement — the spec explicitly defers it).
//
// Implementation: order by score group then pairing rank, fold top-vs-bottom,
// and resolve violations by a COMPLETE backtracking matching that prefers the
// fold but explores every transposition. Completeness is what makes the "a
// total pairing exists whenever a perfect matching exists" property hold — the
// search only fails when no rematch-free (and, for chess, colour-legal) perfect
// matching exists at all. Determinism: candidate order is fixed (fold distance,
// then global rank order), so the same inputs always yield the same pairing.
//
// When it fails, pairRound returns a named refusal (SWISS_NO_LEGAL_PAIRING with
// its reason) that writes nothing, not even the bye — never an empty or partial
// round reported as success (W3 X-SW-3; rulebook-W3 §3.3, P-A6; FIDE C.04.3 [C4]).
import { EngineError } from "../core/errors.ts";
import type { EntrantId } from "../core/types.ts";

export type Colour = "W" | "B";

// One entrant's row as the pairer sees it: current Swiss score and pairing rank
// (rating/seed; lower = stronger). Everything else (metrics, tiebreaks) is
// irrelevant to pairing and stays out.
export interface SwissStanding {
  entrantId: EntrantId;
  score: number;
  rank: number;
}

export interface SwissHistory {
  played: ReadonlySet<string>; // pairKey(a,b) of every fixture already contested — no rematch (hard)
  colours?: ReadonlyMap<EntrantId, readonly Colour[]>; // colour sequence per entrant (chess)
  byes?: ReadonlySet<EntrantId>; // entrants NOT eligible for the bye: already had one, or (FIDE C.04.1(d)) won a walkover. Read only by the bye pick.
  floats?: ReadonlyMap<EntrantId, number>; // downfloat count (avoid repeat floats — soft)
}

export interface SwissConstraints {
  chess?: boolean; // enforce colour rules and read home/away as White/Black
  byeScore?: number; // documented for the caller; pairRound only names the bye entrant
  /** Hammes preset (Jul3/08 §7, 20 Jan): pair ADJACENT ranks (1v2, 3v4, …)
   *  instead of folding top-vs-bottom; the no-rematch backtracking is shared. */
  pairing?: "fold" | "rank_adjacent";
}

export interface SwissPairing {
  home: EntrantId; // chess: White
  away: EntrantId; // chess: Black
}

// W3 X-SW-3 (rulebook-W3 §3.3, P-A6): the code of every refusal, and why the round cannot be paired.
export const SWISS_NO_LEGAL_PAIRING = "SWISS_NO_LEGAL_PAIRING" as const;
export type SwissRefusalReason =
  | "field_too_small" // fewer than 2 entrants
  | "no_bye_candidate" // odd field and every entrant is bye-ineligible (P-A4)
  | "rematch" // no rematch-free perfect matching exists (P-A1/A6)
  | "colour" // a rematch-free matching exists, but none meets the chess colour limits (P-A5)
  | "search_limit"; // the search budget ran out before it proved either

// A round that cannot be paired. It carries no pairing and no bye: the caller seats nothing from it.
export interface SwissRefusal {
  readonly ok: false;
  readonly code: typeof SWISS_NO_LEGAL_PAIRING;
  readonly reason: SwissRefusalReason;
  readonly field: number; // standings.length, for the message ("Round N can't be paired")
}

export interface SwissRound {
  readonly ok: true;
  pairings: SwissPairing[]; // always ⌊n/2⌋ ≥ 1 boards
  bye?: EntrantId; // present iff n is odd: the entrant sitting out
  floated: EntrantId[]; // entrants that downfloated this round (merge into history.floats)
}

export type SwissPairResult = SwissRound | SwissRefusal;

// The search nodes one pairRound call may visit (the pairing search and the reason probe together). A call that runs out
// before it either pairs the round or proves it unpairable is refused `search_limit`, never reported as having no pairing.
export const SWISS_SEARCH_BUDGET: number = 1_000_000;

// Stable, order-independent key for an unordered pair.
export function pairKey(a: EntrantId, b: EntrantId): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

const opposite = (c: Colour): Colour => (c === "W" ? "B" : "W");

interface ColourState {
  diff: number; // white − black
  streakColour: Colour | null;
  streakLen: number;
}

function colourState(seq: readonly Colour[] | undefined): ColourState {
  if (seq === undefined || seq.length === 0) return { diff: 0, streakColour: null, streakLen: 0 };
  let w = 0;
  let b = 0;
  for (const c of seq) {
    if (c === "W") w++;
    else b++;
  }
  const streakColour = seq[seq.length - 1] as Colour;
  let streakLen = 1;
  for (let i = seq.length - 2; i >= 0; i--) {
    if (seq[i] === streakColour) streakLen++;
    else break;
  }
  return { diff: w - b, streakColour, streakLen };
}

// The two hard colour rules (spec 05 §2.2): |W−B| ≤ 2 after the round, and never
// three consecutive same colours.
function canTake(state: ColourState, c: Colour): boolean {
  if (c === "W" ? state.diff + 1 > 2 : state.diff - 1 < -2) return false;
  if (state.streakColour === c && state.streakLen >= 2) return false;
  return true;
}

// Preferred colour to keep the balance level: the minority colour, or the
// alternation of the last one when balanced. `null` = no preference (round 1).
function preferredColour(state: ColourState): Colour | null {
  if (state.diff > 0) return "B";
  if (state.diff < 0) return "W";
  if (state.streakColour !== null) return opposite(state.streakColour);
  return null;
}

// Order (score desc, rank asc, id asc) — the pairing order all groups derive from.
function pairingOrder(standings: readonly SwissStanding[]): SwissStanding[] {
  return [...standings].sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.entrantId < b.entrantId ? -1 : a.entrantId > b.entrantId ? 1 : 0;
  });
}

// Split an already-ordered pool into score groups (runs of equal score, desc).
function groupByScore(pool: readonly SwissStanding[]): SwissStanding[][] {
  const groups: SwissStanding[][] = [];
  for (const s of pool) {
    const last = groups[groups.length - 1];
    if (last === undefined || (last[0] as SwissStanding).score !== s.score) groups.push([s]);
    else last.push(s);
  }
  return groups;
}

// Combinations of `k` items from `items`, yielded in `items` order (so the
// caller's preference ordering carries through).
function* combinations<T>(items: readonly T[], k: number): Generator<T[]> {
  if (k === 0) {
    yield [];
    return;
  }
  for (let i = 0; i <= items.length - k; i++) {
    const head = items[i] as T;
    for (const tail of combinations(items.slice(i + 1), k - 1)) yield [head, tail].flat() as T[];
  }
}

// Which `fc` entrants of `current` to float down. Prefer the least-floated, then
// the lowest-ranked (bottom of the group) — "avoid repeat floats" (spec 05
// §2.2). Only the bottom window is considered, which bounds the combinations.
function floaterChoices(
  current: readonly SwissStanding[],
  fc: number,
  floatCountOf: (id: EntrantId) => number,
): SwissStanding[][] {
  if (fc === 0) return [[]];
  const windowSize = Math.min(current.length, Math.max(fc + 3, 4));
  const window = current.slice(current.length - windowSize);
  const ordered = [...window].sort((a, b) => {
    const fa = floatCountOf(a.entrantId);
    const fb = floatCountOf(b.entrantId);
    if (fa !== fb) return fa - fb; // least-floated first
    return current.indexOf(b) - current.indexOf(a); // bottom (lowest-ranked) first
  });
  return [...combinations(ordered, fc)];
}

export function pairRound(
  standings: readonly SwissStanding[],
  history: SwissHistory,
  constraints: SwissConstraints = {},
  budget: number = SWISS_SEARCH_BUDGET,
): SwissPairResult {
  // An entrant listed twice would be seated twice (or paired with itself): a caller defect, never a round to pair.
  const seen = new Set<EntrantId>();
  for (const s of standings) {
    if (seen.has(s.entrantId)) {
      throw new EngineError("CONFIG_INVALID", `pairRound: entrant "${s.entrantId}" appears twice in the standings`, {
        entrantId: s.entrantId,
      });
    }
    seen.add(s.entrantId);
  }
  const refuse = (reason: SwissRefusalReason): SwissRefusal => ({
    ok: false,
    code: SWISS_NO_LEGAL_PAIRING,
    reason,
    field: standings.length,
  });
  // A round needs a board: 0 entrants pair nothing and 1 would sit out alone.
  if (standings.length < 2) return refuse("field_too_small");

  const chess = constraints.chess === true;
  const stateOf = (id: EntrantId): ColourState => colourState(history.colours?.get(id));

  const ordered = pairingOrder(standings);

  // Bye first (odd field): the lowest-ranked entrant not yet byed (bottom up),
  // else the absolute lowest if everyone has had one.
  let bye: EntrantId | undefined;
  let pool = ordered;
  if (ordered.length % 2 === 1) {
    const byed = history.byes ?? new Set<EntrantId>();
    let pick = ordered[ordered.length - 1] as SwissStanding;
    for (let i = ordered.length - 1; i >= 0; i--) {
      const cand = ordered[i] as SwissStanding;
      if (!byed.has(cand.entrantId)) {
        pick = cand;
        break;
      }
    }
    bye = pick.entrantId;
    pool = ordered.filter((s) => s.entrantId !== bye);
  }

  const played = history.played;
  // The reason probe (below) re-runs the search with the colour limits lifted, to tell "colour" from "rematch".
  let liftColourLimits = false;
  const colourLegal = (a: SwissStanding, b: SwissStanding): boolean => {
    if (!chess || liftColourLimits) return true;
    const sa = stateOf(a.entrantId);
    const sb = stateOf(b.entrantId);
    return (canTake(sa, "W") && canTake(sb, "B")) || (canTake(sa, "B") && canTake(sb, "W"));
  };
  const hardLegal = (a: SwissStanding, b: SwissStanding): boolean =>
    !played.has(pairKey(a.entrantId, b.entrantId)) && colourLegal(a, b);

  // Fold-preference candidate order for the strongest unpaired player `a`: its
  // own score group first (fold partner = top of that group's bottom half),
  // then nearest groups (minimal float), then rank order.
  const orderCandidates = (a: SwissStanding, others: SwissStanding[]): SwissStanding[] => {
    const sameScore = others.filter((o) => o.score === a.score);
    const adjacent = constraints.pairing === "rank_adjacent";
    const foldIdx = adjacent ? 0 : Math.floor(sameScore.length / 2);
    const globalIdx = new Map(others.map((o, i) => [o.entrantId, i]));
    return [...others].sort((x, y) => {
      const sx = x.score === a.score;
      const sy = y.score === a.score;
      if (sx !== sy) return sx ? -1 : 1;
      if (sx && sy) {
        const dx = Math.abs(sameScore.indexOf(x) - foldIdx);
        const dy = Math.abs(sameScore.indexOf(y) - foldIdx);
        if (dx !== dy) return dx - dy;
      } else {
        const gx = Math.abs(a.score - x.score);
        const gy = Math.abs(a.score - y.score);
        if (gx !== gy) return gx - gy;
      }
      return (globalIdx.get(x.entrantId) as number) - (globalIdx.get(y.entrantId) as number);
    });
  };

  // Complete backtracking matching of one (small) list, fold-preferred. Every
  // candidate is tried before giving up, so within a group it finds a matching
  // iff one exists — this is what gives the totality property (a single score
  // group ⇒ this searches the whole field). Backtracking is confined to the
  // group, keeping it polynomial across many groups (spec 05 §2.2: "backtracking
  // over transpositions within score groups is sufficient"). `memoFail` prunes
  // dead subsets within the call.
  // Shared search budget across the whole call (`budget`, default
  // SWISS_SEARCH_BUDGET): hard colour limits can make a pathological field's
  // infeasibility proof exponential, so we cap total work. The cap is far above
  // any feasible small case (a single group of ≤14 explores < 2^14 nodes), so it
  // never truncates a case the totality property covers. Once it runs out every
  // further node fails, so the round cannot be paired AND nothing was proved:
  // `exhausted` makes that a `search_limit` refusal, never a claimed rematch.
  let nodes = 0;
  let exhausted = false;
  const matchWithin = (list: SwissStanding[]): [SwissStanding, SwissStanding][] | null => {
    const memoFail = new Set<string>();
    const rec = (remaining: SwissStanding[]): [SwissStanding, SwissStanding][] | null => {
      if (remaining.length === 0) return [];
      if (++nodes > budget) {
        exhausted = true;
        return null;
      }
      const key = remaining.map((s) => s.entrantId).join(",");
      if (memoFail.has(key)) return null;
      const a = remaining[0] as SwissStanding;
      const others = remaining.slice(1);
      for (const b of orderCandidates(a, others)) {
        if (!hardLegal(a, b)) continue;
        const rest = others.filter((o) => o.entrantId !== b.entrantId);
        const sub = rec(rest);
        if (sub !== null) return [[a, b], ...sub];
      }
      memoFail.add(key);
      return null;
    };
    return rec(list);
  };

  // Score-group pairing top-down. Each group is paired internally (with the
  // carried downfloaters from stronger groups sitting on top); whoever can't be
  // paired here floats to the next group. Fewest floaters first, and among equal
  // counts the lowest-ranked / least-recently-floated go down (spec 05 §2.2
  // float tracking). Bounded: at most a few extra floaters per group.
  const groups = groupByScore(pool);
  const floatCountOf = (id: EntrantId): number => history.floats?.get(id) ?? 0;

  const pairFrom = (gi: number, carry: SwissStanding[]): [SwissStanding, SwissStanding][] | null => {
    if (gi >= groups.length) return carry.length === 0 ? [] : null;
    const current = [...carry, ...(groups[gi] as SwissStanding[])];
    const isLast = gi === groups.length - 1;
    const parity = current.length % 2;
    const maxFloat = isLast ? 0 : parity + 4; // cap extra floats — keeps it polynomial

    for (let fc = parity; fc <= maxFloat; fc += 2) {
      if (isLast && fc !== 0) break;
      for (const floaters of floaterChoices(current, fc, floatCountOf)) {
        const set = new Set(floaters.map((f) => f.entrantId));
        const rest = current.filter((c) => !set.has(c.entrantId));
        const here = matchWithin(rest);
        if (here === null) continue;
        const sub = pairFrom(gi + 1, floaters);
        if (sub !== null) return [...here, ...sub];
      }
    }
    return null;
  };

  const matched = pairFrom(0, []);
  if (matched === null) {
    // No rematch-free (colour-legal) perfect matching was found: refuse, and write nothing, not even the bye (§3.3).
    // The reason, per the bye candidate the search ran with (controller ruling R2: with several candidates, "colour" if
    // ANY candidate's remainder matches with the colour limits lifted, else "rematch"): run out of budget anywhere ⇒
    // "search_limit"; chess, and the remainder pairs once the colour limits are lifted ⇒ "colour"; else "rematch".
    if (exhausted) return refuse("search_limit");
    if (!chess) return refuse("rematch");
    liftColourLimits = true;
    const rematchFree = pairFrom(0, []);
    if (exhausted) return refuse("search_limit");
    return refuse(rematchFree === null ? "rematch" : "colour");
  }

  // Assign colours (chess) / home-away, and record downfloats.
  const pairings: SwissPairing[] = [];
  const floated: EntrantId[] = [];
  for (const [a, b] of matched) {
    if (a.score !== b.score) floated.push(a.entrantId); // a is the stronger side ⇒ it floated down
    pairings.push(assignColours(a, b, chess, stateOf));
  }

  return { ok: true, pairings, floated, ...(bye === undefined ? {} : { bye }) };
}

// Decide who is home (White in chess). Non-chess: the stronger side (a, already
// the upper board) is home. Chess: satisfy the hard rules first, then colour
// preferences; neutral ⇒ the upper board takes White (round-1 S1 = White).
function assignColours(
  a: SwissStanding,
  b: SwissStanding,
  chess: boolean,
  stateOf: (id: EntrantId) => ColourState,
): SwissPairing {
  if (!chess) return { home: a.entrantId, away: b.entrantId };

  const sa = stateOf(a.entrantId);
  const sb = stateOf(b.entrantId);
  const aW = canTake(sa, "W") && canTake(sb, "B");
  const aB = canTake(sa, "B") && canTake(sb, "W");

  let aColour: Colour;
  if (aW && !aB) aColour = "W";
  else if (aB && !aW) aColour = "B";
  else {
    const pa = preferredColour(sa);
    const pb = preferredColour(sb);
    if (pa !== null && pb !== null && pa !== pb) aColour = pa; // both satisfied
    else if (pa !== null && pb !== null) {
      // Both want the same colour — the stronger claim (larger imbalance, then
      // the upper board) gets it.
      aColour = Math.abs(sa.diff) >= Math.abs(sb.diff) ? pa : opposite(pa);
    } else if (pa !== null) aColour = pa;
    else if (pb !== null) aColour = opposite(pb);
    else aColour = "W"; // both neutral ⇒ upper board White
  }

  return aColour === "W"
    ? { home: a.entrantId, away: b.entrantId }
    : { home: b.entrantId, away: a.entrantId };
}
