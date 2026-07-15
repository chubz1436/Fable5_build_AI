import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type {
  Approval,
  EventRecord,
  EventLevel,
  Handoff,
  Project,
  StreamMessage,
  Task,
  WorkerProfile,
} from '../../../shared/types';
import { nowIso, uid } from '../domain/util';

/** Everything that gets persisted to disk. */
export interface DbShape {
  schemaVersion: number;
  projects: Project[];
  tasks: Task[];
  workers: WorkerProfile[];
  approvals: Approval[];
  handoffs: Handoff[];
  events: EventRecord[];
}

const SCHEMA_VERSION = 1;
const MAX_EVENTS = 3000;
const SAVE_DEBOUNCE_MS = 120;

/**
 * Local-first persistence: a single JSON document written atomically
 * (tmp file + rename) with debounced saves. Adequate for a single-owner
 * desktop tool; the public surface is repository-like so a SQLite backend
 * could replace it without touching callers.
 *
 * Every mutation also broadcasts a StreamMessage so SSE clients stay live.
 */
export class Store {
  readonly emitter = new EventEmitter();
  private db: DbShape;
  private saveTimer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor(private readonly dataFile: string) {
    this.db = this.loadOrInit();
  }

  // -- persistence ----------------------------------------------------------

  private loadOrInit(): DbShape {
    if (fs.existsSync(this.dataFile)) {
      const raw = fs.readFileSync(this.dataFile, 'utf8');
      const parsed = JSON.parse(raw) as DbShape;
      if (parsed.schemaVersion !== SCHEMA_VERSION) {
        throw new Error(
          `Data file ${this.dataFile} has schema v${parsed.schemaVersion}, expected v${SCHEMA_VERSION}. ` +
            'Move the file aside to start fresh.',
        );
      }
      return parsed;
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      projects: [],
      tasks: [],
      workers: [],
      approvals: [],
      handoffs: [],
      events: [],
    };
  }

  get isEmpty(): boolean {
    return this.db.projects.length === 0 && this.db.workers.length === 0;
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flushSync();
    }, SAVE_DEBOUNCE_MS);
    this.saveTimer.unref?.();
  }

  /** Write to disk immediately (atomic tmp+rename). */
  flushSync(): void {
    if (!this.dirty) return;
    this.dirty = false;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
    const tmp = `${this.dataFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.db, null, 1), 'utf8');
    fs.renameSync(tmp, this.dataFile);
  }

  private broadcast(message: StreamMessage): void {
    this.emitter.emit('message', message);
  }

  // -- reads ----------------------------------------------------------------

  get projects(): Project[] { return this.db.projects; }
  get tasks(): Task[] { return this.db.tasks; }
  get workers(): WorkerProfile[] { return this.db.workers; }
  get approvals(): Approval[] { return this.db.approvals; }
  get handoffs(): Handoff[] { return this.db.handoffs; }

  project(id: string): Project | undefined {
    return this.db.projects.find((p) => p.id === id);
  }
  task(id: string): Task | undefined {
    return this.db.tasks.find((t) => t.id === id);
  }
  worker(id: string): WorkerProfile | undefined {
    return this.db.workers.find((w) => w.id === id);
  }
  approval(id: string): Approval | undefined {
    return this.db.approvals.find((a) => a.id === id);
  }
  handoff(id: string): Handoff | undefined {
    return this.db.handoffs.find((h) => h.id === id);
  }

  /** newest first */
  recentEvents(limit = 200): EventRecord[] {
    return this.db.events.slice(-limit).reverse();
  }

  eventsForTask(taskId: string): EventRecord[] {
    return this.db.events.filter((e) => e.taskId === taskId);
  }

  approvalsForTask(taskId: string): Approval[] {
    return this.db.approvals.filter((a) => a.taskId === taskId);
  }

  handoffsForTask(taskId: string): Handoff[] {
    return this.db.handoffs.filter((h) => h.taskId === taskId);
  }

  // -- writes ---------------------------------------------------------------

  upsertProject(project: Project): Project {
    const i = this.db.projects.findIndex((p) => p.id === project.id);
    if (i >= 0) this.db.projects[i] = project;
    else this.db.projects.push(project);
    this.scheduleSave();
    return project;
  }

  upsertTask(task: Task): Task {
    task.updatedAt = nowIso();
    const i = this.db.tasks.findIndex((t) => t.id === task.id);
    if (i >= 0) this.db.tasks[i] = task;
    else this.db.tasks.push(task);
    this.scheduleSave();
    this.broadcast({ kind: 'task', task });
    return task;
  }

  upsertWorker(worker: WorkerProfile): WorkerProfile {
    const i = this.db.workers.findIndex((w) => w.id === worker.id);
    if (i >= 0) this.db.workers[i] = worker;
    else this.db.workers.push(worker);
    this.scheduleSave();
    this.broadcast({ kind: 'worker', worker });
    return worker;
  }

  upsertApproval(approval: Approval): Approval {
    const i = this.db.approvals.findIndex((a) => a.id === approval.id);
    if (i >= 0) this.db.approvals[i] = approval;
    else this.db.approvals.push(approval);
    this.scheduleSave();
    this.broadcast({ kind: 'approval', approval });
    return approval;
  }

  addHandoff(handoff: Handoff): Handoff {
    this.db.handoffs.push(handoff);
    this.scheduleSave();
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
    this.db.events.push(event);
    if (this.db.events.length > MAX_EVENTS) {
      this.db.events.splice(0, this.db.events.length - MAX_EVENTS);
    }
    this.scheduleSave();
    this.broadcast({ kind: 'event', event });
    return event;
  }
}
