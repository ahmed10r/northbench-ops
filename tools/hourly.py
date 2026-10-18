# HOURLY OWNER REPORT - one compact line, once per hour, from the agency
import json, os, urllib.request
def kv(k):
    try:
        u=("https://api.cloudflare.com/client/v4/accounts/%s/storage/kv/namespaces/%s/values/"%(os.environ["CF_ACCOUNT"],os.environ["CF_VIEWS_KV"]))+k.replace(":","%3A")
        return urllib.request.urlopen(urllib.request.Request(u,headers={"Authorization":"Bearer "+os.environ["CF_TOKEN"]}),timeout=15).read().decode()
    except Exception: return None
import time
if time.gmtime().tm_min % 60: raise SystemExit  # only the :00 beat sends
b=kv("build:log"); q=kv("build:queue"); kpi=(kv("kpi:latest") or "no kpi yet").splitlines()
sales=[l for l in kpi if "sale" in l.lower()][:1]
msg="NORTHBENCH STUDIO hourly: " + (b or "builder: not run yet") + " | queue: " + str(len(json.loads(q)) if q else 0) + " pending | " + (sales[0].strip() if sales else "sales: 0")
urllib.request.urlopen(urllib.request.Request("https://api.telegram.org/bot%s/sendMessage"%os.environ["TELEGRAM_TOKEN"],data=json.dumps({"chat_id":os.environ["OWNER_CHAT_ID"],"text":msg[:500]}).encode(),headers={"Content-Type":"application/json"}),timeout=15)
print("hourly report sent")
