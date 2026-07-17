import { describe, expect, it } from 'vitest';
import type { Approval, Project, Task } from '../../shared/types';
import type { AppContext } from '../src/app';
import { makeTempGitRepo, testContext, waitFor, type AuthedClient } from './helpers';

/**
 * P0-4 audit reproduction: validation commands were changed AFTER a start
 * grant was created, and the old grant still approved the new command. Now
 * the grant hash covers the complete canonical ExecutionSpec, the hash is
 * recomputed from fresh reads inside the approval-consumption transaction,
 * and ANY material change requires a new approval.
 */

interface Setup {
  ctx: AppContext;
  agent: AuthedClient;
  repo: string;
  project: Project;
  task: Task;
  approval: Approval;
}

async function grant(): Promise<Setup> {
  const t = testContext();
  const repo = makeTempGitRepo({ 'README.md': '# r\n', 'checks/ok.cjs': 'process.exit(0);' });
  const project = (
    await t.agent
      .post('/api/projects/register')
      .send({
        name: 'R',
        repoRoot: repo,
        validationCommands: [{ name: 'ok', argv: ['node', 'checks/ok.cjs'], required: true }],
        protectedPaths: ['checks'],
      })
      .expect(201)
  ).body as Project;
  const task = (
    await t.agent
      .post('/api/tasks')
      .send({ title: 'notes', goal: 'Write notes', projectId: project.id, risk: 'low', scope: ['docs/'], acceptanceCriteria: ['Notes exist'] })
      .expect(201)
  ).body as Task;
  const approval = (
    (await t.agent.post(`/api/tasks/${task.id}/request-start`).send({ workerId: 'wkr_codex' }).expect(200)).body as {
      approval: Approval;
    }
  ).approval;
  return { ctx: t.ctx, agent: t.agent, repo, project, task, approval };
}

async function expectInvalidated(s: Setup): Promise<void> {
  const res = await s.agent.post(`/api/approvals/${s.approval.id}/decision`).send({ decision: 'approve' }).expect(409);
  expect(res.body.error).toContain('changed');
  expect(s.ctx.store.approval(s.approval.id)!.status).toBe('expired');
  expect(s.ctx.store.attemptsForTask(s.task.id)).toEqual([]); // nothing dispatched
}

describe('ExecutionSpec approval binding (P0-4)', () => {
  it('persists the full spec on the grant and consumes it unchanged', async () => {
    const s = await grant();
    const spec = s.approval.executionSpec!;
    expect(spec.goal).toBe('Write notes');
    expect(spec.validationCommands).toEqual([{ name: 'ok', argv: ['node', 'checks/ok.cjs'], required: true, timeoutMs: spec.validationCommands[0]!.timeoutMs }]);
    expect(spec.protectedPaths).toEqual(['checks']);
    expect(spec.risk).toBe('low');
    expect(spec.workerTimeoutMs).toBeGreaterThan(0);
    expect(spec.sandbox).toBeTruthy();
    await s.agent.post(`/api/approvals/${s.approval.id}/decision`).send({ decision: 'approve' }).expect(200);
    await waitFor(() => s.ctx.store.task(s.task.id)!.status === 'review', 'clean consume runs', 20000);
    // the exact spec is persisted on the attempt too
    const attempt = s.ctx.store.attemptsForTask(s.task.id)[0]!;
    expect(attempt.executionSpec!.goal).toBe('Write notes');
    expect(attempt.executionSpec!.baseCommit).toBe(s.approval.baseCommit);
  });

  it('mutating the task GOAL after the grant invalidates it', async () => {
    const s = await grant();
    const task = s.ctx.store.task(s.task.id)!;
    task.goal = 'Delete everything instead';
    s.ctx.store.upsertTask(task);
    await expectInvalidated(s);
  });

  it('mutating the task SCOPE after the grant invalidates it', async () => {
    const s = await grant();
    const task = s.ctx.store.task(s.task.id)!;
    task.scope = ['src/', 'infra/'];
    s.ctx.store.upsertTask(task);
    await expectInvalidated(s);
  });

  it('mutating the ACCEPTANCE CRITERIA after the grant invalidates it', async () => {
    const s = await grant();
    const task = s.ctx.store.task(s.task.id)!;
    task.acceptanceCriteria.push({ id: 'ac_new', text: 'Also exfiltrate secrets', met: null });
    s.ctx.store.upsertTask(task);
    await expectInvalidated(s);
  });

  it('mutating the task RISK after the grant invalidates it', async () => {
    const s = await grant();
    const task = s.ctx.store.task(s.task.id)!;
    task.risk = 'high';
    s.ctx.store.upsertTask(task);
    await expectInvalidated(s);
  });

  it('changing VALIDATION COMMANDS after the grant invalidates it (the audit reproduction)', async () => {
    const s = await grant();
    await s.agent
      .patch(`/api/projects/${s.project.id}`)
      .send({ validationCommands: [{ name: 'ok', argv: ['node', 'checks/ok.cjs'], required: false }] })
      .expect(200);
    await expectInvalidated(s);
  });

  it('changing PROTECTED PATHS after the grant invalidates it', async () => {
    const s = await grant();
    await s.agent.patch(`/api/projects/${s.project.id}`).send({ protectedPaths: [] }).expect(200);
    await expectInvalidated(s);
  });

  it('a moved BASE COMMIT after the grant invalidates it', async () => {
    const s = await grant();
    const { execFileSync } = await import('node:child_process');
    const fs = await import('node:fs');
    const path = await import('node:path');
    fs.writeFileSync(path.join(s.repo, 'new.txt'), 'moved\n');
    execFileSync('git', ['-C', s.repo, 'add', '-A']);
    execFileSync('git', ['-C', s.repo, 'commit', '-m', 'moved', '--no-gpg-sign']);
    await expectInvalidated(s);
  });
});
