// W5 late entry into a started round robin (rulebook RB5-L3, RB5-L4, RB5-L6, RB5-L16, RB5-E9; rows X-CU-1..5): the pure
// catch-up fixture set. The caller has already chosen the case (RB5-L15: complete → refuse, nothing started → Rebuild,
// otherwise catch-up) and the pool; this computes only which fixtures the newcomer owes and where each one goes.
//
//   owed = {(newcomer, m, leg) : m ∈ members, leg ∈ 1..legs} minus every line already present for that key
//          (roundRobinLineKey: order-free, so a line in either orientation counts).
//   An owed key whose member holds an UNSTARTED bye slot in that leg → that bye's round (`bye_slot`), and the slot is
//   consumed (RB5-L3: a future bye holder's fixture lands in that round). A started bye (the caller's K4 predicate) is
//   never touched: finished rounds are never changed (RB5-L4).
//   Every other owed key → its own catch-up round, lastRoundNo + 1, + 2, … (one fixture per round), ordered by the
//   member's earliest roundNo among `lines` (RB5-L6: the order the opponents already played), ties by the member's
//   position in `members` (the caller lists them in seed order; F5, designer's call), a member with no line after
//   every member with one, then by leg.
//   Home side (RB5-G2): per leg, the newcomer alternates along that leg's owed keys in `members` order, away first in
//   leg 1 and home first in leg 2, and so on, so when every leg owes every member each pair flips between legs and the
//   newcomer's per-leg balance is within 1. A member's own per-leg balance may move by one (plan's call: RB5-G2's
//   bound is a whole-schedule property).
//
// Pure: no input is mutated; consumedByes holds the caller's own slot objects.
import { EngineError } from "../core/errors.ts";
import type { EntrantId } from "../core/types.ts";
import { roundRobinLineKey } from "./roundrobin.ts";

export interface ExistingLine {
  home: EntrantId;
  away: EntrantId;
  roundNo: number;
  leg: number;
}

export interface ByeSlot {
  entrantId: EntrantId;
  roundNo: number;
  leg: number;
  started: boolean; // the caller's K4 predicate: a score event, live play, a decided result, or a call to a court
}

export type CatchUpPlacement = { kind: "bye_slot"; roundNo: number } | { kind: "catch_up_round"; roundNo: number };

export interface CatchUpFixture {
  home: EntrantId;
  away: EntrantId;
  leg: number;
  placement: CatchUpPlacement;
}

export interface CatchUpResult {
  fixtures: CatchUpFixture[]; // by placement roundNo
  consumedByes: ByeSlot[]; // by roundNo
  appendedRounds: number;
}

function refuse(reason: string, message: string): never {
  throw new EngineError("CONFIG_INVALID", message, { reason });
}

interface Owed {
  member: EntrantId;
  memberIndex: number;
  leg: number;
  home: EntrantId;
  away: EntrantId;
}

export function lateEntryFixtures(input: {
  members: readonly EntrantId[] /* in listed (seed) order */;
  newcomer: EntrantId;
  legs: number;
  lines: readonly ExistingLine[];
  byes: readonly ByeSlot[];
  lastRoundNo: number;
}): CatchUpResult {
  const { members, newcomer, legs, lines, byes, lastRoundNo } = input;
  if (members.includes(newcomer)) refuse("newcomer_is_member", `${newcomer} is already a member of this round robin`);
  if (!Number.isInteger(legs) || legs < 1) refuse("legs_invalid", `a round-robin leg count is an integer of at least 1, got ${legs}`);
  for (const line of lines) {
    if (line.roundNo > lastRoundNo) {
      refuse("last_round_below_lines", `a line sits in round ${line.roundNo}, after the last drawn round ${lastRoundNo}`);
    }
  }
  for (const bye of byes) {
    if (bye.roundNo > lastRoundNo) {
      refuse("last_round_below_lines", `a bye sits in round ${bye.roundNo}, after the last drawn round ${lastRoundNo}`);
    }
  }

  const present = new Set(lines.map((l) => roundRobinLineKey(l.home, l.away, l.leg)));
  const earliest = new Map<EntrantId, number>();
  for (const l of lines) {
    for (const id of [l.home, l.away]) {
      const seen = earliest.get(id);
      if (seen === undefined || l.roundNo < seen) earliest.set(id, l.roundNo);
    }
  }

  const owed: Owed[] = [];
  for (let leg = 1; leg <= legs; leg++) {
    const keys = new Set<string>();
    let position = 0;
    members.forEach((member, memberIndex) => {
      const key = roundRobinLineKey(newcomer, member, leg);
      if (present.has(key) || keys.has(key)) return;
      keys.add(key);
      // Away first in leg 1, home first in leg 2, …: alternate along the leg's owed list, flipping by leg.
      const newcomerAway = (position + leg - 1) % 2 === 0;
      position++;
      owed.push({
        member,
        memberIndex,
        leg,
        home: newcomerAway ? member : newcomer,
        away: newcomerAway ? newcomer : member,
      });
    });
  }
  // RB5-E9: a placement that adds no fixture (no members, or already seated against every one) is a named refusal, never an
  // empty success.
  if (owed.length === 0) refuse("nothing_to_add", `${newcomer} owes no fixture: no member, or already seated against every one`);

  const fixtures: CatchUpFixture[] = [];
  const consumedByes: ByeSlot[] = [];
  const toAppend: Owed[] = [];
  for (const o of owed) {
    const slot = byes.find((b) => !b.started && b.entrantId === o.member && b.leg === o.leg);
    if (slot === undefined) {
      toAppend.push(o);
      continue;
    }
    consumedByes.push(slot);
    fixtures.push({ home: o.home, away: o.away, leg: o.leg, placement: { kind: "bye_slot", roundNo: slot.roundNo } });
  }

  const firstRound = (o: Owed): number => earliest.get(o.member) ?? Number.POSITIVE_INFINITY;
  toAppend.sort((x, y) => firstRound(x) - firstRound(y) || x.memberIndex - y.memberIndex || x.leg - y.leg);
  toAppend.forEach((o, k) => {
    fixtures.push({
      home: o.home,
      away: o.away,
      leg: o.leg,
      placement: { kind: "catch_up_round", roundNo: lastRoundNo + k + 1 },
    });
  });

  fixtures.sort((x, y) => x.placement.roundNo - y.placement.roundNo);
  consumedByes.sort((x, y) => x.roundNo - y.roundNo);
  return { fixtures, consumedByes, appendedRounds: toAppend.length };
}
