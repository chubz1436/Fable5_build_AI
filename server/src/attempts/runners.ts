import { spawn, execFile, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { EventLevel, ExitReason } from '../../../shared/types';
import { allowlistedChildEnv, codexEnvExtra, type CodexAuthMode } from './env';

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

/**
 * Windows-runnable extensions, most-preferred first: a native entry point
 * (.com/.exe) beats an npm .cmd/.bat shim. An extensionless file (e.g. the
 * bash shim npm also drops next to codex.cmd) is NOT runnable via spawn on
 * Windows — selecting it is exactly the `spawn …\npm\codex ENOENT` bug.
 */
const WIN_RUNNABLE = ['.com', '.exe', '.cmd', '.bat'];

function classifyExecutable(file: string): ResolvedExecutable {
  return { file, viaCmdShim: WIN && /\.(cmd|bat)$/i.test(file) };
}

function winRank(file: string): number {
  const i = WIN_RUNNABLE.indexOf(path.extname(file).toLowerCase());
  return i === -1 ? Number.POSITIVE_INFINITY : i;
}

/** Resolve an explicit path, PATHEXT-probing runnable siblings on Windows. */
function resolveExplicitPath(command: string): ResolvedExecutable | null {
  if (!WIN) return fs.existsSync(command) ? classifyExecutable(command) : null;
  const ext = path.extname(command).toLowerCase();
  if (ext && WIN_RUNNABLE.includes(ext) && fs.existsSync(command)) {
    return classifyExecutable(command);
  }
  // extensionless (or non-runnable ext) → probe runnable siblings in order,
  // so `C:\Users\CHUBZ SERVER\AppData\Roaming\npm\codex` → `…\codex.cmd`
  const base = ext ? command.slice(0, -ext.length) : command;
  for (const e of WIN_RUNNABLE) {
    if (fs.existsSync(base + e)) return classifyExecutable(base + e);
  }
  return null;
}

function runFinder(finder: string, command: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(finder, [command], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      resolve(err ? [] : stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
    });
  });
}

/**
 * Resolve a worker/validator executable to something Node can actually spawn.
 * On Windows this is PATHEXT-aware: it ranks `where` matches native-first and
 * never returns an extensionless shim (falling back to probing its runnable
 * siblings if `where` only surfaced the extensionless one).
 */
export async function resolveExecutable(command: string): Promise<ResolvedExecutable | null> {
  if (/[\\/]/.test(command)) return resolveExplicitPath(command);

  const lines = await runFinder(WIN ? 'where' : 'which', command);
  if (lines.length === 0) return null;
  if (!WIN) return classifyExecutable(lines[0]!);

  const runnable = lines
    .filter((l) => Number.isFinite(winRank(l)))
    .sort((a, b) => winRank(a) - winRank(b));
  if (runnable.length) return classifyExecutable(runnable[0]!);

  // `where` returned only extensionless/non-runnable matches → probe siblings
  for (const l of lines) {
    const sib = resolveExplicitPath(l);
    if (sib) return sib;
  }
  return null;
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
  opts: { cwd: string; env: NodeJS.ProcessEnv; stdio: ['pipe' | 'ignore', 'pipe', 'pipe']; detached?: boolean },
): ChildProcess {
  // On POSIX, long-running children are spawned in their own process group so
  // cancellation can signal the WHOLE group (detached/background descendants
  // included) rather than just the direct child.
  const detached = opts.detached === true && !WIN;
  if (!resolved.viaCmdShim) {
    return spawn(resolved.file, args, { ...opts, detached, windowsHide: true, shell: false });
  }
  for (const a of args) {
    if (!SAFE_SHIM_ARG.test(a)) {
      throw new Error(`Unsafe argument for a .cmd shim launch: ${JSON.stringify(a)}`);
    }
  }
  // NOTE: no `/s`. With `/s`, cmd.exe strips the outer quotes and then breaks
  // on the space in a path like `C:\Users\CHUBZ SERVER\…\codex.cmd`. Without
  // it, cmd keeps the quoted executable token intact. The only quoted token is
  // the resolved executable path we control; every arg is allowlisted
  // (SAFE_SHIM_ARG: no spaces, quotes, or shell metacharacters), so the line
  // `"<path>" arg1 arg2` parses safely with no injection surface.
  const line = `"${resolved.file}" ${args.join(' ')}`.trim();
  return spawn('cmd.exe', ['/d', '/c', line], {
    ...opts,
    // MUST use the computed value: a raw `detached: true` here would put
    // cmd.exe in its own console/process group on Windows and break the piped
    // stdin the worker reads its brief from.
    detached,
    windowsHide: true,
    shell: false,
    windowsVerbatimArguments: true,
  });
}

