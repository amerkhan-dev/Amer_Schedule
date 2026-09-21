// Smoke test: loads app/preview.html in Chromium with a fake Claude runtime
// (an in-memory database + a stubbed Claude answer), then checks that
// planning, "Ask Claude", editing and the phone layout all work.
// Run with: npm test   (first time: npx playwright install chromium)
process.env.JOBS = "off";
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { createServer } from "../server/index.mjs";
import { openDb, seedFrom } from "../server/db.mjs";

const seed = JSON.parse(readFileSync("seed/example.json", "utf8"));
const pageUrl = pathToFileURL(path.resolve("app/preview.html")).href;

// Runs inside the page before any page script: stands in for window.claude.
function fakeRuntime(seed) {
  const docs = new Map();
  const listeners = [];
  for (const [coll, items] of Object.entries(seed)) for (const [id, d] of Object.entries(items)) docs.set(`${coll}/${id}`, structuredClone(d));
  const snapDoc = (p) => ({ id: p.split("/").pop(), exists: docs.has(p), data: () => docs.get(p), metadata: { fromCache: false, hasPendingWrites: false } });
  const runQuery = (q) => {
    let rows = [...docs.entries()]
      .filter(([p]) => p.startsWith(q.coll + "/") && p.split("/").length === q.coll.split("/").length + 1)
      .map(([p, d]) => ({ p, d }));
    for (const [f, op, v] of q.where) if (op === "==") rows = rows.filter((r) => r.d[f] === v);
    if (q.order) rows.sort((a, b) => (a.d[q.order[0]] > b.d[q.order[0]] ? 1 : -1) * (q.order[1] === "desc" ? -1 : 1));
    if (q.limit) rows = rows.slice(0, q.limit);
    const ds = rows.map((r) => snapDoc(r.p));
    return { docs: ds, size: ds.length, empty: !ds.length, docChanges: () => [], metadata: {} };
  };
  const notify = () => setTimeout(() => { for (const l of listeners) l.cb(l.q ? runQuery(l.q) : snapDoc(l.p)); }, 0);
  const query = (q) => ({
    where: (f, op, v) => query({ ...q, where: [...q.where, [f, op, v]] }),
    orderBy: (f, dir) => query({ ...q, order: [f, dir] }),
    limit: (n) => query({ ...q, limit: n }),
    get: async () => runQuery(q),
    onSnapshot: (cb) => { listeners.push({ q, cb }); setTimeout(() => cb(runQuery(q)), 5); return () => {}; },
  });
  const docRef = (p) => ({
    id: p.split("/").pop(), path: p,
    get: async () => snapDoc(p),
    set: async (d) => { docs.set(p, structuredClone(d)); notify(); },
    update: async (d) => { docs.set(p, { ...docs.get(p), ...d }); notify(); },
    delete: async () => { docs.delete(p); notify(); },
    onSnapshot: (cb) => { listeners.push({ p, cb }); setTimeout(() => cb(snapDoc(p)), 5); return () => {}; },
  });
  const db = { doc: docRef, collection: (c) => ({ ...query({ coll: c, where: [] }), path: c, doc: (id) => docRef(`${c}/${id || Math.random().toString(36).slice(2)}`) }) };

  const thu = new Date(); thu.setDate(thu.getDate() - ((thu.getDay() + 6) % 7) + 10); // Thursday next week
  const thuKey = `${thu.getFullYear()}-${String(thu.getMonth() + 1).padStart(2, "0")}-${String(thu.getDate()).padStart(2, "0")}`;
  const sample = async () => ({ text: "ok", truncated: false });
  sample.json = async () => ({
    reply: "Added the midterm and 4 hours of prep before it.",
    ops: [
      { op: "addEvent", title: "CSE midterm", pillar: "class", date: thuKey, start: "14:00", end: "15:15", where: "" },
      { op: "addTask", title: "Midterm prep", pillar: "class", minutes: 240, due: thuKey, priority: 1 },
      { op: "notARealOp" },
    ],
    replan: true,
  });
  window.claude = { use: async (name) => (name === "db" ? db : name === "sample" ? sample : null) };
}

