---
name: setup
description: Set fingod up for a new user as a short selectable form in the terminal — find out which accounts they use, connect them, write their data into data/, and finally open their dashboard in the browser. Use when the user says /setup, "set up fingod", "get me started", "connect my accounts", or pastes the fingod setup prompt.
---

# /setup — onboarding

Onboarding happens here, in the terminal, as a short form: selectable options, then a submit step. The browser only shows the result.

**Follow `docs/ONBOARDING.md` step by step.** It is the single script for every coding agent (Claude Code, Codex,
Gemini, Pi), so it is the only place the steps are written down. Read it now, then run it.

The short version, so you know what you are walking into:

1. Check the tools (Python, Node). **Do not open the browser yet.**
2. Round 1, as one `AskUserQuestion` call with selectable options: which apps they use (Wallet, Zerodha Kite, INDmoney, EPF), what they track by hand (Bitcoin, fixed deposits, Splitwise), and how to set targets.
3. Round 2: the typed-in details, all fields of one item in a single message. Then a review and a selectable **submit**.
4. Connect each chosen source one at a time, following `.claude/skills/refresh/SKILL.md` for the field mappings, with a selectable "ready?" gate before each login.
5. Write the typed-in figures and check the files parse. **Only now** serve the app (`python3 -m http.server`, confirm *your* server answers) and open the dashboard in the browser, then give a short summary.

Use **selectable options** for every choice (and plain questions only for numbers and text), and wait for the submit. Rules that never bend: read-only (never place, modify or
cancel an order), never write a token into a file, and never commit anything from `data/`.

Afterwards, to take a checkpoint, use `/refresh`.
