#!/usr/bin/env python3
"""Deploy the shop's landing site to Cloudflare Workers static assets.

The Netlify substitute: no metered credits, no 300-build month, no waiting for a
reset. Free static serving on the workers.dev subdomain, deployed from here.

The one prerequisite is a Cloudflare API token with Workers Scripts:Edit and
Account Settings:Read (the same token that deploys the courier). Until that
token exists, `deploy` fails honestly and `dryrun` shows exactly what would go.

Commands:
    python3 tools/cf_site.py dryrun     list the files and the manifest, no network
    python3 tools/cf_site.py deploy     create/update the worker + upload assets
    python3 tools/cf_site.py status     show the worker, its assets, and the URL

Credentials are read from crypto-rail/ (cf-token.txt, cf-account.txt) and are
never printed.
"""
from __future__ import annotations

import base64
import hashlib
import json
import mimetypes
import os
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SHOP = os.path.dirname(HERE)
RAIL = os.path.join(os.path.dirname(SHOP), "crypto-rail")
SITE = os.environ.get("NB_LANDING") or os.path.join(SHOP, "shop", "landing")
WORKER = "northbench-site"
API = os.environ.get("CF_API_BASE", "https://api.cloudflare.com/client/v4")
# the food file is served by the site and fetched by the courier; it ships too
SKIP_NAMES = {"__pycache__", ".DS_Store"}

mimetypes.add_type("application/manifest+json", ".webmanifest")


def die(msg, code=1):
    print(msg)
    sys.exit(code)


def creds():
    tok = os.path.join(RAIL, "cf-token.txt")
    acct = os.path.join(RAIL, "cf-account.txt")
    if os.path.exists(tok) and os.path.exists(acct):
        token = open(tok, encoding="utf-8").read().strip()
        account = open(acct, encoding="utf-8").read().strip()
    else:
        # runner mode: the ops repo carries the credentials as secrets
        token = os.environ.get("CF_TOKEN", "")
        account = os.environ.get("CF_ACCOUNT", "")
    if not token or not account:
        die("no Cloudflare credentials: crypto-rail files or CF_TOKEN/CF_ACCOUNT env.", 2)
    return token, account


def call(path, token, payload=None, method="GET", raw=False):
    url = f"{API}{path}"
    data = None
    headers = {"Authorization": f"Bearer {token}"}
    if payload is not None:
        if raw:
            data = payload
        else:
            data = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as r:
            body = r.read()
    except urllib.error.HTTPError as e:
        try:
            err = json.loads(e.read().decode("utf-8", "replace"))
            msg = json.dumps(err.get("errors") or err)[:500]
        except Exception:
            msg = e.read().decode("utf-8", "replace")[:500] if e.fp else str(e)
        raise SystemExit(f"HTTP {e.code} on {method} {path}\n  {msg}")
    return json.loads(body.decode("utf-8"))


def site_files():
    """Every file under shop/landing, as (web path, bytes)."""
    out = []
    for root, dirs, names in os.walk(SITE):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_NAMES)
        for name in sorted(names):
            if name in SKIP_NAMES:
                continue
            full = os.path.join(root, name)
            rel = os.path.relpath(full, SITE).replace(os.sep, "/")
            with open(full, "rb") as fh:
                out.append(("/" + rel, fh.read()))
    # the /go/ redirector needs the slug -> buy URL map; in the shop it rides
    # from release/, in the ops repo a copy lives inside the landing tree and
    # the walk above already ships it as /buy-links.json
    links = os.path.join(SHOP, "release", "buy-links.json")
    if os.path.exists(links) and not any(p == "/buy-links.json" for p, _ in out):
        with open(links, "rb") as fh:
            out.append(("/buy-links.json", fh.read()))
    if not out:
        die("shop/landing is empty - build the site first (python -m _build.build_all).", 2)
    return out


