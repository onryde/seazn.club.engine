// Stage state machines — spec 05 §1 (six kinds), §3 (rank locks), §5 (division
// events, withdrawal policies). A stage moves draft → open → complete; this
// module owns the completion predicate per kind, the ranking of a completed
// stage into `finalRanks`, and the division-event ledger those transitions
// emit. Fixture GENERATION is PROMPT-09 — a stage here consumes an
// already-generated fixture set (its status + results) and never builds one.
import { EngineError } from "../core/errors.ts";
import type { EntrantId, StageKind } from "../core/types.ts";
import { foldResults, foldStandings, type FixtureResult } from "./standings.ts";
import { applyRankLocks, swissDrawPoints, type RankLock, type SwissDrawFacts } from "./points.ts";
import type { StandingsDelta } from "../core/types.ts";
import type { CrossGroupRules, PoolTable, SourceTables as StageTables } from "./progression.ts";
import type { TableRules } from "./table-rules.ts";
import { buildSwissLedger, membersKeyOf, rankStandings, type MembersKey, type NewLotsDraw, type RankContext, type StoredLotsDraw, type SwissLedgerFixture, type SwissTable } from "./tiebreakers.ts";

// spec 02 §6 fixture statuses that matter to a stage's completion/ranking.
export type FixtureStatus = "scheduled" | "in_play" | "decided" | "void" | "walkover";

const SETTLED: ReadonlySet<FixtureStatus> = new Set(["decided", "void", "walkover"]);
/** A fixture in one of these statuses is finished for its stage: it can no
 *  longer move a table. Exported (standings qualification, plan M12) so the web
 *  builder counts a table's remaining matches with the engine's own set rather
 *  than a copy that could drift from `isTableStageComplete`. */
export { SETTLED as SETTLED_FIXTURE_STATUSES };
const COUNTS_FOR_STANDINGS: ReadonlySet<FixtureStatus> = new Set(["decided", "walkover"]);

// A league/group/swiss fixture as the stage sees it: a status and, once
// decided, the sport module's [home, away] delta pair. Void fixtures never
// reach the standings fold (the adapter may still attach a result, which
// counts only for pool membership).
//
// `awardDelta` is the one-sided sit-out path (Swiss odd-field bye, KO seeded
// bye): forfeited + `outcome.kind === "award"` with the other seat null, so
// there is no [home, away] pair and no match_state for `standingsDelta`. The
// adapter synthesises a single win delta; the fold treats it like any other
// played win. Buchholz/SB see it as an unplayed round (a 16.2.1 bye, opponent null).
// On a Swiss ledger stage every counted fixture names its `roundNo`, and one with a `result` its `unplayed` (CONFIG_INVALID).
export interface TableFixture {
  id: string;
  poolId?: string;
  roundNo?: number;
  status: FixtureStatus;
  result?: FixtureResult;
  awardDelta?: StandingsDelta;
  /** W3 (X-SW-7; FIDE C.07 (2026) 16.2.2 / 16.2.4): the side(s) of `result` that lost WITHOUT playing — "home"/"away" a
   *  forfeit with nothing played, "both" a double walkover, `null` a game played (a retirement after play included) — as
   *  `unplayedSidesOf` (points.ts) answers, the one authority the caller fills it from. Read only on a Swiss stage, which
   *  refuses a counted result that leaves it out (final review m3): by the ledger, where a forfeit is an unplayed round on
   *  both cards and no meeting (P-A2), and by the head-to-head steps, whose mini-table leaves it out (X-SW-9). */
  unplayed?: "home" | "away" | "both" | null;
}

// A bracket fixture (knockout / double_elim / stepladder). `round` is 0-based
// and monotonic (higher = later); the deciding game carries `isFinal`.
export interface BracketFixture {
  id: string;
  bracket?: "WB" | "LB" | "GF"; // double-elim lanes; omit for single bracket
  /** 0-based; 0 is the opening round, as the generators emit. */
  round: number;
  isFinal?: boolean; // SE final / DE grand final (or bracket-reset game)
  thirdPlace?: boolean;
  status: FixtureStatus;
  home?: EntrantId;
  away?: EntrantId;
  winner?: EntrantId; // set once decided/walkover
  loser?: EntrantId;
  /** W2b (spec §5.3, W2b-R11), set by the web's `bracketWinnerLoser`: "loser" — the loser forfeited (an `award`), so it
   *  is out of the tournament here and never drops to a losers'-bracket or third-place seat (X-DE-1); "both" — a double
   *  walkover, no winner and no loser, both sides out here (X-DW-2). Ranks pin these entrants' elimination round to
   *  this fixture, so they read the same answer seating does. */
  walkedOver?: "loser" | "both";
  /** W4 (Q4; RB4-C3; X-CH-1): the final ended in joint winners — decided, with no `winner`, no `loser` and no
   *  `walkedOver`: both its seated sides rank 1st. Only ever on the final (`isFinal`); anything else is a wiring bug. */
  jointWinners?: boolean;
}

// Everything the ranking pass needs about a table stage that isn't in the
// fixtures themselves (spec 05 §4 cascade is data). A stage that assembles the
// Swiss ledger names its draw facts beside it (`SwissLedgerStage`).
export type TableStage = TableStageFields & (SwissLedgerStage | { swiss?: false; swissDraw?: SwissDrawFacts; swissAbsentRounds?: ReadonlyMap<EntrantId, readonly number[]> });

/** A stage that assembles the Swiss ledger for buchholz/sberger/direct (`swiss: true`). */
interface SwissLedgerStage {
  swiss: true;
  /** W3 (ruling R4; X-SW-7; T7 re-review N1): the sport's Swiss draw facts under the stage's cfg (`swissDrawFactsOf`),
   *  which turn `rules.points` into D, the draw points of art. 16's dummy cap and of a 16.2.5 round. Required by the type,
   *  and refused at run time (CONFIG_INVALID) whenever it is absent — whether or not a round is yet unplayed — so a caller
   *  that leaves it out fails on its first ranking, not on its first odd round. */
  swissDraw: SwissDrawFacts;
  /** W3 (X-SW-7, X-SW-8; FIDE C.04.2 2.4, C.07 16.1; ruling 251): per entrant, the rounds (1-based) it was in the stage but
   *  not paired — before its late entry, or after its withdrawal; an empty map when nobody was. Each is a zero-point unplayed
   *  round (16.2.3 when play follows it, else 16.2.5, read as a draw, 16.3.2). Keys are the table's entrants; a round is in
   *  1..`rounds` and holds no card of the entrant's. Required, and refused when absent (final review m3): never "nobody". */
  swissAbsentRounds: ReadonlyMap<EntrantId, readonly number[]>;
}

