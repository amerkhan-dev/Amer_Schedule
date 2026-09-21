
/* ---------- Claude: proposes changes, Amer approves ---------- */
const OP_DOCS = `Op shapes (P = one of class, belay, career, gym, meals, free, work, other):
{"op":"addTask","title":str,"pillar":P,"minutes":int,"due":"YYYY-MM-DD" or null,"priority":1|2|3}
{"op":"updateTask","id":str, ...any of title,pillar,minutes,due,priority}
{"op":"completeTask","id":str}   {"op":"deleteTask","id":str}
{"op":"addEvent","title":str,"pillar":P,"date":"YYYY-MM-DD","start":"HH:MM","end":"HH:MM","where":str}
{"op":"updateEvent","id":str, ...fields}   {"op":"deleteEvent","id":str}
{"op":"addCommitment","title":str,"pillar":P,"days":[0-6],"start":"HH:MM","end":"HH:MM","where":str}
{"op":"updateCommitment","id":str, ...fields}   {"op":"deleteCommitment","id":str}
{"op":"addGoal","label":str,"pillar":P,"count":int,"minutes":int,"when":"morning"|"afternoon"|"evening"|"any","days":[0-6] or [],"protect":bool,"earliest":"HH:MM" or null,"latest":"HH:MM" or null}
{"op":"updateGoal","id":str, ...fields}   {"op":"deleteGoal","id":str}
{"op":"updateRules", ...any of wake,bed,rules,about,buffer}`;

function planSummary(plan) {
  if (!plan) return "No plan saved for this week yet.";
  const out = [];
  for (let d = 0; d < 7; d++) {
    const bs = sortBy(plan.blocks.filter((b) => b.d === d), (b) => b.s);
    if (bs.length) out.push(`${DAYS[d]}: ` + bs.map((b) => `${hhmm(b.s)}-${hhmm(b.e)} ${b.title}${b.done ? " (done)" : ""}`).join("; "));
  }
  if (plan.unplaced && plan.unplaced.length) out.push("Didn't fit: " + plan.unplaced.map((u) => `${u.title} (${u.why})`).join("; "));
  return out.join("\n").slice(0, 9000);
}
function contextJSON() {
  const c = cfg(), now = new Date(), soon = dkey(addDays(now, 45)), today = dkey(now);
  const strip = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] != null && o[k] !== "").map((k) => [k, o[k]]));
  return JSON.stringify({
    config: strip(c, ["wake", "bed", "buffer", "rules", "about", "meals", "windows"]),
    goals: Object.values(S.goals).map((g) => strip(g, ["id", "label", "pillar", "count", "minutes", "when", "days", "protect", "earliest", "latest"])),
    weeklySchedule: Object.values(S.commitments).map((x) => strip(x, ["id", "title", "pillar", "days", "start", "end", "where"])),
    events: Object.values(S.events).filter((e) => e.date >= today && e.date <= soon).map((x) => strip(x, ["id", "title", "pillar", "date", "start", "end", "where"])),
    openTasks: Object.values(S.tasks).filter((t) => !t.done).map((x) => strip(x, ["id", "title", "pillar", "minutes", "due", "priority"])),
    progressThisWeek: statsFor(currentPlan()).rows.map((r) => ({ goal: r.g.label, done: r.done, planned: r.planned, target: r.target })),
  });
}
function buildPrompt(message) {
  const now = new Date();
  return `You are the planning assistant inside "Amer OS", Amer Khan's weekly planner. Amer is a UConn computer science sophomore on a full ride who is building a startup (Belay), works as a TA and campus IT technician, prepares for Summer 2027 internships, lifts, and wants protected free time.

How the app works: you only PROPOSE changes to the planner's inputs; Amer approves them. A deterministic planner then lays out the week: weekly schedule + one-off events are fixed, then meals, then protected goals, then tasks (earliest due date first), then other goals. So change inputs (tasks, events, weekly schedule, goals, rules). Do not try to place individual time blocks.

Now: ${DAYS[(now.getDay() + 6) % 7]} ${dkey(now)} ${hhmm(now.getHours() * 60 + now.getMinutes())}. The week being viewed starts ${weekKey()}. In "days" arrays 0=Mon ... 6=Sun. Times are 24-hour "HH:MM". Dates are "YYYY-MM-DD".

Be a sharp, realistic chief of staff: protect sleep, meals and free time; flag overload and say what to cut; keep deadlines safe. If something is ambiguous (like an unknown time), make a sensible assumption and say so. Use existing ids for update, complete and delete ops. Propose only the ops that are needed. The "reply" speaks to Amer as "you", in plain language, under 120 words.

Planner data:
${contextJSON()}

This week's current plan:
${planSummary(currentPlan())}

Amer says: ${JSON.stringify(message)}

Reply with ONLY a JSON object: {"reply": string, "ops": [ ... ], "replan": boolean}. Set "replan" true when the week should be re-laid-out after the ops.
${OP_DOCS}`;
}

