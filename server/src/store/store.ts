import { EventEmitter } from 'node:events';
import type {
  Approval,
  Attempt,
  EventRecord,
  EventLevel,
  Handoff,
  Lease,
  LeaseKind,
  OperationRecord,
  Project,
  StreamMessage,
  Task,
  WorkerProfile,
} from '../../../shared/types';
import { ACTIVE_ATTEMPT_STATES } from '../../../shared/types';
import { nowIso, uid } from '../domain/util';
import { Db, isUniqueViolation } from '../db/db';

const MAX_EVENTS = 5000;

/** Raised when a lease or uniqueness guarantee blocks an action. */
export class ConflictError extends Error {
  readonly statusCode = 409;
  constructor(
    message: string,
    readonly conflict: { kind: string; resourceKey: string } | null = null,
  ) {
    super(message);
  }
}

/**
 * Repository facade over SQLite (WAL). The single authoritative state store.
 * Every mutation is durable immediately and broadcast to SSE subscribers.
 */
export class Store {
  readonly emitter = new EventEmitter();
  private eventInserts = 0;
  /** SSE messages produced inside an open transaction (P0-6) */
  private txBuffer: StreamMessage[] = [];

  constructor(readonly db: Db) {
    // Broadcasts describing uncommitted writes are held back until the
    // outermost COMMIT succeeds; a ROLLBACK discards them so subscribers
    // never observe phantom state (P0-6).
    db.onTxEnd = (committed) => {
      const buffered = this.txBuffer;
      this.txBuffer = [];
      if (!committed) return;
      for (const message of buffered) this.emitter.emit('message', message);
    };
  }

  private broadcast(message: StreamMessage): void {
    if (this.db.inTransaction) {
      this.txBuffer.push(message);
      return;
    }
    this.emitter.emit('message', message);
  }

  /** run fn atomically (BEGIN IMMEDIATE) */
  tx<T>(fn: () => T): T {
    return this.db.tx(fn);
  }

  get isEmpty(): boolean {
    const row = this.db.sqlite.prepare('SELECT COUNT(*) AS n FROM workers').get() as { n: number };
    return row.n === 0;
  }

  /** kept for API compatibility — SQLite writes are already durable */
  flushSync(): void {}

  close(): void {
    this.db.close();
  }

  // -- generic helpers --------------------------------------------------------

  private allJson<T>(sql: string, ...params: Array<string | number>): T[] {
    return (this.db.sqlite.prepare(sql).all(...params) as Array<{ json: string }>).map((r) =>
      JSON.parse(r.json),
    );
  }

