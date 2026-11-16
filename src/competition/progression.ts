// The unified progression field (design doc §2.1/§3, F2). Neither the OLD
// `qualification` vocabulary nor the OLD `seeding` vocabulary was a superset
// of the other — qualification alone could express multiple SOURCE stages
// with dedupe; seeding alone could express a group-count-agnostic take
// pattern and a real DRAW (snake/seeded_map). This module is the union: one
// TakeRule type covering every prior spec shape, one placement algorithm,
// one resolver. Pure — no DB, no tenant, idempotent.
import { EngineError } from "../core/errors.ts";
import type { EntrantId } from "../core/types.ts";
import type { BracketSlotRef } from "../scheduling/bracket.ts";
import type { TiebreakerKey } from "../sport/module.ts";
import { isHeadToHeadKey } from "./cascade-rules.ts";
import { firstLossField, type FirstLossField } from "./first-loss.ts";
import type { FinalPlace, FixtureStatus } from "./stage.ts";
import {
  foldResults,
  resultsAmong,
  type FixtureResult,
  type StandingsRow,
} from "./standings.ts";
import {
  rankStandings,
  type MembersKey,
  type NewLotsDraw,
  type RankContext,
  type RankingResult,
  type StoredLotsDraw,
} from "./tiebreakers.ts";

export interface PoolRankPick {
  pool: string;
  rank: number;
}

// The union table (design doc §2.1, F2 prompt): rankRange survives topN
// (topN:n IS rankRange{from:1,to:n} — the design doc names this directly);
// bestNth survives bestOfRank (bestNth already has the real cross-group
// cascade + tie-flagging two shipped catalogue templates depend on;
// bestOfRank's only extra field, normaliseUnequalPools, is absorbed here and,
// since W5 ruling 286, accepted and ignored: the unequal-pools reduction is
// always on — `compareBestNth` below). picks/roundLosers are qualification's
// TakePicks/RoundLosers, unchanged in meaning, given the kind-tagged shape
// the rest of this union already uses.
// W4 (Task 10; RB4-P1, P4; X-PL-3; owner ruling 265): `firstLosses` is the plate's take — every eligible first loss of a
// single-elimination source (`firstLossField`, first-loss.ts), with no count: the field decides how many (RB4-P4), and it
// is known only after round 2 (RB4-P3). `roundLosers` stays as it is: stored progressions still name it (app PR B
// migrates them).
export type TakeRule =
  | { kind: "rankRange"; from: number; to: number }
  | { kind: "topNPerGroup"; n: number }
  | {
      kind: "bestNth";
      nth: number;
      count: number;
      /** @deprecated W5 ruling 286 (RB5-U8): accepted and ignored. Best-Nth over unequal pools always compares every
       *  candidate on the smallest pool's matches (k = effective size − min, RB5-U1/U7), and equal pools drop nothing
       *  (RB5-U6), set or not. Kept so stored progressions parse. */
      normaliseUnequalPools?: boolean;
    }
  | { kind: "picks"; picks: readonly PoolRankPick[] }
  | { kind: "roundLosers"; round: number; count: number }
  | { kind: "firstLosses" };

export interface ProgressionSource {
  stage: "previous" | { stageId: string };
  take: readonly TakeRule[];
}

export interface SeededMapEntry {
  slot: string;
  source: string;
}

// Deliberately WITHOUT a "when do these fixtures appear" field — that is an
// apps/web orchestration decision (createStages / generateStageFixtures),
// not something take-rule/placement/resolution math needs. apps/web's wire
// ProgressionSchema is this shape plus `timing`.
export interface ProgressionSpec {
  sources: readonly ProgressionSource[];
  placement: "rank_order" | "snake" | "seeded_map";
  map?: readonly SeededMapEntry[];
}

// WHO a not-yet-filled slot represents, independent of whether the source
// stage has finished (shape) or has real standings (resolution).
// `descriptorKey` is the wire identity `seeded_map.source` matches against;
// `descriptorLabel` is the i18n pattern ref persisted onto
// fixtures.home/away_slot_label.
export type SlotDescriptor =
  | { kind: "group_rank"; pool: string; rank: number }
  | { kind: "rank_range"; rank: number }
  | {
      kind: "best_nth";
      nth: number;
      position: number;
      /** @deprecated W5 ruling 286 (RB5-U8): carried from the take rule, read by nothing. */
      normaliseUnequalPools?: boolean;
    }
  | { kind: "round_loser"; round: number; position: number }
  | {
      kind: "first_loss";
      /** The slot's place in the first-loss field: the ORDER OF FIRST LOSS (by round, then bracket position), NOT the
       *  plate seed. The app re-seeds the plate by main-draw seed on the fold (RB4-D10, X-SD-11), so the resolved
       *  `seed` of a first_loss qualifier is this order, never a seeding. */
      position: number;
    };

export interface SlotLabel {
  key: string;
  params: Record<string, unknown>;
}

export interface SourceShape {
  poolKeys: string[];
  /** W4 (Task 10): how many eligible first losses the source's field holds (`firstLossField(...).losers.length`), once
   *  the caller knows it. Absent — at save time, before round 2 — a `firstLosses` take expands to no slot. */
  firstLossCount?: number;
}

/** A descriptor tagged with which `ProgressionSpec.sources[]` entry produced
 *  it. Index 0 for every single-source progression — every progression this
 *  session's writers emit is single-source; multi-source is new capability
 *  (Finding 1: it never worked before this module). */
export interface SourcedSlot {
  sourceIndex: number;
  descriptor: SlotDescriptor;
}

export function descriptorKey(d: SlotDescriptor): string {
  switch (d.kind) {
    case "group_rank":
      return `${d.pool}${d.rank}`;
    case "rank_range":
      return `rank:${d.rank}`;
    case "best_nth":
      return `best:${d.position}`;
    case "round_loser":
      return `loser:${d.round}:${d.position}`;
    case "first_loss":
      return `first:${d.position}`;
  }
}

export function descriptorLabel(d: SlotDescriptor): SlotLabel {
  switch (d.kind) {
    case "group_rank":
      if (d.rank === 1) return { key: "slot.winner_group", params: { g: d.pool } };
      if (d.rank === 2) return { key: "slot.runner_up_group", params: { g: d.pool } };
      return { key: "slot.nth_group", params: { n: d.rank, g: d.pool } };
    case "rank_range":
      return { key: "slot.rank_range", params: { rank: d.rank } };
    case "best_nth":
      return { key: "slot.best_nth", params: { rank: d.position, nth: d.nth } };
    case "round_loser":
      return { key: "slot.round_loser", params: { round: d.round, n: d.position } };
    case "first_loss":
      return { key: "slot.first_loss", params: { n: d.position } };
  }
}

