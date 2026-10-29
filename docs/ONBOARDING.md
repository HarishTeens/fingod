# Onboarding

This is the script for setting fingod up with a new user. **You are their coding agent** (Claude Code,
Codex CLI, Gemini CLI or similar) and this happens in their terminal. The browser only shows the result; it
does not guide anything.

> **Read-only.** Never place, modify or cancel an order. Kite's MCP server exposes order and GTT tools;
> fingod never calls them (they are also disabled in this repo's MCP config). Never write a token into any
> file in the repo. Never commit anything from `data/`: it holds the user's real finances and is gitignored.

## How to ask

Onboarding should feel like filling in a short form, not like an interview. Whenever the answer is a **choice**,
make it **selectable**, and let the user **submit** a whole round at once.

- **Use your structured question tool** if you have one. In Claude Code that is `AskUserQuestion`: it shows
  selectable options, lets you batch **up to 4 questions per call** with **2 to 4 options each**, supports
  `multiSelect` where several answers apply, and adds an "Other" box on its own. Give each option a short
  description, put the recommended option first and label it "(Recommended)", and keep headers to a word or two.
- **No such tool?** (Codex and Gemini have no equivalent.) Fake it plainly: print the same questions as numbered
  lists, one round at a time, and let the user answer with numbers ("1,3", "all", "none"). Same questions, same
  order.
- **Numbers and free text are typed, not selected.** Ask for all the fields of one item in **a single message**
  with an example ("Bitcoin: quantity, current value in ₹, and what you paid (optional). e.g. `0.0125, 106000,
  80000`"), never one field per message.
- Keep your own messages short, and say what you are about to do before you do it.

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

   If port 8000 is busy, pick another, and **remember it**: every later mention of `8000` or `<port>` in this
   guide and in `SKILL.md` means the port you chose. **Confirm your server is the one answering**:
   `curl -s -o /dev/null -w '%{http_code}' localhost:<port>/src/main.js` must print `200`. A leftover server
   from an earlier run can hold the port, and a failed start is easy to miss.
4. **Open it** in the user's browser: `open http://localhost:<port>` (macOS), `xdg-open …` (Linux) or
   `start …` (Windows). If none of those exist (a headless or remote machine), give the user the URL to open
   themselves. They will see "No data yet". Tell them to leave the tab open: it fills in on its own as you
   write files.

## 2. Round 1: what do you use?

One batch of questions, answered together. Ask exactly these (Claude Code: one `AskUserQuestion` call).

**Q1. Which of these apps do you use?** *(multi-select, header "Apps")*

| Option | Description |
|---|---|
| Wallet | Expenses, cash accounts and credit cards (BudgetBakers) |
| Zerodha Kite | Indian stocks, mutual funds, gold and liquid ETFs |
| INDmoney | US stocks and your USD wallet |
| EPF (via INDmoney) | Provident fund balance per employer; rides on the INDmoney connection |

**Q2. What do you track by hand?** *(multi-select, header "By hand")*

| Option | Description |
|---|---|
| Bitcoin | Quantity and current value, typed in (no MCP exists for it) |
| Fixed deposits | Principal, rate and dates; interest is computed |
| Splitwise | Who owes whom, as a bottom line per person |

**Q3. How should allocation targets be set?** *(single-select, header "Targets")*

| Option | Description |
|---|---|
| Use the defaults (Recommended) | 27% Indian equity, 35% mutual funds, 10% US, 5% gold, 5% Bitcoin, 15% FDs, 2% debt, 1% cash |
| I'll set my own | You'll be asked for the percentages next |

Nothing is mandatory: a user with only Bitcoin and one FD still gets a dashboard. If they pick EPF but not INDmoney,
say that EPF rides on INDmoney and add it for them.

## 3. Round 2: the details you need to type

Only for what they picked in Q2 and Q3. **One message per item, all its fields together, with an example.**
Offer to skip any of them.

- **Bitcoin.** Quantity, current total value in rupees, and optionally what they paid in total.
- **Each fixed deposit.** Bank, principal, rate in %, start date, and maturity date (optional). Then a selectable
  question: *Add another deposit?* Yes / No. Interest is computed, so never ask for it.
- **Splitwise.** People and amounts as a bottom line each. Positive means they owe the user, negative means the
  user owes them. One message listing everyone, e.g. `Asha 3000, Ravi -500`.
- **Own targets** (only if they chose "I'll set my own"): show the default percentages and ask what to change. They
  should total 100. An asset they can't rebalance (EPF, say) is left out.

## 4. Review and submit

Before connecting anything or writing a file, show a short summary of what you are about to do:

```
Connect:   Wallet, Zerodha Kite, INDmoney (+ EPF)
By hand:   Bitcoin 0.0125 BTC (₹106,000) · 1 fixed deposit · Splitwise: 2 people
Targets:   defaults
```

Then one selectable question, **"Start setting this up?"**: *Yes, start (Recommended)* / *Change something*. If they
want a change, ask which part with a multi-select (Apps, By hand, Targets) and re-ask only that round. Do not
continue until they have submitted.

## 5. Connect each source

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

Connect the chosen apps **one at a time**. Before each one that needs a login, ask a selectable question
(*"Ready to connect Zerodha Kite? You'll get a single-use login link."* → *Connect now (Recommended)* / *Skip for
now*), so they are at the keyboard when the link appears. Then:

- **Wallet.** The user generates an access token in the Wallet app (Settings, MCP) and exports it as
  `WALLET_MCP_TOKEN` before starting the agent. Never ask them to paste it into a file. Follow SKILL.md §2:
  read the accounts, then **ask what each one is** with selectable questions, batched up to 4 accounts per call:
  *"What is 'Salary account'?"* → *Cash* / *Credit card* / *Ignore (e.g. a fixed deposit)*. Suggest the likely
  answer from the name and type, but never guess silently: a fixed deposit looks like a salary account. Remember
  the answers in `data/config.json`, then page the records and write `data/transactions/wallet-<today>.json`.
- **Zerodha Kite.** Call `get_profile`; if it says to log in, call `login` and show the link **with the risk
  warning the tool returns**. Then follow SKILL.md §1.
- **INDmoney.** OAuth in the browser (mobile number, OTP, MPIN). Then SKILL.md §3 for US holdings, EPF (if chosen)
  and USD wallet cash.

Write everything into **one** `data/checkpoints/<YYYY-MM-DD>.json`. If it already exists, **merge** instead of
overwriting: read it, replace its holdings by `(sleeve, symbol)` and its balances by `(kind, ref)` with your fresh
ones, keep everything else, and write it back. Send `qty` and `price`, never a total. Validate each file with
`python3 -m json.tool`.

## 6. Write the typed-in figures

**Bitcoin** goes into the checkpoint as a holding: `{"sleeve":"btc","symbol":"BTC","name":"Bitcoin","qty":<qty>,
"price":<value / qty>,"avg_cost":<paid / qty>,"invested_inr":<paid>}`. If they didn't say what they paid, **leave
`avg_cost` and `invested_inr` out** entirely: the app then shows no return for it rather than inventing one.

**Fixed deposits, Splitwise and targets** go into `data/standing/manual.json` (see `docs/DATA-FORMAT.md`; the app
imports it and it is safe to re-send):

```json
{
  "fixed_deposits": [{ "bank": "Example Bank", "principal": 100000, "rate_pct": 6.5, "start_date": "2026-02-01", "maturity_date": "2027-02-01" }],
  "splitwise": [{ "person": "Friend A", "amount_inr": 3000 }],
  "target_allocation": { "in_equity": 27, "in_mf": 35, "us_equity": 10, "gold": 5, "btc": 5, "fd": 15, "debt": 2, "liquid": 1 }
}
```

In `target_allocation`, `liquid` is the cash the app labels **"Bank balances"**. `epf` is also a valid key; leave it
out (as above) unless the user wants EPF counted in the rebalance, since it can't be rebalanced.

Always merge into an existing `data/standing/manual.json` rather than overwriting it: replace fixed deposits by
`(bank, principal, start_date)` and people by name, and keep the rest.

## 7. Check it worked

1. Every file you wrote parses: `python3 -m json.tool < <file>`.
2. The dashboard shows up in the open tab within a few seconds. If the user sees a red "couldn't be imported"
   link in the top bar, open **Data** in the app: it names the file and the field. Fix and re-write the file.
3. Sanity-check what you wrote against SKILL.md §7 (holding counts, sleeve totals, no symbol in two sleeves).

## 8. Wrap up

Tell the user, briefly:

- what you connected and what you found (net worth in rupees, the biggest holdings);
- anything stale or skipped;
- how to take a checkpoint later: say "take a checkpoint" (Claude Code also has `/refresh`) in this folder. Each
  checkpoint starts by updating fingod to the latest `main` (a safe fast-forward pull) and telling them what changed;
- that everything stays on their machine: the browser's own database and the gitignored `data/` folder.

Don't ask again for things the user already told you. If they ask for something that is not covered here, use your
judgment and ask before anything that depends on their preferences.
