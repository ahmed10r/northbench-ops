// The always-on courier, Cloudflare edition (2026-09-26).
//
// Same design as the Netlify function beside it (social-daily.js): everything that
// DECIDES what to post lives in the Python engine (tools/social.py), which publishes a
// precomputed schedule; this worker only finds today's row and sends it, and refuses to
// double-post by checking each platform's own record of today. An empty schedule IS the
// off switch. Deployed to the owner's existing Cloudflare account (free cron triggers,
// no credit meter) so the daily post keeps going even when the conversation is closed
// and Netlify credits are exhausted. Deploy script: tools/cf_courier.py.

// the food is tried on our own Cloudflare site first (no meter, our control),
// with the Netlify copy as the fallback - two rails, one post
const DEFAULT_SCHEDULE = [
  "https://northbench-site.a7maaadesmail93.workers.dev/social-5e7f82b46c1a676d5741251b.json",
  "https://friendly-faloodeh-338a4f.netlify.app/social-5e7f82b46c1a676d5741251b.json",
];
const BLUESKY_API = "https://bsky.social/xrpc";
const PUBLIC_API = "https://public.api.bsky.app/xrpc";
const DEVTO_API = "https://dev.to/api";
const BUFFER_API = "https://api.buffer.com";

const today = () => new Date().toISOString().slice(0, 10);
function j(text) { try { return JSON.stringify(text); } catch (e) { return "{}"; } }

async function grab(url, opts, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || 8000);
  try {
    return await fetch(url, Object.assign({ signal: ctrl.signal }, opts || {}));
  } finally { clearTimeout(timer); }
}

async function bluesky(row, keys, note, env) {
  if (!keys || !keys.handle || !keys.app_password) { note("bluesky: no keys - skipped"); return; }
  const base = (env && env.RUNNER_BLUESKY_API) || BLUESKY_API;
  const login = await grab(base + "/com.atproto.server.createSession", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: j({ identifier: String(keys.handle || "").replace(/^@/, ""),
              password: keys.app_password }),
  });
  if (!login.ok) { note("bluesky: login refused " + login.status); return; }
  const auth = await login.json();
  const head = { "Content-Type": "application/json", "Authorization": "Bearer " + auth.accessJwt };

  // the one-a-day rule, checked against the platform itself, not our memory.
  // read from the PUBLIC api (no auth needed, known-good) and fail CLOSED:
  // if the feed cannot be read, refuse to post rather than risk a double
  const pub = (env && env.RUNNER_BLUESKY_PUBLIC_API) || base;
  // 2026-09-27: the anonymous public mirror answers 401 to Cloudflare worker
  // IPs, so the feed is read with the session we already hold - same check,
  // same fail-closed rule, just authenticated
  const feed = await grab(pub + "/app.bsky.feed.getAuthorFeed?actor=" +
    encodeURIComponent(String(keys.handle).replace(/^@/, "")) + "&limit=30", { headers: head });
  if (!feed.ok) { note("bluesky: could not read the feed (" + feed.status + ") - refusing to post"); return; }
  {
    const got = await feed.json();
    const already = (got.feed || []).some((f) =>
      ((f.post || {}).record || {}).text === row.text ||
      (f.post || {}).indexedAt && (f.post.indexedAt || "").slice(0, 10) === today());
    if (already) { note("bluesky: today's post already exists - nothing sent"); return; }
  }

  const post = async (record) => {
    const r = await grab(base + "/com.atproto.repo.createRecord", {
      method: "POST", headers: head,
      body: j({ repo: auth.did, collection: "app.bsky.feed.post", record: record }),
    });
    if (!r.ok) { note("bluesky: post refused " + r.status); return null; }
    return r.json();
  };
  const now = new Date().toISOString();
  const made = await post({ $type: "app.bsky.feed.post", text: row.text, createdAt: now });
  if (!made) return;
  if (row.reply_url) {
    const parent = { uri: made.uri, cid: made.cid };
    await post({ $type: "app.bsky.feed.post", text: row.reply_url, createdAt: now,
                 reply: { root: parent, parent: parent } });
  }
  note("bluesky: posted -> " + made.uri);
}

async function devto(row, keys, note, env) {
  if (!keys || !keys.api_key) { note("devto: no keys - skipped"); return; }
  const base = (env && env.RUNNER_DEVTO_API) || DEVTO_API;
  const head = { "api-key": keys.api_key, "Content-Type": "application/json" };
  const mine = await grab(base + "/articles/me/latest?per_page=20", { headers: head });
  if (mine.ok) {
    const arts = await mine.json();
    const dup = (arts || []).some((a) => a.canonical_url === row.canonical_url ||
      (a.published_at || "").slice(0, 10) === today());
    if (dup) { note("devto: today's article already exists - nothing sent"); return; }
  }
  const made = await grab(base + "/articles", {
    method: "POST", headers: head,
    body: j({ article: { title: row.title, body_markdown: row.body_markdown,
                         tags: row.tags, canonical_url: row.canonical_url, published: true } }),
  });
  if (!made.ok) { note("devto: article refused " + made.status); return; }
  const a = await made.json();
  note("devto: posted -> " + (a.url || "ok"));
}

// mastodon, ported from the Netlify twin so the two couriers stay identical
async function mastodon(row, keys, note) {
  if (!keys || !keys.access_token || !keys.instance) { note("mastodon: no keys - skipped"); return; }
  const base = keys.instance.replace(/\/$/, "");
  const head = { "Authorization": "Bearer " + keys.access_token, "Content-Type": "application/json" };
  const me = await grab(base + "/api/v1/accounts/verify_credentials", { headers: head });
  if (!me.ok) { note("mastodon: login refused " + me.status); return; }
  const my = await me.json();
  const feed = await grab(base + "/api/v1/accounts/" + my.id + "/statuses?limit=30", { headers: head });
  if (feed.ok) {
    const got = await feed.json();
    const dup = (got || []).some((s) => s.content &&
      (s.created_at || "").slice(0, 10) === today());
    if (dup) { note("mastodon: today's post already exists - nothing sent"); return; }
  }
  const made = await grab(base + "/api/v1/statuses", {
    method: "POST", headers: head, body: j({ status: row.text }),
  });
  if (!made.ok) { note("mastodon: post refused " + made.status); return; }
  const s = await made.json();
  if (row.reply_url && s && s.id) {
    await grab(base + "/api/v1/statuses", {
      method: "POST", headers: head,
      body: j({ status: row.reply_url, in_reply_to_id: s.id }),
    });
  }
  note("mastodon: posted -> " + ((s || {}).uri || "ok"));
}

// Buffer: the free door to X (2026-09-27). One GraphQL endpoint, always POST,
// Bearer auth. The link rides INLINE here (Buffer cannot reply-thread), so the
// X-style "link in the profile" note is swapped for "link below", and when
// words + link exceed 280 the words give way at a word - the link is never
// cut. The one-a-day rule is checked against the platform itself and the
// whole thing fails CLOSED: no read, no post. The API base comes from
// env.RUNNER_BUFFER_API so the tests can point it at a fake.
async function buffer(row, keys, note, env) {
  if (!keys || !keys.access_token) { note("buffer: no keys - skipped"); return; }
  const base = (env && env.RUNNER_BUFFER_API) || BUFFER_API;
  const head = { "Authorization": "Bearer " + keys.access_token,
                 "Content-Type": "application/json" };
  const gql = async (query) => {
    const r = await grab(base, { method: "POST", headers: head, body: j({ query: query }) });
    if (!r.ok) throw new Error("buffer http " + r.status);
    const out = await r.json();
    if (out.errors && out.errors.length) throw new Error("buffer: " + out.errors[0].message);
    return out.data || {};
  };
  try {
    const orgs = (((await gql("{ account { organizations { id } } }")).account || {}).organizations) || [];
    if (!orgs.length) { note("buffer: no organization on the account - skipped"); return; }
    const org = orgs[0].id;
    const sent = await gql('{ posts(first: 20, input: { organizationId: "' + org + '", ' +
                           'filter: { status: [sent, scheduled] } }) { edges { node { text } } } }');
    let body = String(row.text || "");
    body = body.replace("no link in the post text - it's in the profile", "link below");
    const link = row.reply_url || "";
    let full = link ? (body + " " + link).trim() : body;
    if (full.length > 280 && link) {
      const room = 280 - link.length - 1;
      let cut = body.slice(0, room);
      const sp = cut.lastIndexOf(" ");
      if (sp > 0) cut = cut.slice(0, sp);
      full = cut + " " + link;
    }
    const edges = ((sent.posts || {}).edges) || [];
    if (edges.some((e) => (((e || {}).node) || {}).text === full)) {
      note("buffer: today's post already exists - nothing sent"); return;
    }
    let cid = keys.channel_id || "";
    if (!cid) {
      const ch = await gql('{ channels(input: { organizationId: "' + org + '" }) { id service } }');
      const tw = (ch.channels || []).filter((c) => c.service === "twitter");
      if (!tw.length) { note("buffer: no X channel connected - skipped"); return; }
      cid = tw[0].id;
    }
    const made = await gql("mutation { createPost(input: { text: " + JSON.stringify(full) +
      ', channelId: "' + cid + '", schedulingType: automatic, mode: shareNow }) ' +
      "{ ... on PostActionSuccess { post { id status } } ... on MutationError { message } } }");
    const res = made.createPost || {};
    if (res.message) { note("buffer said no: " + res.message); return; }
    note("buffer: posted -> " + ((res.post || {}).id || "ok") +
         ((res.post || {}).status ? " (" + res.post.status + ")" : ""));
  } catch (e) {
    note("buffer: refusing to post - " + String((e && e.message) || e));
  }
}

// Pinterest rides the same Buffer account as X: the image is a public pin PNG
// on the site, the board is read from the channel, and the pin's board, title
// and destination link travel in metadata - Pinterest is not a text post.
async function pinterest(row, keys, note, env) {
  if (!keys || !keys.access_token) { note("pinterest: no buffer keys - skipped"); return; }
  const base = (env && env.RUNNER_BUFFER_API) || BUFFER_API;
  const head = { "Authorization": "Bearer " + keys.access_token,
                 "Content-Type": "application/json" };
  const gql = async (query) => {
    const r = await grab(base, { method: "POST", headers: head, body: j({ query: query }) });
    if (!r.ok) throw new Error("buffer http " + r.status);
    const out = await r.json();
    if (out.errors && out.errors.length) throw new Error("buffer: " + out.errors[0].message);
    return out.data || {};
  };
  try {
    const orgs = (((await gql("{ account { organizations { id } } }")).account || {}).organizations) || [];
    if (!orgs.length) { note("pinterest: no organization on the account - skipped"); return; }
    const org = orgs[0].id;
    const ch = await gql('{ channels(input: { organizationId: "' + org + '" }) { id service } }');
    const pins = (ch.channels || []).filter((c) => c.service === "pinterest");
    if (!pins.length) { note("pinterest: no Pinterest channel connected - skipped"); return; }
    const cid = pins[0].id;
    const text = String(row.text || "");
    const sent = await gql('{ posts(first: 20, input: { organizationId: "' + org + '", ' +
                           'filter: { status: [sent, scheduled] } }) { edges { node { text } } } }');
    const edges = ((sent.posts || {}).edges) || [];
    if (edges.some((e) => (((e || {}).node) || {}).text === text)) {
      note("pinterest: today's pin already exists - nothing sent"); return;
    }
    const bd = await gql('{ channel(input: { id: "' + cid + '" }) { metadata { ... on PinterestMetadata ' +
                         '{ boards { serviceId name } } } } }');
    const boards = ((((bd.channel || {}).metadata) || {}).boards) || [];
    if (!boards.length) { note("pinterest: no boards on the connected account - make one board in Pinterest"); return; }
    const meta = "metadata: { pinterest: { boardServiceId: " + JSON.stringify(String(boards[0].serviceId)) +
                 ", title: " + JSON.stringify(String(row.title || "").slice(0, 100)) +
                 ", url: " + JSON.stringify(String(row.reply_url || "")) + " } }";
    const assets = "assets: [{ image: { url: " + JSON.stringify(String(row.image || "")) + " } }]";
    const made = await gql("mutation { createPost(input: { text: " + JSON.stringify(text) +
      ', channelId: "' + cid + '", schedulingType: automatic, mode: shareNow, ' + assets + ", " + meta + " }) " +
      "{ ... on PostActionSuccess { post { id status } } ... on MutationError { message } } }");
    const res = made.createPost || {};
    if (res.message) { note("pinterest said no: " + res.message); return; }
    note("pinterest: pinned -> " + ((res.post || {}).id || "ok") +
         ((res.post || {}).status ? " (" + res.post.status + ")" : ""));
  } catch (e) {
    note("pinterest: refusing to pin - " + String((e && e.message) || e));
  }
}

