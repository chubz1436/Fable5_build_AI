import { Router } from 'express';
import type {
  StateSnapshot,
  Task,
  TaskDraft,
} from '../../../shared/types';
import type { AppContext } from '../app';
import { IntakeError, parseGoal } from '../domain/intake';
import { nowIso, uid } from '../domain/util';

export function createRoutes(ctx: AppContext): Router {
  const { store, engine, config } = ctx;
  const router = Router();

  // -- state ------------------------------------------------------------------

  router.get('/state', (_req, res) => {
    const snapshot: StateSnapshot = {
      projects: store.projects,
      tasks: store.tasks,
      workers: store.workers,
      approvals: store.approvals,
      handoffs: store.handoffs,
      events: store.recentEvents(250),
      system: ctx.systemStatus(),
    };
    res.json(snapshot);
  });

  // -- intake -----------------------------------------------------------------

  /** Parse a natural-language goal into a structured draft (no side effects). */
  router.post('/tasks/parse', (req, res) => {
    const { text, projectId } = req.body as { text?: string; projectId?: string };
    if (!text?.trim()) throw new IntakeError('Provide a goal in "text".');
    const draft = parseGoal(text, store.projects, store.workers, projectId);
    res.json(draft);
  });

  /** Create a task from a (possibly owner-edited) draft. */
  router.post('/tasks', (req, res) => {
    const draft = req.body as TaskDraft;
    if (!draft?.goal?.trim() || !draft?.title?.trim()) {
      throw new IntakeError('Draft needs at least "title" and "goal".');
    }
    const project = store.project(draft.projectId);
    if (!project) throw new IntakeError(`Unknown project: ${draft.projectId}`);

    const task: Task = {
      id: uid('task'),
      title: draft.title.trim(),
      goal: draft.goal.trim(),
      projectId: project.id,
      status: 'ready',
      risk: draft.risk ?? 'medium',
      priority: draft.priority ?? 'p2',
      scope: draft.scope?.length ? draft.scope : ['src/'],
      tags: draft.tags?.length ? draft.tags : ['feature'],
      acceptanceCriteria: (draft.acceptanceCriteria ?? []).map((text) => ({
        id: uid('ac'),
        text,
        met: null,
      })),
      assignedWorkerId: null,
      recommendation: draft.recommendation ?? null,
      attempts: 0,
      progress: 0,
      phase: null,
      blockReason: null,
      runPlan: null,
      evidence: null,
      handoffIds: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
      startedAt: null,
      completedAt: null,
    };
    store.upsertTask(task);
    store.addEvent({
      type: 'task.created',
      taskId: task.id,
      message: `Task created: “${task.title}” (${task.risk} risk, ${task.priority})`,
    });
    if (task.recommendation) {
      const rec = store.worker(task.recommendation.workerId);
      store.addEvent({
        type: 'worker.recommended',
        taskId: task.id,
        workerId: task.recommendation.workerId,
        message: `${rec?.name ?? 'Worker'} recommended — ${task.recommendation.reasons[0] ?? 'best score'}`,
      });
    }
    res.status(201).json(task);
  });

  /** Task detail: task + its events, approvals and handoffs. */
  router.get('/tasks/:id', (req, res) => {
    const task = store.task(req.params.id);
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    res.json({
      task,
      events: store.eventsForTask(task.id),
      approvals: store.approvalsForTask(task.id),
      handoffs: store.handoffsForTask(task.id),
    });
  });

  // -- owner actions ------------------------------------------------------------

  router.post('/tasks/:id/promote', (req, res) => {
    res.json(engine.promote(req.params.id));
  });

  router.post('/tasks/:id/request-start', (req, res) => {
    const { workerId } = (req.body ?? {}) as { workerId?: string };
    res.json(engine.requestStart(req.params.id, workerId));
  });

  router.post('/tasks/:id/pause', (req, res) => {
    res.json(engine.pause(req.params.id));
  });

  router.post('/tasks/:id/resume', (req, res) => {
    res.json(engine.resume(req.params.id));
  });

  router.post('/tasks/:id/cancel', (req, res) => {
    res.json(engine.cancel(req.params.id));
  });

  router.post('/tasks/:id/retry', (req, res) => {
    res.json(engine.retry(req.params.id));
  });

  router.post('/tasks/:id/reassign', (req, res) => {
    const { workerId, reason } = (req.body ?? {}) as { workerId?: string; reason?: string };
    if (!workerId) {
      res.status(400).json({ error: 'workerId is required' });
      return;
    }
    res.json(engine.reassign(req.params.id, workerId, reason));
  });

  router.post('/approvals/:id/decision', (req, res) => {
    const { decision, note } = (req.body ?? {}) as {
      decision?: 'approve' | 'reject';
      note?: string;
    };
    if (decision !== 'approve' && decision !== 'reject') {
      res.status(400).json({ error: 'decision must be "approve" or "reject"' });
      return;
    }
    res.json(engine.decideApproval(req.params.id, decision, note));
  });

  // -- misc -------------------------------------------------------------------

  router.get('/health', (_req, res) => {
    res.json({ ok: true, version: config.version });
  });

  return router;
}
