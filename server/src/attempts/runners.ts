import { spawn, execFile, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import type { EventLevel, ExitReason } from '../../../shared/types';

/**
 * Hardened worker runners for repository-backed attempts (P0.8).
 *
 *  - direct executable + argument arrays; never `shell: true`;
 *  - no user strings are ever composed into a command line (the task goal
 *    travels via stdin or an environment variable);
 *  - bounded output, secret redaction, hard timeout, graceful cancel then
 *    process-tree kill (Windows-correct);
 *  - honest outcome classification — producing output is NOT success.
 */

// -- secret redaction ---------------------------------------------------------

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{10,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[A-Z0-9]{12,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /(Bearer\s+)[A-Za-z0-9._~+/-]{12,}/g,
];
const KV_SECRET = /((?:api[_-]?key|token|secret|password|authorization)["']?\s*[:=]\s*["']?)([^\s"']{6,})/gi;

export function redactSecrets(line: string): string {
  let out = line;
  for (const re of SECRET_PATTERNS) out = out.replace(re, (_m, pre) => (typeof pre === 'string' ? `${pre}•••redacted•••` : '•••redacted•••'));
  out = out.replace(KV_SECRET, (_m, pre) => `${pre}•••redacted•••`);
  return out;
}

// -- safe executable resolution ------------------------------------------------

const WIN = process.platform === 'win32';
/** args allowed onto a cmd.exe shim line: no spaces, quotes or metachars */
const SAFE_SHIM_ARG = /^[A-Za-z0-9_@.\\/:^=,+-]+$/;

export interface ResolvedExecutable {
  file: string;
  /** true when the target is a .cmd/.bat npm shim (needs cmd.exe on Windows) */
  viaCmdShim: boolean;
}

export async function resolveExecutable(command: string): Promise<ResolvedExecutable | null> {
  const classify = (file: string): ResolvedExecutable => ({
    file,
    viaCmdShim: WIN && /\.(cmd|bat)$/i.test(file),
  });
  if (/[\\/]/.test(command)) {
    return fs.existsSync(command) ? classify(command) : null;
  }
  const finder = WIN ? 'where' : 'which';
  const lines = await new Promise<string[]>((resolve) => {
    execFile(finder, [command], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      resolve(err ? [] : stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
    });
  });
  if (lines.length === 0) return null;
  const exe = lines.find((l) => /\.(exe|com)$/i.test(l));
  return classify(exe ?? lines[0]!);
}

/**
 * Spawn without shell interpretation. A .cmd/.bat shim cannot be spawned
 * directly on modern Node, so it is launched through cmd.exe with a
 * deterministic, fully app-controlled line: the shim path (quoted) plus
 * argv tokens that are validated against a no-space/no-quote allowlist.
 */
export function spawnSafe(
  resolved: ResolvedExecutable,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; stdio: ['pipe' | 'ignore', 'pipe', 'pipe'] },
): ChildProcess {
  if (!resolved.viaCmdShim) {
    return spawn(resolved.file, args, { ...opts, windowsHide: true, shell: false });
  }
  for (const a of args) {
    if (!SAFE_SHIM_ARG.test(a)) {
      throw new Error(`Unsafe argument for a .cmd shim launch: ${JSON.stringify(a)}`);
    }
  }
  const line = `"${resolved.file}" ${args.join(' ')}`.trim();
  return spawn('cmd.exe', ['/d', '/s', '/c', line], {
    ...opts,
    windowsHide: true,
    shell: false,
    windowsVerbatimArguments: true,
  });
}

export function killProcessTree(proc: ChildProcess): void {
  if (proc.pid == null) return;
  if (WIN) {
    spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
  } else {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

// -- runner contract -----------------------------------------------------------

export interface RunnerLaunch {
  worktree: string;
  /** full task brief (goal, criteria, rules) — passed via stdin/env only */
  brief: string;
  goal: string;
  timeoutMs: number;
  maxLogLines: number;
  onLog(line: string, level?: EventLevel): void;
}

export interface RunnerOutcome {
  exitReason: ExitReason;
  exitCode: number | null;
  error: string | null;
  logTail: string[];
}

export interface RunnerHandle {
  pid: number | null;
  executablePath: string | null;
  version: string | null;
  done: Promise<RunnerOutcome>;
  cancel(): void;
}

export interface WorkerRunner {
  readonly adapter: string;
  probe(): Promise<{ path: string | null; version: string | null; error: string | null }>;
  start(launch: RunnerLaunch): Promise<RunnerHandle>;
}

// -- shared session harness ----------------------------------------------------

function runSession(
  proc: ChildProcess,
  launch: RunnerLaunch,
  classifyExit: (code: number | null, text: string, flags: { cancelled: boolean; timedOut: boolean }) => ExitReason,
): { done: Promise<RunnerOutcome>; cancel(): void } {
  const tail: string[] = [];
  let lineCount = 0;
  let cancelled = false;
  let timedOut = false;
  let collected = '';

  const log = (raw: string, level?: EventLevel) => {
    const line = redactSecrets(raw).slice(0, 400);
    if (++lineCount > launch.maxLogLines) return; // bounded
    tail.push(line);
    if (tail.length > 60) tail.shift();
    launch.onLog(line, level);
  };

  const feed = (chunk: Buffer, level?: EventLevel) => {
    collected = (collected + chunk.toString('utf8')).slice(-64_000);
    for (const l of chunk.toString('utf8').split(/\r?\n/)) {
      if (l.trim()) log(l.trim(), level);
    }
  };
  proc.stdout?.on('data', (c: Buffer) => feed(c));
  proc.stderr?.on('data', (c: Buffer) => feed(c, 'warning'));

  const timer = setTimeout(() => {
    timedOut = true;
    log(`Hard timeout after ${Math.round(launch.timeoutMs / 1000)}s — terminating process tree.`, 'error');
    killProcessTree(proc);
  }, launch.timeoutMs);
  timer.unref?.();

  const done = new Promise<RunnerOutcome>((resolve) => {
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        exitReason: 'unavailable',
        exitCode: null,
        error: `Could not launch worker executable: ${err.message}`,
        logTail: tail,
      });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      const exitReason = cancelled ? 'cancelled' : timedOut ? 'timeout' : classifyExit(code, collected, { cancelled, timedOut });
      resolve({
        exitReason,
        exitCode: code,
        error:
          exitReason === 'success'
            ? null
            : exitReason === 'cancelled'
              ? 'Cancelled by owner.'
              : exitReason === 'timeout'
                ? 'Worker exceeded the attempt time limit.'
                : `Worker exit ${code}: ${tail.slice(-3).join(' | ') || 'no output'}`,
        logTail: tail,
      });
    });
  });

  return {
    done,
    cancel() {
      cancelled = true;
      // graceful first, then the whole tree
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      setTimeout(() => killProcessTree(proc), 2000).unref?.();
    },
  };
}