  private oneJson<T>(sql: string, ...params: Array<string | number>): T | undefined {
    const row = this.db.sqlite.prepare(sql).get(...params) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as T) : undefined;
  }

  // -- reads ------------------------------------------------------------------

  get projects(): Project[] {
    return this.allJson('SELECT json FROM projects ORDER BY rowid');
  }
  get tasks(): Task[] {
    return this.allJson('SELECT json FROM tasks ORDER BY rowid');
  }
  get workers(): WorkerProfile[] {
    return this.allJson('SELECT json FROM workers ORDER BY rowid');
  }
  get approvals(): Approval[] {
    return this.allJson('SELECT json FROM approvals ORDER BY rowid');
  }
  get handoffs(): Handoff[] {
    return this.allJson('SELECT json FROM handoffs ORDER BY rowid');
  }

  project(id: string): Project | undefined {
    return this.oneJson('SELECT json FROM projects WHERE id = ?', id);
  }
  task(id: string): Task | undefined {
    return this.oneJson('SELECT json FROM tasks WHERE id = ?', id);
  }
  worker(id: string): WorkerProfile | undefined {
    return this.oneJson('SELECT json FROM workers WHERE id = ?', id);
  }
  approval(id: string): Approval | undefined {
    return this.oneJson('SELECT json FROM approvals WHERE id = ?', id);
  }
  handoff(id: string): Handoff | undefined {
    return this.oneJson('SELECT json FROM handoffs WHERE id = ?', id);
  }

  /** newest first */
  recentEvents(limit = 200): EventRecord[] {
    const capped = Math.max(1, Math.min(1000, limit));
    return this.allJson('SELECT json FROM events ORDER BY seq DESC LIMIT ?', capped);
  }

  /** oldest first */
  eventsForTask(taskId: string, limit = 2000): EventRecord[] {
    return this.allJson(
      'SELECT json FROM events WHERE task_id = ? ORDER BY seq ASC LIMIT ?',
      taskId,
      Math.max(1, Math.min(5000, limit)),
    );
  }

  approvalsForTask(taskId: string): Approval[] {
    return this.allJson('SELECT json FROM approvals WHERE task_id = ? ORDER BY rowid', taskId);
  }

  handoffsForTask(taskId: string): Handoff[] {
    return this.allJson('SELECT json FROM handoffs WHERE task_id = ? ORDER BY rowid', taskId);
  }

  // -- writes -----------------------------------------------------------------

  upsertProject(project: Project): Project {
    this.db.sqlite
      .prepare(
        'INSERT INTO projects(id, kind, json) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, json = excluded.json',
      )
      .run(project.id, project.kind, JSON.stringify(project));
    this.broadcast({ kind: 'project', project });
    return project;
  }

  upsertTask(task: Task): Task {
    task.updatedAt = nowIso();
    this.db.sqlite
      .prepare(
        'INSERT INTO tasks(id, status, project_id, git_project_id, updated_at, json) VALUES(?,?,?,?,?,?) ' +
          'ON CONFLICT(id) DO UPDATE SET status = excluded.status, project_id = excluded.project_id, ' +
          'git_project_id = excluded.git_project_id, updated_at = excluded.updated_at, json = excluded.json',
      )
      .run(task.id, task.status, task.projectId, task.gitProjectId ?? null, task.updatedAt, JSON.stringify(task));
    this.broadcast({ kind: 'task', task });
    return task;
  }

  upsertWorker(worker: WorkerProfile): WorkerProfile {
    this.db.sqlite
      .prepare('INSERT INTO workers(id, json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json = excluded.json')
      .run(worker.id, JSON.stringify(worker));
    this.broadcast({ kind: 'worker', worker });
    return worker;
  }

  upsertApproval(approval: Approval): Approval {
    this.db.sqlite
      .prepare(
        'INSERT INTO approvals(id, task_id, type, status, expires_at, json) VALUES(?,?,?,?,?,?) ' +
          'ON CONFLICT(id) DO UPDATE SET status = excluded.status, expires_at = excluded.expires_at, json = excluded.json',
      )
      .run(approval.id, approval.taskId, approval.type, approval.status, approval.expiresAt ?? null, JSON.stringify(approval));
    this.broadcast({ kind: 'approval', approval });
    return approval;
  }

  addHandoff(handoff: Handoff): Handoff {
    this.db.sqlite
      .prepare('INSERT INTO handoffs(id, task_id, json) VALUES(?,?,?)')
      .run(handoff.id, handoff.taskId, JSON.stringify(handoff));
    this.broadcast({ kind: 'handoff', handoff });
    return handoff;
  }

  addEvent(input: {
    type: string;
    message: string;
    level?: EventLevel;
    taskId?: string;
    workerId?: string;
    approvalId?: string;
    data?: Record<string, unknown>;
  }): EventRecord {
    const event: EventRecord = {
      id: uid('evt'),
      at: nowIso(),
      level: input.level ?? 'info',
      type: input.type,
      message: input.message,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.workerId ? { workerId: input.workerId } : {}),
      ...(input.approvalId ? { approvalId: input.approvalId } : {}),
      ...(input.data ? { data: input.data } : {}),
    };
    this.db.sqlite
      .prepare('INSERT INTO events(id, task_id, at, type, json) VALUES(?,?,?,?,?)')
      .run(event.id, event.taskId ?? null, event.at, event.type, JSON.stringify(event));

    // append-oriented log with a bounded tail
    if (++this.eventInserts % 200 === 0) {
      this.db.sqlite.exec(
        `DELETE FROM events WHERE seq <= (SELECT MAX(seq) FROM events) - ${MAX_EVENTS}`,
      );
    }
    this.broadcast({ kind: 'event', event });
    return event;
  }

  // -- attempts ---------------------------------------------------------------

  attempt(id: string): Attempt | undefined {
    return this.oneJson('SELECT json FROM attempts WHERE id = ?', id);
  }

  attemptsForTask(taskId: string): Attempt[] {
    return this.allJson('SELECT json FROM attempts WHERE task_id = ? ORDER BY rowid', taskId);
  }

  recentAttempts(limit = 100): Attempt[] {
    return this.allJson('SELECT json FROM attempts ORDER BY rowid DESC LIMIT ?', limit);
  }

  activeAttempts(): Attempt[] {
    const placeholders = ACTIVE_ATTEMPT_STATES.map(() => '?').join(',');
    return this.allJson(
      `SELECT json FROM attempts WHERE state IN (${placeholders}) ORDER BY rowid`,
      ...ACTIVE_ATTEMPT_STATES,
    );
  }

  /** insert-only; throws ConflictError when the task already has an active attempt */
  insertAttempt(attempt: Attempt): Attempt {
    try {
      this.db.sqlite
        .prepare('INSERT INTO attempts(id, task_id, state, worker_id, git_project_id, started_at, json) VALUES(?,?,?,?,?,?,?)')
        .run(attempt.id, attempt.taskId, attempt.state, attempt.workerId, attempt.projectId, attempt.startedAt, JSON.stringify(attempt));
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictError(`Task ${attempt.taskId} already has an active attempt.`, {
          kind: 'attempt',
          resourceKey: attempt.taskId,
        });
      }
      throw err;
    }
    this.broadcast({ kind: 'attempt', attempt });
    return attempt;
  }

  updateAttempt(attempt: Attempt): Attempt {
    this.db.sqlite
      .prepare('UPDATE attempts SET state = ?, json = ? WHERE id = ?')
      .run(attempt.state, JSON.stringify(attempt), attempt.id);
    this.broadcast({ kind: 'attempt', attempt });
    return attempt;
  }

  // -- operations ---------------------------------------------------------------

  /** insert-only; the unique idempotency key blocks duplicate consequences */
  insertOperation(op: OperationRecord): OperationRecord {
    try {
      this.db.sqlite
        .prepare('INSERT INTO operations(id, attempt_id, kind, idempotency_key, status, started_at, json) VALUES(?,?,?,?,?,?,?)')
        .run(op.id, op.attemptId, op.kind, op.idempotencyKey, op.status, op.startedAt, JSON.stringify(op));
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictError(`Duplicate operation: ${op.kind} (${op.idempotencyKey}) was already dispatched.`, {
          kind: 'operation',
          resourceKey: op.idempotencyKey,
        });
      }
      throw err;
    }
    return op;
  }

  updateOperation(op: OperationRecord): OperationRecord {
    this.db.sqlite
      .prepare('UPDATE operations SET status = ?, json = ? WHERE id = ?')
      .run(op.status, JSON.stringify(op), op.id);
    return op;
  }

  operationsForAttempt(attemptId: string): OperationRecord[] {
    return this.allJson('SELECT json FROM operations WHERE attempt_id = ? ORDER BY rowid', attemptId);
  }

  // -- leases -----------------------------------------------------------------

  /**
   * Atomically acquire every requested lease or none. Expired leases held by
   * non-active attempts are reaped first. Throws ConflictError naming the
   * first blocking resource.
   */
  acquireLeases(
    attemptId: string,
    wants: Array<{ kind: LeaseKind; resourceKey: string }>,
    ttlMs: number,
  ): Lease[] {
    return this.tx(() => {
      this.reapExpiredLeases();
      const acquired: Lease[] = [];
      for (const want of wants) {
        const lease: Lease = {
          id: uid('lease'),
          kind: want.kind,
          resourceKey: want.resourceKey,
          attemptId,
          acquiredAt: nowIso(),
          expiresAt: new Date(Date.now() + ttlMs).toISOString(),
          releasedAt: null,
        };
        try {
          this.db.sqlite
            .prepare('INSERT INTO leases(id, kind, resource_key, attempt_id, acquired_at, expires_at, released_at) VALUES(?,?,?,?,?,?,NULL)')
            .run(lease.id, lease.kind, lease.resourceKey, lease.attemptId, lease.acquiredAt, lease.expiresAt);
        } catch (err) {
          if (isUniqueViolation(err)) {
            const holder = this.db.sqlite
              .prepare('SELECT attempt_id FROM leases WHERE kind = ? AND resource_key = ? AND released_at IS NULL')
              .get(want.kind, want.resourceKey) as { attempt_id: string } | undefined;
            throw new ConflictError(
              `${want.kind} "${want.resourceKey}" is locked by attempt ${holder?.attempt_id ?? 'unknown'}.`,
              { kind: want.kind, resourceKey: want.resourceKey },
            );
          }
          throw err;
        }
        acquired.push(lease);
      }
      return acquired;
    });
  }

  renewLeases(attemptId: string, ttlMs: number): void {
    this.db.sqlite
      .prepare('UPDATE leases SET expires_at = ? WHERE attempt_id = ? AND released_at IS NULL')
      .run(new Date(Date.now() + ttlMs).toISOString(), attemptId);
  }

  releaseLeases(attemptId: string): void {
    this.db.sqlite
      .prepare('UPDATE leases SET released_at = ? WHERE attempt_id = ? AND released_at IS NULL')
      .run(nowIso(), attemptId);
  }

  activeLeases(): Lease[] {
    const rows = this.db.sqlite
      .prepare('SELECT id, kind, resource_key, attempt_id, acquired_at, expires_at, released_at FROM leases WHERE released_at IS NULL')
      .all() as Array<Record<string, string | null>>;
    return rows.map((r) => ({
      id: String(r.id),
      kind: r.kind as LeaseKind,
      resourceKey: String(r.resource_key),
      attemptId: String(r.attempt_id),
      acquiredAt: String(r.acquired_at),
      expiresAt: String(r.expires_at),
      releasedAt: r.released_at ?? null,
    }));
  }

  /** release leases whose expiry passed AND whose holder attempt is no longer active */
  reapExpiredLeases(): number {
    const now = nowIso();
    const placeholders = ACTIVE_ATTEMPT_STATES.map(() => '?').join(',');
    const result = this.db.sqlite
      .prepare(
        `UPDATE leases SET released_at = ? WHERE released_at IS NULL AND expires_at < ? ` +
          `AND attempt_id NOT IN (SELECT id FROM attempts WHERE state IN (${placeholders}))`,
      )
      .run(now, now, ...ACTIVE_ATTEMPT_STATES);
    return Number(result.changes);
  }
}