def manifest_for(files, salt=""):
    """The asset manifest: 32-hex hash of the contents (optionally salted), plus size.

    The hash is a dedup key Cloudflare matches against earlier uploads. When every
    file is already known from a stranded session, a salted re-key (documented as
    legitimate) forces a fresh upload, because only an upload returns the
    completion token a deployment needs.
    """
    out = {}
    for path, body in files:
        digest = hashlib.sha256(body).hexdigest()
        if salt:
            digest = hashlib.sha256((salt + digest).encode()).hexdigest()
        out[path] = {"hash": digest[:32], "size": len(body)}
    return out


def multipart(parts):
    """parts: list of (name, filename_or_None, content_type_or_None, bytes)."""
    b = "----nb" + hashlib.md5(str(id(parts)).encode()).hexdigest()
    chunks = []
    for name, filename, ctype, body in parts:
        chunks.append(f"--{b}\r\n".encode())
        disp = f'form-data; name="{name}"'
        if filename:
            disp += f'; filename="{filename}"'
        chunks.append(f"Content-Disposition: {disp}\r\n".encode())
        if ctype:
            chunks.append(f"Content-Type: {ctype}\r\n".encode())
        chunks.append(b"\r\n")
        chunks.append(body)
        chunks.append(b"\r\n")
    chunks.append(f"--{b}--\r\n".encode())
    return b"".join(chunks), b


def post_multipart(url, token, parts):
    body, boundary = multipart(parts)
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Authorization": f"Bearer {token}",
                 "Content-Type": f"multipart/form-data; boundary={boundary}"})
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            err = json.loads(e.read().decode("utf-8", "replace"))
            msg = json.dumps(err.get("errors") or err)[:500]
        except Exception:
            msg = str(e)
        raise SystemExit(f"HTTP {e.code} uploading assets\n  {msg}")


def cmd_dryrun():
    files = site_files()
    total = sum(len(b) for _, b in files)
    kinds = {}
    for path, body in files:
        top = path.split("/")[1] if path.count("/") > 1 else "(root)"
        kinds[top] = kinds.get(top, 0) + 1
    print(f"{WORKER}: {len(files)} file(s), {total / 1024:.0f} KB total")
    for k in sorted(kinds):
        print(f"  /{k:<12} {kinds[k]} file(s)")
    print("nothing was sent. deploy needs the Cloudflare token with Workers Scripts:Edit.")


