import type { ChildProcess } from 'node:child_process';
import type {
  AttemptValidation,
  ValidationCommand,
  ValidationStepResult,
} from '../../../shared/types';
import { nowIso, uid } from '../domain/util';
import { minimalValidationEnv } from './env';
import { redactSecrets, resolveExecutable, spawnSafe, terminateTree, type TerminationProof } from './runners';

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
// env allowlisting lives in ./env (shared with the worker runners; re-exported
// here so existing importers keep working)
export { allowlistedChildEnv, minimalValidationEnv } from './env';

export interface RunValidationOptions {
  signal?: AbortSignal;
  /**
   * Run before EACH command. Returning a non-null reason fails the step closed
   * (required → FAILED) and aborts the rest — used to re-scan for symlink /
   * junction escapes before every command (fail-closed containment).
   */
  beforeCommand?: () => string | null;
  /**
   * Called with every spawned validation process so the caller can track it and
   * PROVE its whole tree is dead on cancellation. Called again (same process)
   * ONLY once its termination is fully settled (proven or not) — never merely
   * because its stdio closed, which is not proof the whole tree died.
   */
  onProcess?: (proc: ChildProcess, event: 'spawned' | 'closed') => void;
  /**
   * Terminate a validation process tree and PROVE it — overridable so the
   * caller can dedupe/cache the proof per process (never re-derive a tree
   * that has already been partially torn down). Defaults to `terminateTree`.
   */
  terminate?: (proc: ChildProcess) => Promise<TerminationProof>;
  /**
   * Fired once a FORCED termination (timeout or cancellation) settles,
   * proven or not. Callers must retain leases when any reported proof is
   * unproven — do not infer success just because the command's promise
   * eventually resolved.
   */
  onTermination?: (proof: TerminationProof, ctx: { command: string; reason: 'timeout' | 'cancelled' }) => void;
}

export async function runValidation(
  commands: ValidationCommand[],
  worktree: string,
  onLog: (line: string, level?: 'info' | 'warning' | 'error') => void,
  options: RunValidationOptions = {},
): Promise<AttemptValidation> {
  const { signal, beforeCommand, onProcess, onTermination } = options;
  const terminate = options.terminate ?? ((proc: ChildProcess) => terminateTree(proc));
  if (commands.length === 0) {
    onLog('[verify] no validation commands configured — result is UNVERIFIED', 'warning');
    return { status: 'UNVERIFIED', steps: [], completedAt: nowIso() };
  }

  const env = minimalValidationEnv();

  const steps: ValidationStepResult[] = [];
  let requiredFailed = false;
  let optionalFailed = false;
  let cancelled = signal?.aborted ?? false;
  let guardTripped = false;

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

    // fail-closed containment re-scan before this command
    const guardReason = guardTripped ? 'containment scan failed on an earlier command' : beforeCommand?.();
    if (guardReason) {
      guardTripped = true;
      step.status = 'FAILED';
      step.endedAt = nowIso();
      step.outputTail = [`blocked before run: ${guardReason}`];
      onLog(`[verify] ${cmd.name}: BLOCKED — ${guardReason}`, 'error');
      steps.push(step);
      requiredFailed = true; // any containment failure blocks a verified delivery
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
              // POSIX: own process group so cancellation can kill the WHOLE
              // group (a validator's background children included) without
              // signalling the Command Center itself
              detached: true,
            });
          } catch (err) {
            resolve({ code: null, timedOut: false, wasCancelled: false, tail: [String((err as Error).message)] });
            return;
          }
          onProcess?.(proc, 'spawned');
          const feed = (chunk: Buffer) => {
            for (const l of chunk.toString('utf8').split(/\r?\n/)) {
              if (!l.trim()) continue;
              tail.push(redactSecrets(l.trim()).slice(0, 300));
              if (tail.length > 60) tail.shift();
            }
          };
          proc.stdout?.on('data', feed);
          proc.stderr?.on('data', feed);

          // a single termination call for this proc, however many callers ask
          // for it (a timeout AND an abort can race) — never issue two
          // independent terminateTree calls against the same process, since a
          // second capture after the first already killed the root would see
          // a shrunk tree and understate what needs to be proven dead
          let terminating: Promise<TerminationProof> | null = null;
          const terminateOnce = (reason: 'timeout' | 'cancelled'): Promise<TerminationProof> => {
            if (!terminating) {
              terminating = terminate(proc!).then((proof) => {
                onTermination?.(proof, { command: cmd.name, reason });
                return proof;
              });
            }
            return terminating;
          };

          let closeCode: number | null = null;
          let settled = false;
          const settle = (o: { code: number | null; timedOut: boolean; wasCancelled: boolean; tail: string[] }) => {
            if (settled) return;
            settled = true;
            // untrack ONLY once termination is fully settled (proven or not)
            // — never merely because stdio closed, which is not proof the
            // whole tree died
            onProcess?.(proc!, 'closed');
            resolve(o);
          };

          const timer = setTimeout(() => {
            timedOut = true;
            void terminateOnce('timeout').then(() => settle({ code: closeCode, timedOut, wasCancelled, tail }));
          }, cmd.timeoutMs);
          timer.unref?.();
          // P0-3: cancellation kills the live validation process tree; we only
          // resolve once termination is PROVEN (or the deadline expires),
          // never merely on 'close'.
          const onAbort = () => {
            wasCancelled = true;
            void terminateOnce('cancelled').then(() => settle({ code: closeCode, timedOut, wasCancelled, tail }));
          };
          signal?.addEventListener('abort', onAbort, { once: true });
          // the abort may have fired while we awaited executable resolution —
          // an already-aborted signal never emits 'abort', so re-check now
          if (signal?.aborted) onAbort();
          proc.on('error', (err) => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            // a forced-termination path already in flight owns settlement —
            // it awaits the full proof before resolving
            if (timedOut || wasCancelled) return;
            settle({ code: null, timedOut: false, wasCancelled, tail: [err.message] });
          });
          proc.on('close', (code) => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            closeCode = code;
            // a forced-termination path owns settlement once triggered: it
            // awaits the full termination proof, which may resolve after (or
            // before) 'close' — a graceful close settles immediately here
            if (timedOut || wasCancelled) return;
            settle({ code, timedOut, wasCancelled, tail });
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
