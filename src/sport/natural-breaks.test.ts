// R4 sponsors on stream, S1 + S2 (spec onryde/seazn.club docs/superpowers/specs/2026-10-27-sponsors-on-stream-design.md §3.1;
// plan decision P1) — `SportModule.naturalBreaks`: the pauses a sport's own events open, which a sponsor card may air in.
//
// Where the expected values come from (never from the rule under test):
//   - WHICH modules declare breaks: spec §3.1, verbatim ("cricket, football, hockey, icehockey, tennis, badminton,
//     tabletennis, volleyball … 3 declare none: boardgame, carrom, generic").
//   - WHICH kinds a module declares, and their sizes: the module's own `naturalBreaks.kinds` (the engine's declaration).
//   - WHEN a kind opens: each sport's laws, restated per sport below as an oracle over the folded states and the event's
//     own payload (the Laws of Cricket 17.1 and 11; IFAB Law 7; FIH Rules of Hockey and IIHF Rules on intervals; ITF
//     Rules 10 and 29; BWF Law 16.2; ITTF 3.4.4; FIVB 15 and 18).
//   - P1 (plan): a minor and a major opened by the same event are one break, the major.
// The events are REAL: the module's own generator (`arbitraryEvent`) and its recorded golden corpus, replayed the way the
// overlay's derived replay folds them (void resolution first, kernel-owned events skipped, `apply` tolerant).
import { describe, expect, it } from "vitest";
import { EngineError } from "../core/errors.ts";
import { isCoreEventType, kernelOwnsEvent, resolveVoids, type EventEnvelope } from "../core/events.ts";
import { mulberry32 } from "../core/rng.ts";
import type { LineupPair } from "../core/types.ts";
import type { CricketBallEv, CricketCfg, CricketState } from "../sports/cricket/cricket.ts";
import { PLAY_PHASES, type FootballState } from "../sports/football/football.ts";
import { builtinModules } from "../sports/index.ts";
import { endsChanged, type NestedState } from "../sports/nested/kernel.ts";
import type { PeriodState } from "../sports/period/kernel.ts";
import { setTarget, type SetBasedState } from "../sports/setbased/kernel.ts";
import { goldenCorpora } from "../testkit/corpora.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { defaultLineupPair, makeEnvelope } from "../testkit/helpers.ts";
import { resolvePositions } from "./catalog.ts";
import type { AnySportModule } from "./module.ts";
import { breakSizeOf, declareNaturalBreaks, type NaturalBreakDecl, type NaturalBreaks } from "./natural-breaks.ts";

