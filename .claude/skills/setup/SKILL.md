---
name: setup
description: Set fingod up for a new user as a conversation in the terminal — serve the app, open it in their browser, find out which accounts they use, connect them, and write their data into data/. Use when the user says /setup, "set up fingod", "get me started", "connect my accounts", or pastes the fingod setup prompt.
---

# /setup — onboarding

Onboarding happens here, in the terminal, as a conversation. The browser only shows the result.

**Follow `docs/ONBOARDING.md` step by step.** It is the single script for every coding agent (Claude Code, Codex,
Gemini), so it is the only place the steps are written down. Read it now, then run it.

The short version, so you know what you are walking into:

1. Serve the app with `python3 -m http.server`, confirm *your* server answers, and open it in the user's browser.
2. Ask which sources they use: Wallet, Zerodha Kite, INDmoney (and EPF), Bitcoin, fixed deposits, Splitwise.
3. Connect each chosen source, one at a time, following `.claude/skills/refresh/SKILL.md` for the field mappings.
4. Ask for the typed-in figures (Bitcoin, FDs, Splitwise, allocation targets) and write them as files.
5. Check the files parse and the dashboard shows up, then give a short summary.

Ask **one thing at a time** and wait for the answer. Rules that never bend: read-only (never place, modify or
cancel an order), never write a token into a file, and never commit anything from `data/`.

Afterwards, to take a checkpoint, use `/refresh`.
