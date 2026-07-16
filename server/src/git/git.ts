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
