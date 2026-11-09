# @onryde/seazn-engine

## 5.0.0

### Major Changes

- f76f06f: W4 knockout (format matrix): bracket ranks that can tie, a bracket that completes only when every fixture is settled, the title (champion, joint winners, vacant), a third place only behind two real semi-finals, and the first-loss plate feed. Design of record: onryde/seazn.club `docs/superpowers/specs/2026-11-04-format-matrix-w4-knockout-design.md` (rulings 263–275); the rules are in `rules/cross-sport.md`.
  
  - BREAKING: `finalRanks` is `FinalPlace[]` (`{ entrantId, rank }`), not `EntrantId[]`, on `CompletedBracketStage` and on the `stage_completed` `DivisionEvent` of bracket and table stages alike. A table stage ranks by position (rank = index + 1). A bracket stage's ranks may tie, but only at `BRACKET_SHARED_RANKS` (1, 2, 3, 4). At most two entrants share a rank: checked at completion only (`assertCompletedBracketPlaces`). Provisional reads may show more. `bracketRanks` returns `FinalPlace[]` too.
  - BREAKING (testkit): `SimulationResult.finalRanks` and `SimStageRecord.finalRanks` are `FinalPlace[]`, and `SimulationResult.champion` is the entrant ranked 1st (the rank-1 holder), not the first place listed.
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
  - Joint winners: `BracketFixture.jointWinners`, on a decided final with no winner, no loser and no walkover, ranks both finalists 1st (1, 1, then the 3rd-place block). Set in any other shape it is a wiring bug, CONFIG_INVALID with a named reason (and `fixtureId`): `joint_winners_not_final`, `joint_winners_side_missing`, `joint_winners_result_named` (a winner or loser recorded), `joint_winners_walked_over` and `joint_winners_not_decided`.
  - Vacant title: a final that both sides walked over ranks both finalists 2nd (2, 2, then the 3rd-place block), with `title: { kind: "vacant" }`.
  - Walkovers: a walkover loser is out at that fixture, and so are its onward loser feeds (the third place, page-playoff Q2, the losers' bracket). After a semi-final double walkover, the other semi-final's winner takes the final by walkover and nobody ranks 2nd (1, 3, 4 …).
  - Dead-seat attribution: an entrant who withdrew while their next opponent was still to be decided left that seat empty and stamped dead, and the side that arrived walked over it with no loser named. The seat's feed still names them, so the walkover is THEIR loss (`resolveDeadSeats`, read by `bracketRanks`, `assertCompletedBracketPlaces` and `firstLossField`).
    - A withdrawn finalist ranks 2nd. A withdrawn semi-final loser forfeits the play-off and ranks 4th. A winners'-bracket loser who withdrew before their losers'-bracket fixture is out there.
    - In the plate feed, a bye holder or a round-0 walkover winner who withdrew before their round-1 opponent was known is excluded (a forfeit), and the field completes instead of waiting forever.
    - A double walkover over dead seats seats each side its feed names: both lost there, so a final's title is vacant.
    - Mid-bracket, a not-yet-settled fixture's dead seat keeps its fed entrant in play.
    - A feed whose fixture names nobody (a double walkover, a void) attributes nothing. With no feed passed, nothing changes.
  - New: `BracketFixture.homeFrom` / `awayFrom` and `BracketFixtureRow.homeFrom` / `awayFrom`, optional, typed as the generator's `BracketSlotRef`: the fixture whose winner or loser fills each seat. The app must pass them on dead-seat rows. The new `resolveDeadSeats(rows)` is the one reader of them.
  - `BracketFixture.round` is 0-based. Map app rows once (`round_no − 1 − laneOffset`) for EVERY bracket read: ranks, completion, the title and the plate field alike.
  - Provisional ranks mid-bracket: an entrant still in play ranks above every entrant out, fewest losses first. A void final's seated sides count as still in.
  - `firstLossField` (the plate feed) reads everyone's first loss in the main draw. That is round 0, or round 1 for a bye holder or a round-0 walkover winner, never later.
    - Forfeits are excluded: walkover, retirement, disqualification and withdrawal are one engine input, `walkedOver`.
    - Losses are ordered by round, then bracket position, and the field reports whether it is complete. A voided round-0 line waits for nobody.
    - `BracketFixtureRow` gains optional `id`, `status`, `home`, `away`, `winner`, `walkedOver`, `bracket`, `thirdPlace`, `homeFrom` and `awayFrom`.
  - Stepladder: a seed who left before their rung ranks at that rung (X-SP-4). The rung is read from the draw seeds (`BracketStage.seeds`, by seed order), and only where the rung holds their empty seat. A missing seed, or no seed map, ranks them last, as before; it is never refused.
  - Page playoff: an entrant put out by a walkover ranks below one put out by play in the same round (X-SP-5). Every other bracket kind keeps round, then seed, then id.
  - Rules: X-SD-3, X-SD-4, X-SD-5, X-TP-4, X-TP-5, X-CH-1, X-CH-7, X-FR-1, X-FR-2, X-FR-3, X-PL-3, X-PL-4, X-SP-1, X-SP-2, X-SP-4, X-SP-5 proved: 16 rows, with their `AWAITING_PROOF` entries removed. The W4 app rows still await proof (37 "W4 app PR A", 17 "W4 app PR B").
  - No fold change: no `FOLD_EPOCH` or `FOLD_MINOR` entry moves (`competition/` and `scheduling/` are rank-time, not folded).

## 4.0.0

### Major Changes

- f94a767: Cricket, for the S2-4 phone design (onryde/seazn.club.capture `docs/specs/2026-11-07-s2-4-cricket-design.md` §7.3, its rulings 71, 75 and 76). Cricket's fold epoch rises to 3 (FOLD_MINOR back to 0), so the server's 426 gate refuses cricket scoring writes from an epoch-2 client until it updates.
  
  - **Exports (ruling 276; phone ruling 71).** `cricketPadRules` gains `noBallDismissalKinds` and `wideDismissalKinds`, frozen copies of the fold's own sets (CK-NB-1, CK-WD-1), and `@onryde/seazn-engine/sports/cricket` exports `orderFromLineup`, the batting and bowling order the fold builds from a team sheet. Additive.
  - **Hand strike swap (CK-SS-1, ruling 277; phone ruling 76).** On the write path a ball that names exactly the fold's pair reversed (the same two batters, ends swapped) is accepted, with no event of its own. A third batter, or a one-end change outside the unfaced-incoming rule, is still refused. No fold moves: replay already adopted the ledger's pair.
  - **Mid-over bowler change (CK-BC-1, CK-BO-3, ruling 278; phone ruling 75; MCC Law 17.8).** A new event, `cricket.bowler.change` `{ bowler, reason?: "incapacitated" | "suspended" | "other" }`, hands the over in progress to another bowler, who completes it from the same end: later balls of the over name and are credited to them, so each bowler's figures get the balls they bowled. The incoming bowler may not have bowled the previous over or any part of this one; no bowler of a split over may bowl the next (Law 17.7). Each is charged a whole over toward `maxOversPerBowler` for the part, and neither is credited a maiden for it (the scorecard's `OverLog` gains an optional `bowlers` list for a split over). The change is refused with no over in progress, at summary fidelity and in a super over (CK-SO-3), sits at fidelity band 3, is offered by `padSpec` in the Innings drawer (`pad.cricket.action.bowlerChange`) and is dropped by `coarsen`. `FineInnings` gains four optional fields (`overSpells`, `prevOverBowlers`, `partOvers`, `partOverBalls`), absent until a change happens. New exports: `CricketBowlerChange`, `eligibleChangeBowlers`, `oversUsed` and the `OverSpell` type; `eligibleBowlers` now honours a split previous over and part overs. A ball that names another bowler mid-over with no change event is still refused on write and credited to the over's bowler on replay, so no stored ledger is re-credited.
  - Golden: one appended branch stream, cricket `t20#90016` (`cricket.mid_over_bowler_change`), is the epoch-3 witness; no recorded stream moved. `cricket.schema.json` gains the event.