function expandOne(rule: TakeRule, shape: SourceShape): SlotDescriptor[][] {
  switch (rule.kind) {
    case "rankRange": {
      const pot: SlotDescriptor[] = [];
      for (let r = rule.from; r <= rule.to; r++) pot.push({ kind: "rank_range", rank: r });
      return [pot];
    }
    case "topNPerGroup": {
      const pools = shape.poolKeys.length > 0 ? shape.poolKeys : [""];
      const pots: SlotDescriptor[][] = [];
      // WAVE-major, not pool-major: every group's winner (wave 1) before any
      // group's runner-up (wave 2) — the standard tournament convention, and
      // what makes "snake" meaningful.
      for (let wave = 1; wave <= rule.n; wave++) {
        pots.push(pools.map((pool) => ({ kind: "group_rank", pool, rank: wave })));
      }
      return pots;
    }
    case "bestNth": {
      const pot: SlotDescriptor[] = [];
      for (let i = 1; i <= rule.count; i++) {
        pot.push({
          kind: "best_nth",
          nth: rule.nth,
          position: i,
          ...(rule.normaliseUnequalPools !== undefined
            ? { normaliseUnequalPools: rule.normaliseUnequalPools }
            : {}),
        });
      }
      return [pot];
    }
    case "picks":
      // Declaration order is data — one singleton pot PER pick so no
      // placement (snake included) can ever reorder a literal enumeration.
      return rule.picks.map((p) => [{ kind: "group_rank", pool: p.pool, rank: p.rank }]);
    case "roundLosers": {
      const pot: SlotDescriptor[] = [];
      for (let i = 1; i <= rule.count; i++) pot.push({ kind: "round_loser", round: rule.round, position: i });
      return [pot];
    }
    case "firstLosses": {
      // One pot of the field's size, in the field's order; no count yet, no slot (RB4-P3: known after round 2).
      const pot: SlotDescriptor[] = [];
      for (let i = 1; i <= (shape.firstLossCount ?? 0); i++) pot.push({ kind: "first_loss", position: i });
      return [pot];
    }
  }
}

export function expandTake(take: readonly TakeRule[], shape: SourceShape): SlotDescriptor[][] {
  return take.flatMap((rule) => expandOne(rule, shape));
}

/** Total qualifier count across every rule, every kind — never throws (a
 *  read path, previewDivisionFixtures, sizes a stage graph with it). */
export function progressionSize(take: readonly TakeRule[]): number {
  return take.reduce((n, rule) => {
    if (rule.kind === "rankRange") return n + Math.max(0, rule.to - rule.from + 1);
    if (rule.kind === "topNPerGroup") return n; // group-count-dependent; callers with a real shape use expandTake instead
    if (rule.kind === "bestNth") return n + rule.count;
    if (rule.kind === "picks") return n + rule.picks.length;
    if (rule.kind === "firstLosses") return n; // field-dependent: callers size it from firstLossField (B4-7: load-bearing)
    return n + rule.count; // roundLosers
  }, 0);
}

/** Flatten every source's pots, IN SOURCE DECLARATION ORDER, tagging each
 *  descriptor with which source produced it. `shapeOf` is a callback rather
 *  than an array because callers resolve shape lazily (a source stage's
 *  pool count may need its own DB read, per source). */
export function expandSources(
  sources: readonly ProgressionSource[],
  shapeOf: (sourceIndex: number) => SourceShape,
): SourcedSlot[][] {
  return sources.flatMap((source, sourceIndex) =>
    expandTake(source.take, shapeOf(sourceIndex)).map((pot) =>
      pot.map((descriptor) => ({ sourceIndex, descriptor })),
    ),
  );
}

function snakeMerge(pots: readonly SourcedSlot[][]): SourcedSlot[] {
  return pots.flatMap((pot, i) => (i % 2 === 0 ? pot : [...pot].reverse()));
}

/** Resolve `sources[].take`'s pots + `placement` into the final seed 1..N
 *  order. `seeded_map` entries are validated here (unknown source /
 *  out-of-range or duplicate slot) — the "422 at rule save, not at proposal
 *  time" contract carried forward from stage-seeding.ts.
 *
 *  P6 (F3 Task 3) — RESOLVED, was a KNOWN LIMITATION: `seeded_map`'s
 *  `source` string matches against `descriptorKey`, which does not encode
 *  which SOURCE a descriptor came from. A multi-source progression whose two
 *  sources happen to emit the same descriptor key (e.g. both have a
 *  "group_rank A1") is now a genuine ambiguity: if a `seeded_map` entry
 *  names that key, this throws `SEEDING_MAP_SOURCE_AMBIGUOUS` naming the key
 *  and every colliding source index, rather than silently resolving to
 *  whichever source's copy happened to be visited last (the old `Map`
 *  construction's last-write-wins behaviour — the wrong team's placeholder
 *  in the wrong bracket seat, every test green). A shared key that is NOT
 *  referenced by any `seeded_map` entry is not an error — both copies flow
 *  through untouched, same as `rank_order`/`snake` (plain array
 *  concatenation/reversal, never keyed by `descriptorKey`, so they never had
 *  this bug). This was unreachable from the picker before F3: every writer
 *  in this codebase emits a single-source progression; multi-source is new
 *  capability this module unlocked (SourcedSlot's own doc comment). */
// Bracket-kind targets — mirrors apps/web's BRACKET_KINDS
// (server/usecases/stages.ts:1813, server/engine-db/competition.ts:37) and
// BracketStage.kind's Extract union (./stage.ts). Kept as a loose
// `ReadonlySet<string>`, not core's `StageKind`, so BOTH apps/web callers
// (stages.ts, stage-seeding.ts) can pass their DB row's `kind: string`
// verbatim — no cast, no new parse/throw path. An unrecognised value simply
// isn't in the set, which is the same "don't refuse" outcome as omitting
// `targetKind` altogether (see placeDescriptors' doc comment) — this module
// stays tolerant of loose caller data the way progressionSize/
// previewSourceShape already are elsewhere. Keep the four names in sync with
// those two apps/web sites if a new bracket stage kind ever ships.
// Exported (round-4 review, B) so apps/web's bracket-kinds-sync.test.ts can
// pin this literal against its two hand-copied siblings — see that test's
// own header comment for why an unsynced 5th bracket kind is a silent,
// fail-open hazard rather than a loud one.
export const BRACKET_STAGE_KINDS: ReadonlySet<string> = new Set([
  "knockout",
  "double_elim",
  "stepladder",
  "page_playoff",
]);

