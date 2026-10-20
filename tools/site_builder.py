#!/usr/bin/env python3
"""site_builder - the auto-builder that keeps northbenchshop.com up to date.

Reads shop/landing/site-data.json (the single source of truth) and regenerates
the data-driven pages:

    landing/index.html        the homepage (catalog + guides + free lanes)
    landing/guides/index.html the guides library
    landing/sitemap.xml       every page on the site, walked from the tree

Hand-written pages (guides bodies, q/, free/, calcs/) are never touched -
the builder only owns the pages a data change should move. Add a product or
guide to site-data.json, run this, deploy: the site is current.

Usage (from the shop root):
    python3 tools/site_builder.py            regenerate + report
    python3 tools/site_builder.py --check    exit 2 if on-disk pages drift
                                             from what the data says (nightly
                                             uses this to self-heal)
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SHOP = os.path.dirname(HERE)
LANDING = os.environ.get("NB_LANDING") or os.path.join(SHOP, "shop", "landing")
DATA = os.path.join(LANDING, "site-data.json")

CSS = """
:root{--ink:#1A1A18;--paper:#F6F3EC;--amber:#C68A2A;--mut:#6f6a60;--line:#ddd6c8}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;font:16px/1.65 -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:var(--ink);background:var(--paper)}
.wrap{max-width:1120px;margin:0 auto;padding:0 22px}
.serif{font-family:Georgia,'Times New Roman',serif}
a{color:var(--ink);text-decoration:none;border-bottom:2px solid var(--amber)}
a:hover{color:var(--amber)}
header{padding:64px 0 40px;border-bottom:3px solid var(--ink)}
.brand{display:flex;align-items:baseline;gap:16px;flex-wrap:wrap}
.brand h1{font-size:clamp(34px,6vw,64px);letter-spacing:2px;margin:0;font-weight:700}
.brand .tag{font-size:15px;letter-spacing:3px;text-transform:uppercase;color:var(--amber);font-weight:700}
.lede{max-width:64ch;font-size:19px;margin:18px 0 0;color:#3c382f}
.badges{display:flex;gap:10px;flex-wrap:wrap;margin:24px 0 0}
.badges span{font-size:13px;letter-spacing:.4px;border:1.5px solid var(--ink);padding:5px 12px;border-radius:999px;background:#fff}
section{padding:52px 0 8px}
.kicker{font-size:13px;letter-spacing:3px;text-transform:uppercase;color:var(--amber);font-weight:700;margin:0 0 6px}
h2{font-size:clamp(24px,3.4vw,34px);margin:0 0 10px;font-weight:700}
.sub{max-width:60ch;color:var(--mut);margin:0 0 26px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(235px,1fr));gap:20px}
.card{background:#fff;border:1.5px solid var(--line);border-radius:10px;overflow:hidden;display:flex;flex-direction:column;transition:border-color .15s}
.card:hover{border-color:var(--ink)}
.card img{width:100%;aspect-ratio:16/9;object-fit:cover;display:block;background:#eee}
.card .body{padding:14px 16px 16px;display:flex;flex-direction:column;gap:6px;flex:1}
.card .name{font-size:16.5px;font-weight:700;line-height:1.3}
.card .one{font-size:13.5px;color:var(--mut);flex:1}
.card .row{display:flex;align-items:center;justify-content:space-between;margin-top:6px}
.price{font-weight:700;font-size:15px}
.price.free{color:#1d7a3e}
.buy{font-size:13.5px;font-weight:700;letter-spacing:.5px;border-bottom:2px solid var(--amber);padding-bottom:1px}
.card:hover .buy{color:var(--amber)}
.bundle{margin-top:26px;border:2.5px solid var(--ink);border-radius:12px;padding:26px 26px 22px;display:flex;gap:26px;align-items:center;background:#fff;flex-wrap:wrap}
.bundle img{width:230px;border-radius:6px;border:1.5px solid var(--line)}
.bundle .b2{flex:1;min-width:250px}
.bundle h3{margin:0 0 6px;font-size:22px}
.bundle p{margin:0 0 14px;color:var(--mut);max-width:56ch}
.lanes{display:grid;grid-template-columns:repeat(auto-fill,minmax(235px,1fr));gap:20px}
.lane{background:#fff;border:1.5px dashed var(--amber);border-radius:10px;padding:18px 18px 16px;display:flex;flex-direction:column;gap:8px}
.lane .t{font-weight:700;font-size:16.5px}
.lane .o{font-size:13.5px;color:var(--mut);flex:1}
.lane a{font-size:13.5px;font-weight:700;letter-spacing:.5px}
.gcard{background:#fff;border:1.5px solid var(--line);border-radius:10px;padding:16px 18px;display:flex;flex-direction:column;gap:7px}
.gcard:hover{border-color:var(--ink)}
.gcard .t{font-weight:700;font-size:16px;line-height:1.35}
.gcard .o{font-size:13.5px;color:var(--mut);flex:1}
.gcard .r{font-size:13px;font-weight:700;letter-spacing:.5px;color:var(--amber)}
.orbital{display:grid;grid-template-columns:1.05fr .95fr;gap:34px;align-items:center}
.orbital .art{display:grid;grid-template-columns:1.6fr 1fr;gap:12px}
.orbital .art img{width:100%;border-radius:8px;border:1.5px solid var(--line);display:block}
.orbital p{max-width:56ch}
.orbital .when{font-size:14px;letter-spacing:2px;text-transform:uppercase;color:var(--amber);font-weight:700}
@media(max-width:820px){.orbital{grid-template-columns:1fr}}
.promise{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:18px;margin-top:8px}
.promise div{border-top:3px solid var(--amber);padding-top:12px}
.promise b{display:block;margin-bottom:4px}
.promise p{margin:0;font-size:14px;color:var(--mut)}
.band{margin:56px 0 0;background:var(--ink);color:var(--paper);border-radius:14px;padding:38px 30px;text-align:center}
.band h3{font-size:clamp(20px,3vw,28px);margin:0 0 10px}
.band p{margin:0 0 18px;color:#cfc9bb}
.band a{color:#fff;border-bottom:2px solid var(--amber)}
footer{padding:44px 0 60px;color:var(--mut);font-size:14px}
footer .cols{display:flex;gap:40px;flex-wrap:wrap;justify-content:space-between;border-top:1.5px solid var(--line);padding-top:24px}
footer b{color:var(--ink);letter-spacing:2px}
.code{display:inline-block;border:1.5px dashed var(--amber);color:var(--ink);font-weight:700;letter-spacing:1.5px;padding:4px 12px;border-radius:6px;margin-top:8px}
""".strip()

PROMISE = """
      <div><b>Files, not accounts</b><p>Everything you buy is a file you keep. Works
      offline, forever. If we vanish, your tools still work.</p></div>
      <div><b>No subscriptions</b><p>Pay once. Free updates for the life of the
      product. We will never charge you rent on something you own.</p></div>
      <div><b>14-day refunds</b><p>No reason needed. If it is not for you, it is not
      for you - we would rather return your money than keep it badly.</p></div>
      <div><b>Made to keep</b><p>Plain language, honest structure, nothing clever
      enough to break. The boring parts are the durable parts.</p></div>
"""

ORBITAL = """
<section id=orbital>
  <div class=wrap>
    <p class=kicker>The series - in production</p>
    <h2 class=serif>ORBITAL - a thriller told in silence</h2>
    <div class=orbital>
      <div>
        <p>Low orbit is a workplace. A four-person salvage crew catches a
        decommissioned satellite that has been dead for thirty years - except its
        transmitter is warm, and it is spelling one name in old commercial morse:
        the name of the newest member of their crew.</p>
        <p style="margin-top:12px">Season One: ten episodes of precision line art, one
        electric blue, no sound in vacuum. Episode One is finished and in review;
        the season follows.</p>
        <p class=when style="margin-top:18px">Coming - Episode One will be free</p>
      </div>
      <div class=art>
        <img src=assets/orbital/cover.png alt="ORBITAL Season One cover">
        <img src=assets/orbital/splash.png alt="ORBITAL splash page">
      </div>
    </div>
  </div>
</section>
"""


def h(s):
    return (s or "").replace("&", "&amp;").replace("<", "&lt;")


def card(p):
    free = ' style="border-style:dashed"' if p.get("free") else ""
    price_cls = ' class="price free"' if p.get("free") else ' class="price"'
    label = "Get it" if p.get("free") else "Buy"
    href = p["href"] if "href" in p else "/go/%s?src=home" % p["slug"]
    return ('      <div class=card%s><img src=assets/covers/%s.png alt="%s">\n'
            '        <div class=body><div class=name>%s</div>\n'
            '        <div class=one>%s</div>\n'
            '        <div class=row><span%s>%s</span><a class=buy href="%s">%s &rarr;</a></div></div></div>'
            % (free, p["slug"], h(p["name"]), h(p["name"]), h(p["one"]),
               price_cls, h(p["price"]), href, label))


def section_grid(sec, products_by_slug):
    cards = "\n".join(card(products_by_slug[s]) for s in sec["slugs"])
    kicker = '<p class=kicker>%s</p>\n    ' % sec["kicker"] if sec.get("kicker") else ""
    return ('<section%s>\n  <div class=wrap>\n    %s<h2 class=serif>%s</h2>\n'
            '    <p class=sub>%s</p>\n    <div class=grid>\n%s\n    </div>\n  </div>\n</section>'
            % (' id="%s"' % sec["id"] if sec.get("id") else "",
               kicker, h(sec["title"]), h(sec["sub"]), cards))


def build_index(data):
    by_slug = {p["slug"]: p for p in data["products"]}
    parts = []
    parts.append("""<!doctype html>
<html lang=en>
<head>
<meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Northbench - tools and stories, made to keep</title>
<meta name=description content="Tools and stories for people who work for themselves: 40+ plain-English templates and trackers, plus free weekly fiction - UNSENT, The Frequency, The Story Club. The Club: everything for $7/month.">
<link rel=canonical href="https://northbenchshop.com/">
<meta property="og:title" content="Northbench - tools and stories, made to keep">
<meta property="og:description" content="40+ working templates and trackers, plus free weekly fiction: UNSENT, The Frequency, The Story Club. The Club membership: everything for $7/month.">
<meta property="og:type" content="website">
<meta property="og:url" content="https://northbenchshop.com/">
<meta property="og:image" content="https://northbenchshop.com/avatar.png">
<meta name=twitter:card content="summary">
<meta name=twitter:image content="https://northbenchshop.com/avatar.png">
<style>
""" + CSS + """
</style>
</head>
<body>
<header>
  <div class=wrap>
    <div class="brand serif">
      <h1>NORTHBENCH</h1>
      <span class=tag>Made to keep</span>
    </div>
    <p class=lede>Plain, durable files for people who work for themselves - and patient
    stories worth the paper they would be printed on. No logins, free updates, 14-day refunds,
    no rent on tools you already bought.</p>
    <div class=badges>
      <span>Files you keep</span><span>Free updates</span><span>14-day refunds</span><span>30% off with NORTHBENCH30</span>
    </div>
  </div>
</header>
""")
    # the three catalog sections
    for sec in data["sections"]:
        parts.append(section_grid(sec, by_slug))
        if sec["id"] == "money":
            ws = by_slug["wholeshelf"]
            parts.append("""
    <div class=bundle>
      <img src=assets/covers/wholeshelf.png alt="The Whole Shelf">
      <div class=b2>
        <h3 class=serif>%s - everything, one download</h3>
        <p>%s</p>
        <div class=row style="display:flex;align-items:center;gap:18px">
          <span class=price style="font-size:20px">%s</span>
          <a class=buy href="/go/wholeshelf?src=home">Buy the Shelf &rarr;</a>
        </div>
      </div>
    </div>
""" % (h(ws["name"]), h(ws["one"]), h(ws["price"])))
    # the free shelf
    lanes = []
    for ln in data["free_lanes"]:
        lanes.append('      <div class=lane><div class=t>%s</div>\n'
                     '      <div class=o>%s</div>\n'
                     '      <a href="%s">Open &rarr;</a></div>'
                     % (h(ln["title"]), h(ln["one"]), ln["href"]))
    parts.append("""
<section id=free>
  <div class=wrap>
    <p class=kicker>The free shelf</p>
    <h2 class=serif>Free, and no email wall</h2>
    <p class=sub>Everything below is free with no signup. It is the honest half of the shop -
    use it forever, or use it to decide whether the working files are for you.</p>
    <div class=lanes>
%s
    </div>
  </div>
</section>
""" % "\n".join(lanes))
    # the guides library
    gcards = []
    for g in data["guides"]:
        gcards.append('      <div class=gcard><div class=t>%s</div>\n'
                      '      <div class=o>%s</div>\n'
                      '      <a class=r href="/guides/%s">Read the guide &rarr;</a></div>'
                      % (h(g["title"]), h(g["one"]), g["slug"]))
    parts.append("""
<section id=guides>
  <div class=wrap>
    <p class=kicker>The guides</p>
    <h2 class=serif>Plain-words guides, free</h2>
    <p class=sub>Short, honest systems for the jobs people actually have - pricing, proposals,
    cold email, habits, budgets, launches. Each one links to the working files if you want them;
    none of them requires one.</p>
    <div class=grid>
%s
    </div>
  </div>
</section>
""" % "\n".join(gcards))
    parts.append(ORBITAL)
    parts.append("""
<section>
  <div class=wrap>
    <p class=kicker>Why Northbench</p>
    <h2 class=serif>What we promise</h2>
    <div class=promise>
""" + PROMISE + """    </div>
  </div>
</section>

<div class=band>
  <div class=wrap>
    <h3 class=serif>Start with the free sampler</h3>
    <p>Fourteen working AI prompts, no email wall, no strings. One useful note a
    week on Telegram - new tools land there first.</p>
    <p style="margin-bottom:0">
      <a href="https://northbenchshop.gumroad.com/l/prompt-sampler">Get the free sampler</a>
      &nbsp;&middot;&nbsp;
      <a href="https://t.me/northbenchweekly">t.me/northbenchweekly</a>
    </p>
  </div>
</div>

<footer>
  <div class="wrap cols">
    <div>
      <b>NORTHBENCH</b><br>
      northbenchshop.com<br>
      Made to keep.
    </div>
    <div>
      <b>Elsewhere</b><br>
      <a href="https://t.me/northbenchweekly">Telegram</a><br>
      <a href="https://bsky.app/profile/northbench.bsky.social">Bluesky</a><br>
      <a href="https://northbenchshop.gumroad.com">The shop</a>
    </div>
    <div>
      <b>Early-days pricing</b><br>
      Everything, every day:<br>
      <span class=code>NORTHBENCH30</span>
    </div>
  </div>
</footer>
</body>
</html>
""")
    return "".join(parts)


GUIDE_CSS = """
:root{--ink:#1A1A18;--paper:#F6F3EC;--amber:#C68A2A;--mut:#6f6a60;--line:#ddd6c8}
*{box-sizing:border-box}body{margin:0;font:17px/1.7 -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:var(--ink);background:var(--paper)}
.wrap{max-width:760px;margin:0 auto;padding:24px 22px 80px}
.kicker{font-size:13px;letter-spacing:3px;text-transform:uppercase;color:var(--amber);font-weight:700}
h1{font-family:Georgia,serif;font-size:clamp(28px,5vw,42px);line-height:1.15;margin:8px 0 18px}
h2{font-family:Georgia,serif;font-size:24px;margin:38px 0 10px}
a{color:var(--ink);border-bottom:2px solid var(--amber);text-decoration:none}
.g{border:1.5px solid var(--line);background:#fff;border-radius:10px;padding:16px 18px;margin:14px 0}
.g .t{font-weight:700;font-size:17px}
.g .o{font-size:14px;color:var(--mut);margin:4px 0 8px}
.g a{font-size:13.5px;font-weight:700;letter-spacing:.4px}
footer{border-top:1.5px solid var(--line);margin-top:50px;padding-top:18px;color:var(--mut);font-size:14px}
""".strip()


def build_guides_index(data):
    rows = "\n".join(
        '<div class=g><div class=t>%s</div><div class=o>%s</div>'
        '<a href="/guides/%s">Read the guide &rarr;</a></div>'
        % (h(g["title"]), h(g["one"]), g["slug"]) for g in data["guides"])
    return """<!doctype html>
<html lang=en>
<head>
<meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Free guides - Northbench</title>
<meta name=description content="Free, plain-words guides: pricing freelance work, proposals that get signed, cold email, habit trackers, household budgets, AI prompts, event planning, product launches. No email wall.">
<link rel=canonical href="https://northbenchshop.com/guides/">
<style>
""" + GUIDE_CSS + """
</style>
</head>
<body>
<div class=wrap>
<p class=kicker>Free guides - Northbench</p>
<h1>Plain-words guides, free</h1>
<p>Short, honest systems for real jobs. No email wall, no signup - read them here,
keep them if they help. Each guide links to the working files if you want them;
none of them requires you to buy anything.</p>
""" + rows + """
<footer>
NORTHBENCH - made to keep - NORTHBENCH30 takes 30% off everything at <a href="https://northbenchshop.com/">the shop</a>.
</footer>
</div>
</body>
</html>
"""


def build_sitemap(data):
    site = data["site"]
    urls = set()
    for root, dirs, files in os.walk(LANDING):
        dirs[:] = [d for d in dirs if d not in ("assets", "pins")]
        for f in sorted(files):
            if not f.endswith(".html") or f.startswith("google"):
                continue
            rel = os.path.relpath(os.path.join(root, f), LANDING)
            rel = rel.replace(os.sep, "/")
            if f == "index.html":
                u = site + "/" + (os.path.dirname(rel) + "/" if os.path.dirname(rel) else "")
            else:
                u = site + "/" + rel[:-5]
            urls.add(u)
    urls = sorted(urls)
    body = "\n".join("  <url><loc>%s</loc></url>" % u for u in urls)
    return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n%s\n</urlset>\n' % body, len(urls)


def main():
    check = "--check" in sys.argv
    data = json.load(open(DATA, encoding="utf-8"))
    products = data["products"]
    guides = data["guides"]
    assert len(products) >= 18, "product data incomplete"
    assert len(guides) >= 1, "guide data incomplete"

    outputs = {
        os.path.join(LANDING, "index.html"): build_index(data),
        os.path.join(LANDING, "guides", "index.html"): build_guides_index(data),
    }
    smap, n = build_sitemap(data)
    outputs[os.path.join(LANDING, "sitemap.xml")] = smap

    # craft pass: the rendered page must contain every product and guide
    idx = outputs[os.path.join(LANDING, "index.html")]
    for p in products:
        assert 'alt="%s"' % p["name"] in idx or p["slug"] == "wholeshelf", "missing product card: " + p["slug"]
    for g in guides:
        assert "/guides/%s" % g["slug"] in idx, "missing guide link: " + g["slug"]
    assert idx.count("</html>") == 1 and n >= 90, "structure check failed"

    drift = False
    for path, content in outputs.items():
        os.makedirs(os.path.dirname(path), exist_ok=True)
        old = open(path, encoding="utf-8").read() if os.path.exists(path) else None
        if old != content:
            drift = True
            if check:
                print("DRIFT: %s" % os.path.relpath(path, LANDING))
            else:
                open(path, "w", encoding="utf-8").write(content)
                print("regenerated: %s" % os.path.relpath(path, LANDING))
    print("sitemap: %d urls | products: %d | guides: %d" % (n, len(products), len(guides)))
    if check and drift:
        sys.exit(2)
    if not check:
        print("site is up to date with site-data.json")


if __name__ == "__main__":
    main()
