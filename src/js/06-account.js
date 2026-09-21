
/* ---------- Account, notifications and Google Calendar ----------
 * Only used when the backend serves the page. In the Claude artifact and in
 * local preview these all stay hidden.
 */
const Account = {
  user: null, signupMode: false,
  push: { enabled: false, key: null, subscribed: false, busy: false },
  gcal: { enabled: false, connected: false },
};

function errText(e, fallback) {
  const raw = (e && e.message) || "";
  try { const j = JSON.parse(raw); if (j && j.error) return j.error; } catch (_) {}
  return raw && raw.length < 160 ? raw : fallback;
}

/* ---- sign in / sign up ---- */
async function showAuth() {
  let status = null;
  try { status = await (await fetch(Store.api + "/auth/status")).json(); } catch (_) {}
  Account.signupMode = Boolean(status && status.hasAccount === false);
  $("#authIntro").textContent = Account.signupMode
    ? "First time here. Pick an email and a password of at least 10 characters, and this planner is yours."
    : "Sign in to your planner.";
  $("#authSubmit").textContent = Account.signupMode ? "Create account" : "Sign in";
  $("#authPassword").setAttribute("autocomplete", Account.signupMode ? "new-password" : "current-password");
  $("#authOverlay").hidden = false;
  $("#authEmail").focus();
}
function hideAuth() {
  $("#authOverlay").hidden = true;
  $("#authError").hidden = true;
  $("#authPassword").value = "";
}
async function submitAuth(ev) {
  ev.preventDefault();
  const btn = $("#authSubmit"), err = $("#authError");
  const email = $("#authEmail").value.trim(), password = $("#authPassword").value;
  btn.disabled = true; err.hidden = true;
  try {
    const res = await Store.apiFetch(Account.signupMode ? "/auth/signup" : "/auth/login", { method: "POST", body: { email, password } });
    Account.user = res.user;
    hideAuth();
    await Store.loadFromApi();
    loadConnections();
    toast(Account.signupMode ? "Account created" : "Signed in");
  } catch (e) {
    err.textContent = errText(e, "That didn't work. Try again.");
    err.hidden = false;
  } finally { btn.disabled = false; }
}
async function signOut() {
  try { await Store.apiFetch("/auth/logout", { method: "POST" }); } catch (_) {}
  Account.user = null;
  location.reload();
}

/* ---- what this server offers, and what this browser has already agreed to ---- */
async function loadConnections() {
  if (!Store.api) return;
  try {
    const health = await (await fetch(Store.api + "/health")).json();
    Account.push.enabled = Boolean(health.push);
    Account.gcal.enabled = Boolean(health.gcal);
  } catch (_) {}
  try { Account.user = (await Store.apiFetch("/auth/me")).user; } catch (_) {}
  if (Account.gcal.enabled) {
    try { const st = await Store.apiFetch("/gcal/status"); Account.gcal.connected = Boolean(st.connected); } catch (_) {}
  }
  if (Account.push.enabled && "serviceWorker" in navigator && "PushManager" in window) {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      Account.push.subscribed = Boolean(sub);
    } catch (_) {}
  }
  renderConnections();
}

function renderConnections() {
  const box = $("#connections");
  if (!box) return;
  if (!Store.api) { box.hidden = true; return; }
  box.hidden = false;
  box.replaceChildren();
  box.append(h("span", { class: "who" }, Account.user && Account.user.email ? Account.user.email : "Signed in"));

  if (Account.push.enabled && "serviceWorker" in navigator && "PushManager" in window) {
    box.append(Account.push.subscribed
      ? h("button", { class: "btn small", onclick: testPush }, "Send a test notification")
      : h("button", { class: "btn small", onclick: enablePush }, "Notify me on this device"));
  }
  if (Account.gcal.enabled) {
    box.append(Account.gcal.connected
      ? h("button", { class: "btn small", onclick: syncCalendar }, "Sync week to Google Calendar")
      : h("button", { class: "btn small", onclick: () => { location.href = Store.api + "/gcal/connect"; } }, "Connect Google Calendar"));
  }
  box.append(h("button", { class: "btn small ghost", onclick: signOut }, "Sign out"));
}

/* ---- web push ---- */
function urlBase64ToUint8Array(base64) {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}
async function enablePush() {
  if (Account.push.busy) return;
  Account.push.busy = true;
  try {
    const { key, enabled } = await Store.apiFetch("/push/key");
    if (!enabled || !key) { toast("Push isn't set up on this server yet."); return; }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") { toast("Notifications are blocked in this browser's settings."); return; }
    const reg = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription())
      || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) }));
    await Store.apiFetch("/push/subscribe", { method: "POST", body: { subscription: sub.toJSON() } });
    Account.push.subscribed = true;
    renderConnections();
    toast("Notifications on. Your morning brief will arrive here.");
  } catch (e) {
    console.warn("push setup failed", e);
    toast(errText(e, "Couldn't turn on notifications on this device."));
  } finally { Account.push.busy = false; }
}
async function testPush() {
  try {
    const { sent } = await Store.apiFetch("/push/test", { method: "POST" });
    toast(sent ? "Sent. It should appear in a moment." : "No device is registered yet.");
  } catch (e) { toast(errText(e, "Couldn't send a test notification.")); }
}

/* ---- Google Calendar ---- */
async function syncCalendar() {
  if (!currentPlan()) { toast("Plan the week first, then sync it."); return; }
  toast("Syncing to Google Calendar…");
  try {
    const res = await Store.apiFetch("/gcal/sync", { method: "POST", body: { weekStart: weekKey() } });
    toast(`${res.events} blocks are in your "${res.calendar}" calendar.`);
  } catch (e) { toast(errText(e, "Google Calendar wouldn't take that. Try reconnecting.")); }
}

/* ---- startup ---- */
function initAccount() {
  const form = $("#authForm");
  if (form) form.addEventListener("submit", submitAuth);
  if (new URLSearchParams(location.search).get("gcal") === "connected") {
    history.replaceState(null, "", location.pathname);
    setTimeout(() => toast("Google Calendar connected. Press Sync to fill the week."), 400);
  }
}