def cmd_deploy():
    token, account = creds()
    files = site_files()
    manifest = manifest_for(files)
    print(f"{WORKER}: {len(files)} file(s), "
          f"{sum(len(b) for _, b in files) / 1024:.0f} KB")

    # the worker must exist in the beta registry for assets to attach at runtime:
    # a script-only worker accepts the same calls but the asset set never wires up
    # (runtime error 1042). Create it there first if it is missing.
    try:
        call(f"/accounts/{account}/workers/workers/{WORKER}", token, method="GET")
    except SystemExit:
        call(f"/accounts/{account}/workers/workers", token,
             {"name": WORKER, "subdomain": {"enabled": True}}, method="POST")
        print("  worker created in the beta registry")

    def session(man):
        res = call(f"/accounts/{account}/workers/scripts/{WORKER}/assets-upload-session",
                   token, {"manifest": man}, method="POST")
        result = res.get("result") or {}
        if not result.get("jwt"):
            die("the upload session returned no JWT; the API shape moved. Nothing was "
                "half-written - the session simply expired.", 2)
        return result

    result = session(manifest)
    jwt, buckets = result.get("jwt"), result.get("buckets") or []
    if files and not buckets:
        print("  every file already known from an earlier upload - re-keying for a "
              "fresh completion token")
        manifest = manifest_for(files, salt=os.urandom(8).hex())
        result = session(manifest)
        jwt, buckets = result.get("jwt"), result.get("buckets") or []

    # upload each bucket of hashes as one multipart POST, base64 bodies. The parts
    # are plain form fields named by hash (no filename, no content type): the API
    # parses a filename'd part as a file upload and the assets never register.
    by_hash = {manifest[p]["hash"]: (p, b) for p, b in files}
    sent = 0
    completion = None
    for bucket in buckets:
        parts = [(h, None, None, base64.b64encode(by_hash[h][1])) for h in bucket]
        url = f"{API}/accounts/{account}/workers/assets/upload?base64=true"
        r = post_multipart(url, jwt, parts)
        if not r.get("success"):
            die(f"asset upload refused: {json.dumps(r)[:300]}", 2)
        if r.get("result") and r["result"].get("jwt"):
            completion = r["result"]["jwt"]
        sent += len(bucket)
    if buckets:
        print(f"  uploaded {sent} file(s) in {len(buckets)} bucket(s)")
    # when every file was already known, no bucket upload happens and the session
    # JWT itself is what the script PUT accepts as the assets token
    if not completion:
        completion = jwt

    # 3. create the version through the beta workers versions endpoint (JSON),
    #    where the asset set actually wires into the runtime, then deploy at 100%
    #
    # The asset store on this deploy path serves files WITHOUT Content-Type and
    # ignores Range headers (found 09-29: mp4s would not play - browsers require
    # video/mp4, and Safari requires 206). The wrapper sets the mime type by
    # extension (clean URLs count as html) and slices the body itself for Range
    # requests - the asset response carries no content-length at fetch time, so
    # the total comes from the body (x-nb-total: 0 found live).
    # first-party analytics: a KV namespace the worker counts real page views
    # (ours excluded by UA) and /go/ clicks (src-tagged by channel) into. The
    # id lives in crypto-rail/cf-views-kv.txt; no binding -> counting off.
    kv_id = os.environ.get("NB_VIEWS_KV", "")
    kv_path = "/home/user/crypto-rail/cf-views-kv.txt"
    if not kv_id and not os.path.exists(kv_path):
        kv_path = os.path.join(SHOP, "..", "crypto-rail", "cf-views-kv.txt")
    if not kv_id:
        try:
            kv_id = open(kv_path, encoding="utf-8").read().strip()
        except OSError:
            kv_id = ""
    KV_BINDING = ([{"type": "kv_namespace", "name": "VIEWS", "namespace_id": kv_id}]
                  if kv_id else [])

    script = (
        "const STATS_PATH = '/stats-8c2f19ab4e77';\n"
        "const SKIP_UA = /northbench-sitesweep|python-urllib|curl\\/|wget|bot|crawler|spider|headless/i;\n"
        "async function bump(env, key, fn) {\n"
        "  if (!env.VIEWS) return null;\n"
        "  try {\n"
        "    const raw = await env.VIEWS.get(key);\n"
        "    const val = raw ? JSON.parse(raw) : {};\n"
        "    fn(val);\n"
        "    await env.VIEWS.put(key, JSON.stringify(val));\n"
        "    return val;\n"
        "  } catch (e) { return null; }\n"
        "}\n"
        "function today() { return new Date().toISOString().slice(0, 10); }\n"
        "const TYPES = {'.mp4':'video/mp4','.m4v':'video/mp4','.webm':'video/webm',"
        "'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp',"
        "'.gif':'image/gif','.svg':'image/svg+xml','.ico':'image/x-icon',"
        "'.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8',"
        "'.json':'application/json; charset=utf-8','.txt':'text/plain; charset=utf-8',"
        "'.html':'text/html; charset=utf-8','.woff2':'font/woff2','.woff':'font/woff',"
        "'.pdf':'application/pdf','.zip':'application/zip'};\n"
        "export default {\n"
        "  async fetch(request, env) {\n"
        "    const url = new URL(request.url);\n"
        # Google Search Console HTML-file verification demands a 200 at the
        # exact .html URL; the asset layer's clean-URL 307 breaks it. Serve the
        # token file (and any sibling verification file) directly.
        "    if (/^\\/google[^\\/]+\\.html$/.test(url.pathname)) {\n"
        "      const g = await env.ASSETS.fetch(url.origin + url.pathname.replace(/\\.html$/, ''));\n"
        "      const gb = await g.text();\n"
        "      return new Response(gb, {status: g.status, headers: {'content-type': 'text/plain; charset=utf-8'}});\n"
        "    }\n"
        "    // /go/<slug>?src=channel - every published link rides this door, so\n"
        "    // clicks are counted per product and per channel before the hop\n"
        "    if (url.pathname.startsWith('/go/')) {\n"
        "      const slug = url.pathname.slice(4).replace(/\\/$/, '');\n"
        "      const src = (url.searchParams.get('src') || 'direct').slice(0, 24);\n"
        "      const map = await env.ASSETS.fetch(url.origin + '/buy-links.json');\n"
        "      let dest = '';\n"
        "      try { const j = await map.json(); dest = (j.links || {})[slug] || ''; } catch (e) {}\n"
        "      if (!dest) return new Response('no such product', {status: 404});\n"
        "      // UTM tags ride the hop, so Gumroad's own Analytics > Links and\n"
        "      // Referrers attribute the channel natively, beside our KV counts\n"
        "      dest += (dest.indexOf('?') > -1 ? '&' : '?') +\n"
        "              'utm_source=' + encodeURIComponent(src) +\n"
        "              '&utm_medium=social&utm_campaign=northbench';\n"
        "      await bump(env, 'go:' + today(), function (v) {\n"
        "        v[slug] = v[slug] || {}; v[slug][src] = (v[slug][src] || 0) + 1;\n"
        "      });\n"
        "      return Response.redirect(dest, 302);\n"
        "    }\n"
        "    if (url.pathname === STATS_PATH) {\n"
        "      if (!env.VIEWS) return new Response(JSON.stringify({note: 'counting off'}),\n"
        "        {headers: {'content-type': 'application/json'}});\n"
        "      const out = {};\n"
        "      for (let i = 0; i < 30; i++) {\n"
        "        const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);\n"
        "        const v = await env.VIEWS.get('views:' + d);\n"
        "        const g = await env.VIEWS.get('go:' + d);\n"
        "        if (v || g) out[d] = {pageviews: v ? JSON.parse(v) : null,\n"
        "                              goclicks: g ? JSON.parse(g) : null};\n"
        "      }\n"
        "      return new Response(JSON.stringify(out, null, 1),\n"
        "        {headers: {'content-type': 'application/json'}});\n"
        "    }\n"
        "    const res = await env.ASSETS.fetch(request);\n"
        "    const dot = url.pathname.lastIndexOf('.');\n"
        "    const slash = url.pathname.lastIndexOf('/');\n"
        "    const ext = dot > slash ? url.pathname.slice(dot).toLowerCase() : '.html';\n"
        "    const mime = TYPES[ext] || 'text/html; charset=utf-8';\n"
        "    const h = new Headers(res.headers);\n"
        "    if (!h.get('content-type')) h.set('content-type', mime);\n"
        "    const range = request.headers.get('range');\n"
        "    if (range && (mime.startsWith('video/') || mime.startsWith('audio/'))) {\n"
        "      const body = await res.arrayBuffer();\n"
        "      const total = body.byteLength;\n"
        "      const m = /bytes=(\\d*)-(\\d*)/.exec(range);\n"
        "      if (m) {\n"
        "        let start = m[1] === '' ? total - parseInt(m[2] || '0', 10) : parseInt(m[1], 10);\n"
        "        let end = m[2] === '' ? total - 1 : parseInt(m[2], 10);\n"
        "        if (isNaN(start) || isNaN(end) || start < 0) { start = 0; end = total - 1; }\n"
        "        if (start <= end && end < total) {\n"
        "          const rh = new Headers(h);\n"
        "          rh.set('content-range', 'bytes ' + start + '-' + end + '/' + total);\n"
        "          rh.set('accept-ranges', 'bytes');\n"
        "          rh.set('content-length', String(end - start + 1));\n"
        "          return new Response(body.slice(start, end + 1), { status: 206, headers: rh });\n"
        "        }\n"
        "        const rh = new Headers(h);\n"
        "        rh.set('content-range', 'bytes */' + total);\n"
        "        return new Response(null, { status: 416, headers: rh });\n"
        "      }\n"
        "      h.set('accept-ranges', 'bytes');\n"
        "      return new Response(body, { status: res.status, headers: h });\n"
        "    }\n"
        "    if (mime.startsWith('video/') || mime.startsWith('audio/')) h.set('accept-ranges', 'bytes');\n"
        "    if (mime.indexOf('text/html') === 0 && res.status === 200\n"
        "        && request.method === 'GET' && !SKIP_UA.test(request.headers.get('user-agent') || '')) {\n"
        "      const ref = (() => { try { return new URL(request.headers.get('referer') || '').hostname; }\n"
        "                         catch (e) { return 'direct'; } })();\n"
        "      const p = url.pathname === '/' ? '/' : url.pathname.replace(/\\/$/, '');\n"
        "      await bump(env, 'views:' + today(), function (v) {\n"
        "        v[p] = v[p] || {n: 0, refs: {}};\n"
        "        v[p].n += 1;\n"
        "        v[p].refs[ref] = (v[p].refs[ref] || 0) + 1;\n"
        "      });\n"
        "    }\n"
        "    return new Response(res.body, { status: res.status, headers: h });\n"
        "  }\n"
        "};\n"
    )
    payload = {
        "account_id": account,
        "main_module": "worker.js",
        "compatibility_date": "2026-09-01",
        "bindings": [{"type": "assets", "name": "ASSETS"}] + KV_BINDING,
        "assets": {"jwt": completion,
                   "config": {"html_handling": "auto-trailing-slash",
                              "not_found_handling": "none",
                              # the asset layer serves files directly and ignores
                              # the worker otherwise - and on this deploy path it
                              # drops Content-Type and Range. Run the worker first
                              # so the wrapper can set both (found 09-29).
                              "run_worker_first": True}},
        "modules": [{"name": "worker.js",
                     "content_type": "application/javascript+module",
                     "content_base64": base64.b64encode(script.encode()).decode()}],
    }
    res = call(f"/accounts/{account}/workers/workers/{WORKER}/versions", token,
               payload, method="POST")
    version = (res.get("result") or {}).get("id")
    if not version:
        die(f"the version was refused: {json.dumps(res)[:300]}", 2)
    res = call(f"/accounts/{account}/workers/scripts/{WORKER}/deployments", token,
               {"strategy": "percentage",
                "versions": [{"percentage": 100, "version_id": version}]},
               method="POST")
    if not res.get("success"):
        die(f"the deployment was refused: {json.dumps(res)[:300]}", 2)
    sub = call(f"/accounts/{account}/workers/subdomain", token).get("result") or {}
    domain = sub.get("subdomain") or "<your-subdomain>"
    print(f"live at https://{WORKER}.{domain}.workers.dev")
    print("if this is the first deploy, the URL answers within a minute or two.")


def cmd_status():
    token, account = creds()
    res = call(f"/accounts/{account}/workers/scripts", token)
    ours = [s.get("id") for s in (res.get("result") or []) if s.get("id") == WORKER]
    sub = call(f"/accounts/{account}/workers/subdomain", token).get("result") or {}
    domain = sub.get("subdomain") or "<your-subdomain>"
    if ours:
        print(f"{WORKER}: deployed - https://{WORKER}.{domain}.workers.dev")
    else:
        print(f"{WORKER}: not deployed yet")
    print(f"courier: see tools/cf_courier.py status")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "dryrun":
        cmd_dryrun()
    elif cmd == "deploy":
        cmd_deploy()
    elif cmd == "status":
        cmd_status()
    else:
        print(__doc__)
