#!/usr/bin/env node
// --------------------------------------------------------------- northbench
// LAPTOP BRIDGE v3 - my hands on the owner's laptop.
//
//   MODES
//     (normal)        one pass: connect if needed, run today's tasks, report
//     --live          stay open: poll the courier every 2 minutes and do
//                     whatever I queue (comments, messages, edits, deletes,
//                     reads) - this is remote control
//     --test          rehearsal: types everything but never submits/sends
//     --selftest      full chain check, never posts
//
//   The Google login can be auto-typed from nb-credentials.json, so the
//   owner just watches (any extra Google challenge is still his to finish).
// --------------------------------------------------------------- northbench

const fs = require("fs");
const path = require("path");

const VERSION = 43;   // bump on every ship; the cloud carries the latest

const PLAN_URL = "https://northbench-courier.a7maaadesmail93.workers.dev/?laptop=628fc1f007c0a791712f2f6f0da515481880315a";
const PROFILE = path.join(__dirname, "nb-profile");      // stays logged in
const LOG = path.join(__dirname, "activity.log");
const STATE = path.join(__dirname, "nb-state.json");     // connect + guards
const CREDS_F = path.join(__dirname, "nb-credentials.json");
const TEST = process.argv.includes("--test");
const LIVE = process.argv.includes("--live");
const SELFTEST = process.argv.includes("--selftest");
const CONNECT_TIMEOUT_MS = (parseInt(process.env.NB_CONNECT_TIMEOUT || "600", 10)) * 1000;
const POLL_MS = 20000;    // live mode: the flow - ask the courier every 20 seconds
let lastStatusAt = 0, lastCodeAt = 0, lastIdleSaid = 0;

// ------------------------------------------------------------ console+log
const log = (m) => {
  const line = new Date().toISOString().slice(0, 16).replace("T", " ") + "  " + m;
  console.log(line);
  try { fs.appendFileSync(LOG, line + "\n"); } catch (e) {}
};
const say = (m) => { console.log(m); try { fs.appendFileSync(LOG, m + "\n"); } catch (e) {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);
const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch (e) { return {}; } };
const saveState = (st) => { try { fs.writeFileSync(STATE, JSON.stringify(st, null, 1)); } catch (e) {} };
const creds = (() => { try { return JSON.parse(fs.readFileSync(CREDS_F, "utf8")); } catch (e) { return {}; } })();
const os = require("os");
// machine-WIDE lock: two copies in two different folders must not fight
const LOCKDIR = path.join(os.homedir(), ".northbench");
const LOCK = path.join(LOCKDIR, "nb.lock");
const WHO = process.pid + "@" + __dirname.length.toString(36) + Math.abs(__dirname.length * 7).toString(36);
let st_browserPref = null;   // set from state once loaded - adaptive switching
const lockStale = () => { try { return Date.now() - fs.statSync(LOCK).mtimeMs > 90000; } catch (e) { return true; } };
const touchLock = () => { try { fs.mkdirSync(LOCKDIR, { recursive: true }); fs.writeFileSync(LOCK, String(Date.now())); } catch (e) {} };

// ------------------------------------------------------------- the cloud
async function talkToCloud(params) {
  const r = await fetch(PLAN_URL + params, { headers: { "accept": "application/json" },
    signal: AbortSignal.timeout(45000) });
  if (!r.ok) throw new Error("courier answered HTTP " + r.status);
  return r.json();
}
async function reportStatus(what, extra) {
  try { await talkToCloud("&status=" + encodeURIComponent(JSON.stringify(Object.assign({ what: what, who: WHO }, extra || {})))); }
  catch (e) { say("   (could not tell the cloud: " + e.message + ")"); }
}
async function reportTask(task, outcome) {
  // queued tasks (they have an id) report rich results back to me;
  // auto comment tasks record the thread url as done
  // NB37: a failed report must never lose a result - the task is already
  // in doneIds and will never re-run, so buffer it and flush next cycle
  if (task.id) {
    const payload = { id: task.id, action: task.action || "?", ok: !!outcome.ok,
      data: outcome.data !== undefined ? outcome.data : (outcome.result || ""),
      error: outcome.error || null };
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { await talkToCloud("&result=" + encodeURIComponent(JSON.stringify(payload))); return; }
      catch (e) {
        if (attempt < 3) { say("   (report failed, retry " + attempt + "/3: " + e.message + ")"); await sleep(5000); }
        else {
          say("   (could not report after 3 tries - buffering for next cycle)");
          try {
            const st0 = JSON.parse(fs.readFileSync(STATE, "utf8"));
            st0.pendingReports = (st0.pendingReports || []).concat([{ task: { id: task.id, action: task.action || "?" }, payload }]);
            fs.writeFileSync(STATE, JSON.stringify(st0));
          } catch (e2) { say("   (buffer write failed too: " + e2.message + ")"); }
        }
      }
    }
    return;
  }
  try {
    if (task.action === "comment" && outcome.ok && outcome.result !== "dry-run") {
      await talkToCloud("&done=" + encodeURIComponent(task.url));
    }
  } catch (e) { say("   (could not report this task: " + e.message + ")"); }
}

// NB37: flush buffered reports from cycles where the courier was unreachable
async function flushPendingReports(st) {
  const pend = st.pendingReports || [];
  if (!pend.length) return;
  const still = [];
  for (const p of pend) {
    try { await talkToCloud("&result=" + encodeURIComponent(JSON.stringify(p.payload))); say("  (flushed a buffered report: " + p.task.id + ")"); }
    catch (e) { if (!p.at) p.at = Date.now(); if (Date.now() - p.at < 86400000) still.push(p); }
  }
  st.pendingReports = still;
  saveState(st);
}
async function fetchPlan() { return talkToCloud(""); }

// self-update: the cloud carries the newest code; if it is newer than this
// file, replace myself and restart (exit code 42 = the .bat loops and reruns)
async function maybeSelfUpdate() {
  try {
    const r = await fetch(PLAN_URL + "&code=1", { headers: { "accept": "application/json" },
      signal: AbortSignal.timeout(45000) });
    const j = await r.json();
    const cur = fs.readFileSync(__filename, "utf8");
    if (j.version && j.version > VERSION && j.src && j.src !== cur) {
      say("  update from the cloud: v" + VERSION + " -> v" + j.version + " - restarting myself...");
      fs.writeFileSync(__filename + ".new", j.src);
      fs.renameSync(__filename + ".new", __filename);
      try { const old = new Date(Date.now() - 120000); fs.utimesSync(LOCK, old, old); } catch (e) {}
      process.exit(42);
    }
    if (j.version && j.version > VERSION) say("  (cloud code v" + j.version + " is already here)");
  } catch (e) { /* an update check must never break the run */ }
}

// ------------------------------------------------------------ the browser
async function launch() {
  const { chromium } = require("playwright-core");
  const base = {
    headless: false, slowMo: 60,
    viewport: { width: 1100, height: 750 },
    args: ["--disable-blink-features=AutomationControlled", "--no-first-run",
           "--disable-session-crashed-bubble", "--start-maximized"],
  };
  let lastErr = null;
  const ORDER = ["chrome", "msedge", "chromium"];
  const start = ORDER.indexOf(st_browserPref) >= 0 ? ORDER.indexOf(st_browserPref) : 0;
  const order = ORDER.slice(start).concat(ORDER.slice(0, start));
  for (const which of order) {
    try {
      const opts = which === "chromium" ? base : Object.assign({ channel: which }, base);
      const ctx = await chromium.launchPersistentContext(PROFILE, opts);
      return { ctx: ctx, which: which === "chrome" ? "Chrome" : which === "msedge" ? "Edge" : "Chromium" };
    } catch (e) { lastErr = e; }
  }
  throw new Error("no Chrome or Edge found on this laptop - install Google Chrome from google.com/chrome, then run again. (" + (lastErr && lastErr.message) + ")");
}

// the universal finder: layered strategies (text, placeholder, name, id,
// css), size-checked - one finder to rule every page reddit redesigns
async function findFlex(page, spec) {
  const tries = [];
  if (spec.text) {
    tries.push('text="' + spec.text + '"');
    tries.push(':is(button,[role="button"],a,span,div):has-text("' + spec.text + '")');
  }
  if (spec.placeholder) tries.push('input[placeholder*="' + spec.placeholder + '" i], textarea[placeholder*="' + spec.placeholder + '" i]');
  if (spec.name) tries.push((spec.tag || "input") + '[name="' + spec.name + '"]');
  if (spec.id) tries.push("#" + spec.id);
  if (spec.css) tries.push(spec.css);
  for (const sel of tries) {
    try {
      const loc = page.locator(sel).first();
      if (!(await loc.count())) continue;
      if (!(await loc.isVisible().catch(() => false))) continue;
      if (spec.minH || spec.minW) {
        const b = await loc.boundingBox();
        if (!b) continue;
        if (spec.minH && b.height < spec.minH) continue;
        if (spec.minW && b.width < spec.minW) continue;
      }
      return loc;
    } catch (e) { /* next strategy */ }
  }
  return null;
}

// readiness engine: wait for a content signal; a dead shell gets one reload
async function readyPage(page, url, signalFn, timeoutMs, label) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  const t0 = Date.now();
  let reloaded = false;
  while (Date.now() - t0 < (timeoutMs || 45000)) {
    await sleep(3000);
    if (await signalFn(page).catch(() => false)) return true;
    if (!reloaded && Date.now() - t0 > 20000) {
      reloaded = true;
      say("   (" + (label || "page") + " looks empty - one reload...");
      await page.reload({ waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => {});
    }
  }
  return false;
}

// learned memory: what worked last time gets tried first next time
function knowGet(key) {
  try { const st = JSON.parse(fs.readFileSync(STATE, "utf8")); return (st.know || {})[key] || null; } catch (e) { return null; }
}
function knowSet(key, val) {
  try {
    const st = JSON.parse(fs.readFileSync(STATE, "utf8"));
    st.know = st.know || {}; st.know[key] = { val: val, at: new Date().toISOString() };
    fs.writeFileSync(STATE, JSON.stringify(st, null, 1));
  } catch (e) {}
}

