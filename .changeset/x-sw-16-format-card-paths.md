---
"@onryde/seazn-engine": patch
---

Rules: X-SW-16 (`rules/cross-sport.md`) follows Format onto the Division rules card (onryde/seazn.club 58ad2c093c moved it off Settings). The row's proof and implementation paths named files that commit deleted or emptied of Swiss round code.

- Enforced at: `apps/web/src/components/v2/rules/division-format.tsx` replaces `apps/web/src/components/v2/division-settings.tsx`, which no longer holds any Swiss round-count code.
- Proved by: `apps/web/src/components/v2/rules/__tests__/division-format.test.tsx` replaces the deleted `apps/web/src/components/v2/__tests__/division-settings-derived-rounds.test.tsx`.
- Text only: the rule's text, citation and status are unchanged, and no code, export or fold table moves.
