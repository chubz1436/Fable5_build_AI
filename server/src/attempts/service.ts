import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  Approval,
  Attempt,
  AttemptEvidence,
  EventLevel,
  OperationKind,
  OperationRecord,
  Project,
  Task,
  WorkerProfile,
} from '../../../shared/types';
import type { AppConfig } from '../config';
import { assertTransition, LifecycleError } from '../domain/lifecycle';
import { nowIso, uid } from '../domain/util';
import {
  branchOfWorktree,
  diffNumstat,
  diffStat,
  diffUnified,
  stageAll,
  statusPorcelain,
  revParse,
  worktreeRemove,
} from '../git/git';
import { ConflictError, type Store } from '../store/store';
import { CodexRunner, TestRunner, type RunnerHandle, type WorkerRunner } from './runners';
import { runValidation } from './validator';

/**
 * Attempt orchestrator: the authoritative pipeline for repository-backed
 * execution. Every consequential step is a durable Operation; concurrency is
 * enforced by database leases; approvals are exact single-use grants; and
 * evidence comes from the real git worktree.
 *
 *   approve → consume grant (tx) → create isolated worktree → run worker →
 *   capture real diff → independent validation → evidence → owner review
 *
 * Nothing here ever merges, pushes, or touches the owner's primary tree.
 */
export class AttemptService {
  private runners = new Map<string, WorkerRunner>();
  private live = new Map<string, RunnerHandle>(); // attemptId → handle

  constructor(
    private readonly store: Store,
    private readonly config: AppConfig,
  ) {
    this.runners.set('test', new TestRunner());
    this.runners.set('codex', new CodexRunner({ command: config.codexCommand, model: config.codexModel }));
  }

  // -- helpers ---------------------------------------------------------------

  private mustTask(taskId: string): Task {
    const task = this.store.task(taskId);
    if (!task) throw new NotFound(`Task ${taskId} not found`);
    return task;
  }

  private mustGitProject(task: Task): Project {
    const project = task.gitProjectId ? this.store.project(task.gitProjectId) : undefined;
    if (!project?.git) throw new LifecycleError('Task is not bound to a registered git project.');
    if (!project.git.enabled) throw new LifecycleError(`Project “${project.name}” is disabled.`);
    return project;
  }

  private runnerFor(worker: WorkerProfile): WorkerRunner {
    const kind = this.config.attemptRunner === 'test' ? 'test' : worker.adapter === 'codex' ? 'codex' : null;
    if (!kind) {
      throw new LifecycleError(
        `${worker.name} cannot execute repository tasks yet — this release is Codex-first (or the deterministic test runner).`,
      );
    }
    return this.runners.get(kind)!;
  }

  private payloadHash(task: Task, workerId: string, adapter: string, project: Project, baseCommit: string): string {
    const canonical = JSON.stringify({
      taskId: task.id,
      goal: task.goal,
      workerId,
      adapter,
      projectId: project.id,
      repo: project.git!.canonicalRoot.toLowerCase(),
      baseBranch: project.git!.baseBranch,
      baseCommit,
      protectedPaths: [...project.git!.protectedPaths].sort(),
    });
    return crypto.createHash('sha256').update(canonical).digest('hex');
  }

  private event(type: string, message: string, taskId: string, level: EventLevel = 'info', data?: Record<string, unknown>): void {
    this.store.addEvent({ type, message, taskId, level, ...(data ? { data } : {}) });
  }

  private op(attemptId: string, kind: OperationKind, idempotencyKey: string, command: string | null, timeoutMs: number | null = null): OperationRecord {
    return this.store.insertOperation({
      id: uid('op'),
      attemptId,
      kind,
      idempotencyKey,
      status: 'running',
      startedAt: nowIso(),
      endedAt: null,
      command,
      exitCode: null,
      timeoutMs,
      error: null,
    });
  }

  private finishOp(op: OperationRecord, status: OperationRecord['status'], exitCode: number | null = null, error: string | null = null): void {
    op.status = status;
    op.endedAt = nowIso();
    op.exitCode = exitCode;
    op.error = error;
    this.store.updateOperation(op);
  }

  // -- request start: exact approval grant (P0.6) -----------------------------

