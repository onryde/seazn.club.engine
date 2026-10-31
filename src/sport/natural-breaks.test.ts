// R4 sponsors on stream, S1 (spec onryde/seazn.club docs/superpowers/specs/2026-10-27-sponsors-on-stream-design.md §3.1;
// plan decision P1) — `SportModule.naturalBreaks`: the pauses a sport's own events open, which a sponsor card may air in.
//
// Where the expected values come from (never from the rule under test):
//   - WHICH modules declare breaks: spec §3.1, verbatim ("cricket, football, hockey, icehockey, tennis, badminton,
//     tabletennis, volleyball … 3 declare none: boardgame, carrom, generic").
//   - WHICH kinds a module declares, and their sizes: the module's own `naturalBreaks.kinds` (the engine's declaration).
//   - WHEN a kind opens: each sport's laws, restated per sport below as an oracle over the folded states and the event's
//     own payload (the Laws of Cricket 17.1 and 11; IFAB Law 7; FIH Rules of Hockey and IIHF Rules on intervals).
//   - P1 (plan): a minor and a major opened by the same event are one break, the major.
// The events are REAL: the module's own generator (`arbitraryEvent`) and its recorded golden corpus, replayed the way the
// overlay's derived replay folds them (void resolution first, kernel-owned events skipped, `apply` tolerant).
import { describe, expect, it } from "vitest";
import { EngineError } from "../core/errors.ts";
import { isCoreEventType, kernelOwnsEvent, resolveVoids, type EventEnvelope } from "../core/events.ts";
import { mulberry32 } from "../core/rng.ts";
import type { LineupPair } from "../core/types.ts";
import type { CricketState } from "../sports/cricket/cricket.ts";
import { PLAY_PHASES, type FootballState } from "../sports/football/football.ts";
import { builtinModules } from "../sports/index.ts";
import type { PeriodState } from "../sports/period/kernel.ts";
import { goldenCorpora } from "../testkit/corpora.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { defaultLineupPair, makeEnvelope } from "../testkit/helpers.ts";
import { resolvePositions } from "./catalog.ts";
import type { AnySportModule } from "./module.ts";
import { breakSizeOf, declareNaturalBreaks, type NaturalBreakDecl, type NaturalBreaks } from "./natural-breaks.ts";

/** Spec §3.1: the three modules with no natural pause the engine can see (the scene carousel is their path). */
const SPEC_SILENT = ["boardgame", "carrom", "generic"] as const;
/** Spec §3.1's team sports (S1); the set-based four follow in S2. */
const TEAM_SPORTS = ["cricket", "football", "hockey", "icehockey"] as const;

const SEEDS = 40;
const MAX_EVENTS = 800;
/** In a "live" walk a drawn `core.*` event other than the start is drawn again up to this many times, so play goes deep. */
const REDRAWS = 12;

type AnyBreaks = NaturalBreaks<EventEnvelope, unknown>;

const sport = (key: string): AnySportModule => {
  const m = builtinModules.find((x) => x.key === key);
  if (m === undefined) throw new Error(`no builtin module ${key}`);
  return m;
};

const breaksOf = (m: AnySportModule): AnyBreaks => {
  const nb = m.naturalBreaks as AnyBreaks | undefined;
  if (nb === undefined) throw new Error(`${m.key} declares no naturalBreaks`);
  return nb;
};

interface Ledger {
  readonly m: AnySportModule;
  readonly label: string;
  readonly cfg: unknown;
  readonly lineups: LineupPair;
  readonly events: readonly EventEnvelope[];
}

interface Step {
  readonly ledger: Ledger;
  readonly event: EventEnvelope;
  readonly before: unknown;
  readonly after: unknown;
  readonly opened: readonly string[];
}

