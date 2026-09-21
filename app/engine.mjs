/* Shared planning engine.
 *
 * This file runs in two places with no changes:
 *   - in the browser, inlined into the page by scripts/build.mjs
 *   - on the server, as app/engine.mjs (the build appends an export line)
 *
 * It is pure: everything it needs comes in as arguments, so the same week
 * can be planned in the page, in a test, or by the nightly job.
 */

const PILLARS = {
  class:  { label: "Classes & study" },
  belay:  { label: "Belay" },
  career: { label: "Career prep" },
  gym:    { label: "Gym" },
  meals:  { label: "Meals" },
  free:   { label: "Free time" },
  work:   { label: "Work & club" },
  other:  { label: "Other" },
};
const PKEYS = Object.keys(PILLARS);
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const COLLECTIONS = ["goals", "commitments", "events", "tasks", "plans"];
const DEFAULT_CONFIG = {
  wake: "07:30", bed: "23:30", buffer: 10, maxChunk: 120,
  meals: [
    { name: "Breakfast", from: "07:30", to: "09:30", minutes: 30 },
    { name: "Lunch", from: "11:30", to: "14:00", minutes: 45 },
    { name: "Dinner", from: "17:30", to: "20:30", minutes: 45 },
  ],
  windows: { morning: ["07:00", "12:00"], afternoon: ["12:00", "17:30"], evening: ["17:30", "23:30"] },
  rules: "", about: "",
};

/* ---------- time and date helpers ---------- */
const pad = (n) => String(n).padStart(2, "0");
function toMin(t) {
  if (typeof t === "number") return t;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || "").trim());
  return m ? (+m[1]) * 60 + (+m[2]) : NaN;
}
function hhmm(m) { m = ((Math.round(m) % 1440) + 1440) % 1440; return pad(Math.floor(m / 60)) + ":" + pad(m % 60); }
function dur(min) { min = Math.round(min); const hh = Math.floor(min / 60), mm = min % 60; return hh ? (mm ? `${hh}h ${mm}m` : `${hh}h`) : `${mm}m`; }
function dkey(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
function pdate(k) { const [y, m, d] = String(k).split("-").map(Number); return new Date(y, (m || 1) - 1, d || 1); }
function mondayOf(d) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function uid(p) { return (p || "x") + "-" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4); }
function sortBy(arr, f) { return arr.slice().sort((a, b) => { const x = f(a), y = f(b); return x < y ? -1 : x > y ? 1 : 0; }); }
const pillarOf = (p) => (PILLARS[p] ? p : "other");
const withDefaults = (config) => ({ ...DEFAULT_CONFIG, ...(config || {}) });

/** A start/end pair in minutes after midnight; an end at or before the start means it crosses midnight. */
function span(a, b) {
  const s = toMin(a); let e = toMin(b);
  if (isNaN(s) || isNaN(e)) return null;
  if (e <= s) e += 1440;
  return [s, e];
}
function dayWindow(c) {
  const wake = toMin(c.wake), bedRaw = toMin(c.bed);
  const w0 = isNaN(wake) ? 450 : wake;
  let w1 = isNaN(bedRaw) ? 1410 : bedRaw;
  if (w1 <= w0) w1 += 1440;
  return [w0, w1];
}
function windowFor(c, when) {
  const [w0, w1] = dayWindow(c);
  const win = c.windows && c.windows[when];
  if (!win) return [w0, w1];
  const sp = span(win[0], win[1]);
  return sp ? [Math.max(w0, sp[0]), Math.min(w1, sp[1])] : [w0, w1];
}
/** Where a week sits relative to now: already over, current (with today's index), or still ahead. */
function weekPosition(weekStart, now = new Date()) {
  const mon = mondayOf(now);
  const diff = Math.round((weekStart - mon) / 86400000);
  if (diff > 0) return { kind: "future", today: -1, nowMin: 0 };
  if (diff < 0) return { kind: "past", today: 7, nowMin: 0 };
  return { kind: "current", today: (now.getDay() + 6) % 7, nowMin: now.getHours() * 60 + now.getMinutes() };
}