/**
 * True when the pid still exists. Signal 0 only probes.
 *
 * IMPORTANT: `EPERM` means the process EXISTS but we may not signal it — that
 * is very much alive. Only `ESRCH` (no such process) proves death. Treating
 * EPERM as "dead" would let cancellation report success over a surviving
 * process it simply lacks permission to touch.
 */
export function pidAlive(pid: number | null | undefined): boolean {
  if (pid == null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The result of a termination attempt. `proven` is true ONLY when every pid we
 * captured is confirmed dead. Callers must not settle a cancellation or
 * release leases on an unproven result — an uncertain kill is a failure, not a
 * success.
 */
export interface TerminationProof {
  proven: boolean;
  /** every pid we knew about: the root plus its captured descendants */
  captured: number[];
  /** pids still alive when the deadline expired */
  livePids: number[];
  detail: string;
  /** per-tracked-process breakdown folded into this merged proof (P1) */
  sources?: TerminationProofSource[];
}

/** one tracked process tree's contribution to a merged TerminationProof */
export interface TerminationProofSource {
  label: string;
  proven: boolean;
  captured: number[];
  livePids: number[];
  detail: string;
}

/**
 * The minimal, narrow seam between termination logic and the OS. Production
 * uses the real OS backend (below); tests inject a deterministic fake so
 * safety-critical kill/verify code never has to touch a real system PID.
 */
export interface ProcessBackend {
  /** every descendant of rootPid (root included), captured BEFORE any kill */
  captureTree(rootPid: number): Promise<number[]>;
  /** send a termination signal to pid; group=true signals the whole POSIX process group (Windows: the whole tree via taskkill /T) */
  kill(pid: number, opts?: { group?: boolean }): Promise<void>;
  /** true if pid is alive right now (EPERM counts as alive — it exists) */
  pidAlive(pid: number): boolean;
  /** true if the POSIX process group led by pgid still has members (always false on Windows) */
  groupAlive(pgid: number): boolean;
  /** sleep for ms (a fake backend can resolve immediately for fast deterministic tests) */
  wait(ms: number): Promise<void>;
}

/**
 * PID 0 (own/self group), PID 1 (init/launchd) and — on Windows — PID 4
 * (System) are never valid termination targets: signalling them means either
 * "every process I can touch" (POSIX group semantics for 0/negative) or a
 * real system process. A negative pid is never legitimate either. Every path
 * that would otherwise reach `kill(-1, …)` or `kill(0, …)` must be rejected
 * here BEFORE any signal is sent.
 */
export function isSafeRootPid(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 2) return false;
  if (WIN && pid === 4) return false;
  return true;
}

/** snapshot of (pid, ppid) for every process on the machine */
async function listProcesses(): Promise<Array<{ pid: number; ppid: number }> | null> {
  const run = (file: string, args: string[]): Promise<string | null> =>
    new Promise((resolve) => {
      try {
        execFile(file, args, { windowsHide: true, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) =>
          resolve(err ? null : stdout),
        );
      } catch {
        resolve(null);
      }
    });

  if (WIN) {
    // wmic first (fast, present on most builds), PowerShell CIM as fallback
    const wmic = await run('wmic', ['process', 'get', 'ProcessId,ParentProcessId', '/format:csv']);
    const parsed = wmic ? parseWinCsv(wmic) : null;
    if (parsed?.length) return parsed;
    const ps = await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Csv -NoTypeInformation',
    ]);
    return ps ? parseWinCsv(ps) : null;
  }

  const out = await run('ps', ['-eo', 'pid=,ppid=']);
  if (!out) return null;
  const rows: Array<{ pid: number; ppid: number }> = [];
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]) });
  }
  return rows.length ? rows : null;
}

