import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { branchOfWorktree, commitExists, headCommit, isWorktreeRegistered, runGit } from '../git/git';

/**
 * Git/worktree integrity verification (P1 + git-integrity hardening).
 *
 * Diff-based path checks can only see what `git diff` reports — they cannot
 * protect `.git` itself, detect a re-pointed worktree, notice symlink escapes,
 * or catch a worker that quietly commits, switches branches, or rewrites refs,
 * tags, or local config. These checks close those gaps explicitly by capturing
 * a baseline before the worker runs and re-verifying it afterwards.
 */

export interface IntegrityIssue {
  check:
    | 'worktree_exists'
    | 'branch'
    | 'git_link'
    | 'registration'
    | 'base_commit'
    | 'head_moved'
    | 'refs_changed'
    | 'tags_changed'
    | 'config_changed'
    | 'baseline_scan';
  detail: string;
}

/**
 * Immutable snapshot of everything that must NOT change while a worker runs:
 * the worktree's HEAD + branch + gitlink, and the main repo's refs, tags and
 * local config. Captured right after worktree creation, before worker launch.
 */
export interface GitBaseline {
  headCommit: string | null;
  branch: string | null;
  gitLink: string;
  /** sha256 of `for-each-ref` over all refs EXCEPT the attempt branch */
  refsHash: string;
  /** sha256 of `for-each-ref refs/tags` */
  tagsHash: string;
  /** sha256 of `git config --local --list` on the main repo */
  configHash: string;
  registered: boolean;
}

function sha(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
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

/** all refs in the main repo except the attempt branch, hashed for comparison */
async function refsHashExcluding(repo: string, attemptBranch: string): Promise<string> {
  const r = await runGit(['for-each-ref', '--format=%(objectname) %(refname)'], repo);
  const lines = r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !l.endsWith(` refs/heads/${attemptBranch}`))
    .sort();
  return sha(lines.join('\n'));
}

async function tagsHash(repo: string): Promise<string> {
  const r = await runGit(['for-each-ref', '--format=%(objectname) %(refname)', 'refs/tags'], repo);
  const lines = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean).sort();
  return sha(lines.join('\n'));
}

async function configHash(repo: string): Promise<string> {
  const r = await runGit(['config', '--local', '--list'], repo);
  const lines = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean).sort();
  return sha(lines.join('\n'));
}

/** capture the pre-execution baseline (call once, right after worktree add) */
export async function captureGitBaseline(opts: {
  repo: string;
  worktreePath: string;
  attemptBranch: string;
}): Promise<GitBaseline> {
  return {
    headCommit: await headCommit(opts.worktreePath),
    branch: await branchOfWorktree(opts.worktreePath),
    gitLink: readGitLinkFile(opts.worktreePath),
    refsHash: await refsHashExcluding(opts.repo, opts.attemptBranch),
    tagsHash: await tagsHash(opts.repo),
    configHash: await configHash(opts.repo),
    registered: await isWorktreeRegistered(opts.repo, opts.worktreePath),
  };
}

