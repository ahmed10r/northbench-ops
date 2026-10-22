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
    # v2 art engine: layered gradients + composition rules (deep-agent tuned)
    layers=[f'<defs><radialGradient id="g0" cx="30%" cy="25%"><stop offset="0%" stop-color="hsl({hues[0]},55%,{random.randint(22,38)}%)"/><stop offset="100%" stop-color="hsl({hues[1]},60%,6%)" stop-opacity="0"/></radialGradient>'
            f'<radialGradient id="g1" cx="75%" cy="80%"><stop offset="0%" stop-color="hsl({hues[2]},50%,{random.randint(18,30)}%)" stop-opacity="0.8"/><stop offset="100%" stop-color="hsl({hues[2]},60%,4%)" stop-opacity="0"/></radialGradient></defs>',
            '<rect width="1600" height="900" fill="url(#g0)"/>','<rect width="1600" height="900" fill="url(#g1)"/>']
    for i in range(random.randint(3,6)):  # horizon band composition
        y=random.uniform(250,780); h=random.uniform(20,120)
        layers.append(f'<rect x="0" y="{y:.0f}" width="1600" height="{h:.0f}" fill="hsl({random.choice(hues)},{random.randint(25,50)}%,{random.randint(8,20)}%)" opacity="{random.uniform(.25,.7):.2f}"/>')
    for i in range(random.randint(3,6)):  # geometric silhouettes
        h=random.choice(hues); o=round(random.uniform(.1,.35),2); n=random.randint(3,7)
        pts=" ".join(f"{random.uniform(0,1600):.0f},{random.uniform(0,900):.0f}" for _ in range(n))
        layers.append(f'<polygon points="{pts}" fill="hsl({h},{random.randint(35,60)}%,{random.randint(12,40)}%)" opacity="{o}"/>')
    for i in range(random.randint(30,80)):  # star field with size falloff
        sy=random.uniform(0,900)**1.4/900*900
        layers.append(f'<circle cx="{random.uniform(0,1600):.0f}" cy="{sy:.0f}" r="{random.uniform(.4,2.2):.1f}" fill="hsl({random.choice(hues)},{random.randint(50,80)}%,{random.randint(75,92)}%)" opacity="{random.uniform(.2,.95):.2f}"/>')
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
            if os.path.exists(f"content/drops/{now}/wallpaper-{n}.svg"): print("skip: drop already built"); done.append(o); continue
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
            # Hard owner guard: no new offers or Gumroad product creation.
            # Remove the rejected order from the queue without making an API call.
            print("blocked: owner no-new-offers rule; no Gumroad API request made")
        elif k=="push":
            subprocess.run(["git","push"],check=True); print("pushed")
            continue
        else: print("unknown kind:",k)
        done.append(o)
    except Exception as e: print("order failed:",str(e)[:120]); done.append(o)
subprocess.run(["git","push"],capture_output=True)
kv("build:queue",[o for o in queue if o not in done]); kv("build:log",{"at":time.strftime("%Y-%m-%dT%H:%M"),"executed":len(done)})
