/* Google Calendar sync: push an approved week into a calendar of its own.
 *
 * Setup (once):
 *   1. console.cloud.google.com -> new project -> enable the Google Calendar API
 *   2. Credentials -> OAuth client ID -> Web application
 *      Authorised redirect URI: https://<your app>/api/gcal/callback
 *   3. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and PUBLIC_URL (or
 *      GOOGLE_REDIRECT_URI) on the server, then click Connect in the planner.
 *
 * Sync writes to a calendar named "Amer OS", never to your main calendar, and
 * remembers the event ids it created so a re-sync replaces that week instead of
 * duplicating it. Blocks you already ticked off are skipped.
 */
import { randomBytes } from "node:crypto";
import { requireUser } from "./auth.mjs";
import { addDays, dkey, pdate, hhmm } from "../app/engine.mjs";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CAL_API = "https://www.googleapis.com/calendar/v3";
const SCOPE = "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist";
const CAL_NAME = "Amer OS";

export const gcalEnabled = () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const redirectUri = () => process.env.GOOGLE_REDIRECT_URI || `${(process.env.PUBLIC_URL || "http://localhost:3000").replace(/\/$/, "")}/api/gcal/callback`;
const timeZone = () => process.env.TZ || "UTC";

/** Turn one week's blocks into Google Calendar events. Pure, so it can be tested. */
export function blocksToEvents(plan, { tz = timeZone() } = {}) {
  const start = pdate(plan.weekStart);
  return (plan.blocks || []).filter((b) => !b.done).map((b) => {
    const day = addDays(start, b.d);
    const at = (mins) => {
      const d = addDays(day, Math.floor(mins / 1440));
      return `${dkey(d)}T${hhmm(mins % 1440)}:00`;
    };
    return {
      summary: b.title,
      description: `${b.src === "task" ? "Task" : b.src === "goal" ? "Goal" : b.src === "meal" ? "Meal" : "Scheduled"} · planned by Amer OS`,
      start: { dateTime: at(b.s), timeZone: tz },
      end: { dateTime: at(b.e), timeZone: tz },
      extendedProperties: { private: { amerOs: "1", week: plan.weekStart, blockId: b.id } },
    };
  });
}

async function googleFetch(url, { token, method = "GET", body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google ${res.status}: ${(data.error && data.error.message) || "request failed"}`);
  return data;
}

async function exchange(params) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, ...params }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google token ${res.status}: ${data.error_description || data.error || "failed"}`);
  return data;
}

/** A valid access token for this account, refreshing it when it has expired. */
async function accessToken(store) {
  const conn = await store.get("gcal", "connection");
  if (!conn || !conn.refreshToken) throw new Error("Google Calendar isn't connected");
  if (conn.accessToken && conn.expiresAt > Date.now() + 60000) return conn.accessToken;
  const t = await exchange({ grant_type: "refresh_token", refresh_token: conn.refreshToken });
  const next = { ...conn, accessToken: t.access_token, expiresAt: Date.now() + (t.expires_in || 3600) * 1000 };
  await store.put("gcal", "connection", next);
  return next.accessToken;
}

/** Find (or create) the "Amer OS" calendar and remember its id. */
async function calendarId(store, token) {
  const conn = (await store.get("gcal", "connection")) || {};
  if (conn.calendarId) return conn.calendarId;
  const list = await googleFetch(`${CAL_API}/users/me/calendarList`, { token });
  const found = (list.items || []).find((c) => c.summary === CAL_NAME);
  const id = found ? found.id : (await googleFetch(`${CAL_API}/calendars`, { token, method: "POST", body: { summary: CAL_NAME, timeZone: timeZone() } })).id;
  await store.put("gcal", "connection", { ...conn, calendarId: id });
  return id;
}

/** Replace one week in the calendar with the current plan. */
export async function syncWeek(store, weekStart) {
  const plan = (await store.state()).plans[weekStart];
  if (!plan) throw new Error("There's no plan for that week yet");
  const token = await accessToken(store);
  const cal = await calendarId(store, token);

  const marker = await store.get("gcal", "week-" + weekStart);
  for (const id of (marker && marker.eventIds) || []) {
    try { await googleFetch(`${CAL_API}/calendars/${encodeURIComponent(cal)}/events/${encodeURIComponent(id)}`, { token, method: "DELETE" }); }
    catch (e) { if (!/ 404|410/.test(e.message)) throw e; }   // already gone is fine
  }

  const eventIds = [];
  for (const event of blocksToEvents(plan)) {
    const created = await googleFetch(`${CAL_API}/calendars/${encodeURIComponent(cal)}/events`, { token, method: "POST", body: event });
    eventIds.push(created.id);
  }
  await store.put("gcal", "week-" + weekStart, { weekStart, eventIds, syncedAt: Date.now() });
  return { weekStart, events: eventIds.length, calendar: CAL_NAME };
}

export function mountGcalRoutes(app, db, store) {
  app.get("/api/gcal/status", requireUser, async (req, res, next) => {
    try {
      const conn = await store(req).get("gcal", "connection");
      res.json({ enabled: gcalEnabled(), connected: Boolean(conn && conn.refreshToken), calendar: CAL_NAME });
    } catch (e) { next(e); }
  });

  app.get("/api/gcal/connect", requireUser, async (req, res, next) => {
    if (!gcalEnabled()) return res.status(503).send("Google Calendar isn't set up on this server.");
    try {
      const state = randomBytes(12).toString("hex");
      const conn = (await store(req).get("gcal", "connection")) || {};
      await store(req).put("gcal", "connection", { ...conn, oauthState: state });
      const url = `${AUTH_URL}?${new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri(), response_type: "code",
        scope: SCOPE, access_type: "offline", prompt: "consent", include_granted_scopes: "true", state,
      })}`;
      res.redirect(url);
    } catch (e) { next(e); }
  });

  app.get("/api/gcal/callback", requireUser, async (req, res, next) => {
    try {
      const conn = (await store(req).get("gcal", "connection")) || {};
      if (!req.query.code || !req.query.state || req.query.state !== conn.oauthState) return res.status(400).send("That sign-in didn't match. Start again from the planner.");
      const t = await exchange({ grant_type: "authorization_code", code: String(req.query.code), redirect_uri: redirectUri() });
      await store(req).put("gcal", "connection", {
        ...conn, oauthState: null,
        refreshToken: t.refresh_token || conn.refreshToken,
        accessToken: t.access_token, expiresAt: Date.now() + (t.expires_in || 3600) * 1000,
        connectedAt: Date.now(),
      });
      res.redirect("/?gcal=connected");
    } catch (e) { next(e); }
  });

  app.post("/api/gcal/sync", requireUser, async (req, res, next) => {
    try {
      const weekStart = String((req.body && req.body.weekStart) || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return res.status(400).json({ error: "Which week?" });
      res.json(await syncWeek(store(req), weekStart));
    } catch (e) {
      const msg = e.message || "Sync failed";
      if (/isn't connected|no plan/i.test(msg)) return res.status(400).json({ error: msg });
      console.error("gcal sync:", msg);
      res.status(502).json({ error: "Google Calendar refused the sync. Try reconnecting." });
    }
  });

  app.post("/api/gcal/disconnect", requireUser, async (req, res, next) => {
    try { await store(req).remove("gcal", "connection"); res.status(204).end(); } catch (e) { next(e); }
  });
}
