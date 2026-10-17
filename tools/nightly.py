#!/usr/bin/env python3
"""northbench-ops nightly health run - the night crew. v3.1 (loops).

Runs on GitHub Actions (free minutes) at 03:15 UTC daily, and on demand.
Checks the systems that must never silently die, then writes a KPI
snapshot with MACHINE-FED BUSINESS METRICS (the 10x 'automated' +
'selling' standard):

  1. COURIER   - the social courier worker answers.
  2. VAULT     - the master archive lists and its index reads intact.
  3. SHOP      - Gumroad answers and all 18 listings hold.
  4. METRICS   - revenue + sales (Gumroad API), site pageviews +
                 go-clicks (site stats), Telegram members (Bot API).

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
GUMROAD_SALES = "https://api.gumroad.com/v2/sales"
SITE_STATS = "https://northbenchshop.com/stats-8c2f19ab4e77"
TELEGRAM_API = "https://api.telegram.org/bot"
UA = "northbench-ops/1.0"


def fetch(url, headers=None, timeout=45):
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read(), round(time.time() - t0, 2)


def check_courier():
    try:
        status, body, ms = fetch(COURIER_URL)
        ok = status == 200
        # v3.2 connect-all: the courier now reports the reddit engine's
        # state on its health GET - carry it into the KPI beside revenue
        reddit = None
        try:
            reddit = json.loads(body).get("reddit")
        except Exception:
            pass
        return {"ok": ok, "detail": f"http {status} in {ms}s",
                "reddit": reddit}
    except Exception as e:
        return {"ok": False, "detail": str(e)[:160], "reddit": None}


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


def check_metrics():
    """The 10x upgrade: the business numbers, machine-fed, every night.
    Revenue + sales from Gumroad, pageviews + go-clicks from the site's
    first-party counter, Telegram members from the Bot API. Missing
    tokens degrade gracefully to 'n/a' - the run never dies."""
    m = {"revenue": None, "sales": None, "pv_yesterday": None,
         "go_yesterday": None, "telegram": None,
         "top_pages": "", "top_clicks": ""}
    tok = os.environ.get("GUMROAD_TOKEN", "")
    if tok:
        try:
            _, body, _ = fetch(GUMROAD_SALES + "?per_page=50",
                               headers={"Authorization": "Bearer " + tok})
            sales = json.loads(body).get("sales", [])
            m["sales"] = len(sales)
            m["revenue"] = sum(float(s.get("price", 0) or 0) for s in sales)
        except Exception:
            pass
    try:
        _, body, _ = fetch(SITE_STATS)
        stats = json.loads(body)
        yday = time.strftime("%Y-%m-%d", time.gmtime(time.time() - 86400))
        day = stats.get(yday) or {}
        pv = day.get("pageviews") or {}
        go = day.get("goclicks") or {}   # v3.3 BUGFIX: key is goclicks, not go
        m["pv_yesterday"] = sum((v or {}).get("n", 0) for v in pv.values()
                                if isinstance(v, dict))
        m["go_yesterday"] = sum(sum((s or {}).values() or [0])
                                for s in go.values() if isinstance(s, dict))
        # v3.3 connect-all: the movers - top pages and top channel->product
        # clicks, so content and channel decisions read from the same file
        top_pages = sorted(((k, (v or {}).get("n", 0)) for k, v in pv.items()
                            if isinstance(v, dict)), key=lambda x: -x[1])[:3]
        m["top_pages"] = ", ".join(f"{p}({n})" for p, n in top_pages if n)
        movers = []
        for slug, srcs in go.items():
            if isinstance(srcs, dict):
                for src, n in srcs.items():
                    if n: movers.append((n, f"{slug}<-{src}"))
        movers.sort(reverse=True)
        m["top_clicks"] = ", ".join(s for _, s in movers[:4])
    except Exception:
        pass
    ttok = os.environ.get("TELEGRAM_TOKEN", "")
    if ttok:
        try:
            _, body, _ = fetch(TELEGRAM_API + ttok +
                               "/getChatMemberCount?chat_id=@northbenchweekly")
            r = json.loads(body)
            if r.get("ok"):
                m["telegram"] = r.get("result")
        except Exception:
            pass
    return m


def week_rollup(metrics):
    """v3.1 - the weekly loop: every Sunday the machine writes a 7-day
    rollup with deltas against the previous Sunday. Parseable history
    line keeps state between weeks without any database."""
    if time.gmtime().tm_wday != 6:
        return None, None
    pv7 = go7 = 0
    try:
        _, body, _ = fetch(SITE_STATS)
        stats = json.loads(body)
        for i in range(1, 8):
            day = time.strftime("%Y-%m-%d", time.gmtime(time.time() - i * 86400))
            d = stats.get(day) or {}
            pv = d.get("pageviews") or {}
            go = d.get("go") or {}
            pv7 += sum((v or {}).get("n", 0) for v in pv.values() if isinstance(v, dict))
            go7 += sum((v or {}).get("n", 0) for v in go.values() if isinstance(v, dict))
    except Exception:
        pass
    prev = {"rev": None, "pv7": None, "tg": None}
    try:
        old = open("KPI.md", encoding="utf-8").read()
        for line in old.splitlines():
            if line.startswith("- WEEK "):
                parts = dict(p.split("=", 1) for p in line.split("|")[1:] if "=" in p)
                prev = {"rev": parts.get("rev"), "pv7": parts.get("pv7"), "tg": parts.get("tg")}
    except Exception:
        pass
    def delta(cur, oldv):
        try:
            return f" (vs last week: {cur - float(str(oldv).replace('$', '')):+g})"
        except Exception:
            return ""
    week_line = (f"- WEEK {time.strftime('%Y-%m-%d')} | rev={metrics['revenue'] if metrics['revenue'] is not None else 'n/a'}"
                 f" | pv7={pv7} | go7={go7} | tg={metrics['telegram'] if metrics['telegram'] is not None else 'n/a'}")
    section = [
        "## Week in numbers (auto, Sundays)",
        "",
        f"- pageviews, 7 days: {pv7}{delta(pv7, prev['pv7'])}",
        f"- site->shop clicks, 7 days: {go7}",
        f"- revenue to date: {'n/a' if metrics['revenue'] is None else '$' + str(metrics['revenue'])}",
        f"- sales to date: {'n/a' if metrics['sales'] is None else metrics['sales']}",
        f"- telegram members: {'n/a' if metrics['telegram'] is None else metrics['telegram']}{delta(metrics['telegram'] or 0, prev['tg']) if metrics['telegram'] is not None else ''}",
        "",
    ]
    return section, week_line


def main():
    now = time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime())
    courier = check_courier()
    vault = check_vault()
    shop = check_shop()
    metrics = check_metrics()
    all_ok = courier["ok"] and vault["ok"] and shop["ok"]

    fmt = lambda v, pre="": "n/a" if v is None else f"{pre}{v}"
    lines = [
        "# NORTHBENCH KPI - nightly health + business metrics",
        "",
        f"**Last run: {now}** - {'ALL SYSTEMS GO' if all_ok else 'ATTENTION NEEDED'}",
        "",
        "| system | status | detail |",
        "|---|---|---|",
        f"| courier | {'OK' if courier['ok'] else 'FAIL'} | {courier['detail']} |",
        f"| vault | {'OK' if vault['ok'] else 'FAIL'} | {vault['detail']} |",
        f"| shop | {'OK' if shop['ok'] else 'FAIL'} | {shop['detail']} |",
        "",
        "## Business metrics (machine-fed daily)",
        "",
        "| metric | value |",
        "|---|---|",
        f"| revenue to date | {fmt(metrics['revenue'], '$')} |",
        f"| sales to date | {fmt(metrics['sales'])} |",
        f"| site pageviews (yesterday) | {fmt(metrics['pv_yesterday'])} |",
        f"| site->shop clicks (yesterday) | {fmt(metrics['go_yesterday'])} |",
        f"| top pages (yesterday) | {metrics.get('top_pages') or 'n/a'} |",
        f"| channel->product clicks | {metrics.get('top_clicks') or 'n/a'} |",
        f"| telegram members | {fmt(metrics['telegram'])} |",
        f"| reddit replies today | {fmt((courier.get('reddit') or {}).get('today'))} |",
        f"| reddit karma | {(courier.get('reddit') or {}).get('karma') or 'n/a'} |",
        "",
        "Payout gate: $100 in sales revenue unlocks the 16 email workflows.",
        "",
    ]
    week_section, week_line = week_rollup(metrics)
    if week_section:
        lines.extend(week_section)
    lines.extend([
        "## History",
        "",
    ])
    # keep the last 30 history lines
    try:
        old = open("KPI.md", encoding="utf-8").read()
        hist = [l for l in old.splitlines() if l.startswith("- ")][-29:]
    except Exception:
        hist = []
    mark = "OK" if all_ok else "**ATTENTION**"
    if week_line:
        hist.append(week_line)
    lines.append(f"- {now} - {mark} (courier {'ok' if courier['ok'] else 'FAIL'}, "
                 f"vault {'ok' if vault['ok'] else 'FAIL'}, shop {'ok' if shop['ok'] else 'FAIL'}, "
                 f"revenue {fmt(metrics['revenue'], '$')}, sales {fmt(metrics['sales'])}, "
                 f"pv {fmt(metrics['pv_yesterday'])}, tg {fmt(metrics['telegram'])})")
    lines.extend(hist)
    open("KPI.md", "w", encoding="utf-8").write("\n".join(lines) + "\n")
    print("\n".join(lines[:16]))
    sys.exit(0)


if __name__ == "__main__":
    main()