export async function verifyWorktreeIntegrity(opts: {
  repo: string;
  worktreePath: string;
  expectedBranch: string;
  baseCommit: string;
  /** baseline captured before the worker ran (enables ref/tag/config checks) */
  baseline?: GitBaseline;
  /**
   * When true, the worktree HEAD must still equal the approved base commit —
   * i.e. the worker must NOT have created any commit. Used pre-checkpoint.
   */
  requireHeadAtBase?: boolean;
}): Promise<IntegrityIssue[]> {
  const issues: IntegrityIssue[] = [];
  if (!fs.existsSync(opts.worktreePath)) {
    return [{ check: 'worktree_exists', detail: 'worktree directory is missing' }];
  }

  const branch = await branchOfWorktree(opts.worktreePath);
  if (branch !== opts.expectedBranch) {
    issues.push({ check: 'branch', detail: `worktree is on "${branch ?? 'unknown'}" — expected "${opts.expectedBranch}" (branch switch is not allowed)` });
  }

  const head = await headCommit(opts.worktreePath);
  if (opts.requireHeadAtBase && head !== opts.baseCommit) {
    issues.push({ check: 'head_moved', detail: `worktree HEAD ${head?.slice(0, 10) ?? 'unknown'} moved off the approved base commit ${opts.baseCommit.slice(0, 10)} — the worker must not create commits` });
  }

  const gitLink = readGitLinkFile(opts.worktreePath);
  if (!/^gitdir:\s*\S/.test(gitLink)) {
    issues.push({ check: 'git_link', detail: '.git is not an intact gitdir link file' });
  } else if (opts.baseline && opts.baseline.gitLink && gitLink !== opts.baseline.gitLink) {
    issues.push({ check: 'git_link', detail: '.git gitdir link content changed during the attempt' });
  }

  if (!(await isWorktreeRegistered(opts.repo, opts.worktreePath))) {
    issues.push({ check: 'registration', detail: 'worktree is no longer registered with the repository' });
  }

  if (!(await commitExists(opts.repo, opts.baseCommit))) {
    issues.push({ check: 'base_commit', detail: `base commit ${opts.baseCommit.slice(0, 10)} is missing from the object store` });
  }

  if (opts.baseline) {
    const [refs, tags, cfg] = await Promise.all([
      refsHashExcluding(opts.repo, opts.expectedBranch),
      tagsHash(opts.repo),
      configHash(opts.repo),
    ]);
    if (refs !== opts.baseline.refsHash) {
      issues.push({ check: 'refs_changed', detail: 'repository refs (branches) changed during the attempt' });
    }
    if (tags !== opts.baseline.tagsHash) {
      issues.push({ check: 'tags_changed', detail: 'repository tags changed during the attempt' });
    }
    if (cfg !== opts.baseline.configHash) {
      issues.push({ check: 'config_changed', detail: 'local git config changed during the attempt' });
    }
  }

  return issues;
}

/**
 * Symlink / junction / reparse-point scan (P1, FAIL-CLOSED). Returns paths of
 * links inside the worktree whose target resolves OUTSIDE it. On ANY scan
 * error (unreadable directory, unresolvable link) or if the entry limit is
 * reached, a sentinel entry is returned so callers — which treat a non-empty
 * result as a failure — fail closed rather than trusting an incomplete scan.
 */
export function findSymlinkEscapes(worktreePath: string, maxEntries = 20_000): string[] {
  const escapes: string[] = [];
  let rootReal: string;
  try {
    rootReal = fs.realpathSync.native(worktreePath);
  } catch (err) {
    return [`<scan error: cannot resolve worktree root: ${(err as Error).message}>`];
  }
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const rel = (full: string) => path.relative(rootReal, full).replaceAll('\\', '/');
  let seen = 0;
  let truncated = false;

  const walk = (dir: string): void => {
    if (seen > maxEntries) {
      truncated = true;
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      // fail closed: an unreadable directory could hide an escaping link
      escapes.push(`<scan error at ${rel(dir) || '.'}: ${(err as Error).message}>`);
      return;
    }
    for (const entry of entries) {
      if (++seen > maxEntries) {
        truncated = true;
        return;
      }
      const full = path.join(dir, entry.name);
      if (entry.name === '.git' && norm(dir) === norm(rootReal)) continue;
      let isLink = entry.isSymbolicLink();
      if (!isLink) {
        // junctions can surface as plain directories depending on Node version
        try {
          isLink = fs.lstatSync(full).isSymbolicLink();
        } catch (err) {
          escapes.push(`<scan error at ${rel(full)}: ${(err as Error).message}>`);
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
  if (truncated) escapes.push(`<scan incomplete: exceeded ${maxEntries} entries>`);
  return escapes;
}
