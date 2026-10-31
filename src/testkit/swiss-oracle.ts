// W3 X-SW-1: the brute-force Swiss oracle (rulebook-W3-swiss §2.3 items 1–4; RB3-24, the n ≤ 12 half).
//
// For one round it answers what the rules say, and nothing about how a pairer should search:
//   - can the round be paired legally at all (P-A6), and for an odd field, which bye candidates leave a pairable remainder;
//   - when none can, the reason (rulebook §3.3; controller ruling R2);
//   - whether a seated round keeps P-A1, P-A3, P-A4 and, with chess colours on, P-A5;
//   - whether a bye is minimal: no eligible entrant with a strictly lower score leaves a pairable remainder (§2.3 item 4).
//
// It is written from the rulebook and FIDE C.04.1 r.2–7 / C.04.3 [C1]–[C3] alone, and it imports nothing — above all not the
// pairing engine (review M5): an oracle that reuses the code it checks agrees with that code's bugs. Its matching is a plain
// recursive search: take the first unmatched entrant and try each partner it may meet. That is exponential, so it takes fields of
// at most ORACLE_MAX_FIELD; the n ≤ 128 blossom check belongs to the reference checker (packages/reference), not here.
//
// Not in the testkit barrel: it is a test oracle for this package's own suites.

export type OracleColour = "W" | "B";

/** The largest field the brute force judges (RB3-24): its matching search is exponential in the field. */
export const ORACLE_MAX_FIELD = 12;

/** The oracle's own key for an unordered pair: the two ids in code-unit order, joined by "|". */
export function oraclePairKey(a: string, b: string): string {
  return [a, b].sort().join("|");
}

// Ids are keyed with "|" between them, so an id that holds one would make two different pairs share a key; one listed twice
// would be matched with itself. Both are caller defects, never a round to judge.
function checkIds(ids: readonly string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (id.includes("|")) throw new Error(`swiss-oracle: entrant "${id}" contains "|", which the pair keys use`);
    if (seen.has(id)) throw new Error(`swiss-oracle: entrant "${id}" appears twice`);
    seen.add(id);
  }
}

// P-A5's two limits on one colour sequence (C.04.1 r.6–7): whites minus blacks within [−2, +2], and the last three not all
// one colour. Its own count, from the raw sequence.
function withinLimits(seq: readonly OracleColour[]): boolean {
  let white = 0;
  let black = 0;
  for (const c of seq) {
    if (c === "W") white++;
    else if (c === "B") black++;
    else throw new Error(`swiss-oracle: colour ${JSON.stringify(c)} is neither "W" nor "B"`);
  }
  if (white - black > 2 || black - white > 2) return false;
  const k = seq.length;
  return !(k >= 3 && seq[k - 1] === seq[k - 2] && seq[k - 2] === seq[k - 3]);
}

/** P-A5 for one entrant: it may take colour `c` this round iff its sequence with `c` added is still within both limits. */
export function mayTake(seq: readonly OracleColour[], c: OracleColour): boolean {
  return withinLimits([...seq, c]);
}

/** P-A5 read pairwise (rulebook §2.3 item 2): one of the two colour assignments suits both entrants. Two entrants with the same
 *  absolute preference fail it (C.04.3 [C3]). */
export function colourCompatible(a: readonly OracleColour[], b: readonly OracleColour[]): boolean {
  return (mayTake(a, "W") && mayTake(b, "B")) || (mayTake(a, "B") && mayTake(b, "W"));
}

/** Is `seq` a history a legal event produces: P-A5 held after every round of it? The oracle reads P-A5 as "within the limits
 *  after the round". On a history already outside them, a "do not make it worse" reading and this one part ways, so judging such
 *  a round would report a defect no legal event can reach (T2 report, concern 3). The judge below refuses one by name. */
export function colourHistoryLegal(seq: readonly OracleColour[]): boolean {
  for (let k = 1; k <= seq.length; k++) if (!withinLimits(seq.slice(0, k))) return false;
  return true;
}