  async requestStart(taskId: string, workerId?: string): Promise<{ task: Task; approval: Approval }> {
    const task = this.mustTask(taskId);
    const project = this.mustGitProject(task);
    if (task.status === 'blocked') {
      assertTransition(task.status, 'ready'); // blocked → ready → awaiting_approval
      task.status = 'ready';
    }
    assertTransition(task.status, 'awaiting_approval');

    const worker = this.store.worker(workerId ?? task.recommendation?.workerId ?? 'wkr_codex');
    if (!worker) throw new NotFound('Worker not found.');
    const runner = this.runnerFor(worker); // throws for unsupported workers

    // bind the grant to the repo's CURRENT base commit
    const baseCommit = await revParse(project.git!.canonicalRoot, project.git!.baseBranch);
    const hash = this.payloadHash(task, worker.id, runner.adapter, project, baseCommit);

    task.assignedWorkerId = worker.id;
    task.status = 'awaiting_approval';
    this.store.upsertTask(task);

    const approval: Approval = {
      id: uid('appr'),
      taskId: task.id,
      type: 'start',
      title: `Start “${task.title}”`,
      description:
        `${worker.name} will run in an ISOLATED git worktree of “${project.name}” ` +
        `(${project.git!.baseBranch} @ ${baseCommit.slice(0, 8)}). The owner working tree is never touched; ` +
        `nothing is merged or pushed. Validation: ${
          project.git!.validationCommands.length
            ? project.git!.validationCommands.map((c) => c.name).join(', ')
            : 'none configured (delivery will be UNVERIFIED)'
        }.` +
        (project.git!.protectedPaths.length ? ` Protected paths: ${project.git!.protectedPaths.join(', ')}.` : ''),
      risk: task.risk,
      affectedScope: task.scope,
      recommendedAction: 'approve',
      recommendationReason: `Exact single-use grant for ${worker.name} (${runner.adapter} runner) on base ${baseCommit.slice(0, 8)}; expires in ${Math.round(this.config.approvalTtlMs / 60000)} min.`,
      status: 'pending',
      createdAt: nowIso(),
      decidedAt: null,
      decisionNote: null,
      attemptId: null,
      projectId: project.id,
      workerId: worker.id,
      baseCommit,
      payloadHash: hash,
      expiresAt: new Date(Date.now() + this.config.approvalTtlMs).toISOString(),
      singleUse: true,
      consumedAt: null,
    };
    this.store.upsertApproval(approval);
    this.event('approval.requested', `Approval requested: start “${task.title}” with ${worker.name} on ${project.name}`, task.id, 'info', { approvalId: approval.id });
    return { task, approval };
  }

  // -- decision: consume grant transactionally (P0.5 + P0.6) -------------------

  async decide(approvalId: string, decision: 'approve' | 'reject', note?: string): Promise<Approval> {
    const approval = this.store.approval(approvalId);
    if (!approval) throw new NotFound(`Approval ${approvalId} not found`);
    if (approval.type === 'start') return this.decideStart(approval, decision, note);
    if (approval.type === 'completion') return this.decideCompletion(approval, decision, note);
    throw new LifecycleError(`Unsupported approval type for git tasks: ${approval.type}`);
  }

