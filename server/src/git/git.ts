import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Safe git plumbing. Every call is `execFile('git', [...args])` — argument
 * arrays only, no shell, no string composition. Callers pass canonical
 * repository paths that were validated at registration time.
 */

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class GitError extends Error {
  readonly statusCode = 422;
  constructor(message: string, readonly result?: GitResult) {
    super(message);
  }
}

export function runGit(args: string[], cwd?: string, timeoutMs = 30_000): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const raw: unknown = err ? (err as NodeJS.ErrnoException & { code?: unknown }).code : 0;
        resolve({ code: typeof raw === 'number' ? raw : err ? 1 : 0, stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
  });
}

async function mustGit(args: string[], cwd: string, what: string): Promise<string> {
  const r = await runGit(args, cwd);
  if (r.code !== 0) {
    throw new GitError(`git ${what} failed: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`}`, r);
  }
  return r.stdout;
}

/** branch names we generate/accept: conservative allowlist, no leading dash */
export function isSafeBranchName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/.test(name) && !name.includes('..');
}

/** repo-relative paths coming back from git must stay relative and inside */
export function isSafeRelPath(rel: string): boolean {
  if (!rel || path.isAbsolute(rel)) return false;
  const norm = rel.replaceAll('\\', '/');
  return !norm.split('/').includes('..');
}

export async function gitTopLevel(dir: string): Promise<string | null> {
  const r = await runGit(['rev-parse', '--show-toplevel'], dir);
  if (r.code !== 0) return null;
  const top = r.stdout.trim();
  return top ? fs.realpathSync.native(top) : null;
}

export async function currentBranch(repo: string): Promise<string> {
  return (await mustGit(['rev-parse', '--abbrev-ref', 'HEAD'], repo, 'rev-parse HEAD')).trim();
}

export async function revParse(repo: string, ref: string): Promise<string> {
  return (await mustGit(['rev-parse', '--verify', `${ref}^{commit}`], repo, `rev-parse ${ref}`)).trim();
}

/** porcelain status of the repo/worktree ('' = clean) */
export async function statusPorcelain(repo: string): Promise<string> {
  return (await mustGit(['status', '--porcelain'], repo, 'status')).trimEnd();
}

export async function worktreeAdd(
  repo: string,
  worktreePath: string,
  branch: string,
  baseCommit: string,
): Promise<void> {
  if (!isSafeBranchName(branch)) throw new GitError(`Unsafe branch name: ${branch}`);
  if (!/^[0-9a-f]{7,40}$/i.test(baseCommit)) throw new GitError(`Unsafe base commit: ${baseCommit}`);
  await mustGit(['worktree', 'add', '-b', branch, worktreePath, baseCommit], repo, 'worktree add');
}

export async function worktreeRemove(repo: string, worktreePath: string): Promise<void> {
  await mustGit(['worktree', 'remove', '--force', worktreePath], repo, 'worktree remove');
}

export async function worktreeList(repo: string): Promise<string> {
  return await mustGit(['worktree', 'list', '--porcelain'], repo, 'worktree list');
}

export async function branchOfWorktree(worktree: string): Promise<string | null> {
  const r = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], worktree);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** stage everything in the ATTEMPT worktree so the diff includes new files */
export async function stageAll(worktree: string): Promise<void> {
  await mustGit(['add', '-A'], worktree, 'add -A');
}

export interface NumstatEntry {
  path: string;
  additions: number;
  deletions: number;
  changeType: 'added' | 'modified' | 'deleted';
}

/** real per-file change stats between baseCommit and the worktree content */
export async function diffNumstat(worktree: string, baseCommit: string): Promise<NumstatEntry[]> {
  const out = await mustGit(['diff', '--numstat', '--find-renames', baseCommit], worktree, 'diff --numstat');
  const status = await mustGit(['diff', '--name-status', '--find-renames', baseCommit], worktree, 'diff --name-status');
  const kind = new Map<string, string>();
  for (const line of status.split('\n')) {
    const m = line.trim().match(/^([A-Z])\S*\t(.+?)(\t(.+))?$/);
    if (m) kind.set(m[4] ?? m[2]!, m[1]!);
  }
  const entries: NumstatEntry[] = [];
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m) continue;
    const rel = m[3]!.replace(/^"|"$/g, '');
    if (!isSafeRelPath(rel)) continue;
    const k = kind.get(rel) ?? 'M';
    entries.push({
      path: rel,
      additions: m[1] === '-' ? 0 : Number(m[1]),
      deletions: m[2] === '-' ? 0 : Number(m[2]),
      changeType: k === 'A' ? 'added' : k === 'D' ? 'deleted' : 'modified',
    });
  }
  return entries;
}

/** unified diff (size-capped by the caller) */
export async function diffUnified(worktree: string, baseCommit: string): Promise<string> {
  return await mustGit(['diff', '--find-renames', baseCommit], worktree, 'diff');
}

export async function diffStat(worktree: string, baseCommit: string): Promise<string> {
  return (await mustGit(['diff', '--stat', baseCommit], worktree, 'diff --stat')).trimEnd();
}

/**
 * Content snapshot of the worktree (tracked + untracked-not-ignored files):
 * stages everything, then hashes the index into a tree object. Two identical
 * hashes prove byte-identical content; a mismatch pinpoints exactly what a
 * validation run mutated (P0-1). Gitignored files are invisible here — that
 * IS the explicit ignored-output configuration for build artifacts.
 */
export async function writeTreeSnapshot(worktree: string): Promise<string> {
  await stageAll(worktree);
  return (await mustGit(['write-tree'], worktree, 'write-tree')).trim();
}

/** repo-relative paths that differ between two tree snapshots */
export async function diffTreePaths(worktree: string, treeA: string, treeB: string): Promise<string[]> {
  if (!/^[0-9a-f]{7,64}$/i.test(treeA) || !/^[0-9a-f]{7,64}$/i.test(treeB)) {
    throw new GitError('Unsafe tree hash.');
  }
  const out = await mustGit(['diff-tree', '-r', '--name-only', treeA, treeB], worktree, 'diff-tree');
  return out.split('\n').map((l) => l.trim()).filter((l) => l && isSafeRelPath(l));
}

/**
 * App-generated checkpoint commit on the attempt branch (P0-2). The index is
 * already staged by the snapshot; identity is pinned so the commit never
 * depends on (or leaks) the owner's git config, and hooks/signing are
 * disabled because a checkpoint must never be blocked by repo-local hooks.
 * Returns the commit hash, or null when there is nothing to commit.
 */
export async function commitCheckpoint(worktree: string, message: string): Promise<string | null> {
  await stageAll(worktree);
  const staged = await runGit(['diff', '--cached', '--quiet'], worktree);
  if (staged.code === 0) return null; // nothing staged → nothing to preserve
  await mustGit(
    [
      '-c', 'user.name=CHUBZ Command Center',
      '-c', 'user.email=command-center@localhost',
      '-c', 'commit.gpgsign=false',
      'commit', '--no-verify', '-m', message,
    ],
    worktree,
    'commit (checkpoint)',
  );
  return (await mustGit(['rev-parse', 'HEAD'], worktree, 'rev-parse HEAD')).trim();
}

/** true when the object exists in the repository's object store */
export async function commitExists(repo: string, hash: string): Promise<boolean> {
  if (!/^[0-9a-f]{7,64}$/i.test(hash)) return false;
  const r = await runGit(['cat-file', '-e', `${hash}^{commit}`], repo);
  return r.code === 0;
}

export async function headCommit(worktree: string): Promise<string | null> {
  const r = await runGit(['rev-parse', 'HEAD'], worktree);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** true when `worktreePath` is a registered linked worktree of `repo` */
export async function isWorktreeRegistered(repo: string, worktreePath: string): Promise<boolean> {
  const out = await runGit(['worktree', 'list', '--porcelain'], repo);
  if (out.code !== 0) return false;
  const want = fs.existsSync(worktreePath) ? fs.realpathSync.native(worktreePath) : worktreePath;
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p).replaceAll('\\', '/');
  return out.stdout
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .some((l) => norm(l.slice('worktree '.length).trim()) === norm(want));
}
