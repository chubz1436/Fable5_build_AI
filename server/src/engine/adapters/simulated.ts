import type { FileChange, RunStep, TestReport } from '../../../../shared/types';
import { clamp, pick, seededRandom, uid } from '../../domain/util';
import type { RunContext, WorkerAdapter } from './types';

interface RunnerState {
  cancelled: boolean;
  paused: boolean;
  resumeWaiters: Array<() => void>;
}

/**
 * Safe simulated execution engine. Produces realistic phases, logs, plans,
 * blockers, mid-run approval requests and evidence — deterministically seeded
 * per (task, attempt) so behavior is reproducible and testable.
 *
 * Scenario rules (documented, not hidden):
 *  - risk high  → requests a mid-run owner approval before the risky step
 *  - attempt 1 of any medium/high-risk task → hits one realistic blocker;
 *    retry or reassignment succeeds
 *  - low risk   → clean run
 */
export class SimulatedAdapter implements WorkerAdapter {
  readonly kind = 'simulated';
  private runners = new Map<string, RunnerState>();

  start(ctx: RunContext): void {
    const state: RunnerState = { cancelled: false, paused: false, resumeWaiters: [] };
    this.runners.set(ctx.task.id, state);
    // fire and forget; all outcomes are reported through ctx
    void this.run(ctx, state).catch((err) => {
      ctx.log(`Adapter crashed: ${(err as Error).message}`, 'error');
      ctx.blocked(`Internal simulator error: ${(err as Error).message}`);
    });
  }

  pause(taskId: string): void {
    const s = this.runners.get(taskId);
    if (s) s.paused = true;
  }

  resume(taskId: string): void {
    const s = this.runners.get(taskId);
    if (!s) return;
    s.paused = false;
    s.resumeWaiters.forEach((w) => w());
    s.resumeWaiters = [];
  }

  cancel(taskId: string): void {
    const s = this.runners.get(taskId);
    if (!s) return;
    s.cancelled = true;
    // unblock a paused runner so it can observe cancellation and exit
    s.resumeWaiters.forEach((w) => w());
    s.resumeWaiters = [];
  }

  // -------------------------------------------------------------------------

  private async run(ctx: RunContext, state: RunnerState): Promise<void> {
    const { task, worker } = ctx;
    const rand = seededRandom(`${task.id}:${ctx.attempt}`);
    const scopeMain = task.scope[0] ?? 'src/';

    const steps = this.buildPlan(ctx);
    ctx.plan(steps.map((s) => ({ id: s.id, label: s.label, done: false })));

    if (ctx.handoff) {
      ctx.phase('Ingesting handoff context');
      ctx.log(`Handoff received from previous worker — reason: ${ctx.handoff.reason}`);
      ctx.log(`Completed so far: ${ctx.handoff.context.completedWork.length} step(s); next action: ${ctx.handoff.context.nextAction}`);
      await this.sleep(ctx, state, 900);
      if (state.cancelled) return;
    }

    const total = steps.length;
    for (let i = 0; i < total; i++) {
      const step = steps[i]!;
      if (state.cancelled) return;
      await this.waitIfPaused(state);
      if (state.cancelled) return;

      ctx.phase(step.label);

      // mid-run approval gate before the risky step
      if (step.gate === 'approval' && !ctx.priorMidrunApproved) {
        ctx.log(`${worker.name} is requesting owner approval before a guarded change…`, 'warning');
        const ok = await ctx.requestApproval({
          title: `Guarded change in ${scopeMain}`,
          description:
            `${worker.name} wants to apply a high-risk change while working on “${task.title}”: ` +
            `${step.riskyDetail}. Execution is paused until you decide.`,
          affectedScope: task.scope,
        });
        if (state.cancelled) return;
        if (!ok) {
          ctx.blocked('Owner declined the guarded change — task needs re-scoping before another attempt.');
          return;
        }
        ctx.log('Owner approved the guarded change — continuing.', 'success');
      }

      await this.sleep(ctx, state, 900 + rand() * 900);
      if (state.cancelled) return;
      await this.waitIfPaused(state);
      if (state.cancelled) return;

      // blocker injection at the test step on the first attempt of risky work
      if (step.gate === 'blocker' && ctx.attempt === 1 && task.risk !== 'low') {
        const blocker = pick(rand, BLOCKERS);
        for (const line of blocker.logs(scopeMain)) ctx.log(line, 'warning');
        ctx.blocked(blocker.reason(scopeMain));
        return;
      }
      if (step.gate === 'blocker' && ctx.attempt > 1) {
        ctx.log('Applying fix for the previous blocker before re-running checks…');
        await this.sleep(ctx, state, 600);
        if (state.cancelled) return;
      }

      for (const line of step.logs) ctx.log(line);
      ctx.stepDone(step.id);
      ctx.progress(clamp(Math.round(((i + 1) / total) * 93), 2, 93));
    }

    ctx.finished(this.buildResult(ctx, rand));
  }