/** Spec §3.1: the three modules with no natural pause the engine can see (the scene carousel is their path). */
const SPEC_SILENT = ["boardgame", "carrom", "generic"] as const;
/** Spec §3.1: "The MVP makes 8 of the 11 modules declare breaks" — the team sports (S1), then the set-based four (S2). */
const TEAM_SPORTS = ["cricket", "football", "hockey", "icehockey"] as const;
const SET_SPORTS = ["tennis", "badminton", "tabletennis", "volleyball"] as const;
const SPEC_DECLARING = [...TEAM_SPORTS, ...SET_SPORTS] as const;

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

  it("exactly the spec's eight declare their breaks: cricket, football, hockey, ice hockey, tennis, badminton, table tennis, volleyball", () => {
    expect(declaring().map((m) => m.key).sort()).toEqual([...SPEC_DECLARING].sort());
    expect(declaring().length + SPEC_SILENT.length, "every builtin is on one list or the other").toBe(builtinModules.length);
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
    expect(report.modulesWithBreaks, JSON.stringify(report)).toBe(SPEC_DECLARING.length);
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
    for (const key of SPEC_DECLARING) {
      for (const step of playedOf(sport(key)).steps) {
        if (!decidedNow(step)) continue;
        expect(step.opened, `${step.ledger.label} seq ${step.event.seq} (${step.event.type})`).toEqual([]);
        perSport.set(key, (perSport.get(key) ?? 0) + 1);
      }
    }
    for (const key of SPEC_DECLARING) expect(perSport.get(key) ?? 0, `${key}: match-ending events checked`).toBeGreaterThan(0);
  });

  it("the guard behind it: a break-opening event whose after-state is decided opens nothing (each sport's own outcome)", () => {
    // Synthetic on purpose: no football event both decides the match and scores or closes a period, so the walk above
    // never reaches football's guard. Each real break-opening step is asked again with its after-state carrying a real
    // outcome of the same sport: the declaration's promise is "[] once the match is decided", whatever else moved.
    const perSport = new Map<string, number>();
    for (const key of SPEC_DECLARING) {
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
    for (const key of SPEC_DECLARING) expect(perSport.get(key) ?? 0, `${key}: decided break-openers checked`).toBeGreaterThan(0);
  });

  it("the guard's other half: a break-opening event whose after-state is out of play and undecided (not started, abandoned awaiting its ruling) opens nothing", () => {
    // Synthetic, like the test above: no real event both opens a break and leaves play. The out-of-play phases are the
    // sport's own: the phase `init` folds to, and the phase a real `core.abandon` leaves an undecided match in (football
    // and the period sports under `replay`, the set-based sports and tennis always; a cricket abandon always decides).
    const report: Record<string, { phases: string[]; checked: number }> = {};
    for (const key of SPEC_DECLARING) {
      const m = sport(key);
      const nb = breaksOf(m);
      const { ledgers, steps } = playedOf(m);
      const first = ledgers[0];
      if (first === undefined) throw new Error(`${key}: no ledger was played`);
      const phases = new Set([(m.init(first.cfg, first.lineups) as { phase: string }).phase]);
      for (const step of steps) {
        if (step.event.type === "core.abandon" && m.outcome(step.after) === null) phases.add((step.after as { phase: string }).phase);
      }
      let checked = 0;
      for (const phase of phases) {
        for (const step of steps) {
          if (step.opened.length === 0) continue;
          const after = { ...(step.after as object), phase };
          expect(nb.opensAt(step.event, step.before, after), `${step.ledger.label} seq ${step.event.seq} in ${phase}`).toEqual([]);
          checked++;
        }
      }
      report[key] = { phases: [...phases], checked };
    }
    for (const key of SPEC_DECLARING) expect(report[key]?.checked ?? 0, `${key}: ${JSON.stringify(report)}`).toBeGreaterThan(0);
    // Every sport whose abandon can leave the match undecided was asked that phase too, not only the pre-start one.
    for (const key of ["tennis", "badminton", "tabletennis", "volleyball"]) {
      expect(report[key]?.phases, `${key}: ${JSON.stringify(report)}`).toContain("abandoned");
    }
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

  /** The innings the scorebook has closed: an innings break begins when this count moves (Law 11.2). */
  const closedInnings = (s: CricketState) => inningsOf(s).filter((inn) => inn.closed).length;
  /** Law 17.3: a no ball and a wide are not among the over's balls. Read off the delivery's own payload. */
  const legalDelivery = (p: CricketBallEv) => p.runs.extras?.kind !== "wide" && p.runs.extras?.kind !== "noball";
  /** Law 17.1: the delivery the ledger stamps as the over's `ballsPerOver`-th (the CONFIG's), and a legal one, ends it. */
  const endsAnOver = (step: Step) =>
    (step.event.type === "cricket.ball" || step.event.type === "cricket.superover.ball") &&
    legalDelivery(step.event.payload as CricketBallEv) &&
    (step.event.payload as CricketBallEv).ballInOver === (step.ledger.cfg as CricketCfg).ballsPerOver;

  it("cricket: the 6th legal ball of an over opens over_end; the innings' last ball opens innings_break and not over_end", () => {
    const counts = categorise(playedOf(cricket).steps, (step) => {
      if (decidedNow(step)) return { category: "the match ends", kinds: [] };
      const closes = closedInnings(step.after as CricketState) > closedInnings(step.before as CricketState);
      if (closes && endsAnOver(step)) return { category: "an innings closes on an over's last legal ball", kinds: ["innings_break"] };
      if (closes && step.event.type === "cricket.innings.summary") return { category: "a summary closes the innings", kinds: ["innings_break"] };
      if (closes) return { category: "an innings closes mid-over", kinds: ["innings_break"] };
      if (endsAnOver(step)) return { category: "an over's last legal ball", kinds: ["over_end"] };
      // A coarse summary reports overs already bowled: a past over end is not a live pause, wherever its count lands.
      if (step.event.type === "cricket.innings.summary") return { category: "a summary leaves the innings open", kinds: [] };
      return { category: "anything else", kinds: [] };
    });
    for (const category of [
      "the match ends",
      "an innings closes on an over's last legal ball",
      "a summary closes the innings",
      "an innings closes mid-over",
      "an over's last legal ball",
      "a summary leaves the innings open",
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
      if (step.event.type !== "cricket.ball") return;
      const ball = step.event.payload as CricketBallEv;
      if (legalDelivery(ball) || ball.ballInOver !== (step.ledger.cfg as CricketCfg).ballsPerOver || decidedNow(step)) return;
      if (closedInnings(step.after as CricketState) > closedInnings(step.before as CricketState)) return;
      expect(step.opened, `${step.ledger.label} seq ${step.event.seq}`).toEqual([]);
      checked++;
      // The next delivery of the same match: the over's last ball bowled again (Law 17.3: the illegal one is not of the over).
      const next = steps.slice(k + 1).find((s) => s.ledger === step.ledger && s.event.type === "cricket.ball");
      if (next === undefined || decidedNow(next) || !endsAnOver(next)) return;
      if (closedInnings(next.after as CricketState) > closedInnings(next.before as CricketState)) return;
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
        if (marker === "HT") return { category: "the half-time whistle", kinds: ["half_time"] };
        // The kicks from the penalty mark (Law 10.3) follow their own break: one kind across every sport with a shoot-out.
        if (after.phase === "SHOOTOUT") return { category: "into the shoot-out", kinds: ["shootout_break"] };
        return { category: `the ${marker} whistle, play goes on`, kinds: ["period_end"] };
      }
      const goals = (s: FootballState) => s.goals.home + s.goals.away;
      if (live && step.event.type === "football.goal" && goals(after) > goals(before)) return { category: "a goal", kinds: ["after_goal"] };
      return { category: "anything else", kinds: [] };
    });
    for (const category of ["the match ends", "the half-time whistle", "into the shoot-out", "a goal", "anything else"]) {
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
          // FIH's shoot-out and the IIHF's game-winning shots follow their own break, one kind across the sports.
          if (after.phase === "SHOOTOUT") return { category: "into the shoot-out", kinds: ["shootout_break"] };
          if (key === "icehockey") return { category: `into ${after.phase}`, kinds: ["period_end"] };
          return after.phase === "Q3"
            ? { category: "the half-time whistle", kinds: ["half_time"] }
            : { category: `into ${after.phase}`, kinds: ["quarter_end"] };
        }
        const goals = (s: PeriodState) => s.goals.home + s.goals.away;
        if (live && step.event.type === `${key}.goal` && goals(after) > goals(before)) return { category: "a goal", kinds: ["after_goal"] };
        return { category: "anything else", kinds: [] };
      });
      const want = key === "hockey" ? ["the half-time whistle", "into Q2", "into Q4", "into the shoot-out"] : ["into P2", "into P3", "into OT", "into the shoot-out"];
      for (const category of ["the match ends", "a goal", "anything else", ...want]) {
        expect(counts.get(category) ?? 0, `${category}: ${JSON.stringify([...counts])}`).toBeGreaterThan(0);
      }
    });
  }
});

