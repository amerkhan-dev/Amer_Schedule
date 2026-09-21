
/* ---------- Rendering ---------- */
let renderQueued = false;
function render() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => { renderQueued = false; try { renderAll(); } catch (e) { console.error(e); } }, 0);
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const md = (d) => MONTHS[d.getMonth()] + " " + d.getDate();
const CHECK_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>';

function renderAll() {
  renderHeader(); renderScore(); renderLegend(); renderPlan(); renderToday(); renderAgentSide(); renderConnections(); renderTabList();
}

function renderHeader() {
  const pos = weekPosition(S.week), end = addDays(S.week, 6);
  const rel = pos.kind === "current" ? "This week" : pos.kind === "past" ? "Past week" : (Math.round((S.week - mondayOf(new Date())) / 864e5) === 7 ? "Next week" : "Upcoming");
  $("#weekLabel").textContent = `${md(S.week)} – ${S.week.getMonth() === end.getMonth() ? end.getDate() : md(end)}`;
  $("#weekLabel").title = rel;
  $("#planTitle").textContent = rel;
  const plan = currentPlan(), btn = $("#planBtn");
  btn.disabled = pos.kind === "past" || !S.loaded;
  btn.textContent = pos.kind === "past" ? "Week is over" : plan ? (pos.kind === "current" ? "Replan rest of week" : "Replan week") : (pos.kind === "current" ? "Plan this week" : "Plan this week ahead");
  const st = $("#status");
  st.className = "status " + (S.mode === "live" || S.mode === "api" ? "live" : S.mode === "local" ? "local" : "");
  st.lastElementChild.textContent = S.mode === "live" ? "Saved to your account"
    : S.mode === "api" ? "Saved to your server"
    : S.mode === "local" ? "Local preview" : S.mode === "revoked" ? "Read-only" : "Connecting…";
  const ban = $("#banner");
  ban.hidden = S.mode !== "local";
  if (S.mode === "local") ban.textContent = "Local preview: open this page in Claude to save to your account and use Ask Claude. The rows here are examples.";
}

function renderScore() {
  const box = $("#score"); box.replaceChildren();
  const st = statsFor(currentPlan());
  if (!st.rows.length) box.append(h("div", { class: "empty" }, "No goals yet. Add them in the Goals tab below."));
  for (const r of st.rows) {
    const pct = (n) => (r.target ? Math.min(100, (n / r.target) * 100) : 0) + "%";
    box.append(h("div", { class: "goal", style: { "--c": cvar(r.g.pillar) } },
      h("div", { class: "row" },
        h("div", { class: "name" }, h("i", { class: "dot" }), h("span", { text: r.g.label || "Goal", title: r.g.label || "" })),
        h("div", { class: "num" }, String(r.done), h("small", null, " / " + r.target))),
      h("div", { class: "bar", role: "img", "aria-label": `${r.done} done, ${r.planned} planned, target ${r.target}` },
        h("i", { style: { width: pct(r.planned) } }), h("b", { style: { width: pct(r.done) } })),
      h("div", { class: "note" }, `${r.planned} planned · ${dur(r.minutes)} each${r.g.protect ? " · protected" : ""}`)));
  }
  box.append(h("div", { class: "goal", style: { "--c": "var(--ink)" } },
    h("div", { class: "row" }, h("div", { class: "name" }, h("span", { text: "Tasks due this week" })),
      h("div", { class: "num" }, String(st.tasksDone), h("small", null, " / " + st.tasksDue))),
    h("div", { class: "bar" }, h("b", { style: { width: (st.tasksDue ? (st.tasksDone / st.tasksDue) * 100 : 0) + "%" } })),
    h("div", { class: "note" }, `Sleep window ${cfg().bed ? fmt(toMin(cfg().bed)) : "?"}–${cfg().wake ? fmt(toMin(cfg().wake)) : "?"}`)));
}

function renderLegend() {
  const st = statsFor(currentPlan()), box = $("#legend"); box.replaceChildren();
  for (const p of PKEYS) {
    const hrs = st.hours[p]; if (!hrs) continue;
    box.append(h("span", { class: "chip", style: { "--c": cvar(p) } }, h("i", { class: "dot" }), `${PILLARS[p].label} ${Math.round(hrs * 10) / 10}h`));
  }
}

function layoutLanes(list) {
  const items = sortBy(list, (b) => b.s * 10000 + (b.e - b.s));
  let cluster = [], clusterEnd = -1;
  const flush = () => {
    const lanes = [];
    for (const b of cluster) {
      let i = lanes.findIndex((end) => end <= b.s);
      if (i < 0) { i = lanes.length; lanes.push(0); }
      lanes[i] = b.e; b._lane = i;
    }
    for (const b of cluster) b._lanes = lanes.length;
    cluster = [];
  };
  for (const b of items) { if (b.s >= clusterEnd && cluster.length) flush(); cluster.push(b); clusterEnd = Math.max(clusterEnd, b.e); }
  if (cluster.length) flush();
  return items;
}