  private buildPlan(ctx: RunContext): SimStep[] {
    const { task } = ctx;
    const scopeMain = task.scope[0] ?? 'src/';
    const project = task.projectId.replace(/^proj_/, '');
    const steps: SimStep[] = [];
    const add = (label: string, logs: string[], gate?: SimStep['gate'], riskyDetail?: string) =>
      steps.push({ id: uid('step'), label, logs, gate, riskyDetail });

    add('Prepare isolated workspace', [
      `Created scratch workspace for ${project} (no shared checkout touched)`,
      'Installed dependencies from lockfile',
    ]);
    add(`Analyze ${scopeMain} and recent history`, [
      `Scanned ${scopeMain} — mapped modules relevant to the goal`,
      'Reviewed acceptance criteria and existing tests',
    ]);

    if (task.tags.includes('bugfix')) {
      add('Reproduce the issue with a failing test', [
        'Wrote a minimal reproduction; failure confirmed',
        'Pinned the bug with a red test before fixing',
      ]);
    }
    if (task.tags.includes('frontend')) {
      add(`Implement UI changes in ${scopeMain}`, [
        'Built the component and wired it to existing state',
        'Checked mobile and desktop breakpoints',
      ]);
    }
    if (task.tags.includes('backend') || task.risk === 'high') {
      add(
        `Update server-side logic in ${scopeMain}`,
        ['Implemented the change behind the existing interface', 'Kept the change scoped to the agreed paths'],
        task.risk === 'high' ? 'approval' : undefined,
        'a schema/config change that alters persisted data',
      );
    }
    if (task.tags.includes('refactor')) {
      add('Refactor target modules incrementally', [
        'Moved logic in small, verifiable steps',
        'Behavior-preserving: ran tests after each move',
      ]);
    }
    if (task.tags.includes('docs')) {
      add('Draft documentation updates', ['Wrote docs against actual current behavior']);
    }
    if (
      !task.tags.some((t) => ['bugfix', 'frontend', 'backend', 'refactor', 'docs'].includes(t))
    ) {
      add(`Implement the change in ${scopeMain}`, ['Implemented the increment described in the goal']);
    }

    add('Write / extend tests', ['Added coverage for the new behavior']);
    add('Run project test suite', ['vitest run — executing full suite…'], 'blocker');
    add('Static checks (types, lint)', ['tsc --noEmit … OK', 'eslint . … no problems']);
    add('Package evidence & summary', ['Collected diff stats, test report and log tail']);
    return steps;
  }

  private buildResult(ctx: RunContext, rand: () => number) {
    const { task, worker } = ctx;
    const scopeMain = task.scope[0] ?? 'src/';
    const files: FileChange[] = [];
    const slug = task.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 24);

