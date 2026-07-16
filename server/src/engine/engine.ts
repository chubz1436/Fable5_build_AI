import type {
  Approval,
  EventLevel,
  Handoff,
  RunStep,
  Task,
  WorkerProfile,
} from '../../../shared/types';
import type { AppConfig } from '../config';
import { buildHandoff } from '../domain/handoff';
import { assertTransition, LifecycleError, TERMINAL_STATUSES } from '../domain/lifecycle';
import { recommendWorker } from '../domain/recommend';
import { nowIso, uid } from '../domain/util';
import path from 'node:path';
import type { Store } from '../store/store';
import { AntigravityAdapter } from './adapters/antigravity';
import { ClaudeCodeAdapter } from './adapters/claude-code';
import { detectCli } from './adapters/cli-common';
import { CodexAdapter } from './adapters/codex';
import { SimulatedAdapter } from './adapters/simulated';
import type { RunContext, RunResult, WorkerAdapter } from './adapters/types';

/**
 * The orchestrator. Owns every task/worker state change; adapters only
 * report what is happening through their RunContext. Routes call into the
 * engine for anything with side effects.
 */
export class Engine {
  private adapters = new Map<string, WorkerAdapter>();
  /** taskId → attempt number of the currently active run */
  private activeRuns = new Map<string, number>();
  /** approvalId → resolver for a mid-run approval gate */
  private midrunResolvers = new Map<string, (approved: boolean) => void>();

  constructor(
    private readonly store: Store,
    private readonly config: AppConfig,
  ) {
    const workspaceRoot = path.join(path.dirname(config.dataFile), 'workspaces');
    this.adapters.set('simulated', new SimulatedAdapter());
    this.adapters.set(
      'claude-code',
      new ClaudeCodeAdapter({
        command: config.claudeCommand,
        timeoutMs: config.claudeTimeoutMs,
        workspaceRoot,
      }),
    );
    this.adapters.set(
      'codex',
      new CodexAdapter({
        command: config.codexCommand,
        timeoutMs: config.codexTimeoutMs,
        workspaceRoot,
        model: config.codexModel,
      }),
    );
    this.adapters.set(
      'antigravity',
      new AntigravityAdapter({
        command: config.antigravityCommand,
        timeoutMs: config.antigravityTimeoutMs,
        workspaceRoot,
        model: config.antigravityModel,
        skipPermissions: config.antigravitySkipPermissions,
      }),
    );
  }

  // -- helpers ----------------------------------------------------------------

  private mustTask(taskId: string): Task {
    const task = this.store.task(taskId);
    if (!task) throw new NotFoundError(`Task ${taskId} not found`);
    return task;
  }

  private mustWorker(workerId: string): WorkerProfile {
    const worker = this.store.worker(workerId);
    if (!worker) throw new NotFoundError(`Worker ${workerId} not found`);
    return worker;
  }

  private adapterFor(worker: WorkerProfile): WorkerAdapter {
    const adapter = this.adapters.get(worker.adapter);
    if (!adapter) throw new Error(`No adapter registered for kind "${worker.adapter}"`);
    return adapter;
  }

  private freeWorker(workerId: string | null): void {
    if (!workerId) return;
    const worker = this.store.worker(workerId);
    if (!worker) return;
    worker.availability = 'idle';
    worker.currentTaskId = null;
    this.store.upsertWorker(worker);
  }

  // -- owner actions ----------------------------------------------------------

  /** backlog → ready */
  promote(taskId: string): Task {
    const task = this.mustTask(taskId);
    assertTransition(task.status, 'ready');
    task.status = 'ready';
    this.store.upsertTask(task);
    this.store.addEvent({
      type: 'task.ready',
      taskId: task.id,
      message: `“${task.title}” moved to Ready`,
    });
    return task;
  }

