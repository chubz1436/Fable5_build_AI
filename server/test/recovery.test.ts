import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Approval, Attempt, Project, Task } from '../../shared/types';
import { createContext } from '../src/app';
import { makeTempGitRepo, testContext, waitFor, TEST_TOKEN } from './helpers';

describe('crash / restart reconciliation (P0.11)', () => {
  it('an interrupted running attempt becomes UNKNOWN_OUTCOME with leases released and worktree surfaced', async () => {
    const { ctx, agent, dataDir, dbFile } = testContext();
    const repo = makeTempGitRepo();
    const project = (await agent.post('/api/projects/register').send({ name: 'R', repoRoot: repo }).expect(201)).body as Project;
    const task = (
      await agent.post('/api/tasks').send({ title: 'slow', goal: 'Slow work [[SLOW]]', projectId: project.id }).expect(201)
    ).body as Task;
    const approval = ((await agent.post(`/api/tasks/${task.id}/request-start`).send({}).expect(200)).body as { approval: Approval }).approval;
    await agent.post(`/api/approvals/${approval.id}/decision`).send({ decision: 'approve' }).expect(200);
    await waitFor(() => ctx.store.attemptsForTask(task.id)[0]?.state === 'running', 'running before crash', 20000);
    expect(ctx.store.activeLeases().length).toBe(3);

    // simulate a crash: a NEW context opens the same database (recovery on)
    const rebooted = createContext({
      dataDir,
      dbFile,
      legacyJsonFile: path.join(dataDir, 'command-center.json'),
      worktreesRoot: path.join(dataDir, 'worktrees'),
      authTokenFile: path.join(dataDir, 'auth-token.txt'),
      authToken: TEST_TOKEN,
      recoverOnBoot: false,
      realAdapters: false,
      attemptRunner: 'test',
    });
    await rebooted.attempts.recover();

    const attempt = rebooted.store.attemptsForTask(task.id)[0]!;
    expect(attempt.state).toBe('unknown_outcome');
    expect(attempt.exitReason).toBe('unknown');
    expect(attempt.failureReason).toContain('cannot be proven');
    expect(attempt.worktreeHealth).toBe('ok'); // worktree preserved and intact
    const recoveredTask = rebooted.store.task(task.id)!;
    expect(recoveredTask.status).toBe('blocked');
    expect(rebooted.store.activeLeases()).toEqual([]);
    expect(rebooted.store.worker(attempt.workerId)!.availability).toBe('idle');
    // reconcile operation recorded; interrupted operations marked unknown, not retried
    const ops = rebooted.store.operationsForAttempt(attempt.id);
    expect(ops.some((o) => o.kind === 'reconcile' && o.status === 'succeeded')).toBe(true);
    expect(ops.filter((o) => o.kind === 'start_worker').every((o) => o.status !== 'running')).toBe(true);
    rebooted.store.close();
  });

  it('a missing worktree is surfaced as worktreeHealth=missing', async () => {
    const { ctx } = testContext();
    const task = ctx.store.tasks[0]!;
    const attempt: Attempt = {
      id: 'att_ghost',
      taskId: task.id,
      workerId: 'wkr_codex',
      adapter: 'test',
      model: null,
      projectId: 'gproj_ghost',
      baseBranch: 'main',
      baseCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      worktreePath: path.join(ctx.config.worktreesRoot, 'att_ghost'),
      branchName: 'cc/att_ghost',
      approvalId: 'appr_ghost',
      state: 'running',
      exitReason: null,
      executablePath: null,
      executableVersion: null,
      pid: 12345,
      startedAt: new Date().toISOString(),
      endedAt: null,
      failureReason: null,
      validation: null,
      evidence: null,
      delivery: null,
      worktreeCleanedAt: null,
      worktreeHealth: null,
    };
    ctx.store.insertAttempt(attempt);
    await ctx.attempts.recover();
    const recovered = ctx.store.attempt('att_ghost')!;
    expect(recovered.state).toBe('unknown_outcome');
    expect(recovered.worktreeHealth).toBe('missing');
  });

  it('an interrupted validation becomes BLOCKED_RECONCILIATION and re-validate (not re-run) restores review', async () => {
    const { ctx, agent } = testContext();
    const repo = makeTempGitRepo({ 'README.md': '# r\n', 'checks/ok.cjs': 'process.exit(0);' });
    const project = (
      await agent
        .post('/api/projects/register')
        .send({ name: 'R', repoRoot: repo, validationCommands: [{ name: 'ok', argv: ['node', 'checks/ok.cjs'] }] })
        .expect(201)
    ).body as Project;
    const task = (
      await agent.post('/api/tasks').send({ title: 'n', goal: 'Write notes', projectId: project.id }).expect(201)
    ).body as Task;
    const approval = ((await agent.post(`/api/tasks/${task.id}/request-start`).send({}).expect(200)).body as { approval: Approval }).approval;
    await agent.post(`/api/approvals/${approval.id}/decision`).send({ decision: 'approve' }).expect(200);
    await waitFor(() => ctx.store.task(task.id)!.status === 'review', 'first run settles', 20000);

    // force the attempt back into a validating state as if a crash hit mid-validation
    const attempt = ctx.store.attemptsForTask(task.id)[0]!;
    attempt.state = 'validating';
    ctx.store.updateAttempt(attempt);
    const t = ctx.store.task(task.id)!;
    t.status = 'verifying';
    ctx.store.upsertTask(t);

    await ctx.attempts.recover();
    expect(ctx.store.attempt(attempt.id)!.state).toBe('blocked_reconciliation');
    expect(ctx.store.task(task.id)!.status).toBe('blocked');

    // owner re-runs validation only — no worker re-run, straight back to review
    const res = await agent.post(`/api/attempts/${attempt.id}/revalidate`).send({}).expect(200);
    expect((res.body as Attempt).state).toBe('ready_for_review');
    expect(ctx.store.task(task.id)!.status).toBe('review');
    // exactly one start_worker operation ever ran
    const workerOps = ctx.store.operationsForAttempt(attempt.id).filter((o) => o.kind === 'start_worker');
    expect(workerOps.length).toBe(1);
  });
});