// -- deterministic test runner ---------------------------------------------------

/**
 * Deterministic local runner used by automated tests and demos without Codex
 * credentials. Spawns a REAL child process (node) that makes REAL file
 * changes in the worktree. Goal markers steer behavior:
 *   [[SLOW]]  sleep 30s first (cancellation window)
 *   [[FAIL]]  exit 2 without changes
 *   [[SECRET]] print a fake token (redaction path)
 *   [[TOUCH:rel/path]] additionally write that file
 */
const TEST_SCRIPT = `
const fs = require('node:fs');
const path = require('node:path');
const goal = process.env.CC_GOAL || '';
(async () => {
  console.log('test-runner: session started');
  if (goal.includes('[[SECRET]]')) console.log('leaked credential token=sk-verysecret1234567890 (should be redacted)');
  if (goal.includes('[[SLOW]]')) { console.log('test-runner: sleeping'); await new Promise(r => setTimeout(r, 30000)); }
  if (goal.includes('[[FAIL]]')) { console.error('test-runner: simulated failure'); process.exit(2); }
  const m = goal.match(/\\[\\[TOUCH:([^\\]]+)\\]\\]/);
  if (m) { const p = m[1]; fs.mkdirSync(path.dirname(path.join(process.cwd(), p)), { recursive: true }); fs.writeFileSync(p, 'touched by test runner\\n'); console.log('test-runner: wrote ' + p); }
  fs.writeFileSync('TASK_NOTES.md', '# Task notes\\n\\nGoal: ' + goal.replace(/\\[\\[[^\\]]*\\]\\]/g, '').trim() + '\\n');
  console.log('test-runner: wrote TASK_NOTES.md');
  console.log('test-runner: done');
})();
`;