export function placeDescriptors(
  pots: readonly SourcedSlot[][],
  placement: "rank_order" | "snake" | "seeded_map",
  map?: readonly SeededMapEntry[],
  // F3 round-3 review, Task 1 — the target stage's raw `kind` (apps/web's
  // stages.kind column), OPTIONAL: absent/unrecognised means "unknown,
  // don't refuse" rather than "always refuse", so a caller that hasn't been
  // taught to pass it yet (or is validating a shape with no real target in
  // hand) doesn't regress into an always-throwing guard.
  targetKind?: string,
): SourcedSlot[] {
  // Ruling 13 (F3 programme index, round-3 review): snake is chosen by the
  // TARGET stage's kind, not the source's. Rule of record: "snake for a
  // group/pool target, rank_order for a bracket target." Two refusals
  // enforce it, both snake-specific:
  //
  // (1) The bestNth corollary (caught in the same review as ruling 13):
  // snakeMerge reverses a pot's ARRAY ORDER but never touches each
  // descriptor's own `position` (its cross-group strength rank), so
  // reversing a bestNth pot would seed the WEAKEST wildcard into the
  // STRONGEST bracket slot. There is no target for which that reversal is
  // ever correct, so this refuses unconditionally — target-kind known or
  // not.
  if (placement === "snake") {
    const potIndex = pots.findIndex((pot) => pot.some((s) => s.descriptor.kind === "best_nth"));
    if (potIndex !== -1) {
      throw new EngineError(
        "CONFIG_INVALID",
        `placement "snake" cannot be combined with a bestNth-sourced pot (pot ${potIndex}) — snakeMerge reverses a pot's array order without moving each descriptor's cross-group strength rank ("position"), so the weakest wildcard would seed into the strongest slot; use "rank_order" for a bestNth take`,
        { placement, potIndex },
      );
    }
    // (2) The rule itself (Task 1 — the corollary above is not the rule,
    // it's one instance of it). A WAVE-major pot (topNPerGroup's shape —
    // expandOne's own comment: "every group's winner (wave 1) before any
    // group's runner-up (wave 2)"; >1 descriptor, every one `group_rank`;
    // `picks`' singleton group_rank pots are immune — reversing a 1-element
    // pot is a no-op) placed into a bracket-kind TARGET is refused: snakeMerge
    // reverses alternate waves, and a single-elimination seed fold then pairs
    // seed i against seed N+1-i (scheduling/bracket.ts:52-63,156-163) — which
    // lands every pool's OWN wave-1 qualifier against its OWN wave-2
    // qualifier in round 1 (ruling 13's worked example: 4 pools,
    // topNPerGroup(2) => round 1 is A1 v A2, B1 v B2 — every group replaying
    // its own final). `targetKind` unknown/not a bracket kind => this check
    // is skipped entirely (see the param's own doc comment); t20-super8's
    // real usage (a GROUP target) is exactly the skip case.
    if (targetKind !== undefined && BRACKET_STAGE_KINDS.has(targetKind)) {
      const waveIndex = pots.findIndex(
        (pot) => pot.length > 1 && pot.every((s) => s.descriptor.kind === "group_rank"),
      );
      if (waveIndex !== -1) {
        throw new EngineError(
          "CONFIG_INVALID",
          `placement "snake" cannot target a bracket-kind stage ("${targetKind}") together with a multi-pool wave (pot ${waveIndex}) — snakeMerge reverses alternate waves, and a single-elimination seed fold then pairs each pool's OWN qualifiers against each other in round 1 (e.g. group A's winner meets group A's runner-up); use "rank_order" for a bracket target — snake is only correct for a group/pool target`,
          { placement, targetKind, potIndex: waveIndex },
        );
      }
    }
  }
  const flat = placement === "snake" ? snakeMerge(pots) : pots.flat();
  if (placement !== "seeded_map" || !map || map.length === 0) return flat;

  const total = flat.length;
  // Grouped by key (never collapsed to one) — a multi-source progression can
  // legitimately produce the same descriptorKey from two different sources,
  // and `seeded_map.source` is a bare key with no source qualifier, so
  // resolving it can be genuinely ambiguous (see this function's own doc
  // comment above).
  const byKey = new Map<string, SourcedSlot[]>();
  for (const s of flat) {
    const key = descriptorKey(s.descriptor);
    const list = byKey.get(key);
    if (list) list.push(s);
    else byKey.set(key, [s]);
  }
  const seats = new Array<SourcedSlot | undefined>(total).fill(undefined);
  // Claimed by OBJECT identity, not by key string: two flat entries can
  // share a descriptorKey without being the same slot (the ambiguous-but-
  // unreferenced case above), and only the ONE explicitly-mapped slot may be
  // removed from the auto-fill pool — a key-based claim would silently drop
  // its unclaimed sibling too.
  const claimed = new Set<SourcedSlot>();

  for (const entry of map) {
    const seat = Number(entry.slot);
    if (!Number.isInteger(seat) || seat < 1 || seat > total) {
      throw new EngineError(
        "SEEDING_MAP_SLOT_INVALID",
        `seeded_map slot "${entry.slot}" is outside the 1..${total} seed range`,
        { slot: entry.slot, total },
      );
    }
    const candidates = byKey.get(entry.source);
    if (!candidates || candidates.length === 0) {
      throw new EngineError(
        "SEEDING_MAP_SOURCE_INVALID",
        `seeded_map source "${entry.source}" does not match any qualifier this stage's rules produce`,
        { source: entry.source, available: [...byKey.keys()] },
      );
    }
    if (candidates.length > 1) {
      const sourceIndexes = candidates.map((c) => c.sourceIndex);
      const distinctSources = new Set(sourceIndexes);
      // F3 review item 2 (RESOLVED) — was `candidates.length > 1` alone, so
      // a SINGLE source with two overlapping take rules (e.g. two
      // overlapping rankRanges) also threw here, with `sourceIndexes: [0,
      // 0]` while the message claimed ">1 progression source" — a
      // same-source collision is a different condition and (for every
      // descriptorKey EXCEPT best_nth's) a harmless one: descriptorKey fully
      // determines every other kind's descriptor, so a same-key match within
      // one source can only be the identical descriptor twice — an
      // overlapping/duplicate take rule that resolveProgression's own
      // entrant-dedupe guard (QUALIFICATION_INVALID) already refuses the
      // moment BOTH copies are placed, whichever one `seeded_map` picks
      // here. best_nth's key (`best:${position}`) is the one exception —
      // it drops `nth`, so two bestNth rules at the same position but a
      // DIFFERENT nth collide on key while resolving to different entrants;
      // that is genuinely ambiguous even within a single source, so it still
      // refuses rather than silently picking the wrong nth-tier entrant.
      const distinctDescriptors = new Set(candidates.map((c) => JSON.stringify(c.descriptor)));
      if (distinctSources.size > 1 || distinctDescriptors.size > 1) {
        throw new EngineError(
          "SEEDING_MAP_SOURCE_AMBIGUOUS",
          distinctSources.size > 1
            ? `seeded_map source "${entry.source}" matches qualifiers from more than one progression source (indexes ${[...distinctSources].join(", ")}) — seeded_map cannot tell them apart; use rank_order/snake placement instead, or make each source's pool keys distinct`
            : `seeded_map source "${entry.source}" matches more than one qualifier within the same progression source (source ${sourceIndexes[0]}) — its take rules produce this key more than once (e.g. two bestNth rules at the same position with a different nth); remove the overlap or duplicate rule`,
          { source: entry.source, sourceIndexes },
        );
      }
      // Same source, identical descriptor: interchangeable — fall through
      // and let `candidates[0]` claim the seat, same as any other match.
    }
    const slot = candidates[0]!;
    if (seats[seat - 1] !== undefined) {
      throw new EngineError("SEEDING_MAP_SLOT_INVALID", `seeded_map assigns seed ${seat} more than once`, {
        slot: seat,
      });
    }
    // B (round-4 review) — two DIFFERENT entries naming the SAME source both
    // resolve `candidates[0]` to this identical SourcedSlot object; `claimed`
    // already exists to keep it out of the auto-fill pool below, so it also
    // doubles as the duplicate-source check here for free: a second entry
    // reusing an already-claimed source would otherwise silently duplicate
    // that seat's descriptor into a second seed and leave the real qualifier
    // for the now-orphaned seat unplaced — surfacing far downstream as a
    // confusing QUALIFICATION_INVALID at resolve time instead of refusing
    // the malformed map right here.
    if (claimed.has(slot)) {
      throw new EngineError(
        "SEEDING_MAP_SLOT_INVALID",
        `seeded_map source "${entry.source}" is already assigned to another seed — each source may be named by at most one seeded_map entry`,
        { source: entry.source, slot: seat },
      );
    }
    seats[seat - 1] = slot;
    claimed.add(slot);
  }

  const remaining = flat.filter((s) => !claimed.has(s));
  let ri = 0;
  for (let i = 0; i < total; i++) {
    if (seats[i] === undefined) seats[i] = remaining[ri++];
  }
  return seats as SourcedSlot[];
}

