// F-R3 (controller ruling 157; owner 2026-11-11, "Apply rec") — Law 3's extra-time substitution allowance, `cfg.extraTimeSubs`.
//
// Found by the phone's replay of the 2022 World Cup final through the engine: under `maxSubs: 5`, `subWindows: 3` and
// `concussionSubs: 1`, with extra time on, Pezzella (116') was refused SUB_WINDOW_EXCEEDED and Dybala and Disasi (120+1')
// `sub-cap-reached`. Law 3: a competition that allows extra time may permit one additional substitution, and one additional
// substitution opportunity, in extra time, whether or not the team has used its full allowance. Substitutions in the break
// before extra time and at its half-time use no window, which the fold already says: an unstamped substitution is in none.
import { describe, expect, it } from "vitest";
import { EngineError } from "../../core/errors.ts";
import { foldMatch, foldMatchWithStoppage, type EventEnvelope } from "../../core/events.ts";
import type { Lineup, LineupPair } from "../../core/types.ts";
import { footballPadRules } from "../../pad/football.ts";
import { lineupFromCatalog, makeEnvelope } from "../../testkit/index.ts";
import { effectiveSubCaps, football, subWindowsCap, type FootballCfg } from "./football.ts";

// A catalog-valid XI plus a seven-man bench: enough for six ordinary substitutions and a concussion replacement.
function lineupWithBench(entrantId: string, benchSize = 7): Lineup {
  const base = lineupFromCatalog(football.positions, entrantId);
  return {
    ...base,
    slots: [
      ...base.slots,
      ...Array.from({ length: benchSize }, (_, i) => ({ personId: `${entrantId}-b${i + 1}`, slot: "bench" as const, orderNo: 12 + i })),
    ],
  };
}
const lineups: LineupPair = { home: lineupWithBench("H"), away: lineupWithBench("A") };
const cfgOf = (raw: unknown): FootballCfg => football.configSchema.parse(raw);
// Every stream is a scorer entering events: the write path, where a cfg-derived refusal exists (§3.3).
const STRICT = { strictFromSeq: 0 } as const;
const at = (period: string, elapsed: number) => ({ period, elapsed });

type Spec = [type: string, payload?: unknown];
const stream = (...specs: Spec[]): EventEnvelope[] => specs.map(([type, payload], i) => makeEnvelope(i, { type, payload: payload ?? {} }));
const sub = (off: string, on: string, stamp?: unknown, by = "H"): Spec => [
  "football.sub",
  { by, off, on, ...(stamp === undefined ? {} : { at: stamp }) },
];
const kernelSub = (off: string, on: string): Spec => [
  "core.lineup.substitution",
  { side: "H", off, on: { personId: on, slot: "bench" as const, orderNo: 30 } },
];
const concussion = (off: string, on: string, side = "H"): Spec => [
  "core.lineup.replacement",
  { side, off, on: { personId: on, slot: "bench" as const, orderNo: 31 }, exemption: "concussion" },
];
const period = (marker: string): Spec => ["football.period", { phase: marker }];

/** The 2022 final's competition: five substitutions in three windows, one concussion replacement, extra time and the kicks. */
const SENIOR = { maxSubs: 5, subWindows: 3, concussionSubs: 1, extraTime: { enabled: true, halfMinutes: 15 }, shootout: true };
const LAW3 = { ...SENIOR, extraTimeSubs: { subs: 1, windows: 1 } };

/** Five substitutions in three stamped windows in regulation (the full allowance), then a level whistle: the match is in ET_H1. */
const regulation: Spec[] = [
  ["core.start"],
  sub("H-p2", "H-b1", at("H1", 2400)),
  sub("H-p3", "H-b2", at("H1", 2400)),
  period("HT"),
  sub("H-p4", "H-b3", at("H2", 600)),
  sub("H-p5", "H-b4", at("H2", 600)),
  sub("H-p6", "H-b5", at("H2", 1500)),
  period("FT"),
];

const refusal = (run: () => unknown): EngineError => {
  try {
    run();
  } catch (error) {
    if (error instanceof EngineError) return error;
    throw error;
  }
  return expect.unreachable("the fold must refuse it");
};