/** parse either the wmic CSV (Node,ParentProcessId,ProcessId) or CIM CSV */
function parseWinCsv(text: string): Array<{ pid: number; ppid: number }> {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const header = lines.shift();
  if (!header) return [];
  const cols = header.split(',').map((c) => c.replaceAll('"', '').trim().toLowerCase());
  const pidIdx = cols.indexOf('processid');
  const ppidIdx = cols.indexOf('parentprocessid');
  if (pidIdx === -1 || ppidIdx === -1) return [];
  const rows: Array<{ pid: number; ppid: number }> = [];
  for (const line of lines) {
    const parts = line.split(',').map((p) => p.replaceAll('"', '').trim());
    const pid = Number(parts[pidIdx]);
    const ppid = Number(parts[ppidIdx]);
    if (Number.isInteger(pid) && Number.isInteger(ppid)) rows.push({ pid, ppid });
  }
  return rows;
}

/**
 * Capture the full descendant closure of `rootPid` BEFORE killing anything —
 * once the tree is torn down the parent links are gone, so a post-kill
 * enumeration cannot tell us what we were supposed to have killed.
 */
export async function captureProcessTree(rootPid: number): Promise<number[]> {
  const captured = new Set<number>([rootPid]);
  const rows = await listProcesses();
  if (!rows) return [...captured];
  const childrenOf = new Map<number, number[]>();
  for (const { pid, ppid } of rows) {
    if (!childrenOf.has(ppid)) childrenOf.set(ppid, []);
    childrenOf.get(ppid)!.push(pid);
  }
  const queue = [rootPid];
  while (queue.length) {
    const current = queue.shift()!;
    for (const child of childrenOf.get(current) ?? []) {
      if (child === current || captured.has(child)) continue;
      captured.add(child);
      queue.push(child);
    }
  }
  return [...captured];
}

/** true when the POSIX process group led by `pgid` still has members */
function groupAlive(pgid: number): boolean {
  if (WIN) return false;
  if (!isSafeRootPid(pgid)) return false; // never probe -1/-0/negative
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

/** windows: one taskkill /T /F, awaited to completion (or an 10s internal cap) */
function taskkill(pid: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', done);
      killer.on('close', done);
    } catch {
      done();
    }
    setTimeout(done, 10_000).unref?.();
  });
}

/**
 * The real OS-backed ProcessBackend. Every destructive call is guarded by
 * `isSafeRootPid` so this backend can NEVER issue `kill(-1, …)`, `kill(0, …)`,
 * or a signal against PID 1/4 — the guard sits here, at the lowest level,
 * rather than relying on every caller to check first.
 */
export const osProcessBackend: ProcessBackend = {
  captureTree: captureProcessTree,
  async kill(pid, opts) {
    if (!isSafeRootPid(pid)) {
      throw new Error(`Refusing to signal unsafe pid ${pid} (PID 0/1/4 and negative pids are never valid termination targets).`);
    }
    if (WIN) {
      await taskkill(pid); // /T already kills the tree rooted at pid
      return;
    }
    if (opts?.group) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* already gone or no permission */
      }
    } else {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  },
  pidAlive,
  groupAlive,
  wait(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      t.unref?.();
    });
  },
};

/** default backend for production code paths; tests inject a fake instead */
export const defaultProcessBackend: ProcessBackend = osProcessBackend;

/**
 * Kill + verify an ALREADY-CAPTURED pid set against `backend`, polling until
 * every pid is dead (and, on POSIX, the group is empty) or `deadlineMs`
 * expires. Shared by `terminateTree` (fresh capture) and `reverifyDead`
 * (retry against a previously captured set) so neither path re-derives the
 * tree mid-flight.
 */