  private async decideStart(approval: Approval, decision: 'approve' | 'reject', note?: string): Promise<Approval> {
    const task = this.mustTask(approval.taskId);
    const project = this.mustGitProject(task);

    if (decision === 'reject') {
      this.store.tx(() => {
        const fresh = this.store.approval(approval.id)!;
        if (fresh.status !== 'pending') throw new ConflictError(`Approval already ${fresh.status}`);
        fresh.status = 'rejected';
        fresh.decidedAt = nowIso();
        fresh.decisionNote = note ?? null;
        this.store.upsertApproval(fresh);
        assertTransition(task.status, 'ready');
        task.status = 'ready';
        task.assignedWorkerId = null;
        this.store.upsertTask(task);
      });
      this.event('approval.rejected', `Owner rejected: ${approval.title}${note ? ` — “${note}”` : ''}`, task.id, 'warning');
      return this.store.approval(approval.id)!;
    }

    // re-verify the binding against live repo state BEFORE consuming
    const worker = this.store.worker(approval.workerId ?? '');
    if (!worker) throw new LifecycleError('The approved worker no longer exists.');
    const runner = this.runnerFor(worker);
    const freshCommit = await revParse(project.git!.canonicalRoot, project.git!.baseBranch);
    const freshHash = this.payloadHash(task, worker.id, runner.adapter, project, freshCommit);

    // invalidations are PERSISTED (own tx) — an invalid grant never revives
    const current = this.store.approval(approval.id)!;
    if (current.status !== 'pending') throw new ConflictError(`Approval already ${current.status}.`);
    if (current.expiresAt && current.expiresAt < nowIso()) {
      this.store.tx(() => {
        current.status = 'expired';
        current.decidedAt = nowIso();
        this.store.upsertApproval(current);
      });
      throw new ConflictError('Approval has expired — request a new start approval.');
    }
    if (current.payloadHash !== freshHash) {
      this.store.tx(() => {
        current.status = 'expired';
        current.decidedAt = nowIso();
        current.decisionNote = `Invalidated: the authorized action changed (repo moved ${current.baseCommit?.slice(0, 8)} → ${freshCommit.slice(0, 8)} or task edited).`;
        this.store.upsertApproval(current);
      });
      throw new ConflictError('The approved action changed (base commit or task) — request a new approval.');
    }

    const attemptId = uid('att');
    const attempt: Attempt = {
      id: attemptId,
      taskId: task.id,
      workerId: worker.id,
      adapter: runner.adapter,
      model: runner.adapter === 'codex' ? this.config.codexModel || null : null,
      projectId: project.id,
      baseBranch: project.git!.baseBranch,
      baseCommit: freshCommit,
      worktreePath: null,
      branchName: null,
      approvalId: approval.id,
      state: 'creating_worktree',
      exitReason: null,
      executablePath: null,
      executableVersion: null,
      pid: null,
      startedAt: nowIso(),
      endedAt: null,
      failureReason: null,
      validation: null,
      evidence: null,
      delivery: null,
      worktreeCleanedAt: null,
      worktreeHealth: null,
    };

    // single transaction: consume grant + create attempt + acquire all leases
    this.store.tx(() => {
      // atomic re-check inside the consuming transaction (pure race guard)
      const fresh = this.store.approval(approval.id)!;
      if (fresh.status !== 'pending') throw new ConflictError(`Approval already ${fresh.status}.`);
      if (fresh.payloadHash !== freshHash) {
        throw new ConflictError('The approved action changed — request a new approval.');
      }
      fresh.status = 'approved';
      fresh.decidedAt = nowIso();
      fresh.decisionNote = note ?? null;
      fresh.consumedAt = nowIso();
      fresh.attemptId = attemptId;
      this.store.upsertApproval(fresh);

      this.store.insertAttempt(attempt);
      // idempotency: a second click can never dispatch twice
      this.op(attemptId, 'consume_approval', `dispatch:${approval.id}`, JSON.stringify({ approvalId: approval.id }));
      this.store.acquireLeases(
        attemptId,
        [
          { kind: 'task', resourceKey: task.id },
          { kind: 'worker', resourceKey: worker.id },
          { kind: 'repo', resourceKey: project.id },
        ],
        this.config.leaseTtlMs,
      );

      assertTransition(task.status, 'running');
      task.status = 'running';
      task.attempts += 1;
      task.activeAttemptId = attemptId;
      task.blockReason = null;
      task.progress = 5;
      task.phase = 'Creating isolated worktree';
      task.runPlan = null;
      if (!task.startedAt) task.startedAt = nowIso();
      this.store.upsertTask(task);

      worker.availability = 'busy';
      worker.currentTaskId = task.id;
      this.store.upsertWorker(worker);
    });

    this.event('approval.approved', `Owner approved: ${approval.title}`, task.id, 'success', { attemptId });
    this.event('run.started', `${worker.name} attempt ${attemptId} started (grant ${approval.id.slice(-6)}, base ${freshCommit.slice(0, 8)})`, task.id, 'info', { attemptId });

    void this.pipeline(attemptId).catch((err) => this.failAttempt(attemptId, 'failure', `Pipeline error: ${(err as Error).message}`));
    return this.store.approval(approval.id)!;
  }

  private async decideCompletion(approval: Approval, decision: 'approve' | 'reject', note?: string): Promise<Approval> {
    const task = this.mustTask(approval.taskId);
    const attempt = approval.attemptId ? this.store.attempt(approval.attemptId) : undefined;
    if (!attempt) throw new LifecycleError('Completion approval has no attempt.');

    this.store.tx(() => {
      const fresh = this.store.approval(approval.id)!;
      if (fresh.status !== 'pending') throw new ConflictError(`Approval already ${fresh.status}`);
      fresh.status = decision === 'approve' ? 'approved' : 'rejected';
      fresh.decidedAt = nowIso();
      fresh.decisionNote = note ?? null;
      fresh.consumedAt = nowIso();
      this.store.upsertApproval(fresh);

      if (decision === 'approve') {
        assertTransition(task.status, 'completed');
        attempt.state = 'accepted';
        attempt.delivery = 'accepted';
        attempt.endedAt = attempt.endedAt ?? nowIso();
        this.store.updateAttempt(attempt);
        task.status = 'completed';
        task.completedAt = nowIso();
        this.store.upsertTask(task);
        const worker = this.store.worker(attempt.workerId);
        if (worker) {
          worker.completedTaskCount += 1;
          this.store.upsertWorker(worker);
        }
      } else {
        assertTransition(task.status, 'blocked');
        attempt.state = 'rejected';
        attempt.delivery = 'correction_requested';
        attempt.endedAt = attempt.endedAt ?? nowIso();
        this.store.updateAttempt(attempt);
        task.status = 'blocked';
        task.blockReason = `Owner requested correction${note ? `: ${note}` : ''} — the worktree/branch is preserved; retry creates a new attempt.`;
        this.store.upsertTask(task);
      }
    });
    this.event(
      decision === 'approve' ? 'task.completed' : 'task.changes_requested',
      decision === 'approve'
        ? `Owner accepted delivery — branch ${attempt.branchName} remains unmerged for review/merge by the owner`
        : `Owner requested correction on attempt ${attempt.id}`,
      task.id,
      decision === 'approve' ? 'success' : 'warning',
      { attemptId: attempt.id },
    );
    return this.store.approval(approval.id)!;
  }