/** The full "does this progression actually resolve" check every WRITER
 *  must run before trusting it (createStages/replaceStages, and
 *  templates.ts's instantiateTemplate): expand every source's take against
 *  its real shape, let placeDescriptors validate a seeded_map's
 *  slot/source references AND (F3 round-3 review, Task 1) an illegal
 *  snake-into-a-bracket-target combo, then require at least 2 qualifiers
 *  total. `targetKind` is this progression's OWN stage's raw `kind` —
 *  optional, forwarded verbatim to placeDescriptors (see its doc comment for
 *  the "unknown => don't refuse" default).
 *  W4 (Task 10): a source that takes `firstLosses` while its shape has no count yet is not counted here — its field is
 *  known only after round 2 (RB4-P3), and a field under 2 is the app's named outcome (X-PL-2), never a save refusal. */
export function validateProgressionAgainstShapes(
  shapes: readonly SourceShape[],
  progression: Pick<ProgressionSpec, "sources" | "placement" | "map">,
  targetKind?: string,
): void {
  const pots = expandSources(progression.sources, (i) => shapes[i]!);
  placeDescriptors(pots, progression.placement, progression.map, targetKind); // throws on a bad seeded_map or an illegal snake/bracket-target combo
  const total = pots.reduce((n, p) => n + p.length, 0);
  const uncounted = progression.sources.some(
    (source, i) => source.take.some((rule) => rule.kind === "firstLosses") && shapes[i]?.firstLossCount === undefined,
  );
  if (total < 2 && !uncounted) {
    throw new EngineError("SEEDING_RULES_MISSING", "this stage's progression rules produce fewer than 2 qualifiers");
  }
}

// ---------------------------------------------------------------------------
// Resolution — a completed source stage's real standings/bracket, resolved
// against a ProgressionSpec into an ordered seed list (spec 05 §3 successor).
// ---------------------------------------------------------------------------

export interface PoolTable {
  pool: string;
  rows: readonly StandingsRow[];
  /** The pool's counted results (`completeTableStage` writes them). Best-Nth reads them to compare a larger pool's
   *  candidate without the results against its bottom k (W5 RB5-U1); a best-Nth source whose pool needs k > 0 and has
   *  none is refused, STAGE_NOT_READY `pool_results_missing`. */
  results?: readonly FixtureResult[];
  /** W5 (RB5-U5, RB5-U7): the pool's entrants whose results were removed under X-WDT-1 (an expunge). Each keeps its row
   *  but counts in no effective size and is never one of the bottom k: nothing more is dropped for them. Each must be
   *  one of `rows` and named in none of `results` (CONFIG_INVALID otherwise). Written by the app's SourceTables builders
   *  from the withdrawal ledger's expunge mode; no engine code writes it. */
  expunged?: readonly EntrantId[];
}
/** A bracket source's fixture as progression reads it. `roundLosers` reads `round` and `loser` alone. W4 (Task 9) widens
 *  it with what `firstLossField` (first-loss.ts) reads — every new field optional, so a caller of `roundLosers` types as
 *  before. The app builds it from the row `toBracketFixture` already makes (apps/web/src/server/engine-db/competition.ts);
 *  `walkedOver` is `BracketFixture.walkedOver`, the one marker of a forfeit loser (X-PL-4). */
export interface BracketFixtureRow {
  round: number;
  loser?: EntrantId;
  id?: string;
  status?: FixtureStatus;
  home?: EntrantId;
  away?: EntrantId;
  winner?: EntrantId;
  walkedOver?: "loser" | "both";
  bracket?: "WB" | "LB" | "GF";
  thirdPlace?: boolean;
  /** `BracketFixture.homeFrom` / `awayFrom`: the feed of each seat. The app must pass it on dead-seat rows (final review
   *  I2): `firstLossField` reads a withdrawn entrant's empty seat through it (`resolveDeadSeats`, stage.ts). */
  homeFrom?: BracketSlotRef;
  awayFrom?: BracketSlotRef;
}
export interface SourceTables {
  pools: readonly PoolTable[];
  // Carried from the old qualification.ts's StageTables.overall — written by
  // stage.ts's completeTableStage exactly when pools.length === 1 (its only
  // write site, confirmed by grep), and read directly by stage.test.ts.
  // No longer consulted by THIS module's own resolution: rankRange falls
  // back to "the sole pool, whatever its key" instead (rankRangeSource
  // below), which covers every case `overall` ever did — the two
  // conditions were always equivalent, since nothing else ever wrote
  // `overall`. The field stays only so completeTableStage's return shape
  // and its existing test are unaffected by this module superseding
  // qualification.ts.
  overall?: readonly StandingsRow[];
  bracket?: readonly BracketFixtureRow[]; // only present for a bracket-kind source; roundLosers and firstLosses read it
  /** W2d (spec §5.9, ST-G4, X-TB-7): how the source stage compares entrants from different groups (best-Nth) —
   *  `crossGroupRulesOf(stage)` (stage.ts). Absent = the pre-W2d order, `PRE_W2D_CROSS_GROUP`, with no seeds or draws:
   *  the order every B1-migrated pin records, so a caller not yet handing the stage's own rules moves no seat. */
  crossGroup?: CrossGroupRules;
}

