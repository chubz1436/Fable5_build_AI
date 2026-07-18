import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  commitCheckpoint,
  diffUnified,
  worktreeAdd,
} from '../src/git/git';
import { captureGitBaseline, findSymlinkEscapes, verifyWorktreeIntegrity } from '../src/attempts/integrity';
import { makeTempGitRepo } from './helpers';

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function head(dir: string): string {
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

/** create an attempt worktree for `repo` at HEAD and return its path + branch */
async function makeWorktree(repo: string): Promise<{ wt: string; branch: string; base: string }> {
  const base = head(repo);
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'chubz-wt-'));
  fs.rmSync(wt, { recursive: true, force: true }); // git wants a non-existent path
  const branch = `cc/test-${Date.now().toString(36)}`;
  await worktreeAdd(repo, wt, branch, base);
  cleanups.push(wt);
  return { wt, branch, base };
}

describe('git hook suppression (controlled empty hooksPath)', () => {
  it('a blocking pre-commit hook does NOT run during app checkpoint commits', async () => {
    const repo = makeTempGitRepo({ 'README.md': '# r\n' });
    cleanups.push(repo);
    // a hook that would abort EVERY commit if it ran
    const hooksDir = path.join(repo, '.git', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    const hook = path.join(hooksDir, 'pre-commit');
    fs.writeFileSync(hook, '#!/bin/sh\ntouch "$(git rev-parse --show-toplevel)/HOOK_RAN.txt"\nexit 1\n');
    fs.chmodSync(hook, 0o755);

    // control: a raw commit honoring the hook is blocked → proves the hook is
    // active on this platform (it also touches HOOK_RAN before exiting 1)
    const { wt } = await makeWorktree(repo);
    const sentinel = path.join(wt, 'HOOK_RAN.txt');
    fs.writeFileSync(path.join(wt, 'control.txt'), 'x\n');
    execFileSync('git', ['-C', wt, 'add', '-A']);
    let rawBlocked = false;
    try {
      execFileSync('git', ['-C', wt, 'commit', '-m', 'raw'], { stdio: ['ignore', 'ignore', 'ignore'] });
    } catch {
      rawBlocked = true;
    }
    const hookActive = rawBlocked || fs.existsSync(sentinel);
    if (fs.existsSync(sentinel)) fs.rmSync(sentinel); // clear the control's mark

    // the app's hardened checkpoint runs with an empty hooksPath → succeeds and
    // never runs the hook (no fresh HOOK_RAN.txt)
    fs.writeFileSync(path.join(wt, 'work.txt'), 'delivered\n');
    const hash = await commitCheckpoint(wt, 'checkpoint despite blocking hook');
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
    expect(fs.existsSync(sentinel)).toBe(false);
    // sanity: the hook WAS active (control proved it), so the checkpoint
    // succeeding with no sentinel proves suppression, not a skipped hook.
    expect(hookActive).toBe(true);
  });
});

describe('external diff / textconv suppression', () => {
  it('a configured external diff driver is never executed by app git operations', async () => {
    const repo = makeTempGitRepo({ 'README.md': '# r\n', 'a.txt': 'one\n' });
    cleanups.push(repo);
    const { wt, base } = await makeWorktree(repo);

    // install a malicious external diff driver into the worktree's local config
    const marker = path.join(wt, 'EXTDIFF_RAN.txt');
    const driver = path.join(wt, 'driver.sh');
    fs.writeFileSync(driver, `#!/bin/sh\ntouch "${marker.replaceAll('\\', '/')}"\n`);
    fs.chmodSync(driver, 0o755);
    execFileSync('git', ['-C', wt, 'config', 'diff.external', `sh ${driver.replaceAll('\\', '/')}`]);

    // change a file so there is something to diff
    fs.writeFileSync(path.join(wt, 'a.txt'), 'two\n');
    execFileSync('git', ['-C', wt, 'add', '-A']);

    // control: a raw diff honoring config runs the driver
    let rawRan = false;
    try {
      execFileSync('git', ['-C', wt, 'diff', base], { stdio: ['ignore', 'ignore', 'ignore'] });
      rawRan = fs.existsSync(marker);
    } catch {
      rawRan = fs.existsSync(marker);
    }
    if (fs.existsSync(marker)) fs.rmSync(marker);

    // the app's hardened diff forces `diff.external=` + `--no-ext-diff` → no run
    const out = await diffUnified(wt, base);
    expect(out).toContain('a.txt');
    expect(fs.existsSync(marker)).toBe(false);
    if (rawRan) expect(fs.existsSync(marker)).toBe(false); // suppression, not luck
  });
});

describe('git integrity tampering detection', () => {
  it('captures a baseline and flags worker-created commits, branch switches, tags, ref and config changes', async () => {
    const repo = makeTempGitRepo({ 'README.md': '# r\n' });
    cleanups.push(repo);
    const { wt, branch, base } = await makeWorktree(repo);
    const baseline = await captureGitBaseline({ repo, worktreePath: wt, attemptBranch: branch });

    // clean baseline → no issues, HEAD at base
    expect(await verifyWorktreeIntegrity({ repo, worktreePath: wt, expectedBranch: branch, baseCommit: base, baseline, requireHeadAtBase: true })).toEqual([]);

    // 1) worker creates a commit on the attempt branch → HEAD moves off base
    fs.writeFileSync(path.join(wt, 'sneaky.txt'), 'x\n');
    execFileSync('git', ['-C', wt, 'add', '-A']);
    execFileSync('git', ['-C', wt, 'commit', '-m', 'sneaky', '--no-verify', '--no-gpg-sign']);
    let issues = await verifyWorktreeIntegrity({ repo, worktreePath: wt, expectedBranch: branch, baseCommit: base, baseline, requireHeadAtBase: true });
    expect(issues.some((i) => i.check === 'head_moved')).toBe(true);

    // 2) a new tag in the main repo → tags_changed
    execFileSync('git', ['-C', repo, 'tag', 'v9.9.9']);
    issues = await verifyWorktreeIntegrity({ repo, worktreePath: wt, expectedBranch: branch, baseCommit: base, baseline });
    expect(issues.some((i) => i.check === 'tags_changed')).toBe(true);

    // 3) a new branch (ref) in the main repo → refs_changed
    execFileSync('git', ['-C', repo, 'branch', 'rogue', base]);
    issues = await verifyWorktreeIntegrity({ repo, worktreePath: wt, expectedBranch: branch, baseCommit: base, baseline });
    expect(issues.some((i) => i.check === 'refs_changed')).toBe(true);

    // 4) a local config change → config_changed
    execFileSync('git', ['-C', repo, 'config', 'chubz.injected', 'yes']);
    issues = await verifyWorktreeIntegrity({ repo, worktreePath: wt, expectedBranch: branch, baseCommit: base, baseline });
    expect(issues.some((i) => i.check === 'config_changed')).toBe(true);
  });

  it('flags a branch switch inside the worktree', async () => {
    const repo = makeTempGitRepo({ 'README.md': '# r\n' });
    cleanups.push(repo);
    const { wt, branch, base } = await makeWorktree(repo);
    const baseline = await captureGitBaseline({ repo, worktreePath: wt, attemptBranch: branch });
    execFileSync('git', ['-C', wt, 'checkout', '-b', 'cc/switched']);
    const issues = await verifyWorktreeIntegrity({ repo, worktreePath: wt, expectedBranch: branch, baseCommit: base, baseline });
    expect(issues.some((i) => i.check === 'branch')).toBe(true);
  });
});

describe('symlink / junction escape scan (fail-closed)', () => {
  it('flags a link whose target is outside the worktree, and never touches that target', async () => {
    const repo = makeTempGitRepo({ 'README.md': '# r\n' });
    cleanups.push(repo);
    const { wt } = await makeWorktree(repo);

    // an external directory with a sensitive file, OUTSIDE the worktree
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'chubz-external-'));
    cleanups.push(external);
    const secretFile = path.join(external, 'secret.txt');
    fs.writeFileSync(secretFile, 'DO NOT TOUCH\n');
    const before = fs.readFileSync(secretFile, 'utf8');

    // a junction inside the worktree pointing at the external dir (junctions
    // do not require elevation on Windows)
    const linkPath = path.join(wt, 'escape');
    try {
      fs.symlinkSync(external, linkPath, 'junction');
    } catch {
      fs.symlinkSync(external, linkPath, 'dir');
    }

    const escapes = findSymlinkEscapes(wt);
    expect(escapes.some((e) => e.startsWith('escape'))).toBe(true);
    // the scan resolves but never writes through the link
    expect(fs.readFileSync(secretFile, 'utf8')).toBe(before);
  });

  it('fails closed when the entry limit is exceeded', async () => {
    const repo = makeTempGitRepo({ 'README.md': '# r\n' });
    cleanups.push(repo);
    const { wt } = await makeWorktree(repo);
    for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(wt, `f${i}.txt`), 'x\n');
    const escapes = findSymlinkEscapes(wt, 3); // tiny limit forces truncation
    expect(escapes.some((e) => e.includes('scan incomplete'))).toBe(true);
  });

  it('returns nothing for a clean worktree with only internal files', async () => {
    const repo = makeTempGitRepo({ 'README.md': '# r\n', 'src/a.txt': 'x\n' });
    cleanups.push(repo);
    const { wt } = await makeWorktree(repo);
    expect(findSymlinkEscapes(wt)).toEqual([]);
  });
});
