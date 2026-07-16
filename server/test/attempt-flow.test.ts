import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Approval, Attempt, Project, Task } from '../../shared/types';
import { makeTempGitRepo, testContext, waitFor } from './helpers';

const VALIDATE_OK = `const fs=require('node:fs');process.exit(fs.existsSync('TASK_NOTES.md')?0:1);`;
const VALIDATE_FAIL = `console.error('required check failing');process.exit(1);`;

async function registerRepo(
  agent: ReturnType<typeof testContext>['agent'],
  repo: string,
  extra: Record<string, unknown> = {},
): Promise<Project> {
  const res = await agent
    .post('/api/projects/register')
    .send({ name: 'Temp Repo', repoRoot: repo, ...extra })
    .expect(201);
  return res.body as Project;
}

async function createGitTask(
  agent: ReturnType<typeof testContext>['agent'],
  projectId: string,
  goal: string,
): Promise<Task> {
  const res = await agent
    .post('/api/tasks')
    .send({ title: goal.slice(0, 60), goal, projectId, risk: 'low', acceptanceCriteria: ['Notes file exists'] })
    .expect(201);
  return res.body as Task;
}

describe('repository-backed attempt vertical slice', () => {
  it('register → approve → isolated worktree → real diff → independent validation → delivery; owner tree untouched, branch unmerged', async () => {
    const { ctx, agent } = testContext();
    const repo = makeTempGitRepo({
      'README.md': '# owner repo\n',
      'checks/validate.cjs': VALIDATE_OK,
    });
    const headBefore = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    // 1) register the local git repository
    const project = await registerRepo(agent, repo, {
      validationCommands: [{ name: 'notes-exist', argv: ['node', 'checks/validate.cjs'], required: true }],
      protectedPaths: ['checks'],
    });
    expect(project.kind).toBe('git');
    expect(project.git!.baseBranch).toBe('main');
    expect(project.git!.health).toBe('ok');
    expect(project.git!.canonicalRoot.toLowerCase()).toBe(repo.toLowerCase());

    // 2) structured task bound to the project
    const task = await createGitTask(agent, project.id, 'Write the task notes file');
    expect(task.gitProjectId).toBe(project.id);

    // 3) exact approval grant
    const reqStart = await agent.post(`/api/tasks/${task.id}/request-start`).send({ workerId: 'wkr_codex' }).expect(200);
    const approval = (reqStart.body as { approval: Approval }).approval;
    expect(approval.payloadHash).toBeTruthy();
    expect(approval.baseCommit).toBe(headBefore);
    expect(approval.singleUse).toBe(true);
    expect(approval.expiresAt).toBeTruthy();
    expect(approval.description).toContain('ISOLATED git worktree');

    // 4) owner approves → attempt dispatch
    await agent.post(`/api/approvals/${approval.id}/decision`).send({ decision: 'approve' }).expect(200);
    expect(ctx.store.task(task.id)!.status).toBe('running');

    // 5) pipeline completes: worker → diff → validation → review
    await waitFor(() => ctx.store.task(task.id)!.status === 'review', 'attempt reaches review', 20000);
    const attempt = ctx.store.attemptsForTask(task.id)[0]!;
    expect(attempt.state).toBe('ready_for_review');
    expect(attempt.branchName).toBe(`cc/${attempt.id}`);
    expect(attempt.baseCommit).toBe(headBefore);
    expect(fs.existsSync(attempt.worktreePath!)).toBe(true);

    // real evidence from the worktree
    expect(attempt.evidence!.changedFiles.some((f) => f.path === 'TASK_NOTES.md' && f.changeType === 'added')).toBe(true);
    expect(attempt.evidence!.diff).toContain('TASK_NOTES.md');
    expect(attempt.evidence!.protectedViolations).toEqual([]);
    // independent validation actually ran and passed
    expect(attempt.validation!.status).toBe('VERIFIED');
    expect(attempt.validation!.steps[0]!.exitCode).toBe(0);

    // durable operations recorded for every consequential step
    const ops = ctx.store.operationsForAttempt(attempt.id).map((o) => o.kind);
    for (const kind of ['consume_approval', 'create_worktree', 'start_worker', 'capture_diff', 'run_validation']) {
      expect(ops, `operation ${kind} recorded`).toContain(kind);
    }

    // leases released after the run
    expect(ctx.store.activeLeases()).toEqual([]);

    // 6) delivery: completion approval bound to the attempt
    const completion = ctx.store.approvalsForTask(task.id).find((a) => a.type === 'completion' && a.status === 'pending')!;
    expect(completion.attemptId).toBe(attempt.id);
    expect(completion.recommendedAction).toBe('approve');
    await agent.post(`/api/approvals/${completion.id}/decision`).send({ decision: 'approve' }).expect(200);
    expect(ctx.store.task(task.id)!.status).toBe('completed');
    expect(ctx.store.attempt(attempt.id)!.state).toBe('accepted');

    // 7) the OWNER's repository is completely untouched
    expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('# owner repo\n');
    expect(fs.existsSync(path.join(repo, 'TASK_NOTES.md'))).toBe(false);
    const headAfter = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    expect(headAfter).toBe(headBefore); // no merge
    const status = execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
    expect(status).toBe(''); // owner tree clean
    // the attempt branch exists and is NOT merged into main
    const branches = execFileSync('git', ['-C', repo, 'branch', '--list', `cc/${attempt.id}`], { encoding: 'utf8' });
    expect(branches).toContain(`cc/${attempt.id}`);

    // 8) explicit safe cleanup removes the worktree but keeps the branch
    await agent.post(`/api/attempts/${attempt.id}/cleanup`).send({}).expect(200);
    expect(fs.existsSync(attempt.worktreePath!)).toBe(false);
    const branchesAfter = execFileSync('git', ['-C', repo, 'branch', '--list', `cc/${attempt.id}`], { encoding: 'utf8' });
    expect(branchesAfter).toContain(`cc/${attempt.id}`);
  });

  it('required validation failure yields FAILED validation and a reject recommendation', async () => {
    const { ctx, agent } = testContext();
    const repo = makeTempGitRepo({ 'README.md': '# r\n', 'checks/fail.cjs': VALIDATE_FAIL });
    const project = await registerRepo(agent, repo, {
      validationCommands: [{ name: 'always-fails', argv: ['node', 'checks/fail.cjs'], required: true }],
    });
    const task = await createGitTask(agent, project.id, 'Write notes anyway');
    const reqStart = await agent.post(`/api/tasks/${task.id}/request-start`).send({}).expect(200);
    await agent.post(`/api/approvals/${(reqStart.body as { approval: Approval }).approval.id}/decision`).send({ decision: 'approve' }).expect(200);

    await waitFor(() => ctx.store.task(task.id)!.status === 'review', 'review with failed validation', 20000);
    const attempt = ctx.store.attemptsForTask(task.id)[0]!;
    expect(attempt.validation!.status).toBe('FAILED');
    expect(attempt.validation!.steps[0]!.status).toBe('FAILED');
    expect(attempt.validation!.steps[0]!.exitCode).toBe(1);
    const completion = ctx.store.approvalsForTask(task.id).find((a) => a.type === 'completion')!;
    expect(completion.recommendedAction).toBe('reject');
    expect(completion.recommendationReason).toContain('FAILED');
  });

  it('no validation commands → UNVERIFIED, never PASSED', async () => {
    const { ctx, agent } = testContext();
    const repo = makeTempGitRepo();
    const project = await registerRepo(agent, repo);
    const task = await createGitTask(agent, project.id, 'Write notes without validation');
    const reqStart = await agent.post(`/api/tasks/${task.id}/request-start`).send({}).expect(200);
    await agent.post(`/api/approvals/${(reqStart.body as { approval: Approval }).approval.id}/decision`).send({ decision: 'approve' }).expect(200);
    await waitFor(() => ctx.store.task(task.id)!.status === 'review', 'review unverified', 20000);
    const attempt = ctx.store.attemptsForTask(task.id)[0]!;
    expect(attempt.validation!.status).toBe('UNVERIFIED');
    const completion = ctx.store.approvalsForTask(task.id).find((a) => a.type === 'completion')!;
    expect(completion.recommendationReason).toContain('inspect the diff yourself');
  });

  it('protected-path modification forces FAILED validation with explicit violations', async () => {
    const { ctx, agent } = testContext();
    const repo = makeTempGitRepo({ 'README.md': '# r\n', 'secrets/keep.txt': 'do not touch\n' });
    const project = await registerRepo(agent, repo, { protectedPaths: ['secrets'] });
    const task = await createGitTask(agent, project.id, 'Try to touch secrets [[TOUCH:secrets/creds.txt]]');
    const reqStart = await agent.post(`/api/tasks/${task.id}/request-start`).send({}).expect(200);
    await agent.post(`/api/approvals/${(reqStart.body as { approval: Approval }).approval.id}/decision`).send({ decision: 'approve' }).expect(200);
    await waitFor(() => ctx.store.task(task.id)!.status === 'review', 'review with violation', 20000);
    const attempt = ctx.store.attemptsForTask(task.id)[0]!;
    expect(attempt.evidence!.protectedViolations).toContain('secrets/creds.txt');
    expect(attempt.validation!.status).toBe('FAILED');
    expect(attempt.validation!.steps.some((s) => s.name === 'protected-paths' && s.status === 'FAILED')).toBe(true);
  });

  it('worker failure blocks the task, frees the worker and releases leases', async () => {
    const { ctx, agent } = testContext();
    const repo = makeTempGitRepo();
    const project = await registerRepo(agent, repo);
    const task = await createGitTask(agent, project.id, 'This one fails [[FAIL]]');
    const reqStart = await agent.post(`/api/tasks/${task.id}/request-start`).send({ workerId: 'wkr_codex' }).expect(200);
    await agent.post(`/api/approvals/${(reqStart.body as { approval: Approval }).approval.id}/decision`).send({ decision: 'approve' }).expect(200);

    await waitFor(() => ctx.store.task(task.id)!.status === 'blocked', 'blocked on worker failure', 20000);
    const attempt = ctx.store.attemptsForTask(task.id)[0]!;
    expect(attempt.state).toBe('failed');
    expect(attempt.exitReason).toBe('failure');
    expect(ctx.store.worker('wkr_codex')!.availability).toBe('idle');
    expect(ctx.store.activeLeases()).toEqual([]);
    // retry creates a NEW approval (a retry is a new attempt, never a reuse)
    const retry = await agent.post(`/api/tasks/${task.id}/retry`).send({}).expect(200);
    expect((retry.body as { approval: Approval }).approval.type).toBe('start');
    expect(ctx.store.task(task.id)!.status).toBe('awaiting_approval');
  });

  it('cancellation kills the running worker process and settles the attempt', async () => {
    const { ctx, agent } = testContext();
    const repo = makeTempGitRepo();
    const project = await registerRepo(agent, repo);
    const task = await createGitTask(agent, project.id, 'Slow run [[SLOW]]');
    const reqStart = await agent.post(`/api/tasks/${task.id}/request-start`).send({}).expect(200);
    await agent.post(`/api/approvals/${(reqStart.body as { approval: Approval }).approval.id}/decision`).send({ decision: 'approve' }).expect(200);

    await waitFor(() => {
      const a = ctx.store.attemptsForTask(task.id)[0] as Attempt | undefined;
      return !!a && a.state === 'running' && a.pid !== null;
    }, 'worker running with pid', 20000);

    await agent.post(`/api/tasks/${task.id}/cancel`).send({}).expect(200);
    const attempt = ctx.store.attemptsForTask(task.id)[0]!;
    expect(attempt.state).toBe('cancelled');
    expect(attempt.exitReason).toBe('cancelled');
    expect(ctx.store.task(task.id)!.status).toBe('cancelled');
    expect(ctx.store.activeLeases()).toEqual([]);
    const cancelOp = ctx.store.operationsForAttempt(attempt.id).find((o) => o.kind === 'cancel_worker');
    expect(cancelOp?.status).toBe('succeeded');
  });
});
