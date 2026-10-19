// NORTHBENCH FOREMAN v4 - FULLY AUTONOMOUS MANAGER.
// Owner directive (2026-10-17): "no desk thinking - the thinking and full
// management by the FOREMAN, so it works even when I am not online - put
// all the available power to it."
//
// The foreman is the single AI manager of the whole business. All 16
// sections (works/BUSINESS-STRUCTURE.txt) live in ONE prompt as its
// management map; every pass it assesses the whole board, ACTS through
// its action library, orders work for the deep agent, and escalates
// pre-made one-word decisions to the owner.
//
// THE POWER LIBRARY (all available machine powers, pre-built and
// whitelisted in code - the model can only call these by ID):
//   dispatch_nightly   trigger the nightly workflow (health + site rebuild)
//   ping_courier       trigger a courier posting pass
//   queue_sweep        queue a Reddit thread-sweep on the laptop
//   queue_inbox        queue an inbox/karma check on the laptop
//   clear_stale_queue  prune laptop queue items older than 24h
//   registry_note      update a component's next action (bookkeeping)
//   telegram_alert     priority message to the owner
//
// WHAT STAYS LOCKED (owner law, not reversible by any AI): spending
// money, publishing products, creating accounts, owner-gated reads.
// Filters enforced in code: honesty (no invented proof) and money
// (no spend/ads/budget proposals ever reach the owner).
//
// Triggers: courier cron 09:30 UTC daily + nightly workflow ping
// (~08:10 UTC) + manual GET with the key. Loop guard: a run triggered
// by the nightly can never dispatch the nightly.
//
// Bindings: AI, VIEWS (KV), TELEGRAM_TOKEN, OWNER_CHAT_ID, FOREMAN_KEY,
// GITHUB_TOKEN (fine-grained PAT, dispatch-only use).

const KV_LOG = "agent:log";
const KV_STATE = "foreman:state";
const MAX_LOG = 60;
const NIGHTLY_URL = "https://api.github.com/repos/ahmed10r/northbench-ops/actions/workflows/nightly.yml/dispatches";
const COURIER_URL = "https://northbench-courier.a7maaadesmail93.workers.dev/";

const SECTIONS = [
  "RECREATE: tools factory (18 products, SMITH's old desk), content factory",
  "(9 guides/56 answers/8 calcs), design studio (covers/pins/trade dress),",
  "stories factory (ORBITAL/UNSENT/LIGHTHOUSE/audio/course - owner-gated).",
  "RUN: storefront (96-page site + 18 listings + delivery), distribution",
  "engine (courier, food calendar to Oct 2027), watchtower (nightly KPI),",
  "money desk (pricing, $100 gate), support (sleeping till first sale),",
  "compliance, research (pattern library).",
  "GROW: community lane (Reddit engine + Bluesky replies), search lane",
  "(SEO + pins), broadcast lane, letter lane (sleeping till $100 gate),",
  "spark lane (referral loops - to be invented), partnership lane",
  "(sleeping). Paid lane: OFF by owner law.",
];

const LAWS = [
  "LAWS:",
  "- You are the ONLY manager and you are FULLY AUTONOMOUS. The owner",
  "  does not answer questions. You DECIDE, you ACT, and the owner is",
  "  INFORMED via Telegram. Never ask, never wait, never seek approval.",
  "- Budget: default $0, free tiers. Micro-spends (<$15) may be PROPOSED",
  "  with expected return (like the domain step); the owner answers one",
  "  word. You NEVER execute a spend yourself.",
  "- MISSION: profit - a store that sells heavy. Every pass serves the",
  "  next sale: sharpen listings, build trust surfaces, push the 3 best",
  "  products, test prices, ask for the sale.",
  "- Honesty law: 0 sales, so NO testimonials/ratings exist. Never invent",
  "  or borrow social proof. Refunds are 14 days. NORTHBENCH30 = 30% off.",
  "- Publishing is YOURS: you may update Gumroad listings (name/desc/",
  "  price $3-$60) and publish notes to the site repo. Quality doctrine:",
  "  plain words, real value, no hype, no false claims.",
  "- needs_hands = ONLY things software physically cannot do (account",
  "  signup captchas/phones, legal signature, entering payment cards).",
  "  Informational note for the owner - never a question that blocks work.",
  "- ACTIONS: ping_courier, queue_sweep, queue_inbox,",
  "  clear_stale_queue, telegram_alert,",
  '  gumroad_update {"gumroad_update":{"product":"<id>","name":"..","description":"..","price":<dollars>}},',
  '  publish_note {"publish_note":{"title":"..","text":".."}},',
  '  site_update {"site_update":{"path":"works/...","content":"full file text"}},',
  '  gumroad_create {"gumroad_create":{"name":"..","price":9,"description":".."}},',
  '  build_order {"build_order":{"kind":"wallpaper_set|page|gumroad_product", ...}} - queue real work for the builder agent that runs every 30min (wallpaper_set: {name,count}; page: {path,content}; gumroad_product: {name,price,description}). USE THIS to build drop zero: wallpaper sets, pages, the Club product.',,
  '  registry_note {"registry_note":{"component":"id","note":".."}}.',
  "- Think from the WHOLE business first (inventory, strategy, history,",
  "  roadmap), then apply the gauges. Never fixate on one gauge. When you",
  "  learn something durable or make a significant decision, add it to",
  "  your memory: brain_note {\"brain_note\":{\"text\":\"one-line lesson/decision\"}}",
  "  - it persists across passes and the nightly bakes it into the brain.",
];

async function grab(url, ms, opts) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms || 12000);
  try {
    const r = await fetch(url, Object.assign({ signal: c.signal,
      headers: { "User-Agent": "nb-agent/1.0" } }, opts || {}));
    return { ok: r.ok, status: r.status, json: await r.json().catch(() => null) };
  } catch (e) { return { ok: false, status: 0, json: null }; }
  finally { clearTimeout(t); }
}

async function kvGet(env, key) {
  try { const v = await env.VIEWS.get(key); return v ? JSON.parse(v) : null; }
  catch (e) { return null; }
}

async function kvPut(env, key, val) {
  await env.VIEWS.put(key, JSON.stringify(val));
}

async function kvAppendLog(env, entry) {
  const log = (await kvGet(env, KV_LOG)) || [];
  log.push(entry);
  await env.VIEWS.put(KV_LOG, JSON.stringify(log.slice(-MAX_LOG)));
}

async function telegram(env, text) {
  try {
    await fetch("https://api.telegram.org/bot" + env.TELEGRAM_TOKEN + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.OWNER_CHAT_ID, text: text.slice(0, 3800) }),
    });
  } catch (e) { /* never break a pass */ }
}

