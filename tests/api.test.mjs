/* Backend test: boots the API on an in-memory database and exercises it end to end.
 * No network and no keys needed. Set DATABASE_URL to run the same checks on Postgres.
 * Run with: npm test
 */
process.env.JOBS = "off";
process.env.API_TOKEN = "test-key";
import { readFileSync } from "node:fs";
import { createServer } from "../server/index.mjs";
import { openDb, openStore, scoped, seedFrom } from "../server/db.mjs";
import { runDailyBriefs, makeWeeklyPlan } from "../server/jobs.mjs";
import { blocksToEvents } from "../server/gcal.mjs";
import { hashPassword, verifyPassword } from "../server/auth.mjs";
import { mondayOf, addDays, dkey } from "../app/engine.mjs";

const failures = [];
const check = (ok, msg) => { console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`); if (!ok) failures.push(msg); };

const db = process.env.DATABASE_URL ? await openStore() : openDb(":memory:");
console.log(`storage: ${db.kind}`);
await db.clear();
await seedFrom(db, JSON.parse(readFileSync("seed/example.json", "utf8")));

const server = createServer({ db, token: "test-key" }).listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;

let cookie = "";
async function call(path, opts = {}) {
  const res = await fetch(base + path, {
    method: opts.method || "GET",
    headers: {
      "content-type": "application/json",
      ...(cookie && opts.cookie !== false ? { cookie } : {}),
      ...(opts.bearer ? { authorization: "Bearer " + opts.bearer } : {}),
      ...opts.headers,
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    redirect: "manual",
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie && opts.keepCookie !== false) cookie = setCookie.split(";")[0];
  return res;
}
const json = async (res) => (res.status === 204 ? null : res.json());

try {
  // --- passwords
  const hash = await hashPassword("correct horse battery");
  check(await verifyPassword("correct horse battery", hash), "a password verifies against its own hash");
  check(!(await verifyPassword("wrong password here", hash)), "a wrong password does not verify");
  check(!hash.includes("correct"), "the stored hash doesn't contain the password");

  // --- public and locked routes
  check((await json(await call("/api/health"))).ok === true, "health check answers without signing in");
  check((await call("/api/state")).status === 401, "the API refuses an anonymous request");

  // --- first account adopts the planner data that was already there
  const signup = await call("/api/auth/signup", { method: "POST", body: { email: "Amer@Example.com", password: "a-long-enough-password" } });
  const created = await json(signup);
  check(signup.status === 201 && created.user.email === "amer@example.com", "the first visitor can create the account");
  check(created.adopted === true, "the account adopts the data that was there before accounts existed");
  check(Boolean(cookie), "signing up sets a session cookie");

  const state = await json(await call("/api/state"));
  check(Object.keys(state.goals).length === 10, `the account sees the seeded goals (${Object.keys(state.goals).length})`);

  const second = await call("/api/auth/signup", { method: "POST", body: { email: "someone@else.com", password: "another-long-password" }, keepCookie: false });
  check(second.status === 403, "a second signup is refused once the planner has an owner");

  // --- signing in
  const saved = cookie; cookie = "";
  check((await call("/api/state")).status === 401, "a request without the cookie is refused");
  const bad = await call("/api/auth/login", { method: "POST", body: { email: "amer@example.com", password: "not the password" }, keepCookie: false });
  check(bad.status === 401, "a wrong password is refused");
  const good = await call("/api/auth/login", { method: "POST", body: { email: "amer@example.com", password: "a-long-enough-password" } });
  check(good.status === 200 && Boolean(cookie) && cookie !== saved, "the right password starts a new session");
  check((await json(await call("/api/auth/me"))).user.email === "amer@example.com", "the session says who is signed in");

  // --- the planner itself
  const due = dkey(addDays(new Date(), 3));
  const put = await call("/api/tasks/t-test", { method: "PUT", body: { title: "Write API test", pillar: "career", minutes: 60, due, priority: 1, done: false, createdAt: Date.now() } });
  check(put.status === 200, "a task can be saved");
  check((await call("/api/users/sneaky", { method: "PUT", body: { email: "x" } })).status === 400, "the API won't let anyone write to the users collection");

  const weekStart = dkey(addDays(mondayOf(new Date()), 7));
  const plan = await json(await call("/api/plan", { method: "POST", body: { weekStart } }));
  check(plan.weekStart === weekStart && plan.blocks.length > 20, `the planner lays out the week (${plan.blocks.length} blocks)`);
  check(plan.blocks.some((b) => b.ref === "t-test"), "the new task gets time in the plan");

  let clash = null;
  for (let d = 0; d < 7 && !clash; d++) {
    const day = plan.blocks.filter((b) => b.d === d).sort((a, b) => a.s - b.s);
    for (let i = 1; i < day.length; i++) if (day[i].s < day[i - 1].e) clash = `${day[i - 1].title} and ${day[i].title}`;
  }
  check(!clash, `no two blocks overlap${clash ? ": " + clash : ""}`);
  check((await call("/api/tasks/t-test", { method: "DELETE" })).status === 204, "a task can be deleted");

  // --- the API key still works for scripts, as the owner account
  cookie = "";
  const viaKey = await json(await call("/api/state", { bearer: "test-key" }));
  check(Object.keys(viaKey.goals).length === 10, "the API key reaches the same account's data");
  cookie = saved;

  // --- notifications and calendar, switched off in this test
  check((await call("/api/push/subscribe", { method: "POST", body: { subscription: { endpoint: "https://example.com/x" } } })).status === 503,
    "push says it isn't set up when there are no VAPID keys");
  const gcal = await json(await call("/api/gcal/status"));
  check(gcal.enabled === false && gcal.connected === false, "Google Calendar reports itself as not set up");

  const events = blocksToEvents({ weekStart, blocks: [
    { id: "b1", d: 0, s: 9 * 60, e: 10 * 60 + 30, title: "Belay deep work", src: "goal" },
    { id: "b2", d: 6, s: 19 * 60, e: 20 * 60, title: "Done already", src: "goal", done: true },
  ] }, { tz: "America/New_York" });
  check(events.length === 1, "finished blocks are left out of the calendar");
  check(events[0].start.dateTime === `${weekStart}T09:00:00` && events[0].end.dateTime === `${weekStart}T10:30:00`,
    `a block becomes an event at the right time (${events[0].start.dateTime})`);
  check(events[0].start.timeZone === "America/New_York", "the event carries the timezone");

  // --- the scheduled jobs, per account
  const briefs = await runDailyBriefs(db);
  check(briefs.length === 1 && briefs[0].text.length > 10, "the morning brief job writes one brief per account");
  const weekly = await makeWeeklyPlan(scoped(db, created.user.id));
  check(weekly.by === "autopilot", "the Sunday job plans next week");
  check((await json(await call("/api/state"))).briefs.length >= 1, "briefs show up in the state the page reads");

  const page = await (await fetch(base + "/")).text();
  check(page.includes("window.AMER_API") && page.includes("Amer OS"), "the server serves the planner page");
  check((await fetch(base + "/sw.js")).status === 200, "the service worker is served from the root");
  check((await fetch(base + "/manifest.webmanifest")).status === 200, "the web app manifest is served");
} finally {
  server.close();
  await db.close();
}

if (failures.length) { console.error(`\n${failures.length} check(s) failed`); process.exit(1); }
console.log("\nAll API checks passed");
