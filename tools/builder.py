# THE BUILDER - the agency's hands. Runs every 30min in Actions.
# Pulls build:queue from KV, executes orders alone, marks done.
import json, os, sys, urllib.request, urllib.parse, random, math, subprocess, time
def kv(key, data=None):
    acct=os.environ["CF_ACCOUNT"]; tok=os.environ["CF_TOKEN"]; ns=os.environ["CF_VIEWS_KV"]
    u=f"https://api.cloudflare.com/client/v4/accounts/{acct}/storage/kv/namespaces/{ns}/values/"+urllib.parse.quote(key,safe="")
    if data is None:
        try: return json.loads(urllib.request.urlopen(urllib.request.Request(u,headers={"Authorization":"Bearer "+tok}),timeout=20).read().decode())
        except Exception: return None
    urllib.request.urlopen(urllib.request.Request(u,data=json.dumps(data).encode(),headers={"Authorization":"Bearer "+tok,"Content-Type":"application/json"},method="PUT"),timeout=20)
def wallpaper(name, seed):
    random.seed(seed); hues=[random.randint(0,359) for _ in range(3)]
    layers=[]
    for i in range(random.randint(4,7)):
        h=random.choice(hues); o=round(random.uniform(.08,.3),2); n=random.randint(3,9)
        pts=" ".join(f"{random.uniform(0,1600):.0f},{random.uniform(0,900):.0f}" for _ in range(n))
        layers.append(f'<polygon points="{pts}" fill="hsl({h},60%,{random.randint(15,45)}%)" opacity="{o}"/>')
    for i in range(random.randint(20,50)):
        layers.append(f'<circle cx="{random.uniform(0,1600):.0f}" cy="{random.uniform(0,900):.0f}" r="{random.uniform(.5,2.5):.1f}" fill="hsl({random.choice(hues)},70%,80%)" opacity="{random.uniform(.2,.9):.2}"/>')
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900"><rect width="1600" height="900" fill="hsl({hues[0]},45%,{random.randint(5,12)}%)"/>{"".join(layers)}</svg>'
def git(path, content, msg):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    open(path,"w").write(content)
    subprocess.run(["git","add",path],check=True); subprocess.run(["git","-c","user.name=the-agency","-c","user.email=actions@users.noreply.github.com","commit","-m",msg],check=True)
queue=kv("build:queue") or []
if not queue: print("builder: queue empty"); sys.exit(0)
done=[]
for o in queue[:50]:
    try:
        k=o.get("kind"); now=time.strftime("%Y-%m-%d")
        if k=="wallpaper_set":
            seed=o.get("seed") or int(time.time()); n=o.get("count",3)
            for i in range(n): git(f"content/drops/{now}/wallpaper-{i+1}.svg", wallpaper(o.get("name","set"),seed+i), f"builder: wallpaper {i+1}")
            print(f"built {n} wallpapers: {o.get('name')}")
        elif k=="story":
            import random as R; R.seed(o.get("seed") or int(time.time()))
            place=R.choice(["the old observatory","a lighthouse in fog","the last library","a radio shack at dawn","the tidepools","the night train"])
            obj=R.choice(["a brass telescope","a tape recorder","a paper star map","a jar of fireflies","a broken compass"])
            feels=R.choice(["quiet wonder","long-held hope","gentle grief","first courage"])
            body=f"# {o.get('title','Field Note')}\n\nAt {place}, someone left {obj}. It still worked.\n\nThis is a story about {feels} - told the way machines dream: in plain words, small details, one true thing per line.\n\n_(Machine-made fiction from the Northbench Studio fiction desk. New chapters weekly in THE CLUB.)_"
            git(f"content/stories/{now}/{(o.get('title','note') or 'note').lower().replace(' ','-')[:40]}.md", body, "builder: story "+str(o.get('title',''))[:30])
            print("story written:", o.get("title"))
        elif k=="tracklist":
            import random as R; R.seed(o.get("seed") or int(time.time()))
            moods=R.sample(["Slow Orbit","Tide Glass","Cabin Light","Long Wave","Snow Static","Kettle Steam","Ferry Wake","Dusk Synths","Hollow Bell","Warm Circuit","Rain on Tin","Faint Beacon"],k=8)
            body="# "+o.get("title","Ordinary Evenings vol.")+"\n\n"+"\n".join(f"{i+1}. {m}" for i,m in enumerate(moods))+"\n\n_Ambience volume tracklist - full audio ships with the CLUB bundle._"
            git(f"content/audio/{now}/{(o.get('title','volume') or 'vol').lower().replace(' ','-')[:40]}.md", body, "builder: tracklist")
            print("tracklist written:", o.get("title"))
        elif k=="page":
            git(o["path"], o["content"], "builder: page "+o["path"])
        elif k=="gumroad_product":
            body=urllib.parse.urlencode({"name":o["name"],"description":o.get("description",""),"price":int(o.get("price",7)*100)}).encode()
            r=urllib.request.urlopen(urllib.request.Request("https://api.gumroad.com/v2/products",data=body,headers={"Authorization":"Bearer "+os.environ["GUMROAD_TOKEN"]},method="POST"),timeout=30)
            print("gumroad product created:", json.load(r).get("product",{}).get("id"))
        elif k=="push":
            subprocess.run(["git","push"],check=True); print("pushed")
            continue
        else: print("unknown kind:",k)
        done.append(o)
    except Exception as e: print("order failed:",str(e)[:120]); done.append(o)
subprocess.run(["git","push"],capture_output=True)
kv("build:queue",[o for o in queue if o not in done]); kv("build:log",{"at":time.strftime("%Y-%m-%dT%H:%M"),"executed":len(done)})
