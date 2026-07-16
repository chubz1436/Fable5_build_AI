import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { RunContext, WorkerAdapter } from './types';
import {
  buildTaskBrief,
  clamp01,
  diffSnapshots,
  extractFinalReport,
  killTree,
  pickString,
  snapshotWorkspace,
  truncate,
} from './cli-common';

/**
 * REAL worker adapter: drives the locally installed OpenAI Codex CLI
 * (`codex exec`).
 *
 * Safety model:
 *  - each task runs in its own isolated workspace under the app's data
 *    folder (via `--cd`), never a real repository checkout;
 *  - `--sandbox workspace-write` lets Codex run shell commands but confines
 *    writes to that workspace (no `danger-full-access`, no approval bypass);
 *    unlike the Claude Code adapter (file-tools only), Codex may therefore
 *    execute the code it writes — a deliberate capability contrast;
 *  - a hard timeout kills runaway sessions;
 *  - evidence (changed files + diff stats) is computed by diffing real
 *    workspace snapshots, not taken from the model's claims.
 *
 * Uses the owner's existing local Codex login. No keys are stored or read
 * by this app. On Windows without WSL, OS-level sandbox enforcement may be
 * limited; the `--cd` workspace boundary still applies.
 */

export interface CodexOptions {
  command: string;
  timeoutMs: number;
  workspaceRoot: string;
  /** optional model override (`-m`); empty = respect the user's codex config */
  model: string;
}

interface LiveRun {
  proc: ChildProcess;
  cancelled: boolean;
}

/** event `type` substrings that are too noisy to surface line-by-line */
const NOISY = ['delta', 'reasoning', 'token', 'usage', 'heartbeat'];

export class CodexAdapter implements WorkerAdapter {
  readonly kind = 'codex';
  readonly capabilities = { pause: false };
  private runs = new Map<string, LiveRun>();

  constructor(private readonly options: CodexOptions) {}

  start(ctx: RunContext): void {
    void this.run(ctx).catch((err) => {
      ctx.log(`Adapter error: ${(err as Error).message}`, 'error');
      ctx.blocked(`Codex adapter failed: ${(err as Error).message}`);
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
    // final-message sink lives OUTSIDE the workspace so it never pollutes the diff
    const lastMsgPath = path.join(this.options.workspaceRoot, `${task.id}.lastmsg.txt`);
    fs.mkdirSync(workspace, { recursive: true });

    const steps = [
      { id: 'ws', label: 'Prepare isolated workspace' },
      { id: 'brief', label: 'Brief Codex' },
      { id: 'session', label: 'Codex session (live)' },
      { id: 'evidence', label: 'Collect evidence from workspace' },
    ];
    ctx.plan(steps.map((s) => ({ ...s, done: false })));

    ctx.phase('Prepare isolated workspace');
    ctx.log(`Workspace: ${workspace}`);
    ctx.log('Sandbox: workspace-write (shell allowed, writes confined to workspace; no network escalation).');
    const before = snapshotWorkspace(workspace);
    ctx.stepDone('ws');
    ctx.progress(8);

    ctx.phase('Brief Codex');
    const prompt = buildTaskBrief(
      ctx,
      'You MAY run shell commands, but they are sandboxed to this workspace (no network); prefer to also run the code you write to check it.',
    );
    fs.writeFileSync(path.join(workspace, '_TASK_BRIEF.md'), prompt, 'utf8');
    ctx.stepDone('brief');
    ctx.progress(15);

    ctx.phase('Codex session (live)');
    const outcome = await this.spawnSession(ctx, workspace, lastMsgPath, prompt);
    if (outcome.cancelled) return;
    ctx.stepDone('session');
    if (outcome.error) {
      ctx.blocked(outcome.error);
      return;
    }

    ctx.phase('Collect evidence from workspace');
    ctx.progress(92);
    const after = snapshotWorkspace(workspace);
    const filesChanged = diffSnapshots(before, after, 'Codex');
    for (const f of filesChanged) {
      ctx.log(`evidence: ${f.changeType} ${f.path} (+${f.additions} −${f.deletions})`);
    }
    if (filesChanged.length === 0) ctx.log('No files changed in the workspace.', 'warning');
    ctx.stepDone('evidence');

    const finalMessage = readLastMessage(lastMsgPath) ?? outcome.resultText ?? '';
    const report = extractFinalReport(finalMessage);
    const limitations = report?.limitations?.length ? [...report.limitations] : [];
    limitations.push(
      'Real Codex session: file changes are real (see workspace). Codex may have run commands in-sandbox, but no separate verification harness is attached in v1 — review the files.',
    );

    ctx.finished({
      summary:
        report?.summary ??
        (finalMessage ? truncate(finalMessage.replace(/```json[\s\S]*?```/g, '').trim(), 400) : 'Codex session finished (no summary returned).'),
      workPerformed: report?.workPerformed?.length ? report.workPerformed : outcome.actions.slice(0, 10),
      filesChanged,
      tests: {
        passed: 0,
        failed: 0,
        skipped: 0,
        durationMs: 0,
        details: ['No verification harness attached to real Codex runs in v1 — owner review required.'],
      },
      logTail: [
        ...outcome.logTail.slice(-6),
        `Workspace: ${workspace}`,
      ],
      limitations,
      confidence: clamp01(report?.confidence ?? 0.7),
      checks: [
        `[verify] workspace diff … ${filesChanged.length} file(s) changed`,
        '[verify] no automated test gate for real Codex runs in v1 — owner review required',
      ],
      criteriaMet: null,
    });
    fs.rmSync(lastMsgPath, { force: true });
  }

  private spawnSession(
    ctx: RunContext,
    workspace: string,
    lastMsgPath: string,
    prompt: string,
  ): Promise<SessionOutcome> {
    return new Promise((resolve) => {
      const outcome: SessionOutcome = { cancelled: false, actions: [], logTail: [] };
      const note = (line: string, level?: 'info' | 'warning' | 'error') => {
        outcome.logTail.push(line);
        ctx.log(line, level);
      };

      // paths are app-generated (taskId-based) but the workspace root may
      // contain spaces, so quote them; the prompt travels over stdin (`-`).
      const modelArg = this.options.model ? `-m "${this.options.model}" ` : '';
      const cmd =
        `${this.options.command} exec --json --color never --skip-git-repo-check ` +
        `--sandbox workspace-write ${modelArg}-C "${workspace}" -o "${lastMsgPath}" -`;

      const env = { ...process.env };
      delete env.CLAUDECODE;
      delete env.CLAUDE_CODE_ENTRYPOINT;

      const proc = spawn(cmd, [], {
        cwd: workspace,
        env,
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const live: LiveRun = { proc, cancelled: false };
      this.runs.set(ctx.task.id, live);
      note('Codex session started (codex exec, workspace-write sandbox)');

      const timeout = setTimeout(() => {
        note(`Session exceeded ${Math.round(this.options.timeoutMs / 1000)}s timeout — terminating.`, 'error');
        outcome.error = 'Codex session timed out.';
        killTree(proc);
      }, this.options.timeoutMs);
      timeout.unref?.();

      let buf = '';
      let stderrTail = '';
      let activity = 0;

      proc.stdout?.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          this.handleLine(line, outcome, note, () => {
            activity += 1;
            ctx.progress(Math.min(85, 20 + activity * 5));
          });
        }
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000);
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        this.runs.delete(ctx.task.id);
        outcome.error = `Could not launch the Codex CLI (${err.message}). Is "${this.options.command}" on PATH?`;
        resolve(outcome);
      });

      proc.on('close', (code) => {
        clearTimeout(timeout);
        this.runs.delete(ctx.task.id);
        outcome.cancelled = live.cancelled;
        if (!outcome.cancelled && !outcome.error && code !== 0) {
          outcome.error =
            `Codex exited with code ${code}.` +
            (stderrTail.trim() ? ` stderr: ${truncate(stderrTail.trim(), 300)}` : '');
        }
        resolve(outcome);
      });

      proc.stdin?.write(prompt);
      proc.stdin?.end();
    });
  }