export class TestRunner implements WorkerRunner {
  readonly adapter = 'test';

  async probe() {
    return { path: process.execPath, version: process.version, error: null };
  }

  async start(launch: RunnerLaunch): Promise<RunnerHandle> {
    const env = { ...process.env, CC_GOAL: launch.goal };
    const proc = spawn(process.execPath, ['-e', TEST_SCRIPT], {
      cwd: launch.worktree,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    const session = runSession(proc, launch, (code) => (code === 0 ? 'success' : 'failure'));
    return {
      pid: proc.pid ?? null,
      executablePath: process.execPath,
      version: process.version,
      done: session.done,
      cancel: session.cancel,
    };
  }
}

// -- hardened Codex runner --------------------------------------------------------

function classifyCodexExit(code: number | null, text: string): ExitReason {
  const t = text.toLowerCase();
  if (/not logged in|please run.*login|authentication|unauthorized|401/.test(t)) return 'auth_required';
  if (/rate.?limit|429|too many requests/.test(t)) return 'rate_limited';
  if (/quota|usage limit|insufficient credit/.test(t)) return 'quota_exhausted';
  if (code === 0) return 'success';
  if (code === null) return 'unknown';
  return 'failure';
}

export class CodexRunner implements WorkerRunner {
  readonly adapter = 'codex';

  constructor(
    private readonly options: { command: string; model: string },
  ) {}

  async probe() {
    const resolved = await resolveExecutable(this.options.command);
    if (!resolved) return { path: null, version: null, error: `Codex executable "${this.options.command}" not found on PATH.` };
    const version = await new Promise<string | null>((resolve) => {
      try {
        const proc = spawnSafe(resolved, ['--version'], {
          cwd: process.cwd(),
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        proc.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')));
        const t = setTimeout(() => killProcessTree(proc), 10_000);
        t.unref?.();
        proc.on('error', () => resolve(null));
        proc.on('close', (code) => resolve(code === 0 ? out.trim().split('\n')[0] ?? null : null));
      } catch {
        resolve(null);
      }
    });
    return { path: resolved.file, version, error: version ? null : 'Version probe failed.' };
  }

  async start(launch: RunnerLaunch): Promise<RunnerHandle> {
    const resolved = await resolveExecutable(this.options.command);
    if (!resolved) {
      return {
        pid: null,
        executablePath: null,
        version: null,
        cancel() {},
        done: Promise.resolve({
          exitReason: 'unavailable',
          exitCode: null,
          error: `Codex executable "${this.options.command}" not found.`,
          logTail: [],
        }),
      };
    }
    if (this.options.model && !/^[A-Za-z0-9._-]{1,64}$/.test(this.options.model)) {
      throw new Error(`Unsafe Codex model name: ${JSON.stringify(this.options.model)}`);
    }
    // NOTE: the worktree is passed as cwd (codex treats cwd as the workspace
    // root), never as an argument — paths with spaces stay off the argv line.
    const args = [
      'exec',
      '--json',
      '--color', 'never',
      '--skip-git-repo-check',
      '--sandbox', 'workspace-write',
      ...(this.options.model ? ['-m', this.options.model] : []),
      '-',
    ];
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    delete env.AUTH_TOKEN;

    const proc = spawnSafe(resolved, args, {
      cwd: launch.worktree,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    proc.stdin?.write(launch.brief);
    proc.stdin?.end();

    const session = runSession(proc, launch, (code, text) => classifyCodexExit(code, text));
    return {
      pid: proc.pid ?? null,
      executablePath: resolved.file,
      version: null,
      done: session.done,
      cancel: session.cancel,
    };
  }
}
