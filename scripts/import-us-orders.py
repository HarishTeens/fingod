#!/usr/bin/env python3
"""Seed true rupee cost basis for US equity from the INDmoney order report.

Why this exists
---------------
INDmoney's networth_holdings.invested_amount is not the rupees you paid. It
back-converts the USD cost at a flat 92.0000 no matter when the shares were
bought -- verified identical to four decimal places across every holding,
which no blend of real purchase-date rates could produce. Actual ECB rates on
the relevant trade dates varied widely.

The consequence was not cosmetic. Trusting that field misstated the cost basis
and so inflated the reported unrealised gain by roughly half.

So this script owns the number instead: it FIFOs the broker order book and
converts every buy and sell at the rate that actually applied that day.

    make import-us-orders EXPORTS="~/Downloads/exports MF and EQ"

Reading the .xls needs xlrd 1.2.0 (2.x dropped legacy .xls support):

    pip install 'xlrd==1.2.0'

Rates come from the ECB daily reference series via api.frankfurter.dev and are
cached in scripts/us-fx-rates.json, which is gitignored (it is derived from your own trade dates). That makes a re-run
reproducible and offline: a cost basis must not silently change because a rate
provider revised history between two runs.
"""

import argparse
import collections
import datetime
import json
import os
import pathlib
import subprocess
import sys
from decimal import Decimal as D, getcontext

getcontext().prec = 34

HERE = pathlib.Path(__file__).resolve().parent
FX_CACHE = HERE / "us-fx-rates.json"
API = os.environ.get("FINGOD_API", "http://localhost:8080")
TOKEN = os.environ.get("FINGOD_API_TOKEN", "")

# Rows the importer is allowed to replace. Anything else in us_equity was put
# there by hand and is not this script's business to delete.
REPLACEABLE = {"indmoney-orders", "manual"}

# Brokerage is capitalised into the buy and netted out of the sell, so the
# basis is what left the account and the proceeds are what arrived.
NAME_HINT = {
    "ACME": "Acme Corporation",  # extend as needed; only used to label rows
}


def load_orders(path):
    """Parse the ORDER_BOOK sheet of an INDmoney order report."""
    try:
        import xlrd
    except ImportError:
        sys.exit("this needs xlrd 1.2.0 to read the .xls:\n    pip install 'xlrd==1.2.0'")

    book = xlrd.open_workbook(str(path))
    sheet = book.sheet_by_name("ORDER_BOOK")

    # The header sits below an account-details preamble whose height is not
    # guaranteed, so find it rather than hardcoding row 10.
    header_row = None
    for r in range(sheet.nrows):
        if str(sheet.cell_value(r, 0)).strip() == "Stock Name":
            header_row = r
            break
    if header_row is None:
        sys.exit(f"{path.name}: no 'Stock Name' header row — is this an INDmoney order report?")
    header = [str(sheet.cell_value(header_row, c)).strip() for c in range(sheet.ncols)]

    required = {"Stock Symbol", "Order Execution Time", "Transaction Type",
                "Quantity", "Price ($)", "Order Amount ($)"}
    missing = required - set(header)
    if missing:
        sys.exit(f"{path.name}: missing columns {sorted(missing)}")

    orders = []
    for r in range(header_row + 1, sheet.nrows):
        row = dict(zip(header, [sheet.cell_value(r, c) for c in range(sheet.ncols)]))
        sym = str(row.get("Stock Symbol", "")).strip().upper()
        if not sym:
            continue
        # "07 Apr 2025, 09:58 PM" -> settle on the calendar day; the rate series
        # is daily and an intraday timestamp adds no precision.
        stamp = str(row["Order Execution Time"]).split(",")[0].strip()
        date = datetime.datetime.strptime(stamp, "%d %b %Y").date()
        side = str(row["Transaction Type"]).strip().upper()
        if side not in ("BUY", "SELL"):
            sys.exit(f"{sym} on {date}: unknown transaction type {side!r}")
        orders.append({
            "sym": sym,
            "date": date.isoformat(),
            "side": side,
            "qty": D(str(row["Quantity"])),
            "price": D(str(row["Price ($)"])),
            "amount": D(str(row["Order Amount ($)"])),
            "fee": D(str(row.get("Brokerage ($)") or 0)),
        })
    # Buys before sells within a day: you cannot sell what that same day bought
    # if the sell is replayed first, and the report carries no intraday order.
    orders.sort(key=lambda o: (o["date"], o["side"] == "SELL", o["sym"]))
    return orders