/** Does `pool` split into pairs none of which is in `forbidden` (keys built with oraclePairKey)? A plain recursive search: the
 *  first unmatched entrant is tried with each partner in turn. An odd pool has no perfect matching; an empty one has the empty
 *  matching. */
export function perfectMatchingExists(pool: readonly string[], forbidden: ReadonlySet<string>): boolean {
  if (pool.length > ORACLE_MAX_FIELD) {
    throw new Error(`swiss-oracle: the brute force matches a pool of n ≤ 12 (RB3-24), got ${pool.length}`);
  }
  checkIds(pool);
  // A key in another shape (another order or separator) would forbid nothing here and silently report a matching.
  for (const key of forbidden) {
    const ids = key.split("|");
    if (ids.length !== 2 || oraclePairKey(ids[0] as string, ids[1] as string) !== key) {
      throw new Error(`swiss-oracle: ${JSON.stringify(key)} is not a pair key the oracle built (oraclePairKey)`);
    }
  }
  const search = (rest: readonly string[]): boolean => {
    if (rest.length === 0) return true;
    const first = rest[0] as string;
    for (let i = 1; i < rest.length; i++) {
      if (forbidden.has(oraclePairKey(first, rest[i] as string))) continue;
      if (search(rest.filter((_, j) => j !== 0 && j !== i))) return true;
    }
    return false;
  };
  return search(pool);
}

export interface OracleEntrant {
  id: string;
  score: number;
}

/** One round to judge, as plain facts. */
export interface OracleRound {
  /** The active field: everyone the round must seat, with its score (only the bye's minimality reads scores). */
  field: readonly OracleEntrant[];
  /** Every pair that has met (P-A1), as two ids in either order. Unplayed pairs (a walkover) are not listed (P-A2). */
  played: readonly (readonly [string, string])[];
  /** Entrants that may not take the bye: had one, or won a walkover (P-A4). */
  byeIneligible?: ReadonlySet<string>;
  /** Chess colours on: each entrant's colours over its PLAYED games (P-A5); an entrant with none may be left out. Absent = off. */
  colours?: ReadonlyMap<string, readonly OracleColour[]>;
}

export type OracleReason = "no_bye_candidate" | "rematch" | "colour";

export interface OracleVerdict {
  /** P-A6: a round keeping P-A1, P-A3, P-A4 (and P-A5 with colours on) exists. */
  exists: boolean;
  /** Odd field: the bye-eligible entrants, in field order. Even field: none (no bye). */
  eligible: string[];
  /** Odd field: the eligible entrants whose removal leaves a legal perfect matching, in field order. Even field: none. */
  pairableByes: string[];
  /** When no round exists, why (rulebook §3.3, ruling R2): an odd field with nobody eligible ⇒ no_bye_candidate; colours on and
   *  some candidate's remainder pairing once the colour limits are lifted ⇒ colour; else rematch. */
  reason?: OracleReason;
  /** Anti-vacuity (§2.3 item 6): how many perfect-matching questions the verdict rests on. */
  matchingsChecked: number;
}

const colourOf = (round: OracleRound, id: string): readonly OracleColour[] => round.colours?.get(id) ?? [];