function blockSub(b) {
  if (b.src === "fixed") return b.where || (b.oneoff ? "One-off event" : "Weekly schedule");
  if (b.src === "task") return "Task" + (b.late ? " · after due date" : "");
  if (b.src === "goal") return "Goal";
  if (b.src === "meal") return "Meal";
  return "";
}

function renderPlan() {
  const plan = currentPlan(), blocks = (plan && plan.blocks) || [], c = cfg(), [W0, W1] = dayWindow(c);
  const pos = weekPosition(S.week);
  $("#planMeta").replaceChildren();
  if (plan) {
    const t = new Date(plan.savedAt || Date.now());
    const who = plan.by === "claude" ? "Claude" : plan.by === "autopilot" ? "Sunday autopilot" : "the planner";
    $("#planMeta").append(`Planned by ${who} · ${DAYS[(t.getDay() + 6) % 7]} ${fmt(t.getHours() * 60 + t.getMinutes())}`);
    if (plan.unplaced && plan.unplaced.length) {
      const det = h("details", { style: { marginTop: "4px" } }, h("summary", { style: { cursor: "pointer", color: "var(--warn)" } }, `${plan.unplaced.length} didn't fit`),
        h("ul", { style: { margin: "4px 0 0", paddingLeft: "18px" } }, plan.unplaced.map((u) => h("li", null, `${u.title}: ${u.why}`))));
      $("#planMeta").append(det);
    }
  } else $("#planMeta").append(pos.kind === "past" ? "No plan was saved for this week." : "No plan yet. Press the plan button to lay out the week.");

  // Desktop grid
  let lo = W0, hi = W1;
  for (const b of blocks) { lo = Math.min(lo, b.s); hi = Math.max(hi, b.e); }
  lo = Math.floor(lo / 60) * 60; hi = Math.ceil(hi / 60) * 60;
  const PX = 0.8, H = (hi - lo) * PX;
  const grid = h("div", { class: "week", style: { "--hour": 60 * PX + "px" } });
  grid.append(h("div", { class: "whead" }));
  for (let d = 0; d < 7; d++) {
    const date = addDays(S.week, d), isToday = pos.kind === "current" && d === pos.today;
    const mins = blocks.filter((b) => b.d === d && b.src !== "meal").reduce((a, b) => a + (b.e - b.s), 0);
    grid.append(h("div", { class: "whead" + (isToday ? " today" : "") },
      h("div", { class: "d" }, DAYS[d] + " " + date.getDate()), h("div", { class: "load" }, mins ? dur(mins) + " booked" : "open")));
  }
  const tcol = h("div", { class: "tcol", style: { height: H + "px" } });
  for (let m = lo + 60; m < hi; m += 60) tcol.append(h("div", { class: "tick", style: { top: (m - lo) * PX + "px" } }, fmt(m)));
  grid.append(tcol);
  for (let d = 0; d < 7; d++) {
    const isToday = pos.kind === "current" && d === pos.today;
    const col = h("div", { class: "dcol" + (isToday ? " today" : ""), style: { height: H + "px" } });
    for (const b of layoutLanes(blocks.filter((x) => x.d === d))) {
      const top = (b.s - lo) * PX, ht = Math.max(14, (b.e - b.s) * PX - 2);
      const w = 100 / b._lanes;
      const el = h("button", {
        class: "blk" + (b.src === "fixed" ? " fixed" : "") + (b.done ? " done" : "") + (ht < 30 ? " tiny" : ""),
        style: { top: top + "px", height: ht + "px", "--c": cvar(b.pillar), left: `calc(${b._lane * w}% + 3px)`, width: `calc(${w}% - 6px)`, right: "auto" },
        title: `${b.title} · ${fmtRange(b.s, b.e)}`, onclick: (ev) => openBlock(b, ev.currentTarget),
      }, h("span", { class: "t" }, b.title), h("span", { class: "tm" }, fmtRange(b.s, b.e)));
      col.append(el);
    }
    if (isToday && pos.nowMin >= lo && pos.nowMin <= hi) col.append(h("div", { class: "nowline", style: { top: (pos.nowMin - lo) * PX + "px" } }));
    grid.append(col);
  }
  $("#gridWrap").replaceChildren(grid);

  // Phone: day tabs + agenda
  const tabs = $("#dayTabs"); tabs.replaceChildren();
  for (let d = 0; d < 7; d++) {
    tabs.append(h("button", { class: "btn small", "aria-pressed": String(S.day === d), onclick: () => { S.day = d; render(); } }, DAYS[d] + " " + addDays(S.week, d).getDate()));
  }
  $("#mobileAgenda").replaceChildren(agendaList(plan, S.week, S.day, "Nothing planned this day."));
}