### Patch Changes

- c42a4b7: Rules: the W4 knockout family's signed rules (owner rulings 263–274, 2026-11-04), recorded ahead of the code on the owner's "approve and record all rules in engine" (ruling 274). The design of record is onryde/seazn.club `docs/superpowers/specs/2026-11-04-format-matrix-w4-knockout-design.md`, and the rulebook is `rulebook-W4-knockout.md` beside it.
  
  - 70 new rows in `rules/cross-sport.md`, in nine new areas: X-SD (draw and bracket generation), X-LE (late entry after Start), X-LL (vacated seat and lucky loser), X-PL (plate), X-QM (qualifying → main), X-TP (third place), X-CH (champion, joint winners, vacant title), X-FR (final ranks and history) and X-SP (stepladder and page playoff). Each row cites its W4 rulebook id (RB4-…). X-SD-4 is a recorded deviation (ruling 268: seeds stay on the fold, where BWF and ITF place seed bands by lot).
  - No row claims proof yet. Each new row has `proved by` `—` and an `AWAITING_PROOF` entry naming the W4 PR whose test proves it: 14 the W4 engine PR, 39 W4 app PR A, 17 W4 app PR B. Its citation says the same ("not yet implemented", or "proof owed" where an existing path already enforces it).
  - Two existing rows are amended in text and citation only, and keep their ids and statuses. In X-DW-3 and CK-KO-1, the hand-off "is W4" now points at the rows ruling 267 made (X-CH-3, X-CH-4, X-CH-6, X-TP-7).
  - Club separation (RB4-D7, RB4-D8, RB4-E8) is deferred by ruling 272 and has no row.
  - Text and checker data only: no code, export or fold table moves.

