---
"@onryde/seazn-engine": major
---

Cricket's summary reads the last super over, never a sum across them (CK-SO-4). Under `superOverStillTied: "repeat"` a tied super over is played again and only the last one decides, but `summary.headline` added every super over's runs into its ` · SO h–a` suffix, a score nobody made (a Final tied 9–9 and 36–36 before its third super over decided 32–36 read "SO 77–81").

- `summary.headline` ends ` · SO 9–8` while there has been one super over (unchanged), and ` · SO<n> h–a` from the second on (` · SO3 32–36`): the runs of the last super over played or being played, home first. A side yet to bat in it reads 0.
- `summary.detail.superOver` is that same super over's `{ home, away }`, not the sum.
- BREAKING: cricket's `FOLD_EPOCH` rises from 3 to 4, because a phone computes and renders the summary. The server's epoch gate refuses all cricket scoring writes from an epoch-3 client until it updates. No golden stream moved (the corpus's one super over is a single pair); this is a manual major.