async function killAndPoll(rootPid: number, captured: number[], deadlineMs: number, backend: ProcessBackend): Promise<TerminationProof> {
  const kill = async (): Promise<void> => {
    if (WIN) {
      await backend.kill(rootPid, { group: true }); // taskkill /T reaches the tree rooted at rootPid
      // sweep any captured descendant taskkill could not reach through the tree
      for (const p of captured) {
        if (p !== rootPid && backend.pidAlive(p)) await backend.kill(p);
      }
      return;
    }
    // POSIX: the group first (covers detached descendants), then stragglers
    try {
      await backend.kill(rootPid, { group: true });
    } catch {
      try {
        await backend.kill(rootPid);
      } catch {
        /* already gone */
      }
    }
    for (const p of captured) {
      if (backend.pidAlive(p)) {
        try {
          await backend.kill(p);
        } catch {
          /* already gone */
        }
      }
    }
  };

  await kill();

  // verify the COMPLETE captured tree, not just the root
  const deadline = Date.now() + deadlineMs;
  let livePids = captured.filter((p) => backend.pidAlive(p));
  let groupStillAlive = !WIN && backend.groupAlive(rootPid);
  let sweeps = 0;
  while ((livePids.length > 0 || groupStillAlive) && Date.now() < deadline) {
    await backend.wait(200);
    if (++sweeps % 10 === 0) await kill(); // periodic re-kill for stubborn trees
    livePids = captured.filter((p) => backend.pidAlive(p));
    groupStillAlive = !WIN && backend.groupAlive(rootPid);
  }

  const proven = livePids.length === 0 && !groupStillAlive;
  return {
    proven,
    captured,
    livePids,
    detail: proven
      ? `all ${captured.length} captured process(es) confirmed dead`
      : `${livePids.length} of ${captured.length} captured process(es) still alive after ${deadlineMs}ms` +
        (groupStillAlive ? ' (process group still has members)' : '') +
        (livePids.length ? `: pids ${livePids.join(', ')}` : ''),
  };
}

/**
 * Terminate a process tree and PROVE it is gone.
 *
 *   1. capture the whole descendant closure while the links still exist —
 *      exactly ONCE. A second, independent capture after the root has died
 *      would silently miss any descendant that was reparented away from it
 *      (it no longer shows up as a child of a dead pid), understating what
 *      this call is responsible for proving dead. Callers must never call
 *      this twice for the same logical termination and discard the first
 *      result — cache and reuse it (see AttemptService.terminateWorkerOnce);
 *   2. kill — Windows: one `taskkill /T /F` on the root (never the cmd.exe
 *      wrapper first, never a delayed kill, which orphans the real worker);
 *      POSIX: signal the process GROUP (children are spawned detached so they
 *      lead their own group), which reaches detached/background descendants;
 *   3. poll until EVERY captured pid is dead (and, on POSIX, the group is
 *      empty) or the deadline expires.
 *
 * A deadline expiry returns `proven: false` with the surviving pids. Callers
 * must treat that as a failed cancellation. `rootPid` is validated against
 * `isSafeRootPid` before anything else runs — PID 0/1/4/negative are refused
 * outright, never captured, never signalled.
 */
export async function terminateTree(
  proc: ChildProcess,
  deadlineMs = 15_000,
  backend: ProcessBackend = defaultProcessBackend,
): Promise<TerminationProof> {
  const pid = proc.pid;
  if (pid == null) {
    return { proven: true, captured: [], livePids: [], detail: 'process was never started' };
  }
  if (!isSafeRootPid(pid)) {
    return {
      proven: false,
      captured: [],
      livePids: [pid],
      detail: `refusing to terminate unsafe root pid ${pid} (PID 0/1/4 and negative pids are never valid termination targets)`,
    };
  }
  const captured = await backend.captureTree(pid);
  return killAndPoll(pid, captured, deadlineMs, backend);
}

/**
 * Re-attempt termination of an ALREADY-KNOWN captured pid set — e.g. a retry
 * after a prior unproven cancellation or timeout — WITHOUT ever re-deriving
 * the process tree. Re-capturing on retry is exactly the bug this avoids: a
 * root that already died has no discoverable children left in a fresh scan,
 * so a naive retry would silently drop any surviving descendant from what it
 * verifies. This re-kills and re-polls the SAME pids the first attempt
 * captured, so a still-alive descendant is never lost.
 */