/** Weekly commitments and one-off events, as blocks the planner must work around. */
function fixedBlocksFor(state, weekStart) {
  const out = [];
  for (const cm of Object.values(state.commitments || {})) {
    const sp = span(cm.start, cm.end); if (!sp) continue;
    for (const d of (cm.days || [])) {
      if (d < 0 || d > 6) continue;
      out.push({ d, s: sp[0], e: sp[1], title: cm.title || "Commitment", where: cm.where || "", pillar: pillarOf(cm.pillar), src: "fixed", ref: cm.id });
    }
  }
  const wk0 = dkey(weekStart), wk6 = dkey(addDays(weekStart, 6));
  for (const ev of Object.values(state.events || {})) {
    if (!ev.date || ev.date < wk0 || ev.date > wk6) continue;
    const sp = span(ev.start, ev.end); if (!sp) continue;
    const d = Math.round((pdate(ev.date) - weekStart) / 86400000);
    out.push({ d, s: sp[0], e: sp[1], title: ev.title || "Event", where: ev.where || "", pillar: pillarOf(ev.pillar), src: "fixed", ref: ev.id, oneoff: true });
  }
  return out;
}

/**
 * Lay out one week.
 *
 * @param {object}  input
 * @param {object}  input.state     {config, goals, commitments, events, tasks, plans} keyed by id
 * @param {Date}    input.weekStart the Monday of the week to plan
 * @param {object} [input.existing] the plan already saved for that week (done blocks are kept)
 * @param {Date}   [input.now]      "now", for deciding what is already in the past
 * @returns {{weekStart: string, blocks: object[], unplaced: object[], savedAt: number, by: string}}
 *
 * Order of placement, most protected first:
 *   fixed items -> meals -> protected goals -> tasks (by due date) -> remaining goals
 */
