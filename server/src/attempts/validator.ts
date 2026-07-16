import type {
  AttemptValidation,
  ValidationCommand,
  ValidationStepResult,
} from '../../../shared/types';
import { nowIso, uid } from '../domain/util';
import { killProcessTree, redactSecrets, resolveExecutable, spawnSafe } from './runners';

/**
 * Independent validation runner (P0.9). The Command Center — not the worker —
 * executes the project's configured commands inside the attempt worktree and
 * records real exit codes. Worker claims are never validation evidence.
 *
 * Rules encoded here:
 *  - structured argv only (sanitised at registration); no shell strings;
 *  - no configured commands  → UNVERIFIED, never PASSED;
 *  - a required failed step  → FAILED (blocks verified delivery);
 *  - optional failures only  → PARTIAL.
 */

/** env vars that must never leak into validation subprocesses */
const STRIPPED_ENV = [
  'AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
];

export async function runValidation(
  commands: ValidationCommand[],
  worktree: string,
  onLog: (line: string, level?: 'info' | 'warning' | 'error') => void,
): Promise<AttemptValidation> {
  if (commands.length === 0) {
    onLog('[verify] no validation commands configured — result is UNVERIFIED', 'warning');
    return { status: 'UNVERIFIED', steps: [], completedAt: nowIso() };
  }

  const env = { ...process.env };
  for (const key of STRIPPED_ENV) delete env[key];

  const steps: ValidationStepResult[] = [];
  let requiredFailed = false;
  let optionalFailed = false;

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
    onLog(`[verify] ${cmd.name}: ${cmd.argv.join(' ')}`);

    const resolved = await resolveExecutable(cmd.argv[0]!);
    if (!resolved) {
      step.status = 'ERROR';
      step.outputTail = [`executable not found: ${cmd.argv[0]}`];
      step.endedAt = nowIso();
      onLog(`[verify] ${cmd.name}: executable not found`, 'error');
    } else {
      const result = await new Promise<{ code: number | null; timedOut: boolean; tail: string[] }>((resolve) => {
        const tail: string[] = [];
        let timedOut = false;
        let proc;
        try {
          proc = spawnSafe(resolved, cmd.argv.slice(1), {
            cwd: worktree,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch (err) {
          resolve({ code: null, timedOut: false, tail: [String((err as Error).message)] });
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
        proc.on('error', (err) => {
          clearTimeout(timer);
          resolve({ code: null, timedOut: false, tail: [err.message] });
        });
        proc.on('close', (code) => {
          clearTimeout(timer);
          resolve({ code, timedOut, tail });
        });
      });

      step.exitCode = result.code;
      step.outputTail = result.tail;
      step.endedAt = nowIso();
      step.status = result.timedOut
        ? 'TIMEOUT'
        : result.code === 0
          ? 'PASSED'
          : result.code === null
            ? 'ERROR'
            : 'FAILED';
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