/** The configs a sweep plays: every declared one, and each again under its bracket deciders where they change it. */
function cfgsOf(m: AnySportModule): { name: string; cfg: unknown }[] {
  const out: { name: string; cfg: unknown }[] = [];
  for (const { name, cfg } of declaredCfgs(m)) {
    out.push({ name, cfg });
    const bracket = { ...(cfg as object), ...(m.bracketDeciders(cfg) as object) };
    if (JSON.stringify(bracket) !== JSON.stringify(cfg)) out.push({ name: `${name} (bracket)`, cfg: bracket });
  }
  return out;
}

/** One match drawn from the module's own generator. */
function walk(m: AnySportModule, name: string, cfg: unknown, seed: number, live: boolean): Ledger {
  const generate = m.arbitraryEvent;
  if (generate === undefined) throw new Error(`${m.key} has no generator`);
  const lineups = defaultLineupPair(resolvePositions(m, cfg));
  const rng = mulberry32(seed);
  let state: unknown = m.init(cfg, lineups);
  const events: EventEnvelope[] = [];
  for (let i = 0; i < MAX_EVENTS; i++) {
    let drawn = generate.call(m, state, rng);
    for (let r = 0; live && r < REDRAWS && drawn !== null && isCoreEventType(drawn.type) && drawn.type !== "core.start"; r++) {
      drawn = generate.call(m, state, rng);
    }
    if (drawn === null) break;
    const event = makeEnvelope(events.length, drawn);
    if (kernelOwnsEvent(m, event, { state, settled: false })) continue;
    state = m.apply(state, event);
    events.push(event);
  }
  return { m, label: `${m.key} ${name} seed ${seed}${live ? " live" : ""}`, cfg, lineups, events };
}

/** The module's recorded golden corpus, as ledgers. */
function goldenLedgers(m: AnySportModule): Ledger[] {
  const file = goldenCorpora().find((f) => f.key === m.key);
  if (file === undefined) throw new Error(`${m.key} has no golden corpus`);
  const corpus = file.corpus as {
    configs: Record<string, unknown>;
    streams: { config: string; seed: number; lineups?: LineupPair; events: { type: string; payload: unknown; voids?: string }[] }[];
  };
  return corpus.streams.map((stream) => {
    const cfg = m.configSchema.parse(corpus.configs[stream.config]);
    return {
      m,
      label: `${m.key} golden ${stream.config}#${stream.seed}`,
      cfg,
      lineups: stream.lineups ?? defaultLineupPair(resolvePositions(m, cfg)),
      events: stream.events.map((e, i) => makeEnvelope(i, e, e.voids)),
    };
  });
}

/** The replay the overlay runs: voids resolved first, kernel-owned events skipped, every other event applied tolerantly and
 *  asked what it opened. A refusal ends the replay where it stands (the overlay does the same). */
function replay(ledger: Ledger, events: readonly EventEnvelope[] = ledger.events): Step[] {
  const { m } = ledger;
  const nb = m.naturalBreaks as AnyBreaks | undefined;
  let state: unknown = m.init(ledger.cfg, ledger.lineups);
  let settled = false;
  const steps: Step[] = [];
  for (const event of resolveVoids(events)) {
    if (kernelOwnsEvent(m, event, { state, settled })) {
      if (event.type === "core.settle") settled = true;
      continue;
    }
    const before = state;
    try {
      state = m.apply(state, event, { strict: false });
    } catch {
      break;
    }
    steps.push({ ledger, event, before, after: state, opened: nb === undefined ? [] : nb.opensAt(event, before, state) });
  }
  return steps;
}

const memo = new Map<string, { ledgers: Ledger[]; steps: Step[] }>();
/** Every ledger of a module — generator walks (as drawn and live) under every config, then its golden corpus — and their steps. */
function playedOf(m: AnySportModule): { ledgers: Ledger[]; steps: Step[] } {
  const hit = memo.get(m.key);
  if (hit !== undefined) return hit;
  const ledgers: Ledger[] = [];
  for (const { name, cfg } of cfgsOf(m)) {
    for (let seed = 1; seed <= SEEDS; seed++) {
      ledgers.push(walk(m, name, cfg, seed, false), walk(m, name, cfg, seed, true));
    }
  }
  ledgers.push(...goldenLedgers(m));
  const played = { ledgers, steps: ledgers.flatMap((l) => replay(l)) };
  memo.set(m.key, played);
  return played;
}