async function isLoggedIn(page) {
  try {
    const v = await page.evaluate(() => {
      const app = document.querySelector("shreddit-app");
      if (app) {
        const a = app.getAttribute("user-logged-in");
        if (a === "true") return true;
        if (a === "false") return false;
      }
      const btns = Array.from(document.querySelectorAll("button, a"));
      for (const b of btns) {
        const t = (b.textContent || "").trim();
        if (t === "Log In" || t === "Log in") {
          const r = b.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return false;
        }
      }
      return null;
    });
    if (v === true || v === false) return v;
    return await page.evaluate(() => !!document.querySelector(
      'faceplate-tracker[noun="profile"], shreddit-accountmenu-trigger, button[aria-label*="profile" i]'));
  } catch (e) { return false; }
}

// wait for the login page to actually render its form (hydration is slow
// sometimes; the sandbox even gets a challenge wall that never renders)
async function waitLoginReady(page, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const ready = await page.evaluate(() => {
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      if (document.querySelector("input")) return true;
      const els = Array.from(document.querySelectorAll("button, a, [role=\"button\"]"));
      return els.some((el) => /google|apple|continue|log in/i.test((el.textContent || "")) && vis(el));
    }).catch(() => false);
    if (ready) return true;
    await sleep(3000);
  }
  return false;
}

// auto-type the Google login (only ever on accounts.google.com). Returns a
// short reason string; the human still finishes any extra Google challenge.
async function autoGoogleLogin(ctx, page) {
  if (!creds.google_email || !creds.google_password) return "no saved credentials";
  try {
    const ready = await waitLoginReady(page, 30000);
    if (!ready) return "the login page never finished loading";
    const gbtn = page.locator('button:has-text("Google"), a:has-text("Google"), [role="button"]:has-text("Google")').first();
    if (!(await gbtn.count())) return "no Continue-with-Google button";
    say("   auto-typing your Google login - just watch (finish any extra Google check if it asks)...");
    await gbtn.click();
    await sleep(5000);
    let g = null;
    for (let i = 0; i < 6 && !g; i++) {
      g = ctx.pages().find((p) => p.url().includes("accounts.google.com"));
      if (!g) await sleep(2000);
    }
    if (!g) return "Google page never opened";
    // email
    const em = g.locator("#identifierId, input[type=\"email\"]").first();
    if (!(await em.count())) return "no email field on the Google page";
    await em.fill(creds.google_email, { timeout: 15000 });
    await sleep(rnd(600, 1200));
    await g.locator("#identifierNext button, #identifierNext, button:has-text(\"Next\")").first().click();
    await sleep(5000);
    // password - ONLY type it on a real accounts.google.com page
    if (!g.url().includes("accounts.google.com")) return "left the Google page early";
    const pw = g.locator("input[type=\"password\"]").first();
    if (await pw.count()) {
      await pw.fill(creds.google_password, { timeout: 15000 });
      await sleep(rnd(600, 1200));
      await g.locator("#passwordNext button, #passwordNext, button:has-text(\"Next\")").first().click();
      await sleep(6000);
    }
    const html = (await g.content().catch(() => "")) || "";
    if (html.includes("This browser or app may not be secure")) return "Google wants a normal human login this time";
    if (html.includes("Couldn&#39;t find your Google Account") || html.includes("Couldn't find your Google Account")) return "Google does not know that email";
    if (html.includes("Wrong password")) return "Google says wrong password";
    if (html.includes("2-Step") || html.includes("Verify") || html.includes("recovery")) return "Google is asking an extra check - finish it in the window";
    return "typed - waiting for Reddit to accept it";
  } catch (e) { return "auto-login stumbled: " + (e && e.message); }
}

// Reddit's own username + password form - no Google involved at all
async function nativeLogin(page) {
  if (!creds.reddit_user || !creds.google_password) return "no saved reddit credentials";
  try {
    await waitLoginReady(page, 15000);
    const user = page.locator('input[name="username"], input#loginUsername, input[placeholder*="sername" i], input[type="text"]').first();
    if (!(await user.count())) return "no username field on the page";
    say("   auto-typing your Reddit username + password - just watch...");
    await user.fill(creds.reddit_user, { timeout: 15000 });
    await sleep(rnd(500, 1000));
    // combined form (both fields) or two-step (Continue reveals password)?
    let pw = page.locator('input[type="password"]').first();
    if (!(await pw.count()) || !(await pw.isVisible().catch(() => false))) {
      const next = page.locator('button:has-text("Continue")').first();
      if (await next.count()) await next.click({ timeout: 8000 }).catch(() => {});
      await sleep(4000);
      pw = page.locator('input[type="password"]').first();
    }
    if (await pw.count()) {
      await pw.fill(creds.google_password, { timeout: 15000 });
      await sleep(rnd(500, 1000));
      const go = page.locator('button:has-text("Log In"), button:has-text("Log in")').first();
      if (await go.count()) {
        await go.click({ timeout: 8000 }).catch(async () => {
          await page.keyboard.press("Enter");   // disabled button? Enter still submits
        });
      }
      await sleep(6000);
    } else {
      return "the password field never appeared";
    }
    const html = (await page.content().catch(() => "")) || "";
    if (html.includes("Incorrect username or password")) return "Reddit says the password is wrong";
    if (html.includes("upvote") || html.includes("Create a post")) return "typed - waiting for Reddit to accept it";
    return "typed - waiting for Reddit to accept it";
  } catch (e) { return "native login stumbled: " + (e && e.message); }
}

