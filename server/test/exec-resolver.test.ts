import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexRunner, resolveExecutable } from '../src/attempts/runners';
import type { RunnerLaunch } from '../src/attempts/runners';

const WIN = process.platform === 'win32';
const itWin = WIN ? it : it.skip;
const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_WORKER = path.join(here, 'fixtures', 'fake-codex-cli.mjs');

const tmpDirs: string[] = [];
function tmp(name = 'chubz-exec-'): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), name));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** Build a runnable fake `codex` shim in `dir` (real .cmd on Windows). */
function makeFakeCodex(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  if (WIN) {
    const cmd = path.join(dir, 'codex.cmd');
    fs.writeFileSync(cmd, `@echo off\r\nnode "${FAKE_WORKER}" %*\r\n`, 'utf8');
    return cmd;
  }
  const sh = path.join(dir, 'codex');
  fs.writeFileSync(sh, `#!/bin/sh\nexec node "${FAKE_WORKER}" "$@"\n`, 'utf8');
  fs.chmodSync(sh, 0o755);
  return sh;
}

const baseLaunch = (worktree: string, over: Partial<RunnerLaunch> = {}): RunnerLaunch => ({
  worktree,
  brief: 'Add a sum(a,b) utility.',
  goal: 'Add a sum(a,b) utility.',
  timeoutMs: 20_000,
  maxLogLines: 500,
  onLog: () => {},
  ...over,
});

describe('Windows-aware executable resolver', () => {
  it('resolves an explicit .cmd path (npm shim) and flags it as a shim on Windows', async () => {
    const dir = tmp();
    const cmd = makeFakeCodex(dir);
    const r = await resolveExecutable(cmd);
    expect(r).not.toBeNull();
    expect(r!.file).toBe(cmd);
    expect(r!.viaCmdShim).toBe(WIN); // .cmd → cmd.exe shim on Windows only
  });

  it('resolves a shim whose path contains spaces', async () => {
    const dir = path.join(tmp(), 'dir with spaces', 'npm bin');
    const cmd = makeFakeCodex(dir);
    expect(cmd).toContain(' ');
    const r = await resolveExecutable(cmd);
    expect(r).not.toBeNull();
    expect(r!.file).toBe(cmd);
  });

  it('returns null for a missing executable', async () => {
    expect(await resolveExecutable('definitely-not-a-real-cli-xyz-404')).toBeNull();
    const dir = tmp();
    expect(await resolveExecutable(path.join(dir, 'nope', 'ghost'))).toBeNull();
  });

  itWin('prefers the .cmd shim over the extensionless npm shim (the ENOENT bug)', async () => {
    const dir = tmp();
    // reproduce npm's layout: an extensionless bash shim next to codex.cmd
    fs.writeFileSync(path.join(dir, 'codexpick'), '#!/bin/sh\n# bash shim\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'codexpick.cmd'), '@echo off\r\n', 'utf8');
    const oldPath = process.env.PATH;
    process.env.PATH = dir + path.delimiter + oldPath;
    try {
      const r = await resolveExecutable('codexpick');
      expect(r).not.toBeNull();
      expect(r!.file.toLowerCase().endsWith('.cmd')).toBe(true);
      expect(r!.viaCmdShim).toBe(true);
    } finally {
      process.env.PATH = oldPath;
    }
  });

  itWin('probes runnable PATHEXT siblings for an explicit extensionless path', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'codex'), '#!/bin/sh\n', 'utf8'); // extensionless (unusable)
    fs.writeFileSync(path.join(dir, 'codex.cmd'), '@echo off\r\n', 'utf8');
    const r = await resolveExecutable(path.join(dir, 'codex')); // asked for the extensionless one
    expect(r).not.toBeNull();
    expect(r!.file.toLowerCase().endsWith('.cmd')).toBe(true);
  });
});

describe('CodexRunner launch via the resolved shim', () => {
  it('version probe reports the resolved shim path and a version', async () => {
    const cmd = makeFakeCodex(path.join(tmp(), 'probe dir'));
    const runner = new CodexRunner({ command: cmd, model: '' });
    const probe = await runner.probe();
    expect(probe.error).toBeNull();
    expect(probe.path).toBe(cmd);
    expect(probe.version).toContain('9.9.9-fake');
  });

  it('launches the worker (spaced path) and produces a real file change', async () => {
    const cmd = makeFakeCodex(path.join(tmp(), 'launch dir'));
    const worktree = tmp('chubz-wt-');
    const runner = new CodexRunner({ command: cmd, model: '' });
    const handle = await runner.start(baseLaunch(worktree));
    expect(handle.executablePath).toBe(cmd);
    const outcome = await handle.done;
    expect(outcome.exitReason).toBe('success');
    expect(fs.existsSync(path.join(worktree, 'sum.js'))).toBe(true);
    expect(fs.readFileSync(path.join(worktree, 'sum.js'), 'utf8')).toContain('a + b');
  });

  it('cancellation terminates the process tree before the file is written', async () => {
    const cmd = makeFakeCodex(path.join(tmp(), 'cancel dir'));
    const worktree = tmp('chubz-wt-');
    const runner = new CodexRunner({ command: cmd, model: '' });
    const handle = await runner.start(baseLaunch(worktree, { brief: 'Add sum [[SLOW]]', goal: 'slow' }));
    // wait until the child is actually up
    const start = Date.now();
    while (handle.pid == null && Date.now() - start < 3000) await new Promise((r) => setTimeout(r, 20));
    handle.cancel();
    const outcome = await handle.done;
    expect(outcome.exitReason).toBe('cancelled');
    expect(fs.existsSync(path.join(worktree, 'sum.js'))).toBe(false);
  }, 15_000);

  it('does not execute shell metacharacters in the task text (brief goes via stdin)', async () => {
    const cmd = makeFakeCodex(path.join(tmp(), 'inject dir'));
    const worktree = tmp('chubz-wt-');
    const sentinel = path.join(worktree, 'injected.txt').replaceAll('\\', '/');
    const evilBrief = `Add sum(a,b). & echo INJECTED > "${sentinel}" & type nul`;
    const runner = new CodexRunner({ command: cmd, model: '' });
    const outcome = await (await runner.start(baseLaunch(worktree, { brief: evilBrief, goal: evilBrief })).then((h) => h.done));
    expect(outcome.exitReason).toBe('success');
    // the injected side effect must NOT have happened…
    expect(fs.existsSync(path.join(worktree, 'injected.txt'))).toBe(false);
    // …while the legitimate worker output did
    expect(fs.existsSync(path.join(worktree, 'sum.js'))).toBe(true);
  });

  it('reports UNAVAILABLE (not FAILED) when the executable cannot be found', async () => {
    const runner = new CodexRunner({ command: 'definitely-not-codex-xyz-404', model: '' });
    const probe = await runner.probe();
    expect(probe.path).toBeNull();
    expect(probe.error).toContain('not found');
    const handle = await runner.start(baseLaunch(tmp('chubz-wt-')));
    const outcome = await handle.done;
    expect(outcome.exitReason).toBe('unavailable');
  });
});