const declaring = (): AnySportModule[] => builtinModules.filter((m) => m.naturalBreaks !== undefined);

const decidedNow = (step: Step): boolean =>
  step.ledger.m.outcome(step.before) === null && step.ledger.m.outcome(step.after) !== null;

// ---------------------------------------------------------------------------------------------------------------------
// The declaration itself
// ---------------------------------------------------------------------------------------------------------------------

describe("natural breaks: the declaration", () => {
  const KINDS: readonly NaturalBreakDecl[] = [
    { kind: "short", size: "minor" },
    { kind: "other_short", size: "minor" },
    { kind: "long", size: "major" },
  ];
  const ruled = (opened: readonly string[]): AnyBreaks => declareNaturalBreaks<EventEnvelope, unknown>(KINDS, () => opened);
  const ev = makeEnvelope(1, { type: "x.y", payload: {} });

  it("P1: nothing opened is nothing; a minor beside a major is the major only; two minors both stand; a repeat counts once", () => {
    expect(ruled([]).opensAt(ev, {}, {})).toEqual([]);
    expect(ruled(["short", "long"]).opensAt(ev, {}, {})).toEqual(["long"]);
    expect(ruled(["long", "other_short", "short"]).opensAt(ev, {}, {})).toEqual(["long"]);
    expect(ruled(["short", "other_short"]).opensAt(ev, {}, {})).toEqual(["short", "other_short"]);
    expect(ruled(["short", "short"]).opensAt(ev, {}, {})).toEqual(["short"]);
    expect(ruled(["long"]).opensAt(ev, {}, {})).toEqual(["long"]);
  });

  it("a rule that opens a kind it never declared is refused (CONFIG_INVALID), never passed through", () => {
    expect(() => ruled(["nope"]).opensAt(ev, {}, {})).toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }));
    expect(() => ruled(["long", "nope"]).opensAt(ev, {}, {})).toThrow(EngineError);
  });

  it("a declaration with no kind, or one kind twice, is refused", () => {
    expect(() => declareNaturalBreaks([], () => [])).toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }));
    expect(() =>
      declareNaturalBreaks(
        [
          { kind: "a", size: "minor" },
          { kind: "a", size: "major" },
        ],
        () => [],
      ),
    ).toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }));
  });

  it("breakSizeOf throws on an undeclared kind", () => {
    const decl = ruled([]);
    expect(breakSizeOf(decl, "short")).toBe("minor");
    expect(breakSizeOf(decl, "long")).toBe("major");
    expect(() => breakSizeOf(decl, "nope")).toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }));
    expect(() => breakSizeOf(decl, "")).toThrow(EngineError);
    // Every builtin's own kinds answer their own declared size, and no builtin answers a kind it never declared.
    let checked = 0;
    for (const m of declaring()) {
      const nb = breaksOf(m);
      for (const { kind, size } of nb.kinds) {
        expect(breakSizeOf(nb, kind), `${m.key} ${kind}`).toBe(size);
        checked++;
      }
      expect(() => breakSizeOf(nb, "no_such_break"), m.key).toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }));
    }
    expect(checked, `${checked} declared kinds answered across ${declaring().length} modules`).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Every builtin
// ---------------------------------------------------------------------------------------------------------------------

