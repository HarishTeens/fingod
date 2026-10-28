#!/usr/bin/env python3
"""Fetch mutual fund NAV history from AMFI (via api.mfapi.in) into price_history.

    make fetch-mf-navs

Kite's get_historical_data covers exchange-traded instruments only -- a search
for any fund ISIN returns nothing, and mutual funds are the largest sleeve. AMFI
publishes every scheme's daily NAV and api.mfapi.in serves it as JSON keyed by a
scheme code, with the ISIN in the metadata.

Matching is on ISIN, never on name. Fund names are ambiguous in exactly the way
that matters: "Example Midcap Fund" returns four scheme codes -- regular
and direct, growth and dividend -- whose NAVs diverge by the expense ratio and,
for a dividend plan, by every payout ever made. Picking the wrong one produces a
plausible line that is quietly wrong. So a candidate is only accepted when its
isin_growth or isin_div_reinvestment equals the ISIN on the order tape.

Cached under scripts/mf-navs/ so a re-run is offline and reproducible.
"""

import json
import os
import pathlib
import subprocess
import sys
import time
import urllib.parse

HERE = pathlib.Path(__file__).resolve().parent
CACHE = HERE / "mf-navs"
API = os.environ.get("FINGOD_API", "http://localhost:8080")
TOKEN = os.environ.get("FINGOD_API_TOKEN", "")
MFAPI = "https://api.mfapi.in"


def get(url):
    # curl rather than urllib: several of these providers sit behind a CDN that
    # rejects python-urllib's default user agent outright.
    p = subprocess.run(["curl", "-sS", "--max-time", "45", url],
                       capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"{url}: {p.stderr.strip()}")
    return json.loads(p.stdout)


def api(method, path, payload=None):
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


def find_scheme(isin, name):
    """Resolve an ISIN to a scheme code, verifying by ISIN and never by name."""
    # Search on progressively shorter prefixes of the fund name: the full string
    # from a tradebook ("... - DIRECT PLAN") rarely matches AMFI's spelling.
    words = name.replace("-", " ").split()
    for n in (6, 4, 3, 2):
        if n > len(words):
            continue
        q = urllib.parse.quote(" ".join(words[:n]))
        try:
            hits = get(f"{MFAPI}/mf/search?q={q}")
        except Exception:
            continue
        for h in hits[:25]:
            code = h["schemeCode"]
            try:
                meta = get(f"{MFAPI}/mf/{code}").get("meta", {})
            except Exception:
                continue
            time.sleep(0.05)
            if isin in (meta.get("isin_growth"), meta.get("isin_div_reinvestment")):
                return code, meta.get("scheme_name", "")
    return None, None


def main():
    if not TOKEN:
        sys.exit("FINGOD_API_TOKEN is not set — run via `make fetch-mf-navs`")
    CACHE.mkdir(exist_ok=True)

    funds = api("GET", "/prices/coverage")["coverage"]
    funds = [c for c in funds if c["sleeve"] == "in_mf"]
    if not funds:
        sys.exit("no in_mf instruments in the order tape")

    prices, unresolved = [], []
    for c in funds:
        isin, label = c["instrument"], c.get("label", "")
        cached = CACHE / f"{isin}.json"
        if cached.exists():
            payload = json.loads(cached.read_text())
        else:
            code, scheme = find_scheme(isin, label or isin)
            if not code:
                unresolved.append((isin, label))
                print(f"  !! {isin}  {label[:44]:44} no AMFI scheme matched this ISIN",
                      file=sys.stderr)
                continue
            data = get(f"{MFAPI}/mf/{code}")
            payload = {"isin": isin, "scheme_code": code, "scheme_name": scheme,
                       "data": data.get("data", [])}
            cached.write_text(json.dumps(payload))
            time.sleep(0.2)

        bars = []
        for row in payload["data"]:
            # AMFI dates are DD-MM-YYYY.
            d, m, y = row["date"].split("-")
            nav = row["nav"]
            if not nav or float(nav) <= 0:
                continue  # a scheme reports 0.00000 on days it did not publish
            bars.append({"instrument": isin, "on_date": f"{y}-{m}-{d}",
                         "close": nav, "currency": "INR", "source": "amfi/mfapi"})
        prices.extend(bars)
        print(f"  {isin}  {payload['scheme_name'][:46]:46} {len(bars):>5} navs")

    if not prices:
        sys.exit("nothing resolved")

    # Only from the first trade onward: AMFI carries a decade of NAVs and
    # history before the first purchase cannot affect any series.
    first = min(o["on_date"] for o in prices)
    print(f"\n  {len(prices)} navs, {first} .. {max(o['on_date'] for o in prices)}")

    total = 0
    for i in range(0, len(prices), 5000):
        total += api("POST", "/prices", {"prices": prices[i:i + 5000]}).get("written", 0)
    print(f"  written: {total}")
    if unresolved:
        print(f"\n  unresolved ({len(unresolved)}) — these funds will be missing from history:")
        for isin, label in unresolved:
            print(f"    {isin}  {label}")


if __name__ == "__main__":
    main()
