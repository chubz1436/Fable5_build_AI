import type {
  AttemptValidation,
  ValidationCommand,
  ValidationStepResult,
} from '../../../shared/types';
import { nowIso, uid } from '../domain/util';
import { killProcessTree, redactSecrets, resolveExecutable, spawnSafe } from './runners';

/**
 * Independent validation runner (P0.9, hardened per P0-1/P0-3). The Command
 * Center — not the worker — executes the project's configured commands inside
 * the attempt worktree and records real exit codes. Worker claims are never
 * validation evidence.
 *
 * Rules encoded here:
 *  - structured argv only (sanitised at registration); no shell strings;
 *  - subprocesses get a MINIMAL ALLOWLISTED environment — parent secrets
 *    (tokens, API keys, anything not on the allowlist) are never visible;
 *  - every spawned process is tracked and killed on cancellation (AbortSignal)
 *    or per-command timeout;
 *  - no configured commands  → UNVERIFIED, never PASSED;
 *  - a required failed step  → FAILED (blocks verified delivery);
 *  - optional failures only  → PARTIAL.
 *
 * NOTE (honest risk statement): validation commands are owner-configured
 * programs executed with the owner's OS privileges. The environment allowlist
 * limits secret exposure and the worktree snapshot check (service.ts) detects
 * mutations, but a validation command can still read anything the OS account
 * can read. Only configure commands you trust.
 */

/**
 * Environment variables a validation subprocess may inherit. Everything else
 * — including AUTH_TOKEN, ANTHROPIC_API_KEY, OPENAI_API_KEY and any other
 * secret-like variable — is dropped by construction (allowlist, not
 * blocklist). Comparison is case-insensitive (Windows env semantics).
 */
const ENV_ALLOWLIST = new Set(
  [
    // process discovery / execution
    'PATH', 'PATHEXT', 'COMSPEC', 'SHELL',
    // Windows system locations many tools require
    'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'OS',
    'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'PROGRAMDATA',
    'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)',
    // per-user locations (npm/node caches and tool state live here)
    'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
    'APPDATA', 'LOCALAPPDATA', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
    // temp dirs
    'TEMP', 'TMP', 'TMPDIR',
    // benign machine/user identity + locale
    'USERNAME', 'USER', 'USERDOMAIN', 'COMPUTERNAME', 'HOSTNAME', 'LOGNAME',
    'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM',
    // hardware hints used by test runners for parallelism
    'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER',
  ].map((k) => k.toUpperCase()),
);

/** minimal allowlisted environment for validation subprocesses (P0-1) */
export function minimalValidationEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of Object.keys(base)) {
    if (ENV_ALLOWLIST.has(key.toUpperCase())) env[key] = base[key];
  }
  // deliberate signal to validation tooling: non-interactive, CI-like
  env.CI = '1';
  return env;
}

export async function runValidation(
  commands: ValidationCommand[],
  worktree: string,
  onLog: (line: string, level?: 'info' | 'warning' | 'error') => void,
  signal?: AbortSignal,
): Promise<AttemptValidation> {
  if (commands.length === 0) {
    onLog('[verify] no validation commands configured — result is UNVERIFIED', 'warning');
    return { status: 'UNVERIFIED', steps: [], completedAt: nowIso() };
  }

  const env = minimalValidationEnv();

  const steps: ValidationStepResult[] = [];
  let requiredFailed = false;
  let optionalFailed = false;
  let cancelled = signal?.aborted ?? false;

  for (const cmd of commands) {
    const step: ValidationStepResult = {
      id: uid('vstep'),
      name: cmd.name,
      argv: cmd.argv,
      cwd: worktree,
      required: cmd.required,
      startedAt: nowIso(),
      endedAt: null,
      timeoutMs: cmd.timeoutMs,
      exitCode: null,
      status: 'ERROR',
      outputTail: [],
    };

    // cancellation checkpoint between commands (P0-3)
    if (cancelled || signal?.aborted) {
      cancelled = true;
      step.status = 'CANCELLED';
      step.endedAt = nowIso();
      step.outputTail = ['cancelled before start'];
      steps.push(step);
      if (cmd.required) requiredFailed = true;
      continue;
    }

    onLog(`[verify] ${cmd.name}: ${cmd.argv.join(' ')}`);

    const resolved = await resolveExecutable(cmd.argv[0]!);
    if (!resolved) {
      step.status = 'ERROR';
      step.outputTail = [`executable not found: ${cmd.argv[0]}`];
      step.endedAt = nowIso();
      onLog(`[verify] ${cmd.name}: executable not found`, 'error');
    } else {
      const result = await new Promise<{ code: number | null; timedOut: boolean; wasCancelled: boolean; tail: string[] }>(
        (resolve) => {
          const tail: string[] = [];
          let timedOut = false;
          let wasCancelled = false;
          let proc;
          try {
            proc = spawnSafe(resolved, cmd.argv.slice(1), {
              cwd: worktree,
              env,
              stdio: ['ignore', 'pipe', 'pipe'],
            });
          } catch (err) {
            resolve({ code: null, timedOut: false, wasCancelled: false, tail: [String((err as Error).message)] });
            return;
          }
          const feed = (chunk: Buffer) => {
            for (const l of chunk.toString('utf8').split(/\r?\n/)) {
              if (!l.trim()) continue;
              tail.push(redactSecrets(l.trim()).slice(0, 300));
              if (tail.length > 60) tail.shift();
            }
          };
          proc.stdout?.on('data', feed);
          proc.stderr?.on('data', feed);
          const timer = setTimeout(() => {
            timedOut = true;
            killProcessTree(proc);
          }, cmd.timeoutMs);
          timer.unref?.();
          // P0-3: cancellation kills the live validation process tree; we only
          // resolve on 'close', so termination is proven before we return.
          const onAbort = () => {
            wasCancelled = true;
            killProcessTree(proc);
          };
          signal?.addEventListener('abort', onAbort, { once: true });
          // the abort may have fired while we awaited executable resolution —
          // an already-aborted signal never emits 'abort', so re-check now
          if (signal?.aborted) onAbort();
          proc.on('error', (err) => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            resolve({ code: null, timedOut: false, wasCancelled, tail: [err.message] });
          });
          proc.on('close', (code) => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            resolve({ code, timedOut, wasCancelled, tail });
          });
        },
      );

      step.exitCode = result.code;
      step.outputTail = result.tail;
      step.endedAt = nowIso();
      step.status = result.wasCancelled || signal?.aborted
        ? 'CANCELLED'
        : result.timedOut
          ? 'TIMEOUT'
          : result.code === 0
            ? 'PASSED'
            : result.code === null
              ? 'ERROR'
              : 'FAILED';
      if (step.status === 'CANCELLED') cancelled = true;
      onLog(
        `[verify] ${cmd.name}: ${step.status}${result.code !== null ? ` (exit ${result.code})` : ''}`,
        step.status === 'PASSED' ? 'info' : 'error',
      );
    }

    if (step.status !== 'PASSED') {
      if (cmd.required) requiredFailed = true;
      else optionalFailed = true;
    }
    steps.push(step);
  }

  const status = requiredFailed ? 'FAILED' : optionalFailed ? 'PARTIAL' : 'VERIFIED';
  return { status, steps, completedAt: nowIso() };
}
