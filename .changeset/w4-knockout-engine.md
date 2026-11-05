---
"@onryde/seazn-engine": major
---

W4 knockout (format matrix): bracket ranks that can tie, a bracket that completes only when every fixture is settled, the title (champion, joint winners, vacant), a third place only behind two real semi-finals, and the first-loss plate feed. Design of record: onryde/seazn.club `docs/superpowers/specs/2026-11-04-format-matrix-w4-knockout-design.md` (rulings 263–275); the rules are in `rules/cross-sport.md`.

- BREAKING: `finalRanks` is `FinalPlace[]` (`{ entrantId, rank }`), not `EntrantId[]`, on `CompletedBracketStage` and on the `stage_completed` `DivisionEvent` of bracket and table stages alike. A table stage ranks by position (rank = index + 1). A bracket stage's ranks may tie, but only at `BRACKET_SHARED_RANKS` (1, 2, 3, 4), and never more than two entrants at one rank. `bracketRanks` returns `FinalPlace[]` too.
- BREAKING: `BracketStage.entrants` is required. It lists every entrant of the stage, including a withdrawn one and one in no fixture, in the order the bracket was drawn with. The ranks cover exactly these entrants, each once.
  - A repeat in the list is CONFIG_INVALID `duplicate_declared_entrant`.
  - Every ranking, provisional or final, passes the structural `assertBracketPlaces`. Each of these is CONFIG_INVALID: a fixture naming an undeclared entrant (`undeclared_entrant`), an entrant ranked twice (`duplicate_entrant`), a rank that is not a positive integer (`rank_not_positive_integer`), ranks out of order (`rank_order`), and a declared entrant left unranked (`missing_entrant`).
- BREAKING: `isBracketStageComplete` is stricter, for every bracket kind. It needs a final, and EVERY fixture settled (decided, void or walkover): the earlier rounds, a third-place play-off and a double-elimination reset alike. The final alone no longer completes a stage. The new `undecidedBracketFixtures` names the fixtures still owed.
- BREAKING: `completeBracketStage` refuses to rank an open bracket.
  - STAGE_NOT_READY `no_final` when no fixture is the final.
  - STAGE_NOT_READY `fixtures_undecided` naming every fixture still owed (`undecided`).
  - CONFIG_INVALID `no_title` when the settled final decided nothing (a void final with no reset after it).
  - It returns the new `title: BracketTitle` beside `finalRanks`.
- BREAKING: at completion `assertCompletedBracketPlaces` holds the ranks to the strict shapes the stage's own fixtures declare: standard competition ranking, plus only the shared places those fixtures allow. `more_than_two`, `not_a_shared_rank`, `undeclared_shared_place` and `not_competition_ranking` are each CONFIG_INVALID there. A provisional read never takes this check.
- BREAKING: `generateSingleElim` refuses a third place without two real semi-finals. `thirdPlace: true` with 2 or 3 entrants is CONFIG_INVALID `third_place_needs_two_semis` (`entrants`, `realSemis`). n = 2 used to drop the request silently, and n = 3 fed the play-off from a bye's absent loser.
- BREAKING: `TakeRule` gains `{ kind: "firstLosses" }`, and `SlotDescriptor` gains `{ kind: "first_loss"; position }` (key `first:<p>`, label `slot.first_loss`). An exhaustive switch over either type needs the new member.
- BREAKING: `placementTable` and `rank_range` keep ties.
  - `placementTable` accepts `FinalPlace[]`; an `EntrantId[]` still ranks by position. A list mixing the two forms is CONFIG_INVALID `mixed_places`, and places out of rank order are CONFIG_INVALID `places_out_of_order`.
  - `rank_range` takes by POSITION. A row whose rank another row shares comes back flagged `tieUnbroken`, with `tieBreak.key: "shared_place"`. A strict table resolves exactly the rows it did before.
  - `group_rank` and `best_nth` still find by rank.