/** W2d (spec §5.9): a source stage's cross-group comparison — its effective `crossGroup` order (no head-to-head key:
 *  entrants from different groups never met, X-TB-7) and what its keys read. `lotsDraws` are the stage's stored
 *  cross-group draws, by members key. */
export interface CrossGroupRules {
  readonly order: readonly TiebreakerKey[];
  readonly lotsDraws?: ReadonlyMap<MembersKey, StoredLotsDraw>;
  readonly seeds?: ReadonlyMap<EntrantId, number>;
  readonly rngSeed?: number;
  readonly winsCount?: RankContext["winsCount"];
}

/** The order best-Nth used before W2d, hard-coded for every sport — and the `crossGroup` every B1-migrated pin records
 *  (V475: points, diff, for, wins), so a pinned stage's best-Nth seats do not move (B1). */
export const PRE_W2D_CROSS_GROUP: readonly TiebreakerKey[] = ["points", "diff", "for", "wins"];
export interface ResolvedProgressionEntry {
  seed: number;
  sourceIndex: number;
  descriptor: SlotDescriptor;
  entrantId: EntrantId;
  rank: number;
  /** The WITHIN-pool flag: the row this entry was taken from is a residual tie (a shared place, or its pool's own lots
   *  or seed fallback, carried through the cross-group ranking). Never the cross-pool comparison: that is `basis.levelWith`. */
  tieUnbroken: boolean;
  /** W5 T5: the source pool's key — group_rank and best_nth entries; absent otherwise. */
  pool?: string;
  /** W5 T5 (RB5-U3): how a best_nth entry was compared; best_nth entries only. */
  basis?: ComparisonBasis;
}

/** W5 (RB5-U1, RB5-U3, RB5-U7): the basis a best-Nth comparison ran on, the same for every candidate of one source and
 *  nth except `levelWith`. k(pool) = the pool's effective size (rows − expunged) − the smallest effective size among the
 *  source's pools; each pool with k > 0 has its bottom k non-expunged rows by rank (lots included, RB5-U4) left out of
 *  its candidate's results — `dropped`, in pools order, each `against` in rank order. `matchesCounted` = the largest
 *  `played` among the compared rows. `levelWith` (G3): the OTHER candidates this candidate's cross-pool comparison left
 *  level on every key of the source's cross-group order — its residual class, from ranking the compared rows with their
 *  pool trace stripped; [] when a key decided it. Independent of `tieUnbroken`. */
export interface ComparisonBasis {
  nth: number;
  matchesCounted: number;
  dropped: { pool: string; against: EntrantId[] }[];
  levelWith: EntrantId[];
}
export interface ProgressionTieFlag {
  // Widened from SlotDescriptor[] (F3 review item 1): a tie descriptor with
  // no sourceIndex is indistinguishable from an identically-keyed descriptor
  // on a DIFFERENT source (trivially: two rankRange sources, or two
  // group_rank sources sharing a pool letter) — exactly the collision
  // apps/web's computeSeedProposal (stages.ts) used to mis-seat a confirmed
  // tie pick against, because its seedOfKey Map could only key by bare
  // descriptorKey. SourcedSlot already carries sourceIndex — reuse it rather
  // than invent a parallel shape.
  descriptors: SourcedSlot[];
  entrantIds: EntrantId[];
  reason: string;
}

// Pools carry both a key ("A") and a display name ("Pool A"); progression
// picks match the KEY, but accept the name form too (strip a leading
// "Pool " prefix, case-insensitive) so neither silently resolves nothing.
const normPool = (s: string): string => s.trim().toLowerCase().replace(/^pool\s+/, "");

function findPool(pools: readonly PoolTable[], pool: string): PoolTable {
  const want = normPool(pool);
  const table = pools.find((p) => normPool(p.pool) === want);
  if (!table) {
    throw new EngineError(
      "STAGE_NOT_READY",
      `no pool "${pool || "overall"}" in the source stage — available pools: ${pools.map((p) => p.pool).join(", ")}`,
      { pool, available: pools.map((p) => p.pool) },
    );
  }
  return table;
}

/** rankRange's source table: the SOLE pool when there is exactly one —
 *  regardless of its key — otherwise the pool explicitly keyed "".
 *  Mirrors the old qualification.ts's isTopN fallback (`tables.overall ??
 *  (tables.pools.length === 1 ? tables.pools[0].rows : undefined)`) without
 *  needing the `overall` field: `overall` was written by completeTableStage
 *  (stage.ts) ONLY when pools.length === 1 — its only write site — so the
 *  two conditions were always equivalent. A single-pool source's key varies
 *  by caller: a bare league/swiss stage names it "" (no poolId on its
 *  fixtures), but e.g. testkit/simulation.ts's group_knockout format always
 *  assigns a real id ("P1") even when poolCount collapses to 1 for a small
 *  entrant count — matching on "" alone would regress that shape (verified:
 *  simulation.test.ts's SIM_RUNS property sweep hits it routinely, since
 *  drawEntrantCount skews toward low counts). */
function rankRangeSource(pools: readonly PoolTable[]): PoolTable {
  if (pools.length === 1) return pools[0]!;
  return findPool(pools, "");
}

// F2 Task 6 review (defect 4): `rankRange` replaced `topN`, whose old
// message told an organiser what to DO ("takes the top N, only M
// available — lower the qualifier count or add entrants" —
// qualification.ts's isTopN branch, pre-F2). A shortfall like that is
// discovered here for `group_rank` (findPool+rowAtRank) and `best_nth`, and
// — since W4 — for `rank_range` in `rowAtPosition` below, which takes by
// position and repeats this exact message. A generic "no entrant ranked N
// yet" regressed that — restored here, generalised to name the pool when
// there is one (the group_rank case) the way topN's flat single-table
// message never needed to. Still STAGE_NOT_READY (same code topN always used — this message was
// never in seeding-error.ts's 13-code allowlist either, before or after
// F2, so it has always reached the organiser via the raw-message fallback,
// not a wired locale key; wiring one is a separate, scoped effort per
// lib/seeding-error.ts's own "Do NOT audit or wire other unwired codes"
// note).
function rowAtRank(table: PoolTable, rank: number): StandingsRow {
  const row = table.rows.find((r) => r.rank === rank);
  if (!row) {
    const available = table.rows.length;
    const label = table.pool ? `pool "${table.pool}"` : "the previous stage";
    throw new EngineError(
      "STAGE_NOT_READY",
      `${label} takes rank ${rank}, but only ${available} entrant${available === 1 ? "" : "s"} ${available === 1 ? "is" : "are"} available — lower the qualifier count or add entrants`,
      { pool: table.pool, rank, available },
    );
  }
  return row;
}