    files.push({
      path: `${scopeMain.replace(/\/$/, '')}/${slug || 'change'}.ts`,
      changeType: ctx.attempt > 1 ? 'modified' : 'added',
      summary: 'Main implementation for this task',
      additions: 40 + Math.floor(rand() * 120),
      deletions: Math.floor(rand() * 30),
    });
    if (task.scope[1]) {
      files.push({
        path: `${task.scope[1].replace(/\/$/, '')}/index.ts`,
        changeType: 'modified',
        summary: 'Wired the new code into the existing module',
        additions: 8 + Math.floor(rand() * 30),
        deletions: Math.floor(rand() * 10),
      });
    }
    files.push({
      path: `tests/${slug || 'change'}.test.ts`,
      changeType: 'added',
      summary: 'New coverage for this task',
      additions: 30 + Math.floor(rand() * 60),
      deletions: 0,
    });

    const tests: TestReport = {
      passed: 24 + Math.floor(rand() * 30),
      failed: 0,
      skipped: Math.floor(rand() * 3),
      durationMs: 4000 + Math.floor(rand() * 6000),
      details: [
        `${scopeMain}: all green`,
        `tests/${slug || 'change'}.test.ts: new tests pass`,
      ],
    };

    const limitations: string[] = [];
    if (ctx.attempt > 1) {
      limitations.push('First attempt hit a blocker; this delivery is from the retry — see the timeline.');
    }
    if (task.risk === 'high') {
      limitations.push('High-risk change: recommend an extra manual review of the guarded change before shipping.');
    }
    if (limitations.length === 0) {
      limitations.push('Simulated delivery — file diffs and test counts are illustrative artifacts.');
    }

    return {
      summary:
        `${worker.name} completed “${task.title}” in ${files.length} file(s): ` +
        `${files.map((f) => f.path).join(', ')}. Tests are green (${tests.passed} passed).`,
      workPerformed: (ctx.task.runPlan ?? []).map((s) => s.label),
      filesChanged: files,
      tests,
      logTail: [
        '[run] test suite green',
        '[run] static checks clean',
        '[delivery] evidence packaged',
      ],
      limitations,
      confidence: Math.round((0.82 + rand() * 0.13) * 100) / 100,
    };
  }

  // -- pacing ---------------------------------------------------------------

  private async sleep(ctx: RunContext, state: RunnerState, baseMs: number): Promise<void> {
    let remaining = baseMs / ctx.simSpeed;
    while (remaining > 0 && !state.cancelled) {
      const chunk = Math.min(80, remaining);
      await new Promise((r) => setTimeout(r, chunk));
      remaining -= chunk;
      if (state.paused) await this.waitIfPaused(state);
    }
  }

  private waitIfPaused(state: RunnerState): Promise<void> {
    if (!state.paused || state.cancelled) return Promise.resolve();
    return new Promise((resolve) => state.resumeWaiters.push(resolve));
  }
}

interface SimStep {
  id: string;
  label: string;
  logs: string[];
  gate?: 'approval' | 'blocker';
  riskyDetail?: string;
}

const BLOCKERS = [
  {
    reason: (scope: string) => `Test suite failure: 2 regression tests failing in ${scope} after the change.`,
    logs: (scope: string) => [
      `FAIL ${scope}/regressions.test.ts — expected 200, received 500`,
      `FAIL ${scope}/regressions.test.ts — snapshot mismatch`,
      '2 failed, suite aborted',
    ],
  },
  {
    reason: () => 'Dependency conflict: lockfile mismatch while installing packages in the workspace.',
    logs: () => [
      'npm ERR! ERESOLVE unable to resolve dependency tree',
      'npm ERR! peer dep conflict detected in workspace install',
    ],
  },
  {
    reason: () => 'Workspace drift: newer commits on main conflict with the change set.',
    logs: () => [
      'merge: CONFLICT (content) in shared module',
      'auto-merge failed; manual reconciliation required',
    ],
  },
] as const;