describe("natural breaks: tennis (ITF Rules 10 and 29)", () => {
  const tennis = sport("tennis");
  const games = (s: NestedState) => s.games.home + s.games.away;
  const setsWon = (s: NestedState) => s.setsWon.home + s.setsWon.away;

  it("tennis: an odd game from the third opens changeover; the first game and an even game open nothing; a set's end opens set_end", () => {
    const counts = categorise(playedOf(tennis).steps, (step) => {
      const before = step.before as NestedState;
      const after = step.after as NestedState;
      if (decidedNow(step)) return { category: "the match ends", kinds: [] };
      // Rule 29(a)'s set break: the score shows one more set won.
      if (setsWon(after) > setsWon(before)) return { category: "a set closes", kinds: ["set_end"] };
      // Rule 29(a): play is continuous inside a tie-break, though the players change ends every six points.
      if (before.points.kind !== "standard") return { category: "a tie-break point", kinds: [] };
      // Rule 10 (the kernel's own `endsChanged`, TN-EN-1): the ends change after an odd game. Rule 29(a): the changeover
      // rests up to 90 s, except after the first game of a set.
      const turned = endsChanged(after) && !endsChanged(before);
      if (turned && games(after) === 1) return { category: "a set's first game", kinds: [] };
      if (turned) return { category: "an odd game from the third", kinds: ["changeover"] };
      if (endsChanged(before) && !endsChanged(after)) return { category: "an even game", kinds: [] };
      return { category: "anything else", kinds: [] };
    });
    for (const category of ["the match ends", "a set closes", "a tie-break point", "a set's first game", "an odd game from the third", "an even game", "anything else"]) {
      expect(counts.get(category) ?? 0, `${category}: ${JSON.stringify([...counts])}`).toBeGreaterThan(0);
    }
  });

  it("tennis: a set-winning point opens ['set_end'] once and not changeover, on an odd set (a change of ends too) as on an even one (P1)", () => {
    const perParity = { odd: 0, even: 0 };
    for (const step of playedOf(tennis).steps) {
      const before = step.before as NestedState;
      const after = step.after as NestedState;
      if (step.event.type !== "tennis.point" || after.sets.length <= before.sets.length || decidedNow(step)) continue;
      expect(step.opened, `${step.ledger.label} seq ${step.event.seq}`).toEqual(["set_end"]);
      const set = after.sets[after.sets.length - 1];
      if (set === undefined) throw new Error("a set closed and none is recorded");
      perParity[(set.home + set.away) % 2 === 1 ? "odd" : "even"]++;
    }
    expect(perParity.odd, JSON.stringify(perParity)).toBeGreaterThan(0);
    expect(perParity.even, JSON.stringify(perParity)).toBeGreaterThan(0);
  });

  it("tennis: no point inside a tie-break opens anything (Rule 29(a): play is continuous)", () => {
    let checked = 0;
    for (const step of playedOf(tennis).steps) {
      const before = step.before as NestedState;
      const after = step.after as NestedState;
      if (before.points.kind === "standard" || after.sets.length > before.sets.length || decidedNow(step)) continue;
      expect(step.opened, `${step.ledger.label} seq ${step.event.seq}`).toEqual([]);
      checked++;
    }
    expect(checked, `${checked} tie-break points checked`).toBeGreaterThan(0);
  });
});