def fetch_rates(dates):
    """Resolve USD/INR per date, cached. Never invents a rate."""
    cache = json.loads(FX_CACHE.read_text()) if FX_CACHE.exists() else {}
    fresh = 0
    for d in dates:
        if d in cache:
            continue
        url = f"https://api.frankfurter.dev/v1/{d}?base=USD&symbols=INR"
        # curl rather than urllib: the provider sits behind Cloudflare, which
        # 403s python-urllib's default user agent.
        proc = subprocess.run(["curl", "-sS", "--max-time", "30", url],
                              capture_output=True, text=True)
        if proc.returncode != 0:
            sys.exit(f"fetching the rate for {d} failed: {proc.stderr.strip()}")
        try:
            payload = json.loads(proc.stdout)
            rate = payload["rates"]["INR"]
        except (ValueError, KeyError):
            sys.exit(f"unexpected rate response for {d}: {proc.stdout[:200]}")
        cache[d] = {"usd_inr": str(rate), "as_of": payload["date"], "source": "ecb/frankfurter"}
        fresh += 1
    if fresh:
        FX_CACHE.write_text(json.dumps(dict(sorted(cache.items())), indent=1) + "\n")
        print(f"  fetched {fresh} new rate(s) into {FX_CACHE.name}")
    return cache


def fifo(orders, rates):
    """Replay the tape. Returns open positions and closed trades."""
    lots, closed, gaps = collections.defaultdict(collections.deque), [], []

    for o in orders:
        rate = D(rates[o["date"]]["usd_inr"])
        if o["side"] == "BUY":
            cost_usd = o["amount"] + o["fee"]
            lots[o["sym"]].append({
                "qty": o["qty"], "usd": cost_usd, "inr": cost_usd * rate, "date": o["date"],
            })
            continue

        proceeds_usd = o["amount"] - o["fee"]
        remaining, cost_usd, cost_inr, opened = o["qty"], D(0), D(0), None
        while remaining > 0 and lots[o["sym"]]:
            lot = lots[o["sym"]][0]
            take = min(remaining, lot["qty"])
            share = take / lot["qty"]
            cost_usd += lot["usd"] * share
            cost_inr += lot["inr"] * share
            opened = opened or lot["date"]
            lot["usd"] -= lot["usd"] * share
            lot["inr"] -= lot["inr"] * share
            lot["qty"] -= take
            remaining -= take
            if lot["qty"] <= D("1e-12"):
                lots[o["sym"]].popleft()

        if remaining > 0:
            gaps.append((o["sym"], o["date"], remaining))
            continue  # never guess a cost basis

        trade = {
            "sleeve": "us_equity",
            "symbol": o["sym"],
            "name": NAME_HINT.get(o["sym"], o["sym"]),
            "qty": f"{o['qty']:f}",
            "buy_date": opened,
            "exit_date": o["date"],
            # Prices in rupees, because invested_inr and realised_inr are, and a
            # dollar price beside a rupee total reads as a 95x error.
            "buy_price": f"{cost_inr / o['qty']:.6f}",
            "sell_price": f"{proceeds_usd * rate / o['qty']:.6f}",
            "invested_inr": f"{cost_inr:.2f}",
            "realised_inr": f"{proceeds_usd * rate - cost_inr:.2f}",
            "source": "indmoney-orders",
            "note": (f"FIFO at USD/INR {rate} on the exit; cost converted at each buy date's own rate"),
        }
        if opened:
            trade["holding_days"] = (
                datetime.date.fromisoformat(o["date"]) - datetime.date.fromisoformat(opened)
            ).days
        closed.append(trade)

    positions = []
    for sym in sorted(lots):
        qty = sum(l["qty"] for l in lots[sym])
        if qty <= D("1e-12"):
            continue
        positions.append({
            "symbol": sym,
            "qty": f"{qty:f}",
            "cost_usd": f"{sum(l['usd'] for l in lots[sym]):.2f}",
            "cost_inr": f"{sum(l['inr'] for l in lots[sym]):.2f}",
            "first_buy": min(l["date"] for l in lots[sym]),
        })
    return positions, closed, gaps


