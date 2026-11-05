// Stage state machines — spec 05 §1 (completion), §3 (rank locks), §5
// (division events, withdrawal). PROMPT-08 §1.
import { describe, expect, it } from "vitest";
import type { StandingsDelta } from "../core/types.ts";
import { tableRulesOf as rulesOf } from "../testkit/helpers.ts";
import type { FixtureResult } from "./standings.ts";
import {
  bracketRanks,
  completeBracketStage,
  completeTableStage,
  isBracketStageComplete,
  isTableStageComplete,
  openStage,
  withdrawBracketEntrant,
  withdrawTableEntrant,
  type BracketFixture,
  type BracketStage,
  type FinalPlace,
  type TableFixture,
  type TableStage,
} from "./stage.ts";

/** W4 (X-FR-1): a strict order as places — the i-th id ranks i + 1. */
const places = (...ids: string[]): FinalPlace[] => ids.map((entrantId, i) => ({ entrantId, rank: i + 1 }));

function fb(home: string, away: string, hg: number, ag: number): FixtureResult {
  const draw = hg === ag;
  const homeWon = hg > ag;
  const side = (id: string, gf: number, ga: number, w: number, d: number, l: number, pts: number): StandingsDelta => ({
    entrantId: id,
    played: 1,
    won: w,
    drawn: d,
    lost: l,
    points: pts,
    metrics: { gf, ga, gd: gf - ga },
  });
  return [
    side(home, hg, ag, homeWon ? 1 : 0, draw ? 1 : 0, !draw && !homeWon ? 1 : 0, draw ? 1 : homeWon ? 3 : 0),
    side(away, ag, hg, !draw && !homeWon ? 1 : 0, draw ? 1 : 0, homeWon ? 1 : 0, draw ? 1 : homeWon ? 0 : 3),
  ];
}

// W2d T8: a TableStage carries its TableRules (`rulesOf`); completion ranks by the order alone.
const leagueStage: TableStage = {
  id: "s1",
  kind: "league",
  entrants: ["X", "Y", "Z"],
  rules: rulesOf(["points", "diff", "for", "lots"]),
  rngSeed: 5,
};

describe("openStage", () => {
  it("emits stage_opened", () => {
    expect(openStage("s1")).toEqual([{ type: "stage_opened", stageId: "s1" }]);
  });
});

