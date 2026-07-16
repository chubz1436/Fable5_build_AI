import { useState } from 'react';
import type { Project } from '../../../shared/types';
import { EmptyState } from '../components/bits';
import { api } from '../lib/api';
import { timeAgo } from '../lib/format';
import { useStore } from '../lib/store';

const HEALTH_TONE: Record<string, string> = {
  ok: 'b-success',
  dirty: 'b-warning',
  missing: 'b-danger',
  error: 'b-danger',
};

/**
 * Git project registry: register a local repository, see its health, and
 * configure how deliveries get independently validated.
 */
export function Projects() {
  const { projects } = useStore();
  const gitProjects = projects.filter((p) => p.kind === 'git');
  const samples = projects.filter((p) => p.kind !== 'git');

  const [name, setName] = useState('');
  const [repoRoot, setRepoRoot] = useState('');
  const [validation, setValidation] = useState('');
  const [protectedPaths, setProtectedPaths] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const register = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const validationCommands = validation
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line) => {
          const [label, ...argv] = line.split(/\s+/);
          return { name: label!.replace(/:$/, ''), argv, required: true };
        })
        .filter((c) => c.argv.length > 0);
      const project = await api.registerProject({
        name: name.trim(),
        repoRoot: repoRoot.trim(),
        validationCommands: validationCommands.length ? validationCommands : undefined,
        protectedPaths: protectedPaths
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean),
      });
      setNotice(`Registered “${project.name}” (${project.git?.baseBranch} @ ${project.git?.baseCommit.slice(0, 8)})`);
      setName('');
      setRepoRoot('');
      setValidation('');
      setProtectedPaths('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const act = (fn: () => Promise<unknown>) => async () => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="topbar">
        <h1>Projects</h1>
        <span className="spacer" />
        <span className="badge b-outline">attempts always run in isolated worktrees — never in your working tree</span>
      </div>

      {error && <div className="banner danger" style={{ marginBottom: 12 }}>{error}</div>}
      {notice && <div className="banner info" style={{ marginBottom: 12 }}>{notice}</div>}

      <div className="grid two-col">
        <div className="grid" style={{ gap: 14 }}>
          <div className="card">
            <h3>Register a local Git repository</h3>
            <div className="grid" style={{ gap: 10 }}>
              <div className="field">
                <label>Display name</label>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My Project" />
              </div>
              <div className="field">
                <label>Absolute repository path</label>
                <input value={repoRoot} onChange={(e) => setRepoRoot(e.target.value)} placeholder="C:\code\my-project" />
              </div>
              <div className="field">
                <label>Validation commands — one per line: <span className="mono">name cmd arg arg…</span> (no shell)</label>
                <textarea
                  rows={3}
                  value={validation}
                  onChange={(e) => setValidation(e.target.value)}
                  placeholder={'typecheck npx tsc --noEmit\ntests npm test'}
                />
              </div>
              <div className="field">
                <label>Protected paths (comma-separated, repo-relative)</label>
                <input value={protectedPaths} onChange={(e) => setProtectedPaths(e.target.value)} placeholder="secrets, .github" />
              </div>
              <div>
                <button className="btn primary" disabled={busy || !name.trim() || !repoRoot.trim()} onClick={register}>
                  Register repository
                </button>
              </div>
              <p className="small faint" style={{ margin: 0 }}>
                The path must be the root of a real Git repository. Registration records the base branch and
                current commit; every attempt gets its own branch + worktree and is never merged or pushed.
              </p>
            </div>
          </div>

          {gitProjects.length === 0 ? (
            <EmptyState>No repositories registered yet — register one to run real coding attempts.</EmptyState>
          ) : (
            gitProjects.map((p) => <GitProjectCard key={p.id} project={p} busy={busy} act={act} />)
          )}
        </div>

        <div className="card">
          <h3>Sample projects (simulation demo)</h3>
          <div className="row-list">
            {samples.map((p) => (
              <div className="row-item" key={p.id}>
                <span className="tc-project">
                  <span className="swatch" style={{ background: p.color }} />
                  {p.name}
                </span>
                <span className="spacer" style={{ flex: 1 }} />
                <span className="badge b-outline">simulated</span>
              </div>
            ))}
          </div>
          <p className="small faint">
            Tasks on sample projects run the local simulation engine (clearly labeled). Repository-backed
            execution only happens on registered git projects above.
          </p>
        </div>
      </div>
    </>
  );
}

function GitProjectCard({
  project,
  busy,
  act,
}: {
  project: Project;
  busy: boolean;
  act: (fn: () => Promise<unknown>) => () => Promise<void>;
}) {
  const g = project.git!;
  return (
    <div className="card">
      <div className="approval-head">
        <div>
          <div className="approval-title">{project.name}</div>
          <div className="small mono muted">{g.canonicalRoot}</div>
        </div>
        <div className="tc-meta">
          <span className={`badge dot ${HEALTH_TONE[g.health] ?? 'b-neutral'}`}>{g.health}</span>
          {!g.enabled && <span className="badge b-danger">disabled</span>}
        </div>
      </div>
      <dl className="kv" style={{ marginTop: 8 }}>
        <dt>Base</dt>
        <dd className="mono small">{g.baseBranch} @ {g.baseCommit.slice(0, 10)}</dd>
        <dt>Validation</dt>
        <dd className="small">
          {g.validationCommands.length
            ? g.validationCommands.map((c) => `${c.name} (${c.argv.join(' ')})`).join(' · ')
            : 'none — deliveries will be UNVERIFIED'}
        </dd>
        <dt>Protected</dt>
        <dd className="small mono">{g.protectedPaths.join(', ') || '—'}</dd>
        <dt>Checked</dt>
        <dd className="small">{g.lastVerifiedAt ? timeAgo(g.lastVerifiedAt) : 'never'}{g.healthDetail ? ` — ${g.healthDetail}` : ''}</dd>
      </dl>
      <div className="action-bar" style={{ marginTop: 10 }}>
        <button className="btn sm" disabled={busy} onClick={act(() => api.recheckProject(project.id))}>
          ↻ Recheck health
        </button>
        <button
          className={`btn sm ${g.enabled ? 'danger' : 'success'}`}
          disabled={busy}
          onClick={act(() => api.updateProject(project.id, { enabled: !g.enabled }))}
        >
          {g.enabled ? 'Disable' : 'Enable'}
        </button>
      </div>
    </div>
  );
}