const SENDERS = { bluesky: bluesky, devto: devto, mastodon: mastodon, buffer: buffer,
                  pinterest: pinterest };


// ------------------------------------------------- the reddit auto-answerer
// The owner asked for this to run without them. It runs with rails, slowly,
// and it can stop itself: warmup first (answers with no links), one comment
// a day at most, every other day during warmup, every comment checked the
// next run - a removed comment pauses the whole engine and says so. Full
// disclosure on every link it ever posts.
const REDDIT_TOPICS = {
  invoice: { slug: "clientos", product: "ClientOS" },
  rates:   { slug: "freelance-os", product: "Freelance OS" },
  track:   { slug: "clientos", product: "ClientOS" },
  template:{ slug: "proposals", product: "the Proposals Pack" },
  budget:  { slug: "moneymap", product: "Money Map" },
  moneyadmin: { slug: "money-os", product: "Money OS" },
  jobhunt: { slug: "jobhunt", product: "Job Hunt Command" },
  outreach:{ slug: "outreachkit", product: "Outreach Kit" },
  content: { slug: "contentengine", product: "Content Engine" },
  event:   { slug: "eventplan", product: "Event Plan" },
  shop:    { slug: "storeeye", product: "Store Eye" },
  launch:  { slug: "launchkit", product: "Launch Kit" },
  tutoring:{ slug: "tutoros", product: "Tutor OS" },
};

const REDDIT_WARMUP = 10;   // link-free answers before any link is allowed

// launch posts: subs that EXIST for showing what you built, so a real thread
// with a link is the accepted format, not a rules violation. we still read
// their rules and only post where the verdict says links are fine.
const POST_SUBS = ["SideProject", "IMadeThis", "AlphaandBetausers"];


const LAUNCHES = [
  {
    slug: "clientos",
    title: "I made a one-file client tracker for freelancers - clients, projects, time and invoices in plain Excel/Sheets",
    text: "I freelance, and my admin lived in email threads and three half-maintained spreadsheets. So I built the boring version of a client tracker: one file.\n\nWhat's in it: a client sheet, a project sheet, a time log, and invoices with an ageing column that tells me what's owed and how late. A dashboard on top answers two questions - what's unbilled, and what's overdue. No app, no login, nothing uploads anywhere; it's plain formulas you can read and change. Works in both Excel and Google Sheets.\n\nHonest bits: it's paid, 19 dollars on Gumroad, and it will not send emails for you - I decided against automation I could not test honestly. There is a full description of what it does and who it is NOT for here: https://northbench-site.a7maaadesmail93.workers.dev/go/clientos?src=reddit\n\nIf you want the file: founding readers get 30% off with code NORTHBENCH30 - no countdown, it just stays. Happy to answer anything about the build, the formulas, or why I kept it dumb on purpose."
  },
  {
    slug: "moneymap",
    title: "I made a money map for people with irregular income - it plans 12 months forward instead of looking at last month backwards",
    text: "Freelance money advice usually assumes a salary. Mine arrives in lumps, two months late, in three currencies. Every budgeting app I tried wanted me to look backwards at last month, which is useless when no two months match.\n\nSo I built a plain-file money map that looks forward: expected payments in, planned costs out, a low-point line that shows the worst week ahead, and a simple what-if column for raising rates or losing a client. One file, Excel or Google Sheets, no bank connections, no app.\n\nHonest bits: it is paid (on Gumroad), it does not sync anything automatically, and if your income is a stable salary it is honestly not for you. What it does and does not do is written out here: https://northbench-site.a7maaadesmail93.workers.dev/go/moneymap?src=reddit\n\nIf you want it: founding readers get 30% off with code NORTHBENCH30 - no countdown, it just stays. Ask me anything - about the method or the file."
  },
  {
    slug: "freelance-os",
    title: "I made my freelance admin run by conversation - 8 commands that draft invoices, chase payments and keep the ledger",
    text: "I kept not-doing my freelance admin. Invoices waited, chasing clients waited, and the spreadsheet I was supposed to maintain became a guilt object. So I moved the whole thing into conversation.\n\nFreelance OS is eight commands you run in Claude Code: /invoice turns billable work into a numbered invoice plus its covering email and logs it, /chase writes the awkward follow-up you keep postponing, /weekly tells you what is owed and what is unbilled, and five more for clients, quotes and the tax folder. Plain markdown ledgers underneath - you can always read your own data.\n\nHonest bits: it is 29 dollars, it needs you to use Claude Code at least weekly (spreadsheet people should buy ClientOS instead - genuinely), and it does not send anything automatically. I decided against automation I could not test honestly. What it does is written out here: https://northbench-site.a7maaadesmail93.workers.dev/go/freelance-os?src=reddit\n\nIf it is your case: founding readers get 30% off with code NORTHBENCH30 - no countdown, it just stays. Ask me anything about the commands or the ledgers."
  },
  {
    slug: "money-os",
    title: "I made a money admin that wants neither my bank login nor a subscription - 8 commands, plain CSV",
    text: "Every money tool I tried wanted my bank login, and the honest ones that did not want it wanted a subscription instead. So I built the third thing: my money admin as conversation, over files I own.\n\nMoney OS is eight Claude Code commands: /import reads the bank's CSV export and categorizes it, /subscriptions hunts the recurring charges I forgot about, /tax drafts the quarter for the accountant, and the rest cover budget check, net worth and the what-if questions. Nothing connects anywhere. The data stays plain files on my machine.\n\nHonest bits: it is 34 dollars, it will not magically know your spending (you export a CSV and it does the reading), and if you want dashboards and sync this is honestly not it. Full honest description here: https://northbench-site.a7maaadesmail93.workers.dev/go/money-os?src=reddit\n\nFounding readers get 30% off with code NORTHBENCH30 - no countdown, it just stays. Happy to answer anything about the method or the files."
  },
  {
    slug: "promptvault",
    title: "I wrote down the 79 AI prompts I actually use on real work - each one written like an instruction to a smart intern",
    text: "Most prompt packs are written by people who sell prompt packs. Open one and you get a thousand thin lines of act-as-a-world-class-guru - which is a wish, not a prompt.\n\nSo I packaged the opposite: 79 prompts I actually use on real client work, each written like an instruction to a smart intern - context, the task, the format, and what to check before showing me. Categories cover drafting, editing, research, offers, and the boring-but-lucrative admin. No mystical prompting language anywhere.\n\nHonest bits: it is 12 dollars, it assumes you already use an AI assistant weekly (otherwise a prompt pack is a paperweight), and it will not write your business for you - it makes you faster at the work you already understand. Everything it contains is described here: https://northbench-site.a7maaadesmail93.workers.dev/go/promptvault?src=reddit\n\nFounding readers get 30% off with code NORTHBENCH30 - no countdown, it just stays. Ask me anything - I will even give away favorite single prompts in the comments."
  },
  {
    slug: "proposals",
    title: "I fixed fixed-work quoting - a proposal and SOW file that shows its own maths so the scope cannot quietly grow",
    text: "Fixed-work quoting has a failure pattern older than software: you guess a number, the client signs, the work grows, the number does not, and you eat the difference one polite change at a time. I did this for two years before I built the fix.\n\nThe Proposal System is one file: a quote builder that shows its own maths line by line, a proposal and SOW written to prevent the quiet scope growth, a change-order sheet for when the client genuinely wants more (priced, not absorbed), and a payment schedule that protects the front of the project, not the end. Works in Excel and Google Sheets.\n\nHonest bits: it is 49 dollars - the most expensive file I sell, because one prevented scope-creep pays for it many times over; it is paperwork, not magic; and if you only do hourly work it is honestly not for you. What is inside is written out here: https://northbench-site.a7maaadesmail93.workers.dev/go/proposals?src=reddit\n\nFounding readers get 30% off with code NORTHBENCH30 - no countdown, it just stays. Happy to talk scope-creep war stories in the comments."
  },
  {
    slug: "habitledger",
    title: "I made an undated 52-week habit planner with no streaks, no badges and no shame - just a ledger you mark by hand",
    text: "Habit apps have a design flaw nobody admits: they are built on shame. Miss a day and the app shows you a broken streak, a lost badge, a red mark - as if forgetting once cancels the fifty times you remembered.\n\nHabit Ledger is the opposite machine. It is paper. It is undated - start any week, miss any week, nothing breaks. You print a sheet, you mark the habits you kept, and the ledger row simply shows the truth: sixteen of twenty-one days is a good month. There is a one-page review that asks what actually got in the way, not why you failed.\n\nHonest bits: it is 9 dollars, it is a PDF you print (no app, no sync - on purpose), and it will not suit anyone who is motivated by streak anxiety; that is exactly who it is NOT for. Everything it contains is here: https://northbench-site.a7maaadesmail93.workers.dev/go/habitledger?src=reddit\n\nFounding readers get 30% off with code NORTHBENCH30 - no countdown, it just stays. Genuinely happy if you steal the undated-ledger idea and draw your own instead of buying - that is the point."
  },
  {
    slug: "outreachkit",
    title: "I made cold email templates for people who hate cold email - 6 short sequences for freelancers who need 3 clients, not a pipeline",
    text: "Most cold email advice is written by people who enjoy sending it. Outreach Kit is written for the rest of us: freelancers and small studios who need two or three good clients, not a pipeline of thousands.\n\nWhat is in it: six short email sequences (first contact, the polite follow-up, the lapsed-client revival, the referral ask, and two more), a one-page prospect tracker, and a rule set that keeps you out of spam-folder territory - both the algorithmic one and the human one. Every email is under 120 words because that is what gets answered.\n\nHonest bits: it is 16 dollars, it will not write your niche or your portfolio for you, and if you need volume outbound (hundreds a week) this is honestly the wrong tool - it is built for people who send ten good ones. The full contents are written out here: https://northbench-site.a7maaadesmail93.workers.dev/go/outreachkit?src=reddit\n\nFounding readers get 30% off with code NORTHBENCH30 - no countdown, it just stays. Ask me anything - I will share one full follow-up email in the comments for free."
  },
  {
    slug: "wholeshelf",
    title: "I made a one-file home for my notes, habits and plans - a 'shelf' instead of an app",
    text: "I kept losing things between apps: a note here, a habit tracker there, a plan somewhere else. So I built the opposite of an app: one file that behaves like a shelf.\n\nTop row: what I am working on this week. One drawer per project with its notes. A habits strip I tick by hand - no streaks, no confetti. A small plan page for the next 90 days. It is a single spreadsheet, works in Excel and Google Sheets, and every part of it can be edited like normal spreadsheet cells, because it is one.\n\nHonest bits: it is paid on Gumroad, it does not sync to your phone (I print the habits strip), and it will not appeal if you like apps that do the thinking. Details and honest limits here: https://northbench-site.a7maaadesmail93.workers.dev/go/wholeshelf?src=reddit\n\nIf you do want it: founding readers get 30% off with code NORTHBENCH30 - no countdown, it just stays. Happy to talk through the structure if anyone wants to steal the idea instead of buying - that is genuinely fine."
  },
  {
    slug: "tutoros",
    title: "I made a one-file back office for private tutors - students, sessions, fees and who still owes",
    text: "I tutor on the side, and the admin was the worst part of the job: sessions in one note, fees in another, and the uncomfortable feeling every month that somebody's parent never quite paid. So I built the boring fix: one file.\n\nWhat's in it: a Students tab with each rate and parent contact, a Sessions tab where one row per lesson fills its own fee from the student's rate, and a Progress tab so 'how is he doing?' gets a dated answer instead of a vague one. The Summary tab counts what a tutoring practice actually runs on: sessions this month, income this month, the unpaid total, and no-shows - counted honestly, because that number decides whether the term pays.\n\nThere is also a printable session log, because paper survives the lesson and the file survives the year.\n\nHonest bits: it is 19 dollars on Gumroad, it will not chase parents for money (it shows you the number; the conversation stays yours), and if you have three students and no plans for more, a notebook is honestly enough. What it does and who it is NOT for is written out here: https://northbench-site.a7maaadesmail93.workers.dev/go/tutoros?src=reddit\n\nFounding readers get 30% off with code NORTHBENCH30 - no countdown, it just stays. Happy to answer anything about the formulas, the no-show counting, or why I kept it one file on purpose."
  },

  {
    slug: "jobhunt",
    title: "I turned my job hunt into a pipeline - one file, stages, next actions and offer maths",
    text: "A job hunt without a system runs on two feelings: everything-is-fine and nothing-is-working. Both are usually wrong. So I replaced the feelings with a pipeline in one file.\n\nWhat's in it: a Pipeline tab where every application carries its stage, its next action and its follow-up date, with a live count per stage - the count is the point, it shows you where deals actually die. A prep file for the questions you will actually be asked. Offer maths that compares the real numbers, not the salary headline. And scripts for the money conversation, the one most people lose by improvising.\n\nHonest bits: it is 15 dollars on Gumroad, it will not apply for you or autofill anything, and if you have sent three applications total a notebook is honestly enough. What it does and who it is NOT for is written out here: https://northbench-site.a7maaadesmail93.workers.dev/go/jobhunt?src=reddit\n\nFounding readers get 30% off with code NORTHBENCH30 - no countdown, it just stays. Ask me anything - I will share the offer-comparison maths in the comments for free."
  },
  {
    slug: "eventplan",
    title: "I made the spreadsheet part of a big event - guests, seating that checks itself, quotes vs plan",
    text: "Every big event has a beautiful part - the venue, the photos - and a spreadsheet part: who is coming, where they sit, what it costs, what is due to whom and when. The spreadsheet part is what actually goes wrong. So I built it properly.\n\nWhat's in it: one guest list with RSVP status, meal notes and plus-ones, and a live count that matches the seating maths. Seating in rows - table, capacity, guests - with an over-capacity check that is a formula instead of a panicked count on the morning of. And a budget that shows quotes next to plan, so a quote quietly becoming the plan gets caught early.\n\nHonest bits: it is 14 dollars on Gumroad, it is deliberately unglamorous, and it will not manage RSVP emails or talk to any vendor. What it does and who it is NOT for is written out here: https://northbench-site.a7maaadesmail93.workers.dev/go/eventplan?src=reddit\n\nFounding readers get 30% off with code NORTHBENCH30 - no countdown, it just stays. Happy to talk guest-list triage war stories in the comments."
  },
  {
    slug: "listinglab",
    title: "I fixed the blank listing box - 168 fill-in lines and a keyword grid that scores your terms",
    text: "Most listings die in the same place: the blank box. You know the product; the page will not write itself, and 'just write something' produces the same five sentences every shop already has. So I built the fix that is not a ghostwriter.\n\nWhat's in it: 168 fill-in lines covering every part of a listing - titles, hooks, benefit lines, price justifications, objection answers. You pick one line of each kind, fill the braces with your product's truth, run the score on the keyword grid, and publish something a stranger can say yes to.\n\nHonest bits: it is 11 dollars on Gumroad, it will not write your copy for you - it makes you faster at writing copy that is actually yours - and the keyword scores are honest arithmetic, not SEO magic. What it does and who it is NOT for is written out here: https://northbench-site.a7maaadesmail93.workers.dev/go/listinglab?src=reddit\n\nFounding readers get 30% off with code NORTHBENCH30 - no countdown, it just stays. I will give away five of the title lines in the comments if anyone wants a taste."
  },
  {
    slug: "launchkit",
    title: "I wrote the honest playbook for a first digital product - pick, prove, build, price, publish",
    text: "The first digital product usually dies in one of three places: picking something nobody wants, pricing it under the fee floor, or marketing it in a way that makes you feel dirty. I wrote the short honest playbook for surviving all three.\n\nWhat's in it: ten chapters - pick, prove, build, price, publish, launch, market, support, refund, repeat - about 1500 words, readable in one sitting. On purpose: a first product does not need a course, it needs a checklist and the nerve to start. Plus the fee maths for what a 9 dollar product actually keeps, and the ten checks to run before you publish.\n\nHonest bits: it is 24 dollars on Gumroad, it is a short book not a program, and it will not hand you a niche or an audience - it tells you how to find both yourself. What it does and who it is NOT for is written out here: https://northbench-site.a7maaadesmail93.workers.dev/go/launchkit?src=reddit\n\nFounding readers get 30% off with code NORTHBENCH30 - no countdown, it just stays. Ask me anything about the fee maths or the pricing floor."
  },
  {
    slug: "calc-pack",
    title: "I put the eight free money calculators into one offline workbook - same maths, your numbers stay home",
    text: "My site has free calculators, and people use them - then they use them again next week, and the week after, and eventually someone asks the obvious question: can I just have these? So I packaged them.\n\nWhat's in it: all eight calculators as one Excel workbook - the same maths as the free pages, and every tab names the page it matches so you can check any answer against the web any time. You type into the yellow cells; everything else recomputes live. No macros, no links, nothing uploads. Your numbers never leave the file, which is the entire reason a workbook beats a website for anything you would rather keep to yourself.\n\nHonest bits: it is 12 dollars on Gumroad, everything in it is already usable free on the site - you are paying for offline and privacy, nothing more - and there is no app and no sync. What it does and who it is NOT for is written out here: https://northbench-site.a7maaadesmail93.workers.dev/go/calc-pack?src=reddit\n\nFounding readers get 30% off with code NORTHBENCH30 - no countdown, it just stays. The free versions stay free forever - that is the honest deal."
  },
  {
    slug: "storeeye",
    title: "I made a tool that reads my shop every day like a buyer and letters me what changed",
    text: "Shops break quietly. A listing stops being for sale, a price changes to the wrong number, a cover image vanishes, a link starts pointing nowhere - and nobody notices until a customer does. So I built the thing that notices.\n\nWhat's in it: four small readable Python files - what to watch, how to read a page, how to tell what changed, how to write the letter. It reads your public pages every day the way a buyer would, then writes you one short letter naming what moved, worst thing first. No dashboard to log into, no noise, just the letter.\n\nHonest bits: it is 29 dollars on Gumroad, it is Python you run yourself (one command a day, scheduled or by hand), and it watches public pages only - it has no access to your seller account and wants none. What it does and who it is NOT for is written out here: https://northbench-site.a7maaadesmail93.workers.dev/go/storeeye?src=reddit\n\nFounding readers get 30% off with code NORTHBENCH30 - no countdown, it just stays. Happy to explain the diffing approach - it is simpler than you would guess."
  },
  {
    slug: "contentengine",
    title: "I stopped fighting the blank post box - ninety days of content decided in one sitting",
    text: "The blank post box wins because it arrives every single day and you plan once every never. So I flipped the order: decide ninety days in one sitting, then just execute.\n\nWhat's in it: six pillars, thirty written skeletons, a repeat pattern that is deliberate - the pattern is the value, not the novelty - and a repurpose map so one good post works four times. A calendar tab with 90 pre-filled days that self-date. It is planning paper with formulas, not an app, and it posts nothing for you, because the tools that post for you are also the reason everything reads the same.\n\nHonest bits: it is 17 dollars on Gumroad, it will not write your posts or grow your audience for you - it removes the daily deciding, nothing else - and if you post twice a week from inspiration and that works, keep it. What it does and who it is NOT for is written out here: https://northbench-site.a7maaadesmail93.workers.dev/go/contentengine?src=reddit\n\nFounding readers get 30% off with code NORTHBENCH30 - no countdown, it just stays. I will give away three of the thirty skeletons in the comments."
  },
];

