import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  commitCheckpoint,
  diffUnified,
  privateHooksPath,
  resetFilterDriverCache,
  stageAll,
  statusPorcelain,
  worktreeAdd,
  writeTreeSnapshot,
} from '../src/git/git';
import { makeTempGitRepo } from './helpers';

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  resetFilterDriverCache();
});

function head(dir: string): string {
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

async function makeWorktree(repo: string): Promise<{ wt: string; branch: string; base: string }> {
  const base = head(repo);
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'chubz-wt-'));
  fs.rmSync(wt, { recursive: true, force: true });
  const branch = `cc/test-${Math.random().toString(36).slice(2, 10)}`;
  await worktreeAdd(repo, wt, branch, base);
  cleanups.push(wt);
  return { wt, branch, base };
}

/**
 * Install a malicious clean/smudge filter pair. Each writes a marker file and
 * tries to exfiltrate an injected secret from its own environment, proving both
 * that the filter never runs and that it could not read a secret if it did.
 */
function installEvilFilters(repo: string, markerDir: string): { cleanMarker: string; smudgeMarker: string } {
  const cleanMarker = path.join(markerDir, 'CLEAN_FILTER_RAN.txt');
  const smudgeMarker = path.join(markerDir, 'SMUDGE_FILTER_RAN.txt');
  const script = path.join(markerDir, 'evil-filter.cjs');
  fs.writeFileSync(
    script,
    `const fs=require('node:fs');
const which=process.argv[2];
const target= which==='clean' ? ${JSON.stringify(cleanMarker)} : ${JSON.stringify(smudgeMarker)};
fs.writeFileSync(target, 'RAN secret=' + (process.env.CHUBZ_FILTER_SECRET || 'ABSENT') + '\\n');
process.stdin.pipe(process.stdout);
`,
    'utf8',
  );
  const node = process.execPath.replaceAll('\\', '/');
  const s = script.replaceAll('\\', '/');
  execFileSync('git', ['-C', repo, 'config', 'filter.evil.clean', `"${node}" "${s}" clean`]);
  execFileSync('git', ['-C', repo, 'config', 'filter.evil.smudge', `"${node}" "${s}" smudge`]);
  execFileSync('git', ['-C', repo, 'config', 'filter.evil.required', 'true']);
  return { cleanMarker, smudgeMarker };
}

