---
"@onryde/seazn-engine": patch
---

A repair that ties greedy keeps the board that moves fewer matches. `buildSchedule` ships the greedy seed when the placement service's proved board ties it on every rung of the ladder (`already_optimal`), because shipping an indistinguishable board is churn. The seed ignores `current`, though: greedy orders sibling lines by fixture id. Since 6.0.1 bounds a fed line by its existing feeders, the seed is legal in a bracket repair where it used to be disqualified, so it reached the tie and shipped:

- With both semis played and the final and third-place match clashing side by side, a repair moved both TBD lines whenever the organiser had the higher-id one on the first court, where moving one would do. `repairDecomposedCpsat` then reported `moved` 2 and minimality `upper_bound` instead of 1 and `proved`, depending on fixture id order.

What a caller sees changes for one case. When `current` is supplied, the service proved our ladder, the two boards tie on it, and the service's board disturbs `current` less than the seed (fewer of its cards dropped, then fewer moved), `buildSchedule` now ships the service's board: `engine: "optimized"`, `status: "ok"`, and `moved` counted against `current` as before. On an equal count, on every run without `current`, on a reply that places fewer, and on a reply that did not prove our ladder, the seed ships exactly as before. The placement service is not told `current`, so this picks the better of the two tied boards; it does not search for the fewest moves.