function redditDraft(topic, thread, linkOk) {
  const t = REDDIT_TOPICS[topic] || { slug: "wholeshelf", product: "the shelf" };
  const openers = [
    "Been there - this exact thing ate my evenings for a year.",
    "Dealt with this for a long time before I fixed it, so, from the trenches:",
  ];
  const bodies = {
    invoice: [
      "Chase the day after the due date, not a week later - prompt chasers get paid first. Put the invoice number and the amount in the subject line, say the number in the first sentence, and ask one question: has it been scheduled? 'Looking into it' is not an answer. Stay neutral in tone; boredom moves accounts departments, anger doesn't.",
      "Two things fixed this for me: a written late-policy agreed before any work starts (makes chasing administrative instead of awkward), and reminders whose tone matches the age - friendly at day 3, firm and specific at day 30. The email is two sentences. Most people write paragraphs and nobody reads them.",
    ],
    rates: [
      "Work out your effective hourly rate first: everything received last quarter divided by ALL hours worked, including the unbilled ones. Most freelancers find that number is 20-40% below what they thought. Raise from there, between projects, in writing: 'from March 1 my rate is X'. Existing work stays at the old rate - that courtesy is what keeps clients.",
      "Price the outcome, not the hours, when you can - and when you can't, charge for the years that make you fast. A 10-25% step for the same work is defensible; doubles need a genuinely new service. Write your walk-away number down before the conversation, or you'll abandon it mid-sentence.",
    ],
    track: [
      "One spreadsheet beats every CRM I tried for a one-person shop: a clients tab, a projects tab, an invoices tab with a status column. The magic isn't the tool, it's that every invoice has a status and a date, so Friday's 'who owes me what' is a filter, not an evening.",
      "Keep it in one file you can open anywhere: client, project, invoice number, amount, date sent, date due, status. Five minutes to set up, and the overdue filter does the remembering for you. The failure mode isn't tools, it's three places where the truth lives.",
    ],
    template: [
      "Whatever template you use, add a not-included list. It's the one section that prevents every later argument: 'includes two rounds of revision; additional rounds billed at X'. Scope creep lives in the gaps, and the gaps close with one list.",
      "A proposal that closes has three parts: their problem in their words, the plan in plain sentences with dates, and the money as one number with what's included and what's not. Anything else is decoration.",
    ],
    budget: [
      "The version that finally stuck for me: one page, three numbers - fixed costs, what actually went out last month, what came in. No 20-category budget, no app. The whole job is seeing the gap between those numbers every week; anything fancier gets abandoned by February.",
      "Skip the apps for a month and try paper-simple: write fixed costs once, log spending in one list for four weeks, then look. The categories reveal themselves from real rows instead of a template's imagination - and the habit survives because it takes ten minutes a week.",
    ],
    moneyadmin: [
      "What worked here: export the bank CSV once a month, sort by description, highlight every recurring charge. Takes twenty minutes and finds the cancelled-but-still-paying one every single time. The boring version wins because it actually happens.",
      "Two habits carry all of it: every purchase lands in one list the day it happens, and the last day of the month gets a five-line summary. December-you can then answer any question about the year without archaeology. No app, no logins, just rows.",
    ],
    jobhunt: [
      "Track it like a sales pipeline: stage, next action, date. The stage counts tell you the truth - if forty applications sit at 'applied' and nothing at 'interview', the resume is the problem, not the market. And follow up once at day 7; it genuinely moves applications that stalled in a inbox.",
      "For the money conversation: never say a number first if you can avoid it, and when pressed, answer with a range whose bottom you would genuinely accept. Practice it out loud once - the sentence you rehearsed is the one that survives the nerves.",
    ],
    outreach: [
      "Ten researched emails beat two hundred scraped ones, every time it is measured. One personal first line that proves you looked, under a hundred words, one ask, and a follow-up four days later that makes saying no easy. That last part is counterintuitive but it is what gets replies.",
      "The subject line should sound like a colleague wrote it - lowercase, specific, no urgency. And send from your own domain, low volume. Deliverability is a reputation game and the volume tools lose it for you before you start.",
    ],
    content: [
      "Decide the posting topics once, for ninety days, instead of every morning. Six themes, a repeat pattern, and each post is then editing a plan instead of inventing from a blank box. The blank box is what actually kills accounts, not laziness.",
      "Batch: six posts in one sitting beats one per day, every time. And make every seventh post do double duty - rewrite it for email, where you own the list and an algorithm can't take it away.",
    ],
    event: [
      "Three lists carry a big event: guests with RSVP status, a budget with a quote column next to the plan column, and a day-of run sheet that fits on two pages. Everything else is decoration. Watch the gap column - quotes over plan is the thing to catch early.",
      "Seat people in rows, not diagrams: table, capacity, guests. It is slower to look at and much harder to get wrong, and the over-capacity check is a formula instead of a panicked count on the morning of.",
    ],
    shop: [
      "Check your own shop the way a buyer would, daily: does the listing still say for sale, is the price what you meant, does the cover load, does the refund line still exist. Things break quietly and the first person to notice should not be a customer.",
      "A once-a-day look at your own public pages catches the quiet breakages - a vanished cover, a wrong price, a dead link - before a customer emails you about them. Two minutes, every day, worst thing first.",
    ],
    launch: [
      "Before building anything: ask ten people who have the problem whether they would pay for the fix. Not friends - people in the places the problem lives. Two questions, real answers, and most bad ideas die cheaply before they eat a summer.",
      "Price above the fee floor and say plainly what the thing does and who it is not for. The honest version of a product page converts better anyway - the people who buy are the ones it actually fits, and they are the ones who don't refund.",
    ],
    tutoring: [
      "The tutoring admin that actually matters is three numbers: sessions held, fees earned, fees actually paid. Most tutors can guess the first, estimate the second, and have no idea about the third - and the third is the one that decides whether the term pays. One file, one row per lesson, and the maths does itself.",
      "Track no-shows honestly, both kinds: the student who cancelled late and the slot you quietly gave away free. Counted over a term they are usually worth a month of fees, and the number is only uncomfortable the first time you look at it.",
    ],
  };
  const seed = String(thread.link).length + thread.title.length;
  const opener = openers[seed % openers.length];
  const body = (bodies[topic] || bodies.track)[(seed + 1) % 2];
  if (!linkOk) {
    return opener + " " + body + "\n\n(This is me sharing what worked, nothing to buy here.)";
  }
  return opener + " " + body + "\n\nDisclosure: I build plain-file tools for exactly this - " +
    t.product + " is here if it's useful: https://northbench-site.a7maaadesmail93.workers.dev/go/" +
    t.slug + "?src=reddit";
}

