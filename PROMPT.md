# The prompt

Paste this into Claude Code (or any coding agent with shell access and MCP support). It clones fingod,
starts it, and walks you through connecting your accounts. Nothing is ever traded: every connector is
read-only, and your data stays in your browser and in a gitignored `data/` folder.

Works with: **Wallet** (expenses, cash, cards), **Zerodha Kite** (Indian stocks and funds), **INDmoney**
(US stocks, EPF) and **Bitcoin** (typed in). Use only the ones you have.

You don't need an agent to try it. Run `python3 serve.py`, open <http://localhost:8000> and choose
**Explore with demo data**.

---

Set up fingod for me, a local-first net worth tracker. If this repo isn't already in your working folder, clone https://github.com/HarishTeens/fingod and work from there. Then:

1. Start it with `python3 serve.py` (leave it running) and open http://localhost:8000 for me.
2. Read CLAUDE.md, docs/DATA-FORMAT.md and .claude/skills/refresh/SKILL.md.
3. Ask me which of these I use: Wallet (expenses), Zerodha Kite (Indian stocks and funds), INDmoney (US stocks, EPF), Bitcoin (manual). Connect only those, one at a time, using the MCP servers declared in .mcp.json. Walk me through each login.
4. Pull my data and write it as JSON into the data/ folder, exactly as docs/DATA-FORMAT.md describes. The app imports it by itself and shows my dashboard.
5. Tell me what you found, and what moved since last time split into market, flow and FX.

Rules: read-only. Never place, modify or cancel an order. Never commit anything from data/. Ask me before anything that depends on my preferences.
