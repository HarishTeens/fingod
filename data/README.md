# data/

This folder is where your coding agent drops files for fingod to import. **Everything here except this
file is gitignored.** It holds your real finances, so it must never be committed.

```
data/
  checkpoints/2026-10-29.json     one snapshot of everything you own on a date
  transactions/wallet-2026-10-29.json   Wallet expense records
```

`python3 serve.py` lists this folder at `/data/manifest.json`, and the app imports anything new or
changed, every few seconds. The formats are in [../docs/DATA-FORMAT.md](../docs/DATA-FORMAT.md).

The imported data lives in your browser's own SQLite database; these files are just the hand-off.