  /**
   * ready → awaiting_approval. Assigns the chosen (or recommended) worker
   * and creates a start-approval request for the owner.
   */
  requestStart(taskId: string, workerId?: string): { task: Task; approval: Approval } {
    const task = this.mustTask(taskId);
    assertTransition(task.status, 'awaiting_approval');

    if (!task.recommendation) {
      task.recommendation = recommendWorker(
        { tags: task.tags, risk: task.risk, priority: task.priority },
        this.store.workers,
      );
    }
    const worker = this.mustWorker(workerId ?? task.recommendation.workerId);
    task.assignedWorkerId = worker.id;
    task.status = 'awaiting_approval';
    this.store.upsertTask(task);

    const approval: Approval = {
      id: uid('appr'),
      taskId: task.id,
      type: 'start',
      title: `Start “${task.title}”`,
      description:
        `${worker.name} (${worker.model}) will start executing this task in an isolated workspace. ` +
        `Scope: ${task.scope.join(', ')}. Risk: ${task.risk}.` +
        (task.risk === 'high'
          ? ' High-risk steps will pause again for a separate approval.'
          : ''),
      risk: task.risk,
      affectedScope: task.scope,
      recommendedAction: 'approve',
      recommendationReason:
        task.recommendation.workerId === worker.id
          ? `Routing engine recommends ${worker.name}: ${task.recommendation.reasons.join('; ')}`
          : `Owner override — routing engine had recommended a different worker.`,
      status: 'pending',
      createdAt: nowIso(),
      decidedAt: null,
      decisionNote: null,
    };
    this.store.upsertApproval(approval);
    this.store.addEvent({
      type: 'approval.requested',
      taskId: task.id,
      workerId: worker.id,
      approvalId: approval.id,
      message: `Approval requested: start “${task.title}” with ${worker.name}`,
    });
    return { task, approval };
  }

  /** Owner decides any pending approval (start / midrun / completion). */
  decideApproval(approvalId: string, decision: 'approve' | 'reject', note?: string): Approval {
    const approval = this.store.approval(approvalId);
    if (!approval) throw new NotFoundError(`Approval ${approvalId} not found`);
    if (approval.status !== 'pending') {
      throw new LifecycleError(`Approval already ${approval.status}`);
    }
    const task = this.mustTask(approval.taskId);

    approval.status = decision === 'approve' ? 'approved' : 'rejected';
    approval.decidedAt = nowIso();
    approval.decisionNote = note ?? null;
    this.store.upsertApproval(approval);
    this.store.addEvent({
      type: decision === 'approve' ? 'approval.approved' : 'approval.rejected',
      level: decision === 'approve' ? 'success' : 'warning',
      taskId: task.id,
      approvalId: approval.id,
      message:
        `Owner ${decision === 'approve' ? 'approved' : 'rejected'}: ${approval.title}` +
        (note ? ` — “${note}”` : ''),
    });

    switch (approval.type) {
      case 'start':
        if (decision === 'approve') {
          this.startRun(task);
        } else {
          assertTransition(task.status, 'ready');
          task.status = 'ready';
          task.assignedWorkerId = null;
          this.store.upsertTask(task);
        }
        break;

      case 'midrun': {
        const resolve = this.midrunResolvers.get(approval.id);
        this.midrunResolvers.delete(approval.id);
        resolve?.(decision === 'approve');
        break;
      }

      case 'completion':
        if (decision === 'approve') {
          assertTransition(task.status, 'completed');
          task.status = 'completed';
          task.completedAt = nowIso();
          if (task.evidence) task.evidence.finalOwnerAction = 'accepted';
          this.store.upsertTask(task);
          const worker = task.assignedWorkerId ? this.store.worker(task.assignedWorkerId) : null;
          if (worker) {
            worker.completedTaskCount += 1;
            this.store.upsertWorker(worker);
          }
          this.store.addEvent({
            type: 'task.completed',
            level: 'success',
            taskId: task.id,
            message: `Owner accepted delivery — “${task.title}” completed`,
          });
        } else {
          assertTransition(task.status, 'blocked');
          task.status = 'blocked';
          task.blockReason = `Owner requested changes${note ? `: ${note}` : ''}`;
          if (task.evidence) task.evidence.finalOwnerAction = 'changes_requested';
          this.store.upsertTask(task);
          this.store.addEvent({
            type: 'task.changes_requested',
            level: 'warning',
            taskId: task.id,
            message: `Owner requested changes on “${task.title}” — retry to run another attempt`,
          });
        }
        break;
    }
    return approval;
  }