describe("completion predicates (spec 05 §1)", () => {
  it("league completes only when every fixture is settled", () => {
    const decided: TableFixture[] = [
      { id: "f1", status: "decided", result: fb("X", "Y", 1, 0) },
      { id: "f2", status: "void" },
    ];
    expect(isTableStageComplete(leagueStage, decided)).toBe(true);
    expect(
      isTableStageComplete(leagueStage, [...decided, { id: "f3", status: "scheduled" }]),
    ).toBe(false);
  });

  it("swiss completes when the configured rounds are all played", () => {
    const swiss: TableStage = { ...leagueStage, kind: "swiss", rounds: 2 };
    const fixtures: TableFixture[] = [
      { id: "r1a", roundNo: 1, status: "decided", result: fb("X", "Y", 1, 0) },
      { id: "r2a", roundNo: 2, status: "decided", result: fb("X", "Z", 1, 0) },
    ];
    expect(isTableStageComplete(swiss, fixtures)).toBe(true);
    expect(isTableStageComplete({ ...swiss, rounds: 3 }, fixtures)).toBe(false);
  });

  it("a one-sided award bye counts as a played win on the table", () => {
    // Swiss odd-field sit-out: walkover + awardDelta, no [home,away] pair.
    // Without folding awardDelta the bye winner stays P0/pts=0 while pairing
    // still treats them as having scored — the Gus defect on Swiss 7.
    const swiss: TableStage = {
      id: "sw",
      kind: "swiss",
      swiss: true,
      entrants: ["A", "B", "C"],
      rules: rulesOf(["points", "wins", "lots"]),
      rounds: 1,
      // the bye is an unplayed round, so its art. 16 cap needs D: football stands a draw in a Swiss table, no set score
      swissDraw: { drawReachable: true, setsToWin: undefined },
      swissAbsentRounds: new Map(),
      rngSeed: 1,
    };
    const fixtures: TableFixture[] = [
      { id: "board", roundNo: 1, status: "decided", result: fb("A", "B", 1, 0), unplayed: null },
      {
        id: "bye",
        roundNo: 1,
        status: "walkover",
        awardDelta: {
          entrantId: "C",
          played: 1,
          won: 1,
          drawn: 0,
          lost: 0,
          points: 2,
          metrics: {},
        },
      },
    ];
    const { tables } = completeTableStage(swiss, fixtures);
    const byId = new Map((tables.overall ?? []).map((r) => [r.entrantId, r]));
    expect(byId.get("C")).toMatchObject({ played: 1, won: 1, points: 2 });
    expect(byId.get("A")).toMatchObject({ played: 1, won: 1, points: 3 });
  });

  it("a bracket completes when its final is decided, and not while another fixture is still owed", () => {
    const stage: BracketStage = { id: "ko", kind: "knockout", entrants: ["A", "B", "C", "D"] };
    const semis: BracketFixture[] = [
      { id: "sf1", round: 0, status: "decided", home: "A", away: "B", winner: "A", loser: "B" },
      { id: "fin", round: 1, isFinal: true, status: "scheduled", home: "A", away: "C" },
    ];
    expect(isBracketStageComplete(stage, semis)).toBe(false);
    semis[1] = { ...(semis[1] as BracketFixture), status: "decided", winner: "A", loser: "C" };
    expect(isBracketStageComplete(stage, semis)).toBe(true);
    // CH-1 (RB4-C7, every fixture settled): the same decided final beside a semi-final still scheduled is not complete,
    // and becomes complete once that semi is decided. Before W4 the final alone decided it (true here).
    const openSemi: BracketFixture[] = [...semis, { id: "sf2", round: 0, status: "scheduled", home: "C", away: "D" }];
    expect(isBracketStageComplete(stage, openSemi)).toBe(false);
    openSemi[2] = { ...(openSemi[2] as BracketFixture), status: "decided", winner: "C", loser: "D" };
    expect(isBracketStageComplete(stage, openSemi)).toBe(true);
  });
});

