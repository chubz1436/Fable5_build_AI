import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { RunContext, WorkerAdapter } from './types';
import {
  BRIEF_FILE,
  buildTaskBrief,
  clamp01,
  diffSnapshots,
  extractFinalReport,
  killTree,
  snapshotWorkspace,
  truncate,
} from './cli-common';

/**
 * REAL worker adapter: drives the locally installed Antigravity CLI (`agy`).
 *
 * Interface notes (agy v1.1.x), established by probing the CLI:
 *  - `--print "<prompt>"` runs a single prompt non-interactively and prints
 *    the response as PLAIN TEXT (no JSON stream);
 *  - it is an agentic coder: without an approval channel it auto-denies tool
 *    requests in headless mode. `--dangerously-skip-permissions` is required
 *    for it to actually edit files headless (the Antigravity analog of the
 *    Claude Code `acceptEdits` / Codex non-interactive auto-approve).
 *
 * Safety model:
 *  - every run is confined to its own isolated workspace (cwd + `--add-dir`),
 *    never a real repository checkout;
 *  - `--sandbox` keeps terminal restrictions enabled as a guardrail even with
 *    permissions auto-approved;
 *  - within the Command Center, the OWNER has already approved the run via the
 *    start-approval gate before this adapter is invoked;
 *  - a hard timeout kills runaway sessions;
 *  - evidence is a real workspace diff, not the model's claims.
 *
 * `skipPermissions` is configurable (env ANTIGRAVITY_SKIP_PERMISSIONS=0 to
 * disable); with it off the CLI cannot perform edits headless and a run will
 * block with a clear, actionable message rather than silently doing nothing.
 * Uses the owner's existing local Antigravity login. No keys are stored.
 */

export interface AntigravityOptions {
  command: string;
  timeoutMs: number;
  workspaceRoot: string;
  skipPermissions: boolean;
  model: string;
}

interface LiveRun {
  proc: ChildProcess;
  cancelled: boolean;
}

const SHORT_PROMPT =
  `Read the file ${BRIEF_FILE} in the current directory and carry out the task it describes. ` +
  `Work only inside this directory. End your reply with the fenced json block it specifies.`;

/** phrases the CLI prints when it could not act (e.g. permissions denied) */
const FAILURE_HINTS = [/no output produced/i, /auto-denied/i, /skip-permissions to auto-approve/i];

export class AntigravityAdapter implements WorkerAdapter {
  readonly kind = 'antigravity';
  readonly capabilities = { pause: false };
  private runs = new Map<string, LiveRun>();

  constructor(private readonly options: AntigravityOptions) {}

  start(ctx: RunContext): void {
    void this.run(ctx).catch((err) => {
      ctx.log(`Adapter error: ${(err as Error).message}`, 'error');
      ctx.blocked(`Antigravity adapter failed: ${(err as Error).message}`);
    });
  }

  pause(): void {
    /* unreachable: engine checks capabilities.pause first */
  }
  resume(): void {
    /* unreachable: engine checks capabilities.pause first */
  }

  cancel(taskId: string): void {
    const run = this.runs.get(taskId);
    if (!run) return;
    run.cancelled = true;
    killTree(run.proc);
  }

  // -------------------------------------------------------------------------

  private async run(ctx: RunContext): Promise<void> {
    const { task } = ctx;
    const workspace = path.join(this.options.workspaceRoot, task.id);
    fs.mkdirSync(workspace, { recursive: true });

    const steps = [
      { id: 'ws', label: 'Prepare isolated workspace' },
      { id: 'brief', label: 'Brief Antigravity' },
      { id: 'session', label: 'Antigravity session (live)' },
      { id: 'evidence', label: 'Collect evidence from workspace' },
    ];
    ctx.plan(steps.map((s) => ({ ...s, done: false })));

    ctx.phase('Prepare isolated workspace');
    ctx.log(`Workspace: ${workspace}`);
    ctx.log(
      this.options.skipPermissions
        ? 'Sandbox: terminal-restricted; tool permissions auto-approved for headless edits (owner already approved this run).'
        : 'Sandbox: terminal-restricted; permissions NOT auto-approved (edits may be denied headless).',
      this.options.skipPermissions ? 'info' : 'warning',
    );
    const before = snapshotWorkspace(workspace);
    ctx.stepDone('ws');
    ctx.progress(8);

    ctx.phase('Brief Antigravity');
    const brief = buildTaskBrief(
      ctx,
      'You may use file and terminal tools within this sandboxed workspace (no network); prefer to also run the code you write to check it.',
    );
    fs.writeFileSync(path.join(workspace, BRIEF_FILE), brief, 'utf8');
    ctx.stepDone('brief');
    ctx.progress(15);

    ctx.phase('Antigravity session (live)');
    const outcome = await this.spawnSession(ctx, workspace);
    if (outcome.cancelled) return;
    ctx.stepDone('session');
    if (outcome.error) {
      ctx.blocked(outcome.error);
      return;
    }

    ctx.phase('Collect evidence from workspace');
    ctx.progress(92);
    const after = snapshotWorkspace(workspace);
    const filesChanged = diffSnapshots(before, after, 'Antigravity');
    for (const f of filesChanged) {
      ctx.log(`evidence: ${f.changeType} ${f.path} (+${f.additions} −${f.deletions})`);
    }
    if (filesChanged.length === 0) ctx.log('No files changed in the workspace.', 'warning');
    ctx.stepDone('evidence');

    const report = extractFinalReport(outcome.text);
    const limitations = report?.limitations?.length ? [...report.limitations] : [];
    limitations.push(
      'Real Antigravity session: file changes are real (see workspace). No separate verification harness is attached in v1 — review the files.',
    );

    ctx.finished({
      summary:
        report?.summary ??
        (outcome.text ? truncate(outcome.text.replace(/```json[\s\S]*?```/g, '').trim(), 400) : 'Antigravity session finished (no summary returned).'),
      workPerformed: report?.workPerformed?.length ? report.workPerformed : outcome.lastLines.slice(-6),
      filesChanged,
      tests: {
        passed: 0,
        failed: 0,
        skipped: 0,
        durationMs: 0,
        details: ['No verification harness attached to real Antigravity runs in v1 — owner review required.'],
      },
      logTail: [...outcome.lastLines.slice(-6), `Workspace: ${workspace}`],
      limitations,
      confidence: clamp01(report?.confidence ?? 0.7),
      checks: [
        `[verify] workspace diff … ${filesChanged.length} file(s) changed`,
        '[verify] no automated test gate for real Antigravity runs in v1 — owner review required',
      ],
      criteriaMet: null,
    });
  }

