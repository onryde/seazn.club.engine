---
"@onryde/seazn-engine": patch
---

A repair's greedy board keeps the organiser's order. `slotFixtures` takes an optional `current` (the organiser's board), and `buildSchedule` forwards its own `current` to it. With it, lines of one `roundNo` are placed in their order on that board — start time, then court order in `config.courts` — before falling back to fixture id; lines the board does not hold follow, by id. Before, same-round lines were ordered by fixture id alone, a random uuid.

This is the board a repair ships when the placement service's board is rejected by the verifier (`verifier_rejected`). In a knockout repair with both semis played and caller-frozen, the solver is not told the frozen semis feed the final and third-place match, proposes a board with both before the semis, and the verifier rejects it. With the two lines clashing side by side, the id-ordered seed moved BOTH whenever the organiser had the higher-id line on the first court, so `repairDecomposedCpsat` reported `moved` 2 and minimality `upper_bound` about half the time, where one move and `proved` is right (seazn.club smoke #401). It now moves one line in either id order.

What a caller sees changes only when `current` is supplied and non-empty: same-round lines may be placed in a different order, so `assignments`, `moved` and the D6 tie outcome can differ. Without `current` (or with an empty one) the seed is byte-identical to before.