  pause(taskId: string): Task {
    const task = this.mustTask(taskId);
    const activeWorker = task.assignedWorkerId ? this.store.worker(task.assignedWorkerId) : null;
    if (activeWorker && !this.adapterFor(activeWorker).capabilities.pause) {
      throw new LifecycleError(
        `${activeWorker.name} runs a real CLI process that cannot be paused — cancel it or let it finish.`,
      );
    }
    assertTransition(task.status, 'paused');
    task.status = 'paused';
    this.store.upsertTask(task);
    const worker = task.assignedWorkerId ? this.store.worker(task.assignedWorkerId) : null;
    if (worker) this.adapterFor(worker).pause(task.id);
    this.store.addEvent({
      type: 'run.paused',
      level: 'warning',
      taskId: task.id,
      message: `Owner paused “${task.title}”`,
    });
    return task;
  }

  resume(taskId: string): Task {
    const task = this.mustTask(taskId);
    assertTransition(task.status, 'running');
    task.status = 'running';
    this.store.upsertTask(task);
    const worker = task.assignedWorkerId ? this.store.worker(task.assignedWorkerId) : null;
    if (worker) this.adapterFor(worker).resume(task.id);
    this.store.addEvent({
      type: 'run.resumed',
      taskId: task.id,
      message: `Owner resumed “${task.title}”`,
    });
    return task;
  }

  cancel(taskId: string): Task {
    const task = this.mustTask(taskId);
    if (TERMINAL_STATUSES.includes(task.status)) {
      throw new LifecycleError(`Task is already ${task.status}`);
    }
    const worker = task.assignedWorkerId ? this.store.worker(task.assignedWorkerId) : null;
    if (worker && this.activeRuns.has(task.id)) {
      this.adapterFor(worker).cancel(task.id);
    }
    this.activeRuns.delete(task.id);
    this.freeWorker(task.assignedWorkerId);

    // expire any pending approvals tied to this task
    for (const appr of this.store.approvalsForTask(task.id)) {
      if (appr.status === 'pending') {
        appr.status = 'expired';
        appr.decidedAt = nowIso();
        appr.decisionNote = 'Task was cancelled';
        this.store.upsertApproval(appr);
        this.midrunResolvers.get(appr.id)?.(false);
        this.midrunResolvers.delete(appr.id);
      }
    }

    task.status = 'cancelled';
    task.phase = null;
    this.store.upsertTask(task);
    this.store.addEvent({
      type: 'task.cancelled',
      level: 'warning',
      taskId: task.id,
      message: `Owner cancelled “${task.title}”`,
    });
    return task;
  }

  /** blocked → running with the same worker (new attempt). */
  retry(taskId: string): Task {
    const task = this.mustTask(taskId);
    assertTransition(task.status, 'running');
    if (task.status !== 'blocked') {
      throw new LifecycleError('Only blocked tasks can be retried');
    }
    if (!task.assignedWorkerId) throw new LifecycleError('Task has no assigned worker');
    this.store.addEvent({
      type: 'run.retry',
      taskId: task.id,
      message: `Retrying “${task.title}” (attempt ${task.attempts + 1})`,
    });
    return this.startRun(task);
  }

  /** blocked/paused → running with a different worker, via structured handoff. */
  reassign(taskId: string, toWorkerId: string, reason?: string): { task: Task; handoff: Handoff } {
    const task = this.mustTask(taskId);
    if (!['blocked', 'paused'].includes(task.status)) {
      throw new LifecycleError('Only blocked or paused tasks can be reassigned');
    }
    const from = task.assignedWorkerId;
    if (!from) throw new LifecycleError('Task has no assigned worker to hand off from');
    const to = this.mustWorker(toWorkerId);
    if (to.id === from) throw new LifecycleError('Task is already assigned to that worker');
    if (to.availability !== 'idle') {
      throw new LifecycleError(`${to.name} is not idle (${to.availability})`);
    }

    // stop the old run if one is somehow live (paused case)
    const fromWorker = this.store.worker(from);
    if (fromWorker && this.activeRuns.has(task.id)) {
      this.adapterFor(fromWorker).cancel(task.id);
      this.activeRuns.delete(task.id);
    }
    this.freeWorker(from);

    const handoff = buildHandoff(
      task,
      from,
      to.id,
      reason ?? task.blockReason ?? 'Owner reassignment',
      this.store,
    );
    this.store.addHandoff(handoff);
    task.handoffIds.push(handoff.id);
    task.assignedWorkerId = to.id;
    this.store.upsertTask(task);
    this.store.addEvent({
      type: 'handoff.created',
      taskId: task.id,
      workerId: to.id,
      message: `Structured handoff: ${this.store.worker(from)?.name ?? from} → ${to.name} (${handoff.reason})`,
      data: { handoffId: handoff.id },
    });

    this.startRun(task, handoff);
    return { task: this.mustTask(taskId), handoff };
  }

