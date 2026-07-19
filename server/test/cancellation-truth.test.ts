import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Approval, Project, Task } from '../../shared/types';
import { ACTIVE_ATTEMPT_STATES } from '../../shared/types';
import { runValidation } from '../src/attempts/validator';
import {
  captureProcessTree,
  isSafeRootPid,
  pidAlive,
  terminateTree,
  type ProcessBackend,
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

/**
 * A runner whose `cancel()` gives an HONEST first proof (root dead, one
 * captured descendant still alive) but, if ever called a SECOND time for the
 * same termination, would report a WRONG success — mimicking exactly what a
 * naive re-derivation of the process tree would see: the root is already
 * dead, so a fresh scan can no longer find the descendant as one of its
 * children (it was reparented away), and the second capture silently
 * undercounts what needs to be proven dead. AttemptService must never reach
 * that second call — it has to cache and reuse the first, honest proof.
 */
class ShrinkingProofRunner implements WorkerRunner {
  readonly adapter = 'test';
  calls = 0;
  readonly rootPid = 970001;
  readonly childPid = 970002;

  async probe() {
    return { path: process.execPath, version: process.version, error: null };
  }

  async start(): Promise<RunnerHandle> {
    const done = new Promise<RunnerOutcome>(() => {
      /* never settles on its own — only an owner cancel ends this attempt */
    });
    const self = this;
    return {
      pid: this.rootPid,
      executablePath: process.execPath,
      version: process.version,
      done,
      async cancel(): Promise<TerminationProof> {
        self.calls += 1;
        if (self.calls === 1) {
          return {
            proven: false,
            captured: [self.rootPid, self.childPid],
            livePids: [self.childPid],
            detail: `pid ${self.childPid} could not be terminated`,
          };
        }
        return {
          proven: true,
          captured: [self.rootPid],
          livePids: [],
          detail: 'all 1 captured process(es) confirmed dead (WRONG — this undercounts the captured child)',
        };
      },
    };
  }
}

describe('termination proof merging: the first captured tree is never discarded', () => {
  it('an honestly unproven worker cancellation never settles cancelled, even though a second re-derivation would look successful', async () => {
    const t = testContext();
    const runner = new ShrinkingProofRunner();
    t.ctx.attempts.registerRunner('test', runner);
    const { task } = await startAttempt(t);
    await waitFor(() => t.ctx.store.attemptsForTask(task.id)[0]?.state === 'running', 'worker running', 20000);

    await t.agent.post(`/api/tasks/${task.id}/cancel`).send({}).expect(200);
    await waitFor(
      () => t.ctx.store.attemptsForTask(task.id)[0]!.state === 'cancellation_failed',
      'cancellation_failed reached',
      20000,
    );

    const attempt = t.ctx.store.attemptsForTask(task.id)[0]!;
    // settled on the FIRST, honest proof — never promoted to cancelled
    expect(attempt.state).toBe('cancellation_failed');
    expect(attempt.exitReason).not.toBe('cancelled');
    expect(attempt.terminationProof!.proven).toBe(false);
    expect(attempt.terminationProof!.captured).toContain(runner.childPid);
    expect(attempt.terminationProof!.livePids).toContain(runner.childPid);
    expect(t.ctx.store.task(task.id)!.status).not.toBe('cancelled');
    expect(t.ctx.store.activeLeases().length).toBe(3);
    expect(t.ctx.store.worker('wkr_codex')!.availability).toBe('busy');

    // the crux of the regression: cancel() must be called exactly ONCE for
    // this termination — the second (buggy, "successful") result must never
    // have been consulted
    expect(runner.calls).toBe(1);
  }, 30_000);
});

/** a worker runner that reports, after a short delay, an internal hard
 * timeout whose termination could NOT be proven — mirrors runSession()'s
 * timeout path resolving with an unproven `terminationProof` attached to the
 * outcome, without needing a real unkillable OS process. */
class TimeoutSurvivorRunner implements WorkerRunner {
  readonly adapter = 'test';
  readonly rootPid = 970101;
  readonly childPid = 970102;

  async probe() {
    return { path: process.execPath, version: process.version, error: null };
  }

  async start(): Promise<RunnerHandle> {
    const proof: TerminationProof = {
      proven: false,
      captured: [this.rootPid, this.childPid],
      livePids: [this.childPid],
      detail: `pid ${this.childPid} could not be terminated`,
    };
    const done: Promise<RunnerOutcome> = new Promise((resolve) => {
      setTimeout(() => {
        resolve({
          exitReason: 'timeout',
          exitCode: null,
          error: 'Worker exceeded the attempt time limit.',
          logTail: ['test-runner: simulated hang'],
          terminationProof: proof,
        });
      }, 50);
    });
    return {
      pid: this.rootPid,
      executablePath: process.execPath,
      version: process.version,
      done,
      async cancel(): Promise<TerminationProof> {
        return proof;
      },
    };
  }
}

describe('automatic timeout termination is authoritative', () => {
  it('a worker timeout whose process tree cannot be confirmed dead lands in termination_failed and keeps the leases', async () => {
    const t = testContext();
    t.ctx.attempts.registerRunner('test', new TimeoutSurvivorRunner());
    const { task } = await startAttempt(t);

    await waitFor(
      () => t.ctx.store.attemptsForTask(task.id)[0]?.state === 'termination_failed',
      'termination_failed reached',
      20000,
    );
    const attempt = t.ctx.store.attemptsForTask(task.id)[0]!;

    expect(attempt.state).toBe('termination_failed');
    expect(attempt.exitReason).not.toBe('timeout');
    expect(attempt.terminationProof!.proven).toBe(false);
    expect(attempt.terminationProof!.livePids.length).toBeGreaterThan(0);
    expect(attempt.failureReason).toContain('worker timeout');
    expect(attempt.failureReason).not.toMatch(/all .*processes were terminated/i);

    // leases and worker stay held/busy exactly like an unproven cancellation
    expect(t.ctx.store.activeLeases().length).toBe(3);
    expect(t.ctx.store.worker('wkr_codex')!.availability).toBe('busy');
    expect(t.ctx.store.task(task.id)!.status).not.toBe('cancelled');
    expect(ACTIVE_ATTEMPT_STATES).toContain('termination_failed');

    // cleanup must be refused while termination is unconfirmed, same as cancellation_failed
    const cleanup = await t.agent.post(`/api/attempts/${attempt.id}/cleanup`).send({});
    expect(cleanup.status).toBe(409);
    expect(cleanup.body.error).toContain('never confirmed');
  }, 30_000);

  it('a validation command timeout awaits full termination proof before resolving, and never untracks the process merely because it closed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chubz-valterm-'));
    const commands = [
      { id: 'v1', name: 'slow', argv: [process.execPath, '-e', 'setTimeout(() => {}, 60000)'], required: true, timeoutMs: 300 },
    ];

    const survivorPid = 970201;
    const unprovenProof: TerminationProof = {
      proven: false,
      captured: [survivorPid + 1, survivorPid],
      livePids: [survivorPid],
      detail: `pid ${survivorPid} could not be terminated`,
    };

    const terminationEvents: Array<{ proof: TerminationProof; ctx: { command: string; reason: 'timeout' | 'cancelled' } }> = [];
    const trackEvents: Array<{ event: 'spawned' | 'closed' }> = [];
    let terminateCalls = 0;
    let spawnedProc: ChildProcess | null = null;

    const validation = await runValidation(commands, dir, () => {}, {
      onProcess: (proc, event) => {
        trackEvents.push({ event });
        if (event === 'spawned') spawnedProc = proc;
      },
      // the injected terminate is fully fake — it reports "unproven" without
      // actually killing anything, so we clean the real child up below
      terminate: async () => {
        terminateCalls += 1;
        return unprovenProof;
      },
      onTermination: (proof, ctx) => terminationEvents.push({ proof, ctx }),
    });

    // the command is reported as TIMEOUT, and the termination call happened
    // exactly once (never re-derived) with the unproven result surfaced —
    // never silently swallowed as if the process had simply "closed"
    expect(validation.status).toBe('FAILED');
    expect(validation.steps[0]!.status).toBe('TIMEOUT');
    expect(terminateCalls).toBe(1);
    expect(terminationEvents).toHaveLength(1);
    expect(terminationEvents[0]!.proof.proven).toBe(false);
    expect(terminationEvents[0]!.proof.livePids).toContain(survivorPid);
    expect(terminationEvents[0]!.ctx.reason).toBe('timeout');

    // untracking ('closed') must have happened, but only AFTER the proof
    // above was already reported — never merely because stdio closed
    expect(trackEvents.filter((e) => e.event === 'spawned')).toHaveLength(1);
    expect(trackEvents.filter((e) => e.event === 'closed')).toHaveLength(1);

    // the injected terminate() never actually killed the real child (it's a
    // fake proof) — clean it up for real so it doesn't linger past the test
    if (spawnedProc) await terminateTree(spawnedProc);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 20_000);
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

  it('reports proven:false (never a false success) when a pid cannot be killed — via an injected mock backend, never a real system PID', async () => {
    // A small deterministic fake ProcessBackend: pid 88888's "kill" never
    // actually removes it from the alive set, so terminateTree must report
    // proven:false honestly. No real process, no real OS call, ever involved.
    const stubbornPid = 88_888;
    const rootPid = 88_000;
    const kills: number[] = [];
    const backend: ProcessBackend = {
      async captureTree() {
        return [rootPid, stubbornPid];
      },
      async kill(pid) {
        kills.push(pid);
        // pretend the root dies but the "stubborn" descendant never does
      },
      pidAlive(pid) {
        return pid === stubbornPid;
      },
      groupAlive() {
        return false;
      },
      async wait() {
        /* resolve immediately — no real waiting needed for a fake backend */
      },
    };
    const fake = { pid: rootPid } as unknown as ChildProcess;
    const proof = await terminateTree(fake, 300, backend);

    expect(proof.proven).toBe(false);
    expect(proof.livePids).toEqual([stubbornPid]);
    expect(proof.captured).toEqual([rootPid, stubbornPid]);
    expect(proof.detail).toContain('still alive');
    expect(kills).toContain(rootPid); // the kill WAS attempted — it just didn't work
  });

  it('never calls terminateTree against PID 0, 1, 4 or a negative pid — the guard rejects them before any signal is sent', async () => {
    let killCalls = 0;
    let captureCalls = 0;
    const spyBackend: ProcessBackend = {
      async captureTree() {
        captureCalls += 1;
        return [];
      },
      async kill() {
        killCalls += 1;
      },
      pidAlive: () => false,
      groupAlive: () => false,
      async wait() {},
    };

    for (const unsafePid of [0, 1, -1, -5, ...(process.platform === 'win32' ? [4] : [])]) {
      expect(isSafeRootPid(unsafePid), `pid ${unsafePid} must be rejected as a root pid`).toBe(false);
      const fake = { pid: unsafePid } as unknown as ChildProcess;
      const proof = await terminateTree(fake, 100, spyBackend);
      expect(proof.proven).toBe(false);
      expect(proof.detail).toContain('unsafe root pid');
    }
    // the guard trips BEFORE any backend interaction — never even captures
    // the tree, let alone signals it
    expect(captureCalls).toBe(0);
    expect(killCalls).toBe(0);
  });

  it('pidAlive treats EPERM (exists, not permitted) as alive, never as dead', () => {
    const unkillable = process.platform === 'win32' ? 4 : 1;
    expect(pidAlive(unkillable)).toBe(true);
    // a pid that certainly does not exist reports dead
    expect(pidAlive(0x7ffffff0)).toBe(false);
    expect(pidAlive(null)).toBe(false);
  });
});