interface TableStageFields {
  id: string;
  kind: Extract<StageKind, "league" | "group" | "swiss">;
  entrants: readonly EntrantId[];
  /** W2d (spec §5.4, §6 E1): the stage's effective table rules (`resolveTableRules`). The table ranks by
   *  `rules.tiebreakers`; `points` and `crossGroup` ride along for the caller that pays and the progression that compares
   *  groups — `completeTableStage` folds the deltas it is handed and never re-pays them. */
  rules: TableRules;
  /** W2d (B2, HK-TB-1): which wins the `wins` step counts — the module's `winsCount`. Absent = every win. */
  winsCount?: RankContext["winsCount"];
  /** W2d (B5): a result's GAME points, for `sberger` and `direct` on a non-Swiss stage. Absent = the table points. */
  gamePoints?: RankContext["gamePoints"];
  seeds?: ReadonlyMap<EntrantId, number>;
  rngSeed?: number;
  rounds?: number; // swiss: N rounds to play; REQUIRED on a Swiss ledger stage with a bye or an absence (CONFIG_INVALID)
  /** Carry-over openings (Jul3/05 §3): synthetic deltas folded before the
   *  stage's own fixtures — prior H2H is never replayed. */
  openingDeltas?: readonly StandingsDelta[];
  /** Manual rank locks (Jul3/05 §4): pinned ranks; the cascade orders only
   *  the unlocked remainder around them. */
  rankLocks?: readonly RankLock[];
  /** Circular-H2H mode for ≥3-way ties (Jul3/05 §5). */
  h2hScope?: "mini_table" | "overall";
  /** W2d (spec §5.8): the stage's stored lots draws, by pool (a fixture's
   *  `poolId`, "" for none — the key completeTableStage names its pools by),
   *  then by the tied set's members key. A draw belongs to its pool. */
  lotsDraws?: ReadonlyMap<string, ReadonlyMap<MembersKey, StoredLotsDraw>>;
  /** W2d (spec §5.6 "ST-G12", X-TB-8): every fixture the stage schedules, decided or not, as [home, away] — one entry per
   *  fixture (`RankContext.scheduledPairs`). A head-to-head step needs the tied class's mini-schedule complete. Absent or
   *  empty = every mini-schedule complete, as before W2d. Not read on a Swiss stage (no round-robin schedule; B1). */
  scheduledPairs?: RankContext["scheduledPairs"];
  /** W2d (IH-TB-2): the sport's partial-schedule order (`SportModule.partialScheduleOrder`). Absent = the block does not
   *  split a class whose mini-schedule is incomplete. */
  partialScheduleOrder?: RankContext["partialScheduleOrder"];
}

/** W2d (spec §5.9, ST-G4, X-TB-7): how this stage compares entrants from DIFFERENT groups (best-Nth) — its effective
 *  `crossGroup` order (pinned with the stage), with the seeds, `winsCount` and rngSeed its keys read, and the cross-group
 *  draws stored for it. Those live in the stage-wide pool "" (`stage_lots_draws.pool_id` null): a cross-group tie holds
 *  one entrant per group, so its members key never meets a group's own tie, and a pooled stage has no "" table of its
 *  own (T5 review G3). The one reading of a stage for `SourceTables.crossGroup`. */
export function crossGroupRulesOf(stage: TableStage): CrossGroupRules {
  const lotsDraws = stage.lotsDraws?.get("");
  return {
    order: stage.rules.crossGroup,
    ...(lotsDraws === undefined ? {} : { lotsDraws }),
    ...(stage.seeds === undefined ? {} : { seeds: stage.seeds }),
    ...(stage.rngSeed === undefined ? {} : { rngSeed: stage.rngSeed }),
    ...(stage.winsCount === undefined ? {} : { winsCount: stage.winsCount }),
  };
}

export interface BracketStage {
  id: string;
  kind: Extract<StageKind, "knockout" | "double_elim" | "stepladder" | "page_playoff">;
  /** W4 (X-FR-1, RB4-R1): every entrant of the stage, declared — a withdrawn or disqualified entrant included, and one in
   *  no fixture at all (a departed qualifier whose line was voided). The ranks cover exactly these, each once; a fixture
   *  naming anyone else, or a repeat in this list, is a wiring bug (CONFIG_INVALID). In the order the bracket was DRAWN
   *  with: X-SP-4 reads a stepladder rung from it, where two seeds tie (`seedOrder`). */
  entrants: readonly EntrantId[];
  /** The seeds the bracket was DRAWN with — a fed stage's qualification order, never a registration seed the draw did
   *  not use. X-SP-4 reads the stepladder rung from them, by seed order. Absent (or an entrant's missing) = no rung to
   *  read: a stepladder entrant in no fixture then ranks last. */
  seeds?: ReadonlyMap<EntrantId, number>;
}

/** W4 (X-FR-1, RB4-R1): an entrant's place in a stage's ranking. A table stage ranks by position (rank = index + 1); a
 *  bracket stage's ranks may tie, but only at the declared shared places (`BRACKET_SHARED_RANKS`). */
export interface FinalPlace {
  entrantId: EntrantId;
  rank: number;
}

/** W4 (X-FR-1; rulings 266, 267; plan Global Constraints, Rank places): the only ranks two entrants of a bracket may share —
 *  1st (joint winners), 2nd (a vacant title's two finalists), 3rd (the semi-final losers where no play-off decided it) and
 *  4th (both sides of a play-off neither played). Never more than two at one rank; which of these a stage may use is what
 *  its own fixtures declare (`assertCompletedBracketPlaces`). */
export const BRACKET_SHARED_RANKS: ReadonlySet<number> = new Set([1, 2, 3, 4]);

// spec 05 §5 — the structural ledger. (fixtures_generated / fixture_replaced
// belong to generation, PROMPT-09.)
export type DivisionEvent =
  | { type: "stage_opened"; stageId: string }
  | { type: "stage_completed"; stageId: string; finalRanks: FinalPlace[] }
  | { type: "rank_lock_required"; stageId: string; group: EntrantId[] }
  // W2d (spec §5.8, PS-5b): `order` and `drawnAt` are the STORED draw's. A draw
  // made in this call has no date yet, so it emits rank_lock_required alone and
  // goes back in `newLotsDraws`; the lock follows once the draw is stored.
  | { type: "rank_lock"; stageId: string; method: "lots"; group: EntrantId[]; order: EntrantId[]; drawnAt: string }
  | {
      type: "entrant_withdrawn";
      stageId: string;
      entrantId: EntrantId;
      policy: "void_remaining" | "bracket_walkover";
      mode?: "expunge" | "award";
    };

// spec 05 §5 — a stage's instruction to re-status fixtures after a withdrawal
// (the sport-agnostic stage can't mint an award delta; the adapter turns
// `walkoverTo` into an `award` outcome via the sport module).
export interface FixtureUpdate {
  fixtureId: string;
  status: Extract<FixtureStatus, "void" | "walkover">;
  walkoverTo?: EntrantId;
}

// ---------------------------------------------------------------------------
// Completion predicates — spec 05 §1
// ---------------------------------------------------------------------------

