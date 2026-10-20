# THE OWNER REPORT - plain human words, smart about repetition.
# v2 2026-10-20: full report only when something CHANGED (sale, build,
# problem, new work). Identical state = silence, except one short
# heartbeat every 6h so you know the machine breathes. No more
# 24 near-identical messages a day.
import json, os, time, hashlib, urllib.request
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
def send(text):
    try:
        urllib.request.urlopen(urllib.request.Request("https://api.telegram.org/bot%s/sendMessage"%os.environ["TELEGRAM_TOKEN"],data=json.dumps({"chat_id":os.environ["OWNER_CHAT_ID"],"text":text[:900]}).encode(),headers={"Content-Type":"application/json"}),timeout=15)
        return True
    except Exception: return False

now=time.time()
last=kv("report:last")
if not last or time.strftime("%H:%M")!=time.strftime("%H:%M",time.gmtime(float(last))):
    # --- gather state (every read guarded: a missing key must never kill the report)
    sales=0
    try:
        g=json.load(urllib.request.urlopen(urllib.request.Request("https://api.gumroad.com/v2/sales",headers={"Authorization":"Bearer "+os.environ["GUMROAD_TOKEN"]}),timeout=15))
        sales=len(g.get("sales",[]))
    except Exception: pass
    try: bl=json.loads(kv("build:log") or "[]")
    except Exception: bl=[]
    built_today=0
    if isinstance(bl,list):
        built_today=len([b for b in bl if str((b or {}).get("at","")).startswith(time.strftime("%Y-%m-%d"))])
    elif isinstance(bl,dict):
        built_today=bl.get("executed",0) if str(bl.get("at","")).startswith(time.strftime("%Y-%m-%d")) else 0
    try: queue=json.loads(kv("build:queue") or "[]")
    except Exception: queue=[]
    working="keeping the store sharp"
    try:
        log=json.loads(kv("agent:log") or "[]")
        for e in reversed(log):
            o=[str(x) for x in (e.get("orders") or []) if len(str(x))>15 and "dropped" not in str(x)]
            if o: working=o[0][:90]; break
    except Exception: pass
    ctx={}
    try: ctx=json.loads(kv("business:context") or "{}")
    except Exception: pass
    problems=[h for h in (ctx.get("health") or ["ok"]) if "ok" not in str(h).lower()]
    machine="all good" if not problems else "; ".join(str(p) for p in problems)[:140]

    body=("Sales so far: %d\nMade today: %s\nWaiting to be built: %d\nNow working on: %s\nMachine: %s"
          % (sales, ("%s items"%built_today) if built_today else "nothing yet today", len(queue), working, machine))
    h=hashlib.sha1(body.encode()).hexdigest()[:12]
    prev_h=(kv("report:hash") or "").strip()
    prev_at=float(kv("report:sent") or 0)
    if h!=prev_h:
        # something changed -> full report, always
        send("Northbench %s UTC\n%s"%(time.strftime("%H:%M"),body))
        kvput("report:hash",h); kvput("report:sent",str(now)); kvput("report:last",str(now))
        print("report sent (changed)")
    elif now-prev_at>6*3600:
        # identical state -> short heartbeat at most every 6 hours
        send("Northbench %s UTC - heartbeat: nothing changed. Sales 0, machine all good, chain running."%time.strftime("%H:%M"))
        kvput("report:sent",str(now)); kvput("report:last",str(now))
        print("heartbeat sent (unchanged)")
    else:
        kvput("report:last",str(now))
        print("silent (nothing changed, heartbeat not due)")