async function ensureConnected(ctx, st) {
  const page = ctx.pages()[0] || (await ctx.newPage());
  say("   opening Reddit to check your login...");
  await page.goto("https://www.reddit.com/", { waitUntil: "domcontentloaded", timeout: 90000 });
  await sleep(4000);
  if (await isLoggedIn(page)) {
    say("   already logged in - the saved session works.");
    if (!st.connected) { st.connected = true; st.connectedAt = new Date().toISOString(); saveState(st); }
    return true;
  }
  say("");
  await page.goto("https://www.reddit.com/login/", { waitUntil: "domcontentloaded", timeout: 90000 });
  await sleep(3000);
  let why = await autoGoogleLogin(ctx, page);
  say("   (" + why + ")");
  if (why.indexOf("waiting") === -1) {
    why = await nativeLogin(page);
    say("   (" + why + ")");
  }
  if (why.indexOf("waiting") === -1) {
    say("   ============================================================");
    say("   THE CHROME WINDOW NEEDS YOU ONCE:");
    say("   LOG IN TO REDDIT WITH GOOGLE - exactly like always.");
    say("   The script waits and watches - up to 10 minutes.");
    say("   ============================================================");
  }
  const t0 = Date.now();
  while (Date.now() - t0 < CONNECT_TIMEOUT_MS) {
    await sleep(10000);
    say("   ...still waiting for the login");
    if (!page.url().includes("/login") && !page.url().includes("accounts.google.com")) {
      if (await isLoggedIn(page)) break;
      await page.goto("https://www.reddit.com/", { waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => {});
      await sleep(2000);
    }
    let loggedInAnywhere = false;
    for (const p of ctx.pages()) { if (await isLoggedIn(p)) { loggedInAnywhere = true; break; } }
    if (loggedInAnywhere || (await isLoggedIn(page))) break;
  }
  if (await isLoggedIn(page)) {
    say("   logged in - the session is saved. You never do this again.");
    st.connected = true; st.connectedAt = new Date().toISOString(); saveState(st);
    await reportStatus("connected");
    return true;
  }
  return false;
}

// ------------------------------------------------------ reddit: the hands
async function findComposer(page) {
  const trySel = async (sel) => {
    const el = page.locator(sel).first();
    if ((await el.count()) && (await el.isVisible().catch(() => false))) return el;
    return null;
  };
  // 0. learned memory first: the strategy that won last time
  const known = knowGet("composer");
  if (known && known.val) {
    const el0 = await trySel(known.val);
    if (el0) return el0;
  }
  // A. the full composer, already open
  let el = await trySel('shreddit-composer div[contenteditable="true"]');
  if (!el) el = await trySel('div[contenteditable="true"][data-lexical-editor="true"]');
  if (!el) el = await trySel('div[contenteditable="true"][role="textbox"]');
  if (el) return el;
  // B. the "Add a comment" pill - text= matches the SMALLEST element with
  // that exact text (buttons, divs, whatever reddit renders it as today)
  for (const sel of ['text="Add a comment"', 'text="Add a Comment"', '[data-testid="add-comment"]']) {
    const pill = page.locator(sel).first();
    if ((await pill.count()) && (await pill.isVisible().catch(() => false))) {
      await pill.click({ timeout: 4000 }).catch(() => {});
      await sleep(2500);
      el = await trySel('shreddit-composer div[contenteditable="true"]') ||
           await trySel('div[contenteditable="true"][role="textbox"]') ||
           await trySel('div[contenteditable="true"]');
      if (el) return el;
    }
  }
  // C. new reddit's fake input bar: a contenteditable styled like a field.
  // Click every real-sized one - one of them is the composer.
  const cands = await page.locator('div[contenteditable="true"]').all();
  for (const c of cands.slice(0, 6)) {
    try {
      await c.scrollIntoViewIfNeeded({ timeout: 3000 });
      const box = await c.boundingBox();
      if (box && box.height > 8 && box.width > 100) {
        await c.click({ timeout: 4000 }).catch(() => {});
        await sleep(1500);
        // clicking the bar may expand the real composer
        el = await trySel('shreddit-composer div[contenteditable="true"]');
        if (el) return el;
        return c;
      }
    } catch (e) { /* try the next one */ }
  }
  // D. scroll down - the composer often renders at the bottom of the thread
  for (let i = 0; i < 2 && !el; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await sleep(2000);
    el = await trySel('shreddit-composer div[contenteditable="true"]') ||
         await trySel('div[contenteditable="true"][role="textbox"]');
  }
  if (el) return el;
  return await trySel(".usertext-edit textarea");
}

// on failure, gather what the page actually shows so the fix is based on
// real data, not guesses
async function pageDiagnostics(page) {
  try {
    return await page.evaluate(() => {
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const texts = [];
      document.querySelectorAll("button, [role=button], a").forEach((el) => {
        const t = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (t && t.length < 40 && vis(el) && texts.length < 25) texts.push(t);
      });
      const app = document.querySelector("shreddit-app");
      const eds = [];
      document.querySelectorAll('div[contenteditable="true"]').forEach((e) => {
        if (eds.length < 3) eds.push(e.outerHTML.slice(0, 220));
      });
      const cmt = [];
      document.querySelectorAll("*").forEach((e) => {
        if (cmt.length < 10) return;
        const t = (e.childNodes.length === 1 && e.textContent || "").trim();
        if (/^add a comment$/i.test(t) || /^what are your thoughts$/i.test(t)) {
          cmt.push(e.tagName + "." + String(e.className).slice(0, 40));
        }
      });
      return { url: location.href.slice(0, 90),
               loggedIn: app ? app.getAttribute("user-logged-in") : null,
               hasLoginForm: !!document.querySelector('input[name="username"], input[type="password"]'),
               editables: eds, commentish: cmt, buttons: texts };
    });
  } catch (e) { return { diagError: String(e) }; }
}

async function openThreadLogged(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await sleep(rnd(3000, 5000));
  if (await findComposer(page)) return true;
  return false;
}

async function recoverLogin(ctx, st) {
  say("   the saved login looks gone - opening the login page for you.");
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto("https://www.reddit.com/login/", { waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => {});
  await sleep(2000);
  await autoGoogleLogin(ctx, page);
  const t0 = Date.now();
  while (Date.now() - t0 < CONNECT_TIMEOUT_MS && !(await isLoggedIn(page))) await sleep(15000);
  if (await isLoggedIn(page)) { st.connected = true; saveState(st); return true; }
  return false;
}

async function oldRedditComment(page, task) {
  const ourl = task.url.replace("//www.reddit.com", "//old.reddit.com");
  say("   switching to old Reddit for a reliable comment box...");
  await page.goto(ourl, { waitUntil: "domcontentloaded", timeout: 90000 });
  await sleep(3500);
  let ta = page.locator('.usertext-edit textarea, textarea[name="text"], form.comment-form textarea, #commentfield').first();
  if (!(await ta.count()) || !(await ta.isVisible().catch(() => false))) {
    await page.evaluate(() => window.scrollTo(0, 400)).catch(() => {});
    await sleep(1500);
    ta = page.locator('.usertext-edit textarea, textarea[name="text"], form.comment-form textarea, #commentfield').first();
  }
  if (!(await ta.count()) || !(await ta.isVisible().catch(() => false))) throw new Error("old reddit form not found");
  await ta.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  await ta.click();
  await sleep(600);
  await page.keyboard.insertText(task.text);
  await sleep(1000);
  if (TEST || task.__dry) { say("   REHEARSAL: typed on old reddit, NOT submitted."); await sleep(25000); return "dry-run"; }
  const save = page.locator('button.save, .usertext-edit button[type="submit"], button[type="submit"]').first();
  if (!(await save.count())) throw new Error("no save button on old reddit");
  await save.click();
  await sleep(6000);
  const body = await page.content();
  const landed = body.includes(task.text.slice(0, 40));
  say(landed ? "   posted (via old reddit) - visible on the page." : "   submitted on old reddit - verify soon.");
  return landed ? "posted" : "submitted";
}

async function redditReply(ctx, task) {
  const page = ctx.pages()[0] || (await ctx.newPage());
  say("   opening the thread: " + task.url);
  await page.goto(task.url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await sleep(rnd(3000, 5000));
  let box = await findComposer(page);
  if (!box && !(await isLoggedIn(page))) {
    if (await recoverLogin(ctx, loadState())) { await openThreadLogged(page, task.url); box = await findComposer(page); }
  } else if (!box) { await sleep(4000); box = await findComposer(page); }
  if (!box) {
    try { return await oldRedditComment(page, task); }
    catch (e) {
      const d = await pageDiagnostics(page);
      throw new Error("new reddit: no composer; old reddit: " + ((e && e.message) || e) +
        " | Diagnostics: " + JSON.stringify(d).slice(0, 700));
    }
  }

  const bb = await box.boundingBox();
  if (bb) await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2, { steps: 8 });
  await box.click();
  await sleep(rnd(800, 1500));
  await page.keyboard.insertText(task.text);
  await sleep(rnd(1200, 2400));
  if (TEST || task.__dry) {
    say("   REHEARSAL: the reply is typed but NOT submitted. Look at the Chrome window.");
    await sleep(30000);
    return "dry-run";
  }
  const btn = page.locator('button:has-text("Comment")').last();
  if (!(await btn.count())) throw new Error("the Comment button did not appear - nothing was posted.");
  await btn.click();
  await sleep(6000);
  const body = await page.content();
  const landed = body.includes(task.text.slice(0, 40));
  say(landed ? "   posted - the reply is visible on the page." : "   submitted - could not confirm on the page (check later).");
  return landed ? "posted" : "submitted";
}

async function readPage(ctx, url) {
  const page = ctx.pages()[0] || (await ctx.newPage());
  say("   reading: " + url);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  let data = null;
  for (let i = 0; i < 5; i++) {              // comments render slowly - be patient
    await sleep(5000);
    data = await page.evaluate(() => {
      const title = document.title;
      const h1 = document.querySelector("h1, [data-testid=\"post-title\"]");
      const cmts = [];
      document.querySelectorAll("shreddit-comment").forEach((c) => {
        if (cmts.length >= 8) return;
        if (c.parentElement && c.parentElement.closest("shreddit-comment")) return;  // top level only
        const md = c.querySelector(".md, [slot=\"comment\"]");
        const author = c.getAttribute("author") || "";
        const txt = (md ? md.innerText : c.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 350);
        if (txt) cmts.push(author + ": " + txt);
      });
      const body = (document.body.innerText || "").replace(/\\s+/g, " ").trim();
      return { title: title, heading: h1 ? h1.innerText.trim() : "",
               comments: cmts, snippet: body.slice(0, 1500) };
    });
    if (data.comments.length || data.heading) break;
  }
  if (!data.comments.length && !data.heading) {
    say("   the page never rendered real content (challenge or slow load).");
    return { ok: false, error: "page did not render", data: data };
  }
  say("   read it: " + (data.heading || data.title) + " - " + data.comments.length + " top comments");
  return { ok: true, data: data };
}

async function sendMessage(ctx, task) {
  const page = ctx.pages()[0] || (await ctx.newPage());
  const dest = "https://www.reddit.com/message/compose/?to=" + encodeURIComponent(task.to || "");
  say("   opening a private message to: " + task.to);
  await page.goto(dest, { waitUntil: "domcontentloaded", timeout: 90000 });
  await sleep(4000);
  const to = page.locator('input[name="to"], #to, input[placeholder*="sername"]').first();
  const sub = page.locator('input[name="subject"], #subject, input[placeholder*="ubject"], input[placeholder*="itle"]').first();
  const body = page.locator('textarea[name="text"], .usertext-edit textarea, div[contenteditable="true"]').first();
  if (!(await body.count())) throw new Error("no message box appeared - nothing was sent.");
  if ((await sub.count()) && !(await sub.inputValue()).trim()) { await sub.fill(task.subject || "hello"); await sleep(500); }
  await body.click();
  await page.keyboard.insertText(task.text);
  await sleep(1500);
  if (TEST || task.__dry) { say("   REHEARSAL: the message is typed but NOT sent."); await sleep(20000); return "dry-run"; }
  const send = page.locator('button[type="submit"], button:has-text("Send")').last();
  if (!(await send.count())) throw new Error("no Send button - nothing was sent.");
  await send.click();
  await sleep(5000);
  say("   sent.");
  return "sent";
}

async function editComment(ctx, task) {
  const page = ctx.pages()[0] || (await ctx.newPage());
  say("   editing your comment: " + task.url);
  await page.goto(task.url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await sleep(4000);
  const edit = page.locator('button:has-text("Edit")').first();
  if (!(await edit.count())) throw new Error("no Edit button (is this your own comment?) - nothing changed.");
  await edit.click();
  await sleep(2500);
  const box = page.locator('div[contenteditable="true"], textarea').first();
  if (!(await box.count())) throw new Error("the edit box did not open - nothing changed.");
  await box.click();
  await page.keyboard.press("Control+a");
  await sleep(400);
  await page.keyboard.insertText(task.text);
  await sleep(1200);
  if (TEST || task.__dry) { say("   REHEARSAL: new text typed but NOT saved."); await sleep(20000); return "dry-run"; }
  const save = page.locator('button:has-text("Save"), button:has-text("Done")').first();
  if (!(await save.count())) throw new Error("no Save button - nothing changed.");
  await save.click();
  await sleep(4000);
  say("   edited.");
  return "edited";
}

async function deleteComment(ctx, task) {
  const page = ctx.pages()[0] || (await ctx.newPage());
  say("   deleting your comment: " + task.url);
  await page.goto(task.url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await sleep(4000);
  const del = page.locator('button:has-text("Delete")').first();
  if (!(await del.count())) throw new Error("no Delete button (is this your own comment?)");
  await del.click();
  await sleep(1500);
  const confirm = page.locator('button:has-text("Delete")').last();
  if (await confirm.count()) await confirm.click();
  await sleep(4000);
  say("   deleted.");
  return "deleted";
}

// scan a subreddit's hot page - my eyes on Reddit through the home IP
async function scanSub(ctx, task) {
  const page = ctx.pages()[0] || (await ctx.newPage());
  say("SCAN " + (task.sub ? "r/" + task.sub : task.url) + ": reading hot page");
  await page.goto(task.url, { waitUntil: "domcontentloaded", timeout: 90000 });
  let data = null;
  for (let i = 0; i < 5; i++) {
    await sleep(5000);
    data = await page.evaluate(() => {
      const posts = [];
      document.querySelectorAll("shreddit-post").forEach((p) => {
        if (posts.length >= 15) return;
        const a = p.querySelector("a[slot=\"title\"], a[data-testid=\"post-title\"]");
        const h = p.querySelector("h3");
        const title = ((a && a.innerText) || (h && h.innerText) || p.getAttribute("post-title") || "").trim();
        let link = a ? a.href : "";
        if (!link) { const per = p.getAttribute("permalink"); if (per) link = "https://www.reddit.com" + per; }
        const cc = p.getAttribute("comment-count") || "";
        const sc = p.getAttribute("score") || "";
        if (title) posts.push({ title: title.slice(0, 140), url: (link || "").split("?")[0], comments: cc, score: sc });
      });
      return { sub: (location.pathname.split("/")[2] || ""), posts: posts };
    });
    if (data.posts.length) break;
  }
  say("SCAN r/" + (data.sub || task.sub || "?") + ": " + data.posts.length + " threads read");
  if (!data.posts.length) return { ok: false, error: "no posts rendered (challenge or slow load)", data: data };
  return { ok: true, data: data };
}

// update the Reddit profile (display name + about/bio)
// profile save the clean way: reddit's own save endpoint, called from the
// logged-in session. no ui, no selectors, nothing to break. the profile
// subreddit (u_NAME, a t5) carries the display name (title) and the
// about/bio (public_description), and site_admin saves both.
async function profileEditApi(page, task) {
  say("   saving your profile the clean way (reddit's own api)...");
  const r = await page.evaluate(async (args) => {
    try {
      const me = await (await fetch("/api/me.json?raw_json=1")).json();
      const mh = (me.data || {}).modhash || "";
      if (!mh) return { ok: false, why: "no modhash" };
      const about = await (await fetch("/user/" + args.user + "/about.json?raw_json=1")).json();
      const sub = ((about.data || {}).subreddit) || {};
      const sr = sub.fullname || (sub.id ? "t5_" + sub.id : "t5_k7jczq");
      const params = new URLSearchParams({ api_type: "json", sr: sr, name: "u_" + args.user, type: "user", uh: mh, link_type: "any", wikimode: "disabled", lang: "en" });
      if (args.displayName) params.set("title", args.displayName);
      if (args.text) params.set("public_description", args.text);
      const res = await fetch("/api/site_admin", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Modhash": mh }, body: params.toString() });
      const j = await res.json();
      const errs = (j.json && j.json.errors) || [];
      if (errs.length) return { ok: false, why: errs.map((e) => e[0] + "/" + e[2]).join(",") };
      const after = await (await fetch("/user/" + args.user + "/about.json?raw_json=1")).json();
      const s2 = ((after.data || {}).subreddit) || {};
      return { ok: true, title: (s2.title || "").slice(0, 40), desc: (s2.public_description || "").slice(0, 90) };
    } catch (e) { return { ok: false, why: String((e && e.message) || e).slice(0, 150) }; }
  }, { user: task.user || creds.reddit_user || "Glittering_Maize5380", displayName: task.displayName || "", text: task.text || "" });
  if (!r || !r.ok) throw new Error((r && r.why) || "no result");
  say("   profile saved: " + (r.title || "?") + " | " + (r.desc || "?"));
  return "saved (api)";
}

// the profile page's own edit button - a different reddit bundle than the
// stubborn settings page, and thread pages render fine in this chrome
async function profileModalEdit(page, task) {
  say("   trying your profile page's own edit button...");
  const user = task.user || creds.reddit_user || "me";
  const ok = await readyPage(page, "https://www.reddit.com/user/" + user + "/", async (p) =>
    (await p.locator('button:has-text("Edit profile"), [role="button"]:has-text("Edit profile"), button[aria-label*="Edit profile" i]').count()) > 0,
    45000, "profile page");
  const btn = await findFlex(page, { text: "Edit profile" }) || await findFlex(page, { css: 'button[aria-label*="Edit profile" i]' });
  if (!btn) throw new Error(ok ? "no Edit profile button found" : "profile page never showed the button");
  await btn.click({ timeout: 6000 });
  await sleep(4000);
  if (task.displayName) {
    const dn = await findFlex(page, { placeholder: "display" }) || await findFlex(page, { name: "displayName" });
    if (dn) { await dn.click().catch(() => {}); await sleep(300); await page.keyboard.insertText(task.displayName); await sleep(500); }
  }
  const bio = await findFlex(page, { placeholder: "about" }) ||
               await findFlex(page, { css: "textarea", minH: 40 }) ||
               await findFlex(page, { css: 'div[contenteditable="true"]', minH: 40, minW: 200 });
  if (!bio) throw new Error("no bio field in the edit view");
  await bio.click().catch(() => {});
  await sleep(400);
  await page.keyboard.insertText(task.text || "");
  await sleep(700);
  if (TEST || task.__dry) { say("   REHEARSAL: modal typed, NOT saved."); await sleep(15000); return "dry-run"; }
  const save = await findFlex(page, { text: "Save" }) || await findFlex(page, { text: "Save changes" }) ||
               await findFlex(page, { css: 'button[type="submit"]' });
  if (!save) throw new Error("no save control in the edit view");
  await save.click();
  await sleep(4500);
  say("   profile updated through the profile page.");
  return "saved (profile page)";
}

async function profileEdit(ctx, task) {
  const page = ctx.pages()[0] || (await ctx.newPage());
  say("   editing your Reddit profile...");
  let apiWhy = "";
  try {
    const r = await profileEditApi(page, task);
    knowSet("profile", "api");
    return r;
  } catch (e) {
    apiWhy = (e && e.message) || e;
    say("   (api route: " + apiWhy + ")");
  }
  try {
    const r = await profileModalEdit(page, task);
    knowSet("profile", "modal");
    return r;
  } catch (e) {
    const modalWhy = (e && e.message) || e;
    say("   (profile page modal: " + modalWhy + ")");
    try {
      await profileEditNew(page, task);
      knowSet("profile", "settings");
      return "saved";
    } catch (e) {
    const newWhy = (e && e.message) || e;
    say("   (new reddit profile page: " + newWhy + ")");
    let inv = "";
    try {
      inv = await page.evaluate(() => {
        const out = [];
        document.querySelectorAll("input, textarea, div[contenteditable=true]").forEach((el) => {
          const r = el.getBoundingClientRect();
          if (out.length < 12 && r.width > 0) out.push((el.tagName + " n=" + (el.name || "-") + " id=" + (el.id || "-") + " ph=" + (el.placeholder || "-").slice(0, 30)));
        });
        return out.join(" ; ");
      });
    } catch (e2) {}
      try {
        const r = await oldProfileEdit(page, task);
        knowSet("profile", "old");
        return r;
      } catch (e2) {
        throw new Error("api: " + apiWhy + " | modal: " + modalWhy + " | settings: " + newWhy + " | old: " + ((e2 && e2.message) || e2) +
          " | visible fields: " + inv.slice(0, 300));
      }
    }
  }
}

async function profileEditNew(page, task) {
  await page.goto("https://www.reddit.com/settings/profile/", { waitUntil: "domcontentloaded", timeout: 90000 });
  // the settings page is a slow SPA - the form shows up when it feels like it.
  // Poll up to ~40s instead of guessing once.
  let dn = null, bio = null;
  for (let i = 0; i < 14 && !bio; i++) {
    if (i === 7) { say("   settings page looks empty - reloading it once..."); await page.reload({ waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => {}); }
    await sleep(3500);
    dn = page.locator('input[name="displayName"], input#displayName, input[placeholder*="display" i]').first();
    bio = page.locator('textarea[name="about"], textarea#about, textarea[placeholder*="about" i], textarea[placeholder*="yourself" i], form textarea').first();
    if (!(await bio.count()) || !(await bio.isVisible().catch(() => false))) {
      // new reddit loves contenteditable - try a sized editable as the bio
      const eds = await page.locator('div[contenteditable="true"]').all();
      for (const c of eds.slice(0, 4)) {
        try {
          const b = await c.boundingBox();
          if (b && b.height > 30 && b.width > 200) { bio = c; break; }
        } catch (e) {}
      }
    }
    if (bio && !(await bio.count())) { bio = null; }
    if (!bio && i === 4) {
      const nav = page.locator('a:has-text("Profile"), [role="link"]:has-text("Profile")').first();
      if (await nav.count()) await nav.click({ timeout: 3000 }).catch(() => {});
    }
  }
  if (!bio) throw new Error("the profile form never loaded (SPA too slow) - nothing changed");
  if (dn && (await dn.count()) && task.displayName) { await dn.fill(task.displayName, { timeout: 10000 }); await sleep(600); }
  await bio.fill(task.text || "", { timeout: 10000 });
  await sleep(800);
  if (TEST || task.__dry) { say("   REHEARSAL: profile typed but NOT saved."); await sleep(15000); return "dry-run"; }
  await page.evaluate(() => window.scrollTo(0, 700)).catch(() => {});
  await sleep(1500);
  let save = null;
  for (const sel of ['button:has-text("Save")', '[role="button"]:has-text("Save")',
                     'button[type="submit"]', 'button:has-text("Done")']) {
    const c = page.locator(sel).first();
    if ((await c.count()) && (await c.isVisible().catch(() => false))) { save = c; break; }
  }
  if (!save) {
    const btns = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll("button, [role=button]").forEach((b) => {
        const r = b.getBoundingClientRect();
        const t = (b.textContent || "").replace(/\s+/g, " ").trim();
        if (r.width > 0 && t && out.length < 15) out.push(t.slice(0, 30));
      });
      return out.join(" | ");
    }).catch(() => "");
    throw new Error("no Save control. page buttons: " + btns.slice(0, 300));
  }
  await save.click();
  await sleep(5000);
  say("   profile updated.");
  return "saved";
}

// old-reddit profile: the decade-stable form, same fields
async function oldProfileEdit(page, task) {
  say("   trying old Reddit's profile form...");
  await page.goto("https://old.reddit.com/prefs/update/", { waitUntil: "domcontentloaded", timeout: 90000 });
  await sleep(3500);
  if (task.displayName) {
    const dn = page.locator('input[name="displayName"], #displayName').first();
    if (await dn.count()) { await dn.fill(task.displayName, { timeout: 8000 }); await sleep(400); }
  }
  const bio = page.locator('textarea[name="about"], #about, form textarea').first();
  if (!(await bio.count())) {
    // old reddit has no bio field - but the display name alone can still save
    if (task.displayName && (await page.locator('input[name="displayName"], #displayName').count())) {
      say("   old reddit: saving the display name only (bio lives on new reddit).");
      const sv = page.locator('button[type="submit"], .save').first();
      if (await sv.count()) { await sv.click(); await sleep(4000); return "display-name saved (old reddit; bio needs new reddit)"; }
    }
    throw new Error("no about field on old reddit either");
  }
  await bio.fill(task.text || "", { timeout: 8000 });
  await sleep(700);
  if (TEST || task.__dry) { say("   REHEARSAL: old-reddit profile typed, NOT saved."); return "dry-run"; }
  const save = page.locator('button[type="submit"], .save').first();
  if (!(await save.count())) throw new Error("no save button on old reddit");
  await save.click();
  await sleep(5000);
  say("   profile updated (old reddit).");
  return "saved";
}

async function checkInbox(ctx, task) {
  const page = ctx.pages()[0] || (await ctx.newPage());
  say("   checking your Reddit inbox...");
  await page.goto("https://old.reddit.com/message/inbox/", { waitUntil: "domcontentloaded", timeout: 90000 });
  await sleep(3500);
  const data = await page.evaluate(() => {
    const out = { unread: 0, items: [] };
    document.querySelectorAll("#siteTable .thing").forEach((t) => {
      if (out.items.length >= 15) return;
      const who = t.getAttribute("data-author") ||
        (t.querySelector(".correspondent a") ? t.querySelector(".correspondent a").innerText.trim() : "") ||
        (t.querySelector(".author") ? t.querySelector(".author").innerText.trim() : "");
      const subj = t.querySelector(".subject") ? t.querySelector(".subject").innerText.replace(/\s+/g, " ").trim() : "";
      const body = t.querySelector(".md") ? t.querySelector(".md").innerText.replace(/\s+/g, " ").trim().slice(0, 180) : "";
      const mid = t.getAttribute("data-fullname") || "";
      const isNew = t.className.indexOf("new") !== -1;
      if (isNew) out.unread++;
      if (who || subj) out.items.push({ who: who, subject: subj.slice(0, 90), snippet: body, mid: mid, unread: isNew });
    });
    // v38: karma scrape was returning empty on the current old-reddit layout.
    // try every known container, then the profile-side number as a fallback.
    const k = document.querySelector("#header-bottom-right .userkarma, .karma-info, .userkarma, span.karma, .karma");
    out.karma = k ? k.innerText.replace(/\s+/g, " ").trim() : "";
    if (!out.karma) {
      const u = document.querySelector("#header-bottom-right .user a");
      if (u) {
        const m = (u.getAttribute("href") || "").match(/\/user\/([^/]+)/);
        if (m) out.karma = "profile:/u/" + decodeURIComponent(m[1]);
      }
    }
    return out;
  });
  say("INBOX " + data.unread + " unread / " + data.items.length + " items" + (data.karma ? " | karma " + data.karma : ""));
  return { ok: true, data: data };
}

async function replyMessage(ctx, task) {
  const page = ctx.pages()[0] || (await ctx.newPage());
  const url = "https://old.reddit.com/message/messages/" + String(task.mid || "").replace(/^t4_/, "");
  say("   replying to message " + task.mid + "...");
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await sleep(3000);
  const ta = page.locator('.usertext-edit textarea, textarea[name="text"], form.comment textarea, form textarea').first();
  if (!(await ta.count()) || !(await ta.isVisible().catch(() => false))) throw new Error("no reply box on the message page - nothing sent");
  await ta.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  await ta.click();
  await sleep(500);
  await page.keyboard.insertText(task.text);
  await sleep(900);
  if (TEST || task.__dry) { say("   REHEARSAL: reply typed, NOT sent."); await sleep(15000); return "dry-run"; }
  const save = page.locator('button.save, button[type="submit"], input[type="submit"]').first();
  if (!(await save.count())) throw new Error("no send button - nothing sent");
  await save.click();
  await sleep(5000);
  say("   reply sent.");
  return "sent";
}

async function checkComment(ctx, task) {
  const page = ctx.pages()[0] || (await ctx.newPage());
  const ourl = task.url.replace("//www.reddit.com", "//old.reddit.com");
  say("   checking your comment's status...");
  await page.goto(ourl, { waitUntil: "domcontentloaded", timeout: 90000 });
  await sleep(3500);
  const data = await page.evaluate(() => {
    const c = document.querySelector(".comment");
    if (!c) return { found: false };
    return { found: true,
      score: c.querySelector(".score") ? c.querySelector(".score").innerText.trim() : "",
      replies: c.querySelectorAll(".replies .comment").length,
      author: c.getAttribute("data-author") || "",
      snippet: c.querySelector(".md") ? c.querySelector(".md").innerText.replace(/\s+/g, " ").slice(0, 150) : "" };
  });
  if (!data.found) return { ok: false, error: "comment not found on that page" };
  say("   comment status: score " + data.score + ", " + data.replies + " replies");
  return { ok: true, data: data };
}

// generic browse: my remote hands. The cloud sends steps - clicks, fills,
// waits, extracts - and this runs them. New tricks need NO code shipping.
async function doBrowse(ctx, task) {
  const page = ctx.pages()[0] || (await ctx.newPage());
  say("   browse: " + task.url);
  await page.goto(task.url, { waitUntil: "domcontentloaded", timeout: 90000 });
  const report = { extracts: {}, buttons: [], editables: 0, errors: [] };
  for (const step of (task.steps || [])) {
   try {
    if (step.wait) { await sleep(step.wait); }
    else if (step.reload) { await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {}); await sleep(3500); }
    else if (step.scroll) { await page.evaluate((y) => window.scrollTo(0, y), step.scroll).catch(() => {}); await sleep(800); }
    else if (step.click) {
      // patient: keep hunting, reload up to 4x - SPA pages render late
      const spec = typeof step.click === "string" ? { text: step.click } : step.click;
      let el = null; const t0 = Date.now(); let reloaded = 0;
      const marks = [8000, 18000, 32000, 48000];
      while (!el && Date.now() - t0 < 60000) {
        el = await findFlex(page, spec);
        if (!el) {
          const waited = Date.now() - t0;
          if (reloaded < marks.length && waited > marks[reloaded]) {
            say("   click: reloading the page to wake it up...");
            await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
            await sleep(4000); reloaded++;
          } else await sleep(2000);
        }
      }
      if (!el) {
        if (step.optional) { report.note = "skipped optional click: " + JSON.stringify(step.click).slice(0, 80); continue; }
        throw new Error("click target not found after retries: " + JSON.stringify(step.click).slice(0, 120));
      }
      await el.click({ timeout: 8000 }).catch((e) => { throw new Error("click failed: " + String(e.message).slice(0, 80)); });
      await sleep(step.after || 2500);
    }
    else if (step.fill) {
      // v41 playwright-native fill first: waits for the element and speaks
      // React natively; findFlex+keyboard stays as the fallback.
      const fillCss = (step.fill.target && step.fill.target.css) || step.fill.css;
      let filled = false;
      if (fillCss) {
        try { await page.locator(fillCss).first().fill(String(step.fill.value), { timeout: 12000 }); filled = true; }
        catch (e) { /* fall through to the legacy path */ }
      }
      if (!filled) {
        let el = null;
        for (let i = 0; i < 6 && !el; i++) { el = await findFlex(page, step.fill.target || { css: step.fill.css }); if (!el) await sleep(2000); }
        if (!el) throw new Error("fill target not found: " + JSON.stringify(step.fill).slice(0, 120));
        await el.click().catch(() => {});
        await sleep(400);
        await page.keyboard.insertText(String(step.fill.value));
      }
      await sleep(600);
    }
    else if (step.press) { await page.keyboard.press(step.press); await sleep(800); }
    else if (step.download) {
      // v43: the cloud can now hand the bridge files. Downloads to the
      // bridge's own folder, ready for setInputFiles. (cover art, assets)
      try {
        const resp = await ctx.request.get(step.download, { timeout: 60000 });
        if (!resp.ok()) throw new Error("download http " + resp.status());
        const fs = require("fs");
        const dlPath = step.to || ("nb-dl-" + Date.now());
        fs.writeFileSync(dlPath, await resp.body());
        report.download = { path: dlPath, bytes: fs.statSync(dlPath).size };
        say("   downloaded " + dlPath + " (" + fs.statSync(dlPath).size + " bytes)");
      } catch (e) { report.errors.push("download failed: " + String(e && e.message || e).slice(0, 150)); }
    }
    else if (step.setfile) {
      // v43: attach a local file to a file input (e.g. Gumroad cover art)
      const sf = typeof step.setfile === "string" ? { css: step.setfile, path: report.download && report.download.path } : step.setfile;
      try {
        await page.locator(sf.css).first().setInputFiles(sf.path || (report.download && report.download.path), { timeout: 15000 });
        report.setfile = "ok: " + (sf.path || report.download && report.download.path);
        await sleep(2500);
      } catch (e) { report.errors.push("setfile failed: " + String(e && e.message || e).slice(0, 150)); }
    }
    else if (step.run) {
      // a run step may never outlive the watchdog (7 min cycle): cap it at 4
      // minutes so a long poll cannot restart-loop the whole machine
      try {
        const cap = new Promise((res) => setTimeout(() => res({ error: "run step exceeded 4 minutes - capped" }), 240000));
        report.run = await Promise.race([page.evaluate("(async () => {" + step.run + "})()"), cap]);
      }
      catch (e) { report.run = { error: String(e && e.message || e).slice(0, 250) }; }
    }
    else if (step.html) {
      report.html = report.html || {};
      for (const name of Object.keys(step.html)) {
        try { report.html[name] = (await page.locator(step.html[name]).first().evaluate((el) => el.outerHTML).catch(() => "")) .slice(0, 900); }
        catch (e) { report.html[name] = null; }
      }
    }
    else if (step.extract) {
      for (const name of Object.keys(step.extract)) {
        try { report.extracts[name] = (await page.locator(step.extract[name]).first().innerText({ timeout: 3000 }) || "").slice(0, 600); }
        catch (e) { report.extracts[name] = null; }
      }
    }
   } catch (e) { report.errors.push(String((e && e.message) || e).slice(0, 220)); }
  }
  if (task.reportButtons !== false) {
    report.buttons = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll("button, [role=button], a").forEach((b) => {
        const r = b.getBoundingClientRect();
        const t = (b.textContent || "").replace(/\s+/g, " ").trim();
        if (r.width > 0 && t && t.length < 40 && out.length < 25) out.push(t);
      });
      return out;
    }).catch(() => []);
    report.editables = await page.evaluate(() => document.querySelectorAll('div[contenteditable="true"], textarea').length).catch(() => 0);
    report.fields = await page.evaluate(() => {
      const out = [];
      const walk = (root) => {
        root.querySelectorAll("input, textarea, [contenteditable=true]").forEach((el) => {
          const r = el.getBoundingClientRect();
          if (out.length < 15 && r.width > 0) out.push(el.tagName.toLowerCase() + " type=" + (el.type || "-") + " ph=" + String(el.placeholder || "-").slice(0, 40) + " name=" + (el.name || "-") + " shadow=" + (!el.isConnected || !!el.getRootNode().host ? "maybe" : "-"));
        });
        root.querySelectorAll("*").forEach((el) => { if (el.shadowRoot) walk(el.shadowRoot); });
      };
      walk(document);
      return out;
    }).catch(() => []);
  }
  report.errors = report.errors || [];
  return { ok: report.errors.length === 0, error: report.errors[0] || null, data: report };
}

// screenshot for the owner's eyes + page text for mine
async function doScreenshot(ctx, task) {
  const page = ctx.pages()[0] || (await ctx.newPage());
  if (task.url) { await page.goto(task.url, { waitUntil: "domcontentloaded", timeout: 90000 }); await sleep(4500); }
  const f = path.join(__dirname, "screenshot-" + Date.now() + ".png");
  await page.screenshot({ path: f }).catch(() => {});
  const txt = await page.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 1200)).catch(() => "");
  say("   screenshot saved: " + path.basename(f));
  return { ok: true, data: { file: path.basename(f), pageText: txt } };
}

