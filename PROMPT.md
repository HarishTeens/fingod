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

Then paste the prompt below into your agent (Claude Code, Codex CLI, Gemini CLI or any coding agent with shell access and MCP support). It follows [docs/ONBOARDING.md](docs/ONBOARDING.md): it serves
fingod, opens it in your browser, and walks you through connecting your accounts as a short form in your terminal: selectable options, then a submit step. You can also paste it into a
session started anywhere else: it clones the repo, and tells you to restart inside the folder when it reaches the
connectors. Nothing is ever traded: every connector is
read-only, and your data stays in your browser and in a gitignored `data/` folder.

Works with **Wallet** (expenses, cash, cards), **Zerodha Kite** (Indian stocks and funds) and **INDmoney** (US stocks; EPF comes
through it). Bitcoin, fixed deposits and Splitwise are simply typed in. Use only the ones you have.

You don't need an agent to try it. Run `python3 -m http.server 8000 --bind 127.0.0.1`, open <http://localhost:8000> and choose
**Explore with demo data**.

---

Set up fingod for me, a local-first net worth tracker that runs in my browser.

1. If this repo isn't already your working folder, clone https://github.com/HarishTeens/fingod and work from there.
2. Read docs/ONBOARDING.md and follow it step by step. It covers serving the app and opening it in my browser, finding out which accounts I use, connecting them, and writing my data into data/.
3. Run it in this terminal as a short form: use your multiple-choice question tool for every choice (selectable options, then a submit step), and plain questions only for numbers and text.

Rules: read-only. Never place, modify or cancel an order. Never commit anything from data/. Ask me before anything that depends on my preferences.
