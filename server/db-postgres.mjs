/* Postgres storage: the same document store as db.mjs, for hosts with no disk.
 *
 * Free hosting usually gives you a container that is wiped on every deploy, so
 * a SQLite file there would vanish. Point DATABASE_URL at a hosted Postgres
 * (Neon, Supabase, Render, Railway...) and the app uses this file instead.
 *
 * Same methods as the SQLite store, but async, so server code awaits both.
 */
import pg from "pg";

export const COLLECTIONS = ["config", "goals", "commitments", "events", "tasks", "plans", "briefs", "proposals"];

export async function openPgDb(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  // Hosted Postgres nearly always wants TLS; local Postgres nearly always doesn't.
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(connectionString) || process.env.PGSSLMODE === "disable";
  const pool = new pg.Pool({ connectionString, ssl: local ? false : { rejectUnauthorized: false }, max: 5 });

  await pool.query(`CREATE TABLE IF NOT EXISTS docs (
    collection TEXT NOT NULL,
    id         TEXT NOT NULL,
    doc        JSONB NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (collection, id)
  )`);

  return {
    kind: "postgres",
    async put(collection, id, doc) {
      const body = { ...doc };
      delete body.id;
      await pool.query(
        `INSERT INTO docs (collection, id, doc, updated_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (collection, id) DO UPDATE SET doc = EXCLUDED.doc, updated_at = EXCLUDED.updated_at`,
        [collection, id, JSON.stringify(body), Date.now()],
      );
      return { ...body, id };
    },
    async get(collection, id) {
      const { rows } = await pool.query("SELECT doc FROM docs WHERE collection = $1 AND id = $2", [collection, id]);
      return rows.length ? { ...rows[0].doc, id } : null;
    },
    async list(collection) {
      const { rows } = await pool.query("SELECT id, doc FROM docs WHERE collection = $1", [collection]);
      return Object.fromEntries(rows.map((r) => [r.id, { ...r.doc, id: r.id }]));
    },
    async remove(collection, id) {
      await pool.query("DELETE FROM docs WHERE collection = $1 AND id = $2", [collection, id]);
    },
    /** Everything one account owns; see the note in db.mjs. */
    async state(owner) {
      const { rows } = await pool.query("SELECT collection, id, doc FROM docs");
      const out = Object.fromEntries(COLLECTIONS.map((c) => [c, {}]));
      const prefix = owner ? owner + "/" : "";
      for (const r of rows) {
        const c = prefix
          ? (r.collection.startsWith(prefix) ? r.collection.slice(prefix.length) : null)
          : (r.collection.includes("/") ? null : r.collection);
        if (c === null || !(c in out)) continue;
        out[c][r.id] = { ...r.doc, id: r.id };
      }
      return {
        config: out.config.main || null,
        goals: out.goals, commitments: out.commitments, events: out.events,
        tasks: out.tasks, plans: out.plans,
        briefs: Object.values(out.briefs).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 5),
        proposals: Object.values(out.proposals).filter((p) => p.status === "pending"),
      };
    },
    /** Hand documents saved before the first account to that account. */
    async adopt(owner) {
      const { rowCount } = await pool.query(
        "UPDATE docs SET collection = $1 || '/' || collection WHERE collection = ANY($2)", [owner, COLLECTIONS]);
      return rowCount;
    },
    async clear() { await pool.query("DELETE FROM docs"); },
    async close() { await pool.end(); },
  };
}
