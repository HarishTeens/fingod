// The prompt the app and landing page hand to the user's coding agent, and the
// agents it knows how to start. The setup conversation itself lives in
// docs/ONBOARDING.md, so it can improve without touching the prompt.
// Keep MASTER in step with /PROMPT.md, landing/prompt.md and the README.

export const REPO = 'https://github.com/HarishTeens/fingod.git'

/** The coding agents we ship project MCP config for (keep the three in step). */
export const AGENTS = {
  claude: { name: 'Claude Code', cmd: 'claude', config: '.mcp.json', how: 'It asks you to approve them once.' },
  codex: { name: 'Codex CLI', cmd: 'codex', config: '.codex/config.toml', how: 'Trust the project so .codex/config.toml loads. Sign in to INDmoney with: codex mcp login indmoney' },
  gemini: { name: 'Gemini CLI', cmd: 'gemini', config: '.gemini/settings.json', how: 'It reads .gemini/settings.json from the project. Sign in to INDmoney with: /mcp auth indmoney' },
}
export const startCommand = (agent) => `git clone ${REPO} && cd fingod && ${(AGENTS[agent] || AGENTS.claude).cmd}`

/** The one prompt that sets everything up. */
export const MASTER = `Set up fingod for me, a local-first net worth tracker that runs in my browser.

1. If this repo isn't already your working folder, clone https://github.com/HarishTeens/fingod and work from there.
2. Read docs/ONBOARDING.md and follow it step by step. It covers serving the app and opening it in my browser, finding out which accounts I use, connecting them, and writing my data into data/.
3. Run it as a conversation in this terminal: ask me one thing at a time and wait for my answer.

Rules: read-only. Never place, modify or cancel an order. Never commit anything from data/. Ask me before anything that depends on my preferences.`

export const checkpointPrompt = `Take a fingod checkpoint. Follow .claude/skills/refresh/SKILL.md: read every connected source, ask me for the figures no server can supply (like my Bitcoin quantity and value), and write data/checkpoints/<today>.json plus any new data/transactions/*.json. Rules: this is READ-ONLY. Never place, modify or cancel an order, and never write anywhere outside this repo's data/ folder. Money is exact: send qty and price, never a computed total. If a file for today's date already exists in data/checkpoints/, read it and MERGE your parts into it instead of overwriting. Then tell me net worth and what moved, split into market, flow and FX, plus the 52-week price watch.`
