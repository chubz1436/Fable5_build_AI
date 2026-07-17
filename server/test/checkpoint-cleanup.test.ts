import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Approval, Project, Task } from '../../shared/types';
import { makeTempGitRepo, testContext, waitFor } from './helpers';

/**
 * P0-2 audit reproduction: cleanup previously ran `git worktree remove
 * --force` on a worktree whose work was only staged/uncommitted — the branch
 * survived but was empty. Now every reviewable delivery gets an app-generated
 * checkpoint commit first, cleanup refuses to destroy un-checkpointed work
 * without explicit confirmation, and the implementation stays recoverable
 * after cleanup.
 */

async function runToReview() {
  const t = testContext();
  const repo = makeTempGitRepo({ 'README.md': '# r\n' });
  const project = (
    await t.agent.post('/api/projects/register').send({ name: 'R', repoRoot: repo }).expect(201)
  ).body as Project;
  const task = (
    await t.agent.post('/api/tasks').send({ title: 'notes', goal: 'Write notes', projectId: project.id }).expect(201)
  ).body as Task;
  const approval = (
    (await t.agent.post(`/api/tasks/${task.id}/request-start`).send({ workerId: 'wkr_codex' }).expect(200)).body as {
      approval: Approval;
    }
  ).approval;
  await t.agent.post(`/api/approvals/${approval.id}/decision`).send({ decision: 'approve' }).expect(200);
  await waitFor(() => t.ctx.store.task(task.id)!.status === 'review', 'review reached', 20000);
  const attempt = t.ctx.store.attemptsForTask(task.id)[0]!;
  return { ...t, repo, project, task, attempt };
}

describe('durable checkpoint + safe cleanup (P0-2)', () => {
  it('a reviewable delivery has a checkpoint commit; cleanup is lossless and the work stays recoverable', async () => {
    const { agent, repo, attempt } = await runToReview();

    // checkpoint recorded on the attempt AND in the evidence
    expect(attempt.checkpointCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(attempt.evidence!.checkpointCommit).toBe(attempt.checkpointCommit);

    // the worktree is clean at the checkpoint (nothing left uncommitted)
    const status = execFileSync('git', ['-C', attempt.worktreePath!, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
    expect(status).toBe('');

    // never merged or pushed: main repo HEAD unchanged
    const mainHead = execFileSync('git', ['-C', repo, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
    expect(mainHead).toBe(attempt.baseCommit);

    // cleanup succeeds WITHOUT a discard confirmation (it is lossless)
    await agent.post(`/api/attempts/${attempt.id}/cleanup`).send({}).expect(200);
    expect(fs.existsSync(attempt.worktreePath!)).toBe(false);

    // RECOVERABILITY PROOF: after cleanup the full implementation is still
    // reachable from the attempt branch in the owner's repository
    const branchTip = execFileSync('git', ['-C', repo, 'rev-parse', attempt.branchName!], { encoding: 'utf8' }).trim();
    expect(branchTip).toBe(attempt.checkpointCommit);
    const notes = execFileSync('git', ['-C', repo, 'show', `${attempt.branchName}:TASK_NOTES.md`], { encoding: 'utf8' });
    expect(notes).toContain('Task notes');
  });

  it('cleanup REFUSES to destroy work beyond the checkpoint unless the owner confirms irreversible discard', async () => {
    const { ctx, agent, attempt } = await runToReview();

    // un-checkpointed extra work appears in the worktree
    fs.writeFileSync(path.join(attempt.worktreePath!, 'UNSAVED.txt'), 'would be lost\n');

    const refused = await agent.post(`/api/attempts/${attempt.id}/cleanup`).send({}).expect(409);
    expect(refused.body.error).toContain('PERMANENTLY DESTROY');
    expect(fs.existsSync(attempt.worktreePath!)).toBe(true); // nothing was removed
    expect(ctx.store.attempt(attempt.id)!.worktreeCleanedAt).toBeNull();

    // explicit owner confirmation performs the irreversible discard
    await agent.post(`/api/attempts/${attempt.id}/cleanup`).send({ confirmDiscard: true }).expect(200);
    expect(fs.existsSync(attempt.worktreePath!)).toBe(false);
  });

  it('a cancelled attempt with uncommitted work is protected the same way', async () => {
    const t = testContext();
    const repo = makeTempGitRepo();
    const project = (
      await t.agent.post('/api/projects/register').send({ name: 'R', repoRoot: repo }).expect(201)
    ).body as Project;
    const task = (
      await t.agent.post('/api/tasks').send({ title: 'slow', goal: 'Slow [[SLOW]]', projectId: project.id }).expect(201)
    ).body as Task;
    const approval = (
      (await t.agent.post(`/api/tasks/${task.id}/request-start`).send({ workerId: 'wkr_codex' }).expect(200)).body as {
        approval: Approval;
      }
    ).approval;
    await t.agent.post(`/api/approvals/${approval.id}/decision`).send({ decision: 'approve' }).expect(200);
    await waitFor(() => t.ctx.store.attemptsForTask(task.id)[0]?.state === 'running', 'running', 20000);
    await t.agent.post(`/api/tasks/${task.id}/cancel`).send({}).expect(200);
    await waitFor(() => t.ctx.store.attemptsForTask(task.id)[0]!.state === 'cancelled', 'cancelled', 20000);
    const attempt = t.ctx.store.attemptsForTask(task.id)[0]!;

    // simulate partial work left behind (the [[SLOW]] runner was killed before writing)
    fs.writeFileSync(path.join(attempt.worktreePath!, 'PARTIAL.txt'), 'half-done\n');

    const refused = await t.agent.post(`/api/attempts/${attempt.id}/cleanup`).send({}).expect(409);
    expect(refused.body.error).toContain('checkpoint');
    await t.agent.post(`/api/attempts/${attempt.id}/cleanup`).send({ confirmDiscard: true }).expect(200);
  });
});
