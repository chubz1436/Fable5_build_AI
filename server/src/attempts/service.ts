import type { ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  Approval,
  Attempt,
  AttemptEvidence,
  AttemptValidation,
  EventLevel,
  ExecutionSpec,
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
  commitCheckpoint,
  commitExists,
  diffNumstat,
  diffStat,
  diffTreePaths,
  diffUnified,
  headCommit,
  resetFilterDriverCache,
  revParse,
  stageAll,
  statusPorcelain,
  worktreeRemove,
  writeTreeSnapshot,
} from '../git/git';
import { ConflictError, type Store } from '../store/store';
import { captureGitBaseline, findSymlinkEscapes, readGitLinkFile, verifyWorktreeIntegrity, type GitBaseline } from './integrity';
import {
  CodexRunner,
  pidAlive,
  terminateTree,
  TestRunner,
  type RunnerHandle,
  type TerminationProof,
  type WorkerRunner,
} from './runners';
import { runValidation } from './validator';

/**
 * Attempt orchestrator: the authoritative pipeline for repository-backed
 * execution. Every consequential step is a durable Operation; concurrency is
 * enforced by database leases; approvals are exact single-use grants bound to
 * a complete ExecutionSpec; and evidence comes from the real git worktree.
 *
 *   approve → consume grant (tx, spec re-verified) → isolated worktree →
 *   worker → pre-validation snapshot → independent validation →
 *   post-validation snapshot + FINAL diff → checkpoint commit →
 *   evidence → owner review
 *
 * Nothing here ever merges, pushes, or touches the owner's primary tree.
 */
export class AttemptService {
  private runners = new Map<string, WorkerRunner>();
  private live = new Map<string, RunnerHandle>(); // attemptId → handle
  /** one cancellation context per attempt, spanning every pipeline phase (P0-3) */
  private aborts = new Map<string, AbortController>();
  /** in-flight process-tree termination per attempt; awaited before settling */
  private terminations = new Map<string, Promise<void>>();
  /** live validation child processes per attempt (tracked for proven kills) */
  private validationProcs = new Map<string, Set<ChildProcess>>();
  /** in-flight finalizeCancellation per attempt (the pipeline and the cancel
   * request can both reach it; they must not race) */
  private finalizing = new Map<string, Promise<void>>();