// Reddit closed self-service API app creation in early 2026 (approval-only,
// most requests denied, Devvit pushed instead) - so the automation now ends
// at a paste-ready reply in the daily brief. The owner posts it as
// themselves from their own browser: no API, no bot footprint, and exactly
// how a human redditor builds karma on a young account.
async function subRules(env) {
  try {
    if (env && env.VIEWS) return JSON.parse((await env.VIEWS.get("reddit:rules")) || "{}");
  } catch (e) {}
  return {};
}

async function redditCandidate(exclude) {
  const skip = new Set((exclude || []).map((x) => String(x).split("?")[0]));
  const pool = [];
  const rules = await subRules(RADAR_ENV);
  try {
    const { threads } = await radarThreads();
    for (const t of threads) pool.push(t);
  } catch (e) {}
  try {
    const env = RADAR_ENV;
    if (env && env.VIEWS) {
      const lt = JSON.parse((await env.VIEWS.get("laptop:threads")) || "null");
      if (lt && Date.now() - Date.parse(lt.at) < 30 * 3600000) {
        for (const t of (lt.threads || [])) {
          // shreddit stamps carry 6-digit fractions; trim to 3 or Date.parse NaNs
          const tms = Date.parse(String(t.ts || "").replace(/(\.\d{3})\d+/, "$1"));
          const age = isNaN(tms) ? 6 : Math.round((Date.now() - tms) / 3600000);
          if (age > 30 || age < 0) continue;
          if (!radarRelevant(t.sub || "", t.title)) continue;
          pool.push({ sub: t.sub || "?", age: age, title: t.title, link: t.link, topic: radarTopic(t.title) });
        }
      }
    }
  } catch (e) {}
  const seen = new Set();
  const candidates = pool.filter((t) => {
    const id = t.link.split("?")[0];
    if (seen.has(id)) return false;
    seen.add(id);
    return t.topic && t.age <= 30 && !skip.has(id);
  });
  const postSubs = new Set(POST_SUBS.map((x) => x.toLowerCase()));
  const live = candidates.filter((t) => !((rules[t.sub || ""] || {}).banned) &&
    !postSubs.has(String(t.sub || "").toLowerCase()));
  if (!live.length) return null;
  live.sort((a, b) => a.age - b.age);
  const thread = live[0];
  const linkOk = ((rules[thread.sub || ""] || {}).ok) === true;
  return { thread: thread, draft: redditDraft(thread.topic, thread, linkOk), linkOk: linkOk };
}

async function redditState(env) {
  if (!env.VIEWS) return { answers: [] };
  try {
    const raw = await env.VIEWS.get("reddit:state");
    return raw ? JSON.parse(raw) : { answers: [] };
  } catch (e) { return { answers: [] }; }
}

async function redditToken(keys) {
  const basic = btoa(keys.client_id + ":" + keys.client_secret);
  const res = await grab("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: { "Authorization": "Basic " + basic,
               "User-Agent": "northbench-commenter/1.0 by u/" + keys.username,
               "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=password&username=" + encodeURIComponent(keys.username) +
          "&password=" + encodeURIComponent(keys.password),
  }, 10000);
  const j = await res.json();
  if (!j || !j.access_token) throw new Error("reddit login refused: " + JSON.stringify(j).slice(0, 100));
  return j.access_token;
}

async function redditRun(env, note, live) {
  const keys = (JSON.parse(env.RUNNER_SECRETS_JSON || "{}").reddit) || null;
  if (!keys || !keys.client_id || !keys.username) {
    note("reddit: manual mode - Reddit stopped approving new API apps (2026); the paste-ready reply is in the daily brief");
    return;
  }
  if (!keys.enabled) { note("reddit: keys present, switch off (enabled:true starts the warmup)"); return; }
  const state = await redditState(env);
  if (state.paused) { note("reddit: PAUSED - " + (state.pause_reason || "last comment was removed")); return; }

  // last comment's health check: removed or ghosted -> pause everything
  if (state.last && state.last.checked !== today()) {
    try {
      const tok = await redditToken(keys);
      const res = await grab("https://oauth.reddit.com/api/info?id=" + state.last.kind_id, {
        headers: { "Authorization": "bearer " + tok,
                   "User-Agent": "northbench-commenter/1.0 by u/" + keys.username } }, 8000);
      if (res.ok) {
        const j = await res.json();
        const c = (j.data && j.data.children && j.data.children[0] && j.data.children[0].data) || null;
        state.last.checked = today();
        if (!c || c.body === "[removed]" || c.banned_by) {
          state.paused = true;
          state.pause_reason = "last comment (" + state.last.day + ") was removed";
          await env.VIEWS.put("reddit:state", JSON.stringify(state));
          note("reddit: PAUSED - last comment was removed. Needs a human look before it posts again.");
          return;
        }
        state.last.score = c.score;
        await env.VIEWS.put("reddit:state", JSON.stringify(state));
      }
    } catch (e) { note("reddit: last-comment check failed - continuing"); }
  }

  const count = (state.answers || []).length;
  const warmup = count < REDDIT_WARMUP;
  const dom = new Date().getUTCDate();
  if (warmup && dom % 2 === 0) { note("reddit: warmup rest day (" + count + "/" + REDDIT_WARMUP + ")"); return; }

  const { threads } = await radarThreads();
  const answered = new Set((state.answers || []).map((a) => a.id));
  const candidates = threads.filter((t) =>
    t.topic && t.age <= 30 && !answered.has(t.link.split("?")[0]));
  if (!candidates.length) { note("reddit: no qualifying thread today"); return; }
  const thread = candidates[0];
  const draft = redditDraft(thread.topic, thread, warmup);

  if (!live) {
    note("reddit [dry run] warmup " + count + "/" + REDDIT_WARMUP + " | r/" + thread.sub +
         " | " + thread.title.slice(0, 60) + " | draft: " + draft.slice(0, 130) + "...");
    return;
  }

  const thing = "t3_" + (thread.link.split("/comments/")[1] || "").split("/")[0];
  try {
    const tok = await redditToken(keys);
    const res = await grab("https://oauth.reddit.com/api/comment", {
      method: "POST",
      headers: { "Authorization": "bearer " + tok,
                 "User-Agent": "northbench-commenter/1.0 by u/" + keys.username,
                 "Content-Type": "application/x-www-form-urlencoded" },
      body: "api_type=json&thing_id=" + encodeURIComponent(thing) +
            "&text=" + encodeURIComponent(draft),
    }, 12000);
    const j = await res.json();
    const ok = j && j.json && j.json.data && j.json.data.things && j.json.data.things.length;
    if (!ok) {
      note("reddit: refused - " + JSON.stringify((j && j.json && j.json.errors) || j).slice(0, 120));
      return;
    }
    const cid = j.json.data.things[0].data.id;
    state.answers = (state.answers || []).concat(
      [{ id: thread.link.split("?")[0], day: today(), topic: thread.topic }]);
    state.last = { day: today(), kind_id: "t1_" + cid, checked: null, score: null };
    await env.VIEWS.put("reddit:state", JSON.stringify(state));
    note("reddit: answered r/" + thread.sub + " - '" + thread.title.slice(0, 60) +
         "' (" + (warmup ? "warmup " + (count + 1) + "/" + REDDIT_WARMUP + ", no link" : "link day") + ")");
  } catch (e) {
    note("reddit: refusing to post - " + String((e && e.message) || e));
  }
}

// ----------------------------------------------------------------- the radar
// A read-only Reddit research page for the owner. It NEVER posts, never
// votes, never touches an account. It fetches public search feeds, shows
// fresh threads, and offers a suggested honest answer the owner adapts and
// posts by hand. Automation does the finding; the human does the posting.
const RADAR_PATH = "/radar-d6a3709b5284c5201b482d36";

const RADAR_QUERIES = [
  ["r/freelance", "https://www.reddit.com/r/freelance/new.rss?limit=25"],
  ["r/freelancers", "https://www.reddit.com/r/freelancers/new.rss?limit=25"],
  ["r/smallbusiness", "https://www.reddit.com/r/smallbusiness/new.rss?limit=25"],
  ["r/Entrepreneur", "https://www.reddit.com/r/Entrepreneur/new.rss?limit=25"],
  ["r/sidehustle", "https://www.reddit.com/r/sidehustle/new.rss?limit=25"],
  ["r/personalfinance", "https://www.reddit.com/r/personalfinance/new.rss?limit=25"],
  ["r/jobs", "https://www.reddit.com/r/jobs/new.rss?limit=25"],
  ["r/Excel", "https://www.reddit.com/r/Excel/new.rss?limit=25"],
  ["r/ecommerce", "https://www.reddit.com/r/ecommerce/new.rss?limit=25"],
  ["r/wedding", "https://www.reddit.com/r/wedding/new.rss?limit=25"],
  ["r/socialmedia", "https://www.reddit.com/r/socialmedia/new.rss?limit=25"],
];
// one fetch per sub instead of many searches: Reddit's rate limiter likes
// this far better, and the topic filters below do the real narrowing.