describe("completeTableStage — division events (spec 05 §3/§5)", () => {
  it("emits stage_completed with cross-pool interleaved final ranks", () => {
    const stage: TableStage = {
      id: "grp",
      kind: "group",
      entrants: ["A1", "A2", "B1", "B2"],
      rules: rulesOf(["points", "diff", "for", "lots"]),
    };
    const fixtures: TableFixture[] = [
      { id: "a", poolId: "A", status: "decided", result: fb("A1", "A2", 2, 0) },
      { id: "b", poolId: "B", status: "decided", result: fb("B1", "B2", 3, 0) },
    ];
    const { events, tables } = completeTableStage(stage, fixtures);
    expect(tables.pools.map((p) => p.pool)).toEqual(["A", "B"]);
    // rank-1s first (A1, B1), then rank-2s (A2, B2).
    const completed = events.find((e) => e.type === "stage_completed");
    expect(completed).toEqual({ type: "stage_completed", stageId: "grp", finalRanks: places("A1", "B1", "A2", "B2") });
  });

  it("emits rank_lock_required + rank_lock when the cascade exhausts to lots", () => {
    const fixtures: TableFixture[] = [{ id: "f", status: "decided", result: fb("X", "Y", 1, 1) }];
    const stage: TableStage = { id: "s", kind: "league", entrants: ["X", "Y"], rules: rulesOf(["points", "lots"]), rngSeed: 2 };
    // W2d T5 (spec §5.8, PS-5b): rank_lock carries the STORED draw's order and date, so it needs a stored draw; an
    // unstored one emits rank_lock_required alone and is returned for storing (lots-stored.test.ts owns the rest).
    const { events } = completeTableStage(stage, fixtures);
    expect(events).toContainEqual({ type: "rank_lock_required", stageId: "s", group: ["X", "Y"] });
    expect(events.some((e) => e.type === "rank_lock")).toBe(false);
    const lotsDraws = new Map([["", new Map([["X,Y", { order: ["Y", "X"], drawnAt: "2026-10-24 09:00:00+00" }]])]]);
    const stored = completeTableStage({ ...stage, lotsDraws }, fixtures);
    expect(stored.events).toContainEqual({ type: "rank_lock_required", stageId: "s", group: ["X", "Y"] });
    expect(stored.events).toContainEqual({ type: "rank_lock", stageId: "s", method: "lots", group: ["X", "Y"], order: ["Y", "X"], drawnAt: "2026-10-24 09:00:00+00" });
  });

  it("marks lot-decided rows as rankLocked", () => {
    const fixtures: TableFixture[] = [{ id: "f", status: "decided", result: fb("X", "Y", 2, 2) }];
    const stage: TableStage = { id: "s", kind: "league", entrants: ["X", "Y"], rules: rulesOf(["points", "lots"]), rngSeed: 2 };
    const { tables } = completeTableStage(stage, fixtures);
    expect(tables.overall?.every((r) => r.rankLocked === true)).toBe(true);
  });
});

describe("bracketRanks (spec 05 §1)", () => {
  const stage: BracketStage = { id: "ko", kind: "knockout", entrants: ["S1", "S2", "S3", "S4"], seeds: new Map([["S1", 1], ["S2", 2], ["S3", 3], ["S4", 4]]) };
  const bracket: BracketFixture[] = [
    { id: "sf1", round: 0, status: "decided", home: "S1", away: "S4", winner: "S1", loser: "S4" },
    { id: "sf2", round: 0, status: "decided", home: "S2", away: "S3", winner: "S2", loser: "S3" },
    { id: "fin", round: 1, isFinal: true, status: "decided", home: "S1", away: "S2", winner: "S1", loser: "S2" },
  ];

  it("ranks champion, runner-up, then both semi-final losers level 3rd: no play-off, nobody 4th (SH-3)", () => {
    // ruling 270: was 3/4 by seed
    expect(bracketRanks(stage, bracket)).toEqual([
      { entrantId: "S1", rank: 1 },
      { entrantId: "S2", rank: 2 },
      { entrantId: "S3", rank: 3 },
      { entrantId: "S4", rank: 3 },
    ]);
  });

  it("a 3rd-place playoff fixes ranks 3 and 4 from its result", () => {
    const withThird: BracketFixture[] = [
      ...bracket,
      { id: "3p", round: 1, thirdPlace: true, status: "decided", home: "S3", away: "S4", winner: "S4", loser: "S3" },
    ];
    expect(bracketRanks(stage, withThird)).toEqual(places("S1", "S2", "S4", "S3"));
  });

  it("completeBracketStage emits stage_completed with those ranks", () => {
    const { events, finalRanks } = completeBracketStage(stage, bracket);
    // ruling 270: was 3/4 by seed
    expect(finalRanks).toEqual([
      { entrantId: "S1", rank: 1 },
      { entrantId: "S2", rank: 2 },
      { entrantId: "S3", rank: 3 },
      { entrantId: "S4", rank: 3 },
    ]);
    expect(events).toEqual([{ type: "stage_completed", stageId: "ko", finalRanks }]);
  });
});

