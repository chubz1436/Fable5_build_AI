import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { FileChange } from '../../../../shared/types';
import type { RunContext, WorkerAdapter } from './types';

/**
 * REAL worker adapter: drives the locally installed Claude Code CLI.
 *
 * Safety model (v1, deliberately conservative):
 *  - each task gets its own isolated workspace directory under the app's
 *    data folder — never a real repository checkout;
 *  - the CLI runs headless (`-p`) with `--permission-mode acceptEdits` and
 *    an explicit tool allowlist of file tools only (Write/Edit/Read/Glob/
 *    Grep). Bash and network tools are NOT allowed, so the session cannot
 *    run commands — it can only read and write files in its workspace;
 *  - a hard timeout kills runaway sessions;
 *  - evidence (changed files + diff stats) is computed by diffing real
 *    workspace snapshots, not taken from the model's claims.
 *
 * The session uses the owner's existing local Claude Code login. No keys
 * are stored or read by this app.
 */

export interface ClaudeCodeOptions {
  /** command used to launch the CLI (tests substitute a fake) */
  command: string;
  timeoutMs: number;
  /** directory that holds per-task workspaces */
  workspaceRoot: string;
}

const BRIEF_FILE = '_TASK_BRIEF.md';
const ALLOWED_TOOLS = 'Write,Edit,Read,Glob,Grep';

interface LiveRun {
  proc: ChildProcess;
  cancelled: boolean;
}

export class ClaudeCodeAdapter implements WorkerAdapter {
  readonly kind = 'claude-code';
  // a real subprocess can't be paused portably; the engine surfaces this
  readonly capabilities = { pause: false };
  private runs = new Map<string, LiveRun>();

  constructor(private readonly options: ClaudeCodeOptions) {}