function poolOf(fixture: TableFixture): string {
  return fixture.poolId ?? "";
}

// league / group: every fixture decided or void (group pools all complete is
// the same condition — pools only partition the fixtures). swiss: the first
// `rounds` rounds all settled.
export function isTableStageComplete(stage: Pick<TableStage, "kind" | "rounds">, fixtures: readonly TableFixture[]): boolean {
  if (fixtures.length === 0) return false;
  if (stage.kind === "swiss") {
    const rounds = stage.rounds ?? 0;
    if (rounds <= 0) return false;
    for (let round = 1; round <= rounds; round++) {
      const inRound = fixtures.filter((fixture) => fixture.roundNo === round);
      if (inRound.length === 0 || !inRound.every((fixture) => SETTLED.has(fixture.status))) {
        return false;
      }
    }
    return true;
  }
  return fixtures.every((fixture) => SETTLED.has(fixture.status));
}

/** W4 (X-CH-7, ruling 274, RB4-C7): the ids of the fixtures still owed — every fixture not decided, void or walkover —
 *  in the caller's order. Empty for an empty list, so it never answers "no final" on its own. */
export function undecidedBracketFixtures(fixtures: readonly BracketFixture[]): string[] {
  return fixtures.filter((fixture) => !SETTLED.has(fixture.status)).map((fixture) => fixture.id);
}

/** Why a bracket stage cannot complete yet (X-CH-7), or null when it can. */
type BracketCompletionRefusal = { reason: "no_final" } | { reason: "fixtures_undecided"; undecided: string[] };

// Every bracket kind (knockout, double_elim, stepladder, page_playoff): the stage has a final, and EVERY fixture is
// settled — the final, every earlier round, a third-place play-off (X-TP-4, RB4-T3) and a double-elim bracket reset alike
// (X-CH-7, ruling 274, RB4-C7). The final alone is not enough: a semi-final still scheduled (CH-1) or a final still
// in_play (AN-2) leaves the stage open. A voided reset and a walked-over line are settled. No final is checked first:
// an empty list owes no fixture and would otherwise pass. The one reading of both the predicate and the refusal.
function bracketCompletionRefusal(fixtures: readonly BracketFixture[]): BracketCompletionRefusal | null {
  if (!fixtures.some((fixture) => fixture.isFinal === true)) return { reason: "no_final" };
  const undecided = undecidedBracketFixtures(fixtures);
  return undecided.length > 0 ? { reason: "fixtures_undecided", undecided } : null;
}

export function isBracketStageComplete(
  _stage: BracketStage,
  fixtures: readonly BracketFixture[],
): boolean {
  return bracketCompletionRefusal(fixtures) === null;
}

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

export function openStage(stageId: string): DivisionEvent[] {
  return [{ type: "stage_opened", stageId }];
}

// ---------------------------------------------------------------------------
// Completing a table stage → per-pool ranked tables + division events
// ---------------------------------------------------------------------------

function poolNames(fixtures: readonly TableFixture[]): string[] {
  const names = new Set<string>();
  for (const fixture of fixtures) names.add(poolOf(fixture));
  if (names.size === 0) names.add("");
  return [...names];
}

// Which entrants belong to a pool: those appearing in the pool's fixtures. For
// a single-pool (league) stage every entrant is in the one pool.
function entrantsOfPool(
  pool: string,
  fixtures: readonly TableFixture[],
  allEntrants: readonly EntrantId[],
  single: boolean,
): EntrantId[] {
  if (single) return [...allEntrants];
  const ids = new Set<EntrantId>();
  for (const fixture of fixtures) {
    if (poolOf(fixture) !== pool) continue;
    if (fixture.result !== undefined) {
      ids.add(fixture.result[0].entrantId);
      ids.add(fixture.result[1].entrantId);
    }
    if (fixture.awardDelta !== undefined) ids.add(fixture.awardDelta.entrantId);
  }
  // Membership = every entrant on a fixture of this pool carrying a result or
  // an awardDelta, whatever that fixture's status (a voided fixture that kept
  // its outcome still counts). A declared entrant with neither is not a member
  // here; filtering allEntrants only restores the declared order.
  return allEntrants.filter((id) => ids.has(id));
}

export interface CompletedTableStage {
  events: DivisionEvent[];
  tables: StageTables;
  /** W2d (spec §5.8): the lots drawn now, each tagged with its pool, for the caller to store. */
  newLotsDraws: ReadonlyArray<NewLotsDraw & { readonly pool: string }>;
}