const T = (v) => (/^\d{1,2}:\d{2}$/.test(String(v || "")) ? hhmm(toMin(v)) : null);
const D = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : null);
function cleanFields(o, kind) {
  const out = {};
  const str = (k) => { if (o[k] != null && String(o[k]).trim()) out[k] = String(o[k]).trim().slice(0, 160); };
  const num = (k, lo, hi) => { if (o[k] != null && isFinite(+o[k])) out[k] = Math.min(hi, Math.max(lo, Math.round(+o[k]))); };
  str("title"); str("label"); str("where");
  if (o.pillar != null) out.pillar = pillarOf(String(o.pillar));
  num("minutes", 5, 600); num("count", 0, 21); num("priority", 1, 3); num("buffer", 0, 60);
  for (const k of ["start", "end", "earliest", "latest", "wake", "bed"]) if (o[k] !== undefined) { const t = T(o[k]); if (t) out[k] = t; else if (o[k] === null) out[k] = null; }
  for (const k of ["due", "date"]) if (o[k] !== undefined) { const d = D(o[k]); if (d) out[k] = d; else if (o[k] === null && k === "due") out[k] = ""; }
  if (Array.isArray(o.days)) out.days = [...new Set(o.days.map(Number).filter((d) => d >= 0 && d <= 6))];
  if (o.when && WHEN.some((w) => w[0] === o.when)) out.when = o.when;
  if (typeof o.protect === "boolean") out.protect = o.protect;
  if (kind === "rules") { if (typeof o.rules === "string") out.rules = o.rules.slice(0, 4000); if (typeof o.about === "string") out.about = o.about.slice(0, 2000); }
  return out;
}
const OP_COLL = { Task: "tasks", Event: "events", Commitment: "commitments", Goal: "goals" };
function normalizeOps(raw) {
  const ops = [];
  for (const o of Array.isArray(raw) ? raw : []) {
    if (!o || typeof o.op !== "string") continue;
    const m = /^(add|update|delete|complete)(Task|Event|Commitment|Goal)$/.exec(o.op);
    if (o.op === "updateRules") { ops.push({ op: "updateRules", f: cleanFields(o, "rules") }); continue; }
    if (!m) continue;
    const [, verb, kind] = m, coll = OP_COLL[kind];
    if (verb === "complete" && kind !== "Task") continue;
    const f = cleanFields(o, kind);
    if (verb !== "add") { if (!o.id || !S[coll][o.id]) continue; ops.push({ op: o.op, verb, coll, id: String(o.id), f }); continue; }
    if (kind === "Task" && !f.title) continue;
    if (kind === "Goal" && !f.label) continue;
    if (kind === "Event" && !(f.title && f.date && f.start && f.end)) continue;
    if (kind === "Commitment" && !(f.title && f.days && f.days.length && f.start && f.end)) continue;
    ops.push({ op: o.op, verb, coll, f });
  }
  return ops;
}
function describeOp(o) {
  const f = o.f || {}, P = (p) => (p ? PILLARS[pillarOf(p)].label : "");
  const bits = (arr) => arr.filter(Boolean).join(", ");
  if (o.op === "updateRules") return "Update rules: " + Object.keys(f).map((k) => (k === "rules" || k === "about" ? k : `${k} → ${f[k]}`)).join(", ");
  const cur = o.id ? S[o.coll][o.id] || {} : {};
  const name = f.title || f.label || cur.title || cur.label || "item";
  const when = f.date ? `${md(pdate(f.date))}` : "";
  const time = f.start && f.end ? fmtRange(toMin(f.start), toMin(f.end)) : "";
  const days = f.days && f.days.length ? f.days.map((d) => DAYS[d]).join(" ") : "";
  const noun = { tasks: "task", events: "event", commitments: "weekly item", goals: "goal" }[o.coll];
  if (o.verb === "add") return `Add ${noun}: ${name} (${bits([P(f.pillar), f.minutes && o.coll === "tasks" ? dur(f.minutes) : "", f.due ? "due " + md(pdate(f.due)) : "", when, days, time, f.count ? `${f.count}× ${dur(f.minutes || 60)}` : ""])})`;
  if (o.verb === "delete") return `Remove ${noun}: ${name}`;
  if (o.verb === "complete") return `Mark done: ${name}`;
  const ch = Object.entries(f).filter(([k]) => k !== "title" || f.title !== cur.title).map(([k, v]) => `${k} → ${Array.isArray(v) ? v.map((d) => DAYS[d]).join(" ") : v}`);
  return `Change ${noun} "${cur.title || cur.label || name}": ${ch.join(", ") || "no changes"}`;
}
async function applyOps(ops) {
  let n = 0;
  for (const o of ops) {
    if (o.op === "updateRules") { await Store.write("config", "main", { ...cfg(), ...o.f }); n++; continue; }
    if (o.verb === "add") {
      const base = { createdAt: Date.now() };
      if (o.coll === "tasks") Object.assign(base, { done: false, priority: 2, minutes: 60, pillar: "other" });
      if (o.coll === "goals") Object.assign(base, { order: Object.keys(S.goals).length + 1, when: "any", count: 1, minutes: 60 });
      await Store.write(o.coll, uid(o.coll.slice(0, 1)), { ...base, ...o.f }); n++;
    } else if (o.verb === "delete") { await Store.remove(o.coll, o.id); n++; }
    else if (o.verb === "complete") { await Store.write("tasks", o.id, { ...S.tasks[o.id], done: true, doneAt: Date.now() }); n++; }
    else if (S[o.coll][o.id]) { const next = { ...S[o.coll][o.id], ...o.f }; for (const k of Object.keys(next)) if (next[k] === null) delete next[k]; await Store.write(o.coll, o.id, next); n++; }
  }
  return n;
}
async function replanWeek(weekStart) {
  if (weekPosition(weekStart).kind === "past") return;
  const plan = buildPlan(weekStart, S.plans[dkey(weekStart)] || null);
  await Store.write("plans", plan.weekStart, plan);
  return plan;
}

