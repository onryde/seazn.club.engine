// W5 Task 4 (B3) — the table withdrawal decision, proved against the W5 rulebook (rulebook-W5-round-robin.md RB5-W2..W4,
// RB5-W7, RB5-W8; rules/cross-sport.md X-WDT-1..4, X-WDT-6). `withdrawTableEntrant` (stage.ts) reads no SportModule: its
// inputs are the entrant's played fixtures (their results) and its pending ones. The fixtures below are therefore built from
// a sport-free result helper, and X-WDT-6 sweeps the whole sport registry with each module's OWN folded results.
//
// What "played" and "scheduled" mean here is the caller's split (RB5-W4): a voided fixture is handed in neither list, a
// decided or finalized one (finalized is the app's status; the engine sees only a result) is handed in `played`.
import { describe, expect, it } from "vitest";
import { foldMatchWithStoppage, outcomeOf } from "../core/events.ts";
import type { EntrantId, LineupPair, StandingsDelta } from "../core/types.ts";
import { builtinModules } from "../sports/index.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { lineupFromCatalog, makeEnvelope } from "../testkit/helpers.ts";
import {
  withdrawBracketEntrant,
  withdrawTableEntrant,
  type BracketStage,
  type FixtureUpdate,
  type TableFixture,
  type TableStage,
} from "./stage.ts";
import type { FixtureResult } from "./standings.ts";

type Input = Parameters<typeof withdrawTableEntrant>[2];

const W = "W";
const league: Pick<TableStage, "id" | "kind"> = { id: "s", kind: "league" };
const group: Pick<TableStage, "id" | "kind"> = { id: "s", kind: "group" };
const swiss: Pick<TableStage, "id" | "kind"> = { id: "s", kind: "swiss" };

/** A decided result, home beating away; sport-free (the decision reads only the two entrant ids). */
function beat(home: EntrantId, away: EntrantId): FixtureResult {
  const side = (entrantId: EntrantId, won: number): StandingsDelta => ({
    entrantId,
    played: 1,
    won,
    drawn: 0,
    lost: 1 - won,
    points: 3 * won,
    metrics: {},
  });
  return [side(home, 1), side(away, 0)];
}

const OPPONENTS = ["A", "B", "C", "D", "E", "F", "G", "H"] as const;

/** W has played its first `played` opponents (alternately winning and losing) and has `scheduled - played` still to play. */
function scene(played: number, scheduled: number, result: (i: number, opp: EntrantId) => FixtureResult = defaultResult): Input {
  if (played > scheduled || scheduled > OPPONENTS.length) throw new Error(`scene(${played}, ${scheduled}): out of range`);
  return {
    played: OPPONENTS.slice(0, played).map((opp, i) => ({ id: `p-${opp}`, status: "decided", result: result(i, opp) })),
    pending: OPPONENTS.slice(played, scheduled).map((opp) => ({ id: `u-${opp}`, opponent: opp })),
  };
}
function defaultResult(i: number, opp: EntrantId): FixtureResult {
  return i % 2 === 0 ? beat(W, opp) : beat(opp, W);
}

const voids = (...ids: string[]): FixtureUpdate[] => ids.map((fixtureId) => ({ fixtureId, status: "void" }));
const walkovers = (...opps: EntrantId[]): FixtureUpdate[] =>
  opps.map((opp) => ({ fixtureId: `u-${opp}`, status: "walkover", walkoverTo: opp }));