function planWeek({ state, weekStart, existing = null, now = new Date(), by = "planner" }) {
  const c = withDefaults(state.config), [W0, W1] = dayWindow(c);
  const buf = Math.max(0, +c.buffer || 0);
  const maxChunk = Math.max(30, +c.maxChunk || 120);
  const pos = weekPosition(weekStart, now);

  // When each day opens for new blocks. Past days and past hours stay untouched.
  const open = [];
  for (let d = 0; d < 7; d++) {
    if (pos.kind === "future") open[d] = W0;
    else if (pos.kind === "past" || d < pos.today) open[d] = Infinity;
    else if (d === pos.today) open[d] = Math.max(W0, Math.ceil((pos.nowMin + 10) / 15) * 15);
    else open[d] = W0;
  }

  const prev = (existing && existing.blocks) || [];
  const kept = prev.filter((b) => b.src !== "fixed" && (b.done || b.e <= open[b.d]));
  const doneFixed = new Set(prev.filter((b) => b.src === "fixed" && b.done).map((b) => b.ref + "@" + b.d));
  const blocks = [];
  const busy = [[], [], [], [], [], [], []];
  const add = (b) => { const nb = { id: b.id || uid("b"), done: false, ...b }; blocks.push(nb); busy[nb.d].push([nb.s, nb.e]); return nb; };

  for (const f of fixedBlocksFor(state, weekStart)) add({ ...f, done: doneFixed.has(f.ref + "@" + f.d) });
  for (const k of kept) add(k);

  /** First (or last, when `late`) free gap of `need` minutes on day `d` inside [lo, hi]. */
  function findSlot(d, need, lo, hi, late) {
    lo = Math.max(lo, open[d], W0); hi = Math.min(hi, W1);
    if (!(hi - lo >= need)) return null;
    const iv = busy[d].map(([s, e]) => [s - buf, e + buf]).sort((a, b) => a[0] - b[0]);
    const gaps = []; let cur = lo;
    for (const [s, e] of iv) {
      if (e <= cur) continue;
      if (s > cur) gaps.push([cur, Math.min(s, hi)]);
      cur = Math.max(cur, e);
      if (cur >= hi) break;
    }
    if (cur < hi) gaps.push([cur, hi]);
    const fits = gaps.map(([a, b]) => [Math.ceil(a / 5) * 5, Math.floor(b / 5) * 5]).filter(([a, b]) => b - a >= need);
    if (!fits.length) return null;
    if (late) { const g = fits[fits.length - 1]; return [g[1] - need, g[1]]; }
    return [fits[0][0], fits[0][0] + need];
  }
  const load = (d) => busy[d].reduce((t, [s, e]) => t + (e - s), 0);
  const openDays = () => [0, 1, 2, 3, 4, 5, 6].filter((d) => open[d] < W1);
  const unplaced = [];

  // Meals anchor the day, so they go in before anything flexible.
  for (const d of openDays()) for (const m of (c.meals || [])) {
    const sp = span(m.from, m.to), need = Math.max(10, +m.minutes || 30); if (!sp) continue;
    if (kept.some((b) => b.d === d && b.src === "meal" && b.title === m.name)) continue;
    const slot = findSlot(d, need, sp[0], sp[1], false);
    if (slot) add({ d, s: slot[0], e: slot[1], title: m.name, pillar: "meals", src: "meal", ref: "meal:" + m.name });
  }

  function placeGoal(g) {
    const need = Math.max(15, +g.minutes || 60);
    let remaining = Math.max(0, Math.round(+g.count || 0)) - blocks.filter((b) => b.ref === g.id).length;
    if (remaining <= 0) return;
    const [lo, hi] = windowFor(c, g.when || "any");
    const [alo, ahi] = windowFor(c, "any");
    const e0 = toMin(g.earliest), l0 = toMin(g.latest);
    const clampLo = isNaN(e0) ? -Infinity : e0, clampHi = isNaN(l0) ? Infinity : (l0 < W0 ? l0 + 1440 : l0);
    const allowed = openDays().filter((d) => !Array.isArray(g.days) || !g.days.length || g.days.includes(d));
    while (remaining > 0) {
      // Spread sessions out: fewest of this goal already that day, then away from
      // neighbouring days, then whichever day is least booked.
      const perDay = (d) => blocks.filter((b) => b.ref === g.id && b.d === d).length;
      const adj = (d) => perDay(d - 1) + perDay(d + 1);
      const order = sortBy(allowed, (d) => [pad(perDay(d)), pad(adj(d)), String(load(d)).padStart(5, "0"), d].join("|"));
      let placed = null;
      for (const pass of [0, 1]) {
        if (pass === 1 && g.strict) break;   // strict goals never fall outside their window
        const [a, b] = pass === 0 ? [lo, hi] : [alo, ahi];
        for (const d of order) {
          const slot = findSlot(d, need, Math.max(a, clampLo), Math.min(b, clampHi), !!g.late);
          if (slot) { placed = add({ d, s: slot[0], e: slot[1], title: g.label || "Goal", pillar: pillarOf(g.pillar), src: "goal", ref: g.id }); break; }
        }
        if (placed) break;
      }
      if (!placed) { unplaced.push({ title: g.label, why: `${remaining} of ${g.count} sessions didn't fit` }); break; }
      remaining--;
    }
  }

  const goals = sortBy(Object.values(state.goals || {}), (g) =>
    [g.protect ? 0 : 1, Array.isArray(g.days) && g.days.length ? 0 : 1, String(g.order ?? 99).padStart(3, "0")].join("|"));
  for (const g of goals.filter((g) => g.protect)) placeGoal(g);

  // Tasks: earliest due date first, split into chunks, spread across the days before the due date.
  const wk0 = dkey(weekStart), wkEnd = dkey(addDays(weekStart, 6));
  const nowPos = weekPosition(mondayOf(now), now), curKey = dkey(mondayOf(now));
  const ahead = pos.kind === "future"
    ? Object.values(state.plans || {}).filter((p) => p.weekStart >= curKey && p.weekStart < dkey(weekStart))
    : [];
  const plannedAhead = (id) => ahead.reduce((a, p) => a + (p.blocks || []).filter((b) => b.ref === id && !b.done &&
    (p.weekStart > curKey || b.d > nowPos.today || (b.d === nowPos.today && b.s >= nowPos.nowMin))).reduce((x, b) => x + (b.e - b.s), 0), 0);

  const tasks = sortBy(Object.values(state.tasks || {}).filter((t) => !t.done), (t) =>
    [t.due || "9999-12-31", t.priority || 2, String(t.createdAt || 0).padStart(15, "0")].join("|"));
  for (const t of tasks) {
    if (t.due && t.due < wk0 && pos.kind !== "current") continue;
    let left = Math.max(10, +t.minutes || 30)
      - blocks.filter((b) => b.ref === t.id).reduce((a, b) => a + (b.e - b.s), 0)
      - plannedAhead(t.id);
    if (left <= 0) continue;
    const lastDay = t.due && t.due <= wkEnd ? Math.max(0, Math.round((pdate(t.due) - weekStart) / 86400000)) : 6;
    const days = openDays();
    const before = days.filter((d) => d <= lastDay), after = days.filter((d) => d > lastDay);
    let guard = 0;
    while (left > 0 && guard++ < 20) {
      const chunk = Math.min(left, maxChunk);
      const onDay = (d) => blocks.filter((b) => b.ref === t.id && b.d === d).length;
      let placed = null;
      for (const d of [...sortBy(before, (d) => onDay(d) * 10 + d), ...after]) {
        const slot = findSlot(d, chunk, W0, W1, false);
        if (slot) { placed = add({ d, s: slot[0], e: slot[1], title: t.title, pillar: pillarOf(t.pillar), src: "task", ref: t.id, late: d > lastDay }); break; }
      }
      if (!placed) { unplaced.push({ title: t.title, why: `${dur(left)} didn't fit this week` }); break; }
      left -= chunk;
    }
  }

  for (const g of goals.filter((g) => !g.protect)) placeGoal(g);

  blocks.sort((a, b) => a.d - b.d || a.s - b.s);
  return { weekStart: dkey(weekStart), blocks, unplaced, savedAt: Date.now(), by };
}