/** W4 (RB4-Q2; controller ruling B3-8): `rank_range` takes by POSITION — the table's rows in rank order (a stable sort,
 *  so a stored snapshot listed in any order reads as before), position `rank` of them. A bracket source's places can
 *  share a rank (X-FR-1: two semi-final losers both 3rd), so a take never needs a rank nobody holds (1..4 over 1, 2, 3, 3
 *  takes four). A row whose rank another row shares is returned as a clone flagged `tieUnbroken` with `tieBreak.key:
 *  "shared_place"`, naming the others: who goes first, or through, is the organiser's call. A strict table (every rank
 *  once) resolves exactly the rows `rowAtRank` did. A shortfall reads as `rowAtRank`'s, unchanged. `group_rank` and
 *  `best_nth` keep finding by rank (`rowAtRank`). */
function rowAtPosition(table: PoolTable, rank: number): StandingsRow {
  const ordered = [...table.rows].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  const row = ordered[rank - 1];
  if (row === undefined) {
    const available = table.rows.length;
    const label = table.pool ? `pool "${table.pool}"` : "the previous stage";
    throw new EngineError(
      "STAGE_NOT_READY",
      `${label} takes rank ${rank}, but only ${available} entrant${available === 1 ? "" : "s"} ${available === 1 ? "is" : "are"} available — lower the qualifier count or add entrants`,
      { pool: table.pool, rank, available },
    );
  }
  const sharing = ordered.filter((other) => other !== row && other.rank === row.rank).map((other) => other.entrantId);
  if (sharing.length === 0) return row;
  return { ...row, tieUnbroken: true, tieBreak: { key: "shared_place", with: sharing } };
}

/** One pool's candidate compared without the results against its bottom k: the pool's rows minus its expunged entrants
 *  and minus `bottom`, refolded from the results among them. k = 0 (`bottom` empty) is the candidate's own row, as ranked
 *  — its pool's results already exclude any expunged entrant's (`checkExpunged`). */
function normalisedRow(table: PoolTable, candidateId: EntrantId, bottom: readonly EntrantId[]): StandingsRow {
  if (bottom.length === 0) return table.rows.find((row) => row.entrantId === candidateId)!; // rowAtRank found it there
  const left = new Set([...(table.expunged ?? []), ...bottom]);
  const survivors = table.rows.map((row) => row.entrantId).filter((id) => !left.has(id));
  const refolded = foldResults(survivors, resultsAmong(new Set(survivors), table.results ?? []));
  const row = refolded.find((entry) => entry.entrantId === candidateId);
  if (!row) {
    throw new EngineError("STAGE_NOT_READY", `candidate "${candidateId}" not in its pool table`, { candidateId });
  }
  return row;
}

/** RB5-U5: an expunged entrant is one of the pool's rows (else the effective size is wrong) and her results are already
 *  gone from the pool's (else they would still count for everyone). Either is a wiring bug in the caller's builder. */
function checkExpunged(table: PoolTable): void {
  const rows = new Set(table.rows.map((row) => row.entrantId));
  const named = new Set((table.results ?? []).flatMap(([home, away]) => [home.entrantId, away.entrantId]));
  for (const entrantId of table.expunged ?? []) {
    if (!rows.has(entrantId)) {
      throw new EngineError("CONFIG_INVALID", `expunged entrant "${entrantId}" has no row in pool "${table.pool}"`, {
        reason: "expunged_not_in_pool",
        pool: table.pool,
        entrantId,
      });
    }
    if (named.has(entrantId)) {
      throw new EngineError("CONFIG_INVALID", `expunged entrant "${entrantId}" still has results in pool "${table.pool}"`, {
        reason: "expunged_has_results",
        pool: table.pool,
        entrantId,
      });
    }
  }
}

/** A best-Nth comparison: every pool's rank-`nth` row, compared on the smallest pool's matches (W5 RB5-U1, U7; always on,
 *  ruling 286), then ordered by the source's cross-group order (RB5-U2: the sport's own cascade, its seed or stored lots
 *  at the end — ruling 291). Checks, in order: rowAtRank on every pool (a pool short of `nth` rows refuses as before);
 *  each pool's expunged list; the first pool in `pools` order with k > 0 and no results → STAGE_NOT_READY
 *  `pool_results_missing`. */
interface BestNthComparison {
  /** The compared rows in cross-group order — the qualifier order (the ranking that also makes `newLotsDraws`). */
  ordered: StandingsRow[];
  poolOf: Map<EntrantId, string>;
  levelWith: Map<EntrantId, EntrantId[]>;
  matchesCounted: number;
  dropped: { pool: string; against: EntrantId[] }[];
  newLotsDraws: readonly NewLotsDraw[];
}
function compareBestNth(src: SourceTables, nth: number): BestNthComparison {
  const picked = src.pools.map((table) => ({ table, row: rowAtRank(table, nth) }));
  for (const { table } of picked) checkExpunged(table);
  const effective = picked.map(({ table }) => table.rows.length - new Set(table.expunged ?? []).size);
  const min = Math.min(...effective);
  const ks = effective.map((size) => size - min);
  const missing = picked.find(({ table }, i) => ks[i]! > 0 && (table.results ?? []).length === 0);
  if (missing !== undefined) {
    throw new EngineError(
      "STAGE_NOT_READY",
      `pool "${missing.table.pool}" is larger than the smallest pool, and its results are needed to compare its rank-${nth} finisher on the same number of matches`,
      { reason: "pool_results_missing", pool: missing.table.pool },
    );
  }
  const dropped: { pool: string; against: EntrantId[] }[] = [];
  const poolOf = new Map<EntrantId, string>();
  const candidates = picked.map(({ table, row }, i) => {
    const expunged = new Set(table.expunged ?? []);
    const byRank = [...table.rows].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0)).filter((r) => !expunged.has(r.entrantId));
    const bottom = byRank.slice(byRank.length - ks[i]!).map((r) => r.entrantId);
    if (bottom.length > 0) dropped.push({ pool: table.pool, against: bottom });
    poolOf.set(row.entrantId, table.pool);
    return normalisedRow(table, row.entrantId, bottom);
  });
  const rules = src.crossGroup;
  const order = rules?.order ?? PRE_W2D_CROSS_GROUP;
  const ctx = {
    ...(rules?.seeds === undefined ? {} : { seeds: rules.seeds }),
    ...(rules?.rngSeed === undefined ? {} : { rngSeed: rules.rngSeed }),
    ...(rules?.winsCount === undefined ? {} : { winsCount: rules.winsCount }),
  };
  const ranked = crossGroupOrder(candidates, order, rules?.lotsDraws, ctx);
  // G3: the residual classes of the same comparison over rows with their pool trace stripped — a k = 0 row is its pool's
  // own, and a row a key splits keeps the trace it came in with. Its order and draws are the ranking's above, ignored.
  const stripped = candidates.map(({ tieUnbroken: _t, tieBreak: _b, rank: _r, rankLocked: _l, ...row }) => row);
  const levelWith = new Map<EntrantId, EntrantId[]>();
  for (const row of crossGroupOrder(stripped, order, rules?.lotsDraws, ctx).rows) {
    levelWith.set(row.entrantId, row.tieUnbroken === true ? [...(row.tieBreak?.with ?? [])] : []);
  }
  return {
    ordered: ranked.rows,
    poolOf,
    levelWith,
    matchesCounted: Math.max(0, ...candidates.map((row) => row.played)),
    dropped,
    newLotsDraws: ranked.newLotsDraws,
  };
}