  start(ctx: RunContext): void {
    void this.run(ctx).catch((err) => {
      ctx.log(`Adapter error: ${(err as Error).message}`, 'error');
      ctx.blocked(`Claude Code adapter failed: ${(err as Error).message}`);
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
      { id: 'brief', label: 'Brief Claude Code' },
      { id: 'session', label: 'Claude Code session (live)' },
      { id: 'evidence', label: 'Collect evidence from workspace' },
    ];
    ctx.plan(steps.map((s) => ({ ...s, done: false })));

    ctx.phase('Prepare isolated workspace');
    ctx.log(`Workspace: ${workspace}`);
    ctx.log('Tool allowlist: file tools only (no Bash, no network).');
    const before = snapshotWorkspace(workspace);
    ctx.stepDone('ws');
    ctx.progress(8);

    ctx.phase('Brief Claude Code');
    const prompt = buildPrompt(ctx);
    fs.writeFileSync(path.join(workspace, BRIEF_FILE), prompt, 'utf8');
    ctx.stepDone('brief');
    ctx.progress(15);

    ctx.phase('Claude Code session (live)');
    const outcome = await this.spawnSession(ctx, workspace, prompt);
    if (outcome.cancelled) return; // engine already handled the cancel
    ctx.stepDone('session');

    if (outcome.error) {
      ctx.blocked(outcome.error);
      return;
    }

    ctx.phase('Collect evidence from workspace');
    ctx.progress(92);
    const after = snapshotWorkspace(workspace);
    const filesChanged = diffSnapshots(before, after);
    for (const f of filesChanged) {
      ctx.log(`evidence: ${f.changeType} ${f.path} (+${f.additions} −${f.deletions})`);
    }
    if (filesChanged.length === 0) {
      ctx.log('No files changed in the workspace.', 'warning');
    }
    ctx.stepDone('evidence');

    const report = extractFinalReport(outcome.resultText ?? '');
    const limitations = report?.limitations?.length
      ? report.limitations
      : [];
    limitations.push(
      'Real Claude Code session: file changes are real (see workspace); no automated test run — Bash is disabled for CLI sessions in v1.',
    );

    ctx.finished({
      summary:
        report?.summary ??
        (outcome.resultText ? truncate(outcome.resultText, 400) : 'Session finished (no summary returned).'),
      workPerformed: report?.workPerformed?.length
        ? report.workPerformed
        : outcome.toolUses.slice(0, 10),
      filesChanged,
      tests: {
        passed: 0,
        failed: 0,
        skipped: 0,
        durationMs: 0,
        details: ['No automated test run — Bash is disabled for real CLI sessions in v1.'],
      },
      logTail: [
        ...outcome.logTail.slice(-6),
        `Session cost: ${outcome.costUsd != null ? `$${outcome.costUsd.toFixed(4)}` : 'n/a'} · turns: ${outcome.turns ?? '?'}`,
        `Workspace: ${workspace}`,
      ],
      limitations,
      confidence: clamp01(report?.confidence ?? 0.7),
      checks: [
        `[verify] workspace diff … ${filesChanged.length} file(s) changed`,
        '[verify] no automated tests configured for real CLI runs — owner review required',
      ],
      criteriaMet: null, // owner judges criteria for real runs
    });
  }

  private spawnSession(
    ctx: RunContext,
    workspace: string,
    prompt: string,
  ): Promise<SessionOutcome> {
    return new Promise((resolve) => {
      const outcome: SessionOutcome = {
        cancelled: false,
        toolUses: [],
        logTail: [],
      };
      const note = (line: string, level?: 'info' | 'warning' | 'error') => {
        outcome.logTail.push(line);
        ctx.log(line, level);
      };

      const args = [
        '-p',
        '--output-format', 'stream-json',
        '--verbose',
        '--permission-mode', 'acceptEdits',
        '--allowedTools', ALLOWED_TOOLS,
      ];

      // strip nested-session markers so the CLI starts clean
      const env = { ...process.env };
      delete env.CLAUDECODE;
      delete env.CLAUDE_CODE_ENTRYPOINT;
      delete env.CLAUDE_CODE_SSE_PORT;

      // shell:true because on Windows the CLI is a .cmd shim; every arg is a
      // fixed literal and the prompt travels over stdin, so nothing
      // user-controlled reaches the shell line.
      const proc = spawn(`${this.options.command} ${args.join(' ')}`, [], {
        cwd: workspace,
        env,
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const live: LiveRun = { proc, cancelled: false };
      this.runs.set(ctx.task.id, live);

      const timeout = setTimeout(() => {
        note(`Session exceeded ${Math.round(this.options.timeoutMs / 1000)}s timeout — terminating.`, 'error');
        outcome.error = 'Claude Code session timed out.';
        killTree(proc);
      }, this.options.timeoutMs);
      timeout.unref?.();

      let assistantTurns = 0;
      let stdoutBuf = '';
      let stderrTail = '';

      proc.stdout?.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString('utf8');
        let nl: number;
        while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
          const line = stdoutBuf.slice(0, nl).trim();
          stdoutBuf = stdoutBuf.slice(nl + 1);
          if (!line) continue;
          try {
            this.handleStreamEvent(JSON.parse(line), ctx, outcome, note, () => {
              assistantTurns += 1;
              ctx.progress(Math.min(85, 20 + assistantTurns * 6));
            });
          } catch {
            // not JSON — surface it raw, it may be a CLI warning
            note(line);
          }
        }
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000);
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        this.runs.delete(ctx.task.id);
        outcome.error = `Could not launch the Claude Code CLI (${err.message}). Is "${this.options.command}" on PATH?`;
        resolve(outcome);
      });

      proc.on('close', (code) => {
        clearTimeout(timeout);
        this.runs.delete(ctx.task.id);
        outcome.cancelled = live.cancelled;
        if (!outcome.cancelled && !outcome.error && code !== 0 && !outcome.resultText) {
          outcome.error =
            `Claude Code exited with code ${code}.` +
            (stderrTail.trim() ? ` stderr: ${truncate(stderrTail.trim(), 300)}` : '');
        }
        resolve(outcome);
      });

      proc.stdin?.write(prompt);
      proc.stdin?.end();
    });
  }

  private handleStreamEvent(
    event: Record<string, unknown>,
    ctx: RunContext,
    outcome: SessionOutcome,
    note: (line: string, level?: 'info' | 'warning' | 'error') => void,
    onAssistantTurn: () => void,
  ): void {
    const type = event.type as string;

    if (type === 'system' && (event.subtype as string) === 'init') {
      note(`Claude Code session started (model: ${(event.model as string) ?? 'default'})`);
      return;
    }

    if (type === 'assistant') {
      onAssistantTurn();
      const message = event.message as { content?: Array<Record<string, unknown>> } | undefined;
      for (const block of message?.content ?? []) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          note(`🗣 ${truncate(block.text.trim().replace(/\s+/g, ' '), 220)}`);
        }
        if (block.type === 'tool_use') {
          const summary = summarizeToolUse(
            block.name as string,
            (block.input ?? {}) as Record<string, unknown>,
          );
          outcome.toolUses.push(summary);
          note(`⚒ ${summary}`);
        }
      }
      return;
    }

    if (type === 'result') {
      const isError = event.is_error === true || String(event.subtype ?? '').startsWith('error');
      outcome.costUsd = typeof event.total_cost_usd === 'number' ? event.total_cost_usd : undefined;
      outcome.turns = typeof event.num_turns === 'number' ? event.num_turns : undefined;
      if (isError) {
        outcome.error = `Claude Code reported an error result: ${truncate(String(event.result ?? event.subtype ?? 'unknown'), 300)}`;
        note(outcome.error, 'error');
      } else {
        outcome.resultText = typeof event.result === 'string' ? event.result : '';
        note('Session finished — collecting evidence.', 'info');
      }
      ctx.progress(88);
    }
  }
}

