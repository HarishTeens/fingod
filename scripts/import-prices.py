#!/usr/bin/env python3
"""Load daily closes into price_history, from a JSON file of already-fetched bars.

    make import-prices FILE=/path/to/bars.json

Kite's historical data is only reachable over MCP, which a shell script cannot
call. So the split is: Claude fetches the bars via mcp__kite__get_historical_data
and writes them here as JSON, this loads them.

Input shape -- a list of series, each with the instrument key price_history uses
(an ISIN for something owned, IDX:<name> for a benchmark):

    [
      {"instrument": "INE040A01034", "currency": "INR", "source": "kite-historical",
       "bars": [["2021-11-24", "1523.45"], ["2021-11-25", "1530.10"]]},
      {"instrument": "IDX:NIFTY50", "source": "kite-historical",
       "bars": [["2021-11-24", "17416.55"]]}
    ]

Dates are YYYY-MM-DD and closes are decimal strings -- strings, not floats, so a
price never picks up a binary rounding artefact on the way in.
"""

import argparse
import json
import os
import pathlib
import sys
import urllib.error
import urllib.request
from collections import Counter

API = os.environ.get("FINGOD_API", "http://localhost:8080")
TOKEN = os.environ.get("FINGOD_API_TOKEN", "")


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
        sys.exit(f"{method} {path} -> {e.code}: {e.read().decode()[:400]}")


def main(path, dry_run):
    data = json.loads(pathlib.Path(path).expanduser().read_text())
    if isinstance(data, dict):
        data = [data]

    prices, per = [], Counter()
    for s in data:
        inst = s["instrument"]
        for bar in s.get("bars", []):
            date, close = (bar[0], bar[1]) if isinstance(bar, list) else (bar["date"], bar["close"])
            prices.append({
                "instrument": inst, "on_date": date, "close": str(close),
                "currency": s.get("currency", "INR"),
                "source": s.get("source", "kite-historical"),
            })
            per[inst] += 1

    if not prices:
        sys.exit("no bars in that file")

    dates = [p["on_date"] for p in prices]
    print(f"  {len(prices)} bars across {len(per)} instrument(s), {min(dates)} .. {max(dates)}")
    thin = [(i, n) for i, n in per.items() if n < 30]
    if thin:
        print(f"  !! thin series (under 30 bars): {thin}", file=sys.stderr)

    if dry_run:
        print("  dry run — nothing written")
        return
    if not TOKEN:
        sys.exit("FINGOD_API_TOKEN is not set — run via `make import-prices`")

    # Chunked: five years of daily bars for sixty instruments is ~80k rows, and
    # one request that size is a timeout waiting to happen.
    total = 0
    for i in range(0, len(prices), 5000):
        res = call("POST", "/prices", {"prices": prices[i:i + 5000]})
        total += res.get("written", 0)
        print(f"    {min(i + 5000, len(prices))}/{len(prices)}")
    print(f"  written: {total}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("file", help="JSON file of fetched bars")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    main(args.file, args.dry_run)