// the sweep: read the newest posts across the working subs from here (the
// home ip never gets throttled) and report the qualifying threads upward.
// the cloud rss radar gets 429ed by reddit datacenter rules; this does not.
const SWEEP_SUBS = ["freelance", "freelancers", "smallbusiness", "Entrepreneur", "sidehustle",
  "personalfinance", "jobs", "Excel", "ecommerce", "wedding", "socialmedia",
  "SideProject", "IMadeThis", "AlphaandBetausers",
  "tutors", "onlineeducation", "teaching"];
const SWEEP_TOPICS = /freelanc|invoice|client|rate|charg|payment|paid|budget|spreadsheet|template|tracker|contract|proposal|money|pricing|job hunt|job search|interview|salary|offer|cold email|outreach|first client|content calendar|posting schedule|what to post|guest list|seating|wedding budget|vendor|my shop|listing|price change|first product|digital product|launch|net worth|debt|subscription|tutor|tuition|lesson plan|private tutoring|my students|student progress|tuition fee/i;
const SWEEP_JUNK = /\bM4F|F4M|ASMR|roleplay|NSFW|hiring|\bLF\b|looking for a|seeking a|petsit|\[hiring\]|\[for hire\]/i;

async function sweepSubs(ctx) {
  const page = ctx.pages()[0] || (await ctx.newPage());
  const found = []; const rulesOut = {};
  for (const sub of SWEEP_SUBS) {
    try {
      await page.goto("https://www.reddit.com/r/" + sub + "/new/", { waitUntil: "domcontentloaded", timeout: 90000 });
      let posts = [];
      for (let i = 0; i < 3; i++) {
        await sleep(4000);
        posts = await page.evaluate(() => {
          const out = [];
          document.querySelectorAll("shreddit-post").forEach((p) => {
            if (out.length >= 20) return;
            const a = p.querySelector('a[slot="title"], a[data-testid="post-title"]');
            const h = p.querySelector("h3");
            const title = ((a && a.innerText) || (h && h.innerText) || p.getAttribute("post-title") || "").trim();
            let link = a ? a.href : "";
            if (!link) { const per = p.getAttribute("permalink"); if (per) link = "https://www.reddit.com" + per; }
            const ts = p.getAttribute("created-timestamp") || "";
            if (title && link) out.push({ title: title.slice(0, 140), link: link.split("?")[0], ts: ts });
          });
          return out;
        });
        if (posts.length) break;
      }
      let hit = 0;
      for (const p of posts) {
        if (SWEEP_JUNK.test(p.title)) continue;
        if (!SWEEP_TOPICS.test(p.title)) continue;
        found.push({ sub: sub, title: p.title, link: p.link, ts: p.ts });
        hit++;
      }
      // the sub's own rules: read them, judge them, report the verdict
      let verdict = { ok: null, hit: [], n: 0 };
      try {
        verdict = await page.evaluate(async (subname) => {
          try {
            const r = await fetch("/r/" + subname + "/about/rules.json?raw_json=1");
            if (!r.ok) return { ok: null, hit: [], n: 0 };
            const j = await r.json();
            const rules = (j.rules || []).map((x) => (x.short_name || "") + " " + (x.description || "")).join(" | ");
            // deliberately broad: a false "no links" only costs the link; a
            // false "open" costs a removal. catch every phrasing of it.
            const bad = /self[- ]?promot|advertis|solicit|no\s+links?|link\s+ban|shameless|\bspam\b|referral|affiliate|minimum\s+(account\s+)?(age|karma)|new\s+accounts?|account\s+age|karma\s+(requirement|minimum)|not\s+allowed|do\s+not\s+(post|share|link)/i.test(rules);
            const names = (j.rules || []).map((x) => (x.short_name || "").slice(0, 34)).filter(Boolean).slice(0, 4);
            return { ok: !bad, hit: names, n: (j.rules || []).length };
          } catch (e) { return { ok: null, hit: [], n: 0 }; }
        }, sub);
      } catch (e) {}
      rulesOut[sub] = verdict;
      say("   sweep r/" + sub + ": " + posts.length + " posts, " + hit + " on-topic, rules " +
        (verdict.ok === null ? "unreadable" : verdict.ok ? "allow links" : "restrict links"));
      await sleep(1500);
    } catch (e) { say("   sweep r/" + sub + " failed: " + String(e && e.message || e).slice(0, 80)); }
  }
  say("   sweep done: " + found.length + " qualifying threads, rules for " +
    Object.keys(rulesOut).length + " subs");
  return { ok: true, data: { threads: found.slice(0, 20), rules: rulesOut } };
}