/** The verdict on one round (rulebook §2.3 items 3–4). */
export function judgeRound(round: OracleRound): OracleVerdict {
  const ids = round.field.map((e) => e.id);
  if (ids.length < 2 || ids.length > ORACLE_MAX_FIELD) {
    throw new Error(`swiss-oracle: the brute force judges a field of 2 ≤ n ≤ 12 (RB3-24), got ${ids.length}`);
  }
  checkIds(ids);
  const chess = round.colours !== undefined;
  if (chess) {
    for (const id of ids) {
      const seq = colourOf(round, id);
      if (!colourHistoryLegal(seq)) {
        throw new Error(`swiss-oracle: ${id}'s colour history ${seq.join("")} is not one a legal event produces (P-A5 broken after some round)`);
      }
    }
  }
  // The pairs the round may not seat: a rematch (P-A1), and with colours on, a pair no assignment suits (P-A5).
  const met = new Set(round.played.map(([a, b]) => oraclePairKey(a, b)));
  const barred = new Set(met);
  if (chess) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i] as string;
        const b = ids[j] as string;
        if (!colourCompatible(colourOf(round, a), colourOf(round, b))) barred.add(oraclePairKey(a, b));
      }
    }
  }
  let matchingsChecked = 0;
  const pairs = (pool: readonly string[], forbidden: ReadonlySet<string>): boolean => {
    matchingsChecked++;
    return perfectMatchingExists(pool, forbidden);
  };
  const without = (id: string | undefined): string[] => ids.filter((x) => x !== id);

  // An even field seats everyone on boards (no bye); an odd one gives the bye to one eligible entrant and pairs the rest.
  const odd = ids.length % 2 === 1;
  const ineligible = round.byeIneligible ?? new Set<string>();
  const eligible = odd ? ids.filter((id) => !ineligible.has(id)) : [];
  if (odd && eligible.length === 0) return { exists: false, eligible, pairableByes: [], reason: "no_bye_candidate", matchingsChecked };
  const candidates: (string | undefined)[] = odd ? eligible : [undefined];
  const pairable = candidates.filter((c) => pairs(without(c), barred));
  const pairableByes = pairable.filter((c): c is string => c !== undefined);
  if (pairable.length > 0) return { exists: true, eligible, pairableByes, matchingsChecked };
  const reason: OracleReason = chess && candidates.some((c) => pairs(without(c), met)) ? "colour" : "rematch";
  return { exists: false, eligible, pairableByes, reason, matchingsChecked };
}

/** What a seated round breaks, rule by rule (rulebook §2.3 items 1–2): every field entrant seated exactly once (P-A3), a bye
 *  exactly when the field is odd (P-A3), no rematch (P-A1), no ineligible bye (P-A4), and with colours on, each board's White
 *  and Black within their limits as seated (P-A5). Empty means legal. */
export function seatedRoundViolations(
  round: OracleRound,
  seated: { pairings: readonly { home: string; away: string }[]; bye?: string },
): string[] {
  const out: string[] = [];
  const ids = round.field.map((e) => e.id);
  checkIds(ids);
  const count = new Map<string, number>();
  const sat = [...seated.pairings.flatMap((p) => [p.home, p.away]), ...(seated.bye === undefined ? [] : [seated.bye])];
  for (const id of sat) {
    if (!ids.includes(id)) out.push(`P-A3 ${id} is not in the field`);
    count.set(id, (count.get(id) ?? 0) + 1);
  }
  for (const id of ids) {
    const c = count.get(id) ?? 0;
    if (c !== 1) out.push(`P-A3 ${id} is seated ${c} times`);
  }
  if ((seated.bye !== undefined) !== (ids.length % 2 === 1)) out.push("P-A3 a bye is owed exactly when the field is odd");
  const met = new Set(round.played.map(([a, b]) => oraclePairKey(a, b)));
  for (const p of seated.pairings) if (met.has(oraclePairKey(p.home, p.away))) out.push(`P-A1 ${p.home} v ${p.away} have met`);
  if (seated.bye !== undefined && round.byeIneligible?.has(seated.bye) === true) out.push(`P-A4 ${seated.bye} may not take the bye`);
  if (round.colours !== undefined) {
    for (const p of seated.pairings) {
      if (!mayTake(colourOf(round, p.home), "W")) out.push(`P-A5 ${p.home} may not take W`);
      if (!mayTake(colourOf(round, p.away), "B")) out.push(`P-A5 ${p.away} may not take B`);
    }
  }
  return out;
}

/** Bye minimality (rulebook §2.3 item 4; P-Q2's hard core, A3 [C5]): the eligible entrants with a strictly lower score than
 *  `bye` whose removal leaves a pairable remainder. Empty means the bye is minimal. `verdict` is judgeRound(round). */
export function lowerScoredPairableByes(round: OracleRound, verdict: OracleVerdict, bye: string): string[] {
  const score = new Map(round.field.map((e) => [e.id, e.score]));
  const own = score.get(bye);
  if (own === undefined) throw new Error(`swiss-oracle: the bye "${bye}" is not in the field`);
  return verdict.pairableByes.filter((id) => (score.get(id) as number) < own);
}