function opsChecklist(ops, onApply, applyLabel) {
  const wrap = h("div", { class: "ops" });
  if (!ops.length) return wrap;
  const boxes = ops.map((o, i) => {
    const cb = h("input", { type: "checkbox", id: `op-${Date.now().toString(36)}-${i}`, checked: true });
    wrap.append(h("label", { class: "op", for: cb.id }, cb, h("span", null, describeOp(o))));
    return cb;
  });
  const btn = h("button", { class: "btn primary", style: { justifySelf: "start" }, onclick: async () => {
    btn.disabled = true;
    const chosen = ops.filter((_, i) => boxes[i].checked);
    try { await onApply(chosen); } finally { btn.disabled = false; }
  } }, applyLabel);
  wrap.append(btn);
  return wrap;
}

/* Models sometimes wrap JSON in prose or a code fence; take the JSON out. */
function parseLooseJson(text) {
  const tryParse = (x) => { try { return JSON.parse(x); } catch (_) { return undefined; } };
  let v = tryParse(text);
  if (v !== undefined) return v;
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fence && (v = tryParse(fence[1].trim())) !== undefined) return v;
  const starts = [text.indexOf("{"), text.indexOf("[")].filter((i) => i >= 0);
  const start = starts.length ? Math.min(...starts) : -1;
  const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (start >= 0 && end > start && (v = tryParse(text.slice(start, end + 1))) !== undefined) return v;
  throw { code: "invalid_json", message: "Claude's reply was not JSON", text };
}

