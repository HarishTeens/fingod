# Onboarding

This is the script for setting fingod up with a new user. **You are their coding agent** (Claude Code,
Codex CLI, Gemini CLI or similar) and this happens as a conversation in their terminal. The browser only
shows the result; it does not guide anything.

Be a good host: ask **one thing at a time**, wait for the answer, keep your messages short, and say what you
are about to do before you do it. Use your multiple-choice question tool if you have one.

> **Read-only.** Never place, modify or cancel an order. Kite's MCP server exposes order and GTT tools;
> fingod never calls them (they are also disabled in this repo's MCP config). Never write a token into any
> file in the repo. Never commit anything from `data/`: it holds the user's real finances and is gitignored.

---

## 1. Get the app running

1. **Are you in the repo?** If this folder isn't the fingod repo, clone
   `https://github.com/HarishTeens/fingod.git` and work from inside it.
2. **Check the tools.** `python3 --version` (3.8+) and `node -v`. Node is only needed for the Kite connector,
   which needs **20.18.1 or newer**. If it is older and the user wants Kite, tell them to run `nvm install`
   inside the folder (`.nvmrc` pins 22), then restart this session from that shell.
3. **Serve it.** From the repo folder, in the background, run Python's built-in server (the standard
   library, so nothing from the repo is executed):

   ```bash
   python3 -m http.server 8000 --bind 127.0.0.1
   ```

   If port 8000 is busy, pick another. **Confirm your server is the one answering**:
   `curl -s -o /dev/null -w '%{http_code}' localhost:<port>/src/main.js` must print `200`. A leftover server
   from an earlier run can hold the port, and a failed start is easy to miss.
4. **Open it** in the user's browser: `open http://localhost:<port>` (macOS), `xdg-open …` (Linux) or
   `start …` (Windows). They will see "No data yet". Tell them to leave the tab open: it fills in on its own
   as you write files.

## 2. Find out what they use

Ask which of these they use, as one multiple-choice question where several can be picked:

| Source | Brings | How it connects |
|---|---|---|
| **Wallet** (BudgetBakers) | expenses, cash accounts, credit cards | MCP server `wallet`, needs an access token |
| **Zerodha Kite** | Indian stocks, mutual funds, gold and liquid ETFs | MCP server `kite`, OAuth login link |
| **INDmoney** | US stocks, USD wallet cash | MCP server `indmoney`, OAuth |
| **EPF** (via INDmoney) | provident fund balance per employer | same INDmoney connection |
| **Bitcoin** | quantity and value | typed in (no MCP) |
| **Fixed deposits** | principal, rate, dates | typed in |
| **Splitwise** | who owes whom | typed in |

Connect **only** what they choose, one at a time. Nothing is mandatory; a user with only Bitcoin and an FD
still gets a dashboard.

## 3. Connect each source

Follow `.claude/skills/refresh/SKILL.md` for every field mapping, and `docs/DATA-FORMAT.md` for the file
formats. The MCP servers are declared per agent, and the three configs list the same servers:

| Agent | Config | Notes |
|---|---|---|
| Claude Code | `.mcp.json` | the session must have been **started inside the repo folder**; the user approves the servers |
| Codex CLI | `.codex/config.toml` | the user trusts the project; INDmoney sign-in: `codex mcp login indmoney` |
| Gemini CLI | `.gemini/settings.json` | INDmoney sign-in: `/mcp auth indmoney` |

**If a source's tools aren't available**, don't improvise. Tell the user exactly this: quit, then
`cd <repo folder>` and start the agent there (`claude`, `codex` or `gemini`; for Wallet, first
`export WALLET_MCP_TOKEN=<the whole token>`), approve or trust the project's MCP config, and run the setup
again. A session only loads a project's MCP servers when it starts inside that folder.

Per source:

- **Wallet.** The user generates an access token in the Wallet app (Settings, MCP) and exports it as
  `WALLET_MCP_TOKEN` before starting the agent. Never ask them to paste it into a file. Then follow SKILL.md
  §2: read accounts, **ask the user which are cash, credit cards or to ignore** (a fixed deposit looks like a
  salary account, so never guess), remember the answers in `data/config.json`, then page the records and write
  `data/transactions/wallet-<today>.json`.
- **Zerodha Kite.** Call `get_profile`; if it says to log in, call `login` and show the link **with the
  risk warning the tool returns**. Then follow SKILL.md §1.
- **INDmoney.** OAuth in the browser (mobile number, OTP, MPIN). Then SKILL.md §3 for US holdings, EPF and USD
  wallet cash.

Write everything into **one** `data/checkpoints/<YYYY-MM-DD>.json`. If it already exists, read it and merge
your sleeves in rather than overwriting. Send `qty` and `price`, never a total. Validate each file with
`python3 -m json.tool`.

## 4. Typed-in figures

Ask for these in plain conversation, one at a time. Offer to skip any.

**Bitcoin.** Ask for the quantity and the current total value in rupees, and optionally the total they paid.
Add a holding to the checkpoint: `{"sleeve":"btc","symbol":"BTC","name":"Bitcoin","qty":<qty>,"price":<value / qty>,
"avg_cost":<paid / qty>,"invested_inr":<paid>}`.

**Fixed deposits, Splitwise and allocation targets** go into `data/standing/manual.json` (see
`docs/DATA-FORMAT.md`; the app imports it and it is safe to re-send):

```json
{
  "fixed_deposits": [{ "bank": "Example Bank", "principal": 100000, "rate_pct": 6.5, "start_date": "2026-02-01", "maturity_date": "2027-02-01" }],
  "splitwise": [{ "person": "Friend A", "amount_inr": 3000 }],
  "target_allocation": { "in_equity": 27, "in_mf": 35, "us_equity": 10, "gold": 5, "btc": 5, "fd": 15, "debt": 2, "liquid": 1 }
}
```

- A deposit needs the bank, principal, rate and start date; maturity is optional. Interest is computed, so never ask
  for it.
- Splitwise is just the bottom line per person: positive means they owe the user, negative means the user owes them.
- **Targets**: explain that fingod shows how far each asset has drifted from where they want it. Offer the defaults
  above, or let them give their own percentages. They should total 100. An asset they can't rebalance (EPF, say) is
  left out of the target.

Always merge into an existing `data/standing/manual.json` rather than overwriting it.

## 5. Check it worked

1. Every file you wrote parses: `python3 -m json.tool < <file>`.
2. The dashboard shows up in the open tab within a few seconds. If the user sees a red "couldn't be imported"
   link in the top bar, open **Data** in the app: it names the file and the field. Fix and re-write the file.
3. Sanity-check what you wrote against SKILL.md §7 (holding counts, sleeve totals, no symbol in two sleeves).

## 6. Wrap up

Tell the user, briefly:

- what you connected and what you found (net worth in rupees, the biggest holdings);
- anything stale or skipped;
- how to take a checkpoint later: say "take a checkpoint" (Claude Code also has `/refresh`) in this folder. Each
  checkpoint starts by updating fingod to the latest `main` (a safe fast-forward pull) and telling them what changed;
- that everything stays on their machine: the browser's own database and the gitignored `data/` folder.

Don't ask for confirmation of things the user already said. If they ask for something that is not covered here,
use your judgment and ask before anything that depends on their preferences.