## 3.0.2

### Patch Changes

- a39bb86: Rules: X-SW-16 (`rules/cross-sport.md`) follows Format onto the Division rules card (onryde/seazn.club 58ad2c093c moved it off Settings). The row's proof and implementation paths named files that commit deleted or emptied of Swiss round code.
  
  - Enforced at: `apps/web/src/components/v2/rules/division-format.tsx` replaces `apps/web/src/components/v2/division-settings.tsx`, which no longer holds any Swiss round-count code.
  - Proved by: `apps/web/src/components/v2/rules/__tests__/division-format.test.tsx` replaces the deleted `apps/web/src/components/v2/__tests__/division-settings-derived-rounds.test.tsx`.
  - Text only: the rule's text, citation and status are unchanged, and no code, export or fold table moves.

## 3.0.1

### Patch Changes

- 18e54aa: Rules: BG-SW-1 (`rules/boardgame.md`) now states the chess Swiss colours rule onryde/seazn.club enforces since #1122 (owner 2026-11-03, UI5 item 4, with UI5 fix round 1's controller rulings Q2 and I1). The row described a colours switch that the app has removed.
  
  - A chess Swiss always balances colours. A create or a stage edit that turns them off is refused 422 `SWISS_CHESS_ALWAYS_ON`, before and after play starts. Turning them on is refused `SWISS_CHESS_LOCKED` once a board starts.
  - A stage stored off before the rule is not migrated, but it pairs in colour until its round 1 is paired, and a Format re-Apply stores it with colours on. Another sport's off is kept.
  - The round-1 colour lot clauses are unchanged. The status stays `signed 252 2026-10-31`, because the owner's 2026-11-03 decision has no ruling number. It is cited in the citation column.
  - Text only: no code, export or fold table moves.

## 3.0.0

### Major Changes

- 5f878e2: Scheduling: the solver ladder gains a seventh rung, `day_rank`, the earliest-day tie-break (owner ruling 2026-11-04, W3 X-SW-29), mirroring the placement service's new last rung.
  
  - BREAKING: `TIER_NAMES` gains `day_rank` (last) and `TIER_COUNT` is 7. `buildSchedule` trusts a placement proof only when the reply names this exact ladder, so against a placement service that still proves six rungs no proof is trusted: no `already_optimal`, and the D6 comparator (`isStrictlyBetter`) decides between the solver's board and greedy's. Ship it together with the placement service that proves `day_rank` (onryde/seazn.club.placement, `TIER_ORDER`); either side alone degrades every solve the same way. Released as a major so a caret range on 2.x cannot pick it up ahead of that service.
  - BREAKING: `BoardMetrics` gains `dayRankSum`: the sum, over every match with a grid day, of that day's dense index in time order (0 = the grid's first day; a match on no grid day counts 0; 0 with no `DayView`). A `BoardMetrics` object literal needs the new field.
  - `ladderTied` compares `dayRankSum` too, so a proved board that beats the seed only by playing earlier (greedy's board a day late, the solver's on the start day) ships instead of being kept as `already_optimal`. `isStrictlyBetter` still does not rank any day metric.
  - No fold change: no `FOLD_EPOCH` or `FOLD_MINOR` entry moves.

