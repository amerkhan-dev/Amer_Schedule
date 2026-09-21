
/* ---------- Setup tabs ---------- */
const PRIORITY = [[1, "High"], [2, "Normal"], [3, "Low"]];
const WHEN = [["morning", "Morning"], ["afternoon", "Afternoon"], ["evening", "Evening"], ["any", "Any time"]];
const SPECS = {
  tasks: { coll: "tasks", noun: "task", fields: [
    { k: "title", label: "Task", type: "text", wide: true, req: true, ph: "e.g. Apply to Jane Street SWE intern" },
    { k: "pillar", label: "Area", type: "pillar", def: "belay" },
    { k: "minutes", label: "Time needed (min)", type: "number", def: 60 },
    { k: "due", label: "Due", type: "date" },
    { k: "priority", label: "Priority", type: "select", options: PRIORITY, def: 2, num: true }] },
  events: { coll: "events", noun: "event", fields: [
    { k: "title", label: "Event", type: "text", wide: true, req: true, ph: "e.g. Meeting with Aziz, CSE midterm" },
    { k: "pillar", label: "Area", type: "pillar", def: "other" },
    { k: "date", label: "Date", type: "date", req: true },
    { k: "start", label: "Start", type: "time", req: true },
    { k: "end", label: "End", type: "time", req: true },
    { k: "where", label: "Where", type: "text" }] },
  commitments: { coll: "commitments", noun: "weekly item", fields: [
    { k: "title", label: "Class, shift or meeting", type: "text", wide: true, req: true, ph: "e.g. CSE 2050 lecture, CSE 1010 lab (TA), ITS shift" },
    { k: "pillar", label: "Area", type: "pillar", def: "class" },
    { k: "days", label: "Days", type: "days", wide: true, req: true },
    { k: "start", label: "Start", type: "time", req: true },
    { k: "end", label: "End", type: "time", req: true },
    { k: "where", label: "Where", type: "text" }] },
  goals: { coll: "goals", noun: "goal", fields: [
    { k: "label", label: "Goal", type: "text", wide: true, req: true, ph: "e.g. LeetCode, Lift, Belay deep work" },
    { k: "pillar", label: "Area", type: "pillar", def: "career" },
    { k: "count", label: "Sessions per week", type: "number", def: 3 },
    { k: "minutes", label: "Minutes each", type: "number", def: 60 },
    { k: "when", label: "Best time", type: "select", options: WHEN, def: "any" },
    { k: "days", label: "Only on (optional)", type: "days", wide: true },
    { k: "earliest", label: "Not before (optional)", type: "time" },
    { k: "latest", label: "Not after (optional)", type: "time" },
    { k: "protect", label: "Protect (schedule before tasks)", type: "check" },
    { k: "late", label: "Place late in the day", type: "check" }] },
};