// a launch post: a real thread in a sub whose rules allow links. old reddit
// renders reliably in this chrome, so the submit goes through it.
async function submitThread(ctx, task) {
  const page = ctx.pages()[0] || (await ctx.newPage());
  say("   posting a new thread in r/" + task.sub + "...");
  await page.goto("https://old.reddit.com/r/" + task.sub + "/submit?selftext=true", { waitUntil: "domcontentloaded", timeout: 90000 });
  await sleep(4000);
  // old reddit picks link-vs-text with a radio pair named submit_type; if the
  // link radio is checked the form posts an empty url and bounces back. click
  // the text tab AND set the radio directly - belt and braces.
  try {
    await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll(".formtab a, .tabmenu a"));
      const tt = tabs.find((a) => /^text$/i.test((a.textContent || "").trim()));
      if (tt) tt.click();
      const radios = document.querySelectorAll('input[name="submit_type"]');
      if (radios.length >= 2 && !radios[1].checked) {
        radios[1].checked = true;
        radios[1].dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    await sleep(800);
  } catch (e) {}
  const title = page.locator('textarea[name="title"], input[name="title"]');
  if (!(await title.count())) throw new Error("no title field - login or captcha wall");
  await title.click(); await sleep(400);
  await page.keyboard.insertText(task.title);
  await sleep(600);
  const text = page.locator('textarea[name="text"]');
  if (await text.count()) {
    await text.first().click(); await sleep(400);
    await page.keyboard.insertText(task.text || "");
    await sleep(600);
  }
  // the subreddit field must carry the sub or the post goes nowhere
  try {
    await page.evaluate((sub) => {
      const sr = document.querySelector('input[name="sr"]');
      if (sr && !sr.value) {
        sr.value = sub;
        sr.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }, task.sub);
  } catch (e) {}
  if (TEST || task.__dry) { say("   REHEARSAL: thread typed, NOT submitted."); await sleep(15000); return "dry-run"; }
  // old reddit hides a stray <button class="save" type="submit"> in the dom -
  // the real one is the VISIBLE submit button
  let btn = page.locator('button[type="submit"]:visible');
  if (!(await btn.count())) btn = page.locator('.spacer .btn, form#newlink button[type="submit"], button.btn');
  if (!(await btn.count())) throw new Error("no visible submit button");
  await btn.first().click();
  await sleep(8000);
  const url = page.url();
  if (url.includes("/comments/")) { say("   thread is live: " + url); return { ok: true, data: { url: url, sub: task.sub } }; }
  // fail loud: read the page's OWN error so the result teaches the reason
  const why = await page.evaluate(() => {
    const errs = Array.from(document.querySelectorAll(".error, .error.USER, .status, .alert"))
      .map((e) => (e.innerText || "").trim()).filter(Boolean);
    const cap = document.querySelector(".cap-image, #captcha");
    const title = document.querySelector('textarea[name="title"], input[name="title"]');
    return { errs: errs.slice(0, 4), captcha: !!cap, titleKept: title ? title.value.slice(0, 40) : "(none)" };
  }).catch(() => ({}));
  throw new Error("submit did not land: " + JSON.stringify(why).slice(0, 300) + " | url " + url.slice(0, 70));
}

// pinterest account creation - the channel that compounds. one-time flow
// with real per-key typing: this react form truncates generic inserts.
async function pinterestSignup(ctx, task) {
  const page = ctx.pages()[0] || (await ctx.newPage());
  say("   pinterest: creating the shop account...");
  await page.goto("https://www.pinterest.com/", { waitUntil: "domcontentloaded", timeout: 90000 });
  await sleep(6000);
  await page.evaluate(() => window.scrollTo(0, 900)).catch(() => {});
  await sleep(2000);
  const em = page.locator("#email");
  const pw = page.locator("#password");
  const bd = page.locator("#birthdate");
  if (!(await em.count())) throw new Error("signup form not found on the page");
  await em.scrollIntoViewIfNeeded().catch(() => {});
  await em.click(); await sleep(400);
  await em.fill("");
  await em.type(String(task.email || "northbenchsystems@gmail.com"), { delay: 45 });
  await sleep(700);
  await pw.click(); await sleep(400);
  await pw.fill("");
  await pw.type(String(task.password), { delay: 45 });
  await sleep(700);
  await bd.fill("1993-08-15").catch(async () => {
    await bd.click(); await sleep(300);
    await page.keyboard.insertText("08/15/1993"); await sleep(600);
  });
  await sleep(800);
  const chk = await page.evaluate(() => ({
    em: (document.querySelector("#email") || {}).value || "",
    pw: ((document.querySelector("#password") || {}).value || "").length,
    bd: (document.querySelector("#birthdate") || {}).value || "" }));
  say("   form now holds: email " + chk.em.length + " chars, pw " + chk.pw + ", birth '" + chk.bd + "'");
  if (chk.em.length < 20 || chk.pw < 8 || !chk.bd) throw new Error("form did not hold the values: " + JSON.stringify(chk));
  if (TEST || task.__dry) { say("   REHEARSAL: typed, NOT submitted."); await sleep(20000); return "dry-run"; }
  // the exact Continue button - never 'Continue with Google'
  const btns = page.locator("button");
  const n = await btns.count();
  let clicked = false;
  for (let i = 0; i < n; i++) {
    const t = (await btns.nth(i).innerText().catch(() => "")).trim();
    if (t === "Continue") { await btns.nth(i).click({ timeout: 12000 }); clicked = true; break; }
  }
  if (!clicked) throw new Error("no exact Continue button found");
  await sleep(9000);
  const after = page.url();
  const body = await page.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 200)).catch(() => "");
  // proof: /settings redirects home when logged out, stays when logged in
  await page.goto("https://www.pinterest.com/settings/", { waitUntil: "domcontentloaded", timeout: 90000 });
  await sleep(5000);
  const loggedIn = page.url().includes("/settings");
  say("   after signup: " + after.slice(0, 60) + " | settings check: " + (loggedIn ? "LOGGED IN" : "still logged out"));
  return { ok: true, data: { afterUrl: after.slice(0, 90), snippet: body, loggedIn: loggedIn } };
}

