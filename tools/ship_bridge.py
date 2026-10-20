# ships the repo's canonical bridge code over the air + queues today's
# bridge tasks. Called by resume-the-machine at 00:05 UTC (quota reset).
import json, os, urllib.request, urllib.parse
def kvcfg():
    return os.environ["CF_ACCOUNT"], os.environ["CF_TOKEN"], os.environ["CF_VIEWS_KV"]
def kvput(key, val):
    a,t,n=kvcfg()
    u="https://api.cloudflare.com/client/v4/accounts/%s/storage/kv/namespaces/%s/values/"%(a,n)+urllib.parse.quote(key,safe="")
    urllib.request.urlopen(urllib.request.Request(u,data=json.dumps(val).encode(),headers={"Authorization":"Bearer "+t,"Content-Type":"application/json"},method="PUT"),timeout=30)
src=open("laptop-bridge/nb-social.js").read()
version=0
for line in src.splitlines():
    if line.strip().startswith("const VERSION"): version=int(line.split("=")[1].strip().rstrip(";"))
kvput("laptop:code",{"version":version,"src":src})
print("bridge v%d shipped over the air"%version)
# queue: keep it simple - one discovery task so the agency gets fresh
# dashboard product links (covers etc.); never duplicates by id
import urllib.error
a,t,n=kvcfg()
u="https://api.cloudflare.com/client/v4/accounts/%s/storage/kv/namespaces/%s/values/"%(a,n)+urllib.parse.quote("laptop:queue",safe="")
try:
    q=json.loads(urllib.request.urlopen(urllib.request.Request(u,headers={"Authorization":"Bearer "+t}),timeout=20).read().decode() or "[]")
except Exception: q=[]
if not any(x.get("id")=="discover-products" for x in q):
    q.append({"id":"discover-products","platform":"gumroad","action":"browse","url":"https://gumroad.com/products",
      "reportButtons":False,
      "steps":[{"wait":6000},
        {"run":"const rows=[...document.querySelectorAll('a[href*=\"/products/\"]')].map(a=>({text:(a.innerText||'').replace(/\\s+/g,' ').trim().slice(0,60),href:a.getAttribute('href')})).filter(x=>x.text&&!/new|graph_data|customers|analytics|sales|posts/.test(x.href));return rows.slice(0,40)"}]})
    kvput("laptop:queue",q)
    print("discovery task queued")
else:
    print("discovery task already queued")