  constructor(
    private readonly store: Store,
    private readonly config: AppConfig,
  ) {
    this.runners.set('test', new TestRunner());
    this.runners.set(
      'codex',
      new CodexRunner({ command: config.codexCommand, model: config.codexModel, authMode: config.codexAuthMode }),
    );
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

  /** adapters AttemptService can actually drive for repository attempts */
  static readonly REPO_ADAPTERS: ReadonlyArray<WorkerProfile['adapter']> = ['codex'];

  /**
   * Whether a worker may be selected for a repository-backed attempt. In the
   * deterministic test-runner mode any worker is drivable (no real CLI runs);
   * in normal mode only adapters AttemptService supports are eligible.
   */
  supportsRepositoryAttempts(worker: WorkerProfile): boolean {
    if (this.config.attemptRunner === 'test') return true;
    return AttemptService.REPO_ADAPTERS.includes(worker.adapter);
  }

  private runnerFor(worker: WorkerProfile): WorkerRunner {
    const kind = this.config.attemptRunner === 'test' ? 'test' : worker.adapter === 'codex' ? 'codex' : null;
    if (!kind) {
      throw new LifecycleError(
        `${worker.name} (${worker.adapter}) is not available for repository attempts — ` +
          `AttemptService can drive only: ${AttemptService.REPO_ADAPTERS.join(', ')}. ` +
          'Select a supported worker (Codex) or migrate this adapter onto the attempt pipeline.',
      );
    }
    return this.runners.get(kind)!;
  }

  // -- ExecutionSpec (P0-4) ----------------------------------------------------

  /**
   * The complete canonical description of what a start approval authorizes.
   * EVERY consequential field is included; the hash of this object is the
   * approval's payloadHash. Changing any field after the grant invalidates it.
   */
  private buildSpec(
    task: Task,
    worker: WorkerProfile,
    runner: WorkerRunner,
    adapterVersion: string | null,
    project: Project,
    baseCommit: string,
  ): ExecutionSpec {
    const git = project.git;
    if (!git || !git.enabled) throw new LifecycleError(`Project “${project.name}” is not an enabled git project.`);
    return {
      taskId: task.id,
      goal: task.goal,
      scope: [...task.scope],
      acceptanceCriteria: task.acceptanceCriteria.map((c) => c.text),
      risk: task.risk,
      workerId: worker.id,
      adapter: runner.adapter,
      model: runner.adapter === 'codex' ? this.config.codexModel || null : null,
      adapterVersion,
      projectId: project.id,
      repoRoot: process.platform === 'win32' ? git.canonicalRoot.toLowerCase() : git.canonicalRoot,
      baseBranch: git.baseBranch,
      baseCommit,
      protectedPaths: [...git.protectedPaths].sort(),
      // execution order matters → NOT sorted
      validationCommands: git.validationCommands.map((c) => ({
        name: c.name,
        argv: [...c.argv],
        required: c.required,
        timeoutMs: c.timeoutMs,
      })),
      sandbox: runner.adapter === 'codex' ? 'workspace-write' : 'none',
      credentialMode: runner.adapter === 'codex' ? this.config.codexAuthMode : 'none',
      networkAccess: false,
      dependencyInstallAllowed: false,
      workerTimeoutMs: this.config.attemptTimeoutMs,
      validationDefaultTimeoutMs: this.config.validationTimeoutMs,
    };
  }

  private hashSpec(spec: ExecutionSpec): string {
    return crypto.createHash('sha256').update(JSON.stringify(spec)).digest('hex');
  }

  /** binds a completion approval to the exact final evidence (P1) */
  private computeEvidenceHash(
    attemptId: string,
    evidence: AttemptEvidence,
    validation: AttemptValidation | null,
    checkpointCommit: string | null,
  ): string {
    const canonical = JSON.stringify({
      attemptId,
      checkpointCommit,
      validationStatus: validation?.status ?? 'UNVERIFIED',
      diffSha: crypto.createHash('sha256').update(evidence.diff).digest('hex'),
      diffStat: evidence.diffStat,
      gitStatus: evidence.gitStatus,
      changedFiles: evidence.changedFiles.map((f) => ({ p: f.path, t: f.changeType, a: f.additions, d: f.deletions })),
      protectedViolations: evidence.protectedViolations,
      validationMutations: evidence.validationMutations ?? [],
      symlinkEscapes: evidence.symlinkEscapes ?? [],
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

  // -- request start: exact approval grant (P0.6 + P0-4) -----------------------

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

    // bind the grant to the repo's CURRENT base commit + the full spec
    const probe = await runner.probe();
    const baseCommit = await revParse(project.git!.canonicalRoot, project.git!.baseBranch);
    const spec = this.buildSpec(task, worker, runner, probe.version ?? null, project, baseCommit);
    const hash = this.hashSpec(spec);

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
        (project.git!.protectedPaths.length ? ` Protected paths: ${project.git!.protectedPaths.join(', ')}.` : '') +
        ' This grant is bound to the FULL execution spec (goal, scope, criteria, risk, worker, model, repo, base commit, ' +
        'validation commands, protected paths, timeouts, sandbox) — any change invalidates it.',
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
      executionSpec: spec,
      expiresAt: new Date(Date.now() + this.config.approvalTtlMs).toISOString(),
      singleUse: true,
      consumedAt: null,
    };
    this.store.upsertApproval(approval);
    this.event('approval.requested', `Approval requested: start “${task.title}” with ${worker.name} on ${project.name}`, task.id, 'info', { approvalId: approval.id });
    return { task, approval };
  }

  // -- decision: consume grant transactionally (P0.5 + P0.6 + P0-4) -------------

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

    // re-verify the FULL spec binding against live state BEFORE consuming
    const worker = this.store.worker(approval.workerId ?? '');
    if (!worker) throw new LifecycleError('The approved worker no longer exists.');
    const runner = this.runnerFor(worker);
    const probe = await runner.probe();
    const freshCommit = await revParse(project.git!.canonicalRoot, project.git!.baseBranch);

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
    const preSpec = this.buildSpec(this.mustTask(approval.taskId), worker, runner, probe.version ?? null, this.mustGitProject(task), freshCommit);
    if (current.payloadHash !== this.hashSpec(preSpec)) {
      this.store.tx(() => {
        current.status = 'expired';
        current.decidedAt = nowIso();
        current.decisionNote = `Invalidated: the authorized execution spec changed (repo moved ${current.baseCommit?.slice(0, 8)} → ${freshCommit.slice(0, 8)}, or the task/project/validation configuration was edited after the grant).`;
        this.store.upsertApproval(current);
      });
      throw new ConflictError('The approved execution spec changed — request a new approval.');
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
      executionSpec: preSpec,
      checkpointCommit: null,
      evidenceHash: null,
    };

    // single transaction: RE-READ everything, recompute the spec hash, consume
    // grant, create attempt, acquire all leases (P0-4)
    this.store.tx(() => {
      const fresh = this.store.approval(approval.id)!;
      if (fresh.status !== 'pending') throw new ConflictError(`Approval already ${fresh.status}.`);

      const txTask = this.store.task(approval.taskId);
      if (!txTask) throw new NotFound(`Task ${approval.taskId} not found`);
      const txProject = txTask.gitProjectId ? this.store.project(txTask.gitProjectId) : undefined;
      if (!txProject?.git?.enabled) throw new LifecycleError('The task is no longer bound to an enabled git project.');
      const txWorker = this.store.worker(worker.id);
      if (!txWorker) throw new LifecycleError('The approved worker no longer exists.');

      const txSpec = this.buildSpec(txTask, txWorker, runner, probe.version ?? null, txProject, freshCommit);
      if (fresh.payloadHash !== this.hashSpec(txSpec)) {
        throw new ConflictError('The approved execution spec changed — request a new approval.');
      }
      attempt.executionSpec = txSpec;

      fresh.status = 'approved';
      fresh.decidedAt = nowIso();
      fresh.decisionNote = note ?? null;
      fresh.consumedAt = nowIso();
      fresh.attemptId = attemptId;
      this.store.upsertApproval(fresh);

      this.store.insertAttempt(attempt);
      // idempotency: a second click can never dispatch twice. The op both
      // starts AND completes inside this transaction so a consumed approval
      // never leaves a dangling 'running' operation behind (op-status fix).
      const consumeOp = this.op(attemptId, 'consume_approval', `dispatch:${approval.id}`, JSON.stringify({ approvalId: approval.id }));
      this.finishOp(consumeOp, 'succeeded', 0);
      this.store.acquireLeases(
        attemptId,
        [
          { kind: 'task', resourceKey: txTask.id },
          { kind: 'worker', resourceKey: txWorker.id },
          { kind: 'repo', resourceKey: txProject.id },
        ],
        this.config.leaseTtlMs,
      );

      assertTransition(txTask.status, 'running');
      txTask.status = 'running';
      txTask.attempts += 1;
      txTask.activeAttemptId = attemptId;
      txTask.blockReason = null;
      txTask.progress = 5;
      txTask.phase = 'Creating isolated worktree';
      txTask.runPlan = null;
      if (!txTask.startedAt) txTask.startedAt = nowIso();
      this.store.upsertTask(txTask);

      txWorker.availability = 'busy';
      txWorker.currentTaskId = txTask.id;
      this.store.upsertWorker(txWorker);
    });

    this.event('approval.approved', `Owner approved: ${approval.title}`, task.id, 'success', { attemptId });
    this.event('run.started', `${worker.name} attempt ${attemptId} started (grant ${approval.id.slice(-6)}, base ${freshCommit.slice(0, 8)})`, task.id, 'info', { attemptId });

    this.aborts.set(attemptId, new AbortController());
    void this.pipeline(attemptId).catch((err) => this.failAttempt(attemptId, 'failure', `Pipeline error: ${(err as Error).message}`));
    return this.store.approval(approval.id)!;
  }

  private async decideCompletion(approval: Approval, decision: 'approve' | 'reject', note?: string): Promise<Approval> {
    const task = this.mustTask(approval.taskId);
    const attempt = approval.attemptId ? this.store.attempt(approval.attemptId) : undefined;
    if (!attempt) throw new LifecycleError('Completion approval has no attempt.');

    // P1: re-verify evidence integrity BEFORE consuming an acceptance
    if (decision === 'approve') {
      const fresh = this.store.attempt(attempt.id)!;
      const invalidate = (reason: string): never => {
        this.store.tx(() => {
          const a = this.store.approval(approval.id)!;
          if (a.status === 'pending') {
            a.status = 'expired';
            a.decidedAt = nowIso();
            a.decisionNote = reason;
            this.store.upsertApproval(a);
          }
        });
        throw new ConflictError(reason);
      };
      if (!fresh.evidence) invalidate('Delivery evidence is missing — re-validate before accepting.');
      const expected = this.computeEvidenceHash(fresh.id, fresh.evidence!, fresh.validation, fresh.checkpointCommit ?? null);
      if (approval.payloadHash !== expected) {
        invalidate('Delivery evidence changed since this approval was issued — review the new evidence and approve again.');
      }
      const project = this.store.project(fresh.projectId);
      if (fresh.checkpointCommit && project?.git) {
        if (!(await commitExists(project.git.canonicalRoot, fresh.checkpointCommit))) {
          invalidate(`Checkpoint commit ${fresh.checkpointCommit.slice(0, 10)} is missing from the repository — the delivery is no longer durable.`);
        }
        if (fresh.worktreePath && !fresh.worktreeCleanedAt && fs.existsSync(fresh.worktreePath)) {
          const head = await headCommit(fresh.worktreePath);
          let status: string | null = null;
          try {
            status = await statusPorcelain(fresh.worktreePath);
          } catch {
            status = null;
          }
          if (head !== fresh.checkpointCommit || status !== '') {
            invalidate('The attempt worktree changed after this approval was issued — re-run validation to refresh the evidence, then approve again.');
          }
        }
      }
    }

    this.store.tx(() => {
      const fresh = this.store.approval(approval.id)!;
      if (fresh.status !== 'pending') throw new ConflictError(`Approval already ${fresh.status}`);
      if (decision === 'approve') {
        // atomic re-check inside the consuming transaction (P1)
        const a2 = this.store.attempt(attempt.id)!;
        if (!a2.evidence || fresh.payloadHash !== this.computeEvidenceHash(a2.id, a2.evidence, a2.validation, a2.checkpointCommit ?? null)) {
          throw new ConflictError('Delivery evidence changed — approve the refreshed completion request instead.');
        }
      }
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
        ? `Owner accepted delivery — branch ${attempt.branchName} (checkpoint ${attempt.checkpointCommit?.slice(0, 10) ?? 'n/a'}) remains unmerged for review/merge by the owner`
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

  /**
   * True once cancellation has been requested for this attempt (P0-3).
   *
   * Cancellation is now finalised concurrently with the pipeline, so the
   * attempt may already have reached `cancelled` by the time a checkpoint is
   * evaluated. Every cancellation-related state must stop the pipeline —
   * otherwise it would race on and turn a cancelled attempt into a delivery.
   */
  private cancelRequested(attemptId: string): boolean {
    if (this.aborts.get(attemptId)?.signal.aborted) return true;
    const state = this.store.attempt(attemptId)?.state;
    return state === 'cancelling' || state === 'cancellation_failed' || state === 'cancelled';
  }

  /** track live validation children so cancellation can prove they died */
  private trackValidationProcess(attemptId: string, proc: ChildProcess, event: 'spawned' | 'closed'): void {
    if (event === 'spawned') {
      if (!this.validationProcs.has(attemptId)) this.validationProcs.set(attemptId, new Set());
      this.validationProcs.get(attemptId)!.add(proc);
      return;
    }
    this.validationProcs.get(attemptId)?.delete(proc);
  }

  /**
   * Register (or replace) the runner for an adapter kind. Public so tests and
   * future adapters can plug in without reaching into private state.
   */
  registerRunner(kind: string, runner: WorkerRunner): void {
    this.runners.set(kind, runner);
  }

  /** fail-closed containment re-scan: reason string when an escape is found */
  private containmentGuard(worktreePath: string): string | null {
    const escapes = findSymlinkEscapes(worktreePath);
    return escapes.length ? `symlink/junction escape: ${escapes.slice(0, 8).join(', ')}` : null;
  }

  private async pipeline(attemptId: string): Promise<void> {
    let attempt = this.store.attempt(attemptId)!;
    const task = this.mustTask(attempt.taskId);
    const project = this.store.project(attempt.projectId)!;
    const worker = this.store.worker(attempt.workerId)!;
    const repo = project.git!.canonicalRoot;
    const signal = this.aborts.get(attemptId)?.signal;

    // cancellation checkpoint: cancelled before any side effect → nothing runs
    if (this.cancelRequested(attemptId)) return this.finalizeCancellation(attemptId);

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
      if (this.cancelRequested(attemptId)) return this.finalizeCancellation(attemptId);
      return this.failAttempt(attemptId, 'failure', `Worktree creation failed: ${(err as Error).message}`);
    }
    readGitLinkFile(worktreePath); // touch early so a broken link fails here
    attempt = this.store.attempt(attemptId)!;
    attempt.worktreePath = worktreePath;
    attempt.branchName = branch;
    attempt.worktreeHealth = 'ok';
    this.store.updateAttempt(attempt);
    this.log(attempt, `Isolated worktree ready: ${worktreePath} (branch ${branch} @ ${attempt.baseCommit.slice(0, 8)})`);

    // capture the pre-execution git baseline (HEAD, branch, gitlink, refs,
    // tags, local config, registration) — the yardstick every later integrity
    // check compares against (git-integrity hardening)
    let baseline: GitBaseline;
    try {
      baseline = await captureGitBaseline({ repo, worktreePath, attemptBranch: branch });
    } catch (err) {
      return this.failAttempt(attemptId, 'failure', `Could not capture git baseline: ${(err as Error).message}`);
    }

    // re-enumerate content-filter drivers before the worker phase, so the
    // neutralising overrides cover anything configured since registration
    resetFilterDriverCache();

    // fail-closed containment scan BEFORE the worker is ever launched
    const preLaunchEscapes = findSymlinkEscapes(worktreePath);
    if (preLaunchEscapes.length > 0) {
      return this.failAttempt(attemptId, 'failure', `Refusing to launch the worker — symlink/junction escape detected in the fresh worktree: ${preLaunchEscapes.slice(0, 8).join(', ')}`);
    }

    // cancellation checkpoint: cancelled during creating_worktree must NEVER
    // proceed to worker launch (P0-3)
    if (this.cancelRequested(attemptId)) return this.finalizeCancellation(attemptId);
    this.phase(attempt, 'Worker running', 20);

    // 2) worker execution (P0.8)
    const runner = this.runnerFor(worker);
    const probe = await runner.probe();
    const brief = this.buildBrief(task, project);
    if (this.cancelRequested(attemptId)) return this.finalizeCancellation(attemptId);
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
    // a cancel may have raced the spawn — kill immediately, then await close
    if (this.cancelRequested(attemptId)) handle.cancel();

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

    const outcome = await handle.done; // resolves only after process close
    this.live.delete(attemptId);
    this.finishOp(startOp, outcome.exitReason === 'success' ? 'succeeded' : outcome.exitReason === 'timeout' ? 'timeout' : 'failed', outcome.exitCode, outcome.error);

    // cancellation checkpoint: worker tree is proven dead at this point
    if (this.cancelRequested(attemptId) || outcome.exitReason === 'cancelled') {
      return this.finalizeCancellation(attemptId);
    }

    if (outcome.exitReason !== 'success') {
      return this.failAttempt(attemptId, outcome.exitReason, outcome.error ?? 'Worker failed.', outcome.logTail);
    }

    // 3) post-worker git integrity check (P1 + git-integrity hardening):
    // the worker must not have created a commit, switched branches, or touched
    // refs/tags/config; HEAD must still be the approved base commit.
    const intOp1 = this.op(attemptId, 'integrity_check', `integrity:${attemptId}:post_worker`, JSON.stringify({ phase: 'post_worker' }));
    const issues1 = await verifyWorktreeIntegrity({ repo, worktreePath, expectedBranch: branch, baseCommit: attempt.baseCommit, baseline, requireHeadAtBase: true });
    this.finishOp(intOp1, issues1.length ? 'failed' : 'succeeded', null, issues1.length ? issues1.map((i) => `${i.check}: ${i.detail}`).join('; ') : null);
    if (issues1.length) {
      return this.failAttempt(attemptId, 'failure', `Worktree integrity violated after worker run: ${issues1.map((i) => `${i.check} (${i.detail})`).join('; ')}`, outcome.logTail);
    }
    // fail-closed containment scan after the worker ran
    const postWorkerEscapes = findSymlinkEscapes(worktreePath);
    if (postWorkerEscapes.length > 0) {
      return this.failAttempt(attemptId, 'failure', `Symlink/junction escape detected after the worker ran: ${postWorkerEscapes.slice(0, 8).join(', ')}`, outcome.logTail);
    }
    if (this.cancelRequested(attemptId)) return this.finalizeCancellation(attemptId);

    // 4) pre-validation snapshot + diff capture (P0-1). The worker has just
    // run, so re-enumerate filter drivers before any staging/diff touches
    // worker-authored content.
    resetFilterDriverCache();
    this.phase(attempt, 'Capturing git diff', 85);
    const diffOp = this.op(attemptId, 'capture_diff', `diff:${attemptId}`, JSON.stringify(['git', 'add', '-A', '&&', 'git', 'diff', attempt.baseCommit]));
    let evidence: AttemptEvidence;
    let preValidationTree: string;
    try {
      preValidationTree = await writeTreeSnapshot(worktreePath);
      evidence = await this.captureEvidence(worktreePath, attempt.baseCommit, project, worker.name, outcome.logTail);
      evidence.preValidationTree = preValidationTree;
      this.finishOp(diffOp, 'succeeded', 0);
      this.log(attempt, `Diff captured: ${evidence.changedFiles.length} file(s) changed${evidence.protectedViolations.length ? ` — ⚠ ${evidence.protectedViolations.length} protected-path violation(s)!` : ''}`, evidence.protectedViolations.length ? 'error' : 'info');
    } catch (err) {
      this.finishOp(diffOp, 'failed', null, (err as Error).message);
      if (this.cancelRequested(attemptId)) return this.finalizeCancellation(attemptId);
      return this.failAttempt(attemptId, 'failure', `Diff capture failed: ${(err as Error).message}`);
    }
    if (this.cancelRequested(attemptId)) return this.finalizeCancellation(attemptId);

    // 5) independent validation (P0.9) with cancellation + env isolation
    this.phase(attempt, 'Independent validation', 90);
    attempt = this.store.attempt(attemptId)!;
    if (attempt.state !== 'cancelling') {
      attempt.state = 'validating';
      attempt.evidence = evidence;
      this.store.updateAttempt(attempt);
      const t = this.store.task(attempt.taskId)!;
      assertTransition(t.status, 'verifying');
      t.status = 'verifying';
      this.store.upsertTask(t);
    }
    this.event('verify.started', `Independent validation running in the attempt worktree (${project.git!.validationCommands.length} command(s))`, task.id, 'info', { attemptId });

    const valOp = this.op(attemptId, 'run_validation', `validate:${attemptId}:1`, JSON.stringify(project.git!.validationCommands.map((c) => c.argv)));
    const validation = await runValidation(
      project.git!.validationCommands,
      worktreePath,
      (line, level) => this.log(this.store.attempt(attemptId)!, line, level),
      {
        signal,
        beforeCommand: () => this.containmentGuard(worktreePath),
        onProcess: (proc, event) => this.trackValidationProcess(attemptId, proc, event),
      },
    );
    if (this.cancelRequested(attemptId)) {
      this.finishOp(valOp, 'failed', null, 'Cancelled by owner.');
      return this.finalizeCancellation(attemptId);
    }

    // 6) post-validation snapshot: detect EVERY validation-produced
    // modification and recapture the FINAL evidence (P0-1)
    try {
      const postValidationTree = await writeTreeSnapshot(worktreePath);
      const mutations = postValidationTree === preValidationTree ? [] : await diffTreePaths(worktreePath, preValidationTree, postValidationTree);
      if (mutations.length > 0) {
        // validation changed the worktree → the earlier diff is stale; the
        // delivery evidence MUST represent the actual final worktree
        evidence = await this.captureEvidence(worktreePath, attempt.baseCommit, project, worker.name, outcome.logTail);
        evidence.preValidationTree = preValidationTree;
        this.log(this.store.attempt(attemptId)!, `⚠ validation modified ${mutations.length} file(s): ${mutations.slice(0, 10).join(', ')}${mutations.length > 10 ? ', …' : ''}`, 'error');
      }
      evidence.postValidationTree = postValidationTree;
      evidence.validationMutations = mutations;
    } catch (err) {
      this.finishOp(valOp, 'failed', null, (err as Error).message);
      return this.failAttempt(attemptId, 'failure', `Post-validation snapshot failed: ${(err as Error).message}`);
    }

    // 7) post-validation git integrity (P1) — HEAD must still be at base
    // (validation must not have committed), refs/tags/config unchanged.
    const intOp2 = this.op(attemptId, 'integrity_check', `integrity:${attemptId}:post_validation`, JSON.stringify({ phase: 'post_validation' }));
    const issues2 = await verifyWorktreeIntegrity({ repo, worktreePath, expectedBranch: branch, baseCommit: attempt.baseCommit, baseline, requireHeadAtBase: true });
    this.finishOp(intOp2, issues2.length ? 'failed' : 'succeeded', null, issues2.length ? issues2.map((i) => `${i.check}: ${i.detail}`).join('; ') : null);
    // fail-closed containment scan after validation ran
    const postValEscapes = findSymlinkEscapes(worktreePath);
    if (postValEscapes.length > 0) evidence.symlinkEscapes = [...(evidence.symlinkEscapes ?? []), ...postValEscapes];

    this.applyIntegritySteps(validation, evidence, worktreePath, issues2.map((i) => `${i.check}: ${i.detail}`));
    this.finishOp(valOp, validation.status === 'FAILED' ? 'failed' : 'succeeded', null, validation.status === 'FAILED' ? 'required validation failed' : null);
    if (this.cancelRequested(attemptId)) return this.finalizeCancellation(attemptId);

    // 8) durable checkpoint commit on the attempt branch (P0-2): the delivery
    // must be lossless BEFORE it becomes reviewable. Require HEAD == approved
    // base commit right before checkpointing (git-integrity hardening) and a
    // clean containment scan, so we never checkpoint tampered git state.
    resetFilterDriverCache(); // fresh enumeration before the checkpoint commit
    const preCkHead = await headCommit(worktreePath);
    if (preCkHead !== attempt.baseCommit) {
      return this.failAttempt(attemptId, 'failure', `Refusing to checkpoint — worktree HEAD ${preCkHead?.slice(0, 10) ?? 'unknown'} is not the approved base commit ${attempt.baseCommit.slice(0, 10)} (a commit was created during the attempt).`, outcome.logTail);
    }
    const preCkEscapes = findSymlinkEscapes(worktreePath);
    if (preCkEscapes.length > 0) {
      return this.failAttempt(attemptId, 'failure', `Refusing to checkpoint — symlink/junction escape detected: ${preCkEscapes.slice(0, 8).join(', ')}`, outcome.logTail);
    }
    let checkpoint: string | null = null;
    const ckOp = this.op(attemptId, 'checkpoint', `checkpoint:${attemptId}:1`, JSON.stringify(['git', 'commit', '--no-verify', '-m', `checkpoint attempt ${attemptId}`]));
    try {
      checkpoint = await commitCheckpoint(worktreePath, `Command Center checkpoint — attempt ${attemptId}\n\nApp-generated durable checkpoint of the validated delivery. Never merged or pushed by the Command Center.`);
      evidence.checkpointCommit = checkpoint;
      this.finishOp(ckOp, 'succeeded', 0, null);
      if (checkpoint) this.log(this.store.attempt(attemptId)!, `Durable checkpoint committed on ${branch}: ${checkpoint.slice(0, 10)}`);
      else this.log(this.store.attempt(attemptId)!, 'No changes to checkpoint (empty delivery).');
    } catch (err) {
      this.finishOp(ckOp, 'failed', null, (err as Error).message);
      return this.failAttempt(attemptId, 'failure', `Checkpoint commit failed — refusing to offer a non-durable delivery: ${(err as Error).message}`);
    }
    if (this.cancelRequested(attemptId)) return this.finalizeCancellation(attemptId);

    // 9) delivery review (P0.10)
    this.settleForReview(attemptId, validation, evidence, checkpoint);
  }

  /**
   * Capture real evidence from the worktree: git status, staged diff vs the
   * base commit, protected-path violations (case-correct on Windows) and
   * symlink/junction escapes. Called both pre- and post-validation; the FINAL
   * call is what the owner reviews.
   */
  private async captureEvidence(
    worktree: string,
    baseCommit: string,
    project: Project,
    workerName: string,
    logTail: string[],
  ): Promise<AttemptEvidence> {
    const gitStatus = await statusPorcelain(worktree);
    await stageAll(worktree);
    const files = await diffNumstat(worktree, baseCommit);
    const stat = await diffStat(worktree, baseCommit);
    let diff = await diffUnified(worktree, baseCommit);
    const truncated = diff.length > this.config.maxDiffBytes;
    if (truncated) diff = diff.slice(0, this.config.maxDiffBytes);
    // case-correct on Windows: NTFS is case-insensitive, so path comparison
    // must be too — otherwise "SRC/secret" bypasses a "src/secret" rule (P1)
    const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p).replace(/\/+$/, '');
    const violations = files
      .map((f) => f.path)
      .filter((p) => project.git!.protectedPaths.some((pp) => norm(p) === norm(pp) || norm(p).startsWith(`${norm(pp)}/`)));
    const symlinkEscapes = findSymlinkEscapes(worktree);
    return {
      changedFiles: files.map((f) => ({ path: f.path, changeType: f.changeType, additions: f.additions, deletions: f.deletions, summary: `${f.changeType} by ${workerName}` })),
      diffStat: stat,
      diff,
      diffTruncated: truncated,
      gitStatus,
      protectedViolations: violations,
      workerLogTail: logTail,
      symlinkEscapes,
    };
  }

  /**
   * Fold integrity findings into the validation verdict: protected-path
   * violations, validation-produced mutations (P0-1), symlink escapes and git
   * integrity issues each add a FAILED required step. An attempt with any of
   * these is NEVER marked VERIFIED.
   */
  private applyIntegritySteps(validation: AttemptValidation, evidence: AttemptEvidence, worktree: string, gitIssues: string[]): void {
    const addFailed = (name: string, outputTail: string[]): void => {
      validation.steps.push({
        id: uid('vstep'),
        name,
        argv: [],
        cwd: worktree,
        required: true,
        startedAt: nowIso(),
        endedAt: nowIso(),
        timeoutMs: 0,
        exitCode: null,
        status: 'FAILED',
        outputTail: outputTail.slice(0, 30),
      });
      validation.status = 'FAILED';
    };
    if (evidence.protectedViolations.length > 0) {
      addFailed('protected-paths', evidence.protectedViolations.map((p) => `protected path modified: ${p}`));
    }
    if ((evidence.validationMutations?.length ?? 0) > 0) {
      addFailed('post-validation-integrity', evidence.validationMutations!.map((p) => `validation modified: ${p}`));
    }
    if ((evidence.symlinkEscapes?.length ?? 0) > 0) {
      addFailed('symlink-containment', evidence.symlinkEscapes!.map((p) => `link escapes the worktree: ${p}`));
    }
    if (gitIssues.length > 0) {
      addFailed('git-integrity', gitIssues);
    }
  }

  /** the completion approval bound to the exact final evidence (P1) */
  private issueCompletionApproval(task: Task, attempt: Attempt, validation: AttemptValidation | null): Approval {
    const status = validation?.status ?? 'UNVERIFIED';
    const approval: Approval = {
      id: uid('appr'),
      taskId: task.id,
      type: 'completion',
      title: `Accept delivery of “${task.title}”`,
      description:
        `Attempt ${attempt.id} finished on branch ${attempt.branchName}. ` +
        `${attempt.evidence?.changedFiles.length ?? 0} file(s) changed (real git diff attached, captured AFTER validation). ` +
        `Independent validation: ${status}. ` +
        (attempt.checkpointCommit
          ? `The delivery is durably checkpointed at ${attempt.checkpointCommit.slice(0, 10)} on the attempt branch. `
          : 'The delivery contains no changes (nothing to checkpoint). ') +
        'Accepting does NOT merge or push — the branch stays for your review. ' +
        'Note: the task file scope is advisory (NOT enforced); protected paths and worktree containment ARE enforced.',
      risk: task.risk,
      affectedScope: attempt.evidence?.changedFiles.map((f) => f.path).slice(0, 20) ?? [],
      recommendedAction: status === 'VERIFIED' ? 'approve' : 'reject',
      recommendationReason:
        status === 'VERIFIED'
          ? 'All required validation commands passed in the attempt worktree, and no integrity check failed.'
          : status === 'UNVERIFIED'
            ? 'No validation commands are configured — inspect the diff yourself before accepting.'
            : status === 'PARTIAL'
              ? 'Optional validation steps failed — inspect the results.'
              : 'Required validation or an integrity check FAILED — delivery cannot be considered verified.',
      status: 'pending',
      createdAt: nowIso(),
      decidedAt: null,
      decisionNote: null,
      attemptId: attempt.id,
      projectId: attempt.projectId,
      workerId: attempt.workerId,
      baseCommit: attempt.baseCommit,
      payloadHash: attempt.evidenceHash ?? null,
      executionSpec: null,
      expiresAt: null,
      singleUse: true,
      consumedAt: null,
    };
    this.store.upsertApproval(approval);
    return approval;
  }

  private settleForReview(attemptId: string, validation: Attempt['validation'], evidence: AttemptEvidence, checkpointCommit: string | null): void {
    const attempt = this.store.attempt(attemptId)!;
    // a cancelled/cancelling attempt must never be promoted to a delivery,
    // even if the pipeline raced past a checkpoint
    if (['cancelling', 'cancellation_failed', 'cancelled'].includes(attempt.state)) return;
    const task = this.mustTask(attempt.taskId);
    this.aborts.delete(attemptId);
    this.store.tx(() => {
      attempt.state = 'ready_for_review';
      attempt.validation = validation;
      attempt.evidence = evidence;
      attempt.checkpointCommit = checkpointCommit;
      attempt.evidenceHash = this.computeEvidenceHash(attemptId, evidence, validation, checkpointCommit);
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
      this.issueCompletionApproval(task, attempt, validation);
    });
    this.event('verify.passed', `Attempt ready for review — validation: ${validation?.status ?? 'UNVERIFIED'}`, task.id, validation?.status === 'FAILED' ? 'warning' : 'success', { attemptId });
    this.event('review.ready', `Delivery ready: final post-validation diff + validation evidence attached (branch ${attempt.branchName}${checkpointCommit ? `, checkpoint ${checkpointCommit.slice(0, 10)}` : ''})`, task.id, 'success', { attemptId });
  }

  private failAttempt(attemptId: string, exitReason: Attempt['exitReason'], reason: string, logTail: string[] = []): void {
    const attempt = this.store.attempt(attemptId);
    if (!attempt) return;
    if (attempt.state === 'cancelling') {
      void this.finalizeCancellation(attemptId);
      return;
    }
    // an unproven cancellation must never be overwritten by a generic failure —
    // its leases are held on purpose
    if (['cancelled', 'failed', 'timeout', 'accepted', 'rejected', 'cancellation_failed'].includes(attempt.state)) return;
    this.live.delete(attemptId);
    this.aborts.delete(attemptId);
    this.validationProcs.delete(attemptId);
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

  /**
   * Authoritative cancellation (P0-3): the attempt enters CANCELLING, the
   * shared AbortController fires, live process trees are killed — but leases,
   * the worker and the task are only settled by finalizeCancellation() once
   * the pipeline has PROVEN that every child process terminated.
   */
  cancel(taskId: string): Task {
    const task = this.mustTask(taskId);
    const attempt = task.activeAttemptId ? this.store.attempt(task.activeAttemptId) : undefined;
    const handle = attempt ? this.live.get(attempt.id) : undefined;

    // expire pending approvals for the task in every case
    for (const appr of this.store.approvalsForTask(task.id)) {
      if (appr.status === 'pending') {
        appr.status = 'expired';
        appr.decidedAt = nowIso();
        appr.decisionNote = 'Task was cancelled';
        this.store.upsertApproval(appr);
      }
    }

    if (attempt && attempt.state === 'cancelling') {
      return this.store.task(taskId)!; // already cancelling; nothing new to do
    }

    // a previously FAILED cancellation can be retried: re-attempt termination
    // and re-verify, without ever claiming success in between
    if (attempt && attempt.state === 'cancellation_failed') {
      this.store.tx(() => {
        const a = this.store.attempt(attempt.id)!;
        a.state = 'cancelling';
        a.failureReason = 'Retrying cancellation — re-attempting termination of the tracked process tree.';
        this.store.updateAttempt(a);
      });
      this.aborts.get(attempt.id)?.abort();
      this.event('task.cancelling', `Retrying cancellation of attempt ${attempt.id}`, task.id, 'warning', { attemptId: attempt.id });
      void this.finalizeCancellation(attempt.id);
      return this.store.task(taskId)!;
    }

    if (attempt && ['creating_worktree', 'running', 'validating'].includes(attempt.state)) {
      this.op(attempt.id, 'cancel_worker', `cancel:${attempt.id}`, null);
      this.store.tx(() => {
        const a = this.store.attempt(attempt.id)!;
        a.state = 'cancelling';
        a.failureReason = 'Cancellation requested by owner — stopping worker/validation processes.';
        this.store.updateAttempt(a);
        const t = this.store.task(taskId)!;
        t.phase = 'Cancelling — waiting for process termination';
        this.store.upsertTask(t);
      });
      // fire the shared cancellation context; every pipeline phase checks it
      this.aborts.get(attempt.id)?.abort();
      // track the tree-termination so finalizeCancellation can AWAIT it —
      // nothing settles until the whole process tree is proven dead
      if (handle) {
        this.terminations.set(
          attempt.id,
          (async () => {
            try {
              await handle.cancel();
            } catch {
              /* termination is verified by the proof below */
            }
          })(),
        );
      }
      // Drive finalization from here rather than relying on a pipeline
      // checkpoint: a worker that refuses to die never resolves `done`, so the
      // pipeline would stall and the attempt would sit in `cancelling` forever
      // instead of honestly reporting a failed cancellation.
      void this.finalizeCancellation(attempt.id);
      this.event('task.cancelling', `Owner cancelled “${task.title}” — terminating processes; leases stay held until termination is proven`, task.id, 'warning', { attemptId: attempt.id });
      return this.store.task(taskId)!;
    }

    // no active attempt → immediate, honest cancel
    task.status = 'cancelled';
    task.phase = null;
    this.store.upsertTask(task);
    this.event('task.cancelled', `Owner cancelled “${task.title}”`, task.id, 'warning');
    return this.store.task(taskId)!;
  }

  /**
   * Terminate every tracked process for the attempt (worker tree + any live
   * validation trees) and report a COMBINED proof. `proven` is true only when
   * every captured pid of every tracked process is confirmed dead.
   */
  private async proveAllTerminated(attemptId: string): Promise<TerminationProof> {
    const captured = new Set<number>();
    const live = new Set<number>();
    const details: string[] = [];

    const merge = (p: TerminationProof, label: string): void => {
      for (const c of p.captured) captured.add(c);
      for (const l of p.livePids) live.add(l);
      if (!p.proven) details.push(`${label}: ${p.detail}`);
    };

    // worker tree
    const handle = this.live.get(attemptId);
    if (handle) {
      try {
        merge(await handle.cancel(), 'worker');
      } catch (err) {
        details.push(`worker: termination attempt threw (${(err as Error).message})`);
        live.add(-1); // unknown state → cannot be proven
      }
    }

    // any validation process trees still tracked for this attempt
    for (const proc of this.validationProcs.get(attemptId) ?? []) {
      try {
        merge(await terminateTree(proc), `validation pid ${proc.pid ?? '?'}`);
      } catch (err) {
        details.push(`validation: termination attempt threw (${(err as Error).message})`);
        live.add(-1);
      }
    }

    // the attempt's recorded root pid must also be gone even if the handle was
    // already dropped (e.g. after a phase transition)
    const attempt = this.store.attempt(attemptId);
    if (attempt?.pid != null) {
      captured.add(attempt.pid);
      if (pidAlive(attempt.pid)) {
        live.add(attempt.pid);
        details.push(`recorded worker pid ${attempt.pid} is still alive`);
      }
    }

    const livePids = [...live].filter((p) => p > 0);
    const proven = live.size === 0;
    return {
      proven,
      captured: [...captured],
      livePids,
      detail: proven
        ? `all ${captured.size} tracked process(es) confirmed dead`
        : details.join('; ') || 'termination could not be confirmed',
    };
  }

  /**
   * Terminal step of cancellation. Settles CANCELLED and releases the
   * task/worker/repo leases ONLY when every tracked process is confirmed dead.
   * If termination cannot be proven within the limit the attempt moves to
   * `cancellation_failed`, the leases STAY HELD (that state is an active
   * state), and nothing claims the processes were terminated.
   */
  private finalizeCancellation(attemptId: string): Promise<void> {
    const inFlight = this.finalizing.get(attemptId);
    if (inFlight) return inFlight;
    const run = this.finalizeCancellationInner(attemptId).finally(() => this.finalizing.delete(attemptId));
    this.finalizing.set(attemptId, run);
    return run;
  }

  private async finalizeCancellationInner(attemptId: string): Promise<void> {
    const attempt = this.store.attempt(attemptId);
    if (!attempt || ['cancelled', 'failed', 'timeout', 'accepted', 'rejected', 'cancellation_failed'].includes(attempt.state)) {
      return;
    }

    // ── PROVE termination BEFORE settling state or releasing any lease ──
    const pending = this.terminations.get(attemptId);
    if (pending) await pending;
    const proof = await this.proveAllTerminated(attemptId);
    this.terminations.delete(attemptId);

    const task = this.store.task(attempt.taskId);
    const proofRecord = { ...proof, at: nowIso() };

    if (!proof.proven) {
      // Cancellation FAILED: processes may still be running. Keep the leases,
      // keep the worker busy, and say so plainly.
      this.store.tx(() => {
        const a = this.store.attempt(attemptId)!;
        a.state = 'cancellation_failed';
        a.exitReason = 'unknown';
        a.terminationProof = proofRecord;
        a.failureReason =
          `Cancellation could NOT be confirmed: ${proof.detail}. ` +
          'One or more processes may still be running, so the task/worker/repository leases remain held and the attempt is not marked cancelled. ' +
          'Inspect the listed pids and terminate them, then retry cancellation.';
        this.store.updateAttempt(a);
        // NOTE: no releaseLeases(), no freeWorker() — deliberately.
        const t = this.store.task(a.taskId);
        if (t && !['completed', 'cancelled', 'failed'].includes(t.status)) {
          t.phase = 'Cancellation failed — processes may still be running';
          this.store.upsertTask(t);
        }
      });
      const cancelOpFailed = this.store
        .operationsForAttempt(attemptId)
        .find((o) => o.kind === 'cancel_worker' && o.status === 'running');
      if (cancelOpFailed) this.finishOp(cancelOpFailed, 'failed', null, proof.detail);
      if (task) {
        this.event(
          'task.cancellation_failed',
          `⚠ Cancellation of attempt ${attemptId} could NOT be confirmed — ${proof.detail}. Leases remain held; the task is NOT marked cancelled.`,
          task.id,
          'error',
          { attemptId, livePids: proof.livePids },
        );
      }
      return;
    }

    // proven dead → safe to settle and release
    this.live.delete(attemptId);
    this.aborts.delete(attemptId);
    this.validationProcs.delete(attemptId);
    this.store.tx(() => {
      attempt.state = 'cancelled';
      attempt.exitReason = 'cancelled';
      attempt.endedAt = nowIso();
      attempt.terminationProof = proofRecord;
      attempt.failureReason = `Cancelled by owner. ${proof.detail}; the worktree is preserved.`;
      this.store.updateAttempt(attempt);
      this.store.releaseLeases(attemptId);
      this.freeWorker(attempt.workerId);
      if (task && !['completed', 'cancelled', 'failed'].includes(task.status)) {
        task.status = 'cancelled';
        task.phase = null;
        this.store.upsertTask(task);
      }
    });
    const cancelOp = this.store.operationsForAttempt(attemptId).find((o) => o.kind === 'cancel_worker' && o.status === 'running');
    if (cancelOp) this.finishOp(cancelOp, 'succeeded', 0, null);
    if (task) {
      this.event(
        'task.cancelled',
        `Cancellation of attempt ${attemptId} complete — ${proof.detail}; leases released, worktree preserved`,
        task.id,
        'warning',
        { attemptId },
      );
    }
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
    const worktree = attempt.worktreePath;
    const worker = this.store.worker(attempt.workerId);

    // P1: a revalidation ALWAYS invalidates any pending completion approval —
    // the evidence it was bound to is about to be replaced
    this.store.tx(() => {
      for (const appr of this.store.approvalsForTask(attempt.taskId)) {
        if (appr.type === 'completion' && appr.status === 'pending' && appr.attemptId === attemptId) {
          appr.status = 'expired';
          appr.decidedAt = nowIso();
          appr.decisionNote = 'Superseded by re-validation — a new completion approval will be issued with the refreshed evidence.';
          this.store.upsertApproval(appr);
        }
      }
    });

    // fresh filter-driver enumeration + fail-closed containment scan before
    // re-validating a preserved worktree
    resetFilterDriverCache();
    const revalEscapes = findSymlinkEscapes(worktree);
    if (revalEscapes.length > 0) {
      throw new LifecycleError(`Refusing to re-validate — symlink/junction escape detected: ${revalEscapes.slice(0, 8).join(', ')}`);
    }

    const n = this.store.operationsForAttempt(attemptId).filter((o) => o.kind === 'run_validation').length + 1;
    const valOp = this.op(attemptId, 'run_validation', `validate:${attemptId}:${n}`, JSON.stringify(project.git!.validationCommands.map((c) => c.argv)));
    const preTree = await writeTreeSnapshot(worktree);
    const validation = await runValidation(
      project.git!.validationCommands,
      worktree,
      (line, level) => this.log(this.store.attempt(attemptId)!, line, level),
      {
        beforeCommand: () => this.containmentGuard(worktree),
        onProcess: (proc, event) => this.trackValidationProcess(attemptId, proc, event),
      },
    );
    const postTree = await writeTreeSnapshot(worktree);
    const mutations = postTree === preTree ? [] : await diffTreePaths(worktree, preTree, postTree);

    // final evidence must represent the actual final worktree (P0-1)
    const evidence = await this.captureEvidence(worktree, attempt.baseCommit, project, worker?.name ?? attempt.workerId, attempt.evidence?.workerLogTail ?? []);
    evidence.preValidationTree = preTree;
    evidence.postValidationTree = postTree;
    evidence.validationMutations = mutations;
    const postRevalEscapes = findSymlinkEscapes(worktree);
    if (postRevalEscapes.length > 0) evidence.symlinkEscapes = [...(evidence.symlinkEscapes ?? []), ...postRevalEscapes];
    this.applyIntegritySteps(validation, evidence, worktree, []);
    this.finishOp(valOp, validation.status === 'FAILED' ? 'failed' : 'succeeded');

    // keep the delivery durable: checkpoint anything new (P0-2)
    const ckOp = this.op(attemptId, 'checkpoint', `checkpoint:${attemptId}:reval:${n}`, JSON.stringify(['git', 'commit', '--no-verify']));
    let checkpoint: string | null = null;
    try {
      checkpoint = (await commitCheckpoint(worktree, `Command Center checkpoint — attempt ${attemptId} (after re-validation ${n})`)) ?? attempt.checkpointCommit ?? null;
      evidence.checkpointCommit = checkpoint;
      this.finishOp(ckOp, 'succeeded', 0);
    } catch (err) {
      this.finishOp(ckOp, 'failed', null, (err as Error).message);
      throw new LifecycleError(`Checkpoint after re-validation failed: ${(err as Error).message}`);
    }

    if (attempt.state === 'blocked_reconciliation') {
      this.settleForReview(attemptId, validation, evidence, checkpoint);
    } else {
      this.store.tx(() => {
        const a = this.store.attempt(attemptId)!;
        a.validation = validation;
        a.evidence = evidence;
        a.checkpointCommit = checkpoint;
        a.evidenceHash = this.computeEvidenceHash(attemptId, evidence, validation, checkpoint);
        this.store.updateAttempt(a);
        this.issueCompletionApproval(this.store.task(a.taskId)!, a, validation);
      });
      this.event('verify.passed', `Re-validation finished: ${validation.status} — pending completion approval replaced with refreshed evidence`, attempt.taskId, validation.status === 'FAILED' ? 'warning' : 'success', { attemptId });
    }
    return this.store.attempt(attemptId)!;
  }

  /**
   * Explicit worktree removal (P0-2). Removal is REFUSED unless the worktree
   * content is provably preserved (a verified durable checkpoint commit, or
   * nothing beyond the base commit) — or the owner explicitly confirms
   * irreversible discard. The attempt branch is always kept.
   */
  async cleanupWorktree(attemptId: string, opts: { confirmDiscard?: boolean } = {}): Promise<Attempt> {
    const attempt = this.store.attempt(attemptId);
    if (!attempt) throw new NotFound('Attempt not found.');
    if (['creating_worktree', 'running', 'validating', 'cancelling'].includes(attempt.state)) {
      throw new LifecycleError('Attempt is still active — cancel it first.');
    }
    if (attempt.state === 'cancellation_failed') {
      throw new LifecycleError(
        'Cancellation of this attempt was never confirmed — processes may still be writing to the worktree. ' +
          'Terminate the recorded pids and retry cancellation before cleaning up.',
      );
    }
    if (!attempt.worktreePath || attempt.worktreeCleanedAt) return attempt;
    const project = this.store.project(attempt.projectId);
    const repo = project?.git?.canonicalRoot ?? null;

    // verify losslessness BEFORE destroying anything
    let lossless = false;
    let lossDetail = 'worktree state could not be verified';
    if (!fs.existsSync(attempt.worktreePath)) {
      lossless = true; // nothing on disk to lose
      lossDetail = 'worktree directory already gone';
    } else if (repo) {
      try {
        const status = await statusPorcelain(attempt.worktreePath);
        const head = await headCommit(attempt.worktreePath);
        if (attempt.checkpointCommit) {
          const durable = await commitExists(repo, attempt.checkpointCommit);
          lossless = durable && status === '' && head === attempt.checkpointCommit;
          lossDetail = !durable
            ? `checkpoint ${attempt.checkpointCommit.slice(0, 10)} is missing from the repository`
            : status !== ''
              ? 'the worktree has uncommitted changes beyond the checkpoint'
              : head !== attempt.checkpointCommit
                ? `worktree HEAD ${head?.slice(0, 10) ?? 'unknown'} does not match the checkpoint`
                : '';
        } else {
          lossless = status === '' && head === attempt.baseCommit;
          lossDetail = status !== '' ? 'the worktree has uncommitted work and NO durable checkpoint' : `worktree HEAD moved to ${head?.slice(0, 10) ?? 'unknown'} without a recorded checkpoint`;
        }
      } catch (err) {
        lossless = false;
        lossDetail = `git verification failed: ${(err as Error).message}`;
      }
    }

    if (!lossless && !opts.confirmDiscard) {
      throw new LifecycleError(
        `Refusing to remove the worktree: ${lossDetail}. Removing it now would PERMANENTLY DESTROY that work. ` +
          'Re-validate to create a checkpoint, or explicitly confirm irreversible discard.',
      );
    }

    const op = this.op(attemptId, 'cleanup_worktree', `cleanup:${attemptId}`, JSON.stringify(['git', 'worktree', 'remove', attempt.worktreePath, lossless ? '(lossless)' : '(owner-confirmed discard)']));
    try {
      if (repo && fs.existsSync(attempt.worktreePath)) {
        await worktreeRemove(repo, attempt.worktreePath);
      }
      attempt.worktreeCleanedAt = nowIso();
      attempt.worktreeHealth = 'missing';
      this.store.updateAttempt(attempt);
      this.finishOp(op, 'succeeded', 0);
      this.event(
        'attempt.cleanup',
        lossless
          ? `Worktree removed for attempt ${attemptId} — all work is preserved on branch ${attempt.branchName}${attempt.checkpointCommit ? ` at checkpoint ${attempt.checkpointCommit.slice(0, 10)}` : ' (no changes existed)'}`
          : `Worktree removed for attempt ${attemptId} — owner explicitly confirmed IRREVERSIBLE DISCARD of un-checkpointed work (branch ${attempt.branchName} kept)`,
        attempt.taskId,
        lossless ? 'info' : 'warning',
      );
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
      } else if (attempt.state === 'cancelling' || attempt.state === 'cancellation_failed') {
        // A restart destroys the handles we would need to prove termination,
        // and a recorded pid from the previous process lifetime may have been
        // reused. We therefore do NOT claim the processes died: the attempt
        // stays in cancellation_failed and KEEPS its leases.
        attempt.state = 'cancellation_failed';
        attempt.exitReason = 'unknown';
        attempt.failureReason =
          'Cancellation was in progress when the Command Center restarted, so child-process termination could NOT be re-verified. ' +
          'Processes started by the previous run may still be alive: check the recorded pids, terminate anything still running, then retry cancellation. ' +
          'The task/worker/repository leases remain held and the worktree is preserved.';
      } else {
        attempt.state = 'failed';
        attempt.exitReason = 'unknown';
        attempt.failureReason = 'Worktree creation was interrupted by a restart.';
      }
      attempt.endedAt = nowIso();
      this.store.updateAttempt(attempt);
      // an unproven cancellation keeps its leases and its busy worker
      if (attempt.state !== 'cancellation_failed') {
        this.store.releaseLeases(attempt.id);
        this.freeWorker(attempt.workerId);
      }
      this.finishOp(op, 'succeeded');

      if (task && !['completed', 'cancelled'].includes(task.status)) {
        if (attempt.exitReason === 'cancelled') {
          task.status = 'cancelled';
          task.phase = null;
          this.store.upsertTask(task);
        } else {
          task.status = 'blocked';
          task.blockReason = attempt.failureReason;
          task.phase = 'Blocked (recovery)';
          this.store.upsertTask(task);
        }
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
