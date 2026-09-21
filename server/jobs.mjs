/* Scheduled jobs: the part that makes the planner feel agentic.
 *
 *   Sunday 20:00  - lay out next week and save a short summary
 *   Weekdays 07:00 - write a morning brief for the day
 *
 * Both write into the `briefs` collection, which the page shows in the
 * Ask Claude panel. They work without an Anthropic key (the text is then
 * assembled from the plan); with a key, Claude writes it.
 *
 * Times use the server's timezone. Set TZ=America/New_York (Render, Fly and
 * Railway default to UTC).
 */
import cron from "node-cron";
import { replan } from "./plan.mjs";
import { scoped } from "./db.mjs";
import { sendPush } from "./push.mjs";
import { askEnabled, askClaude } from "./ask.mjs";
import { DAYS, dkey, dur, mondayOf, addDays, weekPosition, weekStats } from "../app/engine.mjs";

const fmtTime = (m) => { const h = Math.floor(m / 60) % 24, mi = m % 60; const ap = h < 12 ? "am" : "pm"; return `${((h + 11) % 12) + 1}${mi ? ":" + String(mi).padStart(2, "0") : ""}${ap}`; };

/** The plain-text facts a brief is built from. */
async function dayFacts(db, now) {
  const state = await db.state();
  const week = mondayOf(now), key = dkey(week);
  const plan = state.plans[key] || null;
  const d = weekPosition(week, now).today;
  const blocks = ((plan && plan.blocks) || []).filter((b) => b.d === d).sort((a, b) => a.s - b.s);
  const today = dkey(now);
  const dueToday = Object.values(state.tasks).filter((t) => !t.done && t.due === today);
  const overdue = Object.values(state.tasks).filter((t) => !t.done && t.due && t.due < today);
  const booked = blocks.filter((b) => b.src !== "meal").reduce((a, b) => a + (b.e - b.s), 0);
  return { state, plan, week, d, blocks, dueToday, overdue, booked, today };
}

export async function makeDailyBrief(db, now = new Date()) {
  const f = await dayFacts(db, now);
  if (!f.plan) return await save(db, "daily", now, "No plan for this week yet. Open the planner and press Plan.");
  const lines = f.blocks.map((b) => `${fmtTime(b.s)}-${fmtTime(b.e)} ${b.title}`);
  let text;
  if (askEnabled()) {
    const prompt = `Write a short morning brief for Amer, who is a student and startup founder using a weekly planner.
Today is ${DAYS[f.d]} ${f.today}. His plan for today:
${lines.join("\n") || "(nothing scheduled)"}
Due today: ${f.dueToday.map((t) => t.title).join("; ") || "nothing"}
Overdue: ${f.overdue.map((t) => t.title).join("; ") || "nothing"}
His rules: ${(f.state.config && f.state.config.rules) || "(none)"}

Three sentences at most, speaking to him as "you": what today looks like, the one thing that matters most, and a warning only if something is genuinely at risk. No greeting, no sign-off, no bullet points.`;
    try { text = await askClaude(prompt, { maxTokens: 300 }); }
    catch (e) { console.error("daily brief via Claude failed:", e.message); }
  }
  if (!text) {
    const first = f.blocks.find((b) => b.e > now.getHours() * 60 + now.getMinutes());
    text = [
      `${f.blocks.length} blocks today, ${dur(f.booked)} booked.`,
      first ? `Next: ${first.title} at ${fmtTime(first.s)}.` : "Nothing left on the calendar today.",
      f.dueToday.length ? `Due today: ${f.dueToday.map((t) => t.title).join(", ")}.` : "",
      f.overdue.length ? `Overdue: ${f.overdue.map((t) => t.title).join(", ")}.` : "",
    ].filter(Boolean).join(" ");
  }
  return await save(db, "daily", now, text);
}

export async function makeWeeklyPlan(db, now = new Date()) {
  const next = addDays(mondayOf(now), 7);
  const plan = await replan(db, next, "autopilot");
  const state = await db.state();
  const st = weekStats(state, plan, next);
  const targets = st.rows.map((r) => `${r.g.label}: ${r.planned}/${r.target}`).join(", ");
  const missed = (plan.unplaced || []).map((u) => `${u.title} (${u.why})`);
  let text;
  if (askEnabled()) {
    const prompt = `Amer is a student and startup founder. His planner just laid out next week (starting ${plan.weekStart}).
Weekly targets hit by the plan: ${targets || "(no goals set)"}
Didn't fit: ${missed.join("; ") || "everything fit"}
Hours by area: ${Object.entries(st.hours).map(([k, v]) => `${k} ${Math.round(v)}h`).join(", ")}
His rules: ${(state.config && state.config.rules) || "(none)"}

Four sentences at most, speaking to him as "you": what next week looks like, what's at risk, and what you'd cut or move. No greeting, no bullet points.`;
    try { text = await askClaude(prompt, { maxTokens: 400 }); }
    catch (e) { console.error("weekly brief via Claude failed:", e.message); }
  }
  if (!text) {
    text = [`Next week is planned: ${plan.blocks.length} blocks.`, targets ? `Targets: ${targets}.` : "",
      missed.length ? `Didn't fit: ${missed.join("; ")}.` : "Everything fit."].filter(Boolean).join(" ");
  }
  await save(db, "weekly", now, text, plan.weekStart);
  return plan;
}

async function save(db, kind, now, text, weekStart) {
  const doc = { kind, text, createdAt: Date.now(), date: dkey(now), ...(weekStart ? { weekStart } : {}) };
  await db.put("briefs", `${kind}-${dkey(now)}`, doc);
  console.log(`[${kind} brief] ${text}`);
  return doc;
}

/** One scoped store per account (or the unowned store, before the first signup). */
async function accounts(db) {
  const users = Object.values(await db.list("users"));
  return users.length ? users.map((u) => scoped(db, u.id)) : [scoped(db, null)];
}

/** Every account gets a brief, and a notification if they subscribed a browser. */
export async function runDailyBriefs(db, now = new Date()) {
  const out = [];
  for (const store of await accounts(db)) {
    const brief = await makeDailyBrief(store, now);
    await sendPush(store, { title: "Morning brief", body: brief.text.slice(0, 300), url: "/", tag: "brief" });
    out.push(brief);
  }
  return out;
}

export async function runWeeklyPlans(db, now = new Date()) {
  const out = [];
  for (const store of await accounts(db)) {
    const plan = await makeWeeklyPlan(store, now);
    const brief = (await store.state()).briefs[0];
    await sendPush(store, { title: "Next week is planned", body: (brief && brief.text.slice(0, 300)) || `${plan.blocks.length} blocks`, url: "/", tag: "weekly" });
    out.push(plan);
  }
  return out;
}

/** Wire the jobs to the clock. Set JOBS=off to skip them (tests, or a second instance). */
export function startJobs(db, { daily = "0 7 * * 1-5", weekly = "0 20 * * 0" } = {}) {
  if (process.env.JOBS === "off") return null;
  const timezone = process.env.TZ || undefined;
  const jobs = [
    cron.schedule(daily, () => runDailyBriefs(db).catch((e) => console.error("daily job:", e.message)), { timezone }),
    cron.schedule(weekly, () => runWeeklyPlans(db).catch((e) => console.error("weekly job:", e.message)), { timezone }),
  ];
  console.log(`Scheduled: morning brief "${daily}", weekly plan "${weekly}"${timezone ? " (" + timezone + ")" : ""}`);
  return jobs;
}