// Fold + rank each pool of a completed table stage. Emits stage_completed
// {finalRanks}, plus rank_lock_required for any tie the cascade left to a
// drawing of lots (spec 05 §3/§4.4), and rank_lock for one whose draw is stored
// (W2d §5.8). A pool with no counted fixture is an empty table: no lots, every
// row level. finalRanks interleaves pools by rank (all pool winners, then all
// runners-up, …) — the cross-pool seeding order (spec 05 §2.3).
export function completeTableStage(
  stage: TableStage,
  fixtures: readonly TableFixture[],
): CompletedTableStage {
  const pools = poolNames(fixtures);
  const single = pools.length === 1;
  const events: DivisionEvent[] = [];
  const poolTables: PoolTable[] = [];
  const newLotsDraws: (NewLotsDraw & { readonly pool: string })[] = [];

  for (const pool of pools) {
    const poolFixtures = single ? fixtures : fixtures.filter((fixture) => poolOf(fixture) === pool);
    const entrants = entrantsOfPool(pool, fixtures, stage.entrants, single);
    const counted = poolFixtures.filter((fixture) => COUNTS_FOR_STANDINGS.has(fixture.status) && fixture.result !== undefined);
    const results = counted.map((fixture) => fixture.result as FixtureResult);
    // W3 (X-SW-9): the counted results nothing was played in — the same tuples — for a Swiss stage's head-to-head steps.
    const unplayedResults = new Set(counted.filter((fixture) => fixture.unplayed != null).map((fixture) => fixture.result as FixtureResult));
    const awardDeltas = poolFixtures
      .filter((fixture) => COUNTS_FOR_STANDINGS.has(fixture.status) && fixture.awardDelta !== undefined)
      .map((fixture) => fixture.awardDelta as StandingsDelta);

    const entrantSet = new Set(entrants);
    const openings = (stage.openingDeltas ?? []).filter((d) => entrantSet.has(d.entrantId));
    const rows =
      openings.length > 0 || awardDeltas.length > 0
        ? foldStandings(entrants, [...openings, ...results.flat(), ...awardDeltas])
        : foldResults(entrants, results);
    // W2d §5.8 step 1: the pool's table is empty when nothing in it counts — no
    // counted result, no sit-out award, and no carried opening that holds
    // something (an opening is the fold of counted fixtures in its source stage;
    // one with nothing played and no points carries no table — a points-mode
    // carry plays 0 by construction, so its points are what it carries).
    const carried = openings.filter((d) => d.played > 0 || d.points !== 0);
    const countedFixtures = results.length + awardDeltas.length + carried.length;
    const poolDraws = stage.lotsDraws?.get(pool);
    const ranked = rankStandings(rows, {
      cascade: stage.rules.tiebreakers,
      results,
      countedFixtures,
      ...(stage.winsCount === undefined ? {} : { winsCount: stage.winsCount }),
      ...(stage.gamePoints === undefined ? {} : { gamePoints: stage.gamePoints }),
      ...(poolDraws === undefined ? {} : { lotsDraws: poolDraws }),
      ...(stage.seeds === undefined ? {} : { seeds: stage.seeds }),
      ...(stage.rngSeed === undefined ? {} : { rngSeed: stage.rngSeed }),
      ...(stage.h2hScope === undefined ? {} : { h2hScope: stage.h2hScope }),
      ...(stage.swiss === true
        ? { swiss: swissLedgerOf(stage, entrants, poolFixtures), pointsUnit: stage.rules.points.unit, unplayedResults }
        : {}),
      // ST-G12 reads a round robin's schedule; a Swiss stage pairs round by round and has none (Swiss stays W3, D7 —
      // and production's one competition, a Swiss one, does not move, B1).
      ...(stage.scheduledPairs === undefined || stage.kind === "swiss" ? {} : { scheduledPairs: stage.scheduledPairs }),
      ...(stage.partialScheduleOrder === undefined ? {} : { partialScheduleOrder: stage.partialScheduleOrder }),
    });
    // Manual override wins — it is the final structural word (Jul3/05 §8).
    if (stage.rankLocks !== undefined && stage.rankLocks.length > 0) {
      const poolLocks = stage.rankLocks.filter((l) => entrantSet.has(l.entrantId));
      if (poolLocks.length > 0) ranked.rows = applyRankLocks(ranked.rows, poolLocks);
    }

    for (const group of ranked.lotsGroups) {
      events.push({ type: "rank_lock_required", stageId: stage.id, group });
      // The lock carries the stored draw's order and date (PS-5b): the engine
      // has no clock, so a draw made just now waits for its stored row.
      const drawn = poolDraws?.get(membersKeyOf(group));
      if (drawn !== undefined) {
        events.push({ type: "rank_lock", stageId: stage.id, method: "lots", group, order: [...drawn.order], drawnAt: drawn.drawnAt });
      }
    }
    for (const draw of ranked.newLotsDraws) newLotsDraws.push({ pool, ...draw });
    poolTables.push({ pool, rows: ranked.rows, results });
  }

  // W4 (X-FR-1): a table stage's places are its positions — rank = index + 1, a level row included.
  const finalRanks = crossPoolOrder(poolTables).map((entrantId, i) => ({ entrantId, rank: i + 1 }));
  events.push({ type: "stage_completed", stageId: stage.id, finalRanks });

  const overall = single ? (poolTables[0] as PoolTable).rows : undefined;
  return {
    events,
    tables: { pools: poolTables, ...(overall === undefined ? {} : { overall }) },
    newLotsDraws,
  };
}

// W3 (X-SW-7, X-SW-8; FIDE C.07 (2026) art. 16): the pool's Swiss ledger by round, from its counted fixtures (decided or
// walked over, with a result or a sit-out award, and the side(s) that lost without playing) and the stage's declared
// absences, scaled by the stage's points rule and the sport's draw facts (D = `swissDrawPoints`, ruling R4). Every counted
// fixture names its round: art. 16 reads a card's place among the rounds. The draw facts are refused when absent at once
// (N1), before any card is read: an even field with no unplayed round needs no D, but its stage still names them. So are
// the absences, and a counted result's unplayed side(s) (`null` for a game played): left out, either would read as the
// common case — nobody absent, the game played — and rank a plausible wrong table (final review m3).
function swissLedgerOf(stage: TableStage, entrants: readonly EntrantId[], fixtures: readonly TableFixture[]): SwissTable {
  if (stage.swissDraw === undefined) {
    throw new EngineError("CONFIG_INVALID", `Swiss stage "${stage.id}" names no swissDraw: the sport's Swiss draw facts (swissDrawFactsOf) give its draw points`, { stageId: stage.id });
  }
  if (stage.swissAbsentRounds === undefined) {
    throw new EngineError("CONFIG_INVALID", `Swiss stage "${stage.id}" names no swissAbsentRounds: each entrant's unpaired rounds (late entry, withdrawal), an empty map for none`, { stageId: stage.id });
  }
  const counted: SwissLedgerFixture[] = [];
  for (const fixture of fixtures) {
    if (!COUNTS_FOR_STANDINGS.has(fixture.status) || (fixture.result === undefined && fixture.awardDelta === undefined)) continue;
    if (fixture.roundNo === undefined) {
      throw new EngineError("CONFIG_INVALID", `counted Swiss fixture "${fixture.id}" names no roundNo`, { fixtureId: fixture.id });
    }
    if (fixture.result !== undefined && fixture.unplayed === undefined) {
      throw new EngineError("CONFIG_INVALID", `counted Swiss fixture "${fixture.id}" names no unplayed side(s): null for a game played, else unplayedSidesOf's answer`, { fixtureId: fixture.id });
    }
    counted.push({
      round: fixture.roundNo,
      ...(fixture.result === undefined ? {} : { result: fixture.result }),
      ...(fixture.awardDelta === undefined ? {} : { award: fixture.awardDelta }),
      ...(fixture.unplayed == null ? {} : { unplayed: fixture.unplayed }),
    });
  }
  return buildSwissLedger(entrants, counted, {
    rounds: stage.rounds,
    drawPoints: swissDrawPoints(stage.rules.points, stage.swissDraw),
    absent: stage.swissAbsentRounds,
  });
}

// Interleave pools by rank: rank-1 of every pool (in pool order), then rank-2,
// … — the group→knockout seeding template (spec 05 §2.3).
function crossPoolOrder(pools: readonly PoolTable[]): EntrantId[] {
  const maxRank = Math.max(0, ...pools.map((pool) => pool.rows.length));
  const order: EntrantId[] = [];
  for (let rank = 1; rank <= maxRank; rank++) {
    for (const pool of pools) {
      const row = pool.rows.find((entry) => entry.rank === rank);
      if (row !== undefined) order.push(row.entrantId);
    }
  }
  return order;
}

// ---------------------------------------------------------------------------
// Completing a bracket stage → final ranks from bracket position
// ---------------------------------------------------------------------------

export interface CompletedBracketStage {
  events: DivisionEvent[];
  finalRanks: FinalPlace[];
  /** W4 (X-CH-1): what the deciding final crowned. */
  title: BracketTitle;
}

