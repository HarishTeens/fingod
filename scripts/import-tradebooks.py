#!/usr/bin/env python3
"""Seed realised P&L from broker tradebooks, by FIFO-matching sells to buys.

    make import-tradebooks EXPORTS="~/Downloads/exports MF and EQ"

A tradebook is executions, not positions: a sell says what left and at what
price, never what it originally cost. Matching each sell against the oldest
unsold buys — first in, first out — is how a broker computes realised gain, and
the only way to recover it from this data. Neither Kite nor INDmoney will serve
it over MCP: their trade endpoints are today-only.

Everything is Decimal. A lot that fails to close to exactly zero units is a
signal, not noise, and float would hide it.

**Gaps are fatal by default.** Zerodha exports one financial year at a time, and
a missing year means sells whose buys are absent. Rather than invent a cost
basis, the script refuses and names what is missing — a realised figure computed
from half the history is worse than none, because it looks finished.
"""
import csv, datetime, glob, io, json, os, sys, urllib.request
from collections import defaultdict, deque
from decimal import Decimal as Q, getcontext
from pathlib import Path

getcontext().prec = 28
API = os.environ.get("FINGOD_API_ORIGIN", "http://127.0.0.1:8080")
TOKEN = os.environ.get("FINGOD_API_TOKEN")

# ISIN decides the sleeve, not the ticker: tickers get renamed, ISINs do not.
GOLD = {"INF204KB17I5", "INF0R8F01042"}          # GOLDBEES, GOLDCASE
DEBT = {"INF0R8F01034", "INF732E01037"}          # LIQUIDCASE, LIQUIDBEES


def sleeve_of(isin, segment):
    if isin in GOLD:
        return "gold"
    if isin in DEBT:
        return "debt"
    return "in_mf" if segment == "MF" else "in_equity"


def load_zerodha(root):
    """Every tradebook CSV under root, deduped on trade_id, with ISINs repaired.

    Some exports leave `isin` blank on a subset of rows — several symbols
    can have blanks. Keying FIFO
    on a blank puts unrelated instruments in one bucket and happily matches
    one stock's sell against another's buy, which produces a realised figure
    that is not wrong so much as meaningless.

    So the symbol-to-ISIN map is built from the rows that do carry one, and the
    blanks are filled from it. ISIN stays the key wherever it is known, because
    tickers get renamed and ISINs do not; a symbol that never carries an ISIN
    anywhere falls back to its own name.
    """
    rows = {}
    for f in glob.glob(str(root / "tradebook-*.csv")):
        segment = "MF" if "-MF" in Path(f).name else "EQ"
        for r in csv.DictReader(io.open(f, encoding="utf-8-sig")):
            r["_segment"] = segment
            rows[r["trade_id"]] = r

    known = {}
    for r in rows.values():
        if r["isin"].strip():
            known.setdefault(r["symbol"], r["isin"].strip())

    repaired = 0
    for r in rows.values():
        if not r["isin"].strip():
            r["isin"] = known.get(r["symbol"], "SYM:" + r["symbol"])
            repaired += 1
    if repaired:
        print(f"repaired {repaired} rows with a blank ISIN, matched on symbol")

    out = list(rows.values())
    # Chronological, buys before sells on the same day: you cannot sell what you
    # have not bought, and same-day round trips happen.
    out.sort(key=lambda r: (r["trade_date"], r["order_execution_time"], r["trade_type"] != "buy"))
    return out


def opening_lots(path):
    """Lots that exist without a purchase: corporate actions, or pre-export holdings.

    A demerger hands you shares no tradebook records. Without a cost basis for
    them a sell has nothing to match against, and the choice is between refusing
    it and inventing a number. This is the third option: state the basis
    explicitly, with its derivation, and let it be reviewed.
    """
    if not path.exists():
        return {}
    data = json.loads(path.read_text())
    seeded = defaultdict(list)
    for lot in data.get("lots", []):
        seeded[lot["isin"]].append([Q(lot["qty"]), Q(lot["cost_per_unit"]), lot["date"]])
    if seeded:
        print(f"seeded {sum(len(v) for v in seeded.values())} opening lot(s) from {path.name}")
    return seeded


