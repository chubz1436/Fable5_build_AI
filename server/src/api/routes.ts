import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { StateSnapshot, Task, TaskDraft } from '../../../shared/types';
import type { AppContext } from '../app';
import { IntakeError, parseGoal } from '../domain/intake';
import { nowIso, uid } from '../domain/util';
import { recheckGitProject, registerGitProject, updateGitProject } from '../git/projects';

/**
 * REST surface. Every mutating body is validated at runtime (zod); ids are
 * pattern-checked; git-backed tasks are dispatched through the durable
 * AttemptService while sample tasks keep the simulated engine.
 */

const ID = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const SHORT = z.string().trim().min(1).max(200);
const TEXT = z.string().trim().min(1).max(10_000);

const ParseBody = z.object({ text: TEXT, projectId: ID.optional() });
const DecisionBody = z.object({ decision: z.enum(['approve', 'reject']), note: z.string().max(2000).optional() });
const RequestStartBody = z.object({ workerId: ID.optional() }).default({});
const ReassignBody = z.object({ workerId: ID, reason: z.string().max(500).optional() });
const ValidationCommandBody = z.object({
  name: SHORT,
  argv: z.array(z.string().min(1).max(200)).min(1).max(24),
  required: z.boolean().optional(),
  timeoutMs: z.number().int().positive().max(15 * 60_000).optional(),
});
const RegisterProjectBody = z.object({
  name: SHORT.pipe(z.string().max(80)),
  repoRoot: z.string().min(2).max(500),
  baseBranch: z.string().max(120).optional(),
  validationCommands: z.array(ValidationCommandBody).max(10).optional(),
  protectedPaths: z.array(z.string().max(300)).max(50).optional(),
});
const UpdateProjectBody = z.object({
  enabled: z.boolean().optional(),
  validationCommands: z.array(ValidationCommandBody).max(10).optional(),
  protectedPaths: z.array(z.string().max(300)).max(50).optional(),
});
const CreateTaskBody = z.object({
  title: SHORT,
  goal: TEXT,
  projectId: ID,
  gitProjectId: ID.nullish(),
  risk: z.enum(['low', 'medium', 'high']).optional(),
  priority: z.enum(['p0', 'p1', 'p2', 'p3']).optional(),
  scope: z.array(z.string().max(300)).max(30).optional(),
  tags: z.array(z.string().max(40)).max(15).optional(),
  acceptanceCriteria: z.array(z.string().max(500)).max(20).optional(),
  recommendation: z.unknown().optional(),
});

function body<T extends z.ZodTypeAny>(schema: T, req: Request, res: Response): z.infer<T> | null {
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    res.status(400).json({
      error: `Validation failed: ${issue ? `${issue.path.join('.') || 'body'} — ${issue.message}` : 'invalid body'}`,
      code: 'VALIDATION',
    });
    return null;
  }
  return parsed.data;
}

function param(req: Request, res: Response, name: string): string | null {
  const value = String(req.params[name] ?? '');
  if (!ID.safeParse(value).success) {
    res.status(400).json({ error: `Invalid ${name}.`, code: 'VALIDATION' });
    return null;
  }
  return value;
}

