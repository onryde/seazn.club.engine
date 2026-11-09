---
"@onryde/seazn-engine": patch
---

Greedy placer honours rest before a fed bracket line. When the placement service refuses a bracket and `buildSchedule` falls back to greedy, `slotFixtures` now starts a line fed by another line no earlier than the feeder's end plus `effectiveRestMinutes(config, line)`, the same rest `validateAssignments` requires (`order_inside_feeder_rest`). Before, greedy placed the fed line at its feeder's final whistle, its own verifier flagged it, and the seed dropped it, so at any rest above 0 a bracket kept only its first round (a 4-entrant knockout placed 2 of 3 lines). Every fed shape gets the same floor: knockout rounds, third place, double-elimination loser feeds, page playoff and stepladder rungs. At rest 0 placement is unchanged.