  // -- the pipeline ------------------------------------------------------------

  private log(attempt: Attempt, line: string, level: EventLevel = 'info'): void {
    this.store.addEvent({ type: 'run.log', level, taskId: attempt.taskId, message: line, data: { attemptId: attempt.id } });
  }

  private phase(attempt: Attempt, label: string, progress: number): void {
    const task = this.store.task(attempt.taskId);
    if (!task) return;
    task.phase = label;
    task.progress = progress;
    this.store.upsertTask(task);
    this.store.addEvent({ type: 'run.phase', taskId: attempt.taskId, message: label, data: { attemptId: attempt.id } });
  }

  private async pipeline(attemptId: string): Promise<void> {
    let attempt = this.store.attempt(attemptId)!;
    const task = this.mustTask(attempt.taskId);
    const project = this.store.project(attempt.projectId)!;
    const worker = this.store.worker(attempt.workerId)!;
    const repo = project.git!.canonicalRoot;

    // 1) isolated worktree (P0.7)
    const branch = `cc/${attemptId}`;
    const worktreePath = path.join(this.config.worktreesRoot, attemptId);
    fs.mkdirSync(this.config.worktreesRoot, { recursive: true });
    const wtOp = this.op(attemptId, 'create_worktree', `worktree:${attemptId}`, JSON.stringify(['git', 'worktree', 'add', '-b', branch, worktreePath, attempt.baseCommit]));
    try {
      const { worktreeAdd } = await import('../git/git');
      await worktreeAdd(repo, worktreePath, branch, attempt.baseCommit);
      // containment check: the created path must resolve inside our root
      const real = fs.realpathSync.native(worktreePath);
      const rootReal = fs.realpathSync.native(this.config.worktreesRoot);
      if (!real.toLowerCase().startsWith(rootReal.toLowerCase())) {
        throw new Error('Worktree escaped the managed worktrees directory.');
      }
      this.finishOp(wtOp, 'succeeded', 0);
    } catch (err) {
      this.finishOp(wtOp, 'failed', null, (err as Error).message);
      return this.failAttempt(attemptId, 'failure', `Worktree creation failed: ${(err as Error).message}`);
    }
    attempt = this.store.attempt(attemptId)!;
    attempt.worktreePath = worktreePath;
    attempt.branchName = branch;
    attempt.worktreeHealth = 'ok';
    this.store.updateAttempt(attempt);
    this.log(attempt, `Isolated worktree ready: ${worktreePath} (branch ${branch} @ ${attempt.baseCommit.slice(0, 8)})`);
    this.phase(attempt, 'Worker running', 20);

    // 2) worker execution (P0.8)
    const runner = this.runnerFor(worker);
    const probe = await runner.probe();
    const brief = this.buildBrief(task, project);
    const startOp = this.op(attemptId, 'start_worker', `worker:${attemptId}`, JSON.stringify({ adapter: runner.adapter, executable: probe.path }), this.config.attemptTimeoutMs);

    attempt = this.store.attempt(attemptId)!;
    attempt.state = 'running';
    attempt.executablePath = probe.path;
    attempt.executableVersion = probe.version;
    this.store.updateAttempt(attempt);

    let logCount = 0;
    const handle = await runner.start({
      worktree: worktreePath,
      brief,
      goal: task.goal,
      timeoutMs: this.config.attemptTimeoutMs,
      maxLogLines: this.config.maxLogLines,
      onLog: (line, level) => {
        this.log(this.store.attempt(attemptId)!, line, level);
        if (++logCount % 20 === 0) {
          this.store.renewLeases(attemptId, this.config.leaseTtlMs);
          const t = this.store.task(attempt.taskId);
          if (t && t.progress < 80) {
            t.progress = Math.min(80, t.progress + 2);
            this.store.upsertTask(t);
          }
        }
      },
    });
    attempt = this.store.attempt(attemptId)!;
    attempt.pid = handle.pid;
    // record the executable the runner ACTUALLY launched (may be the resolved
    // .cmd shim where the probe reported the same target)
    if (handle.executablePath) attempt.executablePath = handle.executablePath;
    this.store.updateAttempt(attempt);
    this.live.set(attemptId, handle);

    // P0.12/req-15: the readiness screen must report the same executable
    // target that was actually used to run the worker (created if absent).
    if (handle.executablePath) {
      worker.readiness = {
        state: 'BUSY',
        executablePath: handle.executablePath,
        version: probe.version ?? worker.readiness?.version ?? null,
        authStatus: worker.readiness?.authStatus ?? 'unknown',
        lastCheckAt: nowIso(),
        lastError: worker.readiness?.lastError ?? null,
        supportsCancel: true,
        sandbox: worker.readiness?.sandbox ?? 'workspace-write',
      };
      this.store.upsertWorker(worker);
    }

    const outcome = await handle.done;
    this.live.delete(attemptId);
    this.finishOp(startOp, outcome.exitReason === 'success' ? 'succeeded' : outcome.exitReason === 'timeout' ? 'timeout' : 'failed', outcome.exitCode, outcome.error);

    // cancelled while running → cancel() already settled the attempt/task
    if (this.store.attempt(attemptId)!.state === 'cancelled') return;

    if (outcome.exitReason !== 'success') {
      return this.failAttempt(attemptId, outcome.exitReason, outcome.error ?? 'Worker failed.', outcome.logTail);
    }

    // 3) real diff capture (P0.10)
    this.phase(attempt, 'Capturing git diff', 85);
    const diffOp = this.op(attemptId, 'capture_diff', `diff:${attemptId}`, JSON.stringify(['git', 'add', '-A', '&&', 'git', 'diff', attempt.baseCommit]));
    let evidence: AttemptEvidence;
    try {
      const gitStatus = await statusPorcelain(worktreePath);
      await stageAll(worktreePath);
      const files = await diffNumstat(worktreePath, attempt.baseCommit);
      const stat = await diffStat(worktreePath, attempt.baseCommit);
      let diff = await diffUnified(worktreePath, attempt.baseCommit);
      const truncated = diff.length > this.config.maxDiffBytes;
      if (truncated) diff = diff.slice(0, this.config.maxDiffBytes);
      const violations = files
        .map((f) => f.path)
        .filter((p) => project.git!.protectedPaths.some((pp) => p === pp || p.startsWith(`${pp}/`)));
      evidence = {
        changedFiles: files.map((f) => ({ path: f.path, changeType: f.changeType, additions: f.additions, deletions: f.deletions, summary: `${f.changeType} by ${worker.name}` })),
        diffStat: stat,
        diff,
        diffTruncated: truncated,
        gitStatus,
        protectedViolations: violations,
        workerLogTail: outcome.logTail,
      };
      this.finishOp(diffOp, 'succeeded', 0);
      this.log(attempt, `Diff captured: ${files.length} file(s) changed${violations.length ? ` — ⚠ ${violations.length} protected-path violation(s)!` : ''}`, violations.length ? 'error' : 'info');
    } catch (err) {
      this.finishOp(diffOp, 'failed', null, (err as Error).message);
      return this.failAttempt(attemptId, 'failure', `Diff capture failed: ${(err as Error).message}`);
    }

    // 4) independent validation (P0.9)
    this.phase(attempt, 'Independent validation', 90);
    attempt = this.store.attempt(attemptId)!;
    attempt.state = 'validating';
    attempt.evidence = evidence;
    this.store.updateAttempt(attempt);
    const t = this.store.task(attempt.taskId)!;
    assertTransition(t.status, 'verifying');
    t.status = 'verifying';
    this.store.upsertTask(t);
    this.event('verify.started', `Independent validation running in the attempt worktree (${project.git!.validationCommands.length} command(s))`, t.id, 'info', { attemptId });

    const valOp = this.op(attemptId, 'run_validation', `validate:${attemptId}:1`, JSON.stringify(project.git!.validationCommands.map((c) => c.argv)));
    const validation = await runValidation(project.git!.validationCommands, worktreePath, (line, level) =>
      this.log(this.store.attempt(attemptId)!, line, level),
    );
    if (evidence.protectedViolations.length > 0) {
      validation.steps.push({
        id: uid('vstep'),
        name: 'protected-paths',
        argv: [],
        cwd: worktreePath,
        required: true,
        startedAt: nowIso(),
        endedAt: nowIso(),
        timeoutMs: 0,
        exitCode: null,
        status: 'FAILED',
        outputTail: evidence.protectedViolations.map((p) => `protected path modified: ${p}`),
      });
      validation.status = 'FAILED';
    }
    this.finishOp(valOp, validation.status === 'FAILED' ? 'failed' : 'succeeded', null, validation.status === 'FAILED' ? 'required validation failed' : null);

    // 5) delivery review (P0.10)
    this.settleForReview(attemptId, validation);
  }

