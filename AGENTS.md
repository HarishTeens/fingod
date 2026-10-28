# AGENTS.md

Guidance for coding agents (Codex, Gemini CLI, Claude Code and others) working in this repository. The full
version is [CLAUDE.md](CLAUDE.md); read it. The essentials:

## What this is

fingod is a local-first net worth tracker that runs entirely in the browser: vanilla ES modules and SQLite
compiled to WebAssembly. **You are the connector.** The browser can't speak MCP, so you read the user's
sources (Wallet, Zerodha Kite, INDmoney) over MCP and write JSON files into `data/`; the app imports them.

- If asked to set fingod up, follow [PROMPT.md](PROMPT.md).
- File formats: [docs/DATA-FORMAT.md](docs/DATA-FORMAT.md).
- Field mappings and the whole refresh routine: [.claude/skills/refresh/SKILL.md](.claude/skills/refresh/SKILL.md).
  It is a plain Markdown file; follow it whatever agent you are.

## Hard rules

1. **Read-only.** Never place, modify or cancel an order. Kite's server exposes `place_order`,
   `modify_order`, `cancel_order` and GTT tools; this project never calls them. They are also disabled in
   the project's MCP config for each agent.
2. **Never commit personal financial data.** Everything in `data/` except `data/README.md` is gitignored.
   Never write a token into any file in the repo.
3. **Send `qty` and `price`, never a computed total.** Match holdings on ISIN, not ticker.
4. **Write only into `data/`.**

## MCP servers

Declared per agent, and the three must stay in step:

| Agent | Config | Notes |
|---|---|---|
| Claude Code | `.mcp.json` (+ `.claude/settings.json`) | start `claude` inside the repo and approve the servers |
| Codex CLI | `.codex/config.toml` | trust the project; `codex mcp login indmoney` |
| Gemini CLI | `.gemini/settings.json` | `/mcp auth indmoney` |

Wallet needs `export WALLET_MCP_TOKEN=<token>` before the agent starts. The Kite bridge needs Node 20.18.1+.

## Run and test

```bash
python3 -m http.server 8000 --bind 127.0.0.1    # then open http://localhost:8000 (add ?demo for invented data)
node --test tests/                              # Node 20+, no dependencies
```