const failures = [];
const check = (ok, msg) => { console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`); if (!ok) failures.push(msg); };

const browser = await chromium.launch();
try {
  // Desktop
  const desk = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  const errors = [];
  desk.on("pageerror", (e) => errors.push(e.message));
  await desk.addInitScript(fakeRuntime, seed);
  await desk.goto(pageUrl);
  await desk.waitForTimeout(500);
  await desk.click("#nextWeek");
  await desk.click("#planBtn");
  await desk.waitForTimeout(300);
  const blocks = await desk.$$eval(".blk", (els) => els.length);
  check(blocks > 20, `planner fills next week (${blocks} blocks)`);

  await desk.fill("#agentInput", "My midterm moved to Thursday 2pm. I need 4 hours of prep.");
  await desk.click("#askBtn");
  await desk.waitForTimeout(500);
  const ops = await desk.$$eval(".op", (els) => els.length);
  check(ops === 2, `Claude's suggestions are validated (2 valid of 3, got ${ops})`);
  await desk.click("text=Apply and replan");
  await desk.waitForTimeout(400);
  const midterm = await desk.$$eval(".blk", (els) => els.map((e) => e.title).filter((t) => /midterm/i.test(t)));
  check(midterm.some((t) => t.startsWith("CSE midterm")) && midterm.some((t) => t.startsWith("Midterm prep")), "approved changes land in the plan");

  await desk.click("[data-tab=commitments]");
  await desk.fill("#f-commitments-title", "CSE 2050 lecture");
  await desk.check("#f-commitments-days-0");
  await desk.check("#f-commitments-days-2");
  await desk.fill("#f-commitments-start", "10:10");
  await desk.fill("#f-commitments-end", "11:00");
  await desk.click("#f-commitments-submit");
  await desk.waitForTimeout(200);
  check((await desk.$$eval("#tabList .row-item", (els) => els.length)) === 1, "weekly schedule form adds a class");
  check(errors.length === 0, `no page errors on desktop${errors.length ? ": " + errors.join("; ") : ""}`);

  // Phone
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await phone.addInitScript(fakeRuntime, seed);
  await phone.goto(pageUrl);
  await phone.waitForTimeout(500);
  await phone.click("#planBtn");
  const width = await phone.evaluate(() => document.documentElement.scrollWidth);
  check(width <= 390, `no sideways scrolling on a phone (page is ${width}px wide)`);

  // The same page against the real backend, the way `npm start` serves it.
  const db = openDb(":memory:");
  await seedFrom(db, seed);
  const server = createServer({ db, token: null }).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const served = await ctx.newPage();
    const apiErrors = [];
    served.on("pageerror", (e) => apiErrors.push(e.message));
    await served.goto(base);
    await served.waitForTimeout(600);

    // No account yet, so the page should offer to create one.
    check(!(await served.isHidden("#authOverlay")), "the served page asks you to sign in");
    check((await served.textContent("#authSubmit")).includes("Create"), "the first visit offers to create the account");
    await served.fill("#authEmail", "amer@example.com");
    await served.fill("#authPassword", "a-long-enough-password");
    await served.click("#authSubmit");
    await served.waitForTimeout(800);
    check(await served.isHidden("#authOverlay"), "signing up drops you into the planner");
    check((await served.textContent("#connections")).includes("amer@example.com"), "the page shows who is signed in");

    const status = await served.textContent("#status");
    check(/server/i.test(status), `the served page talks to the API (status: ${status.trim()})`);
    await served.click("#nextWeek");
    await served.click("#planBtn");
    await served.waitForTimeout(600);
    const cookies = await ctx.cookies();
    const session = cookies.find((c) => c.name === "amer_session");
    check(Boolean(session && session.httpOnly), "the session cookie is httpOnly, so page scripts can't read it");
    const stored = await (await fetch(base + "/api/state", { headers: { cookie: `${session.name}=${session.value}` } })).json();
    check(Object.keys(stored.plans).length === 1, "the plan made in the browser is saved in the server's database");
    check(apiErrors.length === 0, `no page errors against the API${apiErrors.length ? ": " + apiErrors.join("; ") : ""}`);
  } finally {
    server.close();
    await db.close();
  }
} finally {
  await browser.close();
}
if (failures.length) { console.error(`\n${failures.length} check(s) failed`); process.exit(1); }
console.log("\nAll checks passed");
