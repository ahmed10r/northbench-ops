# MINUTE-BY-MINUTE OWNER REPORT (owner observation mode, 2026-10-18)
import json, os, time, urllib.request
def kv(k):
    try:
        u=("https://api.cloudflare.com/client/v4/accounts/%s/storage/kv/namespaces/%s/values/"%(os.environ["CF_ACCOUNT"],os.environ["CF_VIEWS_KV"]))+k.replace(":","%3A")
        return urllib.request.urlopen(urllib.request.Request(u,headers={"Authorization":"Bearer "+os.environ["CF_TOKEN"]}),timeout=15).read().decode()
    except Exception: return None
now=time.strftime("%H:%M:%S")
b=kv("build:log") or "{}"
q=kv("build:queue") or "[]"
try: ceo=(json.loads(kv("agent:log") or "[]")[-1].get("at","?")[11:16])
except Exception: ceo="?"
sales=0
try:
    g=json.load(urllib.request.urlopen(urllib.request.Request("https://api.gumroad.com/v2/sales",headers={"Authorization":"Bearer "+os.environ["GUMROAD_TOKEN"]}),timeout=15))
    sales=len(g.get("sales",[]))
except Exception: pass
what="?"
try:
    e=json.loads(kv("agent:log") or "[]")[-1]
    what=str(e.get("assessment") or e.get("digest") or "?")[:70]
except Exception: pass
built=json.loads(b).get("executed","?")
runs="?"
try:
    h={"Authorization":"Bearer "+os.environ["GH_TOKEN"],"User-Agent":"nb"}
    r=json.load(urllib.request.urlopen(urllib.request.Request("https://api.github.com/repos/ahmed10r/northbench-ops/actions/runs?per_page=100",headers=h),timeout=15))
    today=time.strftime("%Y-%m-%d")
    runs=sum(1 for x in r.get("workflow_runs",[]) if x.get("created_at","").startswith(today))
except Exception: pass
msg=("%s | NOW: %s | sales:%d | built:%s orders | queue:%d | beats today:%s (~%s min quota burn)" % (now, what, sales, built, len(json.loads(q)), runs, runs))
urllib.request.urlopen(urllib.request.Request("https://api.telegram.org/bot%s/sendMessage"%os.environ["TELEGRAM_TOKEN"],data=json.dumps({"chat_id":os.environ["OWNER_CHAT_ID"],"text":msg[:500]}).encode(),headers={"Content-Type":"application/json"}),timeout=15)
print("report sent:", msg)