// L3/#414 — page_playoff is a NEW BracketStage.kind. bracketRanks branches on
// stage.kind in one place only since W4 (SH-3, ruling 270): a "knockout"'s
// semi-final losers share 3rd. Every other kind — this fixed 4-team IPL-style
// page playoff among them (scheduling/generatePagePlayoff: pp-q1 + pp-elim at
// round 0, pp-q2 feeding from both at round 1, pp-final isFinal at round 2 —
// no thirdPlace fixture) — ranks strictly by round/isFinal/loser. Without
// `"page_playoff"` in BracketStage's kind union this file fails to typecheck
// (TS2322).
describe("bracketRanks — page_playoff (L3/#414, spec 2026-07-19)", () => {
  const stage: BracketStage = {
    id: "pp",
    kind: "page_playoff",
    entrants: ["S1", "S2", "S3", "S4"],
    seeds: new Map([["S1", 1], ["S2", 2], ["S3", 3], ["S4", 4]]),
  };
  // Q1 (major semi) S1 beats S2; Eliminator (minor semi) S3 beats S4; Q2
  // (preliminary final) is an UPSET — S2 (the Q1 loser) beats S3 (the
  // Eliminator winner) for a second life; the Final is S1 over S2.
  const bracket: BracketFixture[] = [
    { id: "pp-q1", round: 0, status: "decided", home: "S1", away: "S2", winner: "S1", loser: "S2" },
    { id: "pp-elim", round: 0, status: "decided", home: "S3", away: "S4", winner: "S3", loser: "S4" },
    { id: "pp-q2", round: 1, status: "decided", home: "S2", away: "S3", winner: "S2", loser: "S3" },
    {
      id: "pp-final",
      round: 2,
      isFinal: true,
      status: "decided",
      home: "S1",
      away: "S2",
      winner: "S1",
      loser: "S2",
    },
  ];

  it("ranks champion, runner-up, the Q2 (2nd-life) loser, then the Eliminator loser", () => {
    // S3 lost the Eliminator (round 0) but got a 2nd life via S2's upset, then
    // lost Q2 (round 1) — later elimination ⇒ ranked above S4, who never got
    // a 2nd life and is out after round 0. No thirdPlace fixture is involved:
    // this is the lastLossRound fallback alone.
    expect(bracketRanks(stage, bracket)).toEqual(places("S1", "S2", "S3", "S4"));
  });

  it("page playoff completes when all four fixtures are settled", () => {
    const open = (id: string): BracketFixture[] =>
      bracket.map((f) => (f.id === id ? { ...f, status: "scheduled" as const, winner: undefined, loser: undefined } : f));
    expect(isBracketStageComplete(stage, open("pp-final"))).toBe(false);
    // RB4-C7 (every fixture settled): the Final decided while any other fixture is still scheduled leaves the stage open.
    // Before W4 the Final alone decided it (true for each of these).
    let opened = 0;
    for (const id of ["pp-q1", "pp-elim", "pp-q2"]) {
      expect(isBracketStageComplete(stage, open(id)), id).toBe(false);
      opened++;
    }
    expect(opened, "non-final fixtures opened").toBe(3);
    expect(isBracketStageComplete(stage, bracket)).toBe(true);
  });

  it("completeBracketStage emits stage_completed with the page_playoff ranks", () => {
    const { events, finalRanks } = completeBracketStage(stage, bracket);
    expect(finalRanks).toEqual(places("S1", "S2", "S3", "S4"));
    expect(events).toEqual([{ type: "stage_completed", stageId: "pp", finalRanks }]);
  });
});