/** W2d (spec §5.9, ST-G4, X-TB-7): order rows from DIFFERENT groups by the source stage's `crossGroup` order, with its
 *  stored cross-group draws (`lotsDraws`) and the seeds / winsCount / rngSeed its keys read. No results: the entrants
 *  never met, so the order holds no head-to-head key (refused by name, CONFIG_INVALID — `resolveTableRules` and the
 *  write path already strip or refuse one) and `sberger` compares each row's own SB. A row from an empty pool keeps its
 *  `level` (T5 M4); when every row is level the comparison is an empty table too: seed, then id, and no lots. Returns
 *  the ranked clones (`rank` = cross-group position) and any draw made here, for the caller to store. */
export function crossGroupOrder(
  rows: readonly StandingsRow[],
  crossGroup: readonly TiebreakerKey[],
  lotsDraws: ReadonlyMap<MembersKey, StoredLotsDraw> | undefined,
  ctx: Pick<RankContext, "seeds" | "rngSeed" | "winsCount"> = {},
): RankingResult {
  crossGroup.forEach((key, index) => {
    if (isHeadToHeadKey(key)) {
      throw new EngineError(
        "CONFIG_INVALID",
        `cross-group key "${key}" at position ${index + 1} is a head-to-head step — entrants from different groups never met`,
        { key, index },
      );
    }
  });
  const level = new Set(rows.filter((row) => row.level === true).map((row) => row.entrantId));
  const ranked = rankStandings(rows, {
    cascade: crossGroup,
    ...(level.size === rows.length ? { countedFixtures: 0 } : {}),
    ...(lotsDraws === undefined ? {} : { lotsDraws }),
    ...(ctx.seeds === undefined ? {} : { seeds: ctx.seeds }),
    ...(ctx.rngSeed === undefined ? {} : { rngSeed: ctx.rngSeed }),
    ...(ctx.winsCount === undefined ? {} : { winsCount: ctx.winsCount }),
  });
  for (const row of ranked.rows) if (level.has(row.entrantId)) row.level = true;
  return ranked;
}

function loserAt(bracket: readonly BracketFixtureRow[] | undefined, round: number, position: number): StandingsRow {
  if (!bracket) {
    throw new EngineError("STAGE_NOT_READY", "roundLosers needs the completed stage's bracket fixtures", { round });
  }
  // Equality-filter only — never arithmetic on `round` (rounds number
  // sparsely: 1,2,3 on a winners' side, 7-10 on a losers' side). The
  // filtered array's order IS bracket position; the CALLER that assembled
  // `bracket` is the ordering authority, not this function.
  const losers = bracket.filter(
    (f): f is BracketFixtureRow & { loser: EntrantId } => f.round === round && f.loser !== undefined,
  );
  const row = losers[position - 1];
  if (!row) {
    throw new EngineError(
      "QUALIFICATION_INVALID",
      `bracket round ${round} has no loser at position ${position} (found ${losers.length})`,
      { round, position, available: losers.length },
    );
  }
  return { entrantId: row.loser, rank: position } as StandingsRow;
}

/** W4 (Task 10; RB4-P1, P4): a `first_loss` slot's entrant — position p of the source's first-loss field, in the field's
 *  order. Refused, STAGE_NOT_READY, while the field is still open (`first_loss_field_incomplete`: a first match not yet
 *  played, or no main draw at all, controller ruling B4-2), and when the shape's count is not the field's
 *  (`first_loss_field_changed`: the slots were sized from an earlier field — a corrected result since — so seating them
 *  would drop or invent a plate entrant). */
function firstLossAt(field: FirstLossField, expected: number | undefined, sourceIndex: number, position: number): StandingsRow {
  if (!field.complete) {
    throw new EngineError("STAGE_NOT_READY", `progression source ${sourceIndex}'s first-loss field is not final yet`, {
      reason: "first_loss_field_incomplete",
      sourceIndex,
      pending: [...field.pending],
    });
  }
  if (expected !== field.losers.length) {
    throw new EngineError(
      "STAGE_NOT_READY",
      `progression source ${sourceIndex} was sized for ${expected ?? 0} first losses, but its field now holds ${field.losers.length}`,
      { reason: "first_loss_field_changed", sourceIndex, expected, found: field.losers.length },
    );
  }
  const loss = field.losers[position - 1]!; // position ≤ expected = the field's size, checked just above
  return { entrantId: loss.entrantId, rank: position } as StandingsRow;
}