def call(method, path, payload=None):
    import urllib.error
    import urllib.request
    req = urllib.request.Request(
        f"{API}/api/v1{path}", method=method,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r:
            body = r.read()
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        sys.exit(f"{method} {path} -> {e.code}: {e.read().decode()[:400]}")


def main(export_dir, dry_run, keep_existing):
    root = pathlib.Path(export_dir).expanduser()
    reports = sorted(root.glob("IND-ORDER_REPORT*.xls")) if root.is_dir() else [root]
    if not reports:
        sys.exit(f"no IND-ORDER_REPORT*.xls under {root}")
    if len(reports) > 1:
        print(f"  {len(reports)} order reports found, using the newest: {reports[-1].name}")

    orders = load_orders(reports[-1])
    print(f"  {len(orders)} orders, {len({o['sym'] for o in orders})} symbols")

    rates = fetch_rates(sorted({o["date"] for o in orders}))
    positions, closed, gaps = fifo(orders, rates)

    if gaps:
        for sym, date, qty in gaps:
            print(f"  !! {sym} sold {qty} on {date} with no matching buy", file=sys.stderr)
        sys.exit("the order report is incomplete — re-export it covering the full history")

    used = [{"on_date": d, "usd_inr": rates[d]["usd_inr"],
             "as_of": rates[d]["as_of"], "source": rates[d]["source"]}
            for d in sorted({o["date"] for o in orders})]

    print(f"\n  open positions ({len(positions)})")
    print(f"    {'sym':7}{'qty':>14}{'cost USD':>11}{'cost INR':>14}{'buy rate':>10}")
    for p in positions:
        rate = D(p["cost_inr"]) / D(p["cost_usd"]) if D(p["cost_usd"]) else D(0)
        print(f"    {p['symbol']:7}{p['qty']:>14}{p['cost_usd']:>11}{p['cost_inr']:>14}{rate:>10.2f}")
    tot_usd = sum(D(p["cost_usd"]) for p in positions)
    tot_inr = sum(D(p["cost_inr"]) for p in positions)
    print(f"    {'TOTAL':7}{'':>14}{tot_usd:>11.2f}{tot_inr:>14.2f}{tot_inr / tot_usd:>10.2f}")
    print("    ^ compare cost USD against INDmoney's invested_value_usd; they must agree")

    print(f"\n  closed trades ({len(closed)})")
    for t in closed:
        print(f"    {t['symbol']:7}{t['buy_date']} -> {t['exit_date']}"
              f"{t['invested_inr']:>13}{t['realised_inr']:>13}")

    if dry_run:
        print("\n  dry run — nothing written")
        return

    if not TOKEN:
        sys.exit("FINGOD_API_TOKEN is not set — run via `make import-us-orders`")

    if not keep_existing:
        # The FIFO covers the whole order book, so it supersedes whatever is
        # there. Delete by id: the trades unique key includes invested_inr, so
        # a corrected cost would upsert into a second row rather than replace
        # the wrong one.
        existing = call("GET", "/realised?sleeve=us_equity").get("trades") or []
        stale = [t for t in existing if t.get("source") in REPLACEABLE]
        for t in existing:
            if t.get("source") not in REPLACEABLE:
                print(f"  keeping {t['symbol']} {t['exit_date']} (source {t['source']!r})")
        for t in stale:
            call("DELETE", f"/trades/{t['id']}")
        if stale:
            print(f"  removed {len(stale)} superseded us_equity trade(s)")

    res = call("PUT", "/us-cost-basis",
               {"positions": positions, "fx_rates": used, "source": "indmoney-orders"})
    print(f"  cost basis: {res['positions']} positions, {res['fx_rates']} rates recorded")
    if closed:
        res = call("POST", "/trades", {"trades": closed})
        print(f"  trades: {res['inserted']} inserted, {res['updated']} updated")
    print("\n  take a fresh checkpoint (/refresh) to pick the new basis up in holdings")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("exports", help="directory holding IND-ORDER_REPORT*.xls, or the file itself")
    ap.add_argument("--dry-run", action="store_true", help="print what would be written")
    ap.add_argument("--keep-existing", action="store_true",
                    help="do not delete superseded us_equity trades")
    args = ap.parse_args()
    main(args.exports, args.dry_run, args.keep_existing)