/** W4 (Q4; RB4-C1, C3, C4; X-CH-1): what a bracket's deciding final crowned. */
export type BracketTitle =
  | { kind: "champion"; champion: EntrantId }
  | { kind: "joint"; winners: readonly [EntrantId, EntrantId] }
  | { kind: "vacant" };

/** The title the deciding final crowned (`decidingFinal`), or undefined while no final has decided anything — a void
 *  final included (a double-elimination reset that was not needed decides nothing; the grand final before it does) —
 *  and undefined while ANY final is still unsettled (B3 fix round 1, controller ruling): a double-elimination reset
 *  seated after the grand final may yet crown the other side, so the grand final's winner is not the champion yet.
 *  Every jointWinners row is checked first, whatever the answer. */
export function bracketTitle(fixtures: readonly BracketFixture[]): BracketTitle | undefined {
  const decided = decidingFinal(fixtures);
  if (fixtures.some((fixture) => fixture.isFinal === true && !SETTLED.has(fixture.status))) return undefined;
  return decided?.title;
}

// Completing a bracket stage is refused, never ranked provisionally, until `isBracketStageComplete` holds (X-CH-7, ruling
// 274, RB4-C7): STAGE_NOT_READY with `reason: "no_final"` when no fixture is the final, else `reason:
// "fixtures_undecided"` naming every fixture still owed. Its ranks then pass the strict check (X-FR-1, B3-1).
export function completeBracketStage(
  stage: BracketStage,
  fixtures: readonly BracketFixture[],
): CompletedBracketStage {
  const refusal = bracketCompletionRefusal(fixtures);
  if (refusal !== null) {
    const message =
      refusal.reason === "no_final"
        ? `bracket stage "${stage.id}" has no final to complete it`
        : `bracket stage "${stage.id}" has ${refusal.undecided.length} fixture(s) not yet decided or settled: ${refusal.undecided.join(", ")}`;
    throw new EngineError("STAGE_NOT_READY", message, { stageId: stage.id, ...refusal });
  }
  // Assumption → guard (X-CH-1): a completed bracket crowned a champion, joint winners, or left the title vacant. A final
  // settled without deciding anything (void, with no reset after it) crowned nobody: a wiring bug, never a ranking.
  const title = bracketTitle(fixtures);
  if (title === undefined) {
    throw new EngineError("CONFIG_INVALID", `bracket stage "${stage.id}" is settled but its final decided no title`, { reason: "no_title", stageId: stage.id });
  }
  const finalRanks = bracketRanks(stage, fixtures);
  assertCompletedBracketPlaces(stage, fixtures, finalRanks);
  return {
    events: [{ type: "stage_completed", stageId: stage.id, finalRanks }],
    finalRanks,
    title,
  };
}

/** A bracket ranking that breaks X-FR-1 is a wiring bug, not a refusal an organiser can act on (CONFIG_INVALID). */
function placesInvalid(message: string, data: Record<string, unknown>): EngineError {
  return new EngineError("CONFIG_INVALID", `bracket places: ${message}`, data);
}

/** W4 (X-FR-1, RB4-R1; controller ruling B3-1): the STRUCTURAL check every bracket ranking passes, provisional or final —
 *  each declared entrant exactly once (none missing, none repeated, nobody undeclared), every rank a positive integer, and
 *  ranks never decreasing down the list. It names no shared place: a mid-bracket read is provisional and never refused for
 *  its shape (Review Focus 5); `assertCompletedBracketPlaces` holds a completed stage to the declared shapes. */
export function assertBracketPlaces(entrants: readonly EntrantId[], places: readonly FinalPlace[]): void {
  const declared = new Set(entrants);
  const seen = new Set<EntrantId>();
  let previous = 0;
  places.forEach((place, index) => {
    const at = { entrantId: place.entrantId, rank: place.rank, index };
    if (!declared.has(place.entrantId)) {
      throw placesInvalid(`"${place.entrantId}" is ranked but is not an entrant of the stage`, { reason: "undeclared_entrant", ...at });
    }
    if (seen.has(place.entrantId)) {
      throw placesInvalid(`"${place.entrantId}" is ranked twice`, { reason: "duplicate_entrant", ...at });
    }
    seen.add(place.entrantId);
    if (!Number.isInteger(place.rank) || place.rank < 1) {
      throw placesInvalid(`"${place.entrantId}" has rank ${place.rank}, not a positive integer`, { reason: "rank_not_positive_integer", ...at });
    }
    if (place.rank < previous) {
      throw placesInvalid(`rank ${place.rank} follows rank ${previous}`, { reason: "rank_order", ...at });
    }
    previous = place.rank;
  });
  const missing = entrants.filter((id) => !seen.has(id));
  if (missing.length > 0) {
    throw placesInvalid(`${missing.length} entrant(s) of the stage are not ranked: ${missing.join(", ")}`, { reason: "missing_entrant", missing });
  }
}

/** The shapes a completed bracket's own fixtures declare (Rank places table). `pairs`: a rank two share in standard
 *  competition ranking (3, 3, then 5). `pairsBelowVacancy`: a rank two share with the rank above it left vacant (4, 4
 *  after 1, 2). `vacancies`: a rank nobody holds, the next single holder taking the rank after it. */
interface DeclaredPlaces {
  pairs: ReadonlySet<number>;
  pairsBelowVacancy: ReadonlySet<number>;
  vacancies: ReadonlySet<number>;
}

// SH-3 (ruling 270): only a knockout shares its 3rd — its semi-final losers, when it played no play-off or voided it
// (X-TP-3, plan's call); a play-off both sides walked over ranks both 4th, 3rd vacant (X-TP-7). The title (Q4, X-CH-1):
// joint winners share 1st; a vacant title's two finalists share 2nd, 1st vacant. B3-6 (controller call): a champion who
// won the final by walkover over a dead seat has no runner-up, so 2nd is vacant.
function declaredPlaces(stage: BracketStage, fixtures: readonly BracketFixture[]): DeclaredPlaces {
  const pairs = new Set<number>();
  const pairsBelowVacancy = new Set<number>();
  const vacancies = new Set<number>();
  if (stage.kind === "knockout") {
    const playOff = fixtures.find((fixture) => fixture.thirdPlace === true);
    if (playOff === undefined || playOff.status === "void") pairs.add(3);
    else if (playOff.walkedOver === "both") pairsBelowVacancy.add(4);
  }
  const decided = decidingFinal(fixtures);
  if (decided?.title.kind === "joint") pairs.add(1);
  if (decided?.title.kind === "vacant") pairsBelowVacancy.add(2);
  if (decided?.title.kind === "champion" && decided.fixture.loser === undefined) vacancies.add(2);
  return { pairs, pairsBelowVacancy, vacancies };
}

/** W4 (X-FR-1, RB4-R1; controller ruling B3-1): the STRICT check a completed bracket's ranks pass, after the structural
 *  one: standard competition ranking, with a rank shared — or left vacant — only where the stage's own fixtures declare
 *  it (`declaredPlaces`). Never more than two at one rank, and a shared rank is always one of `BRACKET_SHARED_RANKS`.
 *  Each refusal names its reason (CONFIG_INVALID). */
