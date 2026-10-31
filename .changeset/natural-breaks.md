---
"@onryde/seazn-engine": minor
---

Sport modules declare their natural breaks: a new optional `SportModule.naturalBreaks` member (`{ kinds, opensAt(ev, before, after) }`) names the pauses a sport's own events open, each `minor` or `major`, so a client can air content in one without keeping a table of sports. `opensAt` is pure, answers only declared kinds, never a minor beside a major (the major is the break), and nothing for the event that ends the match. Exported from `@onryde/seazn-engine/sport` with `declareNaturalBreaks` and `breakSizeOf` (which refuses an undeclared kind with `CONFIG_INVALID`).

Declared by eight of the eleven builtins: cricket (`over_end`, `innings_break`), football (`half_time`, `period_end`, `after_goal`), hockey (`quarter_end`, `half_time`, `after_goal`), ice hockey (`period_end`, `after_goal`), tennis (`changeover`, `set_end`), badminton (`interval`, `game_end`), table tennis (`timeout`, `game_end`) and volleyball (`timeout`, `set_end`). Boardgame, carrom and generic declare none. No fold, state or schema change.
