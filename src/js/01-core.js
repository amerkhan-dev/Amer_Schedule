/* App shell: state, DOM helpers and storage.
 * Time/date helpers, PILLARS, DAYS and the planner itself come from
 * src/shared/engine.js, which the build inlines above this file.
 *
 * Storage has three modes, decided at startup:
 *   api    - served by the backend in this repo (server/), data in its database
 *   live   - published as a Claude artifact, data in the artifact's database
 *   local  - opened as a plain file, data in this browser only
 */
(() => {
"use strict";

/* Used only in local mode, so the page has something to show. */
const LOCAL_STARTER = {
  config: { ...DEFAULT_CONFIG, rules: "Example rules. Protect sleep. Deep work in the mornings. Saturday night is free." },
  goals: {
    "g-belay-deep": { pillar: "belay", label: "Belay deep work", count: 5, minutes: 120, when: "morning", protect: true, order: 1 },
    "g-gym": { pillar: "gym", label: "Lift", count: 4, minutes: 75, when: "evening", protect: true, order: 2 },
    "g-study": { pillar: "class", label: "Study & homework", count: 6, minutes: 90, when: "afternoon", order: 3 },
    "g-leetcode": { pillar: "career", label: "LeetCode", count: 5, minutes: 45, when: "any", order: 4 },
    "g-free": { pillar: "free", label: "Free time", count: 7, minutes: 60, when: "evening", protect: true, late: true, order: 5 },
  },
  commitments: {
    "c-ex1": { title: "Example class", pillar: "class", days: [0, 2, 4], start: "10:10", end: "11:00", where: "Example" },
    "c-ex2": { title: "Example TA lab", pillar: "work", days: [1], start: "13:25", end: "15:20", where: "Example" },
  },
  events: {},
  tasks: { "t-ex1": { title: "Example task", pillar: "belay", minutes: 45, due: "", priority: 2, done: false, createdAt: 1 } },
  plans: {},
};

/* ---------- DOM helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
function h(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "style" && typeof v === "object") { for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith("--")) n.style.setProperty(sk, sv); else n.style[sk] = sv; } }
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else if (k === "text") n.textContent = v;
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
  return n;
}
function fmt(m) {
  m = ((Math.round(m) % 1440) + 1440) % 1440;
  const hr = Math.floor(m / 60), mi = m % 60, ap = hr < 12 ? "a" : "p", h12 = ((hr + 11) % 12) + 1;
  return h12 + (mi ? ":" + pad(mi) : "") + ap;
}
const fmtRange = (s, e) => fmt(s) + "–" + fmt(e);
const clone = (o) => JSON.parse(JSON.stringify(o ?? null));
const cvar = (p) => `var(--c-${pillarOf(p)})`;
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 2600);
}

/* ---------- State ---------- */
const S = {
  config: null, goals: {}, commitments: {}, events: {}, tasks: {}, plans: {},
  briefs: [], proposals: [],
  week: mondayOf(new Date()), day: (new Date().getDay() + 6) % 7,
  tab: "tasks", mode: "connecting", loaded: false,
};
const cfg = () => withDefaults(S.config);
const weekKey = () => dkey(S.week);
const currentPlan = () => S.plans[weekKey()] || null;
/** The plain object the shared engine works on. */
const snapshot = () => ({ config: cfg(), goals: S.goals, commitments: S.commitments, events: S.events, tasks: S.tasks, plans: S.plans });

/* ---------- Storage ---------- */
const LS_KEY = "amer-os-local-v1";
const Store = {
  db: null, api: null, queues: new Map(),

  enqueue(path, fn) {
    const prev = this.queues.get(path) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.queues.set(path, next);
    return next;
  },
  async write(coll, id, data) {
    const body = clone(data); delete body.id;
    if (coll === "config") S.config = body; else S[coll][id] = { ...body, id };
    render();
    if (this.api) return this.enqueue(coll + "/" + id, () => this.apiFetch(`/${coll}/${id}`, { method: "PUT", body })).catch((e) => this.fail(e));
    if (this.db) {
      const path = coll === "config" ? "config/main" : coll + "/" + id;
      return this.enqueue(path, () => this.db.doc(path).set(body)).catch((e) => this.fail(e));
    }
    this.saveLocal();
  },
  async remove(coll, id) {
    delete S[coll][id]; render();
    if (this.api) return this.enqueue(coll + "/" + id, () => this.apiFetch(`/${coll}/${id}`, { method: "DELETE" })).catch((e) => this.fail(e));
    if (this.db) return this.enqueue(coll + "/" + id, () => this.db.doc(coll + "/" + id).delete()).catch((e) => this.fail(e));
    this.saveLocal();
  },
  async setRaw(path, body) {
    if (this.api) return this.apiFetch("/" + path, { method: "PUT", body }).catch((e) => this.fail(e));
    if (this.db) return this.enqueue(path, () => this.db.doc(path).set(body)).catch((e) => this.fail(e));
  },
  fail(e) {
    const code = e && e.code;
    if (code === "unauthorized") { showAuth(); return; }
    if (code === "quota_exceeded") toast("Storage is full. Delete some old tasks or plans.");
    else if (code === "invalid_argument") toast("You can view this planner but not change it.");
    else toast("Couldn't save. Check your connection and try again.");
    console.warn("save failed", e);
  },

  /* --- backend mode --- */
  async apiFetch(path, { method = "GET", body, signal } = {}) {
    const res = await fetch(this.api + path, {
      method, signal,
      credentials: "same-origin",        // the session cookie rides along
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401) throw { code: "unauthorized", message: "Wrong or missing access key" };
    if (!res.ok) throw { code: "http_" + res.status, message: await res.text().catch(() => res.statusText) };
    return res.status === 204 ? null : res.json();
  },
  async loadFromApi() {
    const state = await this.apiFetch("/state");
    S.config = state.config || null;
    for (const c of COLLECTIONS) S[c] = state[c] || {};
    S.briefs = state.briefs || [];
    S.proposals = state.proposals || [];
    S.loaded = true; S.mode = "api"; render();
  },
  /* --- browser-only mode --- */
  saveLocal() {
    clearTimeout(this._lt);
    this._lt = setTimeout(() => {
      try { localStorage.setItem(LS_KEY, JSON.stringify({ config: S.config, goals: S.goals, commitments: S.commitments, events: S.events, tasks: S.tasks, plans: S.plans })); } catch (_) {}
    }, 300);
  },
  loadLocal() {
    let data = null;
    try { data = JSON.parse(localStorage.getItem(LS_KEY) || "null"); } catch (_) {}
    data = data || clone(LOCAL_STARTER);
    S.config = data.config || { ...DEFAULT_CONFIG };
    for (const c of COLLECTIONS) {
      S[c] = {};
      for (const [id, v] of Object.entries(data[c] || {})) S[c][id] = { ...v, id };
    }
  },

  async init() {
    // 1. Served by the backend in this repo?
    if (window.AMER_API) {
      this.api = window.AMER_API;
      try {
        await this.loadFromApi();
        loadConnections();
      } catch (e) {
        if (e && e.code === "unauthorized") showAuth();               // sign in, then we load
        else { toast("Can't reach the server. Showing a local copy."); this.api = null; }
      }
      if (this.api) { setInterval(() => { if (!$("#authOverlay").hidden) return; this.loadFromApi().catch(() => {}); }, 60000); return; }
    }
    // 2. Published as a Claude artifact?
    let db = null;
    try { db = window.claude && typeof window.claude.use === "function" ? await window.claude.use("db") : null; } catch (_) { db = null; }
    if (!db) { this.loadLocal(); S.mode = "local"; S.loaded = true; render(); return; }

    this.db = db; S.mode = "live";
    const pending = new Set(["config", ...COLLECTIONS]);
    const done = (k) => { if (pending.delete(k) && !pending.size) S.loaded = true; render(); };
    const onErr = (e) => { if (e && e.code === "revoked") { S.mode = "revoked"; render(); } else console.warn("db", e); };
    db.doc("config/main").onSnapshot((s) => { S.config = s.exists ? { ...s.data() } : null; done("config"); }, onErr);
    for (const c of COLLECTIONS) {
      db.collection(c).onSnapshot((snap) => {
        const next = {};
        for (const d of snap.docs) next[d.id] = { ...d.data(), id: d.id };
        S[c] = next; done(c);
      }, onErr);
    }
    db.collection("briefs").orderBy("createdAt", "desc").limit(5).onSnapshot((snap) => {
      S.briefs = snap.docs.map((d) => ({ ...d.data(), id: d.id })); render();
    }, onErr);
    db.collection("proposals").where("status", "==", "pending").onSnapshot((snap) => {
      S.proposals = sortBy(snap.docs.map((d) => ({ ...d.data(), id: d.id })), (p) => -(p.createdAt || 0)); render();
    }, onErr);
  },
};
