import fs from 'node:fs';
import path from 'node:path';
import { branchOfWorktree, commitExists, isWorktreeRegistered } from '../git/git';

/**
 * Git/worktree integrity verification (P1).
 *
 * Diff-based path checks can only see what `git diff` reports — they cannot
 * protect `.git` itself, detect a re-pointed worktree, or notice symlink
 * escapes. These checks close those gaps explicitly:
 *  - the worktree is still on its attempt branch;
 *  - the `.git` gitdir link file is intact and unchanged;
 *  - the worktree is still registered with the main repository;
 *  - the base commit still exists in the object store;
 *  - no symlink/junction/reparse point inside the worktree resolves outside it.
 */

export interface IntegrityIssue {
  check: 'worktree_exists' | 'branch' | 'git_link' | 'registration' | 'base_commit';
  detail: string;
}

/** read the worktree's `.git` link file content ('' when unreadable) */
export function readGitLinkFile(worktreePath: string): string {
  try {
    const p = path.join(worktreePath, '.git');
    if (!fs.lstatSync(p).isFile()) return '';
    return fs.readFileSync(p, 'utf8').trim();
  } catch {
    return '';
  }
}

export async function verifyWorktreeIntegrity(opts: {
  repo: string;
  worktreePath: string;
  expectedBranch: string;
  baseCommit: string;
  /** `.git` link content recorded right after worktree creation */
  expectedGitLink?: string | null;
}): Promise<IntegrityIssue[]> {
  const issues: IntegrityIssue[] = [];
  if (!fs.existsSync(opts.worktreePath)) {
    return [{ check: 'worktree_exists', detail: 'worktree directory is missing' }];
  }

  const branch = await branchOfWorktree(opts.worktreePath);
  if (branch !== opts.expectedBranch) {
    issues.push({ check: 'branch', detail: `worktree is on "${branch ?? 'unknown'}" — expected "${opts.expectedBranch}"` });
  }

  const gitLink = readGitLinkFile(opts.worktreePath);
  if (!/^gitdir:\s*\S/.test(gitLink)) {
    issues.push({ check: 'git_link', detail: '.git is not an intact gitdir link file' });
  } else if (opts.expectedGitLink != null && opts.expectedGitLink !== '' && gitLink !== opts.expectedGitLink.trim()) {
    issues.push({ check: 'git_link', detail: '.git gitdir link content changed during the attempt' });
  }

  if (!(await isWorktreeRegistered(opts.repo, opts.worktreePath))) {
    issues.push({ check: 'registration', detail: 'worktree is no longer registered with the repository' });
  }

  if (!(await commitExists(opts.repo, opts.baseCommit))) {
    issues.push({ check: 'base_commit', detail: `base commit ${opts.baseCommit.slice(0, 10)} is missing from the object store` });
  }

  return issues;
}

/**
 * Find symlinks / junctions / reparse points inside the worktree whose target
 * resolves OUTSIDE the worktree (P1). Such links would let diff-scoped checks
 * miss reads/writes escaping the sandboxed tree. Comparison is
 * case-insensitive on Windows.
 */
export function findSymlinkEscapes(worktreePath: string, maxEntries = 20_000): string[] {
  const escapes: string[] = [];
  let rootReal: string;
  try {
    rootReal = fs.realpathSync.native(worktreePath);
  } catch {
    return escapes;
  }
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const rel = (full: string) => path.relative(rootReal, full).replaceAll('\\', '/');
  let seen = 0;

  const walk = (dir: string): void => {
    if (seen > maxEntries) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (++seen > maxEntries) return;
      const full = path.join(dir, entry.name);
      if (entry.name === '.git' && norm(dir) === norm(rootReal)) continue;
      let isLink = entry.isSymbolicLink();
      if (!isLink) {
        // junctions can surface as plain directories depending on Node version
        try {
          isLink = fs.lstatSync(full).isSymbolicLink();
        } catch {
          continue;
        }
      }
      if (isLink) {
        try {
          const target = fs.realpathSync.native(full);
          const inside = norm(target) === norm(rootReal) || norm(target).startsWith(norm(rootReal + path.sep));
          if (!inside) escapes.push(rel(full));
        } catch {
          escapes.push(`${rel(full)} (unresolvable link)`);
        }
        continue; // never descend through links
      }
      if (entry.isDirectory()) walk(full);
    }
  };

  walk(rootReal);
  return escapes;
}
