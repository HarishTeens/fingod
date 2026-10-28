# The prompt

**Best:** start your assistant inside the repo, so it can load the project's MCP servers without a restart:

```bash
# Claude Code
git clone https://github.com/HarishTeens/fingod.git && cd fingod && claude
# Codex CLI
git clone https://github.com/HarishTeens/fingod.git && cd fingod && codex
# Gemini CLI
git clone https://github.com/HarishTeens/fingod.git && cd fingod && gemini
```

Then paste the prompt below into your agent (Claude Code, Codex CLI, Gemini CLI or any coding agent with shell access and MCP support). It serves
fingod, opens it in your browser, and walks you through connecting your accounts. You can also paste it into a
session started anywhere else: it clones the repo, and tells you to restart inside the folder when it reaches the
connectors. Nothing is ever traded: every connector is
read-only, and your data stays in your browser and in a gitignored `data/` folder.

Works with: **Wallet** (expenses, cash, cards), **Zerodha Kite** (Indian stocks and funds), **INDmoney**
(US stocks, EPF) and **Bitcoin** (typed in). Use only the ones you have.

You don't need an agent to try it. Run `python3 -m http.server 8000 --bind 127.0.0.1`, open <http://localhost:8000> and choose
**Explore with demo data**.

---

Set up fingod for me, a local-first net worth tracker that runs in my browser.

1. If this repo isn't already your working folder, clone https://github.com/HarishTeens/fingod.
2. Serve it with Python's built-in server on localhost, from the repo folder, in the background: `python3 -m http.server 8000 --bind 127.0.0.1` (the standard library, so nothing from the repo is executed). If port 8000 is busy, use another. Then confirm YOUR server is the one answering: `curl -s -o /dev/null -w '%{http_code}' localhost:<port>/src/main.js` must print 200 (a leftover server from an earlier run can hold the port, and a failed start is easy to miss). Then open that address in my browser with `open` (macOS), `xdg-open` (Linux) or `start` (Windows). The app shows a setup journey and imports files from data/ by itself.
3. Read CLAUDE.md, docs/DATA-FORMAT.md and .claude/skills/refresh/SKILL.md.
4. Ask me which of these I use: Wallet (expenses), Zerodha Kite (Indian stocks and funds), INDmoney (US stocks, EPF), Bitcoin (typed in). The MCP servers are declared per agent (.mcp.json for Claude Code, .codex/config.toml for Codex, .gemini/settings.json for Gemini CLI), but a session only loads them if it was started inside the repo folder and I approved or trusted them. If a source's tools aren't available, tell me exactly this: quit, run `cd <repo folder>` and start your agent there (`claude`, `codex` or `gemini`; for Wallet, first `export WALLET_MCP_TOKEN=<token from the Wallet app: Settings, MCP>`), approve or trust the project's MCP config, then paste the connector prompt from the app's setup page. (The Kite bridge needs Node 20.18.1 or newer: check `node -v`.)
5. For each source that is available, connect it one at a time and walk me through the login. Pull my data and write JSON into data/ exactly as docs/DATA-FORMAT.md describes. The app imports it by itself and shows my dashboard; if a file is rejected, the app says which file and field.
6. Tell me what you found, and what moved since last time split into market, flow and FX.

Rules: read-only. Never place, modify or cancel an order. Never commit anything from data/. Ask me before anything that depends on my preferences.