  private settleForReview(attemptId: string, validation: Attempt['validation']): void {
    const attempt = this.store.attempt(attemptId)!;
    const task = this.mustTask(attempt.taskId);
    this.store.tx(() => {
      attempt.state = 'ready_for_review';
      attempt.validation = validation;
      attempt.exitReason = 'success';
      attempt.endedAt = nowIso();
      this.store.updateAttempt(attempt);
      assertTransition(task.status, 'review');
      task.status = 'review';
      task.phase = 'Awaiting owner review';
      task.progress = 100;
      this.store.upsertTask(task);
      this.freeWorker(attempt.workerId);
      // the worker actually produced changes → its executable + auth are proven
      const rw = this.store.worker(attempt.workerId);
      if (rw?.readiness) {
        rw.readiness = { ...rw.readiness, state: 'READY', authStatus: 'ok', lastError: null, lastCheckAt: nowIso() };
        this.store.upsertWorker(rw);
      }
      this.store.releaseLeases(attemptId);

      const status = validation?.status ?? 'UNVERIFIED';
      const approval: Approval = {
        id: uid('appr'),
        taskId: task.id,
        type: 'completion',
        title: `Accept delivery of “${task.title}”`,
        description:
          `Attempt ${attempt.id} finished on branch ${attempt.branchName}. ` +
          `${attempt.evidence?.changedFiles.length ?? 0} file(s) changed (real git diff attached). ` +
          `Independent validation: ${status}. Accepting does NOT merge or push — the branch stays for your review.`,
        risk: task.risk,
        affectedScope: attempt.evidence?.changedFiles.map((f) => f.path).slice(0, 20) ?? [],
        recommendedAction: status === 'VERIFIED' ? 'approve' : 'reject',
        recommendationReason:
          status === 'VERIFIED'
            ? 'All required validation commands passed in the attempt worktree.'
            : status === 'UNVERIFIED'
              ? 'No validation commands are configured — inspect the diff yourself before accepting.'
              : status === 'PARTIAL'
                ? 'Optional validation steps failed — inspect the results.'
                : 'Required validation FAILED — delivery cannot be considered verified.',
        status: 'pending',
        createdAt: nowIso(),
        decidedAt: null,
        decisionNote: null,
        attemptId: attempt.id,
        projectId: attempt.projectId,
        workerId: attempt.workerId,
        baseCommit: attempt.baseCommit,
        payloadHash: null,
        expiresAt: null,
        singleUse: true,
        consumedAt: null,
      };
      this.store.upsertApproval(approval);
    });
    this.event('verify.passed', `Attempt ready for review — validation: ${validation?.status ?? 'UNVERIFIED'}`, task.id, validation?.status === 'FAILED' ? 'warning' : 'success', { attemptId });
    this.event('review.ready', `Delivery ready: real diff + validation evidence attached (branch ${attempt.branchName})`, task.id, 'success', { attemptId });
  }