  // -- run orchestration --------------------------------------------------------

  private startRun(task: Task, handoff: Handoff | null = null): Task {
    assertTransition(task.status, 'running');
    const worker = this.mustWorker(task.assignedWorkerId ?? '');

    task.status = 'running';
    task.attempts += 1;
    task.blockReason = null;
    task.progress = 0;
    task.phase = 'Starting';
    if (!task.startedAt) task.startedAt = nowIso();
    this.store.upsertTask(task);

    worker.availability = 'busy';
    worker.currentTaskId = task.id;
    this.store.upsertWorker(worker);

    const attempt = task.attempts;
    this.activeRuns.set(task.id, attempt);
    this.store.addEvent({
      type: 'run.started',
      taskId: task.id,
      workerId: worker.id,
      message: `${worker.name} started execution (attempt ${attempt})`,
    });

    const priorMidrunApproved = this.store
      .approvalsForTask(task.id)
      .some((a) => a.type === 'midrun' && a.status === 'approved');

    const ctx = this.buildRunContext(structuredClone(task), worker, attempt, handoff, priorMidrunApproved);
    this.adapterFor(worker).start(ctx);
    return task;
  }

  private buildRunContext(
    taskSnapshot: Task,
    worker: WorkerProfile,
    attempt: number,
    handoff: Handoff | null,
    priorMidrunApproved: boolean,
  ): RunContext {
    const taskId = taskSnapshot.id;
    /** ignore emissions from runs that were cancelled/superseded */
    const isLive = () => this.activeRuns.get(taskId) === attempt;
    const liveTask = () => this.store.task(taskId);

    return {
      task: taskSnapshot,
      worker,
      attempt,
      handoff,
      simSpeed: this.config.simSpeed,
      priorMidrunApproved,

      log: (line: string, level: EventLevel = 'info') => {
        if (!isLive()) return;
        this.store.addEvent({
          type: 'run.log',
          level,
          taskId,
          workerId: worker.id,
          message: line,
        });
      },

      phase: (label: string) => {
        if (!isLive()) return;
        const task = liveTask();
        if (!task) return;
        task.phase = label;
        this.store.upsertTask(task);
        this.store.addEvent({
          type: 'run.phase',
          taskId,
          workerId: worker.id,
          message: label,
        });
      },

      progress: (pct: number) => {
        if (!isLive()) return;
        const task = liveTask();
        if (!task) return;
        task.progress = pct;
        this.store.upsertTask(task);
      },

      plan: (steps: RunStep[]) => {
        if (!isLive()) return;
        const task = liveTask();
        if (!task) return;
        task.runPlan = steps;
        this.store.upsertTask(task);
      },

      stepDone: (stepId: string) => {
        if (!isLive()) return;
        const task = liveTask();
        if (!task?.runPlan) return;
        const step = task.runPlan.find((s) => s.id === stepId);
        if (step) step.done = true;
        this.store.upsertTask(task);
      },

      requestApproval: (req) => {
        if (!isLive()) return Promise.resolve(false);
        const task = liveTask();
        if (!task) return Promise.resolve(false);
        const approval: Approval = {
          id: uid('appr'),
          taskId,
          type: 'midrun',
          title: req.title,
          description: req.description,
          risk: task.risk,
          affectedScope: req.affectedScope,
          recommendedAction: 'approve',
          recommendationReason:
            'The worker paused itself before a guarded change and is waiting for your decision.',
          status: 'pending',
          createdAt: nowIso(),
          decidedAt: null,
          decisionNote: null,
        };
        this.store.upsertApproval(approval);
        task.phase = 'Waiting for owner approval';
        this.store.upsertTask(task);
        this.store.addEvent({
          type: 'approval.requested',
          level: 'warning',
          taskId,
          workerId: worker.id,
          approvalId: approval.id,
          message: `Mid-run approval requested: ${req.title}`,
        });
        return new Promise<boolean>((resolve) => {
          this.midrunResolvers.set(approval.id, resolve);
        });
      },

      blocked: (reason: string) => {
        if (!isLive()) return;
        const task = liveTask();
        if (!task) return;
        this.activeRuns.delete(taskId);
        if (task.status === 'paused') task.status = 'running'; // normalize before transition
        assertTransition(task.status, 'blocked');
        task.status = 'blocked';
        task.blockReason = reason;
        task.phase = 'Blocked';
        this.store.upsertTask(task);
        this.freeWorker(worker.id);
        this.store.addEvent({
          type: 'run.blocked',
          level: 'error',
          taskId,
          workerId: worker.id,
          message: `Blocker detected: ${reason}`,
        });
      },

      finished: (result: RunResult) => {
        if (!isLive()) return;
        void this.verify(taskId, worker.id, attempt, result);
      },
    };
  }

