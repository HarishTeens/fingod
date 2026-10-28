// The prompts the app hands to the user's coding agent. The browser cannot speak
// MCP, so the agent does the connecting and writes JSON files into data/, which
// the app imports. Keep MASTER in step with /PROMPT.md and landing/prompt.md.

const RULES = `Rules: this is READ-ONLY. Never place, modify or cancel an order, and never write anywhere outside this repo's data/ folder. Money is exact: send qty and price, never a computed total. If a file for today's date already exists in data/checkpoints/, read it and MERGE your parts into it instead of overwriting.`

const HOW = `Follow .claude/skills/refresh/SKILL.md for the field mapping and docs/DATA-FORMAT.md for the file formats.`

export const CONNECTORS = {
  wallet: {
    name: 'Wallet', by: 'BudgetBakers', brings: 'Expenses, cash accounts and credit cards',
    why: 'Powers the spend charts, the cash balance and credit card debt in your net worth.',
    steps: [
      'In the Wallet app, open Settings → MCP and generate an access token.',
      'Give your agent the prompt below. It adds the Wallet MCP server from .mcp.json and asks you for the token.',
      'It writes your transactions and balances into data/. They appear here within seconds.',
    ],
    prompt: `Connect the Wallet (BudgetBakers) MCP server and import my expenses into fingod. Use the "wallet" server declared in .mcp.json; ask me for the access token (Wallet app → Settings → MCP) and keep it out of git. Read my accounts and ask me which are cash, credit cards, or to ignore (a fixed deposit looks like a salary account, so never guess). Page the cleared records with limit 400, process large pages from the spilled file with jq/python so they never enter your context, and write them to data/transactions/wallet-<date>.json. Put the cash and credit_card balances into data/checkpoints/<today>.json. ${HOW} ${RULES}`,
    done: (s) => (s.wallet.ok ? `${s.wallet.transactions.toLocaleString('en-IN')} transaction${s.wallet.transactions === 1 ? '' : 's'} · ${s.wallet.balances} account balance${s.wallet.balances === 1 ? '' : 's'}` : null),
  },
  kite: {
    name: 'Zerodha Kite', by: 'Zerodha', brings: 'Indian stocks, mutual funds, gold and liquid ETFs',
    why: 'Owns both Indian sleeves. Quantities and prices come straight from your demat.',
    steps: [
      'Give your agent the prompt below. It adds the Kite MCP server via the mcp-remote bridge.',
      'Your agent shows a Kite login link. Open it once and approve. The link is single-use.',
      'It reads your holdings and funds and writes them to data/. Nothing is traded: the routine is read-only.',
    ],
    prompt: `Connect the Zerodha Kite MCP server (the "kite" entry in .mcp.json, via the mcp-remote bridge) and import my Indian holdings into fingod. If get_profile says to log in, call login and show me the link WITH the risk warning the tool returns. Read get_holdings (quantity PLUS t1_quantity), get_mf_holdings and get_margins, and write them into data/checkpoints/<today>.json, classifying gold and liquid ETFs by ISIN. NEVER call place_order, modify_order, cancel_order or any GTT tool. ${HOW} ${RULES}`,
    done: (s) => (s.kite.ok ? `${s.kite.equity} stock${s.kite.equity === 1 ? '' : 's'} and ETFs · ${s.kite.funds} mutual fund${s.kite.funds === 1 ? '' : 's'}` : null),
  },
  indmoney: {
    name: 'INDmoney', by: 'INDmoney', brings: 'US stocks and your USD wallet',
    why: 'Owns US equity. fingod derives the exchange rate from INDmoney\'s own figures so the arithmetic stays exact.',
    steps: [
      'Give your agent the prompt below. It adds the INDmoney MCP server.',
      'Sign in once in the browser (mobile number, OTP and MPIN).',
      'It reads your US holdings and writes them to data/. Everything else INDmoney reports is deliberately ignored.',
    ],
    prompt: `Connect the INDmoney MCP server (the "indmoney" entry in .mcp.json) and import my US stocks into fingod. Read networth_holdings(asset_type="US_STOCK"), parse the inner JSON a second time, derive usd_inr = asset_summary.total_value / asset_summary.total_value_usd and price = current_value_usd / total_units, and do NOT use invested_amount as a cost basis. Also take idle USD from networth_snapshot (US_STOCK_WALLET) as a cash balance. Write everything into data/checkpoints/<today>.json. ${HOW} ${RULES}`,
    done: (s) => (s.indmoney.ok ? `${s.indmoney.us} US holding${s.indmoney.us === 1 ? '' : 's'}` : null),
  },
  epf: {
    name: 'EPF', by: 'via INDmoney', brings: 'Your provident fund balance, per employer',
    why: 'Counts towards total net worth. It is never presented as market gain, because contribution and interest cannot be separated.',
    steps: [
      'This rides on the INDmoney connection. If you connected INDmoney, you are one prompt away.',
      'Give your agent the prompt below.',
      'One balance per employer appears, so a job change reads as one row ending and another starting.',
    ],
    prompt: `Using the INDmoney MCP server, read networth_holdings(asset_type="EPF") and add one epf balance per employer (ref = the employer name, amount_inr = market_value) to data/checkpoints/<today>.json, merging into the existing file. ${HOW} ${RULES}`,
    done: (s) => (s.epf.ok ? `${s.indmoney.epf} employer balance${s.indmoney.epf === 1 ? '' : 's'}` : null),
  },
}

/** The one prompt that sets everything up. */
export const MASTER = `Set up fingod for me, a local-first net worth tracker. If this repo isn't already in your working folder, clone https://github.com/HarishTeens/fingod and work from there. Then:

1. Start it with \`python3 serve.py\` (leave it running) and open http://localhost:8000 for me.
2. Read CLAUDE.md, docs/DATA-FORMAT.md and .claude/skills/refresh/SKILL.md.
3. Ask me which of these I use: Wallet (expenses), Zerodha Kite (Indian stocks and funds), INDmoney (US stocks, EPF), Bitcoin (manual). Connect only those, one at a time, using the MCP servers declared in .mcp.json. Walk me through each login.
4. Pull my data and write it as JSON into the data/ folder, exactly as docs/DATA-FORMAT.md describes. The app imports it by itself and shows my dashboard.
5. Tell me what you found, and what moved since last time split into market, flow and FX.

Rules: read-only. Never place, modify or cancel an order. Never commit anything from data/. Ask me before anything that depends on my preferences.`

export const checkpointPrompt = `Take a fingod checkpoint. Follow .claude/skills/refresh/SKILL.md: read every connected source, ask me for the figures no server can supply (like my Bitcoin quantity and value), and write data/checkpoints/<today>.json plus any new data/transactions/*.json. ${RULES} Then tell me net worth and what moved, split into market, flow and FX, plus the 52-week price watch.`