describe("W5 withdrawal decision (RB5-W2..W4, RB5-W7, RB5-W8)", () => {
  // The empty case first: nothing played and nothing pending. 0 of 0 is not "half or more played" (RB5-W3 needs a half
  // of something), so the rule is the expunge branch — with nothing to remove and nothing to void.
  it("empty: nothing played, nothing pending → expunge, no updates, 0 of 0", () => {
    const out = withdrawTableEntrant(league, W, { played: [], pending: [] });
    expect(out.updates).toEqual([]);
    expect(out.events).toEqual([
      { type: "entrant_withdrawn", stageId: "s", entrantId: W, policy: "void_remaining", mode: "expunge", played: 0, scheduled: 0 },
    ]);
  });

  it("X-WDT-1 under half: every played fixture and every pending one is voided", () => {
    // RB5-W2: 2 of 5 = 40 % < half → every result removed and every unplayed fixture voided: 2 + 3 = five voids.
    for (const stage of [league, group]) {
      const out = withdrawTableEntrant(stage, W, scene(2, 5));
      expect(out.events[0], stage.kind).toMatchObject({ mode: "expunge", played: 2, scheduled: 5 });
      expect(out.updates, stage.kind).toEqual(voids("p-A", "p-B", "u-C", "u-D", "u-E"));
      // Never a walkover under half (RB5-W2 "voided, never a walkover").
      expect(out.updates.some((u) => u.status === "walkover"), stage.kind).toBe(false);
    }
  });

  it("X-WDT-2 half or more: results stand, the rest walk over", () => {
    // RB5-W3: 3 of 5 = 60 % ≥ half → the three played results stand (no update names them) and the two unplayed fixtures
    // are walkovers to the opponent each names.
    for (const stage of [league, group]) {
      const out = withdrawTableEntrant(stage, W, scene(3, 5));
      expect(out.events[0], stage.kind).toMatchObject({ mode: "award", played: 3, scheduled: 5 });
      expect(out.updates, stage.kind).toEqual(walkovers("D", "E"));
    }
    // RB5 R5: withdrawal after all their matches → results stand, nothing to void or walk over.
    const done = withdrawTableEntrant(league, W, scene(4, 4));
    expect(done.events[0]).toMatchObject({ mode: "award", played: 4, scheduled: 4 });
    expect(done.updates).toEqual([]);
  });

  describe("X-WDT-3 the half test is strict", () => {
    it("X-WDT-3 exactly half is half or more: 4 of 8 → award; 3 of 8 → expunge", () => {
      // RB5-W3 "Half or more played": 4 / 8 = 0.5 is half → award. RB5-W2 "Under half": 3 / 8 = 0.375 → expunge.
      const half = withdrawTableEntrant(league, W, scene(4, 8));
      expect(half.events[0]).toMatchObject({ mode: "award", played: 4, scheduled: 8 });
      expect(half.updates).toEqual(walkovers("E", "F", "G", "H"));
      const under = withdrawTableEntrant(league, W, scene(3, 8));
      expect(under.events[0]).toMatchObject({ mode: "expunge", played: 3, scheduled: 8 });
      expect(under.updates).toEqual(voids("p-A", "p-B", "p-C", "u-D", "u-E", "u-F", "u-G", "u-H"));
    });

    it("X-WDT-3 a played fixture without the entrant's result is not counted (and not voided)", () => {
      // RB5-W4 counts the ENTRANT's fixtures. W has 2 played + 3 pending = 2 of 5 → expunge. Handed alongside: one decided
      // fixture between two other entrants and one with no result at all. Counting them would read 4 of 7 (≥ half) and
      // award — the differential.
      const base = scene(2, 5);
      const input: Input = {
        played: [
          ...base.played,
          { id: "x-other", status: "decided", result: beat("Y", "Z") },
          { id: "x-none", status: "decided" },
        ],
        pending: base.pending,
      };
      const out = withdrawTableEntrant(league, W, input);
      expect(out.events[0]).toMatchObject({ mode: "expunge", played: 2, scheduled: 5 });
      expect(out.updates).toEqual(voids("p-A", "p-B", "u-C", "u-D", "u-E"));
    });

    it("X-WDT-3 every leg and catch-up fixture counts: the decision reads no round, leg or pool", () => {
      // RB5-W4 "across every leg ..., catch-up fixtures included": 3 played (leg 1 round 1, leg 2 round 9, a catch-up in
      // round 4) + 3 pending (leg 2) = 3 of 6 = half → award. Dropping any one played fixture would read 2 of 5 → expunge.
      const played: TableFixture[] = [
        { id: "leg1-A", roundNo: 1, poolId: "g1", status: "decided", result: beat(W, "A") },
        { id: "leg2-A", roundNo: 9, poolId: "g1", status: "decided", result: beat("A", W) },
        { id: "catchup-B", roundNo: 4, poolId: "g1", status: "decided", result: beat(W, "B") },
      ];
      const pending = [
        { id: "leg2-B", opponent: "B" },
        { id: "leg2-C", opponent: "C" },
        { id: "leg2-D", opponent: "D" },
      ];
      const out = withdrawTableEntrant(group, W, { played, pending });
      expect(out.events[0]).toMatchObject({ mode: "award", played: 3, scheduled: 6 });
      expect(out.updates.map((u) => u.fixtureId)).toEqual(["leg2-B", "leg2-C", "leg2-D"]);
    });
  });

  describe("X-WDT-4 the decision names its rule and counts", () => {
    it("X-WDT-4 under half: the event is the expunge rule with played 2 of scheduled 5", () => {
      // RB5-W7: "Results removed: left after 2 of 5" — the rule (expunge) and both numbers come from this one event.
      const out = withdrawTableEntrant(league, W, scene(2, 5));
      expect(out.events).toEqual([
        { type: "entrant_withdrawn", stageId: "s", entrantId: W, policy: "void_remaining", mode: "expunge", played: 2, scheduled: 5 },
      ]);
    });

    it("X-WDT-4 half or more: the event is the walkover rule with its counts", () => {
      // RB5-W7: "Remaining fixtures walked over" — the award rule; 3 of 5 = 60 % ≥ half (RB5-W3).
      const out = withdrawTableEntrant(league, W, scene(3, 5));
      expect(out.events).toEqual([
        { type: "entrant_withdrawn", stageId: "s", entrantId: W, policy: "void_remaining", mode: "award", played: 3, scheduled: 5 },
      ]);
    });

    it("X-WDT-4 the bracket policy carries neither count", () => {
      const ko: BracketStage = { id: "ko", kind: "knockout", entrants: [W, "P", "Q"] };
      const { events } = withdrawBracketEntrant(ko, W, [
        { id: "qf", round: 0, status: "decided", home: W, away: "P", winner: W, loser: "P" },
        { id: "sf", round: 1, status: "scheduled", home: W, away: "Q" },
      ]);
      expect(events).toEqual([{ type: "entrant_withdrawn", stageId: "ko", entrantId: W, policy: "bracket_walkover" }]);
      const event = events[0] as Record<string, unknown>;
      expect("played" in event).toBe(false);
      expect("scheduled" in event).toBe(false);
      expect("mode" in event).toBe(false);
    });
  });

  it("X-WDT-6 one rule for every sport at 50 percent", () => {
    // RB5-W8 / RB5-W12 (rulings 277, 290): one 50 % rule, every sport, badminton and tennis included — a permanent
    // deviation from BWF GCR 16.2.5. Each module folds its OWN walkover result (core.forfeit before the start, `by` the
    // loser) into its own standings delta pair; the decision is then run on three scenes per sport:
    //   3 of 5 → award.  // differential: today award (stage.ts:1081-1082); BWF/ITTF always-expunge and the FA's 75 percent
    //                    // would expunge (RB5-W8)
    //   3 of 6 → award   (exactly half, RB5-W3)
    //   2 of 5 → expunge (under half, RB5-W2; a never-expunge rule would award)
    const keys: string[] = [];
    let scenes = 0;
    const visited = forEachSport(({ key, module: m }) => {
      const cfg = (declaredCfgs(m as never)[0] as { cfg: unknown }).cfg;
      const beats = (winner: EntrantId, loser: EntrantId): FixtureResult => {
        const lineups: LineupPair = { home: lineupFromCatalog(m.positions, winner), away: lineupFromCatalog(m.positions, loser) };
        const folded = foldMatchWithStoppage(m as never, cfg as never, lineups, [
          makeEnvelope(1, { type: "core.forfeit", payload: { by: loser, reason: "walkover" } }),
        ]);
        const outcome = outcomeOf(m as never, folded as never);
        expect(outcome, key).not.toBeNull();
        const result = m.standingsDelta(outcome as never, cfg, { kind: "league" }, folded.state) as FixtureResult;
        // Guard: the module's own result names both sides, so the decision can find W in it.
        expect([result[0].entrantId, result[1].entrantId], key).toEqual([winner, loser]);
        return result;
      };
      const sportResult = (i: number, opp: EntrantId) => (i % 2 === 0 ? beats(W, opp) : beats(opp, W));
      for (const stage of [league, group]) {
        const sixty = withdrawTableEntrant(stage, W, scene(3, 5, sportResult));
        expect(sixty.events[0], `${key} ${stage.kind} 3/5`).toMatchObject({ mode: "award", played: 3, scheduled: 5 });
        expect(sixty.updates, `${key} ${stage.kind} 3/5`).toEqual(walkovers("D", "E"));
        scenes++;
        const half = withdrawTableEntrant(stage, W, scene(3, 6, sportResult));
        expect(half.events[0], `${key} ${stage.kind} 3/6`).toMatchObject({ mode: "award", played: 3, scheduled: 6 });
        scenes++;
        const under = withdrawTableEntrant(stage, W, scene(2, 5, sportResult));
        expect(under.events[0], `${key} ${stage.kind} 2/5`).toMatchObject({ mode: "expunge", played: 2, scheduled: 5 });
        expect(under.updates, `${key} ${stage.kind} 2/5`).toEqual(voids("p-A", "p-B", "u-C", "u-D", "u-E"));
        scenes++;
      }
      keys.push(key);
    });
    // Anti-vacuity: every registered sport, three scenes on two table kinds each.
    expect(builtinModules.length).toBeGreaterThan(0);
    expect(visited).toBe(builtinModules.length);
    expect(keys).toEqual(builtinModules.map((m) => m.key));
    expect(scenes).toBe(builtinModules.length * 2 * 3);
    // Ruling 290 names these two; neither has its own rule.
    expect(keys).toContain("badminton");
    expect(keys).toContain("tennis");
  });

  it("Swiss: 1 of 5 → award, the pinned exception (EXPUNGES_EARLY_WITHDRAWAL)", () => {
    // Owner ruling 2026-09-24 ("case 2", option A): Swiss never expunges. 1 of 5 = 20 % would expunge a league.
    const out = withdrawTableEntrant(swiss, W, scene(1, 5));
    expect(out.events[0]).toMatchObject({ policy: "void_remaining", mode: "award", played: 1, scheduled: 5 });
    expect(out.updates).toEqual(walkovers("B", "C", "D", "E"));
    expect(withdrawTableEntrant(league, W, scene(1, 5)).events[0]).toMatchObject({ mode: "expunge" });
  });

  describe("sequence", () => {
    it("a second call on the same input returns an equal result and leaves the input untouched", () => {
      const input = scene(2, 5);
      const before = structuredClone(input);
      const first = withdrawTableEntrant(league, W, input);
      const second = withdrawTableEntrant(league, W, input);
      expect(second).toEqual(first);
      expect(input).toEqual(before);
    });

    it("after a void, the voided fixture is in neither list and the counts drop it", () => {
      // RB5-W4 "voided does not" count. 3 of 6 is half → award; one of the three played results is then voided (a match
      // void), so the caller hands 2 played + 3 pending: 2 of 5 → expunge. The decision flips because the count dropped.
      const atHalf = scene(3, 6);
      const out1 = withdrawTableEntrant(league, W, atHalf);
      expect(out1.events[0]).toMatchObject({ mode: "award", played: 3, scheduled: 6 });
      const afterVoid: Input = { played: atHalf.played.filter((f) => f.id !== "p-C"), pending: atHalf.pending };
      const out2 = withdrawTableEntrant(league, W, afterVoid);
      expect(out2.events[0]).toMatchObject({ mode: "expunge", played: 2, scheduled: 5 });
      expect(out2.updates).toEqual(voids("p-A", "p-B", "u-D", "u-E", "u-F"));
    });

    it("after the expunge is applied, a repeat withdrawal finds nothing: 0 of 0, no updates", () => {
      // Every fixture the first call voided is in neither list on the next (RB5-W4), so the second decision is the empty case.
      const first = withdrawTableEntrant(league, W, scene(2, 5));
      expect(first.updates.every((u) => u.status === "void")).toBe(true);
      const again = withdrawTableEntrant(league, W, { played: [], pending: [] });
      expect(again.events[0]).toMatchObject({ mode: "expunge", played: 0, scheduled: 0 });
      expect(again.updates).toEqual([]);
    });
  });
});
