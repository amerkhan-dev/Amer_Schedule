/* Accounts and sessions.
 *
 * Email + password, hashed with scrypt (built into Node, no dependency).
 * A successful login sets an httpOnly cookie holding a random session id; the
 * session itself lives in the same document store as everything else.
 *
 * Users are stored under the "users" collection and sessions under "sessions",
 * neither of which the API exposes, so a signed-in account can never read or
 * write them through /api/:collection/:id.
 *
 * The first account to sign up adopts any planner data that existed before
 * accounts did, and after that signup is closed unless SIGNUP_OPEN=true.
 */
import { randomBytes, scrypt as _scrypt, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(_scrypt);
const SESSION_DAYS = 30;
const COOKIE = "amer_session";

const emailKey = (email) => "u-" + createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 24);

export async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const key = await scrypt(password, salt, 64);
  return `scrypt:${salt}:${key.toString("hex")}`;
}
export async function verifyPassword(password, stored) {
  const [scheme, salt, hex] = String(stored || "").split(":");
  if (scheme !== "scrypt" || !salt || !hex) return false;
  const key = await scrypt(password, salt, 64);
  const expected = Buffer.from(hex, "hex");
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export async function countUsers(db) {
  return Object.keys(await db.list("users")).length;
}
export async function firstUserId(db) {
  const users = Object.values(await db.list("users")).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  return users.length ? users[0].id : null;
}

async function newSession(db, userId) {
  const sid = randomBytes(24).toString("hex");
  await db.put("sessions", sid, { userId, createdAt: Date.now(), expiresAt: Date.now() + SESSION_DAYS * 864e5 });
  return sid;
}
function setCookie(res, sid, secure) {
  res.append("Set-Cookie", `${COOKIE}=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure ? "; Secure" : ""}`);
}

/**
 * Works out who is asking: a session cookie, or the API key (handy for curl and
 * uptime checks), which acts as the first account. Sets req.userId, or leaves it
 * undefined for anonymous requests.
 */
export function authMiddleware(db, { token } = {}) {
  return async (req, _res, next) => {
    try {
      const sid = parseCookies(req.get("cookie"))[COOKIE];
      if (sid) {
        const session = await db.get("sessions", sid);
        if (session && session.expiresAt > Date.now()) {
          req.userId = session.userId;
          req.sessionId = sid;
          return next();
        }
        if (session) await db.remove("sessions", sid);   // expired
      }
      const bearer = (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
      if (token && bearer && bearer === token) req.userId = (await firstUserId(db)) || "default";
      next();
    } catch (e) { next(e); }
  };
}

/** Blocks anything that isn't signed in. */
export const requireUser = (req, res, next) =>
  req.userId ? next() : res.status(401).json({ error: "Sign in first" });

export function mountAuthRoutes(app, db, { secure = process.env.NODE_ENV === "production" } = {}) {
  const publicUser = (u) => ({ id: u.id, email: u.email, createdAt: u.createdAt });

  // Does this server have an account yet, and am I signed in?
  app.get("/api/auth/status", async (_req, res, next) => {
    try { res.json({ hasAccount: (await countUsers(db)) > 0, signupOpen: process.env.SIGNUP_OPEN === "true" }); }
    catch (e) { next(e); }
  });

  app.get("/api/auth/me", async (req, res, next) => {
    try {
      if (!req.userId) return res.status(401).json({ error: "Not signed in" });
      const user = await db.get("users", req.userId);
      res.json({ user: user ? publicUser(user) : { id: req.userId, email: "api key" } });
    } catch (e) { next(e); }
  });

  app.post("/api/auth/signup", async (req, res, next) => {
    try {
      const email = String((req.body && req.body.email) || "").trim().toLowerCase();
      const password = String((req.body && req.body.password) || "");
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "That doesn't look like an email address" });
      if (password.length < 10) return res.status(400).json({ error: "Use a password of at least 10 characters" });

      const existing = await countUsers(db);
      if (existing > 0 && process.env.SIGNUP_OPEN !== "true") return res.status(403).json({ error: "This planner already has an account" });

      const id = emailKey(email);
      if (await db.get("users", id)) return res.status(409).json({ error: "That email already has an account" });

      const user = { id, email, passwordHash: await hashPassword(password), createdAt: Date.now() };
      await db.put("users", id, user);
      // First account keeps whatever was already in the planner.
      if (existing === 0 && db.adopt) await db.adopt(id);

      setCookie(res, await newSession(db, id), secure);
      res.status(201).json({ user: publicUser(user), adopted: existing === 0 });
    } catch (e) { next(e); }
  });

  app.post("/api/auth/login", async (req, res, next) => {
    try {
      const email = String((req.body && req.body.email) || "").trim().toLowerCase();
      const password = String((req.body && req.body.password) || "");
      const user = await db.get("users", emailKey(email));
      // Same answer either way, so this can't be used to find out who has an account.
      if (!user || !(await verifyPassword(password, user.passwordHash))) return res.status(401).json({ error: "Wrong email or password" });
      setCookie(res, await newSession(db, user.id), secure);
      res.json({ user: publicUser(user) });
    } catch (e) { next(e); }
  });

  app.post("/api/auth/logout", async (req, res, next) => {
    try {
      if (req.sessionId) await db.remove("sessions", req.sessionId);
      res.append("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
      res.status(204).end();
    } catch (e) { next(e); }
  });

  app.post("/api/auth/password", requireUser, async (req, res, next) => {
    try {
      const current = String((req.body && req.body.current) || ""), next_ = String((req.body && req.body.next) || "");
      const user = await db.get("users", req.userId);
      if (!user || !(await verifyPassword(current, user.passwordHash))) return res.status(401).json({ error: "Wrong current password" });
      if (next_.length < 10) return res.status(400).json({ error: "Use a password of at least 10 characters" });
      await db.put("users", user.id, { ...user, passwordHash: await hashPassword(next_) });
      res.status(204).end();
    } catch (e) { next(e); }
  });
}