export async function reverifyDead(
  rootPid: number,
  captured: number[],
  deadlineMs = 5_000,
  backend: ProcessBackend = defaultProcessBackend,
): Promise<TerminationProof> {
  if (!isSafeRootPid(rootPid)) {
    return {
      proven: false,
      captured,
      livePids: captured.filter((p) => backend.pidAlive(p)),
      detail: `refusing to operate on unsafe root pid ${rootPid} (PID 0/1/4 and negative pids are never valid termination targets)`,
    };
  }
  return killAndPoll(rootPid, captured, deadlineMs, backend);
}

/** fire-and-forget termination used by timeout paths (proof not required) */
export function killProcessTree(proc: ChildProcess): Promise<void> {
  return terminateTree(proc, 5_000).then(() => undefined);
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
  /** parent environment to allowlist from (defaults to process.env; tests inject) */
  env?: NodeJS.ProcessEnv;
}

export interface RunnerOutcome {
  exitReason: ExitReason;
  exitCode: number | null;
  error: string | null;
  logTail: string[];
  /**
   * Set ONLY when this outcome was reached via a forced termination (a hard
   * timeout). Callers MUST check `.proven` before treating leases as safe to
   * release — an unproven kill means the process tree may still be alive.
   */
  terminationProof?: TerminationProof;
}