export function assertCompletedBracketPlaces(stage: BracketStage, fixtures: readonly BracketFixture[], places: readonly FinalPlace[]): void {
  assertBracketPlaces(stage.entrants, places);
  const declared = declaredPlaces(stage, fixtures);
  let before = 0;
  let vacant = 0; // declared vacancies already passed: each moves every rank below it down one
  while (before < places.length) {
    const rank = (places[before] as FinalPlace).rank;
    const holders = places.filter((place) => place.rank === rank).map((place) => place.entrantId);
    const at = { stageId: stage.id, rank, holders };
    if (holders.length > 2) {
      throw placesInvalid(`${holders.length} entrants share rank ${rank}; at most two may`, { reason: "more_than_two", ...at });
    }
    if (holders.length === 2 && !BRACKET_SHARED_RANKS.has(rank)) {
      throw placesInvalid(`rank ${rank} is shared; only ${[...BRACKET_SHARED_RANKS].join(", ")} ever are`, { reason: "not_a_shared_rank", ...at });
    }
    if (holders.length === 2 && !declared.pairs.has(rank) && !declared.pairsBelowVacancy.has(rank)) {
      throw placesInvalid(`rank ${rank} is shared, which stage "${stage.id}" does not declare`, { reason: "undeclared_shared_place", ...at });
    }
    const competition = before + 1 + vacant;
    const fits =
      rank === competition
        ? !(holders.length === 2 && declared.pairsBelowVacancy.has(rank))
        : rank === competition + 1 &&
          (holders.length === 2 ? declared.pairsBelowVacancy.has(rank) : declared.vacancies.has(competition));
    if (!fits) {
      throw placesInvalid(`rank ${rank} after ${before} entrant(s) breaks competition ranking (expected ${competition})`, { reason: "not_competition_ranking", ...at });
    }
    if (holders.length === 1 && rank === competition + 1) vacant += 1;
    before += holders.length;
  }
}

// A joint final's two winners. Assumptions are guards (wiring bugs, plain Error): joint winners end the final only, both
// sides seated, decided with no winner, no loser and no walkover.
function jointWinnersOf(fixture: BracketFixture): readonly [EntrantId, EntrantId] {
  const bug = (what: string): Error => new Error(`bracket fixture ${fixture.id}: jointWinners ${what}`);
  if (fixture.isFinal !== true) throw bug("on a fixture that is not the final");
  if (fixture.home === undefined || fixture.away === undefined) throw bug("needs both sides seated");
  if (fixture.winner !== undefined || fixture.loser !== undefined) throw bug("names a winner or a loser");
  if (fixture.walkedOver !== undefined) throw bug("on a walkedOver fixture");
  if (fixture.status !== "decided") throw bug(`on a fixture that is "${fixture.status}", not decided`);
  return [fixture.home, fixture.away];
}

// What a settled final decided, if anything: joint winners, a vacant title (both sides walked over), or a champion.
function titleOf(fixture: BracketFixture): BracketTitle | undefined {
  if (fixture.jointWinners === true) return { kind: "joint", winners: jointWinnersOf(fixture) };
  if (fixture.walkedOver === "both") return { kind: "vacant" };
  if (fixture.winner !== undefined) return { kind: "champion", champion: fixture.winner };
  return undefined;
}

// The deciding game (Q4): the latest-round settled final that decided something — a winner, joint winners, or both sides
// walked over (a vacant title). A voided final (DE bracket reset skipped because the WB champion won GF1, spec 05 §2.4)
// is settled for completion but decides nothing, so it never shadows GF1. Every jointWinners row is checked first, a
// final's or not.
function decidingFinal(fixtures: readonly BracketFixture[]): { fixture: BracketFixture; title: BracketTitle } | undefined {
  for (const fixture of fixtures) if (fixture.jointWinners === true) jointWinnersOf(fixture);
  let decided: { fixture: BracketFixture; title: BracketTitle } | undefined;
  for (const fixture of fixtures) {
    if (fixture.isFinal !== true || !SETTLED.has(fixture.status)) continue;
    const title = titleOf(fixture);
    if (title !== undefined && (decided === undefined || fixture.round > decided.fixture.round)) decided = { fixture, title };
  }
  return decided;
}

// The entrants a `walkedOver` fixture puts out. Assumptions are guards: a double walkover decided nobody, so a row that
// names a winner or a loser is a wiring bug; a forfeit always names who forfeited.
function walkedOverSides(fixture: BracketFixture): EntrantId[] {
  if (fixture.walkedOver === "both") {
    if (fixture.winner !== undefined || fixture.loser !== undefined) {
      throw new Error(`bracket fixture ${fixture.id}: a double walkover (walkedOver "both") names a winner or a loser`);
    }
    // Both sides were absent, so both were seated: a "both" row with an empty seat is a wiring bug too.
    if (fixture.home === undefined || fixture.away === undefined) {
      throw new Error(`bracket fixture ${fixture.id}: a double walkover (walkedOver "both") is missing a side`);
    }
    return [fixture.home, fixture.away];
  }
  if (fixture.loser === undefined) {
    throw new Error(`bracket fixture ${fixture.id}: a forfeit (walkedOver "loser") names no loser`);
  }
  return [fixture.loser];
}

// The stage's declared entrants, refused when one repeats (X-FR-1: each entrant exactly once).
function declaredEntrants(stage: BracketStage): Set<EntrantId> {
  const declared = new Set<EntrantId>();
  for (const id of stage.entrants) {
    if (declared.has(id)) {
      throw placesInvalid(`stage "${stage.id}" declares "${id}" twice`, { reason: "duplicate_declared_entrant", stageId: stage.id, entrantId: id });
    }
    declared.add(id);
  }
  return declared;
}

// W4 (X-SP-4, RB4-S4; RB4-S1): the round each declared stepladder entrant in no fixture was due to enter. The ladder is
// drawn in seed order over the stage's entrants (`generateStepladder`): of k, ladder places k − 1 and k play first, at
// round 0, and place p ≤ k − 2 waits for round k − 1 − p. One in no fixture left before their rung was played, so that
// rung holds an empty seat — theirs, dead (X-WD-3, ruling 116) — and they rank as its loser. A rung with no empty seat
// was drawn without them (as is no rung at all): they stay in no fixture, last. The rung is read from the seed. One with
// no seed — or a stage with no seed map, an unseeded division — has no rung to read, and ranks last as before W4: a read
// path never refuses (Review Focus 5; T11 review I1, controller ruling).
function stepladderDueRounds(stage: BracketStage, fixtures: readonly BracketFixture[], named: ReadonlySet<EntrantId>): Map<EntrantId, number> {
  const due = new Map<EntrantId, number>();
  const k = stage.entrants.length;
  const seedKey = (id: EntrantId): number => stage.seeds?.get(id) ?? Number.MAX_SAFE_INTEGER;
  stage.entrants.forEach((id, index) => {
    if (named.has(id)) return;
    const seed = stage.seeds?.get(id);
    if (seed === undefined) return;
    // Their ladder place, as the generator's seed order draws it: by seed, a tie by declared order.
    const place = 1 + stage.entrants.filter((other, i) => seedKey(other) < seed || (seedKey(other) === seed && i < index)).length;
    const round = place >= k - 1 ? 0 : k - 1 - place;
    if (fixtures.some((fixture) => fixture.round === round && (fixture.home === undefined || fixture.away === undefined))) due.set(id, round);
  });
  return due;
}