  /** Simulated verification pass: checks + acceptance criteria + evidence. */
  private async verify(
    taskId: string,
    workerId: string,
    attempt: number,
    result: RunResult,
  ): Promise<void> {
    const task = this.store.task(taskId);
    if (!task || this.activeRuns.get(taskId) !== attempt) return;

    assertTransition(task.status, 'verifying');
    task.status = 'verifying';
    task.phase = 'Verification';
    task.progress = 95;
    this.store.upsertTask(task);
    this.store.addEvent({
      type: 'verify.started',
      taskId,
      message: `Verification running for “${task.title}” (types, tests, criteria)`,
    });

    const pace = (ms: number) => new Promise((r) => setTimeout(r, ms / this.config.simSpeed));
    const check = (line: string) =>
      this.store.addEvent({ type: 'run.log', taskId, workerId, message: line });

    // only report checks the adapter actually ran — nothing is invented here
    for (const line of result.checks) {
      await pace(500);
      if (this.activeRuns.get(taskId) !== attempt) return;
      check(line);
    }

    const fresh = this.store.task(taskId);
    if (!fresh || this.activeRuns.get(taskId) !== attempt) return;

    if (result.criteriaMet !== null) {
      const met = result.criteriaMet;
      fresh.acceptanceCriteria = fresh.acceptanceCriteria.map((c) => ({ ...c, met }));
    }
    fresh.evidence = {
      request: fresh.goal,
      summary: result.summary,
      workerId,
      workPerformed: result.workPerformed,
      filesChanged: result.filesChanged,
      tests: result.tests,
      logTail: result.logTail,
      limitations: result.limitations,
      confidence: result.confidence,
      finalOwnerAction: null,
    };
    assertTransition(fresh.status, 'review');
    fresh.status = 'review';
    fresh.phase = 'Awaiting owner review';
    fresh.progress = 100;
    this.store.upsertTask(fresh);
    this.activeRuns.delete(taskId);
    this.freeWorker(workerId);

    this.store.addEvent({
      type: 'verify.passed',
      level: 'success',
      taskId,
      message:
        result.criteriaMet === null
          ? 'Run finished — real evidence collected; owner review required'
          : 'Verification passed — evidence ready for review',
    });

    const workerName = this.store.worker(workerId)?.name ?? 'Worker';
    const approval: Approval = {
      id: uid('appr'),
      taskId,
      type: 'completion',
      title: `Accept delivery of “${fresh.title}”`,
      description:
        `${workerName} finished the task. ${result.summary} ` +
        `Review the evidence (files, tests, logs) and accept or request changes.`,
      risk: fresh.risk,
      affectedScope: fresh.scope,
      recommendedAction: 'approve',
      recommendationReason:
        result.criteriaMet === null
          ? `Real worker run finished (confidence ${Math.round(result.confidence * 100)}%) — no automated verification ran, so inspect the changed files yourself before accepting.`
          : `Verification passed and confidence is ${Math.round(result.confidence * 100)}%.`,
      status: 'pending',
      createdAt: nowIso(),
      decidedAt: null,
      decisionNote: null,
    };
    this.store.upsertApproval(approval);
    this.store.addEvent({
      type: 'review.ready',
      level: 'success',
      taskId,
      approvalId: approval.id,
      message: `Delivery ready: review evidence and accept or request changes`,
    });
  }