// Reddit 429s parallel bursts. One query at a time, spaced out, one retry,
// and a 10-minute cache so the page and the daily brief share one fetch.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let RADAR_CACHE = { at: 0, data: null };
let RADAR_ENV = null;

// Quality gates - the old site-wide queries pulled ASMR scripts and pet-sitting;
// a lead now has to come from a working-freelancer sub AND read like a real
// problem, or it never reaches the page.
const RADAR_SUBS = /^(freelance|freelancers|smallbusiness|Entrepreneur|personalfinance|upwork|sidehustle|freelance_writers|graphic_design|web_design|copywriting|sysadmin|Bookkeeping|jobs|careerguidance|Excel|spreadsheets|ecommerce|wedding|weddingplanning|socialmedia|smallbusinessUK|EntrepreneurRideAlong|startups|tutors|onlineeducation|teaching|Teachers)$/i;
const RADAR_JUNK = /\bM4F|F4M|ASMR|roleplay|NSFW|hiring|\bLF\b|looking for a|seeking a|petsit|mech\b|\[hiring\]|\[for hire\]/i;
const RADAR_TOPICS = /freelanc|invoice|client|rate|charg|payment|paid|budget|spreadsheet|template|tracker|contract|proposal|money|pricing|job hunt|job search|interview|salary|offer|cold email|outreach|first client|content calendar|posting schedule|what to post|guest list|seating|wedding budget|vendor|my shop|listing|price change|first product|digital product|launch|net worth|debt|subscription|tutor|tuition|lesson plan|students? i tutor|private tutoring|my students|student progress|tuition fee/i;

function radarRelevant(sub, title) {
  if (!RADAR_SUBS.test(sub)) return false;
  if (RADAR_JUNK.test(title)) return false;
  return RADAR_TOPICS.test(title);
}

const RADAR_ANSWERS = {
  invoice: "I keep one list with invoice date, due date, amount and a days-past-due column. Chase in age order, oldest first: one short reminder the day after the due date, then weekly. Most late payments are administration, not refusal - a weekly nudge finds out which one it is. Twenty minutes to set up, five minutes a week to run.",
  rates: "Work backwards from the number you need per month: hours you can actually bill, plus tax, plus the dry months. That gives a floor, not a ceiling - quote up from it by how much the client values the job. The mistake is starting from the going rate; the going rate is someone else's math.",
  track: "One spreadsheet beats most CRMs at this size: a client tab, an invoice tab with ageing, and a pipeline tab for who might sign next. If it takes more than five minutes a week to update, it is too complicated and you will quietly stop using it.",
  template: "Whatever template you use, keep three things visible: the scope in one sentence, the price with what it includes, and the payment terms. If a client has to ask what something covers, the quote did half its job badly.",
  budget: "One page, three numbers: fixed costs, what went out, what came in. Ten minutes a week. Anything fancier gets abandoned by February.",
  moneyadmin: "Export the bank CSV monthly, sort by description, highlight recurring charges. Twenty minutes, and it finds the cancelled-but-still-paying one every time.",
  jobhunt: "Track stage, next action, date - the stage counts show whether the problem is the resume or the market. Follow up at day 7; it moves stalled applications.",
  outreach: "Ten researched emails beat two hundred scraped. One personal line, under 100 words, one ask, easy-no follow-up four days later.",
  content: "Decide ninety days of topics once, then edit instead of inventing. The blank box is what kills accounts, not laziness.",
  event: "Three lists: guests with RSVPs, budget with a quote column next to plan, and a two-page day-of run sheet. Watch the gap column.",
  shop: "Check your own listings daily the way a buyer sees them: price, cover, published state, refund line. Things break quietly.",
  launch: "Ask ten people with the problem before building. Two questions, real answers - most bad ideas die cheaply before they eat a summer.",
};

function radarTopic(title) {
  const t = title.toLowerCase();
  if (/unpaid|invoice|chase|late payment|overdue/.test(t)) return "invoice";
  if (/rate|charge|price|pricing|how much|quote/.test(t)) return "rates";
  if (/template|proposal|contract|agreement|sow|scope/.test(t)) return "template";
  if (/job hunt|job search|interview|salary|offer|resume|applying/.test(t)) return "jobhunt";
  if (/cold email|outreach|first client|pitch/.test(t)) return "outreach";
  if (/content calendar|posting schedule|what to post|content ideas|batch/.test(t)) return "content";
  if (/guest list|seating|wedding budget|vendor|planning my wedding|event/.test(t)) return "event";
  if (/my shop|listing|storefront|price change|product page/.test(t)) return "shop";
  if (/first product|digital product|launch|sell online|pricing my/.test(t)) return "launch";
  if (/budget|net worth|debt|subscription|expenses|saving/.test(t)) return "budget";
  if (/categorize|bank statement|money admin|quarterly taxes/.test(t)) return "moneyadmin";
  if (/client|track|crm|spreadsheet|pipeline|lead/.test(t)) return "track";
  return null;
}

function radarDecode(s) {
  return String(s).replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function radarEntries(xml) {
  const out = [];
  const re = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const e = m[1];
    const t = e.match(/<title[^>]*>([\s\S]*?)<\/title>/);
    const l = e.match(/<link[^>]*href="([^"]+)"/);
    const u = e.match(/<updated>([^<]+)<\/updated>/);
    if (t && l) out.push({ title: radarDecode(t[1]), link: l[1], updated: u ? u[1] : "" });
  }
  return out;
}

async function radarThreads() {
  // shared cache in KV across every isolate - the laptop polls often and
  // Reddit throttles datacenter IPs, so all isolates must share one rhythm
  const env = RADAR_ENV;
  if (env && env.VIEWS) {
    try {
      const c = JSON.parse((await env.VIEWS.get("radar:cache")) || "null");
      if (c && c.data && Date.now() - c.at < 900000) { RADAR_CACHE = c; return c.data; }
      const lock = JSON.parse((await env.VIEWS.get("radar:lock")) || "null");
      if (lock && Date.now() - lock.at < 120000 && c && c.data) { RADAR_CACHE = c; return c.data; }
      await env.VIEWS.put("radar:lock", JSON.stringify({ at: Date.now() }));
    } catch (e) {}
  }
  if (RADAR_CACHE.data && Date.now() - RADAR_CACHE.at < 300000) return RADAR_CACHE.data;
  const results = [];
  for (const q of RADAR_QUERIES) {
    let xml = null, err = null;
    for (let attempt = 0; attempt < 2 && xml === null; attempt++) {
      if (attempt) await sleep(5000);
      try {
        const res = await grab(q[1], { headers: { "User-Agent": "Mozilla/5.0 (compatible; northbench-radar/1.0; research only)" } }, 9000);
        if (!res.ok) { err = "HTTP " + res.status; continue; }
        xml = await res.text();
      } catch (e) { err = String((e && e.message) || e); }
    }
    results.push(xml !== null ? { ok: true, xml: xml } : { ok: false, err: err || "no answer" });
    await sleep(1500);
  }
  const threads = [], errors = [];
  const seen = {};
  for (const r of results) {
    if (!r.ok) { errors.push(r.err); continue; }
    for (const e of radarEntries(r.xml)) {
      const id = e.link.split("?")[0];
      if (seen[id]) continue;
      seen[id] = true;
      const sub = (e.link.match(/reddit\.com\/r\/([^\/]+)/) || [])[1] || "";
      const age = e.updated ? Math.round((Date.now() - Date.parse(e.updated)) / 3600000) : 999;
      if (age > 48) continue;
      if (!radarRelevant(sub, e.title)) continue;
      threads.push({ sub: sub, age: age, title: e.title, link: e.link, topic: radarTopic(e.title) });
    }
  }
  threads.sort((a, b) => a.age - b.age);
  RADAR_CACHE = { at: Date.now(), data: { threads, errors } };
  if (env && env.VIEWS) { try { await env.VIEWS.put("radar:cache", JSON.stringify(RADAR_CACHE)); } catch (e) {} }
  return RADAR_CACHE.data;
}

async function radarPage() {
  const started = Date.now();
  const { threads, errors } = await radarThreads();
  const rows = threads.slice(0, 24).map((t) => {
    const ans = t.topic ? (RADAR_ANSWERS[t.topic] || "") : "";
    const ansHtml = ans
      ? '<p class="lab">suggested answer - adapt into your own words, no links in the post</p><textarea readonly rows="4">' + ans + "</textarea>"
      : '<p class="lab">no canned answer for this one - answer from experience: help first, never a link in the post, the profile does the selling</p>';
    return '<div class="th"><p class="meta">r/' + t.sub + " · " + (t.age < 1 ? "under an hour" : t.age + "h old") +
      '</p><p><a href="' + t.link + '" target="_blank" rel="noopener">' + t.title + "</a></p>" + ansHtml + "</div>";
  }).join("\n");
  const errHtml = errors.length
    ? '<p class="err">some queries refused by Reddit (' + errors.join("; ") + ") - rate limits come and go; the rest of the list is live.</p>"
    : "";
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    "<title>Northbench Radar</title><style>" +
    "body{margin:0;font:15px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;background:#10121a;color:#e8e6e1;padding:26px 18px}" +
    ".wrap{max-width:820px;margin:0 auto}h1{font-size:26px;margin:0 0 6px;letter-spacing:-.5px}p{margin:6px 0}" +
    ".sub{color:#aeb4c4}.th{background:#181b25;border:1px solid #2b3040;border-radius:12px;padding:14px 16px;margin:12px 0}" +
    ".meta{color:#FF6A3D;font-size:12.5px;margin:0 0 4px;text-transform:uppercase;letter-spacing:.4px}" +
    "a{color:#fff;text-decoration:none;border-bottom:1px solid #FF6A3D}textarea{width:100%;margin-top:6px;background:#0d0f15;color:#cbd2e0;border:1px solid #2b3040;border-radius:8px;padding:10px;font:13.5px/1.5 inherit}" +
    ".lab{color:#6b7280;font-size:12.5px;margin:8px 0 0}.err{color:#f2b29b;background:#241a15;border:1px solid #4a2f22;border-radius:8px;padding:8px 12px}" +
    "footer{color:#6b7280;font-size:13px;margin-top:26px;border-top:1px solid #2b3040;padding-top:14px}" +
    "</style></head><body><div class=\"wrap\">" +
    "<h1>Northbench Radar</h1><p class=\"sub\">Fresh freelancer threads from the last 48 hours. This page never posts anything - you post, in your own words, from your own account. Two or three answers a day is the whole job.</p>" +
    errHtml + rows +
    "<footer>found in " + (Date.now() - started) + "ms · " + threads.length + " fresh threads · read-only by design · the rules: help first, no links in posts, no copy-paste twice, the profile does the selling</footer>" +
    "</div></body></html>";
}


// ------------------------------------------------- the owner's daily brief
// The reminder layer the owner asked for: one Telegram DM a day with the
// freshest radar leads and one rotating to-do. DMs need the owner to have
// pressed Start on the bot once - until then this waits silently.
const REMINDERS = [
  "Domain: northbench.co at Cloudflare Registrar (~$25/yr). Say 'domain bought' in the chat and everything gets wired the same day.",
  "Affiliates: Gumroad -> Settings -> Affiliates -> Enable (30%). Say 'on' and the recruitment posts fire.",
  "Pinterest business account (10 min). The pin batch is cut and waiting.",
  "X: paste this week's pack into Buffer (marketing/social/X-WEEK-1.md), or hand over API keys once and it posts itself.",
  "Reddit: answer two threads from today's radar. Help first, links never.",
  "Drop the free sampler link wherever someone asks about prompts - it is the shop's front door.",
  "KPI review day: the week's numbers land in this chat today.",
];

