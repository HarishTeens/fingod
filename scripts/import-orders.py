#!/usr/bin/env python3
"""Seed the order tape from every source fingod has.

    make import-orders EXPORTS="~/Downloads/exports MF and EQ"

Reads, in one pass:

  Zerodha tradebooks   tradebook-*-EQ.csv and -MF.csv. Deduped on trade_id
                       across however many overlapping exports are in the
                       directory -- 14 files carried 364 unique trades with 73
                       rows repeated. Segment EQ/MF plus the ISIN decides the
                       sleeve, the same mapping /refresh uses.
  INDmoney order book  IND-ORDER_REPORT*.xls, converted at each trade date's
                       own USD/INR from scripts/us-fx-rates.json. Needs
                       xlrd 1.2.0; skipped with a warning if absent.
  Fixed deposits       from the API, as an 'open' event per deposit.
  Bitcoin              from the latest checkpoint, as a single 'buy' at the
                       average cost -- CoinDCX has no export, so the tape
                       cannot be better than the aggregate here.

What it deliberately does NOT do is invent the events that reconcile a
position. When the tape disagrees with what is held -- a split, a dividend paid
in units -- this prints it and leaves it alone. Guessing a 5:1 split into
existence as a fabricated 'split' row would make the reconciliation report
green while making the data worse.
"""

import argparse
import collections
import csv
import datetime
import glob
import json
import os
import pathlib
import sys
import urllib.error
import urllib.request
from decimal import Decimal as D, getcontext

getcontext().prec = 34

HERE = pathlib.Path(__file__).resolve().parent
FX_CACHE = HERE / "us-fx-rates.json"
API = os.environ.get("FINGOD_API", "http://localhost:8080")
TOKEN = os.environ.get("FINGOD_API_TOKEN", "")

GOLD = {"INF204KB17I5", "INF0R8F01042"}
DEBT = {"INF0R8F01034", "INF732E01037"}