describe("natural breaks: badminton, table tennis and volleyball (BWF 16.2, ITTF 3.4.4, FIVB 15 and 18)", () => {
  /** BWF 16.2.1 (DOMAIN.badminton.md BD-IN-1): the interval comes when the leading score reaches half the game's target,
   *  rounded up — 11 in a game to 21. The target is the cfg's, through the fold's own `setTarget`. */
  const intervalMark = (s: SetBasedState, i: number) => Math.ceil(setTarget(s.cfg, i) / 2);
  const lead = (set: { home: number; away: number } | undefined) => (set === undefined ? 0 : Math.max(set.home, set.away));
  const timeouts = (s: SetBasedState) => (s.timeouts?.home ?? 0) + (s.timeouts?.away ?? 0);

  for (const [key, setEnd] of [
    ["badminton", "game_end"],
    ["tabletennis", "game_end"],
    ["volleyball", "set_end"],
  ] as const) {
    it(`${key}: a ${setEnd === "game_end" ? "game" : "set"} that closes opens ${setEnd}; ${key === "badminton" ? "the leading score reaching the mark opens interval" : "a timeout opens timeout"}`, () => {
      const counts = categorise(playedOf(sport(key)).steps, (step) => {
        const before = step.before as SetBasedState;
        const after = step.after as SetBasedState;
        if (decidedNow(step)) return { category: "the match ends", kinds: [] };
        const live = after.outcome === null && after.phase === "live";
        const closed = after.sets.some((set, i) => set.closed && before.sets[i]?.closed !== true);
        const crossed = after.sets.some((set, i) => lead(before.sets[i]) < intervalMark(after, i) && lead(set) >= intervalMark(after, i));
        if (live && closed && key === "badminton" && crossed) return { category: "a game closes past the mark from below it", kinds: [setEnd] };
        if (live && closed) return { category: "a set closes", kinds: [setEnd] };
        if (live && key === "badminton" && crossed) return { category: "the leading score reaches the mark", kinds: ["interval"] };
        if (live && key !== "badminton" && step.event.type === `${key}.timeout` && timeouts(after) > timeouts(before)) {
          return { category: "a timeout", kinds: ["timeout"] };
        }
        return { category: "anything else", kinds: [] };
      });
      const want = key === "badminton" ? ["the leading score reaches the mark"] : ["a timeout"];
      for (const category of ["the match ends", "a set closes", "anything else", ...want]) {
        expect(counts.get(category) ?? 0, `${category}: ${JSON.stringify([...counts])}`).toBeGreaterThan(0);
      }
    });
  }

  it("badminton: reaching 11 in a game to 21 opens interval once a game, and a re-poll fold does not open it twice", () => {
    const badminton = sport("badminton");
    let games = 0;
    let atEleven = 0;
    let repolled = 0;
    for (const ledger of playedOf(badminton).ledgers) {
      const steps = replay(ledger);
      const perGame = new Map<number, number>();
      for (const step of steps) {
        if (!step.opened.includes("interval")) continue;
        const after = step.after as SetBasedState;
        const i = after.sets.findIndex((set, k) => lead((step.before as SetBasedState).sets[k]) < intervalMark(after, k) && lead(set) >= intervalMark(after, k));
        perGame.set(i, (perGame.get(i) ?? 0) + 1);
        // A rally adds one point, so the rally that opens it in a game to 21 lands on 11 itself (BWF 16.2.1).
        if (step.event.type === "badminton.rally" && setTarget(after.cfg, i) === 21) {
          expect(lead(after.sets[i]), `${ledger.label} seq ${step.event.seq}`).toBe(11);
          atEleven++;
        }
      }
      for (const [i, n] of perGame) expect(n, `${ledger.label} game ${i}: interval opened`).toBe(1);
      games += perGame.size;
      // The overlay re-folds the ledger on each poll: every prefix answers the interval at the same event, once.
      const at = steps.filter((s) => s.opened.includes("interval")).map((s) => s.event.seq);
      if (at.length === 0) continue;
      const cut = ledger.events.findIndex((e) => e.seq === at[0]);
      for (const upTo of [cut + 1, cut + 2, ledger.events.length]) {
        const prefix = ledger.events.slice(0, upTo);
        const inside = new Set(prefix.map((e) => e.seq));
        const again = replay(ledger, prefix).filter((s) => s.opened.includes("interval")).map((s) => s.event.seq);
        expect(again, `${ledger.label}: poll at ${upTo}`).toEqual(at.filter((seq) => inside.has(seq)));
        expect(again.length, `${ledger.label}: poll at ${upTo} holds the first interval`).toBeGreaterThan(0);
      }
      repolled++;
    }
    expect(games, `${games} games with an interval`).toBeGreaterThan(0);
    expect(atEleven, `${atEleven} intervals opened by the rally reaching 11`).toBeGreaterThan(0);
    expect(repolled, `${repolled} ledgers re-polled`).toBeGreaterThan(0);
  });

  it("badminton declares no timeout (BWF play has none) and table tennis and volleyball no interval", () => {
    const kinds = (key: string) => breaksOf(sport(key)).kinds.map((k) => k.kind);
    expect(kinds("badminton")).not.toContain("timeout");
    expect(kinds("tabletennis")).not.toContain("interval");
    expect(kinds("volleyball")).not.toContain("interval");
  });
});