def fifo(trades, seeded=None):
    """Replay the tape. Returns closed lots and any sell that ran out of buys."""
    lots, closed, gaps = defaultdict(deque), [], []
    for isin, entries in (seeded or {}).items():
        for e in entries:
            lots[isin].append(list(e))
    for t in trades:
        isin, qty, price = t["isin"], Q(t["quantity"]), Q(t["price"])
        if t["trade_type"] == "buy":
            lots[isin].append([qty, price, t["trade_date"]])
            continue

        remaining, cost, opened = qty, Q(0), None
        while remaining > 0 and lots[isin]:
            lot = lots[isin][0]
            take = min(remaining, lot[0])
            cost += take * lot[1]
            opened = opened or lot[2]
            lot[0] -= take
            remaining -= take
            if lot[0] == 0:
                lots[isin].popleft()

        if remaining > 0:
            gaps.append((t["symbol"], t["trade_date"], remaining))
            continue        # never guess a cost basis; the caller decides

        lot = {
            "sleeve": sleeve_of(isin, t["_segment"]),
            "symbol": t["symbol"], "isin": isin, "name": t["symbol"],
            "qty": f"{qty:f}", "buy_date": opened, "exit_date": t["trade_date"],
            "invested_inr": f"{cost:.2f}", "realised_inr": f"{qty * price - cost:.2f}",
            "buy_price": f"{cost / qty:.6f}", "sell_price": f"{price:f}",
            "source": "kite-tradebook",
        }
        if opened:
            # From the oldest lot consumed, which is the FIFO answer to "how
            # long did I hold this" — the units that left are the ones bought
            # first.
            lot["holding_days"] = (
                datetime.date.fromisoformat(t["trade_date"])
                - datetime.date.fromisoformat(opened)
            ).days
        closed.append(lot)
    return closed, gaps


def post(path, payload):
    req = urllib.request.Request(
        f"{API}/api/v1{path}", method="POST", data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        return json.load(r)


def main(export_dir, allow_gaps):
    root = Path(export_dir).expanduser()
    trades = load_zerodha(root)
    if not trades:
        sys.exit(f"no tradebook-*.csv under {root}")

    dates = sorted(t["trade_date"] for t in trades)
    print(f"{len(trades)} executions, {dates[0]} to {dates[-1]}")

    # Name the missing financial years explicitly — that is what has to be
    # downloaded, and "some buys are missing" is not an actionable message.
    months = {t["trade_date"][:7] for t in trades}
    y, m, missing = int(dates[0][:4]), int(dates[0][5:7]), []
    while (y, m) <= (int(dates[-1][:4]), int(dates[-1][5:7])):
        if f"{y}-{m:02d}" not in months:
            missing.append(f"{y}-{m:02d}")
        m += 1
        if m == 13:
            y, m = y + 1, 1

    closed, gaps = fifo(trades, opening_lots(Path(__file__).parent / 'opening-lots.json'))
    if gaps:
        print(f"\n{len(gaps)} sells have no matching buys:")
        for sym, date, qty in gaps:
            print(f"    {sym:34} {date}  {qty:,.4f} units")
        if missing:
            runs, start = [], missing[0]
            for a, b in zip(missing, missing[1:] + [None]):
                if b is None or b != f"{int(a[:4]) + (a[5:7] == '12'):04d}-{(int(a[5:7]) % 12) + 1:02d}":
                    runs.append((start, a))
                    start = b
            print("\n  months with no trades at all:")
            for a, b in runs:
                print(f"    {a} to {b}" if a != b else f"    {a}")
        if not allow_gaps:
            sys.exit("\nrefusing to import: a realised figure built on half the history looks "
                     "finished while being wrong.\nDownload the missing tradebooks from Zerodha "
                     "Console (Reports -> Tradebook, one financial year at a time), drop them in "
                     "the same folder, and re-run.\nUse --allow-gaps to import only the sells that "
                     "do match.")
        print("\n--allow-gaps: importing only the sells that matched\n")

    if not closed:
        sys.exit("nothing to import")
    res = post("/trades", {"trades": closed})
    realised = sum(Q(t["realised_inr"]) for t in closed)
    print(f"\n{res['received']} closings · {res['inserted']} new · {res['updated']} updated "
          f"· ₹{realised:,.2f} realised")


if __name__ == "__main__":
    if not TOKEN:
        sys.exit("FINGOD_API_TOKEN is not set — run via `make import-tradebooks`")
    args = [a for a in sys.argv[1:] if a != "--allow-gaps"]
    if len(args) != 1:
        sys.exit('usage: import-tradebooks.py "<export dir>" [--allow-gaps]')
    main(args[0], "--allow-gaps" in sys.argv)
