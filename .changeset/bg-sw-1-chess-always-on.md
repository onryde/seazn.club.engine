---
"@onryde/seazn-engine": patch
---

Rules: BG-SW-1 (`rules/boardgame.md`) now states the chess Swiss colours rule onryde/seazn.club enforces since #1122 (owner 2026-11-03, UI5 item 4, with UI5 fix round 1's controller rulings Q2 and I1). The row described a colours switch that the app has removed.

- A chess Swiss always balances colours. A create or a stage edit that turns them off is refused 422 `SWISS_CHESS_ALWAYS_ON`, before and after play starts. Turning them on is refused `SWISS_CHESS_LOCKED` once a board starts.
- A stage stored off before the rule is not migrated, but it pairs in colour until its round 1 is paired, and a Format re-Apply stores it with colours on. Another sport's off is kept.
- The round-1 colour lot clauses are unchanged. The status stays `signed 252 2026-10-31`, because the owner's 2026-11-03 decision has no ruling number. It is cited in the citation column.
- Text only: no code, export or fold table moves.
