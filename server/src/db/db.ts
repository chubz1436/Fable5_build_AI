import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * SQLite (WAL) is the single authoritative operational store.
 *
 * Design notes:
 *  - Domain entities (tasks, workers, projects, …) are stored as JSON
 *    documents with the columns that matter for constraints/queries lifted
 *    into real columns. Operational tables that need hard guarantees
 *    (attempts, operations, leases) use typed columns plus UNIQUE and
 *    partial-index constraints so concurrency protection lives in the
 *    database, not in memory.
 *  - Every state transition that must be atomic runs inside tx().
 *  - WAL mode gives crash-safe writes; each statement is durable.
 */

const SCHEMA_VERSION = 4;

const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id   TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'sample',
  json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workers (
  id   TEXT PRIMARY KEY,
  json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id             TEXT PRIMARY KEY,
  status         TEXT NOT NULL,
  project_id     TEXT,
  git_project_id TEXT,
  updated_at     TEXT NOT NULL,
  json           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status);

CREATE TABLE IF NOT EXISTS approvals (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL,
  type       TEXT NOT NULL,
  status     TEXT NOT NULL,
  expires_at TEXT,
  json       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS approvals_task ON approvals(task_id);

CREATE TABLE IF NOT EXISTS handoffs (
  id      TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  json    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  id      TEXT NOT NULL UNIQUE,
  task_id TEXT,
  at      TEXT NOT NULL,
  type    TEXT NOT NULL,
  json    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_task ON events(task_id);

CREATE TABLE IF NOT EXISTS attempts (
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES tasks(id),
  state          TEXT NOT NULL,
  worker_id      TEXT NOT NULL,
  git_project_id TEXT NOT NULL,
  started_at     TEXT NOT NULL,
  json           TEXT NOT NULL
);
-- hard guarantee: one active attempt per task. 'cancelling',
-- 'cancellation_failed' and 'termination_failed' still count as active:
-- their processes may be alive, so they keep holding their leases.
CREATE UNIQUE INDEX IF NOT EXISTS attempts_one_active ON attempts(task_id)
  WHERE state IN ('creating_worktree','running','validating','cancelling','cancellation_failed','termination_failed');
CREATE INDEX IF NOT EXISTS attempts_task ON attempts(task_id);

CREATE TABLE IF NOT EXISTS operations (
  id              TEXT PRIMARY KEY,
  attempt_id      TEXT NOT NULL REFERENCES attempts(id),
  kind            TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL,
  started_at      TEXT NOT NULL,
  json            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS operations_attempt ON operations(attempt_id);

CREATE TABLE IF NOT EXISTS leases (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  attempt_id   TEXT NOT NULL,
  acquired_at  TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  released_at  TEXT
);
-- hard guarantee: one active lease per (kind, resource)
CREATE UNIQUE INDEX IF NOT EXISTS leases_active ON leases(kind, resource_key)
  WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS leases_attempt ON leases(attempt_id);
`;

export class Db {
  readonly sqlite: DatabaseSync;
  private txDepth = 0;
  /**
   * Called after the OUTERMOST transaction ends: `true` after a successful
   * COMMIT, `false` after a ROLLBACK. Used by the Store to buffer SSE
   * broadcasts until the data they describe is actually durable (P0-6).
   */
  onTxEnd: ((committed: boolean) => void) | null = null;

  get inTransaction(): boolean {
    return this.txDepth > 0;
  }

  constructor(readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.sqlite = new DatabaseSync(file);
    this.sqlite.exec('PRAGMA journal_mode = WAL');
    this.sqlite.exec('PRAGMA foreign_keys = ON');
    this.sqlite.exec('PRAGMA busy_timeout = 5000');
    this.sqlite.exec(DDL);
    this.integrityCheck();
    this.migrate();
  }

  private integrityCheck(): void {
    const row = this.sqlite.prepare('PRAGMA integrity_check').get() as
      | { integrity_check?: string }
      | undefined;
    const result = row?.integrity_check ?? 'unknown';
    if (result !== 'ok') {
      throw new Error(`SQLite integrity check failed for ${this.file}: ${result}`);
    }
  }

  private migrate(): void {
    const current = Number(this.getMeta('schema_version') ?? '0');
    if (current > SCHEMA_VERSION) {
      throw new Error(
        `Database schema v${current} is newer than this build supports (v${SCHEMA_VERSION}).`,
      );
    }
    if (current < SCHEMA_VERSION) {
      if (current < 4) {
        // v2 added 'cancelling'; v3 added 'cancellation_failed'; v4 adds
        // 'termination_failed' — all three keep holding leases. CREATE INDEX
        // IF NOT EXISTS never updates an existing definition, so the index is
        // rebuilt from scratch every time this list grows.
        this.sqlite.exec('DROP INDEX IF EXISTS attempts_one_active');
        this.sqlite.exec(
          "CREATE UNIQUE INDEX attempts_one_active ON attempts(task_id) " +
            "WHERE state IN ('creating_worktree','running','validating','cancelling','cancellation_failed','termination_failed')",
        );
      }
      this.setMeta('schema_version', String(SCHEMA_VERSION));
    }
  }

  getMeta(key: string): string | null {
    const row = this.sqlite.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.sqlite
      .prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  /**
   * Run fn inside a transaction (BEGIN IMMEDIATE). Nested calls join the
   * outer transaction. Throwing rolls back.
   */
  tx<T>(fn: () => T): T {
    if (this.txDepth > 0) {
      this.txDepth++;
      try {
        return fn();
      } finally {
        this.txDepth--;
      }
    }
    this.sqlite.exec('BEGIN IMMEDIATE');
    this.txDepth = 1;
    let committed = false;
    try {
      const result = fn();
      this.sqlite.exec('COMMIT');
      committed = true;
      return result;
    } catch (err) {
      try {
        this.sqlite.exec('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      throw err;
    } finally {
      this.txDepth = 0;
      this.onTxEnd?.(committed);
    }
  }

  close(): void {
    try {
      this.sqlite.close();
    } catch {
      /* already closed */
    }
  }
}

/** true when the error is a UNIQUE-constraint violation */
export function isUniqueViolation(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? '');
  return msg.includes('UNIQUE constraint failed');
}

/**
 * One-time import of the legacy single-document JSON store. The JSON file is
 * never modified or deleted — it simply stops being the source of truth.
 * Returns true when an import happened.
 */
export function importLegacyJson(db: Db, legacyFile: string): boolean {
  if (db.getMeta('legacy_import') !== null) return false;
  if (!fs.existsSync(legacyFile)) return false;

  let parsed: Record<string, unknown[]>;
  try {
    parsed = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
  } catch {
    db.setMeta('legacy_import', `failed:unreadable:${new Date().toISOString()}`);
    return false;
  }

  const rows = (key: string) => (Array.isArray(parsed[key]) ? (parsed[key] as Array<Record<string, unknown>>) : []);

  db.tx(() => {
    for (const p of rows('projects')) {
      // legacy projects predate the kind/git fields
      const project = { kind: 'sample', git: null, ...p };
      db.sqlite
        .prepare('INSERT OR IGNORE INTO projects(id, kind, json) VALUES(?,?,?)')
        .run(String(p.id), String(project.kind), JSON.stringify(project));
    }
    for (const w of rows('workers')) {
      const worker = { readiness: null, ...w };
      db.sqlite
        .prepare('INSERT OR IGNORE INTO workers(id, json) VALUES(?,?)')
        .run(String(w.id), JSON.stringify(worker));
    }
    for (const t of rows('tasks')) {
      const task = { gitProjectId: null, activeAttemptId: null, ...t };
      db.sqlite
        .prepare('INSERT OR IGNORE INTO tasks(id, status, project_id, git_project_id, updated_at, json) VALUES(?,?,?,?,?,?)')
        .run(
          String(t.id),
          String(t.status ?? 'backlog'),
          (t.projectId as string) ?? null,
          null,
          String(t.updatedAt ?? new Date().toISOString()),
          JSON.stringify(task),
        );
    }
    for (const a of rows('approvals')) {
      const approval = {
        attemptId: null,
        projectId: null,
        workerId: null,
        baseCommit: null,
        payloadHash: null,
        expiresAt: null,
        singleUse: false,
        consumedAt: null,
        ...a,
      };
      db.sqlite
        .prepare('INSERT OR IGNORE INTO approvals(id, task_id, type, status, expires_at, json) VALUES(?,?,?,?,?,?)')
        .run(String(a.id), String(a.taskId), String(a.type), String(a.status), null, JSON.stringify(approval));
    }
    for (const h of rows('handoffs')) {
      db.sqlite
        .prepare('INSERT OR IGNORE INTO handoffs(id, task_id, json) VALUES(?,?,?)')
        .run(String(h.id), String(h.taskId), JSON.stringify(h));
    }
    for (const e of rows('events')) {
      db.sqlite
        .prepare('INSERT OR IGNORE INTO events(id, task_id, at, type, json) VALUES(?,?,?,?,?)')
        .run(String(e.id), (e.taskId as string) ?? null, String(e.at), String(e.type), JSON.stringify(e));
    }
    db.setMeta('legacy_import', `ok:${new Date().toISOString()}`);
  });
  return true;
}