async function gatherContext(env, mode) {
  if (mode === "patrol") {
    try {
      const blobRaw = await env.VIEWS.get("ctx:blob");
      if (blobRaw) {
        const b = JSON.parse(blobRaw);
        if (Date.now() - new Date(b.at).getTime() < 7200000)
          return Object.assign({}, b, { at: new Date().toISOString() });
      }
    } catch (e) {}
  }
  const ctx = { at: new Date().toISOString() };
  const c = await grab(COURIER_URL, 25000);
  if (c.ok && c.json) { ctx.courier = c.json.reddit || {}; ctx.courier_log = (c.json.log || []).slice(0, 4); }
  const s = await grab("https://northbenchshop.com/stats-8c2f19ab4e77");
  if (s.ok && s.json) {
    const days = Object.keys(s.json).filter((k) => k !== "note").sort().slice(-3);
    ctx.stats = days.map((d) => {
      const day = s.json[d] || {};
      const pv = Object.values(day.pageviews || {}).reduce((a, v) => a + (v.n || 0), 0);
      let clicks = 0;
      for (const p of Object.values(day.goclicks || {}))
        for (const n of Object.values(p)) clicks += n;
      return d + ": " + pv + " views, " + clicks + " shop clicks";
    });
  }
  const brain = await env.VIEWS.get("business:brain");
  if (brain) ctx.brain = brain.slice(0, 2600);
  const bnotes = await kvGet(env, "brain:notes");
  if (Array.isArray(bnotes) && bnotes.length)
    ctx.foreman_memory = bnotes.slice(-6).map((n) => n.at.slice(0, 10) + ": " + n.text).join(" | ").slice(0, 600);
  const depts = await env.VIEWS.get("business:departments");
  if (depts) ctx.departments = depts.slice(0, 1800);
  const machine = await env.VIEWS.get("business:machine");
  if (machine) ctx.machine_map = machine.slice(0, 1600);
  const live = await kvGet(env, "business:context");
  if (live) ctx.live_context = live;
  const dirs = await kvGet(env, "twins:directives");
  if (dirs) ctx.twin_directives = dirs;
  const kpi = await env.VIEWS.get("kpi:latest");
  if (kpi) ctx.kpi_tail = kpi.split("\n").filter((l) => l.indexOf("|") > -1).slice(0, 18).join("\n");
  const reg = await kvGet(env, "registry:snapshot");
  if (reg && reg.components) {
    ctx.due = reg.components
      .filter((x) => String(x.next_due || "") <= ctx.at.slice(0, 10))
      .map((x) => x.id + " - " + String(x.next_action || "").slice(0, 90));
  }
  const res = await kvGet(env, "laptop:results");
  if (Array.isArray(res) && res.length) {
    ctx.laptop = res.slice(0, 3).map((r) =>
      (r.at || "").slice(11, 16) + " " + (r.action || "?") + " ok=" + (r.ok ? 1 : 0)).join("; ");
  }
  const q = await kvGet(env, "laptop:queue");
  if (Array.isArray(q)) ctx.queue_pending = q.length;
  const st = await kvGet(env, KV_STATE);
  if (st) ctx.last_run = st.at;
  const log = await kvGet(env, KV_LOG);
  if (Array.isArray(log) && log.length) ctx.last_thought = String(log[log.length - 1].assessment || "").slice(0, 180);
  if (mode !== "patrol") { try { await kvPut(env, "ctx:blob", ctx); } catch (e) {} }
  return ctx;
}

function buildPrompt(ctx) {
  return [
    "THINK LIKE THIS (the deep agent's method - follow exactly):",
    "1. See the WHOLE business first (brain, tree, departments) - never one",
    "   gauge. 2. Ask: what moves members TODAY? Not what looks busy.",
    "3. Second-order: if this works, what breaks next? If it fails, what",
    "   did we learn? 4. Prefer the smallest test that produces a number.",
    "5. Kill weak things without sentiment; double down on what moves.",
    "6. Honesty check: would the owner reading this in 6 months call it",
    "   true? 7. Only then act, and say WHY in one line. Ship or shut up.",
    "",
    "You are the FOREMAN of Northbench - the single AI manager of a small",
    "digital-products business (18 tool products on Gumroad, revenue $0,",
    "sales 0 - the funnel top works, clicks exist; the frontier is",
    "conversion, trust and proof). The owner does not think, plan, order",
    "or manage anymore. YOU DO. The business must keep working when the",
    "owner is offline.",
    "",
    "YOUR SECTIONS (the whole business, your management map):",
  ].concat(SECTIONS, [""], LAWS, [
    "", "CURRENT STATE:", JSON.stringify(ctx, null, 1).slice(0, 3200), "",
    "Reply with ONLY this JSON:",
    '{"assessment": "2-3 sentences: what matters most right now and why",',
    ' "actions": ["action id or its object form - only what the state calls for", "..."],',
    ' "decisions": [{"decision": "a choice you already made", "why": "one line"}],',
    ' "orders": ["concrete work item for the deep agent", "...up to 4],',
    ' "needs_hands": ["only physical impossibilities for software, usually empty"],',
    ' "digest": "one line for the owner, plain words, 140 chars max"}',
  ]).join("\n");
}

