// R4 sponsors on stream (onryde/seazn.club spec 2026-10-27-sponsors-on-stream-design.md §3.1) — a sport's NATURAL BREAKS:
// the pauses in play its own events open (an over's end, half-time, a set's end, a timeout), declared by the sport so the
// overlay can air a sponsor card in one without keeping a table of sports. `SportModule.naturalBreaks` holds one.
//
// Named `naturalBreaks`, not `breaks`: `breaks` is already a stat key (carrom), and "break" is a service break in tennis.
import { EngineError } from "../core/errors.ts";

/** One kind of break a sport declares. `minor` is a short pause (about a minute at most: an over's end, a changeover, a
 *  timeout, the restart after a goal); `major` is an interval (an innings break, half-time, a set's or game's end). */
export interface NaturalBreakDecl {
  kind: string;
  size: "minor" | "major";
}

export interface NaturalBreaks<Ev, State> {
  /** Every kind this sport can open, each once. */
  kinds: readonly NaturalBreakDecl[];
  /** Pure. The kinds this event OPENS, given the state before and after it. [] for most events. P1: never a minor beside a
   *  major (the major is the break). [] when the event ends the match: no play follows it. */
  opensAt(ev: Ev, before: State, after: State): readonly string[];
}

/** The size a declaration gives `kind`. A kind it never declared is refused (CONFIG_INVALID), never read as either size. */
export function breakSizeOf(decl: NaturalBreaks<unknown, unknown>, kind: string): "minor" | "major" {
  const found = decl.kinds.find((k) => k.kind === kind);
  if (found === undefined) {
    throw new EngineError("CONFIG_INVALID", `no natural break "${kind}" is declared`, {
      kind,
      declared: decl.kinds.map((k) => k.kind),
    });
  }
  return found.size;
}

/**
 * A sport's declaration, from its kinds and the rule that says which of them an event opened. The rule states the facts as
 * they are (an innings that closed on an over's last ball closed AND finished an over); this keeps the declaration's two
 * promises over whatever it answers:
 *  - only declared kinds, each once: a kind the sport never declared is refused (`breakSizeOf`), not passed on;
 *  - P1 (plan decision): a minor and a major opened by the same event are one break, the major. The set break holds the
 *    change of ends, the innings break the over's end.
 * A declaration with no kind, or one kind twice, is refused: `breakSizeOf` could not answer it.
 */
export function declareNaturalBreaks<Ev, State>(
  kinds: readonly NaturalBreakDecl[],
  opened: (ev: Ev, before: State, after: State) => readonly string[],
): NaturalBreaks<Ev, State> {
  if (kinds.length === 0) throw new EngineError("CONFIG_INVALID", "a natural-break declaration names no kind", {});
  const seen = new Set<string>();
  for (const { kind } of kinds) {
    if (seen.has(kind)) throw new EngineError("CONFIG_INVALID", `natural break "${kind}" is declared twice`, { kind });
    seen.add(kind);
  }
  const decl: NaturalBreaks<Ev, State> = {
    kinds: Object.freeze(kinds.map(({ kind, size }) => Object.freeze({ kind, size }))),
    opensAt(ev, before, after) {
      const unique = [...new Set(opened(ev, before, after))];
      const majors = unique.filter((kind) => breakSizeOf(decl, kind) === "major");
      return majors.length > 0 ? majors : unique;
    },
  };
  return Object.freeze(decl);
}