  private failAttempt(attemptId: string, exitReason: Attempt['exitReason'], reason: string, logTail: string[] = []): void {
    const attempt = this.store.attempt(attemptId);
    if (!attempt || ['cancelled', 'failed', 'timeout', 'accepted', 'rejected'].includes(attempt.state)) return;
    const task = this.store.task(attempt.taskId);
    this.store.tx(() => {
      attempt.state = exitReason === 'timeout' ? 'timeout' : 'failed';
      attempt.exitReason = exitReason;
      attempt.failureReason = reason;
      attempt.endedAt = nowIso();
      if (logTail.length && !attempt.evidence) {
        attempt.evidence = { changedFiles: [], diffStat: '', diff: '', diffTruncated: false, gitStatus: '', protectedViolations: [], workerLogTail: logTail };
      }
      this.store.updateAttempt(attempt);
      this.store.releaseLeases(attemptId);
      this.freeWorker(attempt.workerId);
      if (task && !['completed', 'cancelled', 'failed'].includes(task.status)) {
        task.status = 'blocked';
        task.blockReason = reason;
        task.phase = 'Blocked';
        this.store.upsertTask(task);
      }
    });
    if (task) this.event('run.blocked', `Attempt ${attemptId} ${exitReason}: ${reason}`, task.id, 'error', { attemptId });
    // honest readiness update from real outcomes
    const worker = this.store.worker(attempt.workerId);
    if (worker?.readiness && (exitReason === 'auth_required' || exitReason === 'rate_limited' || exitReason === 'quota_exhausted' || exitReason === 'unavailable')) {
      worker.readiness = {
        ...worker.readiness,
        state: exitReason === 'auth_required' ? 'AUTH_REQUIRED' : exitReason === 'rate_limited' ? 'RATE_LIMITED' : exitReason === 'quota_exhausted' ? 'QUOTA_EXHAUSTED' : 'UNAVAILABLE',
        authStatus: exitReason === 'auth_required' ? 'required' : worker.readiness.authStatus,
        lastError: reason,
        lastCheckAt: nowIso(),
      };
      this.store.upsertWorker(worker);
    }
  }