// Rank entrants by bracket position (spec 05 §1 "ranking" column). Champion =
// winner of the last `isFinal` game; runner-up = its loser; everyone else is
// ordered by how late they were eliminated (later round = better), then by
// seed. A knockout's semi-final losers share 3rd unless a 3rd-place play-off decides 3rd and 4th (SH-3, W4).
// W4 (X-FR-1): every DECLARED entrant is ranked, one in no fixture last (a stepladder seed: at their rung, X-SP-4); a
// fixture naming anyone else reaches the structural guard as a place and is refused there. Mid-bracket the ranks are
// provisional (B3-3): an entrant still in play ranks above every entrant out.
export function bracketRanks(
  stage: BracketStage,
  fixtures: readonly BracketFixture[],
): FinalPlace[] {
  const entrants = declaredEntrants(stage);
  const named = new Set<EntrantId>();
  for (const fixture of fixtures) {
    for (const id of [fixture.home, fixture.away, fixture.winner, fixture.loser]) {
      if (id !== undefined) {
        entrants.add(id);
        named.add(id);
      }
    }
  }

  const decided = decidingFinal(fixtures);

  const lastLossRound = new Map<EntrantId, number>();
  for (const fixture of fixtures) {
    if (!SETTLED.has(fixture.status) || fixture.loser === undefined) continue;
    const prev = lastLossRound.get(fixture.loser) ?? -1;
    if (fixture.round > prev) lastLossRound.set(fixture.loser, fixture.round);
  }
  // W2b (X-DE-1, X-DW-2): a forfeit loser and both sides of a double walkover are OUT at that fixture — seating never
  // drops them — so their elimination round is pinned there, the earliest such fixture, and a later loss a stale row
  // still names cannot move it. Every other entrant is eliminated at its LAST loss (a double-elim drop is not out).
  const outAt = new Map<EntrantId, number>();
  for (const fixture of fixtures) {
    if (!SETTLED.has(fixture.status) || fixture.walkedOver === undefined) continue;
    const out = walkedOverSides(fixture);
    for (const id of out) {
      const prev = outAt.get(id);
      if (prev === undefined || fixture.round < prev) outAt.set(id, fixture.round);
    }
  }
  // W4 (X-SP-4, RB4-S4): a stepladder seed in no fixture is out at the rung they were due to enter (`stepladderDueRounds`).
  const dueRound = stage.kind === "stepladder" ? stepladderDueRounds(stage, fixtures, named) : new Map<EntrantId, number>();
  // One that never lost and was never walked over ranks below every round: its line voided, or in no fixture at all.
  const eliminatedIn = (id: EntrantId): number => outAt.get(id) ?? lastLossRound.get(id) ?? dueRound.get(id) ?? -1;

  // B3-3 (provisional reads): an entrant still in play — seated in a fixture not yet settled, and not put out by a
  // walkover — ranks above every entrant out, fewest losses first (a winners'-bracket side above a losers'-bracket one),
  // then seed, then id. B3 fix round 1 (controller ruling): a void final decided nothing, so its seated sides are still
  // in too — never ranked below the entrants they knocked out. Once every fixture is settled, only a void final's sides
  // can be in play; a stage completes over a void final only when an earlier final crowned someone (a double-elimination
  // reset not needed), and the title has placed that pair already.
  const losses = new Map<EntrantId, number>();
  const inPlay = new Set<EntrantId>();
  for (const fixture of fixtures) {
    const settled = SETTLED.has(fixture.status);
    if (settled && fixture.loser !== undefined) losses.set(fixture.loser, (losses.get(fixture.loser) ?? 0) + 1);
    const stillIn = !settled || (fixture.isFinal === true && fixture.status === "void");
    if (!stillIn) continue;
    for (const id of [fixture.home, fixture.away]) if (id !== undefined && !outAt.has(id)) inPlay.add(id);
  }

  const seedOf = (id: EntrantId): number => stage.seeds?.get(id) ?? Number.MAX_SAFE_INTEGER;
  const bySeedThenId = (a: EntrantId, b: EntrantId): number => {
    const sa = seedOf(a);
    const sb = seedOf(b);
    if (sa !== sb) return sa - sb;
    return a < b ? -1 : a > b ? 1 : 0;
  };
  // W4 (X-SP-5, RB4-S5): a page-playoff entrant a walkover put out — a withdrawal — ranks below everyone still in the
  // stage when they left, so below one out by play in the same round (a Qualifier 1 withdrawal below the Eliminator's
  // loser). Every other kind keeps elimination round, then seed, then id (X-FR-2).
  const forfeitsLast = stage.kind === "page_playoff";
  const rankRest = (ids: EntrantId[]): EntrantId[] =>
    ids.sort((a, b) => {
      const ra = eliminatedIn(a);
      const rb = eliminatedIn(b);
      if (ra !== rb) return rb - ra; // eliminated later ⇒ ranked higher
      if (forfeitsLast && outAt.has(a) !== outAt.has(b)) return outAt.has(a) ? 1 : -1;
      return bySeedThenId(a, b);
    });

  const places: FinalPlace[] = [];
  const placed = new Set<EntrantId>();
  let lastRank = 0;
  const placeAt = (id: EntrantId | undefined, rank: number): void => {
    if (id === undefined || placed.has(id)) return;
    places.push({ entrantId: id, rank });
    placed.add(id);
    lastRank = rank;
  };
  // X-FR-2 (ruling 273, RB4-R2): outside a shared place every rank is strict — max(previous rank + 1, entrants already
  // placed + 1) — so a shared 3rd's second holder still uses up a place (3, 3, then 5) and a vacant rank stays vacant.
  const placeNext = (id: EntrantId | undefined): void => placeAt(id, Math.max(lastRank + 1, placed.size + 1));

  // The title (Q4; RB4-C1, C3, C4): a champion ranks 1st and the final's loser 2nd; joint winners both 1st; a vacant
  // title's two finalists both 2nd, 1st vacant — each pair by seed, then id.
  if (decided !== undefined) {
    const { fixture: decider, title } = decided;
    if (title.kind === "champion") {
      placeNext(title.champion);
      placeNext(decider.loser);
    } else if (title.kind === "joint") {
      for (const id of [...title.winners].sort(bySeedThenId)) placeAt(id, 1);
    } else {
      for (const id of walkedOverSides(decider).sort(bySeedThenId)) placeAt(id, 2);
    }
  }

  const stillInPlay = [...inPlay].filter((id) => !placed.has(id));
  stillInPlay.sort((a, b) => (losses.get(a) ?? 0) - (losses.get(b) ?? 0) || bySeedThenId(a, b));
  for (const id of stillInPlay) placeNext(id);

  // SH-3 (ruling 270; RB4-T2, T3, T6): a knockout's third-place block, after the title (and, mid-bracket, after every
  // entrant still in play: `third` is never above them). Its semi-finals are the fixtures of the final's round before
  // (the play-off is in the final's round). With no play-off, or a voided one (plan's call), every semi-final loser
  // ranks 3rd (X-TP-3), by seed then id. A decided play-off gives its winner 3rd and its loser 4th; both its sides
  // walked over, both rank 4th and 3rd stays vacant (X-TP-7). An unsettled play-off names no winner or loser yet, so it
  // places nobody: the strict order below (completion refuses it, X-TP-4). A semi-final both sides walked over has no
  // loser: its two sides rank in the strict block (plan's call). Every other kind ranks strictly below its title (Rank
  // places table). A final in round 0 (two entrants) has no semi-final round.
  const final = fixtures.find((fixture) => fixture.isFinal === true);
  if (stage.kind === "knockout" && final !== undefined) {
    const third = Math.max(3, lastRank + 1);
    const playOff = fixtures.find((fixture) => fixture.thirdPlace === true);
    if (playOff === undefined || playOff.status === "void") {
      // An unsettled semi-final names no loser; its seated sides are in play, so already placed above. X-FR-3 (RB4-R3):
      // an entrant a walkover put out in an earlier round is out there, so a stale semi-final row naming it a loser
      // never makes it a semi-final loser.
      const semiLosers = fixtures
        .filter((fixture) => fixture.round === final.round - 1)
        .flatMap((fixture) => {
          const loser = fixture.loser;
          return loser === undefined || (outAt.get(loser) ?? fixture.round) < fixture.round ? [] : [loser];
        })
        .sort(bySeedThenId);
      for (const id of semiLosers) placeAt(id, third);
    } else if (playOff.walkedOver === "both") {
      for (const id of walkedOverSides(playOff).sort(bySeedThenId)) placeAt(id, third + 1);
    } else {
      placeAt(playOff.winner, third);
      placeAt(playOff.loser, third + 1);
    }
  }

  for (const id of rankRest([...entrants].filter((id) => !placed.has(id)))) placeNext(id);
  assertBracketPlaces(stage.entrants, places);
  return places;
}