export function createRoutes(ctx: AppContext): Router {
  const { store, engine, attempts, config } = ctx;
  const router = Router();

  const isGitTask = (taskId: string): boolean => !!store.task(taskId)?.gitProjectId;

  // -- state ------------------------------------------------------------------

  router.get('/state', (_req, res) => {
    const snapshot: StateSnapshot = {
      projects: store.projects,
      tasks: store.tasks,
      workers: store.workers,
      approvals: store.approvals,
      handoffs: store.handoffs,
      attempts: store.recentAttempts(100),
      events: store.recentEvents(250),
      system: ctx.systemStatus(),
    };
    res.json(snapshot);
  });

  // -- intake -----------------------------------------------------------------

  router.post('/tasks/parse', (req, res) => {
    const input = body(ParseBody, req, res);
    if (!input) return;
    const draft = parseGoal(input.text, store.projects, store.workers, input.projectId);
    res.json(draft);
  });

  router.post('/tasks', (req, res) => {
    const input = body(CreateTaskBody, req, res);
    if (!input) return;

    let gitProjectId: string | null = null;
    let projectId = input.projectId;
    const target = store.project(input.gitProjectId ?? input.projectId);
    if (!target) throw new IntakeError(`Unknown project: ${input.gitProjectId ?? input.projectId}`);
    if (target.kind === 'git') {
      if (!target.git?.enabled) throw new IntakeError(`Project “${target.name}” is disabled.`);
      gitProjectId = target.id;
      projectId = target.id;
    }

    const draft = input as unknown as TaskDraft;
    const task: Task = {
      id: uid('task'),
      title: input.title,
      goal: input.goal,
      projectId,
      status: 'ready',
      risk: input.risk ?? 'medium',
      priority: input.priority ?? 'p2',
      scope: input.scope?.length ? input.scope : ['src/'],
      tags: input.tags?.length ? input.tags : ['feature'],
      acceptanceCriteria: (input.acceptanceCriteria ?? []).map((text) => ({ id: uid('ac'), text, met: null })),
      assignedWorkerId: null,
      recommendation: (draft.recommendation as Task['recommendation']) ?? null,
      attempts: 0,
      progress: 0,
      phase: null,
      blockReason: null,
      runPlan: null,
      evidence: null,
      handoffIds: [],
      gitProjectId,
      activeAttemptId: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      startedAt: null,
      completedAt: null,
    };
    store.upsertTask(task);
    store.addEvent({
      type: 'task.created',
      taskId: task.id,
      message: `Task created: “${task.title}” (${task.risk} risk, ${task.priority}${gitProjectId ? `, repository-backed on “${target.name}”` : ''})`,
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

  // -- task detail --------------------------------------------------------------

  router.get('/tasks/:id', (req, res) => {
    const id = param(req, res, 'id');
    if (!id) return;
    const task = store.task(id);
    if (!task) {
      res.status(404).json({ error: 'Task not found', code: 'NOT_FOUND' });
      return;
    }
    const taskAttempts = store.attemptsForTask(id);
    res.json({
      task,
      events: store.eventsForTask(task.id),
      approvals: store.approvalsForTask(task.id),
      handoffs: store.handoffsForTask(task.id),
      attempts: taskAttempts,
      operations: task.activeAttemptId ? store.operationsForAttempt(task.activeAttemptId) : [],
    });
  });

  // -- owner actions --------------------------------------------------------------

  router.post('/tasks/:id/promote', (req, res) => {
    const id = param(req, res, 'id');
    if (!id) return;
    res.json(engine.promote(id));
  });

  router.post('/tasks/:id/request-start', async (req, res) => {
    const id = param(req, res, 'id');
    if (!id) return;
    const input = body(RequestStartBody, req, res);
    if (!input) return;
    if (isGitTask(id)) {
      res.json(await attempts.requestStart(id, input.workerId));
    } else {
      res.json(engine.requestStart(id, input.workerId));
    }
  });

  router.post('/tasks/:id/pause', (req, res) => {
    const id = param(req, res, 'id');
    if (!id) return;
    if (isGitTask(id)) {
      res.status(409).json({ error: 'Repository attempts cannot be paused — cancel or let the attempt finish.', code: 'UNSUPPORTED' });
      return;
    }
    res.json(engine.pause(id));
  });

  router.post('/tasks/:id/resume', (req, res) => {
    const id = param(req, res, 'id');
    if (!id) return;
    if (isGitTask(id)) {
      res.status(409).json({ error: 'Repository attempts cannot be paused/resumed.', code: 'UNSUPPORTED' });
      return;
    }
    res.json(engine.resume(id));
  });

  router.post('/tasks/:id/cancel', (req, res) => {
    const id = param(req, res, 'id');
    if (!id) return;
    res.json(isGitTask(id) ? attempts.cancel(id) : engine.cancel(id));
  });

  router.post('/tasks/:id/retry', async (req, res) => {
    const id = param(req, res, 'id');
    if (!id) return;
    if (isGitTask(id)) {
      // a retry is a NEW attempt and therefore needs a NEW exact approval
      const task = store.task(id)!;
      res.json(await attempts.requestStart(id, task.assignedWorkerId ?? undefined));
    } else {
      res.json(engine.retry(id));
    }
  });

  router.post('/tasks/:id/reassign', (req, res) => {
    const id = param(req, res, 'id');
    if (!id) return;
    const input = body(ReassignBody, req, res);
    if (!input) return;
    if (isGitTask(id)) {
      res.status(409).json({
        error: 'Reassignment of repository attempts is not supported in this release — retry with a new approval instead.',
        code: 'UNSUPPORTED',
      });
      return;
    }
    res.json(engine.reassign(id, input.workerId, input.reason));
  });

  router.post('/approvals/:id/decision', async (req, res) => {
    const id = param(req, res, 'id');
    if (!id) return;
    const input = body(DecisionBody, req, res);
    if (!input) return;
    const approval = store.approval(id);
    if (!approval) {
      res.status(404).json({ error: 'Approval not found', code: 'NOT_FOUND' });
      return;
    }
    if (isGitTask(approval.taskId)) {
      res.json(await attempts.decide(id, input.decision, input.note));
    } else {
      res.json(engine.decideApproval(id, input.decision, input.note));
    }
  });

  // -- git project registry (P0.2) ---------------------------------------------------

  router.post('/projects/register', async (req, res) => {
    const input = body(RegisterProjectBody, req, res);
    if (!input) return;
    res.status(201).json(await registerGitProject(store, config, input));
  });

  router.post('/projects/:id/recheck', async (req, res) => {
    const id = param(req, res, 'id');
    if (!id) return;
    res.json(await recheckGitProject(store, config, id));
  });

  router.patch('/projects/:id', (req, res) => {
    const id = param(req, res, 'id');
    if (!id) return;
    const input = body(UpdateProjectBody, req, res);
    if (!input) return;
    res.json(updateGitProject(store, config, id, input));
  });

  // -- attempts ------------------------------------------------------------------------

  router.get('/attempts/:id', (req, res) => {
    const id = param(req, res, 'id');
    if (!id) return;
    const attempt = store.attempt(id);
    if (!attempt) {
      res.status(404).json({ error: 'Attempt not found', code: 'NOT_FOUND' });
      return;
    }
    res.json({ attempt, operations: store.operationsForAttempt(id) });
  });

  router.post('/attempts/:id/revalidate', async (req, res) => {
    const id = param(req, res, 'id');
    if (!id) return;
    res.json(await attempts.revalidate(id));
  });

  router.post('/attempts/:id/cleanup', async (req, res) => {
    const id = param(req, res, 'id');
    if (!id) return;
    res.json(await attempts.cleanupWorktree(id));
  });

  // -- misc -------------------------------------------------------------------

  router.get('/health', (_req, res) => {
    res.json({ ok: true, version: config.version });
  });

  return router;
}