function setTab(tab) {
  S.tab = tab;
  for (const b of document.querySelectorAll("#tabs button")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  const body = $("#tabBody"); body.replaceChildren();
  if (tab === "rules") { body.append(rulesForm()); return; }
  const spec = SPECS[tab];
  body.append(h("div", { class: "list", id: "tabList" }), buildForm(tab, spec));
  resetForm(tab);
  renderTabList();
}

function metaFor(tab, it) {
  const bits = [];
  if (tab === "tasks") {
    bits.push(dur(+it.minutes || 30));
    if (it.due) { const late = !it.done && it.due < dkey(new Date()); bits.push((late ? "Overdue · " : "Due ") + md(pdate(it.due))); }
    bits.push((PRIORITY.find((p) => p[0] === +it.priority) || PRIORITY[1])[1] + " priority");
  } else if (tab === "events") {
    bits.push(`${DAYS[(pdate(it.date).getDay() + 6) % 7]} ${md(pdate(it.date))}`, fmtRange(toMin(it.start), toMin(it.end)));
    if (it.where) bits.push(it.where);
  } else if (tab === "commitments") {
    bits.push((it.days || []).slice().sort().map((d) => DAYS[d]).join(" "), fmtRange(toMin(it.start), toMin(it.end)));
    if (it.where) bits.push(it.where);
  } else if (tab === "goals") {
    bits.push(`${it.count}× ${dur(+it.minutes || 60)} / week`, (WHEN.find((w) => w[0] === it.when) || WHEN[3])[1].toLowerCase());
    if (it.days && it.days.length) bits.push("only " + it.days.map((d) => DAYS[d]).join(" "));
    if (it.latest) bits.push("not after " + fmt(toMin(it.latest)));
    if (it.protect) bits.push("protected");
  }
  return bits.join(" · ");
}

function renderTabList() {
  if (S.tab === "rules") {
    const f = $("#rulesForm");
    if (f && !f.contains(document.activeElement) && !f.dataset.dirty) setTab("rules");
    return;
  }
  const box = $("#tabList"); if (!box) return;
  const spec = SPECS[S.tab]; box.replaceChildren();
  let items = Object.values(S[spec.coll]);
  if (S.tab === "tasks") {
    const open = sortBy(items.filter((t) => !t.done), (t) => (t.due || "9999") + (t.priority || 2));
    const done = sortBy(items.filter((t) => t.done), (t) => -(t.doneAt || 0)).slice(0, 8);
    items = [...open, ...done];
  } else if (S.tab === "events") {
    const today = dkey(new Date());
    items = sortBy(items.filter((e) => (e.date || "") >= today), (e) => e.date + e.start);
  } else if (S.tab === "commitments") items = sortBy(items, (c) => (Math.min(...(c.days || [9])) + "|" + c.start));
  else items = sortBy(items, (g) => String(g.order ?? 99).padStart(3, "0"));
  if (!items.length) box.append(h("div", { class: "empty" }, `No ${spec.noun}s yet. Add one below, or tell Claude.`));
  for (const it of items) {
    const title = it.title || it.label;
    const first = S.tab === "tasks"
      ? (() => { const c = h("button", { class: "check", style: { "--c": cvar(it.pillar) }, "aria-pressed": String(!!it.done), "aria-label": (it.done ? "Reopen: " : "Complete: ") + title,
          onclick: () => Store.write("tasks", it.id, { ...it, done: !it.done, doneAt: it.done ? null : Date.now() }) }); c.innerHTML = CHECK_SVG; return c; })()
      : h("i", { class: "dot", style: { "--c": cvar(it.pillar) } });
    box.append(h("div", { class: "row-item" + (it.done ? " done" : "") },
      first,
      h("div", { style: { minWidth: 0 } }, h("div", { class: "ttl", style: { fontWeight: 600 } }, title),
        h("div", { class: "meta" }, PILLARS[pillarOf(it.pillar)].label + " · " + metaFor(S.tab, it))),
      h("div", { style: { display: "flex", gap: "4px" } },
        h("button", { class: "btn small ghost", onclick: () => editItem(S.tab, it) }, "Edit"),
        h("button", { class: "btn small ghost", "aria-label": "Delete " + title, onclick: () => { Store.remove(spec.coll, it.id); toast("Deleted"); } }, "Delete"))));
  }
}

function fieldInput(tab, f) {
  const id = `f-${tab}-${f.k}`;
  if (f.type === "pillar" || f.type === "select") {
    const opts = f.type === "pillar" ? PKEYS.map((p) => [p, PILLARS[p].label]) : f.options;
    return h("select", { id }, opts.map(([v, l]) => h("option", { value: v }, l)));
  }
  if (f.type === "days") return h("div", { class: "days", id }, DAYS.map((d, i) => h("label", null, h("input", { type: "checkbox", value: String(i), id: `${id}-${i}` }), d)));
  if (f.type === "check") return h("input", { type: "checkbox", id });
  return h("input", { type: f.type, id, placeholder: f.ph || null, min: f.type === "number" ? "0" : null });
}

function buildForm(tab, spec) {
  const form = h("form", { class: "form", id: `form-${tab}`, novalidate: true });
  for (const f of spec.fields) {
    const inp = fieldInput(tab, f);
    if (f.type === "check") form.append(h("label", { class: "f", style: { display: "flex", alignItems: "center", gap: "6px", color: "var(--ink)" } }, inp, f.label));
    else if (f.type === "days") form.append(h("div", { class: "f label-like" + (f.wide ? " wide" : ""), role: "group", "aria-label": f.label }, h("span", null, f.label), inp));
    else form.append(h("label", { class: "f" + (f.wide ? " wide" : ""), for: inp.id }, f.label, inp));
  }
  const submit = h("button", { class: "btn primary", type: "submit", id: `f-${tab}-submit` }, "Add " + spec.noun);
  const cancel = h("button", { class: "btn ghost", type: "button", id: `f-${tab}-cancel`, hidden: true, onclick: () => resetForm(tab) }, "Cancel");
  form.append(h("div", { style: { display: "flex", gap: "6px", alignItems: "end" } }, submit, cancel));
  form.addEventListener("submit", (e) => { e.preventDefault(); submitForm(tab); });
  return form;
}

function readField(tab, f) {
  const id = `f-${tab}-${f.k}`, el = document.getElementById(id);
  if (!el) return undefined;
  if (f.type === "days") return [...el.querySelectorAll("input:checked")].map((x) => +x.value);
  if (f.type === "check") return el.checked;
  if (f.type === "number") return el.value === "" ? f.def : Math.max(0, +el.value);
  if (f.num) return +el.value;
  return el.value.trim();
}
function writeField(tab, f, v) {
  const el = document.getElementById(`f-${tab}-${f.k}`); if (!el) return;
  if (f.type === "days") { for (const x of el.querySelectorAll("input")) x.checked = Array.isArray(v) && v.includes(+x.value); return; }
  if (f.type === "check") { el.checked = !!v; return; }
  el.value = v == null ? "" : String(v);
}
function resetForm(tab) {
  const spec = SPECS[tab], form = document.getElementById(`form-${tab}`); if (!form) return;
  form.dataset.editing = "";
  for (const f of spec.fields) writeField(tab, f, f.def ?? "");
  document.getElementById(`f-${tab}-submit`).textContent = "Add " + spec.noun;
  document.getElementById(`f-${tab}-cancel`).hidden = true;
}
function editItem(tab, it) {
  const spec = SPECS[tab], form = document.getElementById(`form-${tab}`); if (!form) return;
  form.dataset.editing = it.id;
  for (const f of spec.fields) writeField(tab, f, it[f.k]);
  document.getElementById(`f-${tab}-submit`).textContent = "Save " + spec.noun;
  document.getElementById(`f-${tab}-cancel`).hidden = false;
  form.scrollIntoView({ behavior: "smooth", block: "center" });
  document.getElementById(`f-${tab}-${spec.fields[0].k}`).focus();
}
async function submitForm(tab) {
  const spec = SPECS[tab], form = document.getElementById(`form-${tab}`), editing = form.dataset.editing;
  const data = {};
  for (const f of spec.fields) {
    const v = readField(tab, f);
    if (f.req && (v === "" || v == null || (Array.isArray(v) && !v.length))) { toast(`Add ${f.label.toLowerCase()} first`); document.getElementById(`f-${tab}-${f.k}`)?.focus?.(); return; }
    if (v !== "" && v != null) data[f.k] = v;
  }
  if (data.start && data.end && !span(data.start, data.end)) { toast("Check the start and end times"); return; }
  const base = editing ? S[spec.coll][editing] || {} : { createdAt: Date.now() };
  if (!editing && tab === "tasks") data.done = false;
  if (!editing && tab === "goals") data.order = Object.keys(S.goals).length + 1;
  const id = editing || uid(tab.slice(0, 1));
  const merged = { ...base, ...data };
  for (const f of spec.fields) if (!(f.k in data) && !f.req && f.type !== "check") delete merged[f.k];
  await Store.write(spec.coll, id, merged);
  resetForm(tab);
  toast(editing ? "Saved" : `Added ${spec.noun}. Replan to fit it in.`);
}

function rulesForm() {
  const c = cfg();
  const f = h("form", { id: "rulesForm", style: { display: "grid", gap: "14px" } });
  const t = (id, label, val, type = "time") => h("label", { class: "f", for: id }, label, h("input", { type, id, value: val ?? "" }));
  f.append(h("div", { class: "form", style: { marginTop: 0 } },
    t("r-wake", "Wake up", c.wake), t("r-bed", "Bedtime", c.bed),
    t("r-buffer", "Buffer between blocks (min)", c.buffer, "number"), t("r-chunk", "Longest work block (min)", c.maxChunk, "number")));
  const w = c.windows || DEFAULT_CONFIG.windows;
  f.append(h("div", null, h("div", { class: "eyebrow", style: { marginBottom: "6px" } }, "Time of day"), h("div", { class: "form", style: { marginTop: 0 } },
    ...["morning", "afternoon", "evening"].flatMap((k) => [t(`r-w-${k}-a`, `${k[0].toUpperCase() + k.slice(1)} starts`, (w[k] || [])[0]), t(`r-w-${k}-b`, "ends", (w[k] || [])[1])]))));
  const meals = (c.meals && c.meals.length ? c.meals : DEFAULT_CONFIG.meals).slice(0, 4);
  while (meals.length < 3) meals.push({ name: "", from: "", to: "", minutes: 30 });
  f.append(h("div", null, h("div", { class: "eyebrow", style: { marginBottom: "6px" } }, "Meals (the planner fits each one inside its window)"),
    ...meals.map((m, i) => h("div", { class: "form", style: { marginTop: i ? "6px" : 0 } },
      t(`r-m${i}-name`, "Meal", m.name, "text"), t(`r-m${i}-from`, "Earliest", m.from), t(`r-m${i}-to`, "Latest", m.to), t(`r-m${i}-min`, "Minutes", m.minutes, "number")))));
  f.append(h("label", { class: "f", for: "r-rules" }, "Rules Claude should follow (plain English)",
    h("textarea", { id: "r-rules", rows: "5", placeholder: "e.g. No LeetCode after 10pm. Saturday night is free. If the week is overloaded, trim career prep before gym or sleep." }, c.rules || "")));
  f.append(h("label", { class: "f", for: "r-about" }, "About me (context for Claude)",
    h("textarea", { id: "r-about", rows: "3" }, c.about || "")));
  f.append(h("div", { style: { display: "flex", gap: "8px" } }, h("button", { class: "btn primary", type: "submit" }, "Save rules")));
  f.addEventListener("input", () => { f.dataset.dirty = "1"; });
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = (id) => document.getElementById(id).value.trim();
    const next = { ...cfg(), wake: v("r-wake") || "07:30", bed: v("r-bed") || "23:30",
      buffer: Math.max(0, +v("r-buffer") || 0), maxChunk: Math.max(30, +v("r-chunk") || 120),
      windows: Object.fromEntries(["morning", "afternoon", "evening"].map((k) => [k, [v(`r-w-${k}-a`), v(`r-w-${k}-b`)]])),
      meals: meals.map((_, i) => ({ name: v(`r-m${i}-name`), from: v(`r-m${i}-from`), to: v(`r-m${i}-to`), minutes: Math.max(10, +v(`r-m${i}-min`) || 30) })).filter((m) => m.name && m.from && m.to),
      rules: v("r-rules"), about: v("r-about") };
    delete f.dataset.dirty;
    await Store.write("config", "main", next);
    toast("Rules saved. Replan to apply them.");
  });
  return f;
}