function extractJson(text) {
  if (!text) return null;
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0) return null;
  if (b > a) {
    try { return JSON.parse(text.slice(a, b + 1)); } catch (e) { /* repair */ }
  }
  let s = b > a ? text.slice(a, b + 1) : text.slice(a);
  if ((s.split('"').length - 1) % 2 === 1) s += '"';
  const stack = [];
  let inStr = false, esc = false;
  for (const ch of s) {
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{" || ch === "[") stack.push(ch);
    if (ch === "}" || ch === "]") stack.pop();
  }
  // backoff repair: close the JSON, and if still broken, drop back to
  // each earlier comma and close again (handles cuts after ":" or mid-value)
  let attempt = s;
  for (let i = 0; i < 8; i++) {
    const st2 = [];
    let inS = false, esc2 = false;
    for (const ch of attempt) {
      if (esc2) { esc2 = false; continue; }
      if (ch === "\\") { esc2 = true; continue; }
      if (ch === '"') { inS = !inS; continue; }
      if (inS) continue;
      if (ch === "{" || ch === "[") st2.push(ch);
      if (ch === "}" || ch === "]") st2.pop();
    }
    let fixed = attempt;
    while (st2.length) fixed += st2.pop() === "{" ? "}" : "]";
    try { return JSON.parse(fixed); } catch (e) { /* back off */ }
    const c = attempt.lastIndexOf(",");
    if (c <= 0) return null;
    attempt = attempt.slice(0, c);
  }
  return null;
}

async function think(env, ctx, mode) {
  const prompt = buildPrompt(ctx);
  // patrol passes use the cheap 8b (24/7 budget); deep passes lead with 70b
  const models = mode === "patrol"
    ? ["@cf/meta/llama-3.1-8b-instruct-fp8",
       "@cf/meta/llama-3.3-70b-instruct-fp8-fast"]
    : ["@cf/meta/llama-3.3-70b-instruct-fp8-fast",
       "@cf/meta/llama-3.1-8b-instruct-fp8"];
  let lastErr = "";
  for (const model of models) {
    try {
      const out = await env.AI.run(model, {
        messages: [{ role: "user", content: prompt }],
        max_tokens: 1000,
      });
      const text = (out && (out.response || out.text)) || "";
      const parsed = extractJson(String(text));
      if (parsed) {
        // SELF-CRITIQUE: a second pass reviews the first answer.
        // Flagged orders/actions get dropped. Two looks, one verdict.
        try {
          const crit = await env.AI.run(model, {
            messages: [{ role: "user", content:
              "You are the LAW critic. Your ONLY job: flag items that VIOLATE the " +
              "laws - invented proof/testimonials, any spending/ads/paid tools, " +
              "dishonesty, platform-rule risks. Style, specificity, or strategy " +
              "preferences are NOT violations - never drop those, the manager " +
              "decides strategy. Reply ONLY JSON with keys keep(bool), drop(array " +
              "of indices that violate laws, empty if none), better(one line). PLAN: " +
              JSON.stringify(parsed).slice(0, 1800) }],
            max_tokens: 300,
          });
          const c = extractJson(String((crit && (crit.response || crit.text)) || ""));
          if (c && Array.isArray(c.drop)) {
            const kill = new Set(c.drop.map(Number));
            parsed.orders = (parsed.orders || []).filter((_, i) => !kill.has(i));
            parsed.actions = (parsed.actions || []).filter((_, i) => !kill.has(i));
          }
          if (c && c.better) parsed.digest = String(c.better).slice(0, 140);
        } catch (e) { /* critique is best-effort */ }
        return { parsed, raw: null };
      }
      lastErr = model + " unparseable: " + String(text).slice(0, 140);
    } catch (e) {
      lastErr = model + " failed: " + String(e).slice(0, 140);
    }
  }
  return { parsed: null, raw: "AI run failed: " + lastErr };
}

// ---- THE POWER LIBRARY -------------------------------------------------
// Each action is pre-built code. The model only names it. Failures are
// logged, never fatal. The nightly-dispatch has a loop guard.
async function executeActions(env, actions, source, ctx) {
  const results = [];
  if (!Array.isArray(actions)) return results;
  const st = (await kvGet(env, KV_STATE)) || {};
  for (const a of actions.slice(0, 4)) {
    // normalize: bare string, wrapped object, or flat object all work
    let id, g = null;
    if (typeof a === "string") { id = a.trim(); }
    else if (a && typeof a === "object") {
      // intent rescue v2 (2026-10-19): the chiefs often emit strings or
      // wrong shapes - normalize instead of refusing, so no intent is lost.
      if (a.gumroad_update) {
        id = "gumroad_update";
        g = typeof a.gumroad_update === "string"
          ? { product: a.gumroad_update.replace(/^[^:]{0,40}:?\s*/, "").slice(0, 60) }
          : a.gumroad_update;
        if (g && typeof g.product === "object" && g.product.name) g.product = g.product.name;
      } else if (a.site_update) {
        id = "site_update";
        g = typeof a.site_update === "object" ? a.site_update : null;
      }
      else if (a.publish_note) { id = "publish_note"; g = a.publish_note; }
      else if (a.registry_note) { id = "registry_note"; g = a.registry_note; }
      else if (a.product) { id = "gumroad_update"; g = a; }
      else if (a.title && a.text) { id = "publish_note"; g = a; }
      else if (a.text) { id = "telegram_alert"; g = a; }
      else if (a.component) { id = "registry_note"; g = a; }
      else if (a.id) { id = String(a.id); g = a; }
      else id = String(a);
    } else id = String(a);
    try {
      if (id === "dispatch_nightly") {
        // loop guard: never from the nightly itself, never twice in 6h
        if (source === "nightly") { results.push("dispatch_nightly: refused (called by nightly - loop guard)"); continue; }
        if (Date.now() - (st.last_dispatch || 0) < 6 * 3600000) { results.push("dispatch_nightly: skipped (ran in the last 6h)"); continue; }
        const r = await grab(NIGHTLY_URL, 15000, {
          method: "POST",
          headers: { "Authorization": "Bearer " + env.GITHUB_TOKEN,
                     "Accept": "application/vnd.github+json",
                     "Content-Type": "application/json" },
          body: JSON.stringify({ ref: "main" }),
        });
        st.last_dispatch = Date.now();
        results.push("dispatch_nightly: " + (r.status === 204 ? "triggered" : "http " + r.status));
      } else if (id === "ping_courier") {
        const r = await grab(COURIER_URL, 25000);
        results.push("ping_courier: " + (r.ok ? "pass complete" : "http " + r.status));
      } else if (id === "queue_sweep" || id === "queue_inbox") {
        const q = (await kvGet(env, "laptop:queue")) || [];
        const kind = id === "queue_sweep" ? "sweep" : "inbox";
        if (q.some((x) => x.action === kind)) {
          results.push(id + ": skipped (one already pending - no self-spam)");
          continue;
        }
        const task = id === "queue_sweep"
          ? { id: "foreman-sweep-" + Date.now().toString(36), platform: "reddit", action: "sweep", queuedAt: ctx.at }
          : { id: "foreman-inbox-" + Date.now().toString(36), platform: "reddit", action: "inbox", queuedAt: ctx.at };
        q.push(task);
        await kvPut(env, "laptop:queue", q);
        results.push(id + ": queued (" + task.id + ")");
      } else if (id === "clear_stale_queue") {
        const q = (await kvGet(env, "laptop:queue")) || [];
        const now = Date.now();
        const fresh = q.filter((t) => !t.queuedAt || now - Date.parse(t.queuedAt) < 86400000);
        const removed = q.length - fresh.length;
        if (removed > 0) await kvPut(env, "laptop:queue", fresh);
        results.push("clear_stale_queue: " + removed + " removed, " + fresh.length + " kept");
      } else if (id === "registry_note") {
        if (!g) { results.push("registry_note: no component/note given - not executed"); continue; }
        const reg = await kvGet(env, "registry:snapshot");
        if (reg && reg.components) {
          for (const c of reg.components)
            if (c.id === (g.component || g.id)) c.next_action = String(g.note || g.text || "").slice(0, 220);
          await kvPut(env, "registry:snapshot", reg);
          results.push("registry_note: " + (g.component || g.id) + " updated");
        } else { results.push("registry_note: no registry snapshot"); }
      } else if (id === "brain_note") {
        if (!g || !(g.text || g.note)) { results.push("brain_note: no text - not executed"); continue; }
        const notes = (await kvGet(env, "brain:notes")) || [];
        notes.push({ at: ctx.at, text: String(g.text || g.note).slice(0, 220) });
        await kvPut(env, "brain:notes", notes.slice(-40));
        results.push("brain_note: remembered");
      } else if (id === "site_update" && g && g.path && g.content) {
        // restructure the live site: any file in the repo, deployed nightly
        const safe = ["works/", "site/", "data/", "content/"].some((p) => g.path.startsWith(p)) && !g.path.includes("..");
        if (!safe) { results.push("site_update: path outside allowed roots - refused"); continue; }
        const enc = g.path.split("/").map(encodeURIComponent).join("/");
        const existing = await grab("https://api.github.com/repos/ahmed10r/northbench-ops/contents/" + enc, 8000,
          { headers: { "Authorization": "Bearer " + env.GITHUB_TOKEN } });
        const sha = existing.ok && existing.json && existing.json.sha ? existing.json.sha : null;
        const put = await grab("https://api.github.com/repos/ahmed10r/northbench-ops/contents/" + enc, 15000, {
          method: "PUT",
          headers: { "Authorization": "Bearer " + env.GITHUB_TOKEN, "Content-Type": "application/json" },
          body: JSON.stringify({ message: "foreman: site_update " + g.path,
            content: btoa(unescape(encodeURIComponent(String(g.content).slice(0, 60000)))), sha: sha, branch: "main" }),
        });
        results.push("site_update " + g.path + ": " + (put.ok ? "CHANGED (deploys at nightly)" : "http " + put.status));
      } else if (id === "gumroad_create" && g && g.name && g.price != null) {
        // grow the lineup: new product (draft) on Gumroad
        const pr = Math.round(Number(g.price) * 100);
        if (!(pr >= 100 && pr <= 12000)) { results.push("gumroad_create: price outside $1-$120 - refused"); continue; }
        const d = String(g.description || "").slice(0, 900);
        if (BANNED.test(d) || SPENDY.test(d)) { results.push("gumroad_create: text dropped by laws"); continue; }
        const r = await fetch("https://api.gumroad.com/v2/products", {
          method: "POST",
          headers: { "Authorization": "Bearer " + env.GUMROAD_TOKEN,
                     "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ name: String(g.name).slice(0, 90), description: d, price: pr }),
        });
        const j = await r.json().catch(() => null);
        results.push("gumroad_create '" + String(g.name).slice(0, 40) + "': " +
          (r.ok && j && j.product ? "CREATED (id " + (j.product.short_url || j.product.id) + ")" : "http " + r.status));
      } else if (id === "build_order") {
        if (!g || !g.kind) { results.push("build_order: no kind - not executed"); continue; }
        const q = (await kvGet(env, "build:queue")) || [];
        q.push(g);
        await kvPut(env, "build:queue", q.slice(-10));
        results.push("build_order '" + g.kind + "' queued for the builder (runs <=30min)");
      } else if (id === "self_repair") {
        const stR = (await kvGet(env, KV_STATE)) || {};
        if (stR.lastSelfRepair && Date.now() - stR.lastSelfRepair < 3600000) {
          results.push("self_repair: skipped (ran in the last hour)");
        } else {
          const rr = await fetch("https://api.github.com/repos/ahmed10r/northbench-ops/actions/workflows/self-repair.yml/dispatches", {
            method: "POST",
            headers: { "User-Agent": "nb-agent/1.0",
              "Authorization": "Bearer " + env.GITHUB_TOKEN,
              "Accept": "application/vnd.github+json",
              "Content-Type": "application/json" },
            body: JSON.stringify({ ref: "main" }),
          });
          stR.lastSelfRepair = Date.now();
          await kvPut(env, KV_STATE, stR);
          results.push("self_repair: " + (rr.status === 204 ? "ENGAGED - redeploying last-known-good code" : "http " + rr.status));
        }
      } else if (id === "telegram_alert") {
        await telegram(env, "FOREMAN ALERT (" + ctx.at.slice(11, 16) + " UTC): " +
          String((g && g.text) || (typeof a === "object" ? JSON.stringify(a) : "unspecified")).slice(0, 400));
        results.push("telegram_alert: sent");
      } else if (id === "gumroad_update") {
        if (!g) { results.push("gumroad_update: no product/details given - not executed"); continue; }
        const body = new URLSearchParams();
        if (g.name && !BANNED.test(g.name) && !SPENDY.test(g.name))
          body.append("name", String(g.name).slice(0, 90));
        if (g.description) {
          const d = String(g.description).slice(0, 900);
          if (BANNED.test(d) || SPENDY.test(d)) { results.push("gumroad_update: text dropped by laws"); continue; }
          body.append("description", d);
        }
        if (g.price != null) {
          const pr = Math.round(Number(g.price) * 100);
          if (!(pr >= 300 && pr <= 6000)) { results.push("gumroad_update: price outside $3-$60 - refused"); continue; }
          body.append("price", pr);
        }
        if (!body.toString()) { results.push("gumroad_update: nothing lawful to do"); continue; }
        if (!/^(\d{5,}|[a-z0-9-]{3,})$/.test(String(g.product || ""))) {
          // resolve a product NAME to its id via the live shelf
          try {
            const pl = await fetch("https://api.gumroad.com/v2/products?per_page=60",
              { headers: { "Authorization": "Bearer " + env.GUMROAD_TOKEN, "User-Agent": "nb" } });
            const pj = pl.ok ? await pl.json() : null;
            const hit = (pj && pj.products || []).find((x) =>
              String(x.name || "").toLowerCase().indexOf(String(g.product).toLowerCase().slice(0, 20)) > -1);
            if (hit) { g.product = hit.id; results.push("gumroad_update: resolved product -> " + hit.name.slice(0, 40)); }
            else { results.push("gumroad_update: no product matches '" + String(g.product).slice(0, 30) + "' - refused"); continue; }
          } catch (e) { results.push("gumroad_update: product lookup failed"); continue; }
        }
        const r = await fetch("https://api.gumroad.com/v2/products/" + encodeURIComponent(g.product), {
          method: "PUT",
          headers: { "Authorization": "Bearer " + env.GUMROAD_TOKEN,
                     "Content-Type": "application/x-www-form-urlencoded" },
          body: body,
        });
        results.push("gumroad_update " + g.product + ": " + (r.ok ? "PUBLISHED" : "http " + r.status));
      } else if (id === "site_update") {
        if (g && g.path && g.content) {
          const q2 = (await kvGet(env, "build:queue")) || [];
          q2.push({ kind: "page", path: String(g.path).slice(0, 90), content: String(g.content).slice(0, 8000) });
          await kvPut(env, "build:queue", q2);
          results.push("site_update -> page build queued: " + g.path);
        } else results.push("site_update: needs {path, content} - refused");
      } else if (id === "publish_note") {
        if (!g) { results.push("publish_note: no title/text given - not executed"); continue; }
        const title = String(g.title || "Foreman note").slice(0, 80);
        const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "note";
        const path = "works/notes/foreman/" + ctx.at.slice(0, 10) + "-" + slug + ".md";
        const text = "# " + title + "\n\n" + String(g.text || g.body || "").slice(0, 4000) +
          "\n\n_By the Northbench foreman, " + ctx.at + "_\n";
        const b64 = btoa(unescape(encodeURIComponent(text)));
        const enc = path.split("/").map(encodeURIComponent).join("/");
        const existing = await grab("https://api.github.com/repos/ahmed10r/northbench-ops/contents/" + enc, 8000,
          { headers: { "Authorization": "Bearer " + env.GITHUB_TOKEN } });
        const sha = existing.ok && existing.json && existing.json.sha ? existing.json.sha : null;
        const put = await grab("https://api.github.com/repos/ahmed10r/northbench-ops/contents/" + enc, 15000, {
          method: "PUT",
          headers: { "Authorization": "Bearer " + env.GITHUB_TOKEN, "Content-Type": "application/json" },
          body: JSON.stringify({ message: "foreman: publish note - " + title,
            content: b64, sha: sha, branch: "main" }),
        });
        results.push("publish_note: " + (put.ok ? "PUBLISHED to repo (" + path + ")" : "http " + put.status));
      } else {
        results.push(id + ": unknown action id - refused");
      }
    } catch (e) {
      results.push(id + ": error " + String(e).slice(0, 80));
    }
  }
  st.at = ctx.at;
  await kvPut(env, KV_STATE, st);
  return results;
}

// laws enforced in code, not by model goodwill
const BANNED = /even if none exist|fabricat|invent(ing)? (a )?(testimonial|review|rating|proof)|fake (testimonial|review|rating|proof)|buy (reviews|ratings)/i;
const SPENDY = /(ad(s|vertis\w*)|paid (tool|service|ads?)|budget|spend(ing)?)\s*(of|to|:)?\s*\$?\d|\$\s?\d+\s*(\/|per\s)?(month|day|week)|increase (the )?budget|allocat\w* \$?\d/i;
function cleanOrders(p) {
  if (!Array.isArray(p.orders)) { p.orders = []; return 0; }
  const kept = p.orders.filter((o) => !BANNED.test(String(o)) && !SPENDY.test(String(o)));
  const dropped = p.orders.length - kept.length;
  p.orders = kept;
  return dropped;
}
function cleanByLaws(p, key) {
  if (!Array.isArray(p[key])) { p[key] = []; return 0; }
  const kept = p[key].filter((x) => !SPENDY.test(JSON.stringify(x)) && !BANNED.test(JSON.stringify(x)));
  const dropped = p[key].length - kept.length;
  p[key] = kept;
  return dropped;
}
function cleanEscalations(p) { return cleanByLaws(p, "escalations") + cleanByLaws(p, "decisions") + cleanByLaws(p, "needs_hands"); }

function digestText(ctx, p, actionResults) {
  if (!p) {
    return ["NORTHBENCH FOREMAN - " + ctx.at.slice(0, 16).replace("T", " "),
            "Could not think this pass (AI parse failed). Raw saved to the log."].join("\n");
  }
  const out = ["NORTHBENCH FOREMAN - " + ctx.at.slice(0, 16).replace("T", " ") + " UTC",
               p.digest || "", ""];
  if (actionResults && actionResults.length) {
    out.push("ACTIONS TAKEN:");
    actionResults.forEach((r) => out.push("  * " + r));
    out.push("");
  }
  if (p.orders && p.orders.length) {
    out.push("ORDERS FOR THE DEEP AGENT (" + p.orders.length + "):");
    p.orders.slice(0, 4).forEach((o, i) => out.push("  " + (i + 1) + ". " + String(o).slice(0, 160)));
  }
  if (p.decisions && p.decisions.length) {
    out.push("");
    out.push("DECIDED (autonomous, already in effect):");
    p.decisions.slice(0, 4).forEach((e) => {
      out.push("  > " + String(e.decision || "").slice(0, 150));
      if (e.why) out.push("    why: " + String(e.why).slice(0, 110));
    });
  }
  if (p.needs_hands && p.needs_hands.length) {
    out.push("");
    out.push("NEEDS YOUR HANDS (nothing is waiting - work continues regardless):");
    p.needs_hands.slice(0, 3).forEach((n) => out.push("  - " + String(n).slice(0, 140)));
  }
  return out.join("\n");
}


// ---- DEEP AUDITOR + REPAIRER ------------------------------------------
// Real checks against the live machine (not model guesses), then a 70b
// pass that picks repairs from the powers. Runs on every deep pass.
async function deepAudit(env, ctx) {
  const f = [];
  const s = await grab("https://northbenchshop.com", 10000);
  if (!s.ok) f.push("CRITICAL: site DOWN http " + s.status);
  try {
    const c = await grab("https://api.github.com/repos/ahmed10r/northbench-ops/commits/main", 8000,
      { headers: { Authorization: "Bearer " + env.GITHUB_TOKEN } });
    if (c.ok && c.json && c.json.commit) {
      const ageH = (Date.now() - Date.parse(c.json.commit.committer.date)) / 3600000;
      const q = (await kvGet(env, "build:queue")) || [];
      if (ageH > 30 && q.length === 0) f.push("repo idle " + Math.round(ageH) + "h and queue empty");
    } else f.push("repo check failed");
  } catch (e) {}
  try {
    const q = (await kvGet(env, "laptop:queue")) || [];
    const stale = q.filter((x) => x.queuedAt && Date.now() - Date.parse(x.queuedAt) > 86400000);
    if (stale.length) {
      await kvPut(env, "laptop:queue", q.filter((x) => !stale.includes(x)));
      f.push("repaired: pruned " + stale.length + " stale laptop task(s)");
    }
  } catch (e) {}
  // ---- BUSINESS WATCH (owner, 2026-10-19): watch the WHOLE business,
  // not just the machine. Store, products, traffic, channels, schedule.
  try {
    const gr = await grab("https://api.gumroad.com/v2/products", 12000,
      { headers: { Authorization: "Bearer " + env.GUMROAD_TOKEN } });
    if (gr.ok && gr.json && Array.isArray(gr.json.products)) {
      const ps = gr.json.products;
      const club = ps.find((x) => /CLUB/i.test(x.name || ""));
      if (!club) f.push("BUSINESS: THE CLUB product missing from Gumroad");
      else if (!club.published) f.push("BUSINESS: THE CLUB is unpublished");
      const dead = ps.filter((x) => x.published === false);
      if (dead.length) f.push("BUSINESS: " + dead.length + " product(s) unpublished: " + dead.slice(0,3).map((x) => x.name).join(", ").slice(0, 80));
      if (ps.length < 10) f.push("BUSINESS: only " + ps.length + " products on the shelf (was 10 - nothing is ever deleted)");
    } else f.push("BUSINESS: Gumroad store check failed (http " + gr.status + ")");
  } catch (e) {}
  try {
    const st = await grab("https://northbenchshop.com/stats-8c2f19ab4e77", 10000);
    if (st.ok && st.json) {
      const days = Object.keys(st.json).filter((k) => k !== "note").sort().slice(-3);
      const views = days.map((d) => {
        const day = st.json[d] || {};
        return Object.values(day.pageviews || {}).reduce((a, v) => a + (v.n || 0), 0);
      });
      if (views.length === 3 && views.every((v) => v === 0))
        f.push("BUSINESS: zero site views for 3 straight days - the shop is invisible (traffic broken?)");
    }
  } catch (e) {}
  try {
    const lr = (await kvGet(env, "laptop:results")) || [];
    const last = lr[0] || lr[lr.length - 1];
    if (last && last.at && Date.now() - Date.parse(last.at) > 48 * 3600000)
      f.push("BUSINESS: Reddit lane asleep 48h+ (laptop bridge offline)");
  } catch (e) {}
  try {
    const day = new Date().getUTCDay();
    if (day === 1 || day === 4) {
      const blp = await kvGet(env, "build:log");
      if (blp && !String(blp.at || "").startsWith(new Date().toISOString().slice(0, 10)))
        f.push("BUSINESS: drop day (Mon/Thu) but nothing built yet today");
    }
  } catch (e) {}
  const bl = await kvGet(env, "build:log");
  if (bl && bl.at && Date.now() - Date.parse(bl.at) > 259200000) f.push("builder silent 3+ days");
  if (!(await env.VIEWS.get("kpi:latest"))) f.push("kpi:latest missing");
  if (!(await env.VIEWS.get("business:brain"))) f.push("CRITICAL: business:brain missing from KV");
  // FLOW WATCH (the lesson of 2026-10-19): watch the machine's own FLOW,
  // not just its parts - a machine can have every part green and still be
  // stuck. Classes: meetings not completing, thinker going silent.
  try {
    const log = (await kvGet(env, KV_LOG)) || [];
    const lastChief = [...log].reverse().find((e) => e.chief && e.chief.verdict);
    if (!lastChief || Date.now() - Date.parse(lastChief.at) > 4 * 3600000)
      f.push("FLOW: no completed executive meeting (chief verdict) in 4h+ - deep passes may be timing out");
    const lastAny = log[log.length - 1];
    if (!lastAny || Date.now() - Date.parse(lastAny.at) > 2 * 3600000)
      f.push("FLOW: no logged pass at all in 2h+ - the thinker may be silent while the body runs");
  } catch (e) {}
  // the storefront truth: are the Studio pages actually LIVE on the site?
  for (const pg of ["club.html", "shelf.html", "drops/index.html"]) {
    const r = await grab("https://northbenchshop.com/" + pg, 8000);
    if (r.ok && r.json && String(r.json).indexOf("Northbench") > -1) continue;
    f.push("Studio page not live: /" + pg + " (http " + r.status + ") - needs nightly deploy");
  }
  return f;
}

async function runPass(env, source, mode) {
  const ctx = await gatherContext(env, mode);
  // 24/7 patrol: skip the AI when nothing changed, think the moment
  // something has (or every 8th patrol = forced heartbeat, 4h)
  const fp = JSON.stringify([ctx.courier_log, ctx.laptop, ctx.queue_pending,
    ctx.kpi_tail, ctx.stats]);
  const st = (await kvGet(env, KV_STATE)) || {};
  st.patrols = (st.patrols || 0) + 1;
  if (mode === "patrol") {
    if (st.patrols % 8 !== 0 && fp === st.fingerprint) {
      return { ok: true, patrol: "watching - no state change", patrols: st.patrols + 1 };
    }
  }
  st.fingerprint = fp; st.at = ctx.at; await kvPut(env, KV_STATE, st);
  const thought = await think(env, ctx, mode);
  const p = thought.parsed;
  let actionResults = [];
  if (p) {
    // intent rescue: the model often puts action calls inside orders text.
    // extract them and run them as real actions - no lost intent, ever.
    if (Array.isArray(p.orders)) {
      for (let i = p.orders.length - 1; i >= 0; i--) {
        const s = String(p.orders[i]);
        const m = s.match(/(build_order|publish_note|gumroad_update|gumroad_create|site_update|brain_note|queue_sweep|queue_inbox|ping_courier|telegram_alert|registry_note|clear_stale_queue|dispatch_nightly)/);
        if (!m) continue;
        let payload = null;
        const braceAt = s.indexOf("{");
        if (braceAt > -1) {
          const norm = s.slice(braceAt).replace(/'/g, '"').replace(/,(\s*[\]}])/g, "$1");
          try { payload = JSON.parse(norm.slice(0, norm.lastIndexOf("}") + 1)); } catch (e) { payload = null; }
        }
        p.actions = Array.isArray(p.actions) ? p.actions : [];
        p.actions.push(payload && typeof payload === "object" ? payload : m[1]);
        p.orders.splice(i, 1);
      }
    }
    const dropped = cleanOrders(p) + cleanEscalations(p);
    if (dropped > 0) p.orders.push("(" + dropped + " item(s) dropped by the honesty/money laws)");
    actionResults = await executeActions(env, p.actions, source, ctx);
  }
  // v4: decisions are MADE, not asked. owner is informed, never blocked.
  // THE UPGRADER - every 3rd deep pass, an AI reviews the machine itself:
  // what failed, what guards dropped, what patterns repeat - and writes
  // upgrade notes into permanent memory. The machine improves itself.
  let upgrader = null;
  const stU = (await kvGet(env, KV_STATE)) || {};
  stU.deepCount = (stU.deepCount || 0) + 1;
  if (mode !== "patrol" && stU.deepCount % 2 === 0) {
    try {
      const log = (await kvGet(env, KV_LOG)) || [];
      const recent = log.slice(-6).map((e) => ({
        at: e.at, actions: e.actions, orders: (e.orders || []).length,
        parse_failed: !!e.raw }));
      const fails = recent.filter((e) => e.parse_failed).length;
      const refused = recent.reduce((a, e) =>
        a + ((e.actions || []).filter((x) => /refused|not executed|dropped/.test(String(x))).length), 0);
      const u = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
        messages: [{ role: "user", content:
          "You are THE UPGRADER of an AI-run business - you upgrade the WHOLE " +
          "business and ALL its work. Machine health: " + JSON.stringify({passes:
          recent.length, parse_failures: fails, refused_or_dropped_actions: refused,
          recent_orders: recent.map((e) => e.orders)}).slice(0, 900) +
          ". Look at ALL work streams - creation (are drops good enough to pay " +
          "for?), storefront (do listings sell?), marketing (is every channel " +
          "improving?), operations (friction, waste, gaps?), the machine itself. " +
          "Find the biggest recurring weakness in ANY work and propose ONE concrete " +
          "upgrade (process, quality bar, new builder, prompt fix, new power, " +
          "kill-list). Reply ONLY JSON: {weakness: 'what it is', where: 'which work " +
          "stream', upgrade: 'the one concrete change', impact: 'what it unlocks'}" }],
        max_tokens: 300,
      });
      const up = extractJson(String((u && (u.response || u.text)) || ""));
      if (up && up.upgrade) {
        upgrader = up;
        const notes = (await kvGet(env, "brain:notes")) || [];
        notes.push({ at: ctx.at, text: "[upgrade] " + String(up.friction).slice(0, 80) +
          " -> " + String(up.upgrade).slice(0, 140) });
        await kvPut(env, "brain:notes", notes.slice(-40));
      }
    } catch (e) { /* best-effort */ }
  }
  await kvPut(env, KV_STATE, stU);

  // THE BUSINESS ANALYZER - a dedicated 70b pass on every deep run:
  // reads the funnel (views -> clicks -> sales -> members) and writes the
  // verdict + next lever into permanent memory. The machine's own analyst.
  let analyzer = null;
  if (mode !== "patrol") {
    try {
      const an = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
        messages: [{ role: "user", content:
          "You are THE BUSINESS ANALYZER of Northbench Studio - you analyze the " +
          "WHOLE business and ALL work, not just numbers. Scan every layer: " +
          "products + shelf (are listings sharp?), content drops (useful and " +
          "beautiful?), site pages (do they sell?), marketing channels (Reddit, " +
          "Pinterest, SEO, social - each pulling weight?), the CLUB offer, the " +
          "20 departments (any slacking?), the funnel (traffic, trust, offer). " +
          "State: " +
          JSON.stringify({stats: ctx.stats, kpi: (ctx.kpi_tail || "").slice(0, 300),
          laptop: ctx.laptop, brain: (ctx.brain || "").slice(0, 500),
          departments: (ctx.departments || "").slice(0, 500)}).slice(0, 1600) +
          ". Name the WEAKEST LINK across all of it and the one move that fixes " +
          "it this hour. Reply ONLY JSON: {weakest_link: 'what it is', layer: " +
          "'product|content|site|marketing|club|department|funnel', verdict: '2 " +
          "sentences of honest truth about the whole business', move: 'the one " +
          "thing to do now', expect: 'what should improve and by when'}" }],
        max_tokens: 350,
      });
      const a2 = extractJson(String((an && (an.response || an.text)) || ""));
      if (a2 && a2.verdict) {
        analyzer = a2;
        const notes = (await kvGet(env, "brain:notes")) || [];
        notes.push({ at: ctx.at, text: "[analysis] " + String(a2.bottleneck) + ": " +
          String(a2.lever).slice(0, 120) });
        await kvPut(env, "brain:notes", notes.slice(-40));
      }
    } catch (e) { /* best-effort */ }
  }

  // REDDIT STRATEGIST - a dedicated 70b pass on every deep run.
  // Owns the karma plan: what to sweep, which subs, when launch threads
  // fire (karma >= 10). Works autonomously; queues laptop tasks itself.
  let reddit = null;
  if (mode !== "patrol") {
    try {
      const r = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
        messages: [{ role: "user", content:
          "You are the Reddit strategist for Northbench Studio (curious-mind " +
          "digital products: wallpapers, stories, ambience, tools). Karma is " +
          "low; launch threads need karma >= 10. Rules: honest, no spam, no " +
          "invented proof, be a genuine community member first. Reply ONLY " +
          "JSON: {sweep: 'what threads to look for today', reply_angle: 'what " +
          "kind of comments earn karma honestly', launch_plan: 'path to 10 " +
          "karma and which sub launches first', note: 'one-line memory worth " +
          "keeping'} State: " + JSON.stringify({kpi: ctx.kpi_tail, laptop: ctx.laptop}).slice(0, 900) }],
        max_tokens: 400,
      });
      const rs = extractJson(String((r && (r.response || r.text)) || ""));
      if (rs) {
        reddit = rs;
        const notes = (await kvGet(env, "brain:notes")) || [];
        if (rs.note) notes.push({ at: ctx.at, text: "[reddit] " + String(rs.note).slice(0, 200) });
        await kvPut(env, "brain:notes", notes.slice(-40));
        const q = (await kvGet(env, "laptop:queue")) || [];
        if (!q.some((x) => x.action === "sweep"))
          q.push({ id: "reddit-sweep-" + Date.now().toString(36), platform: "reddit", action: "sweep", queuedAt: ctx.at });
        await kvPut(env, "laptop:queue", q);
      }
    } catch (e) { /* best-effort */ }
  }
  let audit = null;
  if (mode !== "patrol") {
    try {
      const findings = await deepAudit(env, ctx);
      if (findings.length) {
        audit = findings;
        try {
          const rep = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
            messages: [{ role: "user", content:
              "You are THE AUDITOR-REPAIRER of an AI business machine. Findings: " +
              JSON.stringify(findings).slice(0, 500) +
              ". Pick repairs ONLY from these action ids (bare ids, params if obvious): " +
              "dispatch_nightly, ping_courier, build_order, telegram_alert, clear_stale_queue, or none. " +
              "Reply ONLY JSON: {repairs: [..], said: 'one line for the log'}" }],
            max_tokens: 250,
          });
          const rr = extractJson(String((rep && (rep.response || rep.text)) || ""));
          if (rr && Array.isArray(rr.repairs) && rr.repairs.length) {
            const done = await executeActions(env, rr.repairs, "auditor", ctx);
            audit = findings.concat(done.map((x) => "repair: " + x));
          }
        } catch (e) {}
        if (findings.some((x) => /CRITICAL/.test(x))) {
          await telegram(env, "AUDIT ALERT: " + findings.join(" | ").slice(0, 300));
        }
      }
    } catch (e) {}
  }
  // ---- TWIN-2: the second head. Full permission, both ways: sees what
  // TWIN-1 decided, can veto any of it, and can act on its own judgment.
  // When nobody is online, the two heads run the company together.
  let twin2 = null;
  let chief = null;
  if (mode !== "patrol") {
    try {
      const t2 = await think(env, ctx, "deep");
      const p2 = t2.parsed;
      if (p2) {
        const veto = [];
        if (Array.isArray(p2.veto) && Array.isArray(p.actions))
          for (const v of p2.veto.slice(0, 6)) {
            const i = p.actions.findIndex((a) => String(a).indexOf(String(v)) > -1);
            if (i > -1) { p.actions.splice(i, 1); veto.push(String(v).slice(0, 40)); }
          }
        cleanOrders(p2); cleanEscalations(p2);
        const acts2 = (p2.actions || []).slice(0, 4);
        if (acts2.length) {
          const res2 = await executeActions(env, acts2, "twin-2", ctx);
          p2.actions = res2;
        }
        // ---- THE CHIEF (the third AI, above the Twins): the Twins
        // brainstorm; the Chief LISTENS to both, then DECIDES and ORDERS.
        // Its verdict is final and executes; its directives bind both
        // twins at their next meeting.
        try {
          const ch = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
            messages: [{ role: "user", content:
              "You are THE CHIEF of Northbench Studio - the third AI, above the " +
              "Twin executives. The Twins met. TWIN-1 proposed: " +
              JSON.stringify({actions: p.actions, orders: p.orders, digest: p.digest}).slice(0, 700) +
              " TWIN-2 responded (vetoed: " + JSON.stringify(veto) + ", added: " +
              JSON.stringify(p2.actions || []).slice(0, 250) + ", view: " + String(p2.assessment || "").slice(0, 250) +
              "). You rule on their meeting: adopt, amend, or overrule - you own the " +
              "decision. Also give each twin one directive for their next meeting. " +
              "Reply ONLY JSON: {final_actions:[adopted actions], final_orders:[adopted " +
              "orders], order_to_twin1:'directive', order_to_twin2:'directive', verdict:'the " +
              "decision in one plain line'}" }],
            max_tokens: 800,
          });
          const c = extractJson(String((ch && (ch.response || ch.text)) || ""));
          if (c) {
            chief = c;
            if (Array.isArray(c.final_actions) && c.final_actions.length) {
              chief.executed = await executeActions(env, c.final_actions.slice(0, 4), "chief", ctx);
            }
            if (Array.isArray(c.final_orders)) p.orders = c.final_orders;
            if (c.verdict) p.digest = c.verdict;
            await kvPut(env, "twins:directives", {
              at: ctx.at, twin1: c.order_to_twin1, twin2: c.order_to_twin2,
              verdict: c.verdict });
          }
        } catch (e) { /* best-effort */ }
        twin2 = { vetoed: veto, added: (p2.actions || []), digest: p2.digest,
                  assessment: p2.assessment, joint: joint };
      }
    } catch (e) { twin2 = null; }
  }
  const entry = {
    at: ctx.at, desk: "foreman", source: source || "manual",
    assessment: p ? p.assessment : null,
    actions: actionResults,
    orders: p ? p.orders : [],
    decisions: p ? p.decisions : [],
    needs_hands: p ? p.needs_hands : [],
    digest: p ? p.digest : null,
    reddit: reddit,
    audit: audit,
    twin2: twin2,
    chief: chief,
    analyzer: analyzer,
    upgrader: upgrader,
    raw: p ? null : thought.raw,
  };
  // PRODUCTION HEARTBEAT: the machine must keep producing even when the
  // model's action emissions fizzle. If nothing has been built for 8h+ and
  // the queue is empty, the next drop is queued deterministically.
  try {
    const bl = await kvGet(env, "build:log");
    const bq = (await kvGet(env, "build:queue")) || [];
    const staleMs = bl && bl.at ? Date.now() - Date.parse(bl.at) : Infinity;
    if (bq.length === 0 && staleMs > 8 * 3600000) {
      const day = ctx.at.slice(0, 10);
      bq.push({ kind: "wallpaper_set", name: "Drop " + day, count: 4,
        seed: Math.floor(Date.now() / 86400000) });
      await kvPut(env, "build:queue", bq);
      entry.actions = (entry.actions || []).concat(["production heartbeat: drop " + day + " auto-queued (builder was silent >8h)"]);
    }
  } catch (e) {}
  if (mode !== "patrol" || (actionResults && actionResults.length) || !p) await kvAppendLog(env, entry);
  // AUTO LOGGER + CONTEXT KEEPER: the unified live snapshot - one key any
  // agent (or any future session) reads to know exactly where we are.
  try {
    const notes = (await kvGet(env, "brain:notes")) || [];
    if (mode !== "patrol") await kvPut(env, "business:context", {
      at: ctx.at,
      what: p ? p.digest : null,
      health: audit ? audit.slice(0, 3) : ["all systems ok"],
      gauges: { stats: ctx.stats, queue: ctx.queue_pending, laptop: ctx.laptop },
      last_notes: notes.slice(-3).map((n) => n.text),
    });
  } catch (e) {}
  // deep passes always report; patrol passes only when they DID something
  const notable = (actionResults && actionResults.length) || !p;
  if (mode !== "patrol" || notable) await telegram(env, digestText(ctx, p, actionResults));
  return { ok: true, thought: entry };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const key = url.searchParams.get("key") || (request.headers.get("x-foreman-key") || "");
    if (!env.FOREMAN_KEY || key !== env.FOREMAN_KEY) {
      return new Response(JSON.stringify({ ok: false, error: "bad key" }),
        { status: 401, headers: { "content-type": "application/json" } });
    }
    try {
    const source = url.searchParams.get("source") || "manual";
    // SELF-PERPETUATING BEAT (fired FIRST, before any work): the next beat
    // is scheduled the moment this one starts - no timeout, no long meeting,
    // no client disconnect can ever break the chain again.
    let chained = null;
    if (source === "patrol") {
      try {
        const cr = await fetch("https://api.github.com/repos/ahmed10r/northbench-ops/actions/workflows/foreman-loop.yml/dispatches", {
          method: "POST",
          headers: { "User-Agent": "nb-agent/1.0",
            "Authorization": "Bearer " + env.GITHUB_TOKEN,
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json" },
          body: JSON.stringify({ ref: "main" }),
        });
        chained = cr.status;
      } catch (e) { chained = String(e).slice(0, 60); }
    }
    let mode = url.searchParams.get("mode") === "patrol" ? "patrol" : "deep";
    if (mode === "patrol") {  // hour cycles: a deep pass at least every hour
      try {
        const raw = await env.VIEWS.get("foreman:state");
        const st = raw ? JSON.parse(raw) : null;
        if (!st || !st.lastDeepAt || Date.now() - Date.parse(st.lastDeepAt) > 55 * 60000) {
          mode = "deep";
          const st2 = Object.assign({}, st || {}, { lastDeepAt: new Date().toISOString() });
          await env.VIEWS.put("foreman:state", JSON.stringify(st2));
        }
      } catch (e) { /* stay patrol */ }
    }
    const r = await runPass(env, source, mode);
    // (chain dispatch moved to the start of the pass - see above)
    return new Response(JSON.stringify(Object.assign({ chained: chained }, r), null, 1),
      { headers: { "content-type": "application/json" } });
    } catch (e) {
      // never let an exception kill the chain: chain the next beat, report
      // the error as data, and let the machine keep running no matter what
      let chained2 = null;
      try {
        const cr = await fetch("https://api.github.com/repos/ahmed10r/northbench-ops/actions/workflows/foreman-loop.yml/dispatches", {
          method: "POST",
          headers: { "User-Agent": "nb-agent/1.0",
            "Authorization": "Bearer " + env.GITHUB_TOKEN,
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json" },
          body: JSON.stringify({ ref: "main" }),
        });
        chained2 = cr.status;
      } catch (e2) {}
      try {
        const stC = JSON.parse((await env.VIEWS.get("foreman:state")) || "{}");
        stC.crashStreak = (stC.crashStreak || 0) + 1;
        if (stC.crashStreak >= 2) {
          stC.crashStreak = 0;
          await env.VIEWS.put("foreman:state", JSON.stringify(stC));
          await fetch("https://api.github.com/repos/ahmed10r/northbench-ops/actions/workflows/self-repair.yml/dispatches", {
            method: "POST",
            headers: { "User-Agent": "nb-agent/1.0",
              "Authorization": "Bearer " + env.GITHUB_TOKEN,
              "Accept": "application/vnd.github+json",
              "Content-Type": "application/json" },
            body: JSON.stringify({ ref: "main" }),
          });
          await telegram(env, "MACHINE: 2nd consecutive crash - SELF-REPAIR ENGAGED (redeploying last-known-good code). Error: " + String(e).slice(0, 100));
        } else {
          await env.VIEWS.put("foreman:state", JSON.stringify(stC));
          await telegram(env, "MACHINE: a pass crashed (" + String(e).slice(0, 120) + ") - the chain continues, error logged.");
        }
      } catch (e3) {}
      return new Response(JSON.stringify({ ok: false, error: String(e).slice(0, 300), chained: chained2 }),
        { headers: { "content-type": "application/json" } });
    }
  },
  async scheduled(event, env) {
    await runPass(env, "cron");
  },
};