describe("FB-SU-3: effectiveSubCaps (F-R3): the caps in force in a phase", () => {
  const cfg = cfgOf(LAW3);

  it("before extra time, the caps are the cfg's own: 5 and 3", () => {
    for (const phase of ["pre", "H1", "H2", "Q2", "Q4"]) {
      expect(effectiveSubCaps(cfg, phase), phase).toEqual({ maxSubs: 5, subWindows: 3 });
    }
  });

  it("from extra time on, each is raised by extraTimeSubs: 6 and 4", () => {
    for (const phase of ["ET_H1", "ET_H2", "SHOOTOUT"]) {
      expect(effectiveSubCaps(cfg, phase), phase).toEqual({ maxSubs: 6, subWindows: 4 });
    }
  });

  it("a shoot-out with no extra time before it is not extra time", () => {
    const noEt = cfgOf({ ...LAW3, extraTime: { enabled: false, halfMinutes: 15 } });
    expect(effectiveSubCaps(noEt, "SHOOTOUT")).toEqual({ maxSubs: 5, subWindows: 3 });
  });

  it("absent extraTimeSubs leaves the caps unchanged in extra time", () => {
    expect(effectiveSubCaps(cfgOf(SENIOR), "ET_H2")).toEqual({ maxSubs: 5, subWindows: 3 });
  });

  it("raises only a declared base cap: an uncapped side stays uncapped", () => {
    expect(effectiveSubCaps(cfgOf({ ...LAW3, maxSubs: undefined }), "ET_H1")).toEqual({ maxSubs: undefined, subWindows: 4 });
    expect(effectiveSubCaps(cfgOf({ ...LAW3, subWindows: undefined }), "ET_H1")).toEqual({ maxSubs: 6, subWindows: undefined });
  });

  it("subWindowsCap and the pad's read the same: before extra time with no phase, raised in extra time", () => {
    expect(subWindowsCap(cfg)).toBe(3);
    expect(subWindowsCap(cfg, "ET_H1")).toBe(4);
    expect(footballPadRules.subWindowsCap(LAW3)).toBe(3);
    expect(footballPadRules.subWindowsCap(LAW3, "H2")).toBe(3);
    expect(footballPadRules.subWindowsCap(LAW3, "ET_H2")).toBe(4);
    expect(footballPadRules.subWindowsCap(SENIOR, "ET_H2")).toBe(3);
  });
});

describe("FB-SU-3: absent extraTimeSubs: extra time refuses exactly as before", () => {
  it("refuses the 6th substitution in extra time (sub-cap-reached)", () => {
    const error = refusal(() => foldMatch(football, cfgOf(SENIOR), lineups, stream(...regulation, sub("H-p7", "H-b6")), STRICT));
    expect(error.code).toBe("INVALID_EVENT");
    expect(error.data).toMatchObject({ reason: "sub-cap-reached" });
  });

  it("refuses a 4th window in extra time (SUB_WINDOW_EXCEEDED)", () => {
    // maxSubs off, so the window is the only bound in play.
    const error = refusal(() =>
      foldMatch(football, cfgOf({ ...SENIOR, maxSubs: undefined }), lineups, stream(...regulation, sub("H-p7", "H-b6", at("ET_H1", 300))), STRICT),
    );
    expect(error.code).toBe("SUB_WINDOW_EXCEEDED");
  });
});