describe("withdrawal policies (spec 05 §5)", () => {
  const stage: TableStage = { id: "s", kind: "league", entrants: ["W", "A", "B", "C"], rules: rulesOf(["points", "lots"]) };

  it("void_remaining EXPUNGES when the entrant has played < 50%", () => {
    const { events, updates } = withdrawTableEntrant(stage, "W", {
      played: [{ id: "p1", status: "decided", result: fb("W", "A", 1, 0) }],
      pending: [
        { id: "p2", opponent: "B" },
        { id: "p3", opponent: "C" },
      ],
    });
    expect(events[0]).toMatchObject({ type: "entrant_withdrawn", entrantId: "W", policy: "void_remaining", mode: "expunge" });
    expect(updates).toEqual([
      { fixtureId: "p1", status: "void" },
      { fixtureId: "p2", status: "void" },
      { fixtureId: "p3", status: "void" },
    ]);
  });

  it("void_remaining AWARDS remaining games when the entrant has played ≥ 50%", () => {
    const { events, updates } = withdrawTableEntrant(stage, "W", {
      played: [
        { id: "p1", status: "decided", result: fb("W", "A", 1, 0) },
        { id: "p2", status: "decided", result: fb("W", "B", 0, 1) },
      ],
      pending: [{ id: "p3", opponent: "C" }],
    });
    expect(events[0]).toMatchObject({ mode: "award" });
    expect(updates).toEqual([{ fixtureId: "p3", status: "walkover", walkoverTo: "C" }]);
  });

  // Owner ruling 2026-09-24 ("case 2", option A): a Swiss withdrawal NEVER
  // expunges. Expunging a Swiss board left it abandoned with no outcome, and
  // the division stranded — Pair next, Unpair and Forfeit all refused it.
  // Every input below expunges in a league; the swiss rows prove the
  // exception, the league/group rows prove it is narrow.
  describe("swiss never expunges; league and group still do under 50%", () => {
    const early = {
      played: [{ id: "p1", status: "decided" as const, result: fb("W", "A", 1, 0) }],
      pending: [
        { id: "p2", opponent: "B" },
        { id: "p3", opponent: "C" },
      ],
    };
    const nothingPlayed = { played: [], pending: [{ id: "p1", opponent: "A" }] };
    const withdraw = (kind: TableStage["kind"], input: Parameters<typeof withdrawTableEntrant>[2]) =>
      withdrawTableEntrant({ ...stage, kind }, "W", input);

    it("swiss, 1 played of 3: the played result stands and both pending boards walk over", () => {
      const { events, updates } = withdraw("swiss", early);
      expect(events[0]).toMatchObject({ type: "entrant_withdrawn", entrantId: "W", mode: "award" });
      expect(updates).toEqual([
        { fixtureId: "p2", status: "walkover", walkoverTo: "B" },
        { fixtureId: "p3", status: "walkover", walkoverTo: "C" },
      ]);
    });

    it("swiss, nothing played and one board paired (the stranded Saturday shape): the board walks over", () => {
      const { events, updates } = withdraw("swiss", nothingPlayed);
      expect(events[0]).toMatchObject({ mode: "award" });
      expect(updates).toEqual([{ fixtureId: "p1", status: "walkover", walkoverTo: "A" }]);
    });

    it.each(["league", "group"] as const)("%s, the same inputs: still expunges", (kind) => {
      const early_ = withdraw(kind, early);
      expect(early_.events[0]).toMatchObject({ mode: "expunge" });
      expect(early_.updates.map((u) => u.status)).toEqual(["void", "void", "void"]);
      expect(withdraw(kind, nothingPlayed).events[0]).toMatchObject({ mode: "expunge" });
    });
  });

  it("bracket_walkover advances the opponent in each pending fixture", () => {
    const koStage: BracketStage = { id: "ko", kind: "knockout", entrants: ["W", "P", "Q"] };
    const fixtures: BracketFixture[] = [
      { id: "qf", round: 0, status: "decided", home: "W", away: "P", winner: "W", loser: "P" },
      { id: "sf", round: 1, status: "scheduled", home: "W", away: "Q" },
    ];
    const { events, updates } = withdrawBracketEntrant(koStage, "W", fixtures);
    expect(events[0]).toMatchObject({ type: "entrant_withdrawn", policy: "bracket_walkover" });
    expect(updates).toEqual([{ fixtureId: "sf", status: "walkover", walkoverTo: "Q" }]);
  });
});
