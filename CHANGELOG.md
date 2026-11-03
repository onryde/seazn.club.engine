# @onryde/seazn-engine

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