/* When the backend serves the page, Ask Claude goes through /api/ask. */
function serverSample() {
  return {
    json: async (prompt, opts = {}) => {
      const { text } = await Store.apiFetch("/ask", { method: "POST", body: { prompt }, signal: opts.signal });
      return parseLooseJson(String(text || ""));
    },
  };
}

let sampleFn = null, askCtl = null;
async function ask(message) {
  if (!sampleFn) { toast(S.mode === "local" ? "Open this page in Claude to use Ask Claude." : "Ask Claude isn't available here."); return; }
  const out = $("#agentOut"), opsBox = $("#agentOps"), askBtn = $("#askBtn"), stop = $("#stopBtn");
  out.hidden = false; out.textContent = "Thinking…"; opsBox.replaceChildren();
  askBtn.disabled = true; $("#reviewBtn").disabled = true; stop.hidden = false;
  askCtl = new AbortController();
  const t0 = Date.now(), tick = setInterval(() => { if (out.textContent.startsWith("Thinking")) out.textContent = `Thinking… ${Math.round((Date.now() - t0) / 1000)}s`; }, 1000);
  try {
    const res = await sampleFn.json(buildPrompt(message), { signal: askCtl.signal, cache: false });
    const ops = normalizeOps(res && res.ops);
    out.textContent = (res && typeof res.reply === "string" && res.reply.trim()) || (ops.length ? "Here's what I'd change." : "No changes needed.");
    if (ops.length) opsBox.replaceChildren(opsChecklist(ops, async (chosen) => {
      const n = await applyOps(chosen);
      if ((res.replan || n) && weekPosition(S.week).kind !== "past") await replanWeek(S.week);
      opsBox.replaceChildren(); $("#agentInput").value = "";
      toast(`Applied ${n} change${n === 1 ? "" : "s"}${weekPosition(S.week).kind !== "past" ? " and replanned" : ""}`);
    }, "Apply and replan"));
  } catch (e) {
    const code = e && e.code;
    if (code === "cancelled") out.textContent = "Stopped.";
    else if (["not_granted", "sampling_disabled", "not_declared", "capability_disabled", "capability_removed"].includes(code)) { out.textContent = "Ask Claude is turned off for this page. You can still plan and edit everything by hand."; sampleFn = null; }
    else if (code === "rate_limited") out.textContent = "Too many requests right now. Try again in a minute.";
    else if (code === "invalid_json") out.textContent = "Claude's answer came back in the wrong format. Try again, or ask for fewer changes at once.";
    else if (code === "prompt_too_large") out.textContent = "There's too much planner data to send at once. Clear out old tasks and try again.";
    else if (code === "session_expired") out.textContent = "Sign in to Claude again, then retry.";
    else if (code === "http_503") out.textContent = "Ask Claude is off on your server. Set ANTHROPIC_API_KEY and restart it.";
    else if (code === "unauthorized") out.textContent = "Your access key was rejected. Reload the page and enter it again.";
    else out.textContent = "Couldn't reach Claude. Try again.";
  } finally {
    clearInterval(tick); askBtn.disabled = false; $("#reviewBtn").disabled = false; stop.hidden = true; askCtl = null;
  }
}

