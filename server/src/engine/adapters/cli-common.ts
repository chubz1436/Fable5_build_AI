import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { FileChange } from '../../../../shared/types';
import type { RunContext } from './types';

/**
 * Shared machinery for adapters that drive a real headless coding CLI
 * (Claude Code, Codex, …). The pieces here are provider-agnostic: workspace
 * snapshotting + real diffing, process tree-kill, the task brief, the final
 * self-report extractor, and CLI detection. Provider-specific stream parsing
 * lives in each adapter.
 */

/** Written into each workspace; excluded from evidence diffs. */
export const BRIEF_FILE = '_TASK_BRIEF.md';

// ---------------------------------------------------------------------------
// workspace snapshot + real diff
// ---------------------------------------------------------------------------

export type Snapshot = Map<string, string[]>; // relative path → lines

/** Content snapshot of every text file in the workspace (brief excluded). */
export function snapshotWorkspace(dir: string): Snapshot {
  const snap: Snapshot = new Map();
  if (!fs.existsSync(dir)) return snap;
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const rel = path.relative(dir, full).replaceAll('\\', '/');
      if (rel === BRIEF_FILE) continue;
      const stat = fs.statSync(full);
      if (stat.size > 512 * 1024) {
        snap.set(rel, [`<binary or large file: ${stat.size} bytes>`]);
        continue;
      }
      snap.set(rel, fs.readFileSync(full, 'utf8').split('\n'));
    }
  };
  walk(dir);
  return snap;
}

/** Real diff stats between two snapshots (multiset line comparison). */
export function diffSnapshots(before: Snapshot, after: Snapshot, actor = 'the worker'): FileChange[] {
  const changes: FileChange[] = [];
  for (const [rel, newLines] of after) {
    const oldLines = before.get(rel);
    if (!oldLines) {
      changes.push({
        path: rel,
        changeType: 'added',
        summary: `Created by ${actor} in the task workspace`,
        additions: newLines.length,
        deletions: 0,
      });
    } else {
      const common = multisetIntersection(oldLines, newLines);
      const additions = newLines.length - common;
      const deletions = oldLines.length - common;
      if (additions > 0 || deletions > 0) {
        changes.push({
          path: rel,
          changeType: 'modified',
          summary: `Modified by ${actor} in the task workspace`,
          additions,
          deletions,
        });
      }
    }
  }
  for (const [rel, oldLines] of before) {
    if (!after.has(rel)) {
      changes.push({
        path: rel,
        changeType: 'deleted',
        summary: `Deleted by ${actor} in the task workspace`,
        additions: 0,
        deletions: oldLines.length,
      });
    }
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

function multisetIntersection(a: string[], b: string[]): number {
  const counts = new Map<string, number>();
  for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
  let common = 0;
  for (const line of b) {
    const c = counts.get(line) ?? 0;
    if (c > 0) {
      common += 1;
      counts.set(line, c - 1);
    }
  }
  return common;
}

// ---------------------------------------------------------------------------
// final self-report (fenced json block in the CLI's last message)
// ---------------------------------------------------------------------------

export interface FinalReport {
  summary?: string;
  workPerformed?: string[];
  limitations?: string[];
  confidence?: number;
}

/** Pulls the last ```json … ``` block out of the CLI's final message. */
export function extractFinalReport(text: string): FinalReport | null {
  const matches = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  const last = matches[matches.length - 1]?.[1];
  if (!last) return null;
  try {
    const parsed = JSON.parse(last) as FinalReport;
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// task brief handed to the CLI as its prompt
// ---------------------------------------------------------------------------

/**
 * Builds the natural-language brief a real worker receives. `toolNote`
 * states the provider's execution boundary (e.g. file-tools-only vs
 * sandboxed shell) so the brief matches what the adapter actually allows.
 */
export function buildTaskBrief(ctx: RunContext, toolNote: string): string {
  const { task, worker, handoff, attempt } = ctx;
  const lines = [
    `You are ${worker.name}, an AI coding worker executing a task for the CHUBZ AI Command Center.`,
    '',
    `# Task: ${task.title}`,
    `GOAL: ${task.goal}`,
    `RISK LEVEL: ${task.risk} · PRIORITY: ${task.priority} · ATTEMPT: ${attempt}`,
    '',
    '## Acceptance criteria',
    ...task.acceptanceCriteria.map((c) => `- ${c.text}`),
  ];
  if (attempt > 1 && task.blockReason) {
    lines.push('', '## Retry note', `A previous attempt was blocked: ${task.blockReason}. Address this.`);
  }
  if (handoff) {
    lines.push(
      '',
      '## Handoff context (from the previous worker)',
      `State: ${handoff.context.currentState}`,
      `Completed: ${handoff.context.completedWork.join('; ') || 'nothing yet'}`,
      `Remaining: ${handoff.context.remainingWork.join('; ') || 'see goal'}`,
      `Next action: ${handoff.context.nextAction}`,
    );
  }
  lines.push(
    '',
    '## Rules',
    '- Work ONLY inside the current directory (an isolated task workspace).',
    '- Create or modify files to accomplish the goal. Keep the change minimal and focused.',
    `- ${toolNote}`,
    `- ${BRIEF_FILE} is this brief; do not edit it.`,
    '- End your final message with a fenced json block exactly like:',
    '```json',
    '{"summary": "one paragraph of what you did", "workPerformed": ["step 1", "step 2"], "limitations": ["anything not covered"], "confidence": 0.9}',
    '```',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// process helpers
// ---------------------------------------------------------------------------

export function killTree(proc: ChildProcess): void {
  if (proc.pid == null) return;
  if (process.platform === 'win32') {
    // kill the whole tree; a CLI shim spawns children
    spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
  } else {
    proc.kill('SIGTERM');
  }
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** first non-empty string found at any of `keys` on `obj` (arrays joined). */
export function pickString(obj: unknown, keys: string[]): string | null {
  if (obj == null || typeof obj !== 'object') return null;
  const rec = obj as Record<string, unknown>;
  for (const key of keys) {
    const v = rec[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (Array.isArray(v)) {
      const joined = v
        .map((p) => (typeof p === 'string' ? p : typeof (p as { text?: string })?.text === 'string' ? (p as { text: string }).text : ''))
        .filter(Boolean)
        .join(' ')
        .trim();
      if (joined) return joined;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// CLI detection (used at boot to upgrade the roster honestly)
// ---------------------------------------------------------------------------

/**
 * Probe `<command> --version`. Retries a few times so a transient spawn
 * failure (common with npm CLI shims under load) does not get misread as
 * "not installed" — which would wrongly downgrade a real worker.
 */
export async function detectCli(command: string, timeoutMs = 8000, attempts = 3): Promise<string | null> {
  for (let i = 0; i < attempts; i++) {
    const version = await probeVersion(command, timeoutMs);
    if (version) return version;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

function probeVersion(command: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: string | null) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    try {
      const proc = spawn(`${command} --version`, [], { shell: true, windowsHide: true });
      let out = '';
      const timer = setTimeout(() => {
        killTree(proc);
        done(null);
      }, timeoutMs);
      timer.unref?.();
      proc.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')));
      proc.on('error', () => {
        clearTimeout(timer);
        done(null);
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        done(code === 0 && out.trim() ? out.trim().split('\n')[0]! : null);
      });
    } catch {
      done(null);
    }
  });
}
