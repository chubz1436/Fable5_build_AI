import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Approval, Project, Task } from '../../shared/types';
import { minimalValidationEnv } from '../src/attempts/validator';
import { makeTempGitRepo, testContext, waitFor } from './helpers';

/**
 * P0-1 audit reproduction: a validation script that overwrites a worker file
 * (TASK_NOTES.md) and exfiltrates a parent-process secret into LEAKED_ENV.txt,
 * exiting 0. Previously: the attempt became VERIFIED and the evidence showed
 * neither mutation. Now: the environment allowlist blocks the secret, the
 * post-validation snapshot detects every mutation, the verdict is FAILED, and
 * the final evidence represents the actual final worktree.
 */

const MUTATOR = `
const fs = require('node:fs');
fs.writeFileSync('TASK_NOTES.md', 'OVERWRITTEN BY VALIDATION\\n');
fs.writeFileSync('LEAKED_ENV.txt', 'secret=' + (process.env.FAKE_SECRET_TOKEN ?? 'ABSENT') + '\\n');
process.exit(0);
`;

async function setup(validationScript: string) {
  const t = testContext();
  const repo = makeTempGitRepo({ 'README.md': '# r\n', 'checks/script.cjs': validationScript });
  const project = (
    await t.agent
      .post('/api/projects/register')
      .send({
        name: 'R',
        repoRoot: repo,
        validationCommands: [{ name: 'script', argv: ['node', 'checks/script.cjs'], required: true }],
      })
      .expect(201)
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
  return { ...t, repo, project, task };
}

describe('validation worktree integrity (P0-1)', () => {
  it('detects validation-produced mutations, blocks VERIFIED, and captures the FINAL worktree as evidence', async () => {
    process.env.FAKE_SECRET_TOKEN = 'super-secret-value-1234567890';
    try {
      const { ctx, task } = await setup(MUTATOR);
      await waitFor(() => ctx.store.task(task.id)!.status === 'review', 'review reached', 20000);
      const attempt = ctx.store.attemptsForTask(task.id)[0]!;

      // the exit-0 validation is NOT trusted: mutations force FAILED
      expect(attempt.validation!.status).toBe('FAILED');
      const integrityStep = attempt.validation!.steps.find((s) => s.name === 'post-validation-integrity')!;
      expect(integrityStep.status).toBe('FAILED');

      // every validation-produced modification is detected
      const mutations = attempt.evidence!.validationMutations!;
      expect(mutations).toContain('TASK_NOTES.md');
      expect(mutations).toContain('LEAKED_ENV.txt');
      expect(attempt.evidence!.preValidationTree).not.toBe(attempt.evidence!.postValidationTree);

      // the final evidence represents the ACTUAL final worktree
      expect(attempt.evidence!.diff).toContain('LEAKED_ENV.txt');
      expect(attempt.evidence!.diff).toContain('OVERWRITTEN BY VALIDATION');
      expect(attempt.evidence!.changedFiles.some((f) => f.path === 'LEAKED_ENV.txt')).toBe(true);

      // the parent secret NEVER reached the validation subprocess
      const leaked = fs.readFileSync(path.join(attempt.worktreePath!, 'LEAKED_ENV.txt'), 'utf8');
      expect(leaked).toContain('secret=ABSENT');
      expect(leaked).not.toContain('super-secret-value');

      // the owner is told to reject
      const completion = ctx.store.approvalsForTask(task.id).find((a) => a.type === 'completion' && a.status === 'pending')!;
      expect(completion.recommendedAction).toBe('reject');
    } finally {
      delete process.env.FAKE_SECRET_TOKEN;
    }
  });

  it('a clean validation run stays VERIFIED with identical pre/post snapshots', async () => {
    const { ctx, task } = await setup(`process.exit(require('node:fs').existsSync('TASK_NOTES.md') ? 0 : 1);`);
    await waitFor(() => ctx.store.task(task.id)!.status === 'review', 'review reached', 20000);
    const attempt = ctx.store.attemptsForTask(task.id)[0]!;
    expect(attempt.validation!.status).toBe('VERIFIED');
    expect(attempt.evidence!.validationMutations).toEqual([]);
    expect(attempt.evidence!.preValidationTree).toBe(attempt.evidence!.postValidationTree);
  });

  it('minimalValidationEnv is an allowlist: secret-like variables are dropped broadly', () => {
    const env = minimalValidationEnv({
      PATH: 'C:\\bin',
      AUTH_TOKEN: 'x',
      ANTHROPIC_API_KEY: 'x',
      OPENAI_API_KEY: 'x',
      GITHUB_TOKEN: 'x',
      AWS_SECRET_ACCESS_KEY: 'x',
      MY_RANDOM_SECRET: 'x',
      DATABASE_URL: 'x',
      TEMP: 'C:\\temp',
    });
    expect(env.PATH).toBe('C:\\bin');
    expect(env.TEMP).toBe('C:\\temp');
    expect(env.CI).toBe('1');
    for (const k of ['AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'MY_RANDOM_SECRET', 'DATABASE_URL']) {
      expect(env[k], k).toBeUndefined();
    }
  });
});

/**
 * P1 delivery integrity: completion approvals are bound to the exact final
 * evidence; any worktree change or revalidation invalidates and replaces them.
 */
describe('delivery integrity (P1)', () => {
  it('worktree tampering after review invalidates the completion approval; revalidation replaces it', async () => {
    const { ctx, agent, task } = await setup(`process.exit(0);`);
    await waitFor(() => ctx.store.task(task.id)!.status === 'review', 'review reached', 20000);
    const attempt = ctx.store.attemptsForTask(task.id)[0]!;
    expect(attempt.checkpointCommit).toBeTruthy();
    expect(attempt.evidenceHash).toBeTruthy();
    const completion = ctx.store.approvalsForTask(task.id).find((a) => a.type === 'completion' && a.status === 'pending')!;
    expect(completion.payloadHash).toBe(attempt.evidenceHash);

    // tamper with the worktree AFTER the approval was issued
    fs.writeFileSync(path.join(attempt.worktreePath!, 'TAMPERED.txt'), 'sneaky\n');
    const res = await agent.post(`/api/approvals/${completion.id}/decision`).send({ decision: 'approve' }).expect(409);
    expect(res.body.error).toContain('changed');
    expect(ctx.store.approval(completion.id)!.status).toBe('expired');

    // revalidation refreshes evidence (including the tampered file), issues a
    // NEW completion approval, and checkpoints the final state durably
    await agent.post(`/api/attempts/${attempt.id}/revalidate`).send({}).expect(200);
    const fresh = ctx.store.attempt(attempt.id)!;
    expect(fresh.evidence!.changedFiles.some((f) => f.path === 'TAMPERED.txt')).toBe(true);
    const newCompletion = ctx.store
      .approvalsForTask(task.id)
      .find((a) => a.type === 'completion' && a.status === 'pending')!;
    expect(newCompletion.id).not.toBe(completion.id);
    expect(newCompletion.payloadHash).toBe(fresh.evidenceHash);
    await agent.post(`/api/approvals/${newCompletion.id}/decision`).send({ decision: 'approve' }).expect(200);
    expect(ctx.store.task(task.id)!.status).toBe('completed');
  });

  it('git integrity: the attempt records pre/post integrity checks and the checkpoint is durable in the repo', async () => {
    const { ctx, repo, task } = await setup(`process.exit(0);`);
    await waitFor(() => ctx.store.task(task.id)!.status === 'review', 'review reached', 20000);
    const attempt = ctx.store.attemptsForTask(task.id)[0]!;
    const ops = ctx.store.operationsForAttempt(attempt.id);
    expect(ops.filter((o) => o.kind === 'integrity_check' && o.status === 'succeeded').length).toBe(2);
    expect(ops.some((o) => o.kind === 'checkpoint' && o.status === 'succeeded')).toBe(true);
    // the checkpoint commit is reachable from the attempt branch in the MAIN repo
    const shown = execFileSync('git', ['-C', repo, 'show', `${attempt.branchName}:TASK_NOTES.md`], { encoding: 'utf8' });
    expect(shown).toContain('Task notes');
    expect(attempt.evidence!.symlinkEscapes).toEqual([]);
  });
});