function renderAgentSide() {
  const bb = $("#briefBox"), brief = S.briefs[0];
  const fresh = brief && Date.now() - (brief.createdAt || 0) < 3 * 864e5;
  bb.hidden = !fresh;
  if (fresh) {
    const t = new Date(brief.createdAt);
    bb.replaceChildren(h("div", { class: "eyebrow", style: { marginBottom: "6px" } }, `${brief.kind === "weekly" ? "Sunday plan" : "Morning brief"} · ${DAYS[(t.getDay() + 6) % 7]} ${md(t)}`),
      h("div", { class: "brief" }, String(brief.text || "")));
  }
  const pb = $("#proposalBox"), p = S.proposals[0];
  pb.hidden = !p;
  if (p) {
    const ops = normalizeOps(p.ops);
    const setStatus = async (status) => {
      S.proposals = S.proposals.filter((x) => x.id !== p.id); render();
      const { id, ...rest } = p;
      await Store.setRaw("proposals/" + id, { ...rest, status, decidedAt: Date.now() });
    };
    pb.replaceChildren(
      h("div", { class: "eyebrow", style: { marginBottom: "6px" } }, "Suggested by autopilot"),
      h("div", { class: "agent-out" }, String(p.summary || "Suggested changes")),
      opsChecklist(ops, async (chosen) => {
        const n = await applyOps(chosen);
        const wk = p.weekStart && D(p.weekStart) ? mondayOf(pdate(p.weekStart)) : S.week;
        await replanWeek(wk);
        await setStatus("applied");
        toast(`Applied ${n} change${n === 1 ? "" : "s"} and planned the week`);
      }, ops.length ? "Apply and plan week" : "Plan week"),
      h("button", { class: "btn small ghost", style: { marginTop: "6px" }, onclick: () => setStatus("dismissed") }, "Dismiss"));
  }
}

/* ---------- Boot ---------- */
const EXAMPLES = [
  "Add my weekly classes: CSE 2050 MWF 10:10–11:00",
  "My midterm moved to Thursday 2pm. I need 4 hours of prep.",
  "I'm wiped today. Lighten today and move what matters.",
  "Add 5 internship applications this week",
];
function boot() {
  $("#prevWeek").onclick = () => { S.week = addDays(S.week, -7); render(); };
  $("#nextWeek").onclick = () => { S.week = addDays(S.week, 7); render(); };
  $("#thisWeek").onclick = () => { S.week = mondayOf(new Date()); S.day = (new Date().getDay() + 6) % 7; render(); };
  $("#planBtn").onclick = async () => {
    const btn = $("#planBtn"); btn.disabled = true;
    try { const p = await replanWeek(S.week); if (p) toast(p.unplaced.length ? `Planned. ${p.unplaced.length} item${p.unplaced.length === 1 ? "" : "s"} didn't fit.` : "Week planned"); }
    finally { btn.disabled = false; render(); }
  };
  for (const b of document.querySelectorAll("#tabs button")) b.onclick = () => setTab(b.dataset.tab);
  const ex = $("#examples");
  for (const e of EXAMPLES) ex.append(h("button", { type: "button", onclick: () => { $("#agentInput").value = e; $("#agentInput").focus(); } }, e));
  $("#askBtn").onclick = () => { const v = $("#agentInput").value.trim(); if (!v) { toast("Type what changed first"); $("#agentInput").focus(); return; } ask(v); };
  $("#agentInput").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) $("#askBtn").click(); });
  $("#stopBtn").onclick = () => askCtl && askCtl.abort();
  $("#reviewBtn").onclick = () => ask("Review my plan for the week I'm viewing against my goals and rules. Call out the biggest risks (overload, sleep, deadlines, missing free time) and propose the few changes that matter most.");
  initAccount();
  setTab("tasks");
  render();
  Store.init().then(() => render());
  (async () => {
    try { sampleFn = window.claude && typeof window.claude.use === "function" ? await window.claude.use("sample") : null; } catch (_) { sampleFn = null; }
    if (!sampleFn && Store.api) {
      const health = await fetch(Store.api + "/health").then((r) => r.json()).catch(() => null);
      if (health && health.ask) sampleFn = serverSample();
    }
    $("#agentState").textContent = sampleFn ? "Proposes changes for you to approve" : "Available when opened in Claude";
  })();
  setInterval(render, 60000);
}
