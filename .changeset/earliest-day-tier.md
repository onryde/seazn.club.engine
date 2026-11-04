---
"@onryde/seazn-engine": major
---

Scheduling: the solver ladder gains a seventh rung, `day_rank`, the earliest-day tie-break (owner ruling 2026-11-04, W3 X-SW-29), mirroring the placement service's new last rung.

- BREAKING: `TIER_NAMES` gains `day_rank` (last) and `TIER_COUNT` is 7. `buildSchedule` trusts a placement proof only when the reply names this exact ladder, so against a placement service that still proves six rungs no proof is trusted: no `already_optimal`, and the D6 comparator (`isStrictlyBetter`) decides between the solver's board and greedy's. Ship it together with the placement service that proves `day_rank` (onryde/seazn.club.placement, `TIER_ORDER`); either side alone degrades every solve the same way. Released as a major so a caret range on 2.x cannot pick it up ahead of that service.
- BREAKING: `BoardMetrics` gains `dayRankSum`: the sum, over every match with a grid day, of that day's dense index in time order (0 = the grid's first day; a match on no grid day counts 0; 0 with no `DayView`). A `BoardMetrics` object literal needs the new field.
- `ladderTied` compares `dayRankSum` too, so a proved board that beats the seed only by playing earlier (greedy's board a day late, the solver's on the start day) ships instead of being kept as `already_optimal`. `isStrictlyBetter` still does not rank any day metric.
- No fold change: no `FOLD_EPOCH` or `FOLD_MINOR` entry moves.