function agendaList(plan, weekStart, d, emptyText) {
  const blocks = sortBy(((plan && plan.blocks) || []).filter((b) => b.d === d), (b) => b.s);
  const list = h("div", { class: "agenda" });
  if (!blocks.length) { list.append(h("div", { class: "empty" }, emptyText)); return list; }
  for (const b of blocks) {
    const chk = h("button", { class: "check", "aria-pressed": String(!!b.done), "aria-label": (b.done ? "Mark not done: " : "Mark done: ") + b.title, onclick: () => toggleDone(plan, b) });
    chk.innerHTML = CHECK_SVG;
    list.append(h("div", { class: "item" + (b.done ? " done" : ""), style: { "--c": cvar(b.pillar) } },
      chk, h("div", { class: "what" }, b.title, h("small", null, blockSub(b))), h("div", { class: "when" }, fmtRange(b.s, b.e))));
  }
  return list;
}

function renderToday() {
  const now = new Date(), mon = mondayOf(now), plan = S.plans[dkey(mon)] || null, d = (now.getDay() + 6) % 7;
  $("#todayTitle").textContent = "Today · " + DAYS[d] + " " + md(now);
  const blocks = ((plan && plan.blocks) || []).filter((b) => b.d === d);
  $("#todayMeta").textContent = blocks.length ? `${blocks.filter((b) => b.done).length}/${blocks.length} done` : "";
  $("#todayList").replaceChildren(agendaList(plan, mon, d, plan ? "Nothing else planned today." : "Plan this week to fill in today."));
}

async function toggleDone(plan, b) {
  if (!plan) return;
  const blocks = plan.blocks.map((x) => (x.id === b.id ? { ...x, done: !x.done } : x));
  await Store.write("plans", plan.weekStart, { ...plan, blocks });
}

/* ---------- Block popover ---------- */
function closePop() { $("#pop").hidden = true; }
function openBlock(b, anchor) {
  const plan = currentPlan(); if (!plan) return;
  const pop = $("#pop"); pop.replaceChildren();
  const date = addDays(S.week, b.d);
  pop.append(
    h("div", null, h("span", { class: "chip", style: { "--c": cvar(b.pillar) } }, h("i", { class: "dot" }), PILLARS[pillarOf(b.pillar)].label)),
    h("h3", null, b.title),
    h("div", { class: "small muted" }, `${DAYS[b.d]} ${md(date)} · ${fmtRange(b.s, b.e)} · ${blockSub(b)}`));
  const acts = h("div", { class: "acts" });
  acts.append(h("button", { class: "btn small primary", onclick: () => { toggleDone(plan, b); closePop(); } }, b.done ? "Mark not done" : "Mark done"));
  if (b.src === "task" && S.tasks[b.ref] && !S.tasks[b.ref].done) {
    acts.append(h("button", { class: "btn small", onclick: async () => {
      closePop();
      await Store.write("tasks", b.ref, { ...S.tasks[b.ref], done: true, doneAt: Date.now() });
      const blocks = plan.blocks.map((x) => (x.ref === b.ref && x.d >= b.d ? { ...x, done: x.id === b.id ? true : x.done } : x)).filter((x) => !(x.ref === b.ref && !x.done && x.id !== b.id));
      await Store.write("plans", plan.weekStart, { ...plan, blocks });
      toast("Task completed");
    } }, "Complete task"));
  }
  if (b.src !== "fixed") acts.append(h("button", { class: "btn small ghost", onclick: async () => {
    closePop();
    await Store.write("plans", plan.weekStart, { ...plan, blocks: plan.blocks.filter((x) => x.id !== b.id) });
    toast("Removed from plan");
  } }, "Remove"));
  acts.append(h("button", { class: "btn small ghost", onclick: closePop }, "Close"));
  pop.append(acts);
  pop.hidden = false;
  const r = anchor.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight;
  let x = Math.min(window.innerWidth - pw - 16, Math.max(16, r.left));
  let y = r.bottom + 6; if (y + ph > window.innerHeight - 16) y = Math.max(16, r.top - ph - 6);
  pop.style.left = x + "px"; pop.style.top = y + "px";
  pop.querySelector("button").focus();
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePop(); });
document.addEventListener("click", (e) => { const p = $("#pop"); if (!p.hidden && !p.contains(e.target) && !e.target.closest(".blk")) closePop(); });