describe("FB-SU-3: extraTimeSubs {subs: 1, windows: 1}", () => {
  const cfg = cfgOf(LAW3);

  it("before extra time the caps are 5 and 3: a 6th sub and a 4th window in H2 are refused", () => {
    const early: Spec[] = regulation.slice(0, -1); // still in H2, five used in three windows
    const sixth = refusal(() => foldMatch(football, cfg, lineups, stream(...early, sub("H-p7", "H-b6")), STRICT));
    expect(sixth.data).toMatchObject({ reason: "sub-cap-reached" });
    const uncapped = cfgOf({ ...LAW3, maxSubs: undefined });
    const fourth = refusal(() => foldMatch(football, uncapped, lineups, stream(...early, sub("H-p7", "H-b6", at("H2", 2000))), STRICT));
    expect(fourth.code).toBe("SUB_WINDOW_EXCEEDED");
  });

  it("accepts a 6th substitution in ET_H1 and refuses a 7th", () => {
    const sixth = stream(...regulation, sub("H-p7", "H-b6", at("ET_H1", 300)));
    const state = foldMatch(football, cfg, lineups, sixth, STRICT);
    expect(state.phase).toBe("ET_H1");
    expect(state.squads.home.offUsed).toHaveLength(6);
    expect(state.squads.home.onPitch).toContain("H-b6");

    const seventh = refusal(() => foldMatch(football, cfg, lineups, stream(...regulation, sub("H-p7", "H-b6", at("ET_H1", 300)), sub("H-p8", "H-b7", at("ET_H1", 300))), STRICT));
    expect(seventh.data).toMatchObject({ reason: "sub-cap-reached" });
  });

  // The kernel vocabulary, on its own: the kernel's own count is what its cap reads, and a `football.sub` is not in it (football's
  // `squadsForLineup` keeps the kernel's counts), so these streams substitute by `core.lineup.substitution` throughout.
  const kernelRegulation: Spec[] = [
    ["core.start"],
    kernelSub("H-p2", "H-b1"),
    kernelSub("H-p3", "H-b2"),
    period("HT"),
    kernelSub("H-p4", "H-b3"),
    kernelSub("H-p5", "H-b4"),
    kernelSub("H-p6", "H-b5"),
  ];

  it("the kernel vocabulary (core.lineup.substitution): a 6th is refused in H2, accepted in ET_H1, and a 7th refused", () => {
    const early = refusal(() => foldMatch(football, cfg, lineups, stream(...kernelRegulation, kernelSub("H-p7", "H-b6")), STRICT));
    expect(early.code).toBe("LINEUP_INVALID");
    expect(early.data).toMatchObject({ reason: "sub-cap-reached" });

    const inEt = stream(...kernelRegulation, period("FT"), kernelSub("H-p7", "H-b6"));
    const { state, squads } = foldMatchWithStoppage(football, cfg, lineups, inEt, STRICT);
    expect(state.phase).toBe("ET_H1");
    expect(squads.home.subsUsed).toBe(6);
    expect(state.squads.home.onPitch).toContain("H-b6");

    const seventh = refusal(() => foldMatch(football, cfg, lineups, stream(...kernelRegulation, period("FT"), kernelSub("H-p7", "H-b6"), kernelSub("H-p8", "H-b7")), STRICT));
    expect(seventh.code).toBe("LINEUP_INVALID");
    expect(seventh.data).toMatchObject({ reason: "sub-cap-reached" });
  });

  it("the kernel vocabulary without extraTimeSubs: the 6th is refused in extra time, as before", () => {
    const error = refusal(() => foldMatch(football, cfgOf(SENIOR), lineups, stream(...kernelRegulation, period("FT"), kernelSub("H-p7", "H-b6")), STRICT));
    expect(error.code).toBe("LINEUP_INVALID");
    expect(error.data).toMatchObject({ reason: "sub-cap-reached" });
  });

  it("accepts a 4th window in extra time and refuses a 5th", () => {
    const uncapped = cfgOf({ ...LAW3, maxSubs: undefined });
    const fourth = stream(...regulation, sub("H-p7", "H-b6", at("ET_H1", 300)));
    expect(foldMatch(football, uncapped, lineups, fourth, STRICT).squads.home.subWindows).toHaveLength(4);
    const fifth = refusal(() =>
      foldMatch(football, uncapped, lineups, stream(...regulation, sub("H-p7", "H-b6", at("ET_H1", 300)), sub("H-p8", "H-b7", at("ET_H1", 600))), STRICT),
    );
    expect(fifth.code).toBe("SUB_WINDOW_EXCEEDED");
    expect(fifth.data).toMatchObject({ subWindows: 4 });
  });

  it("a sub in the break before extra time (unstamped) uses no window and counts towards the sub cap", () => {
    // The final whistle of a level match moves the fold straight to ET_H1: the break has no phase of its own.
    const state = foldMatch(football, cfg, lineups, stream(...regulation, sub("H-p7", "H-b6")), STRICT);
    expect(state.squads.home.subWindows).toHaveLength(3);
    expect(state.squads.home.offUsed).toHaveLength(6);
    // ...so the window it did not use is still there for a stamped one, while the cap it did use is spent.
    const capped = refusal(() => foldMatch(football, cfg, lineups, stream(...regulation, sub("H-p7", "H-b6"), sub("H-p8", "H-b7", at("ET_H1", 300))), STRICT));
    expect(capped.data).toMatchObject({ reason: "sub-cap-reached" });
  });

  it("a concussion replacement is still outside both caps", () => {
    // Six ordinary substitutions in four windows (the extra-time allowance spent), then the concussion replacement.
    const events = stream(...regulation, sub("H-p7", "H-b6", at("ET_H1", 300)), concussion("H-p8", "H-b7"));
    const { squads, state } = foldMatchWithStoppage(football, cfg, lineups, events, STRICT);
    expect(squads.home.exemptUsed).toEqual({ concussion: 1 });
    expect(state.squads.home.offUsed).toHaveLength(7); // six ordinary and the replacement
    expect(state.squads.home.subWindows).toHaveLength(4);
    expect(state.squads.home.onPitch).toContain("H-b7");
  });
});

