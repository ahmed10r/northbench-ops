#!/usr/bin/env python3
"""Audit live sitemap routes for primary navigation and visible Gumroad CTAs.

Usage: python3 tools/audit_live_site.py [--base https://northbenchshop.com]
The audit user-agent contains "bot" so the Worker skips pageview sampling.
"""
import argparse
import concurrent.futures
import re
import sys
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from urllib.parse import urlsplit

UA = 'NorthbenchSiteAuditBot/1.0'
NAV = 'aria-label="Primary navigation"'
CTA_SELECTOR = 'a[href^="https://northbenchshop.gumroad.com/l/"]{'
CTA_LINK = re.compile(r'href="https://northbenchshop\.gumroad\.com/l/')
NS = {'sm': 'http://www.sitemaps.org/schemas/sitemap/0.9'}


def request(url, timeout):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': '*/*'})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return response.status, response.headers, response.read()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', default='https://northbenchshop.com')
    parser.add_argument('--workers', type=int, default=6)
    parser.add_argument('--timeout', type=int, default=25)
    args = parser.parse_args()
    base = args.base.rstrip('/')
    try:
        status, headers, raw = request(base + '/sitemap.xml', args.timeout)
        ctype = headers.get('Content-Type', '').lower()
        if status != 200 or not (ctype.startswith('application/xml') or ctype.startswith('text/xml')):
            raise RuntimeError(f'sitemap HTTP/content-type mismatch: {status} {ctype}')
        root = ET.fromstring(raw)
        locs = [e.text for e in root.findall('sm:url/sm:loc', NS) if e.text]
        base_host = urlsplit(base).netloc.lower()
        routes = sorted({urlsplit(u).path or '/' for u in locs
                         if urlsplit(u).netloc.lower() == base_host})
        if not routes:
            raise RuntimeError('sitemap contained no URLs for the requested host')
    except Exception as exc:
        print(f'FAIL sitemap: {type(exc).__name__}: {exc}', file=sys.stderr)
        return 1

    def check(path):
        try:
            code, h, raw = request(base + path, args.timeout)
            body = raw.decode('utf-8', 'replace')
            nav_count = body.count(NAV)
            cta_count = len(CTA_LINK.findall(body))
            styled = CTA_SELECTOR in body
            issues = []
            if code != 200: issues.append(f'HTTP {code}')
            if nav_count != 1: issues.append(f'primary-nav={nav_count}')
            if cta_count and not styled: issues.append(f'{cta_count} direct Gumroad links lack CTA CSS')
            return path, code, nav_count, issues, cta_count
        except Exception as exc:
            return path, 0, 0, [f'{type(exc).__name__}: {exc}'], 0

    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        results = list(pool.map(check, routes))
    failed = [(path, issues) for path, _, _, issues, _ in results if issues]
    http_ok = sum(code == 200 for _, code, _, _, _ in results)
    nav_ok = sum(nav == 1 for _, _, nav, _, _ in results)
    links = sum(n for _, _, _, _, n in results)
    pages = sum(n > 0 for _, _, _, _, n in results)
    print(f'sitemap: {status} {ctype}; routes={len(routes)}')
    print(f'pages: HTTP 200={http_ok}/{len(routes)}; primary nav exactly once={nav_ok}/{len(routes)}')
    print(f'direct Gumroad product links={links} across {pages} routes; CTA styles checked')
    for path, issues in failed:
        print('FAIL', path, '; '.join(issues))
    return 1 if failed else 0


if __name__ == '__main__':
    raise SystemExit(main())