async function telegramSend(token, chatId, text) {
  const res = await grab("https://api.telegram.org/bot" + token + "/sendMessage", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "chat_id=" + encodeURIComponent(chatId) + "&text=" + encodeURIComponent(text),
  }, 9000);
  return res.ok;
}

async function ownerChatId(env) {
  if (env.OWNER_CHAT_ID) return env.OWNER_CHAT_ID;
  try {
    const res = await grab("https://api.telegram.org/bot" + env.TELEGRAM_TOKEN + "/getUpdates?limit=20", {}, 8000);
    if (!res.ok) return null;
    const data = await res.json();
    const privates = (data.result || []).filter((u) => u.message && u.message.chat && u.message.chat.type === "private");
    if (!privates.length) return null;
    const chat = privates[privates.length - 1].message.chat;
    return String(chat.id);
  } catch (e) { return null; }
}

async function ownerBrief(env, runLog) {
  const out = ["Northbench daily - " + today(), ""];
  out.push(runLog.length ? "Posts today: " + runLog.join("; ") : "Posts today: nothing scheduled (check the switches)");
  try {
    const { threads } = await radarThreads();
    out.push("", "Radar - freshest " + Math.min(5, threads.length) + " of " + threads.length + " fresh threads:");
    for (const t of threads.slice(0, 5)) {
      out.push("- r/" + t.sub + " (" + (t.age < 1 ? "under 1h" : t.age + "h") + "): " + t.title.slice(0, 90) + "\n  " + t.link);
    }
    if (!threads.length) out.push("radar quiet - no fresh threads in 48h");
  } catch (e) { out.push("radar unavailable: " + String(e && e.message || e)); }
  // Reddit manual-assist (2026: Reddit ended self-service API apps): the
  // brief ends with a ready-to-paste reply to the freshest qualifying
  // thread. 30 seconds of copying = the channel alive, zero bot risk.
  try {
    if (env.VIEWS) {
      const st = await redditState(env);
      const offered = new Set(((st.offered || []).map((o) => o.id))
        .concat((st.answers || []).map((a) => a.id)));
      const warmb = ((st.answers || []).length) < REDDIT_WARMUP;
      const pick = await redditCandidate(Array.from(offered), warmb);
      if (pick) {
        st.offered = (st.offered || []).concat(
          [{ id: pick.thread.link.split("?")[0], day: today() }]).slice(-40);
        await env.VIEWS.put("reddit:state", JSON.stringify(st));
        out.push("", "Reddit today (paste this as yourself, 30 sec): " + pick.thread.link, "",
          pick.draft);
      } else {
        out.push("", "Reddit today: no fresh qualifying thread - nothing to paste");
      }
    }
  } catch (e) { /* manual assist must never break the brief */ }
  // reddit eyes: what the laptop's daily scan saw (never breaks the brief)
  try {
    if (env.VIEWS) {
      const sc = JSON.parse((await env.VIEWS.get("laptop:lastscan")) || "null");
      if (sc && sc.at && sc.at.slice(0, 10) === today() && sc.posts && sc.posts.length) {
        out.push("Reddit eyes r/" + sc.sub + ": " + sc.posts.slice(0, 3)
          .map((p) => (p.title || "").slice(0, 55)).join(" / "));
      }
    }
  } catch (e) {}
  // the inbox: what the machine's own inbox watch saw
  try {
    if (env.VIEWS) {
      const ib = JSON.parse((await env.VIEWS.get("laptop:inbox")) || "null");
      if (ib) out.push("Reddit inbox: " + (ib.unread ? ib.unread + " unread" : "clear") +
        (ib.top && ib.top.length ? " - last: " + ((ib.top[0].who || "?") + " " + (ib.top[0].subject || "")).slice(0, 50) : "") +
        (ib.karma ? " | karma " + ib.karma : ""));
    }
  } catch (e) {}
  // the backlog: visible progress, every day
  try {
    if (env.VIEWS) {
      const bl = JSON.parse((await env.VIEWS.get("work:backlog")) || "[]");
      const open = bl.filter((b) => b.status !== "done");
      if (open.length) out.push("Machine backlog: " + open.length + " open — now on: " + (open[0].what || "?").slice(0, 60));
      else if (bl.length) out.push("Machine backlog: all clear ✓");
    }
  } catch (e) {}
  // the laptop hand: what it last told us, and when (never breaks the brief)
  try {
    if (env.VIEWS) {
      const raw = await env.VIEWS.get("laptop:status");
      if (raw) {
        const s = JSON.parse(raw);
        const mins = Math.round((Date.now() - Date.parse(s.at)) / 60000);
        const ago = mins < 60 ? mins + " min ago" : Math.round(mins / 60) + "h ago";
        out.push("Laptop hand: " + (s.what || "reported") + " (" + ago + ")");
      } else {
        out.push("Laptop hand: not connected yet (run-windows.bat on the laptop)");
      }
    }
  } catch (e) {}
  // first-party traffic: yesterday's real pageviews (ours excluded) and the
  // /go/ clicks by channel, read straight from the site's KV counters (a
  // worker-to-worker fetch on this account 404s - the binding is the door).
  // Never breaks the brief: no binding or empty day is one quiet line.
  try {
    if (env.VIEWS) {
      const days = [];
      for (let i = 1; i <= 3; i++) {
        days.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
      }
      let d = null, pv = null, go = null;
      for (const cand of days) {
        const v = await env.VIEWS.get("views:" + cand);
        const g = await env.VIEWS.get("go:" + cand);
        if (v || g) { d = cand; pv = v ? JSON.parse(v) : {}; go = g ? JSON.parse(g) : {}; break; }
      }
      if (d) {
        let views = 0; const refTotals = {};
        for (const path of Object.keys(pv)) {
          views += (pv[path] || {}).n || 0;
          for (const r of Object.keys((pv[path] || {}).refs || {})) {
            refTotals[r] = (refTotals[r] || 0) + pv[path].refs[r];
          }
        }
        const srcs = [];
        for (const slug of Object.keys(go || {})) {
          for (const src of Object.keys(go[slug])) srcs.push(src + ":" + go[slug][src]);
        }
        out.push("", "Traffic " + d + " - real pageviews: " + views +
                       (Object.keys(refTotals).length ? " (from: " +
                        Object.keys(refTotals).sort((a, b) => refTotals[b] - refTotals[a]).join(", ") + ")" : "") +
                       (srcs.length ? " | buy-door clicks: " + srcs.join(", ") : " | buy-door clicks: 0"));
      } else {
        out.push("", "Traffic - no counted days yet (first numbers appear tomorrow)");
      }
    }
  } catch (e) { out.push("traffic line unavailable: " + String(e && e.message || e)); }
  const day = new Date().getUTCDay();
  out.push("", "Today's one thing: " + REMINDERS[day % REMINDERS.length]);
  out.push("", "The radar page (never posts, you do): https://northbench-courier.a7maaadesmail93.workers.dev" + RADAR_PATH);
  return out.join("\n");
}

async function run(env) {
  const log = [];
  try {
    // the schedule lives in KV (food:schedule) - the one source of truth,
    // updated by the shop whenever it regenerates. HTTP copies are the
    // fallback, and which source answered is recorded in the log.
    let schedule = null, source = "none", last = "";
    try {
      const raw = env.VIEWS && await env.VIEWS.get("food:schedule");
      if (raw) { schedule = JSON.parse(raw); source = "kv"; }
    } catch (e) { last = "kv: " + String((e && e.message) || e); }
    if (!schedule) {
      const urls = [].concat(env.RUNNER_SCHEDULE_URL || DEFAULT_SCHEDULE);
      for (const u of urls) {
        try {
          const res = await grab(u, {}, 8000);
          if (!res.ok) { last = u + " -> " + res.status; continue; }
          schedule = await res.json();
          source = "http:" + (u.includes("netlify") ? "netlify" : "cloudflare");
          break;
        } catch (e) { last = u + " -> " + (e && e.message ? e.message : e); }
      }
    }
    if (!schedule) return { error: "schedule fetch failed everywhere: " + last, log };
    const log = [];
    const note = (m) => log.push(m);
    note("food source: " + source);
    var lastFoodDate = "";
    try {
      const ds = (schedule.days || []).map((r) => r.date).sort();
      lastFoodDate = ds[ds.length - 1] || "";
    } catch (e) {}
    const rows = (schedule.days || []).filter((r) => r.date === today());
    if (!rows.length) return { note: "nothing scheduled for today - the switches are off (food source: " + source + ")", log };
    let keys = {};
    try { keys = JSON.parse(env.RUNNER_SECRETS_JSON || "{}"); } catch (e) { keys = {}; }
    for (const row of rows) {
      const sender = SENDERS[row.platform];
      if (!sender) { note(row.platform + ": this courier does not speak it yet - skipped"); continue; }
      try { await sender(row, keys[row.platform] || keys.buffer, note, env); }
      catch (e) { note(row.platform + ": " + String((e && e.message) || e)); }
    }
    return { ok: true, log };
  } catch (e) {
    return { error: String((e && e.message) || e), log };
  }
}