interface SessionOutcome {
  cancelled: boolean;
  error?: string;
  resultText?: string;
  toolUses: string[];
  logTail: string[];
  costUsd?: number;
  turns?: number;
}

// ---------------------------------------------------------------------------
// pure helpers (unit-tested)
// ---------------------------------------------------------------------------

export interface FinalReport {
  summary?: string;
  workPerformed?: string[];
  limitations?: string[];
  confidence?: number;
}

/** Pulls the last ```json … ``` block out of the CLI's final message. */
export function extractFinalReport(text: string): FinalReport | null {
  const matches = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  const last = matches[matches.length - 1]?.[1];
  if (!last) return null;
  try {
    const parsed = JSON.parse(last) as FinalReport;
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

export function summarizeToolUse(name: string, input: Record<string, unknown>): string {
  const target =
    (input.file_path as string) ??
    (input.path as string) ??
    (input.pattern as string) ??
    '';
  return target ? `${name} ${target}` : name;
}

type Snapshot = Map<string, string[]>; // relative path → lines

/** Content snapshot of every text file in the workspace (brief excluded). */
export function snapshotWorkspace(dir: string): Snapshot {
  const snap: Snapshot = new Map();
  if (!fs.existsSync(dir)) return snap;
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const rel = path.relative(dir, full).replaceAll('\\', '/');
      if (rel === BRIEF_FILE) continue;
      const stat = fs.statSync(full);
      if (stat.size > 512 * 1024) {
        snap.set(rel, [`<binary or large file: ${stat.size} bytes>`]);
        continue;
      }
      snap.set(rel, fs.readFileSync(full, 'utf8').split('\n'));
    }
  };
  walk(dir);
  return snap;
}