def call(method, path, payload=None):
    req = urllib.request.Request(
        f"{API}/api/v1{path}", method=method,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r:
            body = r.read()
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        sys.exit(f"{method} {path} -> {e.code}: {e.read().decode()[:500]}")


def zerodha(root):
    """Every Zerodha fill, deduped on trade_id across overlapping exports."""
    rows = {}
    files = sorted(glob.glob(str(root / "tradebook-*.csv")))
    for f in files:
        for r in csv.DictReader(open(f)):
            if r.get("trade_id"):
                rows[r["trade_id"]] = r
    if not rows:
        return [], 0

    # A few symbols ship with a blank ISIN in some exports. Without this map
    # they all collide into one bucket keyed on the empty string, which once
    # merged several unrelated instruments into a single FIFO queue.
    sym2isin = {r["symbol"]: r["isin"] for r in rows.values() if r.get("isin")}

    out = []
    for tid, r in rows.items():
        isin = r.get("isin") or sym2isin.get(r["symbol"], "")
        if r["segment"] == "MF":
            sleeve = "in_mf"
            # Holdings key mutual funds by ISIN (Kite's tradingsymbol IS the
            # ISIN), while the tradebook puts the fund name in `symbol` and
            # spells it inconsistently across exports -- the same fund
            # appears as "...FUND - DIRECT PLAN" and
            # "...FUND-DIRECT PLAN-GROWTH". Keying on the name would
            # split one position into two that each half-reconcile.
            if isin:
                r = dict(r, _name=r["symbol"])
                r["symbol"] = isin
        elif isin in GOLD:
            sleeve = "gold"
        elif isin in DEBT:
            sleeve = "debt"
        else:
            sleeve = "in_equity"
        out.append({
            "source": "kite-tradebook", "external_id": tid,
            "sleeve": sleeve, "symbol": r["symbol"], "isin": isin,
            "name": r.get("_name", ""),
            "action": "buy" if r["trade_type"] == "buy" else "sell",
            "trade_date": r["trade_date"], "qty": r["quantity"], "price": r["price"],
            "currency": "INR", "fx_rate": "1",
            "order_id": r.get("order_id", ""), "exchange": r.get("exchange", ""),
            "raw": r,
        })
    return out, len(files)


def indmoney(root):
    """The US order book, converted at each trade date's own rate."""
    reports = sorted(glob.glob(str(root / "IND-ORDER_REPORT*.xls")))
    if not reports:
        return []
    try:
        import xlrd
    except ImportError:
        print("  !! xlrd not installed — US orders skipped. `pip install 'xlrd==1.2.0'`",
              file=sys.stderr)
        return []
    if not FX_CACHE.exists():
        print(f"  !! {FX_CACHE.name} missing — run `make import-us-orders` first to fetch rates",
              file=sys.stderr)
        return []
    fx = json.loads(FX_CACHE.read_text())

    sheet = xlrd.open_workbook(reports[-1]).sheet_by_name("ORDER_BOOK")
    header_row = next((r for r in range(sheet.nrows)
                       if str(sheet.cell_value(r, 0)).strip() == "Stock Name"), None)
    if header_row is None:
        print(f"  !! {pathlib.Path(reports[-1]).name}: no header row, skipped", file=sys.stderr)
        return []
    hdr = [str(sheet.cell_value(header_row, c)).strip() for c in range(sheet.ncols)]

    out, missing = [], set()
    for i in range(header_row + 1, sheet.nrows):
        row = dict(zip(hdr, [sheet.cell_value(i, c) for c in range(sheet.ncols)]))
        sym = str(row.get("Stock Symbol", "")).strip().upper()
        if not sym:
            continue
        date = datetime.datetime.strptime(
            str(row["Order Execution Time"]).split(",")[0].strip(), "%d %b %Y").date().isoformat()
        if date not in fx:
            missing.add(date)
            continue
        # The broker reference is per order and unique; it is the only stable id
        # the report offers.
        ref = str(row.get("Broker Reference Id") or f"{sym}-{date}-{i}").strip()
        out.append({
            "source": "indmoney-orders", "external_id": ref,
            "sleeve": "us_equity", "symbol": sym,
            "name": str(row.get("Stock Name", "")).strip(),
            "action": "buy" if str(row["Transaction Type"]).strip().upper() == "BUY" else "sell",
            "trade_date": date, "qty": str(row["Quantity"]), "price": str(row["Price ($)"]),
            "currency": "USD", "fx_rate": fx[date]["usd_inr"],
            "fees": str(row.get("Brokerage ($)") or 0),
            "raw": {k: str(v) for k, v in row.items()},
        })
    if missing:
        print(f"  !! no cached rate for {sorted(missing)} — those orders skipped", file=sys.stderr)
    return out


def opening_lots():
    """Units that exist with no purchase in any tradebook.

    Only what is documented and independently corroborated in
    scripts/opening-lots.json (see opening-lots.example.json) -- e.g. a demerger,
    whose per-share cost is derived from the broker's own apportionment. These are recorded as transfer_in because that is
    what happened: the shares arrived without being bought.
    """
    path = HERE / "opening-lots.json"
    if not path.exists():
        return []
    out = []
    for lot in json.loads(path.read_text()).get("lots", []):
        out.append({
            "source": "opening-lot", "external_id": f"{lot['isin']}-{lot['date']}",
            "sleeve": "in_equity", "symbol": lot["symbol"], "isin": lot["isin"],
            "action": "transfer_in", "trade_date": lot["date"],
            "qty": lot["qty"], "price": lot["cost_per_unit"],
            "currency": "INR", "fx_rate": "1",
            "note": " ".join(lot.get("why", []))[:500],
            "raw": lot,
        })
    return out


def deposits_and_btc():
    """FDs as 'open' events; Bitcoin as a single buy at its average cost."""
    out = []
    for fd in call("GET", "/fixed-deposits").get("fixed_deposits", []):
        out.append({
            "source": "manual", "external_id": f"fd-{fd['id']}",
            "sleeve": "fd", "symbol": f"{fd['bank']} FD {fd['id']}",
            "name": f"{fd['bank']} {fd['rate_pct']}% to {fd['maturity_date']}",
            "action": "open", "trade_date": fd["start_date"],
            # A deposit has a principal, not a unit price: one unit priced at
            # the whole principal keeps qty x price the amount that went in.
            "qty": "1", "price": str(fd["principal"]),
            "currency": "INR", "fx_rate": "1",
            "note": fd.get("note", ""), "raw": fd,
        })

    cps = call("GET", "/checkpoints").get("checkpoints", [])
    if cps:
        latest = max(c["as_of_date"] for c in cps)
        for h in call("GET", f"/checkpoints/{latest}").get("holdings", []):
            if h["sleeve"] != "btc" or not h.get("avg_cost"):
                continue
            out.append({
                "source": "manual", "external_id": f"btc-{h['symbol']}-opening",
                "sleeve": "btc", "symbol": h["symbol"], "name": h.get("name", ""),
                "action": "buy",
                # No purchase date exists anywhere: CoinDCX has no export and the
                # position arrived as an aggregate. The first checkpoint that saw
                # it is the earliest defensible date, and the note says so rather
                # than letting a made-up date look like a real one.
                "trade_date": min(c["as_of_date"] for c in cps),
                "qty": h["qty"], "price": h["avg_cost"],
                "currency": "INR", "fx_rate": "1",
                "note": "opening position — CoinDCX has no export, so this is the "
                        "aggregate average cost, not a real purchase event",
                "raw": h,
            })
    return out


def main(export_dir, dry_run):
    root = pathlib.Path(export_dir).expanduser()
    if not root.is_dir():
        sys.exit(f"not a directory: {root}")
    if not TOKEN:
        sys.exit("FINGOD_API_TOKEN is not set — run via `make import-orders`")

    zer, nfiles = zerodha(root)
    print(f"  zerodha   {len(zer):>4} fills from {nfiles} file(s)")
    us = indmoney(root)
    print(f"  indmoney  {len(us):>4} orders")
    man = deposits_and_btc()
    print(f"  manual    {len(man):>4} (deposits + bitcoin)")
    lots = opening_lots()
    print(f"  opening   {len(lots):>4} documented lot(s) with no purchase on any tape")

    orders = zer + us + man + lots
    if not orders:
        sys.exit("nothing to import")

    by = collections.Counter(o["sleeve"] for o in orders)
    act = collections.Counter(o["action"] for o in orders)
    dates = [o["trade_date"] for o in orders]
    print(f"\n  {len(orders)} events, {dates and min(dates)} .. {dates and max(dates)}")
    print(f"  sleeves: {dict(by)}")
    print(f"  actions: {dict(act)}")

    if dry_run:
        print("\n  dry run — nothing written")
        return

    res = call("POST", "/orders", {"orders": orders})
    print(f"\n  imported: {res['inserted']} new, {res['updated']} updated")

    rec = call("GET", "/orders/reconcile")
    print(f"\n  reconciliation: {rec['reconciled']} agree, {rec['problems']} do not")
    for p in rec["positions"]:
        if p["status"] == "ok":
            continue
        print(f"    {p['sleeve']:10}{p['symbol']:14} tape {p['net_qty']:>14} "
              f"held {p['held_qty']:>14}   {p['status']}")
    if rec["problems"]:
        print("\n  These are real events, not import bugs. Each one is a quantity that "
              "\n  moved without a trade — resolve by adding the actual corporate action, "
              "\n  not by editing the tape.")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("exports", help="directory holding the tradebook CSVs and the IND .xls")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    main(args.exports, args.dry_run)