export function resolveProgression(
  spec: ProgressionSpec,
  shapes: readonly SourceShape[],
  tables: readonly SourceTables[],
  // A2 (round-4 review, MAJOR) — this stage's own raw `kind`, forwarded
  // verbatim to placeDescriptors so ruling 13's bracket-target snake guard
  // can fire on the actual seed-RESOLUTION path, not just at save-time
  // validation (validateProgressionAgainstShapes). OPTIONAL, same "unknown,
  // don't refuse" default as placeDescriptors' own targetKind param (see its
  // doc comment) — an old caller that hasn't been taught to pass one yet
  // does not regress into an always-throwing guard.
  targetKind?: string,
): {
  qualifiers: ResolvedProgressionEntry[];
  ties: ProgressionTieFlag[];
  /** W2d (spec §5.9): the cross-group draws best-Nth made here, by source — for the caller to store under that stage's
   *  "" pool (`crossGroupRulesOf`). Empty when every draw was stored or no tie needed one. */
  newLotsDraws: (NewLotsDraw & { readonly sourceIndex: number })[];
} {
  const pots = expandSources(spec.sources, (i) => shapes[i]!);
  const placed = placeDescriptors(pots, spec.placement, spec.map, targetKind);

  const qualifiers: ResolvedProgressionEntry[] = [];
  const tieGroups = new Map<string, ProgressionTieFlag>();
  const seen = new Set<EntrantId>();
  const bestNthCache = new Map<string, BestNthComparison>();
  const firstLossCache = new Map<number, FirstLossField>();
  const newLotsDraws: (NewLotsDraw & { readonly sourceIndex: number })[] = [];

  placed.forEach((slot, i) => {
    const seed = i + 1;
    const src = tables[slot.sourceIndex];
    if (!src) {
      throw new EngineError("STAGE_NOT_READY", `progression source ${slot.sourceIndex} has no tables yet`, {
        sourceIndex: slot.sourceIndex,
      });
    }
    let row: StandingsRow;
    let pool: string | undefined;
    let basis: ComparisonBasis | undefined;
    const d = slot.descriptor;
    if (d.kind === "group_rank") {
      const table = findPool(src.pools, d.pool);
      row = rowAtRank(table, d.rank);
      pool = table.pool;
    } else if (d.kind === "rank_range") {
      row = rowAtPosition(rankRangeSource(src.pools), d.rank);
    } else if (d.kind === "round_loser") {
      row = loserAt(src.bracket, d.round, d.position);
    } else if (d.kind === "first_loss") {
      // Position is the order of first loss, not the plate seed (see SlotDescriptor first_loss; RB4-D10, X-SD-11).
      let field = firstLossCache.get(slot.sourceIndex);
      if (field === undefined) {
        field = firstLossField(src.bracket ?? []);
        firstLossCache.set(slot.sourceIndex, field);
      }
      row = firstLossAt(field, shapes[slot.sourceIndex]?.firstLossCount, slot.sourceIndex, d.position);
    } else {
      // best_nth — every pool's nth-place row, compared together (once per
      // distinct nth), exactly like resolveQualification.bestOfRank used to
      // — never one candidate at a time. The flag is not in the key: since
      // ruling 286 it selects nothing, so two rules at one nth read ONE
      // comparison (and collide on the entrant dedupe below, as two equal
      // rules always did).
      const cacheKey = `${slot.sourceIndex}:${d.nth}`;
      let compared = bestNthCache.get(cacheKey);
      if (!compared) {
        compared = compareBestNth(src, d.nth);
        for (const draw of compared.newLotsDraws) newLotsDraws.push({ sourceIndex: slot.sourceIndex, ...draw });
        bestNthCache.set(cacheKey, compared);
      }
      const candidate = compared.ordered[d.position - 1];
      if (!candidate) {
        throw new EngineError(
          "QUALIFICATION_INVALID",
          `bestNth needs ${d.position} pools with a rank-${d.nth} finisher, found ${compared.ordered.length}`,
          { nth: d.nth, position: d.position },
        );
      }
      row = candidate;
      pool = compared.poolOf.get(candidate.entrantId);
      basis = {
        nth: d.nth,
        matchesCounted: compared.matchesCounted,
        dropped: compared.dropped.map((x) => ({ pool: x.pool, against: [...x.against] })),
        levelWith: [...(compared.levelWith.get(candidate.entrantId) ?? [])],
      };
    }

    if (seen.has(row.entrantId)) {
      throw new EngineError(
        "QUALIFICATION_INVALID",
        `entrant ${row.entrantId} qualifies through more than one source or take rule`,
        { entrantId: row.entrantId },
      );
    }
    seen.add(row.entrantId);

    qualifiers.push({
      seed,
      sourceIndex: slot.sourceIndex,
      descriptor: d,
      entrantId: row.entrantId,
      rank: row.rank ?? 0,
      tieUnbroken: row.tieUnbroken === true,
      ...(pool === undefined ? {} : { pool }),
      ...(basis === undefined ? {} : { basis }),
    });

    if (row.tieUnbroken === true) {
      const group = [row.entrantId, ...(row.tieBreak?.with ?? [])].sort();
      const key = group.join(",");
      const existing = tieGroups.get(key);
      // Push the whole SourcedSlot (sourceIndex + descriptor), not just `d`
      // — see ProgressionTieFlag's own doc comment.
      if (existing) existing.descriptors.push(slot);
      else tieGroups.set(key, { descriptors: [slot], entrantIds: group, reason: row.tieBreak?.key ?? "seed" });
    }
  });

  return { qualifiers, ties: [...tieGroups.values()], newLotsDraws };
}

// W4 (X-FR-1): a finish order as places. An EntrantId list (a table stage's order, a pre-W4 caller) ranks by position,
// i + 1; a FinalPlace list keeps its ranks, a shared place included. Assumptions are guards: a list mixing the two forms,
// or places out of rank order, is a wiring bug (CONFIG_INVALID).
function placesOf(finalRanks: readonly EntrantId[] | readonly FinalPlace[]): FinalPlace[] {
  const items: readonly (EntrantId | FinalPlace)[] = finalRanks;
  const ids = items.filter((item): item is EntrantId => typeof item === "string");
  if (ids.length === items.length) return ids.map((entrantId, i) => ({ entrantId, rank: i + 1 }));
  if (ids.length > 0) {
    throw new EngineError("CONFIG_INVALID", "placementTable: a finish order mixes entrant ids and places", { reason: "mixed_places" });
  }
  const places = items.filter((item): item is FinalPlace => typeof item !== "string");
  places.forEach((place, i) => {
    const previous = places[i - 1];
    if (previous !== undefined && place.rank < previous.rank) {
      throw new EngineError("CONFIG_INVALID", `placementTable: "${place.entrantId}" (rank ${place.rank}) follows rank ${previous.rank}`, {
        reason: "places_out_of_order",
        entrantId: place.entrantId,
      });
    }
  });
  return places.map(({ entrantId, rank }) => ({ entrantId, rank }));
}

// L3/#414 — wraps any finish order as a single-pool PoolTable (from qualification.ts); W4: by place, ties kept.
export function placementTable(finalRanks: readonly EntrantId[] | readonly FinalPlace[]): PoolTable {
  return {
    pool: "",
    rows: placesOf(finalRanks).map(({ entrantId, rank }) => ({
      entrantId,
      played: 0,
      won: 0,
      drawn: 0,
      lost: 0,
      points: 0,
      metrics: {},
      rank,
    })),
  };
}