// ---------------------------------------------------------------------------
// Withdrawal policies — spec 05 §5
// ---------------------------------------------------------------------------

export interface WithdrawalResult {
  events: DivisionEvent[];
  updates: FixtureUpdate[];
}

function involvesEntrant(fixture: TableFixture, entrantId: EntrantId): boolean {
  return (
    fixture.result?.[0].entrantId === entrantId || fixture.result?.[1].entrantId === entrantId
  );
}

// Which table kinds may EXPUNGE an early withdrawal. One row per kind, so a
// new table kind has to declare its rule rather than inherit one.
//
// Swiss never does (owner ruling 2026-09-24, "case 2", option A). Expunging a
// Swiss board abandons it with no outcome, and the round can then neither be
// paired past (an abandoned board is not decided), unpaired (it has a played
// result) nor forfeited (the match is over) — the division is stranded. A
// Swiss withdrawal keeps every played result, earlier walkovers included, and
// walks each paired board over to the opponent; unseated later rounds simply
// pair without them. The same verdict feeds the qualification builder
// (apps/web lib/table-withdrawal + qualification-view), so it lives here once.
const EXPUNGES_EARLY_WITHDRAWAL: Readonly<Record<TableStage["kind"], boolean>> = {
  league: true,
  group: true,
  swiss: false,
};

// spec 05 §5 — league/group `void_remaining`: if the withdrawing entrant has
// played < 50% of its fixtures, EXPUNGE (void all its games so the standings
// read as if it never entered); otherwise AWARD its remaining fixtures to the
// opponents as forfeits and keep the games already played. `played`/`total`
// are the entrant's decided vs scheduled fixture counts (the caller knows the
// full schedule, including result-less pending fixtures). Swiss always
// AWARDS — see EXPUNGES_EARLY_WITHDRAWAL.
export function withdrawTableEntrant(
  stage: Pick<TableStage, "id" | "kind">,
  entrantId: EntrantId,
  fixtures: {
    played: readonly TableFixture[]; // decided games this entrant appears in
    pending: readonly { id: string; opponent: EntrantId }[]; // its unplayed games
  },
): WithdrawalResult {
  const playedCount = fixtures.played.filter((fixture) => involvesEntrant(fixture, entrantId)).length;
  const total = playedCount + fixtures.pending.length;
  const fraction = total === 0 ? 0 : playedCount / total;
  const expunge = EXPUNGES_EARLY_WITHDRAWAL[stage.kind] && fraction < 0.5;

  const updates: FixtureUpdate[] = [];
  if (expunge) {
    for (const fixture of fixtures.played) {
      if (involvesEntrant(fixture, entrantId)) updates.push({ fixtureId: fixture.id, status: "void" });
    }
    for (const pending of fixtures.pending) updates.push({ fixtureId: pending.id, status: "void" });
  } else {
    for (const pending of fixtures.pending) {
      updates.push({ fixtureId: pending.id, status: "walkover", walkoverTo: pending.opponent });
    }
  }

  return {
    events: [
      {
        type: "entrant_withdrawn",
        stageId: stage.id,
        entrantId,
        policy: "void_remaining",
        mode: expunge ? "expunge" : "award",
      },
    ],
    updates,
  };
}

// spec 05 §5 — knockout `bracket_walkover`: the withdrawing entrant's remaining
// fixtures are walked over to the opponent, who advances.
export function withdrawBracketEntrant(
  stage: BracketStage,
  entrantId: EntrantId,
  fixtures: readonly BracketFixture[],
): WithdrawalResult {
  const updates: FixtureUpdate[] = [];
  for (const fixture of fixtures) {
    if (SETTLED.has(fixture.status)) continue;
    if (fixture.home !== entrantId && fixture.away !== entrantId) continue;
    const opponent = fixture.home === entrantId ? fixture.away : fixture.home;
    updates.push({
      fixtureId: fixture.id,
      status: "walkover",
      ...(opponent === undefined ? {} : { walkoverTo: opponent }),
    });
  }
  return {
    events: [{ type: "entrant_withdrawn", stageId: stage.id, entrantId, policy: "bracket_walkover" }],
    updates,
  };
}
