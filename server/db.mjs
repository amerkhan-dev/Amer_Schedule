/* SQLite storage.
 *
 * Everything the planner keeps is a JSON document with a collection and an id,
 * exactly like the Claude artifact version, so one table holds all of it:
 *
 *   docs(collection, id, json, updated_at)
 *
 * Swapping SQLite for Postgres later means rewriting only this file.
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const COLLECTIONS = ["config", "goals", "commitments", "events", "tasks", "plans", "briefs", "proposals"];

export function openDb(file = process.env.DB_FILE || "data/amer.db") {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS docs (
    collection TEXT NOT NULL,
    id         TEXT NOT NULL,
    json       TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (collection, id)
  )`);

  const stmts = {
    put: db.prepare(`INSERT INTO docs (collection, id, json, updated_at) VALUES (?, ?, ?, ?)
                     ON CONFLICT(collection, id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`),
    get: db.prepare("SELECT json FROM docs WHERE collection = ? AND id = ?"),
    list: db.prepare("SELECT id, json FROM docs WHERE collection = ?"),
    del: db.prepare("DELETE FROM docs WHERE collection = ? AND id = ?"),
    all: db.prepare("SELECT collection, id, json FROM docs"),
  };
  const parse = (row) => ({ ...JSON.parse(row.json), id: row.id });

  return {
    kind: "sqlite",
    raw: db,
    put(collection, id, doc) {
      const body = { ...doc };
      delete body.id;
      stmts.put.run(collection, id, JSON.stringify(body), Date.now());
      return { ...body, id };
    },
    get(collection, id) {
      const row = stmts.get.get(collection, id);
      return row ? { ...JSON.parse(row.json), id } : null;
    },
    list(collection) {
      const out = {};
      for (const row of stmts.list.all(collection)) out[row.id] = parse(row);
      return out;
    },
    remove(collection, id) { stmts.del.run(collection, id); },

    /**
     * Everything one account owns, shaped the way the page and the engine expect.
     * Documents live under "<owner>/<collection>", so two accounts never see each
     * other's week. Rows with no owner (from before accounts existed) are ignored.
     */
    state(owner) {
      const out = Object.fromEntries(COLLECTIONS.map((c) => [c, {}]));
      const prefix = owner ? owner + "/" : "";
      for (const row of stmts.all.all()) {
        const c = prefix
          ? (row.collection.startsWith(prefix) ? row.collection.slice(prefix.length) : null)
          : (row.collection.includes("/") ? null : row.collection);
        if (c === null || !(c in out)) continue;
        out[c][row.id] = parse(row);
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
    adopt(owner) {
      const marks = COLLECTIONS.map(() => "?").join(",");
      return db.prepare(`UPDATE docs SET collection = ? || '/' || collection WHERE collection IN (${marks})`)
        .run(owner, ...COLLECTIONS).changes;
    },
    clear() { db.exec("DELETE FROM docs"); },
    close() { db.close(); },
  };
}

/**
 * A view of the store that belongs to one account: every collection is stored
 * under "<owner>/<collection>", so the rest of the code can forget accounts exist.
 */
export function scoped(db, owner) {
  const p = (c) => (owner ? `${owner}/${c}` : c);
  return {
    kind: db.kind,
    owner,
    put: (c, id, doc) => db.put(p(c), id, doc),
    get: (c, id) => db.get(p(c), id),
    list: (c) => db.list(p(c)),
    remove: (c, id) => db.remove(p(c), id),
    state: () => db.state(owner),
  };
}

/**
 * Pick the store: Postgres when DATABASE_URL is set (free hosts with no disk),
 * SQLite otherwise (your laptop, or a host with a mounted disk).
 */
export async function openStore() {
  if (process.env.DATABASE_URL) {
    const { openPgDb } = await import("./db-postgres.mjs");
    return openPgDb(process.env.DATABASE_URL);
  }
  return openDb();
}

/** Load seed/example.json (or any file of the same shape) into an empty database. */
export async function seedFrom(db, seed) {
  for (const [collection, docs] of Object.entries(seed)) {
    for (const [id, doc] of Object.entries(docs)) await db.put(collection, id, doc);
  }
}
