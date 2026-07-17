import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Approval, Project, Task } from '../../shared/types';
import { makeTempGitRepo, testContext, waitFor } from './helpers';

/**
 * P0-3 audit reproduction: cancellation previously flipped the task/leases to
 * cancelled immediately while validation kept running, wrote files, and its
 * operation later became 'succeeded'. Now cancellation is authoritative: a
 * CANCELLING state, one AbortController across the pipeline, tracked process
 * handles, checkpoints between phases, and leases released only after
 * termination is proven.
 */

const SLOW_VALIDATION = `
setTimeout(() => {
  require('node:fs').writeFileSync('VALIDATION_LATE.txt', 'validation kept running after cancel\\n');
  process.exit(0);
}, 8000);
`;

async function setup(opts: { goal: string; validation?: boolean }) {
  const t = testContext();
  const repo = makeTempGitRepo({ 'README.md': '# r\n', 'checks/slow.cjs': SLOW_VALIDATION });
  const project = (
    await t.agent
      .post('/api/projects/register')
      .send({
        name: 'R',
        repoRoot: repo,
        ...(opts.validation
          ? { validationCommands: [{ name: 'slow-check', argv: ['node', 'checks/slow.cjs'], required: true, timeoutMs: 60000 }] }
          : {}),
      })
      .expect(201)
  ).body as Project;
  const task = (
    await t.agent.post('/api/tasks').send({ title: 'c', goal: opts.goal, projectId: project.id }).expect(201)
  ).body as Task;
  const approval = (
    (await t.agent.post(`/api/tasks/${task.id}/request-start`).send({ workerId: 'wkr_codex' }).expect(200)).body as {
      approval: Approval;
    }
  ).approval;
  return { ...t, repo, project, task, approval };
}

describe('authoritative cancellation across every phase (P0-3)', () => {
  it('cancel during creating_worktree never proceeds to worker launch', async () => {
    const { ctx, agent, task, approval } = await setup({ goal: 'Write notes' });
    await agent.post(`/api/approvals/${approval.id}/decision`).send({ decision: 'approve' }).expect(200);
    // cancel immediately — the pipeline is still in creating_worktree
    await agent.post(`/api/tasks/${task.id}/cancel`).send({}).expect(200);
    await waitFor(() => ctx.store.attemptsForTask(task.id)[0]?.state === 'cancelled', 'cancelled', 20000);

    const attempt = ctx.store.attemptsForTask(task.id)[0]!;
    const ops = ctx.store.operationsForAttempt(attempt.id);
    // the worker must never have been launched
    expect(ops.some((o) => o.kind === 'start_worker')).toBe(false);
    expect(attempt.pid).toBeNull();
    expect(ctx.store.task(task.id)!.status).toBe('cancelled');
    expect(ctx.store.activeLeases()).toEqual([]);
  });

  it('cancel during running: leases stay held while CANCELLING, then release once termination is proven', async () => {
    const { ctx, agent, task, approval } = await setup({ goal: 'Slow [[SLOW]]' });
    await agent.post(`/api/approvals/${approval.id}/decision`).send({ decision: 'approve' }).expect(200);
    await waitFor(() => {
      const a = ctx.store.attemptsForTask(task.id)[0];
      return !!a && a.state === 'running' && a.pid !== null;
    }, 'running with pid', 20000);

    await agent.post(`/api/tasks/${task.id}/cancel`).send({}).expect(200);
    const during = ctx.store.attemptsForTask(task.id)[0]!;
    if (during.state === 'cancelling') {
      // authoritative semantics: nothing is released until termination is proven
      expect(ctx.store.activeLeases().length).toBeGreaterThan(0);
      expect(ctx.store.task(task.id)!.status).not.toBe('cancelled');
    }
    await waitFor(() => ctx.store.attemptsForTask(task.id)[0]!.state === 'cancelled', 'cancelled', 20000);
    expect(ctx.store.activeLeases()).toEqual([]);
    expect(ctx.store.worker('wkr_codex')!.availability).toBe('idle');
    expect(ctx.store.task(task.id)!.status).toBe('cancelled');
  });

  it('cancel during validation stops the validation process tree; its operation never becomes succeeded', async () => {
    const { ctx, agent, task, approval } = await setup({ goal: 'Write notes', validation: true });
    await agent.post(`/api/approvals/${approval.id}/decision`).send({ decision: 'approve' }).expect(200);
    await waitFor(() => ctx.store.attemptsForTask(task.id)[0]?.state === 'validating', 'validating', 20000);

    await agent.post(`/api/tasks/${task.id}/cancel`).send({}).expect(200);
    await waitFor(() => ctx.store.attemptsForTask(task.id)[0]!.state === 'cancelled', 'cancelled', 20000);

    const attempt = ctx.store.attemptsForTask(task.id)[0]!;
    // the validation process was killed BEFORE it could write its file
    expect(fs.existsSync(path.join(attempt.worktreePath!, 'VALIDATION_LATE.txt'))).toBe(false);
    // the validation operation must NOT be recorded as succeeded
    const valOp = ctx.store.operationsForAttempt(attempt.id).find((o) => o.kind === 'run_validation');
    if (valOp) expect(valOp.status).not.toBe('succeeded');
    // no completion approval was issued for a cancelled attempt
    expect(ctx.store.approvalsForTask(task.id).some((a) => a.type === 'completion' && a.status === 'pending')).toBe(false);
    expect(ctx.store.task(task.id)!.status).toBe('cancelled');
    expect(ctx.store.activeLeases()).toEqual([]);
    // the cancel operation settles as succeeded once termination is proven
    const cancelOp = ctx.store.operationsForAttempt(attempt.id).find((o) => o.kind === 'cancel_worker');
    expect(cancelOp?.status).toBe('succeeded');
  }, 30000);
});
