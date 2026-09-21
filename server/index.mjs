/* The Amer OS backend: one Express app that serves the planner page and its API.
 *
 *   GET    /                     the planner page
 *   GET    /sw.js                service worker, for push notifications
 *   GET    /manifest.webmanifest so the page can be installed on a phone
 *   GET    /api/health           public: is the server up, what is switched on
 *   POST   /api/auth/signup      first visit creates the account
 *   POST   /api/auth/login       sets a session cookie
 *   POST   /api/auth/logout      ends the session
 *   GET    /api/auth/me          who am I
 *   GET    /api/state            everything this account owns
 *   PUT    /api/:collection/:id  create or replace one document
 *   DELETE /api/:collection/:id  remove one document
 *   POST   /api/plan             lay out a week and save it   {weekStart?}
 *   POST   /api/ask              relay a prompt to Claude     {prompt}
 *   POST   /api/push/subscribe   register this browser for the morning brief
 *   GET    /api/gcal/*           connect and sync Google Calendar
 *
 * Everything under /api except health and auth needs a signed-in session
 * (cookie) or the API key as a bearer token, which acts as the first account.
 */
import "dotenv/config";
import express from "express";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openStore, scoped, COLLECTIONS } from "./db.mjs";
import { mondayOf, pdate } from "../app/engine.mjs";
import { askEnabled, askClaude } from "./ask.mjs";
import { replan } from "./plan.mjs";
import { startJobs } from "./jobs.mjs";
import { authMiddleware, requireUser, mountAuthRoutes } from "./auth.mjs";
import { pushEnabled, mountPushRoutes, publicKey } from "./push.mjs";
import { gcalEnabled, mountGcalRoutes } from "./gcal.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const asset = (name) => path.join(ROOT, "app", name);
const WRITABLE = new Set(COLLECTIONS.filter((c) => c !== "users" && c !== "sessions"));

export function createServer({ db, token = process.env.API_TOKEN } = {}) {
  if (!db) throw new Error("createServer needs a store: await openStore()");
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.disable("x-powered-by");
  app.set("trust proxy", 1);   // hosts terminate TLS in front of us

  app.get("/api/health", (_req, res) => res.json({ ok: true, ask: askEnabled(), push: pushEnabled(), gcal: gcalEnabled() }));

  app.use(authMiddleware(db, { token }));
  mountAuthRoutes(app, db);

  // From here on, you have to be signed in.
  app.use("/api", requireUser);
  const store = (req) => scoped(db, req.userId);

  app.get("/api/state", async (req, res, next) => {
    try {
      const state = await store(req).state();
      res.json({ ...state, pushPublicKey: publicKey() });
    } catch (e) { next(e); }
  });

  app.put("/api/:collection/:id", async (req, res, next) => {
    const { collection, id } = req.params;
    if (!WRITABLE.has(collection)) return res.status(400).json({ error: `Unknown collection "${collection}"` });
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) return res.status(400).json({ error: "Body must be a JSON object" });
    try { res.json(await store(req).put(collection, id, req.body)); } catch (e) { next(e); }
  });

  app.delete("/api/:collection/:id", async (req, res, next) => {
    const { collection, id } = req.params;
    if (!WRITABLE.has(collection)) return res.status(400).json({ error: `Unknown collection "${collection}"` });
    try { await store(req).remove(collection, id); res.status(204).end(); } catch (e) { next(e); }
  });

  app.post("/api/plan", async (req, res, next) => {
    const weekStart = mondayOf(req.body && req.body.weekStart ? pdate(req.body.weekStart) : new Date());
    try { res.json(await replan(store(req), weekStart, req.body && req.body.by)); } catch (e) { next(e); }
  });

  app.post("/api/ask", async (req, res, next) => {
    const prompt = req.body && typeof req.body.prompt === "string" ? req.body.prompt : "";
    if (!prompt.trim()) return res.status(400).json({ error: "Nothing to ask" });
    if (!askEnabled()) return res.status(503).json({ error: "Ask Claude is off. Set ANTHROPIC_API_KEY to turn it on." });
    try { res.json({ text: await askClaude(prompt) }); }
    catch (e) { console.error("ask failed:", e.message); res.status(502).json({ error: "Claude didn't answer. Try again." }); }
  });

  mountPushRoutes(app, db, store);
  mountGcalRoutes(app, db, store);

  // The page is built as a fragment (the Claude artifact host adds the document
  // around it), so wrap it and tell it where the API lives.
  app.get("/", (_req, res) => {
    let body;
    try { body = readFileSync(asset("amer-os.html"), "utf8"); }
    catch { return res.status(500).send("Run `npm run build` first: app/amer-os.html is missing."); }
    res.type("html").send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#eef1ef">
<link rel="manifest" href="/manifest.webmanifest">
<style>[hidden]{display:none!important} body{margin:0}</style>
<script>window.AMER_API = "/api";</script>
</head>
<body>
${body}
</body>
</html>`);
  });

  // Must be served from the root, or the browser won't let it handle push.
  app.get("/sw.js", (_req, res) => res.type("js").sendFile(asset("sw.js")));
  app.get("/manifest.webmanifest", (_req, res) => res.type("application/manifest+json").sendFile(asset("manifest.webmanifest")));
  app.get("/icon-:size.png", (req, res) => res.sendFile(asset(`icon-${req.params.size}.png`)));

  app.use((err, _req, res, _next) => {
    console.error("request failed:", err);
    res.status(500).json({ error: "Something went wrong on the server" });
  });

  app.locals.db = db;
  return app;
}

// Started directly (`npm start`) rather than imported by a test.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const db = await openStore();
  const port = Number(process.env.PORT) || 3000;
  createServer({ db }).listen(port, () => {
    console.log(`Amer OS is running on port ${port} (storage: ${db.kind})`);
    console.log(`Ask Claude: ${askEnabled() ? "on" : "off (set ANTHROPIC_API_KEY)"} · ` +
      `push: ${pushEnabled() ? "on" : "off (run npm run keys:push)"} · ` +
      `Google Calendar: ${gcalEnabled() ? "on" : "off (set GOOGLE_CLIENT_ID/SECRET)"}`);
  });
  startJobs(db);
}