  // -- crash recovery -------------------------------------------------------

  /**
   * Called once at boot. Any task that was mid-execution when the process
   * stopped is moved to blocked with a clear reason (retry resumes it), and
   * stale worker/approval state is cleaned up.
   */
  recoverInterrupted(): void {
    for (const task of this.store.tasks) {
      if (['running', 'verifying', 'paused'].includes(task.status)) {
        task.status = 'blocked';
        task.blockReason = 'Execution was interrupted by a Command Center restart — retry to resume.';
        task.phase = 'Blocked';
        this.store.upsertTask(task);
        this.store.addEvent({
          type: 'run.interrupted',
          level: 'warning',
          taskId: task.id,
          message: `“${task.title}” was interrupted by a restart and is now blocked (safe to retry)`,
        });
        for (const appr of this.store.approvalsForTask(task.id)) {
          if (appr.status === 'pending' && appr.type === 'midrun') {
            appr.status = 'expired';
            appr.decidedAt = nowIso();
            appr.decisionNote = 'Run was interrupted by a restart';
            this.store.upsertApproval(appr);
          }
        }
      }
    }
    for (const worker of this.store.workers) {
      if (worker.availability === 'busy' || worker.currentTaskId) {
        worker.availability = 'idle';
        worker.currentTaskId = null;
        this.store.upsertWorker(worker);
      }
    }
    this.store.flushSync();
  }
}

export class NotFoundError extends Error {
  readonly statusCode = 404;
}

/**
 * Boot-time honesty pass: probe for each supported local CLI and upgrade the
 * matching worker to its real adapter when the CLI is actually available —
 * or revert it to simulated when it is not. Runs only from the runtime
 * entrypoint (never in tests). Antigravity has no headless CLI, so it is
 * intentionally absent here and stays simulated.
 */
export async function enableRealAdapters(store: Store, config: AppConfig): Promise<void> {
  const probes: Array<{
    workerId: string;
    adapter: 'claude-code' | 'codex' | 'antigravity';
    command: string;
    label: string;
    /** model string to restore if the CLI is not present (revert case) */
    simulatedModel: string;
  }> = [
    { workerId: 'wkr_claude_code', adapter: 'claude-code', command: config.claudeCommand, label: 'Claude Code CLI', simulatedModel: 'claude-fable-5' },
    { workerId: 'wkr_codex', adapter: 'codex', command: config.codexCommand, label: 'Codex CLI', simulatedModel: 'gpt-5-codex' },
    { workerId: 'wkr_antigravity', adapter: 'antigravity', command: config.antigravityCommand, label: 'Antigravity CLI', simulatedModel: 'gemini-3-pro' },
  ];

  for (const probe of probes) {
    const worker = store.worker(probe.workerId);
    if (!worker) continue;
    const version = await detectCli(probe.command);
    if (version) {
      if (worker.adapter !== probe.adapter) {
        worker.adapter = probe.adapter;
        worker.integration = 'real';
        worker.model = `${probe.label} (${version})`;
        store.upsertWorker(worker);
        store.addEvent({
          type: 'system.adapter',
          level: 'success',
          workerId: worker.id,
          message: `${probe.label} detected (${version}) — worker “${worker.name}” now uses the REAL adapter`,
        });
      }
    } else if (worker.adapter === probe.adapter) {
      worker.adapter = 'simulated';
      worker.integration = 'simulated';
      worker.model = probe.simulatedModel;
      store.upsertWorker(worker);
      store.addEvent({
        type: 'system.adapter',
        level: 'warning',
        workerId: worker.id,
        message: `${probe.label} not found on PATH — worker “${worker.name}” reverted to the simulated adapter`,
      });
    }
  }
  store.flushSync();
}
