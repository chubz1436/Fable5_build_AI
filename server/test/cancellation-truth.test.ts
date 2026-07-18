import { spawn, type ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { Approval, Project, Task } from '../../shared/types';
import { ACTIVE_ATTEMPT_STATES } from '../../shared/types';
import {
  captureProcessTree,
  pidAlive,
  terminateTree,
  type RunnerHandle,
  type RunnerLaunch,
  type RunnerOutcome,
  type TerminationProof,
  type WorkerRunner,
} from '../src/attempts/runners';
import { makeTempGitRepo, testContext, waitFor } from './helpers';

/**
 * Cancellation must be TRUE: nothing may be settled as cancelled — and no
 * task/worker/repo lease may be released — unless every tracked process is
 * confirmed dead. An unproven termination is a FAILURE, reported as such.
 */

/** a worker runner whose "cancel" deliberately fails to kill anything */
class UnkillableRunner implements WorkerRunner {
  readonly adapter = 'test';
  /** the real child we leave running, so the proof genuinely cannot succeed */
  survivor: ChildProcess | null = null;

  async probe() {
    return { path: process.execPath, version: process.version, error: null };
  }

  async start(launch: RunnerLaunch): Promise<RunnerHandle> {
    // a genuinely long-lived child that our cancel() will NOT terminate
    const proc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], {
      cwd: launch.worktree,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.survivor = proc;
    const done = new Promise<RunnerOutcome>(() => {
      /* never settles while the child lives — mirrors a wedged worker */
    });
    return {
      pid: proc.pid ?? null,
      executablePath: process.execPath,
      version: process.version,
      done,
      // reports a proof that is honestly NOT proven (the child is still alive)
      async cancel(): Promise<TerminationProof> {
        const live = proc.pid != null && pidAlive(proc.pid) ? [proc.pid] : [];
        return {
          proven: live.length === 0,
          captured: proc.pid != null ? [proc.pid] : [],
          livePids: live,
          detail: live.length ? `pid ${live[0]} could not be terminated` : 'already dead',
        };
      },
    };
  }
}

async function startAttempt(ctx: ReturnType<typeof testContext>) {
  const repo = makeTempGitRepo({ 'README.md': '# r\n' });
  const project = (await ctx.agent.post('/api/projects/register').send({ name: 'R', repoRoot: repo }).expect(201))
    .body as Project;
  const task = (
    await ctx.agent.post('/api/tasks').send({ title: 'c', goal: 'Slow work', projectId: project.id }).expect(201)
  ).body as Task;
  const approval = (
    (await ctx.agent.post(`/api/tasks/${task.id}/request-start`).send({ workerId: 'wkr_codex' }).expect(200)).body as {
      approval: Approval;
    }
  ).approval;
  await ctx.agent.post(`/api/approvals/${approval.id}/decision`).send({ decision: 'approve' }).expect(200);
  return { repo, project, task };
}

describe('cancellation truth: unproven termination never settles or releases', () => {
  it('an unprovable termination yields cancellation_failed, KEEPS the leases, and does not claim processes died', async () => {
    const t = testContext();
    const runner = new UnkillableRunner();
    t.ctx.attempts.registerRunner('test', runner);
    const { task } = await startAttempt(t);

    await waitFor(() => t.ctx.store.attemptsForTask(task.id)[0]?.state === 'running', 'worker running', 20000);
    const leasesBefore = t.ctx.store.activeLeases().length;
    expect(leasesBefore).toBe(3); // task + worker + repo

    await t.agent.post(`/api/tasks/${task.id}/cancel`).send({}).expect(200);

    // termination cannot be proven → the attempt must land in cancellation_failed
    await waitFor(
      () => t.ctx.store.attemptsForTask(task.id)[0]!.state === 'cancellation_failed',
      'cancellation_failed reached',
      30000,
    );
    const attempt = t.ctx.store.attemptsForTask(task.id)[0]!;

    // 1) NOT settled as cancelled
    expect(attempt.state).toBe('cancellation_failed');
    expect(attempt.exitReason).not.toBe('cancelled');
    expect(t.ctx.store.task(task.id)!.status).not.toBe('cancelled');

    // 2) leases still held — every one of them
    expect(t.ctx.store.activeLeases().length).toBe(3);
    for (const kind of ['task', 'worker', 'repo']) {
      expect(t.ctx.store.activeLeases().some((l) => l.kind === kind)).toBe(true);
    }
    // …and the worker is still marked busy, not handed back out
    expect(t.ctx.store.worker('wkr_codex')!.availability).toBe('busy');

    // 3) the recorded proof is honest and the message never claims success
    expect(attempt.terminationProof).toBeTruthy();
    expect(attempt.terminationProof!.proven).toBe(false);
    expect(attempt.terminationProof!.livePids.length).toBeGreaterThan(0);
    expect(attempt.failureReason).toContain('could NOT be confirmed');
    expect(attempt.failureReason).not.toMatch(/all .*processes were terminated/i);
    expect(attempt.failureReason).not.toMatch(/all processes terminated/i);

    // 4) no event claims termination
    const events = t.ctx.store.eventsForTask(task.id);
    expect(events.some((e) => e.type === 'task.cancellation_failed')).toBe(true);
    for (const e of events) {
      expect(e.message).not.toMatch(/all processes terminated/i);
    }

    // 5) the cancel operation is recorded as failed, not succeeded
    const cancelOp = t.ctx.store.operationsForAttempt(attempt.id).find((o) => o.kind === 'cancel_worker');
    expect(cancelOp?.status).toBe('failed');

    // 6) cleanup is refused while termination is unconfirmed
    const cleanup = await t.agent.post(`/api/attempts/${attempt.id}/cleanup`).send({});
    expect(cleanup.status).toBe(409);
    expect(cleanup.body.error).toContain('never confirmed');

    // 7) cancellation_failed counts as ACTIVE so leases cannot be reaped
    expect(ACTIVE_ATTEMPT_STATES).toContain('cancellation_failed');
    t.ctx.store.reapExpiredLeases();
    expect(t.ctx.store.activeLeases().length).toBe(3);

    // cleanup the survivor process the fake runner deliberately left alive
    if (runner.survivor?.pid) await terminateTree(runner.survivor);
  }, 60_000);

  it('once the processes really are gone, retrying cancellation settles and releases', async () => {
    const t = testContext();
    const runner = new UnkillableRunner();
    t.ctx.attempts.registerRunner('test', runner);
    const { task } = await startAttempt(t);
    await waitFor(() => t.ctx.store.attemptsForTask(task.id)[0]?.state === 'running', 'worker running', 20000);

    await t.agent.post(`/api/tasks/${task.id}/cancel`).send({}).expect(200);
    await waitFor(
      () => t.ctx.store.attemptsForTask(task.id)[0]!.state === 'cancellation_failed',
      'cancellation_failed reached',
      30000,
    );
    expect(t.ctx.store.activeLeases().length).toBe(3);

    // the owner terminates the stuck process for real, then retries
    if (runner.survivor?.pid) await terminateTree(runner.survivor);
    await t.agent.post(`/api/tasks/${task.id}/cancel`).send({}).expect(200);

    await waitFor(
      () => t.ctx.store.attemptsForTask(task.id)[0]!.state === 'cancelled',
      'cancelled after real termination',
      30000,
    );
    const attempt = t.ctx.store.attemptsForTask(task.id)[0]!;
    expect(attempt.terminationProof!.proven).toBe(true);
    expect(t.ctx.store.task(task.id)!.status).toBe('cancelled');
    expect(t.ctx.store.activeLeases()).toEqual([]);
    expect(t.ctx.store.worker('wkr_codex')!.availability).toBe('idle');
  }, 60_000);
});

describe('process-tree capture and proof', () => {
  it('captures descendants and proves the whole tree dead, not just the root', async () => {
    // parent spawns a child that outlives it unless the TREE is killed
    const parent = spawn(
      process.execPath,
      [
        '-e',
        `const {spawn}=require('node:child_process');
         const c=spawn(process.execPath,['-e','setTimeout(()=>{},120000)'],{stdio:'ignore'});
         console.log(c.pid);
         setTimeout(()=>{},120000);`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    const childPid = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('child pid never reported')), 15000);
      parent.stdout!.on('data', (c: Buffer) => {
        const n = Number(c.toString().trim().split('\n')[0]);
        if (Number.isInteger(n)) {
          clearTimeout(timer);
          resolve(n);
        }
      });
    });

    expect(pidAlive(parent.pid)).toBe(true);
    expect(pidAlive(childPid)).toBe(true);

    const captured = await captureProcessTree(parent.pid!);
    expect(captured).toContain(parent.pid);
    expect(captured, 'descendant must be captured before the kill').toContain(childPid);

    const proof = await terminateTree(parent);
    expect(proof.proven).toBe(true);
    expect(proof.livePids).toEqual([]);
    expect(proof.captured).toContain(childPid);
    expect(pidAlive(parent.pid)).toBe(false);
    expect(pidAlive(childPid), 'descendant must be dead too').toBe(false);
  }, 60_000);

  it('reports proven:false (never a false success) when a pid cannot be killed', async () => {
    // A pid that genuinely exists but cannot be terminated by this account:
    // the Windows System process (4) / init (1) on POSIX. Signalling it fails
    // with EPERM, which means ALIVE — terminateTree must not claim success.
    const unkillable = process.platform === 'win32' ? 4 : 1;
    expect(pidAlive(unkillable), 'the probe pid must be alive for this test').toBe(true);

    const fake = { pid: unkillable, kill: () => false } as unknown as ChildProcess;
    const proof = await terminateTree(fake, 1500);

    expect(proof.proven).toBe(false);
    expect(proof.livePids).toContain(unkillable);
    expect(proof.detail).toContain('still alive');
  }, 30_000);

  it('pidAlive treats EPERM (exists, not permitted) as alive, never as dead', () => {
    const unkillable = process.platform === 'win32' ? 4 : 1;
    expect(pidAlive(unkillable)).toBe(true);
    // a pid that certainly does not exist reports dead
    expect(pidAlive(0x7ffffff0)).toBe(false);
    expect(pidAlive(null)).toBe(false);
  });
});
