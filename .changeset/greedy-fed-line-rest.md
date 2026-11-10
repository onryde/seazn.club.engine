---
"@onryde/seazn-engine": patch
---

Greedy placer honours rest before a fed bracket line, and pinned or already-placed feeders. When the placement service refuses a bracket and `buildSchedule` falls back to greedy, `slotFixtures` now starts a line fed by another line no earlier than the feeder's end plus `effectiveRestMinutes(config, line)`, the same rule `validateAssignments` enforces (`order_before_feeder`, `order_inside_feeder_rest`). Greedy's own verifier flagged every line that broke it, and the seed dropped them; two cases did:

- At any rest above 0, greedy started a fed line at its feeder's final whistle, so a bracket kept only its first round (a 4-entrant knockout placed 2 of 3 lines).
- A feeder that was pinned (`locked`) or already on the board (`existing`) set no floor at all, at rest 0 included. With both semis pinned, Auto put the final before them.

One floor now covers every fed shape (knockout rounds, third place, double-elimination loser feeds, page playoff and stepladder rungs), wherever the feeder sits: placed in this pass, pinned, or in `existing`. Boards with no feed into a movable line, and fed lines at rest 0 whose feeders are both movable, place exactly as before.

What a caller sees changes for one case. If the new floor pushes a fed line past the horizon or past the last session window, the line is still not placed, but it is now reported as `no_slot` with detail `no_slot_horizon`, naming no feeder. Before, greedy placed it too early and the line came back as `order_before_feeder` (pinned feeder) or `order_inside_feeder_rest` (feeder plus rest), naming each feeder.