// ---------------------------------------------------------------------------
// The 2022 World Cup final (Lusail, 18 December 2022), Argentina 3–3 France, Argentina 4–2 on penalties: the replay that found
// F-R3, every substitution as it was made. Stamps are seconds into the period: 41' is H1 2460, 64' is H2 1140, 96' is ET_H1 360,
// 113' is ET_H2 480, 120+1' is ET_H2 960. Argentina's 91' substitution was made in the break before extra time, so it carries no
// stamp. France's 96' substitution is recorded as the concussion replacement, as the replay recorded it.
// ---------------------------------------------------------------------------

const named = (entrantId: string, xi: readonly string[], bench: readonly string[]): Lineup => {
  const base = lineupFromCatalog(football.positions, entrantId);
  return {
    ...base,
    slots: [
      ...base.slots.map((slot, i) => ({ ...slot, personId: xi[i] ?? slot.personId })),
      ...bench.map((personId, i) => ({ personId, slot: "bench" as const, orderNo: 12 + i })),
    ],
  };
};

// The catalog's first slot is the keeper; the rest take the XI in team-sheet order.
const ARG = named(
  "ARG",
  ["E.Martinez", "Molina", "Romero", "Otamendi", "Tagliafico", "De Paul", "Fernandez", "Mac Allister", "Di Maria", "Messi", "Alvarez"],
  ["Acuna", "Montiel", "Paredes", "L.Martinez", "Pezzella", "Dybala"],
);
const FRA = named(
  "FRA",
  ["Lloris", "Kounde", "Varane", "Upamecano", "Hernandez", "Tchouameni", "Rabiot", "Griezmann", "Dembele", "Mbappe", "Giroud"],
  ["Thuram", "Kolo Muani", "Coman", "Camavinga", "Fofana", "Konate", "Disasi"],
);
const FINAL: LineupPair = { home: ARG, away: FRA };

const goal = (by: string, scorer: string, stamp: unknown, penalty = false): Spec => [
  "football.goal",
  { by, scorer, at: stamp, ...(penalty ? { penalty: true } : {}) },
];
const kick = (by: string, person: string, scored: boolean): Spec => ["football.shootout.kick", { by, person, scored }];