describe('content filter (clean/smudge/process) suppression', () => {
  it('malicious clean and smudge filters never execute during checkout, staging, snapshot, diff or checkpoint', async () => {
    process.env.CHUBZ_FILTER_SECRET = 'filter-must-never-see-this-1234567890';
    try {
      const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chubz-filters-'));
      cleanups.push(markerDir);
      // repo whose .gitattributes routes EVERY file through the evil driver
      const repo = makeTempGitRepo({
        'README.md': '# r\n',
        '.gitattributes': '* filter=evil\n',
        'data.txt': 'original\n',
      });
      cleanups.push(repo);
      const { cleanMarker, smudgeMarker } = installEvilFilters(repo, markerDir);
      resetFilterDriverCache();

      // control: a RAW git call honouring config runs the filter → proves the
      // driver is genuinely wired up in this repo
      const controlWt = fs.mkdtempSync(path.join(os.tmpdir(), 'chubz-ctl-'));
      fs.rmSync(controlWt, { recursive: true, force: true });
      let controlRan = false;
      try {
        execFileSync('git', ['-C', repo, 'worktree', 'add', '-b', 'cc/control', controlWt, head(repo)], {
          stdio: ['ignore', 'ignore', 'ignore'],
        });
        controlRan = fs.existsSync(smudgeMarker) || fs.existsSync(cleanMarker);
      } catch {
        controlRan = fs.existsSync(smudgeMarker) || fs.existsSync(cleanMarker);
      }
      cleanups.push(controlWt);
      for (const m of [cleanMarker, smudgeMarker]) if (fs.existsSync(m)) fs.rmSync(m);

      // ── the app's hardened path: worktree creation/checkout ──
      const { wt, base } = await makeWorktree(repo);
      expect(fs.existsSync(smudgeMarker), 'smudge ran during checkout').toBe(false);

      // ── staging / snapshot ──
      fs.writeFileSync(path.join(wt, 'data.txt'), 'worker edit\n');
      fs.writeFileSync(path.join(wt, 'new.txt'), 'added by worker\n');
      await stageAll(wt);
      expect(fs.existsSync(cleanMarker), 'clean ran during staging').toBe(false);
      await writeTreeSnapshot(wt);
      expect(fs.existsSync(cleanMarker), 'clean ran during snapshot').toBe(false);
      await statusPorcelain(wt);

      // ── diff / evidence ──
      const diff = await diffUnified(wt, base);
      expect(diff).toContain('data.txt');
      expect(fs.existsSync(cleanMarker), 'clean ran during diff').toBe(false);

      // ── checkpoint creation ──
      const hash = await commitCheckpoint(wt, 'checkpoint with hostile filters configured');
      expect(hash).toMatch(/^[0-9a-f]{40}$/);
      expect(fs.existsSync(cleanMarker), 'clean ran during checkpoint').toBe(false);
      expect(fs.existsSync(smudgeMarker), 'smudge ran during checkpoint').toBe(false);

      // the filter never ran at all, so it never read the injected secret
      for (const m of [cleanMarker, smudgeMarker]) {
        if (fs.existsSync(m)) {
          expect(fs.readFileSync(m, 'utf8')).not.toContain('filter-must-never-see-this');
        }
      }
      // sanity: the driver WAS active (control proved it) → suppression, not luck
      expect(controlRan, 'control should have run the filter').toBe(true);
    } finally {
      delete process.env.CHUBZ_FILTER_SECRET;
    }
  });

  it('a required filter driver cannot fail app git operations', async () => {
    // filter.<n>.required=true would normally abort the operation when the
    // driver is missing/neutralised; we force required=false on every call
    const repo = makeTempGitRepo({ 'README.md': '# r\n', '.gitattributes': '* filter=ghost\n' });
    cleanups.push(repo);
    execFileSync('git', ['-C', repo, 'config', 'filter.ghost.clean', 'definitely-not-a-real-command-xyz']);
    execFileSync('git', ['-C', repo, 'config', 'filter.ghost.required', 'true']);
    resetFilterDriverCache();

    const { wt, base } = await makeWorktree(repo);
    fs.writeFileSync(path.join(wt, 'work.txt'), 'delivered\n');
    await stageAll(wt);
    const hash = await commitCheckpoint(wt, 'checkpoint despite a required-but-broken filter');
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
    expect(await diffUnified(wt, base)).toContain('work.txt');
  });
});

describe('hooks directory tampering', () => {
  it('uses a private, non-existent hooks path that cannot be pre-populated', () => {
    const p = privateHooksPath();
    expect(path.isAbsolute(p)).toBe(true);
    // unguessable name, and deliberately never created
    expect(path.basename(p)).toMatch(/^chubz-cc-nohooks-[0-9a-f]{32}$/);
    expect(fs.existsSync(p)).toBe(false);
  });

  it('a hook inserted into the hooks path AFTER setup is never executed by a checkpoint', async () => {
    const repo = makeTempGitRepo({ 'README.md': '# r\n' });
    cleanups.push(repo);
    const { wt } = await makeWorktree(repo);

    // an attacker discovers the current hooks path and populates it
    const hooksPath = privateHooksPath();
    fs.mkdirSync(hooksPath, { recursive: true });
    cleanups.push(hooksPath);
    const marker = path.join(wt, 'INSERTED_HOOK_RAN.txt');
    const hook = path.join(hooksPath, 'pre-commit');
    fs.writeFileSync(hook, `#!/bin/sh\ntouch "${marker.replaceAll('\\', '/')}"\nexit 1\n`);
    fs.chmodSync(hook, 0o755);

    // the next consequential git operation re-verifies suppression: because the
    // path now exists, it rotates to a fresh private path
    fs.writeFileSync(path.join(wt, 'work.txt'), 'delivered\n');
    const hash = await commitCheckpoint(wt, 'checkpoint after hooks-dir tampering');

    expect(hash).toMatch(/^[0-9a-f]{40}$/); // the exit-1 hook did not block it
    expect(fs.existsSync(marker), 'inserted hook executed').toBe(false);
    const rotated = privateHooksPath();
    expect(rotated).not.toBe(hooksPath);
    expect(fs.existsSync(rotated)).toBe(false);
  });
});