  private freeWorker(workerId: string): void {
    const worker = this.store.worker(workerId);
    if (!worker) return;
    worker.availability = 'idle';
    worker.currentTaskId = null;
    this.store.upsertWorker(worker);
  }

  private buildBrief(task: Task, project: Project): string {
    return [
      `You are an AI coding worker executing one task inside an ISOLATED git worktree.`,
      ``,
      `# Task: ${task.title}`,
      `GOAL: ${task.goal}`,
      ``,
      `## Acceptance criteria`,
      ...task.acceptanceCriteria.map((c) => `- ${c.text}`),
      ``,
      `## Rules`,
      `- Work ONLY inside the current directory (a dedicated worktree of ${project.name}).`,
      `- Do NOT commit, merge, push, or change branches — the Command Center captures the diff.`,
      ...(project.git!.protectedPaths.length ? [`- NEVER modify these protected paths: ${project.git!.protectedPaths.join(', ')}`] : []),
      `- Keep the change minimal and focused on the goal.`,
    ].join('\n');
  }

  // -- owner actions -------------------------------------------------------------

  cancel(taskId: string): Task {
    const task = this.mustTask(taskId);
    const attempt = task.activeAttemptId ? this.store.attempt(task.activeAttemptId) : undefined;
    const handle = attempt ? this.live.get(attempt.id) : undefined;
    if (attempt && ['creating_worktree', 'running', 'validating'].includes(attempt.state)) {
      const cancelOp = this.op(attempt.id, 'cancel_worker', `cancel:${attempt.id}`, null);
      if (handle) handle.cancel();
      this.store.tx(() => {
        attempt.state = 'cancelled';
        attempt.exitReason = 'cancelled';
        attempt.endedAt = nowIso();
        attempt.failureReason = 'Cancelled by owner.';
        this.store.updateAttempt(attempt);
        this.store.releaseLeases(attempt.id);
        this.freeWorker(attempt.workerId);
      });
      this.finishOp(cancelOp, 'succeeded');
    }
    // expire pending approvals for the task
    for (const appr of this.store.approvalsForTask(task.id)) {
      if (appr.status === 'pending') {
        appr.status = 'expired';
        appr.decidedAt = nowIso();
        appr.decisionNote = 'Task was cancelled';
        this.store.upsertApproval(appr);
      }
    }
    task.status = 'cancelled';
    task.phase = null;
    this.store.upsertTask(task);
    this.event('task.cancelled', `Owner cancelled “${task.title}” (worker process tree terminated)`, task.id, 'warning');
    return task;
  }

  /** re-run ONLY validation (never the worker) in the preserved worktree */
  async revalidate(attemptId: string): Promise<Attempt> {
    const attempt = this.store.attempt(attemptId);
    if (!attempt) throw new NotFound('Attempt not found.');
    if (!attempt.worktreePath || attempt.worktreeCleanedAt) throw new LifecycleError('Worktree is gone — cannot re-validate.');
    if (!['ready_for_review', 'blocked_reconciliation'].includes(attempt.state)) {
      throw new LifecycleError(`Cannot re-validate an attempt in state ${attempt.state}.`);
    }
    const project = this.store.project(attempt.projectId)!;
    const n = this.store.operationsForAttempt(attemptId).filter((o) => o.kind === 'run_validation').length + 1;
    const valOp = this.op(attemptId, 'run_validation', `validate:${attemptId}:${n}`, JSON.stringify(project.git!.validationCommands.map((c) => c.argv)));
    const validation = await runValidation(project.git!.validationCommands, attempt.worktreePath, (line, level) =>
      this.log(this.store.attempt(attemptId)!, line, level),
    );
    this.finishOp(valOp, validation.status === 'FAILED' ? 'failed' : 'succeeded');
    if (attempt.state === 'blocked_reconciliation') {
      this.settleForReview(attemptId, validation);
    } else {
      attempt.validation = validation;
      this.store.updateAttempt(attempt);
      this.event('verify.passed', `Re-validation finished: ${validation.status}`, attempt.taskId, validation.status === 'FAILED' ? 'warning' : 'success', { attemptId });
    }
    return this.store.attempt(attemptId)!;
  }

