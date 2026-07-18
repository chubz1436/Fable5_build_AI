import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { captureProcessTree, CodexRunner, pidAlive, type RunnerLaunch } from '../src/attempts/runners';

const WIN = process.platform === 'win32';
const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_DETACHED = path.join(here, 'fixtures', 'fake-codex-detached.mjs');

const tmpDirs: string[] = [];
function tmp(name = 'chubz-cancel-'): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), name));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* a killed child may still hold a handle briefly */
    }
  }
});

function makeFakeCodex(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  if (WIN) {
    const cmd = path.join(dir, 'codex.cmd');
    fs.writeFileSync(cmd, `@echo off\r\nnode "${FAKE_DETACHED}" %*\r\n`, 'utf8');
    return cmd;
  }
  const sh = path.join(dir, 'codex');
  fs.writeFileSync(sh, `#!/bin/sh\nexec node "${FAKE_DETACHED}" "$@"\n`, 'utf8');
  fs.chmodSync(sh, 0o755);
  return sh;
}

const launch = (worktree: string, over: Partial<RunnerLaunch> = {}): RunnerLaunch => ({
  worktree,
  brief: 'Add a sum(a,b) utility.',
  goal: 'Add a sum(a,b) utility.',
  timeoutMs: 60_000,
  maxLogLines: 500,
  onLog: () => {},
  ...over,
});

describe('process-tree cancellation (detached descendants)', () => {
  it('cancellation terminates a background child: its delayed marker is never written', async () => {
    const cmd = makeFakeCodex(path.join(tmp(), 'detach dir'));
    const worktree = tmp('chubz-wt-');
    const runner = new CodexRunner({ command: cmd, model: '' });
    const logs: string[] = [];
    const handle = await runner.start(launch(worktree, { onLog: (l) => logs.push(l) }));

    // wait until the fake worker reports the background child is up
    const marker = path.join(worktree, 'DETACHED_CHILD_RAN.txt');
    const start = Date.now();
    while (!logs.some((l) => l.includes('spawned background child')) && Date.now() - start < 15_000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    // the test is only meaningful if the descendant really exists
    const spawnLine = logs.find((l) => l.includes('spawned background child'));
    expect(spawnLine, 'fake worker never spawned its background child').toBeTruthy();
    const childPid = Number(spawnLine!.match(/pid=(\d+)/)?.[1]);
    expect(Number.isInteger(childPid)).toBe(true);
    // wait for the descendant to actually appear in the OS process table —
    // polling instead of a fixed sleep is what makes this reliable under load
    const upBy = Date.now() + 10_000;
    while (!pidAlive(childPid) && Date.now() < upBy) await new Promise((r) => setTimeout(r, 50));
    expect(pidAlive(childPid), 'background child should be alive before cancellation').toBe(true);
    // and it must be captured as part of the tree BEFORE we kill anything
    const captured = await captureProcessTree(handle.pid!);
    expect(captured, 'descendant must be captured before the kill').toContain(childPid);

    // cancel() must resolve only once the WHOLE tree is proven down
    const proof = await handle.cancel();
    expect(proof.proven, `termination not proven: ${proof.detail}`).toBe(true);
    expect(proof.captured).toContain(childPid);
    expect(proof.livePids).toEqual([]);

    const outcome = await handle.done;
    expect(outcome.exitReason).toBe('cancelled');
    expect(pidAlive(handle.pid), 'root process still alive after cancel').toBe(false);
    expect(pidAlive(childPid), 'detached descendant survived cancellation').toBe(false);

    // and its delayed write (6s after spawn) must never land
    await new Promise((r) => setTimeout(r, 7000));
    expect(fs.existsSync(marker), 'detached child survived cancellation and wrote its marker').toBe(false);
    // the parent's own slow output must also be absent
    expect(fs.existsSync(path.join(worktree, 'sum.js'))).toBe(false);
  }, 60_000);

  it('cancel() is idempotent and still resolves when the tree is already gone', async () => {
    const cmd = makeFakeCodex(path.join(tmp(), 'idem dir'));
    const worktree = tmp('chubz-wt-');
    const runner = new CodexRunner({ command: cmd, model: '' });
    const handle = await runner.start(launch(worktree));
    const start = Date.now();
    while (handle.pid == null && Date.now() - start < 5000) await new Promise((r) => setTimeout(r, 20));

    await handle.cancel();
    await handle.cancel(); // second call must not hang or throw
    const outcome = await handle.done;
    expect(outcome.exitReason).toBe('cancelled');
  }, 40_000);
});