const WORLD_CUP_FINAL: Spec[] = [
  ["core.start"],
  goal("ARG", "Messi", at("H1", 1320), true), // 23'
  goal("ARG", "Di Maria", at("H1", 2160)), // 36'
  sub("Giroud", "Thuram", at("H1", 2460), "FRA"), // 41'
  sub("Dembele", "Kolo Muani", at("H1", 2460), "FRA"),
  period("HT"),
  sub("Di Maria", "Acuna", at("H2", 1140), "ARG"), // 64'
  sub("Griezmann", "Coman", at("H2", 1560), "FRA"), // 71'
  sub("Hernandez", "Camavinga", at("H2", 1560), "FRA"),
  goal("FRA", "Mbappe", at("H2", 2100), true), // 80'
  goal("FRA", "Mbappe", at("H2", 2160)), // 81'
  period("FT"),
  sub("Molina", "Montiel", undefined, "ARG"), // 91', the break before extra time
  concussion("Rabiot", "Fofana", "FRA"), // 96'
  sub("De Paul", "Paredes", at("ET_H1", 720), "ARG"), // 102'
  sub("Alvarez", "L.Martinez", at("ET_H1", 720), "ARG"),
  period("ET_HT"),
  goal("ARG", "Messi", at("ET_H2", 180)), // 108'
  sub("Varane", "Konate", at("ET_H2", 480), "FRA"), // 113'
  sub("Mac Allister", "Pezzella", at("ET_H2", 660), "ARG"), // 116'
  goal("FRA", "Mbappe", at("ET_H2", 780), true), // 118'
  sub("Kounde", "Disasi", at("ET_H2", 960), "FRA"), // 120+1'
  sub("Tagliafico", "Dybala", at("ET_H2", 960), "ARG"),
  period("ET_FT"),
  kick("FRA", "Mbappe", true),
  kick("ARG", "Messi", true),
  kick("FRA", "Coman", false),
  kick("ARG", "Dybala", true),
  kick("FRA", "Tchouameni", false),
  kick("ARG", "Paredes", true),
  kick("FRA", "Kolo Muani", true),
  kick("ARG", "Montiel", true),
];

describe("FB-SU-3: the 2022 World Cup final, through the engine (F-R3)", () => {
  it("accepts every substitution under Law 3's extra-time allowance, and Argentina win on penalties", () => {
    const { state, squads } = foldMatchWithStoppage(football, cfgOf(LAW3), FINAL, stream(...WORLD_CUP_FINAL), STRICT);
    expect(state.goals).toEqual({ home: 3, away: 3 });
    expect(state.outcome).toMatchObject({ kind: "win", winner: "ARG", loser: "FRA" });
    // France: 41, 71, 113, 120+1. The 96' concussion replacement is in no window and outside the cap.
    expect(state.squads.away.subWindows).toEqual([at("H1", 2460), at("H2", 1560), at("ET_H2", 480), at("ET_H2", 960)]);
    expect(state.squads.away.offUsed).toHaveLength(7); // six ordinary and the concussion replacement
    expect(squads.away.exemptUsed).toEqual({ concussion: 1 });
    // Argentina: 64, 102, 116, 120+1. The 91' substitution in the break used no window.
    expect(state.squads.home.subWindows).toEqual([at("H2", 1140), at("ET_H1", 720), at("ET_H2", 660), at("ET_H2", 960)]);
    expect(state.squads.home.offUsed).toHaveLength(6);
    expect(state.squads.home.exemptUsed).toBeUndefined();
    expect(state.squads.home.onPitch).toEqual(expect.arrayContaining(["Acuna", "Montiel", "Paredes", "L.Martinez", "Pezzella", "Dybala"]));
    expect(state.squads.away.onPitch).toEqual(expect.arrayContaining(["Thuram", "Kolo Muani", "Coman", "Camavinga", "Fofana", "Konate", "Disasi"]));
  });

  it("without extraTimeSubs, the same final is refused at 120+1': each side's 6th substitution, and Argentina's 4th window", () => {
    const disasi = refusal(() => foldMatch(football, cfgOf(SENIOR), FINAL, stream(...WORLD_CUP_FINAL), STRICT));
    expect(disasi.code).toBe("INVALID_EVENT");
    expect(disasi.data).toMatchObject({ by: "FRA", reason: "sub-cap-reached" });
    const withoutDisasi = WORLD_CUP_FINAL.filter((spec) => (spec[1] as { on?: string } | undefined)?.on !== "Disasi");
    const dybala = refusal(() => foldMatch(football, cfgOf(SENIOR), FINAL, stream(...withoutDisasi), STRICT));
    expect(dybala.data).toMatchObject({ by: "ARG", reason: "sub-cap-reached" });
    // With the 91' substitution unstamped (the break), Pezzella (116') is Argentina's third window and stands; Dybala opens a
    // fourth, which the window cap refuses on its own.
    const windowsOnly = refusal(() => foldMatch(football, cfgOf({ ...SENIOR, maxSubs: undefined }), FINAL, stream(...withoutDisasi), STRICT));
    expect(windowsOnly.code).toBe("SUB_WINDOW_EXCEEDED");
    expect(windowsOnly.data).toMatchObject({ by: "ARG", subWindows: 3, at: at("ET_H2", 960) });
  });
});
