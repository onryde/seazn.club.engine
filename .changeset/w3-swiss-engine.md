---
"@onryde/seazn-engine": major
---

W3 Swiss (format matrix): pairing refusal and legality, FIDE C.07 art. 16 tie-breaks, bye = win points, Swiss default chains, round-order scheduling.

- BREAKING: `pairRound` returns `SwissPairResult`: a `SwissRound` (`ok: true`) or a `SwissRefusal` (`ok: false`, `code: "SWISS_NO_LEGAL_PAIRING"`, a `reason`). Callers narrow on `ok`; a refused round seats nothing, not even the bye.
- BREAKING: `buildSwissTable` is now `buildSwissLedger`, which assembles the ledger by round (`SwissLedgerFixture`s, `opts.rounds`, `opts.drawPoints`, `opts.absent`).
- BREAKING: a Swiss ledger `TableStage` (`swiss: true`) must name `swissDraw` (`swissDrawFactsOf`), `rounds` whenever a bye or an absence stands, and a `roundNo` on every counted fixture; a missing one is CONFIG_INVALID.
- BREAKING: a Swiss ledger `TableStage` must also name `swissAbsentRounds`, an empty map when nobody entered late or withdrew, and each counted fixture on it with a `result` must name `TableFixture.unplayed`: `null` for a game played, else `unplayedSidesOf`'s answer (which is `null` for a played result). Leaving either out is CONFIG_INVALID; it used to read as nobody absent and the game played, which ranks a plausible wrong Buchholz, Cut-1 and head-to-head.
- BREAKING: `TiebreakerKey` gains `opp_diff` (Swiss only); exhaustive maps over it need the new key.
- BREAKING: `SwissConstraints.byeScore` and boardgame's `byeScore` cfg key are removed (X-SW-6): a bye always pays the win. boardgame FOLD_EPOCH 4 → 5. A stored cfg that still holds the key parses (zod strips it).
- Bye = win points: a pairing-allocated bye pays the stage's win, never the forfeit row, its award score or a bonus (X-SW-5). A late entrant's missed round, or a round after a withdrawal, is a zero-point unplayed round (`swissAbsentRounds`, X-SW-8).
- Pairing: bye retry with no second bye, whole-group floats, a complete fallback search, soft home/away alternation outside chess, a one-round look-ahead (`lookAhead`, `nextRound`) and the final-round topscorer colour exception (`finalRoundMaxScore`).
- Tie-breaks: forfeits count as unplayed rounds on the Swiss ledger and out of head-to-head (`TableFixture.unplayed`, `unplayedSidesOf`), Buchholz Cut-1 reads voluntary unplayed rounds first, and the Swiss default chain of ten sports is replaced (X-SW-9; boardgame's already matched and gains only its row, BG-TB-4).
- Scheduling: a Swiss round starts only after the previous round ends (`roundBarrier: "end"`, X-SW-31), a round gap, a rounds-per-day cap, unpaired round slots, `existing[].dayIndex` (the placement service's `PinnedRow.day_index`), and played rows read through `roundSequenceRows` are pins.
- Rules: X-SW-1..11 and the sport tie-break rows; close-out rows X-SW-12..30, X-SW-31, BG-SW-1, X-RB-1.