/** Real diff stats between two snapshots (multiset line comparison). */
export function diffSnapshots(before: Snapshot, after: Snapshot): FileChange[] {
  const changes: FileChange[] = [];
  for (const [rel, newLines] of after) {
    const oldLines = before.get(rel);
    if (!oldLines) {
      changes.push({
        path: rel,
        changeType: 'added',
        summary: 'Created by Claude Code in the task workspace',
        additions: newLines.length,
        deletions: 0,
      });
    } else {
      const common = multisetIntersection(oldLines, newLines);
      const additions = newLines.length - common;
      const deletions = oldLines.length - common;
      if (additions > 0 || deletions > 0) {
        changes.push({
          path: rel,
          changeType: 'modified',
          summary: 'Modified by Claude Code in the task workspace',
          additions,
          deletions,
        });
      }
    }
  }
  for (const [rel, oldLines] of before) {
    if (!after.has(rel)) {
      changes.push({
        path: rel,
        changeType: 'deleted',
        summary: 'Deleted by Claude Code in the task workspace',
        additions: 0,
        deletions: oldLines.length,
      });
    }
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

function multisetIntersection(a: string[], b: string[]): number {
  const counts = new Map<string, number>();
  for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
  let common = 0;
  for (const line of b) {
    const c = counts.get(line) ?? 0;
    if (c > 0) {
      common += 1;
      counts.set(line, c - 1);
    }
  }
  return common;
}

function buildPrompt(ctx: RunContext): string {
  const { task, worker, handoff, attempt } = ctx;
  const lines = [
    `You are ${worker.name}, an AI coding worker executing a task for the CHUBZ AI Command Center.`,
    '',
    `# Task: ${task.title}`,
    `GOAL: ${task.goal}`,
    `RISK LEVEL: ${task.risk} · PRIORITY: ${task.priority} · ATTEMPT: ${attempt}`,
    '',
    '## Acceptance criteria',
    ...task.acceptanceCriteria.map((c) => `- ${c.text}`),
  ];
  if (attempt > 1 && task.blockReason) {
    lines.push('', `## Retry note`, `A previous attempt was blocked: ${task.blockReason}. Address this.`);
  }
  if (handoff) {
    lines.push(
      '',
      '## Handoff context (from the previous worker)',
      `State: ${handoff.context.currentState}`,
      `Completed: ${handoff.context.completedWork.join('; ') || 'nothing yet'}`,
      `Remaining: ${handoff.context.remainingWork.join('; ') || 'see goal'}`,
      `Next action: ${handoff.context.nextAction}`,
    );
  }
  lines.push(
    '',
    '## Rules',
    '- Work ONLY inside the current directory (an isolated task workspace).',
    '- Create or modify files to accomplish the goal. Keep the change minimal and focused.',
    '- Bash and network access are disabled; use file tools only.',
    `- ${BRIEF_FILE} is this brief; do not edit it.`,
    '- End your final message with a fenced json block exactly like:',
    '```json',
    '{"summary": "one paragraph of what you did", "workPerformed": ["step 1", "step 2"], "limitations": ["anything not covered"], "confidence": 0.9}',
    '```',
  );
  return lines.join('\n');
}

function killTree(proc: ChildProcess): void {
  if (proc.pid == null) return;
  if (process.platform === 'win32') {
    // kill the whole tree; the CLI shim spawns children
    spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
  } else {
    proc.kill('SIGTERM');
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

// ---------------------------------------------------------------------------
// CLI detection (used at boot to upgrade the roster honestly)
// ---------------------------------------------------------------------------

export function detectClaudeCli(command: string, timeoutMs = 8000): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: string | null) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    try {
      const proc = spawn(`${command} --version`, [], { shell: true, windowsHide: true });
      let out = '';
      const timer = setTimeout(() => {
        killTree(proc);
        done(null);
      }, timeoutMs);
      timer.unref?.();
      proc.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')));
      proc.on('error', () => {
        clearTimeout(timer);
        done(null);
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        done(code === 0 && out.trim() ? out.trim().split('\n')[0]! : null);
      });
    } catch {
      done(null);
    }
  });
}