// did our comment survive? reads my own comment list from the logged-in
// session and checks the one in this thread for removal marks
async function checkComment(ctx, task) {
  const page = ctx.pages()[0] || (await ctx.newPage());
  const me = creds.reddit_user || "Glittering_Maize5380";
  say("   checking whether my comment in " + task.url + " survived...");
  await page.goto("https://www.reddit.com/r/all/", { waitUntil: "domcontentloaded", timeout: 90000 });
  await sleep(3000);
  const r = await page.evaluate(async (args) => {
    try {
      const tid = (args.thread.split("/comments/")[1] || "").split("/")[0];
      if (!tid) return { status: "unknown", why: "no thread id" };
      for (const kind of ["comments", "submissions"]) {
        const res = await fetch("/user/" + args.me + "/" + kind + ".json?raw_json=1&limit=50");
        if (!res.ok) continue;
        const j = await res.json();
        const kids = (j.data && j.data.children) || [];
        for (const k of kids) {
          const d = k.data || {};
          if ((d.permalink || "").includes("/comments/" + tid + "/")) {
            if (d.body === "[removed]" || d.banned_by || d.selftext === "[removed]")
              return { status: "removed", by: d.banned_by || "moderator" };
            return { status: "alive", score: d.score };
          }
        }
      }
      return { status: "gone", why: "not among my latest comments or posts" };
    } catch (e) { return { status: "unknown", why: String(e).slice(0, 80) }; }
  }, { thread: task.url, me: me });
  say("   check: " + JSON.stringify(r));
  return { ok: true, data: r };
}