  private spawnSession(ctx: RunContext, workspace: string): Promise<SessionOutcome> {
    return new Promise((resolve) => {
      const outcome: SessionOutcome = { cancelled: false, text: '', lastLines: [] };
      const note = (line: string, level?: 'info' | 'warning' | 'error') => {
        outcome.lastLines.push(line);
        if (outcome.lastLines.length > 40) outcome.lastLines.shift();
        ctx.log(line, level);
      };

      const timeoutSec = Math.round(this.options.timeoutMs / 1000);
      const modelArg = this.options.model ? `--model "${this.options.model}" ` : '';
      const skipArg = this.options.skipPermissions ? '--dangerously-skip-permissions ' : '';
      // SHORT_PROMPT and flags are fixed literals; only the workspace path is
      // interpolated (app-generated, quoted). The full brief lives in a file.
      const cmd =
        `${this.options.command} --print "${SHORT_PROMPT}" --mode accept-edits --sandbox ` +
        `${skipArg}${modelArg}--add-dir "${workspace}" --print-timeout ${timeoutSec}s`;

      const proc = spawn(cmd, [], {
        cwd: workspace,
        env: { ...process.env },
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const live: LiveRun = { proc, cancelled: false };
      this.runs.set(ctx.task.id, live);
      note('Antigravity session started (agy --print, sandboxed)');

      const timeout = setTimeout(() => {
        note(`Session exceeded ${timeoutSec}s timeout — terminating.`, 'error');
        outcome.error = 'Antigravity session timed out.';
        killTree(proc);
      }, this.options.timeoutMs);
      timeout.unref?.();

      let buf = '';
      let stderrTail = '';
      let activity = 0;
      const emitLine = (raw: string) => {
        const line = raw.replace(/\r$/, '').trim();
        if (!line) return;
        outcome.text += `${line}\n`;
        note(truncate(line, 220));
        activity += 1;
        ctx.progress(Math.min(85, 20 + activity * 5));
      };

      proc.stdout?.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          emitLine(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      });
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000);
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        this.runs.delete(ctx.task.id);
        outcome.error = `Could not launch the Antigravity CLI (${err.message}). Is "${this.options.command}" available?`;
        resolve(outcome);
      });

      proc.on('close', (code) => {
        clearTimeout(timeout);
        this.runs.delete(ctx.task.id);
        if (buf.trim()) emitLine(buf);
        outcome.cancelled = live.cancelled;
        if (outcome.cancelled || outcome.error) return resolve(outcome);

        // the CLI can exit 0 yet report it did nothing (permissions denied)
        if (FAILURE_HINTS.some((re) => re.test(outcome.text))) {
          outcome.error = this.options.skipPermissions
            ? 'Antigravity produced no changes (a tool was denied). See the session log.'
            : 'Antigravity could not edit files headless because permissions are not auto-approved. Enable it (ANTIGRAVITY_SKIP_PERMISSIONS=1) or add allow-rules, then retry.';
          return resolve(outcome);
        }
        if (code !== 0) {
          outcome.error =
            `Antigravity exited with code ${code}.` +
            (stderrTail.trim() ? ` stderr: ${truncate(stderrTail.trim(), 300)}` : '');
        }
        resolve(outcome);
      });
    });
  }
}

interface SessionOutcome {
  cancelled: boolean;
  error?: string;
  /** accumulated stdout (plain text response) */
  text: string;
  lastLines: string[];
}