/** Planned / done / target per goal, plus task counts and hours per area, for one week. */
function weekStats(state, plan, weekStart) {
  const blocks = (plan && plan.blocks) || [];
  const goals = sortBy(Object.values(state.goals || {}), (g) => String(g.order ?? 99).padStart(3, "0") + (g.label || ""));
  const rows = goals.map((g) => {
    const bs = blocks.filter((b) => b.ref === g.id);
    return { g, planned: bs.length, done: bs.filter((b) => b.done).length, target: Math.max(0, +g.count || 0), minutes: +g.minutes || 0 };
  });
  const wk0 = dkey(weekStart), wk6 = dkey(addDays(weekStart, 6));
  const dueThisWeek = Object.values(state.tasks || {}).filter((t) => t.due && t.due >= wk0 && t.due <= wk6);
  const hours = {};
  for (const b of blocks) hours[b.pillar] = (hours[b.pillar] || 0) + (b.e - b.s) / 60;
  return { rows, tasksDue: dueThisWeek.length, tasksDone: dueThisWeek.filter((t) => t.done).length, hours };
}

export {
  planWeek, weekStats, weekPosition, dayWindow, windowFor, span, fixedBlocksFor, withDefaults,
  PILLARS, PKEYS, DAYS, COLLECTIONS, DEFAULT_CONFIG, toMin, hhmm, dur, dkey, pdate, mondayOf, addDays, uid, sortBy, pillarOf,
};