async function doTask(ctx, task, st) {
  try {
    if (task.action === "comment") { const r = await redditReply(ctx, task); return { ok: true, result: r }; }
    if (task.action === "read") { return await readPage(ctx, task.url); }
    if (task.action === "scan") { return await scanSub(ctx, task); }
    if (task.action === "sweep") { return await sweepSubs(ctx); }
    if (task.action === "checkcomment") { return await checkComment(ctx, task); }
    if (task.action === "submit") { return await submitThread(ctx, task); }
    if (task.action === "pinterest-signup") { return await pinterestSignup(ctx, task); }
    if (task.action === "inbox") { return await checkInbox(ctx, task); }
    if (task.action === "message-reply") { const r = await replyMessage(ctx, task); return { ok: true, result: r }; }
    if (task.action === "check") { return await checkComment(ctx, task); }
    if (task.action === "profile-edit") { const r = await profileEdit(ctx, task); return { ok: true, result: r }; }
    if (task.action === "browse") { return await doBrowse(ctx, task); }
    if (task.action === "screenshot") { return await doScreenshot(ctx, task); }
    if (task.action === "message") { const r = await sendMessage(ctx, task); return { ok: true, result: r }; }
    if (task.action === "edit") { const r = await editComment(ctx, task); return { ok: true, result: r }; }
    if (task.action === "delete") { const r = await deleteComment(ctx, task); return { ok: true, result: r }; }
    return { ok: false, error: "unknown action: " + task.action };
  } catch (e) {
    say("   TASK FAILED (" + task.action + "): " + (e && e.message));
    return { ok: false, error: String((e && e.message) || e) };
  }
}

async function runTasks(b, plan, st, label) {
  const today = new Date().toISOString().slice(0, 10);
  const alreadyRan = st.day === today;
  st.doneIds = st.doneIds || [];
  // queued tasks (with id) always run once; the radar's auto comment only
  // once per day
  const tasks = (plan.tasks || []).filter((t) => t.id ? st.doneIds.indexOf(t.id) === -1 : (!alreadyRan || TEST));
  if (!tasks.length) { say("  [" + label + "] nothing to do."); return { done: 0, closed: 0 }; }
  let done = 0, closed = 0;
  for (const task of tasks) {
    say("");
    say("  --- task: " + (task.action || "?") + (task.id ? " (from my queue)" : " (auto)"));
    let out = await doTask(b.ctx, task, st);
    if (!out.ok && String(out.error || "").indexOf("has been closed") !== -1) {
      closed++;
      if (!task.__retried) {
        // the browser died mid-task: relaunch and try again in the same
        // breath - the machine does not give up after one transport loss
        task.__retried = true;
        st.crashes = (st.crashes || 0) + 1; saveState(st);
        say("   the browser died mid-task - relaunching and retrying...");
        await reportStatus("browser-restart", { note: "died mid-task; retrying in place" });
        try { await b.ctx.close(); } catch (e) {}
        try { const nb = await launch(); b.ctx = nb.ctx; b.which = nb.which; await ensureConnected(b.ctx, st); }
        catch (e) { say("   (relaunch failed: " + (e && e.message) + ")"); }
        out = await doTask(b.ctx, task, st);
        if (out.ok) closed = Math.max(0, closed - 1);
      }
    }
    if (task.id) { st.doneIds.push(task.id); st.doneIds = st.doneIds.slice(-100); }
    else if (out.ok && out.result !== "dry-run") { st.day = today; }
    saveState(st);
    await reportTask(task, out);
    if (out.ok) done++;
  }
  return { done: done, closed: closed };
}

// is the browser still with us? (the owner closing Chrome must not kill LIVE)
async function browserAlive(ctx) {
  try {
    const pages = ctx.pages();
    if (!pages.length) return false;
    await pages[0].evaluate(() => 1);   // must actually answer
    return true;
  } catch (e) { return false; }
}

// cheap probe: can this context still open and talk to a page?
async function runTasksProbe(ctx) {
  // quiet probe: talk to the existing tab, never open a new one (a new tab
  // every cycle popped Chrome in the owner's face - fixed)
  try {
    const pages = ctx.pages();
    if (!pages.length) return { done: 0, closed: 1 };
    await pages[0].evaluate(() => 1);
    return { done: 0, closed: 0 };
  } catch (e) { return { done: 0, closed: 1 }; }
}

