# THE OWNER REPORT - plain human words, nothing else
import json, os, time, urllib.request
def kv(k):
    try:
        u=("https://api.cloudflare.com/client/v4/accounts/%s/storage/kv/namespaces/%s/values/"%(os.environ["CF_ACCOUNT"],os.environ["CF_VIEWS_KV"]))+k.replace(":","%3A")
        return urllib.request.urlopen(urllib.request.Request(u,headers={"Authorization":"Bearer "+os.environ["CF_TOKEN"]}),timeout=15).read().decode()
    except Exception: return None
def kvput(k,v):
    try:
        u=("https://api.cloudflare.com/client/v4/accounts/%s/storage/kv/namespaces/%s/values/"%(os.environ["CF_ACCOUNT"],os.environ["CF_VIEWS_KV"]))+k.replace(":","%3A")
        urllib.request.urlopen(urllib.request.Request(u,data=v.encode(),headers={"Authorization":"Bearer "+os.environ["CF_TOKEN"],"Content-Type":"application/json"},method="PUT"),timeout=15)
    except Exception: pass
last=kv("report:last")
if not last or time.strftime("%H:%M") != time.strftime("%H:%M", time.gmtime(float(last))):
    sales=0
    try:
        g=json.load(urllib.request.urlopen(urllib.request.Request("https://api.gumroad.com/v2/sales",headers={"Authorization":"Bearer "+os.environ["GUMROAD_TOKEN"]}),timeout=15))
        sales=len(g.get("sales",[]))
    except Exception: pass
    bl=json.loads(kv("build:log") or "{}")
    queue=json.loads(kv("build:queue") or "[]")
    working="keeping the store sharp"
    try:
        log=json.loads(kv("agent:log") or "[]")
        for e in reversed(log):
            o=[str(x) for x in (e.get("orders") or []) if len(str(x))>15 and "dropped" not in str(x)]
            if o: working=o[0][:90]; break
    except Exception: pass
    ctx=json.loads(kv("business:context") or "{}")
    problems=[h for h in (ctx.get("health") or ["ok"]) if "ok" not in h.lower()]
    msg=("Northbench %s UTC\n"
         "Sales so far: %d\n"
         "Made today: %s\n"
         "Waiting to be built: %d\n"
         "Now working on: %s\n"
         "Machine: %s") % (time.strftime("%H:%M"), sales,
            ("%s items" % bl.get("executed")) if str(bl.get("at","")).startswith(time.strftime("%Y-%m-%d")) else "nothing yet today",
            len(queue), working,
            "all good" if not problems else "; ".join(problems)[:120])
    urllib.request.urlopen(urllib.request.Request("https://api.telegram.org/bot%s/sendMessage"%os.environ["TELEGRAM_TOKEN"],data=json.dumps({"chat_id":os.environ["OWNER_CHAT_ID"],"text":msg[:600]}).encode(),headers={"Content-Type":"application/json"}),timeout=15)
    kvput("report:last",str(time.time()))
    print("report sent")
