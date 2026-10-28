# data/

This folder is where your coding agent drops files for fingod to import. **Everything here except this
file is gitignored.** It holds your real finances, so it must never be committed.

```
data/
  checkpoints/2026-10-29.json     one snapshot of everything you own on a date
  transactions/wallet-2026-10-29.json   Wallet expense records
```

Served by any local static server (`python3 -m http.server 8000 --bind 127.0.0.1`), the app reads this
folder's listing and imports anything new or changed, every few seconds. The formats are in [../docs/DATA-FORMAT.md](../docs/DATA-FORMAT.md).

The imported data lives in your browser's own SQLite database; these files are just the hand-off.