describe("natural breaks: the sport registry", () => {
  it("boardgame, carrom and generic declare no naturalBreaks (the scene carousel is their path)", () => {
    let silent = 0;
    const visited = forEachSport(({ key, module }) => {
      if (!(SPEC_SILENT as readonly string[]).includes(key)) return;
      expect(module.naturalBreaks, key).toBeUndefined();
      silent++;
    });
    expect(visited).toBe(builtinModules.length);
    expect(silent).toBe(SPEC_SILENT.length);
  });

  it("the team sports declare their breaks: cricket, football, hockey and ice hockey (spec §3.1)", () => {
    const keys = declaring().map((m) => m.key);
    for (const key of TEAM_SPORTS) expect(keys, key).toContain(key);
  });

  it("every declared kind is reachable by a real event sequence (forEachSport)", () => {
    const report = { modulesWithBreaks: 0, kindsDeclared: 0, kindsReached: 0, eventsChecked: 0 };
    const unreached: string[] = [];
    forEachSport(({ module }) => {
      if (module.naturalBreaks === undefined) return;
      report.modulesWithBreaks++;
      const { steps } = playedOf(module);
      report.eventsChecked += steps.length;
      const reached = new Set(steps.flatMap((s) => s.opened));
      for (const { kind } of breaksOf(module).kinds) {
        report.kindsDeclared++;
        if (reached.has(kind)) report.kindsReached++;
        else unreached.push(`${module.key}.${kind}`);
      }
    });
    expect(unreached, JSON.stringify(report)).toEqual([]);
    expect(report.modulesWithBreaks, JSON.stringify(report)).toBeGreaterThan(0);
    expect(report.kindsReached, JSON.stringify(report)).toBe(report.kindsDeclared);
    expect(report.eventsChecked, JSON.stringify(report)).toBeGreaterThan(0);
  });

  it("opensAt returns only declared kinds, and never a minor beside a major (P1)", () => {
    let checked = 0;
    let opening = 0;
    for (const m of declaring()) {
      const nb = breaksOf(m);
      const declared = new Map(nb.kinds.map((k) => [k.kind, k.size]));
      for (const step of playedOf(m).steps) {
        checked++;
        if (step.opened.length > 0) opening++;
        for (const kind of step.opened) expect(declared.has(kind), `${step.ledger.label} seq ${step.event.seq}: ${kind}`).toBe(true);
        expect(new Set(step.opened).size, `${step.ledger.label} seq ${step.event.seq}: a kind twice`).toBe(step.opened.length);
        const sizes = new Set(step.opened.map((k) => declared.get(k)));
        expect(sizes.has("major") && sizes.has("minor"), `${step.ledger.label} seq ${step.event.seq}: ${step.opened.join("+")}`).toBe(false);
      }
    }
    expect(checked, `${checked} events checked`).toBeGreaterThan(0);
    expect(opening, `${opening} of ${checked} events opened a break`).toBeGreaterThan(0);
  });

  it("an undo-restored state opens nothing: opensAt(ev, after, before) after an undo returns []", () => {
    let checked = 0;
    for (const m of declaring()) {
      const nb = breaksOf(m);
      for (const step of playedOf(m).steps) {
        if (step.opened.length === 0) continue;
        expect(nb.opensAt(step.event, step.after, step.before), `${step.ledger.label} seq ${step.event.seq}`).toEqual([]);
        checked++;
      }
    }
    expect(checked, `${checked} break-opening events checked backwards`).toBeGreaterThan(0);
  });

  it("a voided break-opening event opens nothing on the replay; recorded again it opens the same kinds, once", () => {
    let checked = 0;
    for (const m of declaring()) {
      // Every kind's first opener in the generator walks (the ledgers there carry no voids of their own).
      const firsts = new Map<string, Step>();
      for (const step of playedOf(m).steps) {
        if (!step.ledger.label.includes("seed")) continue;
        for (const kind of step.opened) if (!firsts.has(kind)) firsts.set(kind, step);
      }
      for (const [kind, step] of firsts) {
        const ledger = step.ledger;
        const upTo = ledger.events.findIndex((e) => e.seq === step.event.seq);
        const prefix = ledger.events.slice(0, upTo + 1);
        const undo = makeEnvelope(prefix.length, { type: "core.void", payload: {} }, step.event.id);
        const undone = replay(ledger, [...prefix, undo]);
        expect(undone.some((s) => s.event.seq === step.event.seq), `${ledger.label}: the voided event is not replayed`).toBe(false);
        expect(undone.flatMap((s) => s.opened), `${m.key}.${kind}: undone`).toEqual(replay(ledger, prefix.slice(0, -1)).flatMap((s) => s.opened));
        // The scorer records it again: a new envelope (new id, next seq), the same play.
        const again = makeEnvelope(prefix.length + 1, { type: step.event.type, payload: step.event.payload });
        const redone = replay(ledger, [...prefix, undo, again]);
        const last = redone[redone.length - 1];
        expect(last?.event.seq, `${m.key}.${kind}: re-recorded event replayed`).toBe(again.seq);
        expect(last?.opened, `${m.key}.${kind}: re-recorded`).toEqual(step.opened);
        expect(redone.filter((s) => s.opened.includes(kind)).length, `${m.key}.${kind}: opened once more, not twice`).toBe(
          undone.filter((s) => s.opened.includes(kind)).length + 1,
        );
        checked++;
      }
    }
    expect(checked, `${checked} kinds undone and re-recorded`).toBeGreaterThan(0);
  });

  it("the match-ending event opens nothing, in every declaring sport", () => {
    const perSport = new Map<string, number>();
    for (const key of TEAM_SPORTS) {
      for (const step of playedOf(sport(key)).steps) {
        if (!decidedNow(step)) continue;
        expect(step.opened, `${step.ledger.label} seq ${step.event.seq} (${step.event.type})`).toEqual([]);
        perSport.set(key, (perSport.get(key) ?? 0) + 1);
      }
    }
    for (const key of TEAM_SPORTS) expect(perSport.get(key) ?? 0, `${key}: match-ending events checked`).toBeGreaterThan(0);
  });

  it("the guard behind it: a break-opening event whose after-state is decided opens nothing (each sport's own outcome)", () => {
    // Synthetic on purpose: no football event both decides the match and scores or closes a period, so the walk above
    // never reaches football's guard. Each real break-opening step is asked again with its after-state carrying a real
    // outcome of the same sport: the declaration's promise is "[] once the match is decided", whatever else moved.
    const perSport = new Map<string, number>();
    for (const key of TEAM_SPORTS) {
      const m = sport(key);
      const nb = breaksOf(m);
      const { steps } = playedOf(m);
      const decided = steps.find(decidedNow);
      if (decided === undefined) throw new Error(`${key}: no match was decided`);
      const outcome = m.outcome(decided.after);
      for (const step of steps) {
        if (step.opened.length === 0) continue;
        const after = { ...(step.after as object), outcome };
        expect(nb.opensAt(step.event, step.before, after), `${step.ledger.label} seq ${step.event.seq}`).toEqual([]);
        perSport.set(key, (perSport.get(key) ?? 0) + 1);
      }
    }
    for (const key of TEAM_SPORTS) expect(perSport.get(key) ?? 0, `${key}: decided break-openers checked`).toBeGreaterThan(0);
  });

  it("opensAt is pure: replaying the same ledger again answers the same breaks at the same events", () => {
    let checked = 0;
    for (const m of declaring()) {
      for (const ledger of playedOf(m).ledgers.slice(0, 60)) {
        const first = replay(ledger).map((s) => [s.event.seq, s.opened]);
        expect(replay(ledger).map((s) => [s.event.seq, s.opened]), ledger.label).toEqual(first);
        checked += first.length;
      }
    }
    expect(checked, `${checked} events replayed twice`).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Per sport: when each kind opens, from the sport's laws
// ---------------------------------------------------------------------------------------------------------------------

/** Tallies each oracle category, so a category no real event reached is a failure rather than a silent pass. */
function categorise(steps: readonly Step[], expected: (step: Step) => { category: string; kinds: readonly string[] }): Map<string, number> {
  const counts = new Map<string, number>();
  for (const step of steps) {
    const { category, kinds } = expected(step);
    expect(step.opened, `${step.ledger.label} seq ${step.event.seq} (${step.event.type}): ${category}`).toEqual(kinds);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return counts;
}

describe("natural breaks: cricket (Laws of Cricket 17.1 the over, 11 intervals)", () => {
  const cricket = sport("cricket");
  const inningsOf = (s: CricketState) => [...s.innings, ...(s.superOver?.innings ?? [])];

  it("cricket: the 6th legal ball of an over opens over_end; the innings' last ball opens innings_break and not over_end", () => {
    const counts = categorise(playedOf(cricket).steps, (step) => {
      const before = step.before as CricketState;
      const after = step.after as CricketState;
      if (decidedNow(step)) return { category: "the match ends", kinds: [] };
      const live = after.outcome === null && (after.phase === "live" || after.phase === "super_over");
      const was = inningsOf(before);
      const now = inningsOf(after);
      const bpo = after.cfg.ballsPerOver;
      const closed = now.some((inn, i) => inn.closed && !(was[i]?.closed ?? false));
      const overDone = now.some((inn, i) => inn.legalBalls > (was[i]?.legalBalls ?? 0) && inn.legalBalls % bpo === 0);
      if (live && closed && overDone) return { category: "an innings closes on an over's last legal ball", kinds: ["innings_break"] };
      if (live && closed) return { category: "an innings closes mid-over", kinds: ["innings_break"] };
      if (live && overDone) return { category: "an over's last legal ball", kinds: ["over_end"] };
      return { category: "anything else", kinds: [] };
    });
    for (const category of [
      "the match ends",
      "an innings closes on an over's last legal ball",
      "an innings closes mid-over",
      "an over's last legal ball",
      "anything else",
    ]) {
      expect(counts.get(category) ?? 0, `${category}: ${JSON.stringify([...counts])}`).toBeGreaterThan(0);
    }
  });

  it("cricket: a delivery that is not legal (a wide, a no-ball) at an over's fifth ball opens nothing; the next legal ball opens over_end", () => {
    let checked = 0;
    let followed = 0;
    const steps = playedOf(cricket).steps;
    steps.forEach((step, k) => {
      const before = inningsOf(step.before as CricketState);
      const after = inningsOf(step.after as CricketState);
      const bpo = (step.after as CricketState).cfg.ballsPerOver;
      const i = after.length - 1;
      const b = before[i];
      const a = after[i];
      if (step.event.type !== "cricket.ball" || b === undefined || a === undefined || a.closed) return;
      if (b.legalBalls % bpo !== bpo - 1 || a.legalBalls !== b.legalBalls) return;
      expect(step.opened, `${step.ledger.label} seq ${step.event.seq}`).toEqual([]);
      checked++;
      // The next event of the same match that adds a legal ball to this innings: the over's last.
      const next = steps.slice(k + 1).find((s) => s.ledger === step.ledger && (inningsOf(s.after as CricketState)[i]?.legalBalls ?? 0) > a.legalBalls);
      if (next === undefined || decidedNow(next)) return;
      const n = inningsOf(next.after as CricketState)[i];
      if (n === undefined || n.closed || n.legalBalls !== a.legalBalls + 1) return;
      expect(next.opened, `${next.ledger.label} seq ${next.event.seq}: the legal ball after the illegal one`).toEqual(["over_end"]);
      followed++;
    });
    expect(checked, `${checked} illegal deliveries at an over's last ball`).toBeGreaterThan(0);
    expect(followed, `${followed} of them followed by the over's last legal ball`).toBeGreaterThan(0);
  });
});

describe("natural breaks: football (IFAB Law 7, the duration of the match)", () => {
  const football = sport("football");

  it("football: half_time at the end of period 1; after_goal on a goal; every other whistle that play continues after opens period_end", () => {
    const counts = categorise(playedOf(football).steps, (step) => {
      const before = step.before as FootballState;
      const after = step.after as FootballState;
      if (decidedNow(step)) return { category: "the match ends", kinds: [] };
      const live = after.outcome === null && (PLAY_PHASES.includes(after.phase) || after.phase === "SHOOTOUT");
      if (live && step.event.type === "football.period") {
        // Law 7.2: the half-time interval is the HT whistle's (in quarters it closes Q2: DOMAIN.md "the real half-time").
        const marker = (step.event.payload as { phase: string }).phase;
        return marker === "HT"
          ? { category: "the half-time whistle", kinds: ["half_time"] }
          : { category: `the ${marker} whistle, play goes on`, kinds: ["period_end"] };
      }
      const goals = (s: FootballState) => s.goals.home + s.goals.away;
      if (live && step.event.type === "football.goal" && goals(after) > goals(before)) return { category: "a goal", kinds: ["after_goal"] };
      return { category: "anything else", kinds: [] };
    });
    for (const category of ["the match ends", "the half-time whistle", "a goal", "anything else"]) {
      expect(counts.get(category) ?? 0, `${category}: ${JSON.stringify([...counts])}`).toBeGreaterThan(0);
    }
    // Quarters (mini-soccer) and the deciders put play on after other whistles: at least one of them is reached.
    const others = [...counts.keys()].filter((c) => c.endsWith("play goes on"));
    expect(others.length, JSON.stringify([...counts])).toBeGreaterThan(0);
  });

  it("football: a goal and the half-time whistle are separate events, so a goal never opens half_time (no goal ends a half)", () => {
    let goals = 0;
    for (const step of playedOf(football).steps) {
      if (step.event.type !== "football.goal") continue;
      expect(step.opened, `${step.ledger.label} seq ${step.event.seq}`).not.toContain("half_time");
      expect((step.after as FootballState).phase, `${step.ledger.label}: a goal moved the phase`).toBe((step.before as FootballState).phase);
      goals++;
    }
    expect(goals, `${goals} goals checked`).toBeGreaterThan(0);
  });
});

describe("natural breaks: hockey and ice hockey (FIH quarters, IIHF periods)", () => {
  // FIH: an interval after the first and third quarters, and the half-time interval after the second. IIHF: an
  // intermission after each period. Play that goes on into an overtime or a shoot-out is after a period end too.
  for (const key of ["hockey", "icehockey"] as const) {
    it(`${key}: an advance that play continues after opens the ${key === "hockey" ? "quarter or half-time" : "period"} break; a goal opens after_goal`, () => {
      const m = sport(key);
      const counts = categorise(playedOf(m).steps, (step) => {
        const before = step.before as PeriodState;
        const after = step.after as PeriodState;
        if (decidedNow(step)) return { category: "the match ends", kinds: [] };
        const live = after.outcome === null && after.phase !== "done" && after.phase !== "abandoned" && after.phase !== "final";
        if (live && step.event.type === `${key}.period.advance` && after.phase !== before.phase) {
          if (key === "icehockey") return { category: `into ${after.phase}`, kinds: ["period_end"] };
          return after.phase === "Q3"
            ? { category: "the half-time whistle", kinds: ["half_time"] }
            : { category: `into ${after.phase}`, kinds: ["quarter_end"] };
        }
        const goals = (s: PeriodState) => s.goals.home + s.goals.away;
        if (live && step.event.type === `${key}.goal` && goals(after) > goals(before)) return { category: "a goal", kinds: ["after_goal"] };
        return { category: "anything else", kinds: [] };
      });
      const want = key === "hockey" ? ["the half-time whistle", "into Q2", "into Q4"] : ["into P2", "into P3"];
      for (const category of ["the match ends", "a goal", "anything else", ...want]) {
        expect(counts.get(category) ?? 0, `${category}: ${JSON.stringify([...counts])}`).toBeGreaterThan(0);
      }
    });
  }
});