  /** explicit, safe worktree removal for terminal attempts (branch is kept) */
  async cleanupWorktree(attemptId: string): Promise<Attempt> {
    const attempt = this.store.attempt(attemptId);
    if (!attempt) throw new NotFound('Attempt not found.');
    if (['creating_worktree', 'running', 'validating'].includes(attempt.state)) {
      throw new LifecycleError('Attempt is still active — cancel it first.');
    }
    if (!attempt.worktreePath || attempt.worktreeCleanedAt) return attempt;
    const project = this.store.project(attempt.projectId);
    const op = this.op(attemptId, 'cleanup_worktree', `cleanup:${attemptId}`, JSON.stringify(['git', 'worktree', 'remove', attempt.worktreePath]));
    try {
      if (project?.git && fs.existsSync(attempt.worktreePath)) {
        await worktreeRemove(project.git.canonicalRoot, attempt.worktreePath);
      }
      attempt.worktreeCleanedAt = nowIso();
      attempt.worktreeHealth = 'missing';
      this.store.updateAttempt(attempt);
      this.finishOp(op, 'succeeded', 0);
      this.event('attempt.cleanup', `Worktree removed for attempt ${attemptId} (branch ${attempt.branchName} kept)`, attempt.taskId);
    } catch (err) {
      this.finishOp(op, 'failed', null, (err as Error).message);
      throw new LifecycleError(`Worktree cleanup failed: ${(err as Error).message}`);
    }
    return attempt;
  }

  // -- crash/restart reconciliation (P0.11) ----------------------------------------

  async recover(): Promise<void> {
    for (const attempt of this.store.activeAttempts()) {
      const task = this.store.task(attempt.taskId);
      const op = this.op(attempt.id, 'reconcile', `reconcile:${attempt.id}:${Date.now()}`, JSON.stringify({ foundState: attempt.state }));

      // worktree health
      let health: Attempt['worktreeHealth'] = 'unknown';
      if (attempt.worktreePath) {
        if (!fs.existsSync(attempt.worktreePath)) health = 'missing';
        else {
          const branch = await branchOfWorktree(attempt.worktreePath);
          health = branch === attempt.branchName ? 'ok' : 'branch_mismatch';
        }
      }
      attempt.worktreeHealth = health;

      if (attempt.state === 'running') {
        // the worker process fate cannot be proven after a restart
        attempt.state = 'unknown_outcome';
        attempt.exitReason = 'unknown';
        attempt.failureReason =
          'The Command Center restarted while the worker was running; the process outcome cannot be proven. ' +
          'Inspect the preserved worktree, then retry (new attempt) or clean up.';
      } else if (attempt.state === 'validating') {
        attempt.state = 'blocked_reconciliation';
        attempt.failureReason = 'Validation was interrupted by a restart — re-run validation (the worker will not re-run).';
      } else {
        attempt.state = 'failed';
        attempt.exitReason = 'unknown';
        attempt.failureReason = 'Worktree creation was interrupted by a restart.';
      }
      attempt.endedAt = nowIso();
      this.store.updateAttempt(attempt);
      this.store.releaseLeases(attempt.id);
      this.freeWorker(attempt.workerId);
      this.finishOp(op, 'succeeded');

      if (task && !['completed', 'cancelled'].includes(task.status)) {
        task.status = 'blocked';
        task.blockReason = attempt.failureReason;
        task.phase = 'Blocked (recovery)';
        this.store.upsertTask(task);
        this.event('run.interrupted', `Attempt ${attempt.id} reconciled after restart → ${attempt.state} (worktree: ${health})`, task.id, 'warning', { attemptId: attempt.id });
      }
    }
    // mark any operation left 'running' as unknown — never blindly retried
    const stale = this.store.db.sqlite
      .prepare("SELECT json FROM operations WHERE status = 'running'")
      .all() as Array<{ json: string }>;
    for (const row of stale) {
      const op = JSON.parse(row.json) as OperationRecord;
      op.status = 'unknown';
      op.endedAt = nowIso();
      op.error = 'Interrupted by restart; outcome not proven.';
      this.store.updateOperation(op);
    }
    this.store.reapExpiredLeases();
  }
}

export class NotFound extends Error {
  readonly statusCode = 404;
}