- New: `bracketTitle(fixtures)` is `{ kind: "champion" }`, `{ kind: "joint" }` or `{ kind: "vacant" }`. It is `undefined` while ANY final is unsettled, a pending double-elimination reset included, so no champion is named before the reset is played.
- New: `SourceShape.firstLossCount` is the number of slots a `firstLosses` source expands to. At resolve time a field still open is STAGE_NOT_READY `first_loss_field_incomplete` (`pending`), and a count that differs from the field's size is STAGE_NOT_READY `first_loss_field_changed` (`expected`, `found`).
- New: `firstLossField(rows)` refuses rows it cannot read, each CONFIG_INVALID: `first_loss_row_without_id`, `first_loss_row_without_status` and `first_loss_not_single_elimination` (a losers'-bracket or grand-final row). Rows given with none in round 0 are `first_loss_no_opening_round` (`lowestRound`): `BracketFixture.round` is 0-based, as the generators emit it. No rows at all is no main draw yet (`complete: false`), never refused.
- Shared 3rd by default, so ranks change value: a knockout's two semi-final losers share 3rd (1, 2, 3, 3, then 5 …). Only a decided third-place play-off splits them into 3rd and 4th, and a voided play-off still shares 3rd, never a seed split. A bracket that 3.x ranked by splitting its semi-final losers by seed ranks them level now. Below the semi-finals every rank is strict: elimination round (later first), then seed, then entrant id, each rank `max(previous + 1, placed + 1)`.
- Vacant 3rd: a play-off that neither side played (double walkover) leaves 3rd vacant, and both rank 4th (1, 2, 4, 4, 5 …).
- Joint winners: `BracketFixture.jointWinners`, on a decided final with no winner, no loser and no walkover, ranks both finalists 1st (1, 1, then the 3rd-place block). Set in any other shape (not the final, a seat missing, a winner, loser or walkover recorded, or the final not decided), it throws a plain `Error`: that is a wiring bug.
- Vacant title: a final that both sides walked over ranks both finalists 2nd (2, 2, then the 3rd-place block), with `title: { kind: "vacant" }`.
- Walkovers: a walkover loser is out at that fixture, and so are its onward loser feeds (the third place, page-playoff Q2, the losers' bracket). After a semi-final double walkover, the other semi-final's winner takes the final by walkover and nobody ranks 2nd (1, 3, 4 …).
- Provisional ranks mid-bracket: an entrant still in play ranks above every entrant out, fewest losses first. A void final's seated sides count as still in.
- `firstLossField` (the plate feed) reads everyone's first loss in the main draw. That is round 0, or round 1 for a bye holder or a round-0 walkover winner, never later.
  - Forfeits are excluded: walkover, retirement, disqualification and withdrawal are one engine input, `walkedOver`.
  - Losses are ordered by round, then bracket position, and the field reports whether it is complete. A voided round-0 line waits for nobody.
  - `BracketFixtureRow` gains optional `id`, `status`, `home`, `away`, `winner`, `walkedOver`, `bracket` and `thirdPlace`.
- Stepladder: a seed who left before their rung ranks at that rung (X-SP-4). The rung is read from the draw seeds (`BracketStage.seeds`, by seed order), and only where the rung holds their empty seat. A missing seed, or no seed map, ranks them last, as before; it is never refused.
- Page playoff: an entrant put out by a walkover ranks below one put out by play in the same round (X-SP-5). Every other bracket kind keeps round, then seed, then id.
- Rules: X-SD-3, X-SD-4, X-SD-5, X-TP-4, X-TP-5, X-CH-1, X-CH-7, X-FR-1, X-FR-2, X-FR-3, X-PL-3, X-PL-4, X-SP-1, X-SP-2, X-SP-4, X-SP-5 proved: 16 rows, with their `AWAITING_PROOF` entries removed. The W4 app rows still await proof (37 "W4 app PR A", 17 "W4 app PR B").
- No fold change: no `FOLD_EPOCH` or `FOLD_MINOR` entry moves (`competition/` and `scheduling/` are rank-time, not folded).
