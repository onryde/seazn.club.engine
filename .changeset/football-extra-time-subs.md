---
"@onryde/seazn-engine": major
---

football: `extraTimeSubs` — Law 3's extra substitution and window in extra time

A new optional football cfg key, `extraTimeSubs: { subs, windows }` (stage-scoped rule key), with no default. Once the match has reached extra time (ET_H1, ET_H2, or the shoot-out after extra time), the substitution cap is `maxSubs + subs` and the window cap is `subWindows + windows`, each only where its base cap is declared. Absent, every fold is unchanged. One reader, `effectiveSubCaps(cfg, phase)`: the fold's window check, football's `lineupPolicy` and the pad's `footballPadRules.subWindowsCap(cfg, phase)`. **Breaking:** `phase` is a new REQUIRED argument of `subWindowsCap` (pad and `sports/football`), so a caller that has not been updated fails to compile rather than quietly reading the cap before extra time; pass the match's phase.

The kernel now asks a module's `lineupPolicy(cfg, state)` per lineup event with the state the event is judged in (the hook's `state` argument is new and optional), so `core.lineup.substitution` gets the extra-time cap too.

Major, not minor: football's `FOLD_EPOCH` rises to 5. The key is opt-in and an epoch-4 client strips it, so a match that uses it folds differently there (GOLDEN-POLICY "Unexercised branches", the W2c precedent for opt-in keys), and a moved `FOLD_EPOCH` needs a major release. Found by the phone's replay of the 2022 World Cup final (F-R3).