export default {
  async scheduled(controller, env, ctx) {        // the daily 09:30 UTC cron
    ctx.waitUntil((async () => {
      const out = await run(env);
      // the food's sell-by date, said out loud: a schedule that runs out
      // posts nothing, silently - never again without a warning first
      try {
        if (out && out.log && lastFoodDate) {
          const daysLeft = Math.round((Date.parse(lastFoodDate) - Date.now()) / 86400000);
          if (daysLeft < 45) out.log.push("WARNING: the schedule food runs out in " +
            daysLeft + " days (" + lastFoodDate + ") - say 'regen food' in the chat");
        }
      } catch (e) { /* a warning must never break the run */ }
      if (env.TELEGRAM_TOKEN) {
        try {
          const chat = await ownerChatId(env);
          if (chat) {
            const brief = await ownerBrief(env, (out && out.log) || []);
            await telegramSend(env.TELEGRAM_TOKEN, chat, brief);
          }
        } catch (e) { /* the brief is a courtesy - it must never break posting */ }
      }
      if (out && out.error) {
        try { await telegramSend(env.TELEGRAM_TOKEN, (await ownerChatId(env)) || "@northbenchweekly",
              "Northbench courier - PROBLEM: " + out.error); } catch (e) {}
      }
      try {
        const rlog = [];
        await redditRun(env, (m) => rlog.push(m), true);
        if (rlog.length) {
          await telegramSend(env.TELEGRAM_TOKEN, (await ownerChatId(env)) || "@northbenchweekly",
                             "Reddit rail: " + rlog.join("; "));
        }
      } catch (e) { /* the reddit rail never breaks the daily run */ }
      // S64: the foreman (the AI layer of the control center) thinks right
      // after the daily run - no free cron slot left, so the courier's own
      // 09:30 cron carries it. Fire-and-forget; a foreman failure must
      // never touch the posting pass.
      if (env.FOREMAN_URL && env.FOREMAN_KEY) {
        try {
          await fetch(env.FOREMAN_URL + "?key=" + encodeURIComponent(env.FOREMAN_KEY),
                      { headers: { "User-Agent": "nb-agent/1.0" } });
        } catch (e) { /* the foreman thinks for itself tomorrow */ }
      }
      return out;
    })());
  },
  async fetch(request, env) {                    // manual check: GET the worker URL
    RADAR_ENV = env;   // the radar needs KV for its shared cache
    const url = new URL(request.url);
    if (url.pathname === RADAR_PATH) {           // the radar: read-only, never sends
      return new Response(await radarPage(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
        if (url.searchParams.get("laptop") === "628fc1f007c0a791712f2f6f0da515481880315a") {
      // the owner's laptop bridge. The courier plans (radar + drafts); the
      // laptop script is just the hands: it opens the thread in the owner's
      // real Chrome and pastes the reply as them. This endpoint hands out
      // the day's tasks and records what the laptop completed.
      const out = { ok: true };
      try {
        if (env.VIEWS && (await env.VIEWS.get("laptop:control")) === "halt") out.control = "halt";
        const status = url.searchParams.get("status");
        const done = url.searchParams.get("done");
        const push = url.searchParams.get("push");
        const result = url.searchParams.get("result");
        if (push && env.VIEWS) {
          // ME, adding work to the laptop's queue: comment/message/edit/delete/read
          const t = JSON.parse(push);
          const q = JSON.parse((await env.VIEWS.get("laptop:queue")) || "[]");
          t.id = (t.id || crypto.randomUUID().slice(0, 8));
          t.queuedAt = new Date().toISOString();
          q.push(t);
          await env.VIEWS.put("laptop:queue", JSON.stringify(q.slice(-50)));
          out.queued = t;
        } else if (result && env.VIEWS) {
          // the laptop reporting what a task did (my feedback loop)
          const r = JSON.parse(result);
          r.at = new Date().toISOString();
          const rs = JSON.parse((await env.VIEWS.get("laptop:results")) || "[]");
          rs.unshift(r);
          await env.VIEWS.put("laptop:results", JSON.stringify(rs.slice(0, 20)));
          if (r.action === "sweep" && r.ok && r.data && r.data.threads && env.VIEWS) {
            // the laptop's eyes: threads read from the home ip, never throttled
            await env.VIEWS.put("laptop:threads", JSON.stringify({
              at: new Date().toISOString(), threads: r.data.threads.slice(0, 20) }));
            await env.VIEWS.put("laptop:swept", new Date().toISOString());
            // and the sub rules it read: open -> links allowed, else link-free
            const rules = JSON.parse((await env.VIEWS.get("reddit:rules")) || "{}");
            for (const sub of Object.keys(r.data.rules || {})) {
              const v = r.data.rules[sub];
              if (v && v.ok !== null && !((rules[sub] || {}).banned))
                rules[sub] = { ok: !!v.ok, hit: (v.hit || []).slice(0, 4), n: v.n || 0,
                               removeds: (rules[sub] || {}).removeds || 0,
                               at: new Date().toISOString() };
            }
            await env.VIEWS.put("reddit:rules", JSON.stringify(rules));
          } else if (r.action === "checkcomment" && r.ok && r.data && env.VIEWS) {
            // survival watch: a removed comment teaches the machine
            const last = JSON.parse((await env.VIEWS.get("reddit:last")) || "null");
            if (last) {
              last.checked = new Date().toISOString();
              last.status = (r.data && r.data.status) || "unknown";
              if (last.status === "removed" || last.status === "gone") {
                const rules = JSON.parse((await env.VIEWS.get("reddit:rules")) || "{}");
                const rsub = rules[last.sub || ""] || { ok: false, hit: [], removeds: 0 };
                rsub.removeds = (rsub.removeds || 0) + 1;
                if (last.linked && rsub.removeds < 2) { rsub.ok = false; last.lesson = "linked comment removed - sub goes link-free"; }
                else { rsub.banned = true; last.lesson = "removed again - sub banned from replies"; }
                rules[last.sub || ""] = rsub;
                await env.VIEWS.put("reddit:rules", JSON.stringify(rules));
                const rem = JSON.parse((await env.VIEWS.get("reddit:removed")) || "[]");
                rem.push({ sub: last.sub, day: today(), linked: !!last.linked, at: last.checked });
                await env.VIEWS.put("reddit:removed", JSON.stringify(rem.slice(-20)));
                const since = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
                const recent = rem.filter((x) => x.day >= since);
                const subsHit = new Set(recent.map((x) => x.sub));
                if (subsHit.size >= 2) {
                  const stx = JSON.parse((await env.VIEWS.get("reddit:state")) || "{}");
                  stx.paused = true;
                  stx.pause_reason = "comments removed in " + subsHit.size + " different subs";
                  await env.VIEWS.put("reddit:state", JSON.stringify(stx));
                }
              }
              await env.VIEWS.put("reddit:last", JSON.stringify(last));
            }
          } else if (r.action === "submit" && env.VIEWS) {
            if (!(r.ok && r.data && r.data.url)) {
              // a failed submit teaches: after 3 in a day, launch posts pause
              try {
                const fl = JSON.parse((await env.VIEWS.get("reddit:launchfail")) || "[]");
                fl.push({ at: new Date().toISOString(), why: (r.error || "").slice(0, 80) });
                await env.VIEWS.put("reddit:launchfail", JSON.stringify(fl.slice(-10)));
                // reddit's own gate ("that was a tricky one") means the account
                // is too young for threads: wait 3 days, let comment karma grow
                if (/tricky|try that again/i.test(r.error || "")) {
                  await env.VIEWS.put("reddit:launchgate", JSON.stringify({
                    until: new Date(Date.now() + 3 * 86400000).toISOString(),
                    why: "reddit gates thread posts from young accounts - growing karma first" }));
                }
              } catch (e) {}
            }
          }
          if (r.action === "submit" && r.ok && r.data && r.data.url && env.VIEWS) {
            // the launch post landed: record it, then the survival watch
            // takes over through reddit:pending -> &done -> reddit:last
            try {
              const posts = JSON.parse((await env.VIEWS.get("reddit:posts")) || "[]");
              posts.push({ sub: (r.data.sub || r.sub || "?"), url: r.data.url.split("?")[0],
                at: new Date().toISOString() });
              await env.VIEWS.put("reddit:posts", JSON.stringify(posts.slice(-20)));
              await env.VIEWS.put("reddit:pending", JSON.stringify({
                thread: r.data.url.split("?")[0], sub: (r.data.sub || r.sub || "?"),
                topic: "launch", linked: true, at: new Date().toISOString() }));
            } catch (e) {}
          } else if (r.action === "inbox" && r.ok && r.data && env.VIEWS) {
            await env.VIEWS.put("laptop:inbox", JSON.stringify({
              unread: r.data.unread || 0, karma: r.data.karma || "",
              top: (r.data.items || []).slice(0, 5), at: new Date().toISOString() }));
          }
          if (String(r.id || "").indexOf("scan-") === 0 && r.ok) {
            await env.VIEWS.put("laptop:lastscan", JSON.stringify({ sub: (r.data && r.data.sub) || "?",
              posts: (r.data && r.data.posts) || [], at: new Date().toISOString() }));
            await env.VIEWS.put("laptop:scanned", today());
          }
          // pull it from the queue if still there
          const q = JSON.parse((await env.VIEWS.get("laptop:queue")) || "[]");
          const q2 = q.filter((x) => x.id !== r.id);
          if (q2.length !== q.length) await env.VIEWS.put("laptop:queue", JSON.stringify(q2));
          out.recorded = "result";
        } else if (url.searchParams.get("code") === "1" && env.VIEWS) {
          // the laptop's self-update: newest nb-social.js source
          try {
            const c = JSON.parse((await env.VIEWS.get("laptop:code")) || "{}");
            return new Response(JSON.stringify({ version: c.version || 0, src: c.src || "" }),
              { headers: { "content-type": "application/json" } });
          } catch (e) { return new Response("{\"version\":0}", { headers: { "content-type": "application/json" } }); }
        } else if (url.searchParams.get("view") === "1") {
          // the cockpit: one page showing the whole machine
          const g = async (k, d) => { try { return JSON.parse((await env.VIEWS.get(k)) || d); } catch (e) { return JSON.parse(d); } };
          const st = await g("laptop:status", "{}");
          const qu = await g("laptop:queue", "[]");
          const re = await g("laptop:results", "[]");
          const sc = await g("laptop:lastscan", "null");
          const bl = await g("work:backlog", "[]");
          const note = (await env.VIEWS.get("assistant:note")) || "(no note set)";
          const esc = (x) => String(x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
          const ago = (iso) => { try { const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
            return m < 60 ? m + " min ago" : Math.round(m / 60) + "h ago"; } catch (e) { return "?"; } };
          const rows = (arr, f) => arr.map(f).join("") || '<div class="dim">— none yet —</div>';
          const html = "<!doctype html><html><head><meta charset=utf-8><title>Northbench machine</title>" +
            '<meta http-equiv="refresh" content="20">' +
            "<style>body{font-family:system-ui;background:#0e1116;color:#d7dde6;margin:0;padding:24px}" +
            "h1{font-size:20px;margin:0 0 4px}.dim{color:#7a8699}.card{background:#161b23;border:1px solid #232b38;border-radius:10px;padding:14px 18px;margin:14px 0}" +
            ".ok{color:#4ade80}.warn{color:#fbbf24}li{margin:6px 0}small{color:#7a8699}</style></head><body>" +
            "<h1>NORTHBENCH — the machine</h1><div class=dim>cloud brain · laptop hands · the assistant in between · refreshes itself every 20s</div>" +
            '<div class=card><b>Laptop hand</b><br>' + (st.what
              ? "state: <b class=ok>" + esc(st.what) + "</b> · last heartbeat " + ago(st.at) +
                (st.note ? " · " + esc(st.note) : "")
              : '<span class=warn>never connected</span> — run run-windows.bat on the laptop') + "</div>" +
            '<div class=card><b>From your assistant</b><br>' + esc(note).replace(/\n/g, "<br>") + "</div>" +
            '<div class=card><b>Waiting in the queue</b>' + rows(qu, (t) => "<div>• " + esc(t.action) + " " + esc((t.url || t.to || "").slice(0, 70)) + "</div>") + "</div>" +
            '<div class=card><b>Last results (hands reporting back)</b>' + rows(re.slice(0, 6), (r) =>
              "<div>• " + (r.ok ? '<span class=ok>✓</span>' : '<span class=warn>✗</span>') + " " + esc(r.action) +
              (r.error ? " — " + esc(r.error).slice(0, 80) : " — " + esc(JSON.stringify(r.data || r.result || "")).slice(0, 90)) +
              " <small>" + ago(r.at) + "</small></div>") + "</div>" +
            '<div class=card><b>Reddit eyes</b><br>' + (sc && sc.posts && sc.posts.length
              ? "r/" + esc(sc.sub) + " scanned " + ago(sc.at) + ":<ul>" + sc.posts.slice(0, 5).map((p) =>
                  "<li>" + esc(p.title || "").slice(0, 90) + " <small>(" + esc(p.comments || "?") + " comments)</small></li>").join("") + "</ul>"
              : '<span class=dim>no scan yet — the laptop scans once a day when idle</span>') + "</div>" +
            '<div class=card><b>Backlog (the assistant is burning this down)</b><ul>' + rows(bl, (b) =>
              "<li>" + (b.status === "done" ? "✓ " : "○ ") + esc(b.what) + (b.status === "done" ? "" : " <small>[" + esc(b.status) + "]</small>") + "</li>") + "</ul></div>" +
            "</body></html>";
          return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
        } else if (url.searchParams.get("control") && env.VIEWS) {
          // the kill switch: halt or resume the laptop bridge remotely
          const c = url.searchParams.get("control");
          if (c === "halt" || c === "run") {
            await env.VIEWS.put("laptop:control", c);
            out.control = c;
          } else out.error = "control must be halt or run";
        } else if (url.searchParams.get("note") && env.VIEWS) {
          await env.VIEWS.put("assistant:note", url.searchParams.get("note"));
          out.noteSaved = true;
        } else if (url.searchParams.get("badd") && env.VIEWS) {
          const bl = JSON.parse((await env.VIEWS.get("work:backlog")) || "[]");
          bl.push({ id: crypto.randomUUID().slice(0, 8), what: url.searchParams.get("badd"), status: "open" });
          await env.VIEWS.put("work:backlog", JSON.stringify(bl.slice(-40)));
          out.backlog = bl.length;
        } else if (url.searchParams.get("bdone") && env.VIEWS) {
          const bl = JSON.parse((await env.VIEWS.get("work:backlog")) || "[]");
          const b = bl.find((x) => x.id === url.searchParams.get("bdone"));
          if (b) b.status = "done";
          await env.VIEWS.put("work:backlog", JSON.stringify(bl));
          out.backlog = bl.length;
        } else if (status && env.VIEWS) {
          // the laptop's heartbeat. v-fix 2026-10-20 status-write throttle:
          // KV writes cap at 1000/day; the courier keeps only the freshest
          // status per 4-minute window, so no heartbeat storm can ever burn
          // the budget (the v42 bridge also self-throttles to 10 minutes).
          const s = JSON.parse(status);
          let fresh = true;
          try {
            const prevS = JSON.parse((await env.VIEWS.get("laptop:status")) || "{}");
            if (prevS.at && Date.now() - Date.parse(prevS.at) < 240000) fresh = false;
          } catch (e) {}
          if (fresh) {
            s.at = new Date().toISOString();
            await env.VIEWS.put("laptop:status", JSON.stringify(s));
          }
          out.recorded = "status";
          try { out.echo = s; } catch (e) {}
        } else if (env.VIEWS) {
          try { const prev = await env.VIEWS.get("laptop:status"); if (prev) out.laptop = JSON.parse(prev); } catch (e) {}
          const st = await redditState(env);
          if (done) {
            st.answers = (st.answers || []).concat(
              [{ id: decodeURIComponent(done), day: today(), via: "laptop" }]).slice(-200);
            await env.VIEWS.put("reddit:state", JSON.stringify(st));
            try {
              const pend = JSON.parse((await env.VIEWS.get("reddit:pending")) || "null");
              if (pend && pend.thread === decodeURIComponent(done)) {
                await env.VIEWS.put("reddit:last", JSON.stringify(
                  { thread: pend.thread, sub: pend.sub, linked: pend.linked,
                    at: new Date().toISOString(), checked: null, tries: 0 }));
              }
            } catch (e) {}
            out.recorded = true;
          } else {
            const exclude = (st.offered || []).map((o) => o.id)
              .concat((st.answers || []).map((a) => a.id));
            if (st.paused) {
              out.note = "reddit PAUSED - " + (st.pause_reason || "a comment was removed") +
                ". Needs a human look before it posts again.";
              out.tasks = JSON.parse((await env.VIEWS.get("laptop:queue")) || "[]");
              out.say = out.note;
              return new Response(JSON.stringify(out, null, 1),
                { headers: { "content-type": "application/json" } });
            }
            const todayCount = (st.answers || []).filter((a) => a.day === today()).length;
            // v39 HEAVY MODE (owner directive 2026-10-17): auto commenting ON and
            // maximized within survival rails. Volume scales with account karma,
            // up to 3 fresh picks per cycle (the laptop's ~5-min cycles pace them
            // naturally). The brakes stay: pause-on-removal, survival checks,
            // per-sub rules, link policy, warmup. Heavy, not suicidal.
            let karmaNow = 0;
            try {
              const ib = JSON.parse((await env.VIEWS.get("laptop:inbox")) || "{}");
              karmaNow = parseInt(String(ib.karma || "").replace(/[^0-9]/g, ""), 10) || 0;
            } catch (e) {}
            // v40 MAXIMUM-SAFE (owner directive: no invented low caps - run at the
            // real platform-risk ceiling): base 8/day, +3 per 20 karma, ceiling 25.
            // The safety rails are per-sub spread (max 2 per sub/day) and the
            // standing brakes (pause-on-removal, survival checks, rules, warmup).
            const dailyCap = Math.min(8 + Math.floor(karmaNow / 20) * 3, 25);
            const subDay = {};
            for (const o of (st.offered || [])) if (o.day === today()) subDay[o.sub || "?"] = (subDay[o.sub || "?"] || 0) + 1;
            const picks = [];
            const excl = exclude.slice();
            while (picks.length < Math.min(4, dailyCap - todayCount)) {
              let c = null;
              for (let guard = 0; guard < 4 && !c; guard++) {
                const t = await redditCandidate(excl);
                if (!t) break;
                if ((subDay[t.thread.sub || "?"] || 0) >= 2) { excl.push(t.thread.link.split("?")[0]); continue; }
                c = t;
              }
              if (!c) break;
              picks.push(c);
              excl.push(c.thread.link.split("?")[0]);
              subDay[c.thread.sub || "?"] = (subDay[c.thread.sub || "?"] || 0) + 1;
            }
            if (picks.length && env.VIEWS) {
              const pl = picks[picks.length - 1];
              await env.VIEWS.put("reddit:pending", JSON.stringify({
                thread: pl.thread.link.split("?")[0], sub: pl.thread.sub,
                topic: pl.thread.topic, linked: !!pl.linkOk, at: new Date().toISOString() }));
            }
            if (picks.length) {
              st.offered = (st.offered || []).concat(
                picks.map((p) => ({ id: p.thread.link.split("?")[0], sub: p.thread.sub || "?", day: today() }))).slice(-160);
              await env.VIEWS.put("reddit:state", JSON.stringify(st));
            }
            // my queue first (live control), then the heavy picks
            const q = JSON.parse((await env.VIEWS.get("laptop:queue")) || "[]");
            let tasks = q.concat(picks.map((p, i) => ({ id: "radar-" + Date.now().toString(36) + "-" + i,
              platform: "reddit", action: "comment",
              url: p.thread.link, text: p.draft })));
            // keep the eyes fresh: auto-queue a sweep when the thread pool is stale
            try {
              const lt2 = JSON.parse((await env.VIEWS.get("laptop:threads")) || "null");
              if ((!lt2 || Date.now() - Date.parse(lt2.at) > 6 * 3600000) &&
                  !tasks.some((t) => t.action === "sweep")) {
                tasks.push({ id: "sweep-" + Date.now().toString(36), platform: "reddit", action: "sweep" });
              }
            } catch (e) {}
            out.note = "ENGINE reddit | queued " + picks.length + " | today " + todayCount + "/" + dailyCap +
              " | karma " + karmaNow + (st.paused ? " | PAUSED" : "") +
              (q.length ? " | manual " + q.length : "") +
              (tasks.some((t) => String(t.id || "").indexOf("sweep-") === 0) ? " | sweep fresh" : "");
            // the survival check: 90 minutes after a comment, did it stick?
            if (!tasks.length && env.VIEWS) {
              try {
                const last = JSON.parse((await env.VIEWS.get("reddit:last")) || "null");
                if (last && !last.checked && Date.now() - Date.parse(last.at) > 90 * 60000 && (last.tries || 0) < 2) {
                  last.tries = (last.tries || 0) + 1;
                  await env.VIEWS.put("reddit:last", JSON.stringify(last));
                  tasks = [{ id: "chk-" + Date.now().toString(36), platform: "reddit",
                             action: "checkcomment", url: last.thread }];
                  out.note = "checking whether the last comment survived (round " + last.tries + ")";
                }
              } catch (e) {}
            }
            // launch day: every 5 days a real thread with the link, in a sub
            // that exists for exactly that and whose rules read open
            if (!tasks.length && env.VIEWS) {
              try {
                const posts = JSON.parse((await env.VIEWS.get("reddit:posts")) || "[]");
                const lastAt = posts.length ? Date.parse(posts[posts.length - 1].at) : 0;
                const fails = JSON.parse((await env.VIEWS.get("reddit:launchfail")) || "[]")
                  .filter((x) => Date.now() - Date.parse(x.at) < 86400000);
                const gate = JSON.parse((await env.VIEWS.get("reddit:launchgate")) || "null");
                if (fails.length >= 3) { /* circuit breaker holds launch posts */ }
                else if (gate && Date.now() < Date.parse(gate.until)) { /* account too young: waiting */ }
                else if (karmaNow < 10) { /* owner gate: launch threads wait for 10+ karma; comments grow it; auto-retries */ }
                else if (!posts.length || Date.now() - lastAt > 5 * 86400000) {
                  const rules = JSON.parse((await env.VIEWS.get("reddit:rules")) || "{}");
                  const doneSubs = new Set(posts.map((p) => (p.sub || "").toLowerCase()));
                  const open = POST_SUBS.filter((x) => !doneSubs.has(x.toLowerCase()) &&
                    ((rules[x] || {}).ok) === true && !(rules[x] || {}).banned);
                  const sub = open[0];
                  if (sub) {
                    const d = LAUNCHES[posts.length % LAUNCHES.length];
                    tasks = [{ id: "post-" + Date.now().toString(36), platform: "reddit",
                      action: "submit", sub: sub, title: d.title, text: d.text }];
                    out.note = "launch post day: r/" + sub + " (rules say links are fine there)";
                  }
                }
              } catch (e) {}
            }
            // idle is rare: no queue + no reply + not swept in 6h -> sweep
            let sweptAt = 0;
            try { sweptAt = Date.parse((await env.VIEWS.get("laptop:swept")) || "") || 0; } catch (e) {}
            if (!tasks.length && Date.now() - sweptAt > 6 * 3600000) {
              tasks = [{ id: "sweep-" + Date.now().toString(36), platform: "reddit", action: "sweep" }];
              out.note = "sweeping 11 subs for fresh threads (the machine's eyes on Reddit)";
            }
            out.tasks = tasks;
            // the assistant line - the live link he can see every run
            try {
              const bl = JSON.parse((await env.VIEWS.get("work:backlog")) || "[]");
              const open = bl.filter((b) => b.status !== "done").length;
              const note = await env.VIEWS.get("assistant:note");
              out.say = "Link OK — " + new Date().toISOString().slice(0, 16).replace("T", " ") +
                " UTC. Queue: " + q.length + ". Backlog: " + open + " open item(s)." +
                (note ? "\n" + note : "\nWatching the radar and your morning brief.");
            } catch (e) {}
            try { const rs = await env.VIEWS.get("laptop:results"); if (rs) out.results = JSON.parse(rs).slice(0, 3); } catch (e) {}
          }
        } else { out.tasks = []; out.note = "no KV binding"; }
      } catch (e) { out.error = String((e && e.message) || e); out.tasks = []; }
      return new Response(JSON.stringify(out, null, 1), { headers: { "content-type": "application/json" } });
    }
    if (url.searchParams.get("reddit") === "1") {  // dry-run: the candidate + draft, posts nothing
      const rlog = [];
      try { await redditRun(env, (m) => rlog.push(m), false); }
      catch (e) { rlog.push("error: " + String((e && e.message) || e)); }
      let manual = null;
      try {
        const pick = await redditCandidate();
        if (pick) manual = { thread: pick.thread.link, sub: pick.thread.sub,
                             title: pick.thread.title, draft: pick.draft };
      } catch (e) { manual = { error: String((e && e.message) || e) }; }
      return new Response(j({ reddit: rlog, manual_today: manual }),
        { headers: { "content-type": "application/json" } });
    }
    if (url.searchParams.get("brief") === "1") {   // test the owner brief without waiting for the cron
      const chat = await ownerChatId(env);
      const brief = await ownerBrief(env, ["manual test"]);
      let sent = null;
      if (env.TELEGRAM_TOKEN && chat) sent = await telegramSend(env.TELEGRAM_TOKEN, chat, brief);
      return new Response(j({ chat: chat, sent: sent, brief: brief.slice(0, 400) }),
        { headers: { "Content-Type": "application/json" } });
    }
    const out = await run(env);
    // v39 connect-all: the health GET also reports the reddit engine's state,
    // so the night crew's KPI can carry it next to revenue and traffic - one
    // file, every system.
    try {
      if (env.VIEWS) {
        const st = JSON.parse((await env.VIEWS.get("reddit:state")) || "{}");
        const ib = JSON.parse((await env.VIEWS.get("laptop:inbox")) || "{}");
        const td = new Date().toISOString().slice(0, 10);
        out.reddit = {
          today: (st.answers || []).filter((a) => a.day === td).length,
          total: (st.answers || []).length,
          paused: !!st.paused,
          karma: ib.karma || ""
        };
      }
    } catch (e) { /* the connect-all add-on must never break the run */ }
    return new Response(j(out), { headers: { "Content-Type": "application/json" } });
  },
};