// ------------------------------------------------------------------ main
(async () => {
  say("");
  say("  ==========================================================");
  say("   NORTHBENCH - your Reddit hand (connected to the courier)");
  say("  ==========================================================");
  const st = loadState();
  st_browserPref = st.browserPref || "chrome";

  // only ONE copy may run at a time - two copies fight over Chrome and kill
  // each other's browser session
  if (!lockStale()) {
    say("  ANOTHER COPY IS ALREADY RUNNING somewhere (another black window).");
    say("  Close THIS window. Keep only ONE open.");
    return;
  }
  touchLock();
  await maybeSelfUpdate();

  if (SELFTEST) {
    say("  SELFTEST: full chain, will NOT post anything.");
    let b = null;
    try {
      const plan = await fetchPlan();
      say("  [cloud]   reachable - " + (plan.note || "answered"));
      b = await launch();
      say("  [browser] " + b.which + " launched");
      await ensureConnected(b.ctx, st);
      const task = { platform: "reddit", action: "comment",
        url: "https://www.reddit.com/r/freelance/comments/1wyu5va/interesting_client/",
        text: "selftest - not for posting", __dry: true };
      await redditReply(b.ctx, task);
      await readPage(b.ctx, "https://www.reddit.com/r/freelance/comments/1wyu5va/interesting_client/");
      say("  SELFTEST passed.");
    } catch (e) { say("  SELFTEST stopped: " + (e && e.message ? e.message : e)); }
    finally { if (b) await b.ctx.close().catch(() => {}); }
    say("  SELFTEST done.");
    return;
  }

  // 1. the cloud
  say("");
  say("  [1/4] talking to the courier...");
  let plan = null;
  try {
    plan = await fetchPlan();
    say("        connected - the cloud answered: " + (plan.note || "answered"));
    if (plan.say) {
      say("");
      say("   ------------------------------------------------------------");
      say("   FROM YOUR ASSISTANT (live from the cloud):");
      String(plan.say).split("\n").forEach((l) => say("   " + l));
      say("   ------------------------------------------------------------");
    }
  } catch (e) {
    if (!LIVE) {
      say("        CANNOT REACH THE COURIER: " + e.message);
      await reportStatus("cloud-unreachable").catch(() => {});
      return;
    }
    // live mode never gives up: the courier hiccup is transient, so wait it
    // out and keep trying until the cloud answers again
    say("        courier not answering yet (" + e.message + ") - live mode waits and retries...");
    let tries = 0;
    for (;;) {
      await sleep(30000);
      tries++;
      try {
        plan = await fetchPlan();
        say("        connected again after " + tries + " wait(s) - the cloud answered.");
        break;
      } catch (e2) {
        if (tries % 10 === 1) {
          say("        still waiting for the courier (try " + tries + ")...");
          await reportStatus("cloud-unreachable", { waits: tries }).catch(() => {});
        }
      }
    }
  }

  const tasks0 = plan.tasks || [];
  const readsOnly = tasks0.length > 0 && tasks0.every((t) => t.action === "read" || t.action === "scan");
  const needBrowser = LIVE || !st.connected || tasks0.length > 0;
  if (!needBrowser) {
    say("  [2/4] Chrome: not needed - nothing to do and you are already connected.");
    await reportStatus("idle", { note: "nothing to do" });
    say("");
    say("  All set. Want live control? Double-click LIVE.bat and keep it open.");
    return;
  }

  // 2. the browser
  say("  [2/4] looking for Chrome...");
  let b = null;
  try { b = await launch(); say("        found: " + b.which); }
  catch (e) { say("        " + e.message); await reportStatus("no-browser", { note: String(e.message).slice(0, 80) }); return; }

  // 3. the login (reading public threads does not need one)
  say("  [3/4] Reddit login...");
  let ok = false;
  if (!LIVE && readsOnly && !st.connected) {
    say("        skipped - reading public threads needs no login.");
  } else {
    try { ok = await ensureConnected(b.ctx, st); } catch (e) { say("        " + e.message); }
  }
  if (!ok && !LIVE && !(readsOnly && !st.connected)) {
    say("        not logged in after waiting - run this again and log in in the Chrome window.");
    await reportStatus("logged-out");
    await b.ctx.close().catch(() => {});
    return;
  }
  if (!ok && LIVE) say("        no login yet - reads still work; comments and messages wait for it.");

  // 4. the work
  if (LIVE) {
    say("  [4/4] LIVE mode - I am driving. This window must stay open.");
    say("        checking for my tasks every 2 minutes. Close the window to stop me.");
    // watchdog: a cycle that never finishes (wedged await, laptop woke from
    // sleep mid-cycle) restarts everything via the .bat loop - exit 42 is the
    // agreed restart code. covers hangs the try/catches cannot reach.
    let lastBeat = Date.now();
    const WATCHDOG = setInterval(() => {
      if (Date.now() - lastBeat > 7 * 60000) {
        say("  WATCHDOG: a cycle did not finish in 7 minutes - restarting cleanly...");
        try { clearInterval(WATCHDOG); } catch (e) {}
        process.exit(42);
      }
    }, 60000);
    // one-time: make the launcher restart us on ANY exit, not only code 42,
    // so a crash can never park the window at a pause prompt
    try {
      const BAT = "LIVE.bat";
      let bat = "";
      try { bat = fs.readFileSync(BAT, "utf8"); } catch (e) {}
      if (bat.indexOf("NB28") === -1) {
        const better = [
          "@echo off",
          "title Northbench - LIVE",
          "cd /d \"%~dp0\"",
          "echo.",
          "echo   LIVE CONTROL - keep this window open while you want",
          "echo   the assistant to have the hands. Close it to stop.",
          "echo.",
          "where node >nul 2>&1",
          "if errorlevel 1 (",
          "  echo   Node.js is not installed yet - see START-HERE.md step 2.",
          "  pause",
          "  exit /b 1",
          ")",
          "if not exist node_modules (",
          "  echo   First run: installing one small tool - about a minute...",
          "  call npm install >install.log 2>&1",
          ")",
          "rem NB28 - restart on ANY exit so the machine never parks",
          ":run",
          "echo.",
          "node nb-social.js --live",
          "echo.",
          "echo   (restarting in 10 seconds - close this window to stop me)",
          "timeout /t 10 >nul",
          "goto run",
          ""
        ].join("\r\n");
        fs.writeFileSync(BAT, better);
        say("        (upgraded LIVE.bat to restart on any exit - NB28)");
      }
    } catch (e) {}
    // and while I work, Windows should not doze off on its own
    try {
      require("child_process").exec("powercfg /change standby-timeout-ac 0 & powercfg /change standby-timeout-dc 0", () => {});
      say("        (told Windows not to auto-sleep while I work)");
    } catch (e) {}
    await reportStatus("listening", { mode: "live" });
    let lastSay = null;
    for (;;) {
      touchLock();
      lastBeat = Date.now();
      try { await flushPendingReports(st); } catch (e) {}   // NB37: lost results get a second life
      if (Date.now() - lastCodeAt > 180000) { lastCodeAt = Date.now(); await maybeSelfUpdate(); }
      // self-heal: chrome dying (closed by hand, crash, or self-update
      // relaunch) must never stop the machine
      let r = { done: 0, closed: 0 };
      try { r = await runTasksProbe(b.ctx); } catch (e) { r = { done: 0, closed: 1 }; }
      const dead = r.closed > 0 || !(await browserAlive(b.ctx).catch(() => false));
      if (dead) {
        st.crashes = (st.crashes || 0) + 1; saveState(st);
        say("  Chrome went away (crash/update/close, x" + st.crashes + ") - reopening...");
        await reportStatus("browser-restart", { note: "chrome died x" + st.crashes });
        try { await b.ctx.close(); } catch (e) {}
        if (st.crashes === 2) {
          const ORDER = ["chrome", "msedge", "chromium"];
          const next = ORDER[(ORDER.indexOf(st.browserPref || "chrome") + 1) % 3];
          say("  Chrome keeps dying - switching the machine to: " + next);
          st.browserPref = next; saveState(st);
        }
        if (st.crashes >= 3) {
          say("  resetting the saved profile too (login re-types itself).");
          try { fs.renameSync(PROFILE, PROFILE + "-broken-" + Date.now()); } catch (e) { say("  (could not reset profile: " + e.message + ")"); }
          st.connected = false; st.crashes = 0; saveState(st);
        }
        try { b = await launch(); await ensureConnected(b.ctx, st); }
        catch (e) { say("  (could not reopen Chrome yet: " + (e && e.message) + ")"); await sleep(30000); }
      } else if (st.crashes) { st.crashes = 0; saveState(st); }
      // management rhythm: watch the inbox every 15 minutes on its own
      if (Date.now() - (st.inboxAt || 0) > 900000) {
        st.inboxAt = Date.now(); saveState(st);
        const itask = { id: "inbox-" + Date.now().toString(36), platform: "reddit", action: "inbox" };
        const iout = await doTask(b.ctx, itask, st);
        await reportTask(itask, iout);
      }
      try { plan = await fetchPlan(); } catch (e) { plan = { tasks: [] }; say("  (courier hiccup: " + e.message + ")"); }
      if (plan.control === "halt") {
        say("  HALT received from the cloud - stopping work. You can close this window.");
        await reportStatus("halted");
        break;
      }
      if (plan.say && plan.say !== lastSay) {
        lastSay = plan.say;
        say("");
        say("   ------------------------------------------------------------");
        say("   FROM YOUR ASSISTANT (live from the cloud):");
        String(plan.say).split("\n").forEach((l) => say("   " + l));
        say("   ------------------------------------------------------------");
      }
      const did = await runTasks(b, plan, st, "live");
      const busy = did && did.done;
      if (busy || Date.now() - lastStatusAt > 600000) { // v42: 10-min heartbeat (KV write budget)
        lastStatusAt = Date.now();
        if (busy) await reportStatus("listening", { did: did.done, browser: b.which, v: VERSION });
        else await reportStatus("listening", { mode: "live", browser: b.which, v: VERSION });
      }
      if (!busy && Date.now() - lastIdleSaid > 900000) {
        lastIdleSaid = Date.now();
        say("  ...in the flow. Checking every 20 seconds. Close this window to stop me.");
      }
      await sleep(POLL_MS);
    }
  }

  say("  [4/4] today's task...");
  const rr = await runTasks(b, plan, st, "today");
  const did = rr.done;
  if (!did && !(plan.tasks || []).length) {
    say("        nothing to post today - that is normal, no good thread appeared.");
    say("        You are connected and ready. For live control: LIVE.bat");
    await reportStatus("idle", { note: "connected, nothing to post today" });
  } else {
    await reportStatus(did ? "worked" : "tried", { tasks: (plan.tasks || []).length, done: did });
  }
  await b.ctx.close().catch(() => {});
  say("");
  say("  Done. activity.log in this folder keeps the full history.");
})();