export interface RunnerHandle {
  pid: number | null;
  executablePath: string | null;
  version: string | null;
  done: Promise<RunnerOutcome>;
  /**
   * Terminate the process tree and report whether termination was PROVEN.
   * An unproven result must never be treated as a successful cancellation.
   */
  cancel(): Promise<TerminationProof>;
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
): { done: Promise<RunnerOutcome>; cancel(): Promise<TerminationProof> } {
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

  // a single termination call for this proc, however many callers ask for it
  // (the internal timeout timer AND an explicit cancel() can race) — never
  // issue two independent terminateTree calls against the same process, since
  // a second capture after the first has already killed the root would see a
  // shrunk (or empty) tree and understate what actually needs to be proven dead
  let terminating: Promise<TerminationProof> | null = null;
  const terminateOnce = (): Promise<TerminationProof> => {
    if (!terminating) terminating = terminateTree(proc);
    return terminating;
  };

  let resolveDone!: (o: RunnerOutcome) => void;
  const done = new Promise<RunnerOutcome>((resolve) => {
    resolveDone = resolve;
  });
  let settled = false;
  const settle = (o: RunnerOutcome) => {
    if (settled) return;
    settled = true;
    resolveDone(o);
  };
  let closeCode: number | null = null;

  const timer = setTimeout(() => {
    timedOut = true;
    log(`Hard timeout after ${Math.round(launch.timeoutMs / 1000)}s — terminating process tree.`, 'error');
    // MUST await the full termination proof before settling `done` — a
    // process that merely closed its stdio is not proof its whole tree died
    void terminateOnce().then((proof) => {
      settle({
        exitReason: 'timeout',
        exitCode: closeCode,
        error: 'Worker exceeded the attempt time limit.',
        logTail: tail,
        terminationProof: proof,
      });
    });
  }, launch.timeoutMs);
  timer.unref?.();

  proc.on('error', (err) => {
    clearTimeout(timer);
    settle({
      exitReason: 'unavailable',
      exitCode: null,
      error: `Could not launch worker executable: ${err.message}`,
      logTail: tail,
    });
  });
  proc.on('close', (code) => {
    clearTimeout(timer);
    closeCode = code;
    // the timeout branch owns resolution once it has fired: it awaits the
    // full termination proof, which may resolve after (or before) 'close'
    if (timedOut) return;
    const exitReason = cancelled ? 'cancelled' : classifyExit(code, collected, { cancelled, timedOut });
    settle({
      exitReason,
      exitCode: code,
      error:
        exitReason === 'success'
          ? null
          : exitReason === 'cancelled'
            ? 'Cancelled by owner.'
            : `Worker exit ${code}: ${tail.slice(-3).join(' | ') || 'no output'}`,
      logTail: tail,
    });
  });

  return {
    done,
    /**
     * Authoritative cancellation: capture the whole tree, kill it immediately
     * (never the cmd.exe wrapper first, never a delayed taskkill — that
     * orphans the real worker and its background children), then verify EVERY
     * captured pid is dead. The returned proof tells the caller whether it may
     * settle the cancellation at all.
     */
    async cancel(): Promise<TerminationProof> {
      cancelled = true;
      const proof = await terminateOnce();
      await Promise.race([
        done.then(() => undefined),
        new Promise<void>((r) => setTimeout(r, 5_000).unref?.()),
      ]);
      return proof;
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
 *   [[DUMPENV:VAR]] write ENV_DUMP.txt with VAR's value or ABSENT (env isolation)
 */
const TEST_SCRIPT = `
const fs = require('node:fs');
const path = require('node:path');
const goal = process.env.CC_GOAL || '';
(async () => {
  console.log('test-runner: session started');
  if (goal.includes('[[SECRET]]')) console.log('leaked credential token=sk-verysecret1234567890 (should be redacted)');
  const de = goal.match(/\\[\\[DUMPENV:([A-Za-z0-9_]+)\\]\\]/);
  if (de) { const v = process.env[de[1]]; fs.writeFileSync('ENV_DUMP.txt', de[1] + '=' + (v === undefined ? 'ABSENT' : v) + '\\n'); console.log('test-runner: dumped env ' + de[1]); }
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
    // the deterministic runner is held to the SAME env isolation as a real
    // worker: allowlisted parent env + the one task variable it needs.
    const env = { ...allowlistedChildEnv([], launch.env ?? process.env), CC_GOAL: launch.goal };
    const proc = spawn(process.execPath, ['-e', TEST_SCRIPT], {
      cwd: launch.worktree,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
      // own process group on POSIX → cancellation kills background descendants
      detached: process.platform !== 'win32',
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
  // Exit 0 is success, full stop. The keyword scan below only REFINES a
  // failing exit into a specific reason — scanning a successful session's
  // stdout would misclassify any run that merely mentions "authentication",
  // "quota", etc. in the model's own reasoning.
  if (code === 0) return 'success';
  const t = text.toLowerCase();
  if (/not logged in|please run\b.*login|unauthorized|\b401\b|error saving auth|login required/.test(t)) return 'auth_required';
  if (/rate.?limit|\b429\b|too many requests/.test(t)) return 'rate_limited';
  if (/quota|usage limit|insufficient credit/.test(t)) return 'quota_exhausted';
  if (code === null) return 'unknown';
  return 'failure';
}

export class CodexRunner implements WorkerRunner {
  readonly adapter = 'codex';

  constructor(
    private readonly options: { command: string; model: string; authMode?: CodexAuthMode },
  ) {}

  /** credential mode this runner will use (default: on-disk codex login) */
  get authMode(): CodexAuthMode {
    return this.options.authMode ?? 'login_file';
  }

  async probe() {
    const resolved = await resolveExecutable(this.options.command);
    if (!resolved) return { path: null, version: null, error: `Codex executable "${this.options.command}" not found on PATH.` };
    const version = await new Promise<string | null>((resolve) => {
      try {
        const proc = spawnSafe(resolved, ['--version'], {
          cwd: process.cwd(),
          env: allowlistedChildEnv(codexEnvExtra(this.authMode)),
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
        async cancel(): Promise<TerminationProof> {
          return { proven: true, captured: [], livePids: [], detail: 'worker was never launched' };
        },
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
    // Minimal ALLOWLISTED environment (never a blocklist): the base benign
    // variables plus exactly the keys the SELECTED credential mode needs.
    //   - default 'login_file': only CODEX_HOME — authentication comes from the
    //     on-disk `codex login`; an OPENAI_API_KEY present in the Command
    //     Center's environment is NOT forwarded;
    //   - 'api_key' (explicit owner opt-in): additionally OPENAI_API_KEY and
    //     the related endpoint/org variables;
    //   - AUTH_TOKEN and every other parent secret are never inherited.
    const env = allowlistedChildEnv(codexEnvExtra(this.authMode), launch.env ?? process.env);

    const proc = spawnSafe(resolved, args, {
      cwd: launch.worktree,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true, // own process group on POSIX → whole-group cancellation
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