  /**
   * Defensive parse of one `codex exec --json` JSONL line. Correctness never
   * depends on this — success comes from exit code, the final message from
   * the `-o` file, and evidence from the workspace diff. This only produces
   * readable live logs, so it tolerates schema drift across Codex versions.
   */
  private handleLine(
    line: string,
    outcome: SessionOutcome,
    note: (line: string, level?: 'info' | 'warning' | 'error') => void,
    onActivity: () => void,
  ): void {
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(line) as Record<string, unknown>;
    } catch {
      note(truncate(line, 200));
      return;
    }

    const type = String(json.type ?? (json.msg as { type?: string })?.type ?? '');
    const body = (json.msg ?? json.item ?? json) as Record<string, unknown>;

    if (/error/i.test(type) || json.error != null) {
      const msg = flattenError(json) || type || 'unknown error';
      outcome.error = `Codex error: ${truncate(msg, 300)}`;
      note(`⚠ ${truncate(msg, 220)}`, 'error');
      return;
    }

    if (NOISY.some((n) => type.includes(n))) return;

    const command = pickString(body, ['command', 'cmd']);
    if (command) {
      outcome.actions.push(`ran: ${command}`);
      note(`⚙ ${truncate(command, 200)}`);
      onActivity();
      return;
    }

    const file = pickString(body, ['path', 'file_path', 'filename']);
    if (file && /file|patch|apply|edit|write/i.test(type)) {
      outcome.actions.push(`edited: ${file}`);
      note(`✎ ${file}`);
      onActivity();
      return;
    }

    const text = pickString(body, ['message', 'text', 'content', 'summary']);
    if (text) {
      note(`🗣 ${truncate(text.replace(/\s+/g, ' '), 220)}`);
      onActivity();
    }
  }
}

interface SessionOutcome {
  cancelled: boolean;
  error?: string;
  resultText?: string;
  actions: string[];
  logTail: string[];
}

function readLastMessage(file: string): string | null {
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    return text || null;
  } catch {
    return null;
  }
}

/**
 * Pulls a human-readable message out of Codex's nested error shapes, which
 * vary: a plain string, `{ error: { message } }`, `{ message }`, or a string
 * that is itself JSON wrapping another error. Digs to the innermost message.
 */
function flattenError(value: unknown, depth = 0): string {
  if (depth > 5 || value == null) return '';
  if (typeof value === 'string') {
    const s = value.trim();
    if (s.startsWith('{') || s.startsWith('[')) {
      try {
        return flattenError(JSON.parse(s), depth + 1) || s;
      } catch {
        return s;
      }
    }
    return s;
  }
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return flattenError(o.error, depth + 1) || flattenError(o.message, depth + 1) || '';
  }
  return String(value);
}