## 2.0.0

### Major Changes

- 5bba509: W3 Swiss (format matrix): pairing refusal and legality, FIDE C.07 art. 16 tie-breaks, bye = win points, Swiss default chains, round-order scheduling.
  
  - BREAKING: `pairRound` returns `SwissPairResult`: a `SwissRound` (`ok: true`) or a `SwissRefusal` (`ok: false`, `code: "SWISS_NO_LEGAL_PAIRING"`, a `reason`). Callers narrow on `ok`; a refused round seats nothing, not even the bye.
  - BREAKING: `pairRound`'s default search budget rises from 200,000 to 1,000,000 nodes (`SWISS_SEARCH_BUDGET`), and a new fourth argument sets it per call. A round the old budget gave up on (`search_limit`) may now be paired, and a call may run up to five times longer.
  - `pairRound` cost: the call is synchronous and bounded by its budget, which the search, the reason probe and the look-ahead share. A round that spends it all (a `search_limit` refusal, or a look-ahead ending `"unknown"`) is the worst case: 1.9 to 2.8 s for chess at n = 42 at the default budget on a development laptop, with the look-ahead on as the app sets it there (up to 3.5 s under load). The final review measured about 2 to 2.5 s, and the look-ahead at about twice the cost of a round without it. A server caller holding a lock, such as the division lock, can pass a smaller budget; running out stays a `search_limit` refusal or `nextRound: "unknown"`, never a wrong pairing.
  - BREAKING: `buildSwissTable` is now `buildSwissLedger`, which assembles the ledger by round (`SwissLedgerFixture`s, `opts.rounds`, `opts.drawPoints`, `opts.absent`).
  - BREAKING: `SwissGame` changes shape: `round` is required, `unplayed` is a category (`UnplayedRound`: "bye", "forfeit_win", "forfeit_loss", "absent" or "absent_last") instead of a boolean, and an unplayed card carries its 16.4 `cap`. `SwissRow` gains `adjusted` (16.3).
  - BREAKING: a Swiss ledger `TableStage` (`swiss: true`) must name `swissDraw` (`swissDrawFactsOf`), `rounds` whenever a bye or an absence stands, and a `roundNo` on every counted fixture; a missing one is CONFIG_INVALID.
  - BREAKING: a Swiss ledger `TableStage` must also name `swissAbsentRounds`, an empty map when nobody entered late or withdrew, and each counted fixture on it with a `result` must name `TableFixture.unplayed`: `null` for a game played, else `unplayedSidesOf`'s answer (which is `null` for a played result). Leaving either out is CONFIG_INVALID; it used to read as nobody absent and the game played, which ranks a plausible wrong Buchholz, Cut-1 and head-to-head.
  - BREAKING: `TableStage` is now a type alias over a union (the Swiss ledger arm and the rest), not an interface, so `interface X extends TableStage` no longer compiles; use an intersection type instead.
  - BREAKING: `RankContext.pointsUnit` ("whole" or "half") is new, and `rankStandings` refuses a Swiss ledger (`swiss`) passed without it (CONFIG_INVALID). `completeTableStage` passes the stage's `rules.points.unit` itself.
  - BREAKING: Buchholz, Buchholz Cut-1 and Sonneborn-Berger change value on Swiss stages. On any stage with a bye, a forfeit or a missed round, an unplayed round now scores against FIDE C.07 (2026) art. 16's dummy (the entrant's own score, capped at D × R or, for a forfeit, at the scheduled opponent's adjusted score), replacing the C.07 (2023) virtual opponent (the score before the round plus a draw for each round left); this can change the order. On every Swiss stage the displayed columns are now in the table's own points: Buchholz is ÷ 2 only on a half-point table (it was always ÷ 2), and SB ÷ 4 on a half-point table but ÷ 2 on a whole-point one (it was always ÷ 4), so on a whole-point table the Buchholz, Cut-1 and SB columns read twice what 1.x showed.
  - BREAKING: `TiebreakerKey` gains `opp_diff` (Swiss only); exhaustive maps over it need the new key.
  - BREAKING: `ConflictDetailKind` gains `round_order_end`, `rounds_per_day`, `no_slot_round_barrier` and `no_slot_rounds_per_day`; exhaustive maps over it (a `Record<ConflictDetailKind, …>`) need the new keys.
  - BREAKING: `SwissConstraints.byeScore` and boardgame's `byeScore` cfg key are removed (X-SW-6): a bye always pays the win. boardgame FOLD_EPOCH 4 → 5. A stored cfg that still holds the key parses (zod strips it).
  - BREAKING: a bye pays win points. A pairing-allocated bye pays the stage's win, never the forfeit row, its award score or a bonus (X-SW-5). It used to be paid as a forfeit, so on a stage whose rule sets a forfeit row, an award score or a forfeit bonus, a bye's points change.
  - Absences: a late entrant's missed round, or a round after a withdrawal, is a zero-point unplayed round (`swissAbsentRounds`, X-SW-8).
  - Pairing: bye retry with no second bye, whole-group floats, a complete fallback search, soft home/away alternation outside chess, a one-round look-ahead (`lookAhead`, `nextRound`) and the final-round topscorer colour exception (`finalRoundMaxScore`).
  - Tie-breaks: forfeits count as unplayed rounds on the Swiss ledger and out of head-to-head (`TableFixture.unplayed`, `unplayedSidesOf`), Buchholz Cut-1 reads voluntary unplayed rounds first, and the Swiss default chain of ten sports is replaced (X-SW-9; boardgame's already matched and gains only its row, BG-TB-4).
  - Scheduling: a Swiss round starts only after the previous round ends (`roundBarrier: "end"`, X-SW-31), a round gap, a rounds-per-day cap, unpaired round slots, `existing[].dayIndex` (the placement service's `PinnedRow.day_index`), and played rows read through `roundSequenceRows` are pins.
  - Rules: X-SW-1..11 and the sport tie-break rows; close-out rows X-SW-12..30, X-SW-31, BG-SW-1, X-RB-1.

## 1.1.0

### Minor Changes

- b615c84: Sport modules declare their natural breaks: a new optional `SportModule.naturalBreaks` member (`{ kinds, opensAt(ev, before, after) }`) names the pauses a sport's own events open, each `minor` or `major`, so a client can air content in one without keeping a table of sports. `opensAt` is pure, answers only declared kinds, never a minor beside a major (the major is the break), and nothing for the event that ends the match. Exported from `@onryde/seazn-engine/sport` with `declareNaturalBreaks` and `breakSizeOf` (which refuses an undeclared kind with `CONFIG_INVALID`).
  
  Declared by eight of the eleven builtins: cricket (`over_end`, `innings_break`), football (`half_time`, `period_end`, `shootout_break`, `after_goal`), hockey (`quarter_end`, `half_time`, `shootout_break`, `after_goal`), ice hockey (`period_end`, `shootout_break`, `after_goal`), tennis (`changeover`, `set_end`), badminton (`interval`, `game_end`), table tennis (`timeout`, `game_end`) and volleyball (`timeout`, `set_end`). The break before a shoot-out (football's kicks from the penalty mark, FIH's shoot-out, the IIHF's game-winning shots) is one kind, `shootout_break`, in all three. Boardgame, carrom and generic declare none. No fold, state or schema change.

### Patch Changes

- ce56475: Give the Stryker leg core-2 its own runner heap cap of 4096 MB (every other leg keeps 2560) and record its measured run: 888 mutants, 187.8 minutes, timeout 282. Mutation config and sizing data only, no engine source change.
- 14a0bfd: Stryker mutant-count drift is a warning on pull request and push CI and a failure on mutation.yml's weekly run and `group=all` dispatches, which now also run cold (no incremental restore). CI policy only, no engine source change.
- 92795aa: Re-measure the Stryker legs whose mutant counts moved past the sizing drift; timeouts and fan-out quotes re-derived. Sizing data only, no engine source change.

## 1.0.0

### Major Changes

- 0260d0b: First stable release from onryde/seazn.club.engine; no behaviour change from onryde/seazn.club@5a67fbf37d (engine-split-base)
