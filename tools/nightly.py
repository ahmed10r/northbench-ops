#!/usr/bin/env python3
"""northbench-ops nightly health run - the night crew.

Runs on GitHub Actions (free minutes) at 03:15 UTC daily, and on demand.
Checks the three systems that must never silently die, then writes a
KPI snapshot the whole team (one agent, one owner) can read:

  1. COURIER   - the social courier worker answers.
  2. VAULT     - the master archive lists and its index reads intact.
  3. SHOP      - Gumroad answers and the product count holds >= 18.

Output: KPI.md updated in this repo (committed by the workflow).
Everything is graceful: a failed check is recorded, never crashes the
run - the report IS the alarm.
"""
import json
import os
import sys
import time
import urllib.request

COURIER_URL = "https://northbench-courier.a7maaadesmail93.workers.dev/"
VAULT_URL = "https://nb-vault.a7maaadesmail93.workers.dev"
GUMROAD_API = "https://api.gumroad.com/v2/products"
UA = "northbench-ops/1.0"


def fetch(url, headers=None, timeout=45):
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read(), round(time.time() - t0, 2)


def check_courier():
    try:
        status, body, ms = fetch(COURIER_URL)
        text = body.decode("utf-8", "ignore")[:200]
        ok = status == 200
        return {"ok": ok, "detail": f"http {status} in {ms}s", "hint": text[:120]}
    except Exception as e:
        return {"ok": False, "detail": str(e)[:160]}


def check_vault():
    key = os.environ.get("VAULT_KEY", "")
    if not key:
        return {"ok": False, "detail": "no VAULT_KEY secret set"}
    try:
        status, body, ms = fetch(f"{VAULT_URL}/list?prefix=nb/",
                                 headers={"X-Vault-Key": key})
        keys = json.loads(body)
        index_ok = False
        if "nb/archive/INDEX.json" in keys:
            s2, idx, _ = fetch(f"{VAULT_URL}/kv/nb%2Farchive%2FINDEX.json",
                               headers={"X-Vault-Key": key})
            index_ok = s2 == 200 and b"NORTHBENCH" in idx
        return {"ok": status == 200 and index_ok,
                "detail": f"{len(keys)} keys, index {'intact' if index_ok else 'MISSING'}, {ms}s"}
    except Exception as e:
        return {"ok": False, "detail": str(e)[:160]}


OUR_SLUGS = [
    "calc-pack", "clientos", "contentengine", "eventplan", "freelance-os",
    "habitledger", "jobhunt", "launchkit", "listinglab", "money-os",
    "moneymap", "outreachkit", "prompt-sampler", "promptvault", "proposals",
    "storeeye", "tutoros", "wholeshelf",
]  # the 18 Northbench tools listings


def check_shop():
    """Gumroad's products API ignores paging on this account (returns the
    same first 10 for every page), so the honest health check is: do all
    18 of our listings answer? We hit each public short link and count
    200s. A listing that 404s is a listing that died - that is the alarm."""
    ok_count, missing = 0, []
    for slug in OUR_SLUGS:
        try:
            status, _, _ = fetch(f"https://gumroad.com/l/{slug}", timeout=30)
            if status in (200, 301, 302):
                ok_count += 1
            else:
                missing.append(f"{slug}({status})")
        except Exception as e:
            missing.append(f"{slug}(err)")
    return {"ok": ok_count == len(OUR_SLUGS),
            "detail": f"{ok_count}/{len(OUR_SLUGS)} listings answer"
                      + (f" - MISSING: {', '.join(missing)}" if missing else "")}


def main():
    now = time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime())
    courier = check_courier()
    vault = check_vault()
    shop = check_shop()
    all_ok = courier["ok"] and vault["ok"] and shop["ok"]

    lines = [
        "# NORTHBENCH KPI - nightly health",
        "",
        f"**Last run: {now}** - {'ALL SYSTEMS GO' if all_ok else 'ATTENTION NEEDED'}",
        "",
        "| system | status | detail |",
        "|---|---|---|",
        f"| courier | {'OK' if courier['ok'] else 'FAIL'} | {courier['detail']} |",
        f"| vault | {'OK' if vault['ok'] else 'FAIL'} | {vault['detail']} |",
        f"| shop | {'OK' if shop['ok'] else 'FAIL'} | {shop['detail']} |",
        "",
        "## History",
        "",
    ]
    # keep the last 30 history lines
    try:
        old = open("KPI.md", encoding="utf-8").read()
        hist = [l for l in old.splitlines() if l.startswith("- ")][-29:]
    except Exception:
        hist = []
    mark = "OK" if all_ok else "**ATTENTION**"
    lines.append(f"- {now} - {mark} (courier {'ok' if courier['ok'] else 'FAIL'}, "
                 f"vault {'ok' if vault['ok'] else 'FAIL'}, shop {'ok' if shop['ok'] else 'FAIL'})")
    lines.extend(hist)
    open("KPI.md", "w", encoding="utf-8").write("\n".join(lines) + "\n")
    print("\n".join(lines[:12]))
    sys.exit(0)


if __name__ == "__main__":
    main()
