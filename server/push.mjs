/* Web push: the morning brief on your phone without opening the page.
 *
 * Needs a VAPID key pair (`npm run keys:push` prints one) in
 * VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY, and the app served over HTTPS —
 * browsers refuse push on plain http, except on localhost.
 *
 * A subscription is whatever the browser hands us; we keep one document per
 * browser under the account's "pushSubs" collection, and drop it when the
 * push service says it is gone.
 */
import webpush from "web-push";
import { createHash } from "node:crypto";
import { requireUser } from "./auth.mjs";

export const pushEnabled = () => Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
export const publicKey = () => process.env.VAPID_PUBLIC_KEY || null;

let configured = false;
function configure() {
  if (configured || !pushEnabled()) return pushEnabled();
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:nobody@example.com", process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  configured = true;
  return true;
}
const subId = (endpoint) => "s-" + createHash("sha256").update(String(endpoint)).digest("hex").slice(0, 24);

/** Send one notification to every browser this account registered. Returns how many got it. */
export async function sendPush(store, { title, body, url = "/" }) {
  if (!configure()) return 0;
  const subs = Object.values(await store.list("pushSubs"));
  let sent = 0;
  for (const row of subs) {
    try {
      await webpush.sendNotification(row.subscription, JSON.stringify({ title, body, url }));
      sent++;
    } catch (e) {
      // 404/410 mean the browser threw the subscription away; anything else is transient.
      if (e.statusCode === 404 || e.statusCode === 410) await store.remove("pushSubs", row.id);
      else console.error("push failed:", e.statusCode || e.message);
    }
  }
  return sent;
}

export function mountPushRoutes(app, db, store) {
  app.get("/api/push/key", requireUser, (_req, res) => res.json({ key: publicKey(), enabled: pushEnabled() }));

  app.post("/api/push/subscribe", requireUser, async (req, res, next) => {
    const sub = req.body && req.body.subscription;
    if (!pushEnabled()) return res.status(503).json({ error: "Push isn't set up on this server" });
    if (!sub || !sub.endpoint) return res.status(400).json({ error: "That isn't a push subscription" });
    try {
      await store(req).put("pushSubs", subId(sub.endpoint), { subscription: sub, createdAt: Date.now(), agent: (req.get("user-agent") || "").slice(0, 120) });
      res.status(201).json({ ok: true });
    } catch (e) { next(e); }
  });

  app.delete("/api/push/subscribe", requireUser, async (req, res, next) => {
    const endpoint = req.body && req.body.endpoint;
    if (!endpoint) return res.status(400).json({ error: "Which subscription?" });
    try { await store(req).remove("pushSubs", subId(endpoint)); res.status(204).end(); } catch (e) { next(e); }
  });

  // "Send me one now", so you can tell it works without waiting for 7am.
  app.post("/api/push/test", requireUser, async (req, res, next) => {
    try {
      const sent = await sendPush(store(req), { title: "Amer OS", body: "Push is working. Your morning brief will arrive here.", url: "/" });
      res.json({ sent });
    } catch (e) { next(e); }
  });
}
