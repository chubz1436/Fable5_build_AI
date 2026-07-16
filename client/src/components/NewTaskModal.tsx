import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Priority, RiskLevel, TaskDraft } from '../../../shared/types';
import { api } from '../lib/api';
import { useLookups, useStore } from '../lib/store';
import { Modal, WorkerChip } from './bits';

const EXAMPLE = 'Continue the next safe implementation batch for the Games Project.';

/**
 * Two-step intake: describe the goal in natural language → the system
 * structures it (risk, priority, tags, scope, criteria, recommended worker)
 * → owner can adjust → create.
 */
export function NewTaskModal({ onClose }: { onClose: () => void }) {
  const { projects } = useStore();
  const { workerById } = useLookups();
  const navigate = useNavigate();

  const [text, setText] = useState('');
  const [draft, setDraft] = useState<TaskDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const structure = async () => {
    setBusy(true);
    setError(null);
    try {
      setDraft(await api.parse(text));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const task = await api.createTask(draft);
      onClose();
      navigate(`/tasks/${task.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const recommended = draft ? workerById(draft.recommendation.workerId) : undefined;

  return (
    <Modal onClose={onClose}>
      <h2>New task</h2>

      {!draft && (
        <>
          <div className="field">
            <label htmlFor="goal">Describe the goal in plain language</label>
            <textarea
              id="goal"
              rows={4}
              placeholder={`e.g. “${EXAMPLE}”`}
              value={text}
              onChange={(e) => setText(e.target.value)}
              autoFocus
            />
          </div>
          <p className="small faint" style={{ margin: 0 }}>
            The Command Center will structure this into a task: project, risk, priority,
            scope, acceptance criteria and a recommended worker. You can adjust everything
            before creating it.
          </p>
          <div className="modal-actions">
            <button className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn sm ghost" onClick={() => setText(EXAMPLE)}>Use example</button>
            <button className="btn primary" disabled={busy || !text.trim()} onClick={structure}>
              {busy ? 'Structuring…' : 'Structure it →'}
            </button>
          </div>
        </>
      )}

      {draft && (
        <>
          <div className="draft-preview">
            <div className="field">
              <label>Title</label>
              <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            </div>
            <div className="field-row">
              <div className="field">
                <label>Project</label>
                <select
                  value={draft.projectId}
                  onChange={(e) => setDraft({ ...draft, projectId: e.target.value })}
                >
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.kind === 'git' ? `⛁ ${p.name} — repository (real execution)` : `${p.name} (simulated demo)`}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Risk</label>
                <select
                  value={draft.risk}
                  onChange={(e) => setDraft({ ...draft, risk: e.target.value as RiskLevel })}
                >
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                </select>
              </div>
              <div className="field">
                <label>Priority</label>
                <select
                  value={draft.priority}
                  onChange={(e) => setDraft({ ...draft, priority: e.target.value as Priority })}
                >
                  <option value="p0">P0 · Urgent</option>
                  <option value="p1">P1 · High</option>
                  <option value="p2">P2 · Normal</option>
                  <option value="p3">P3 · Low</option>
                </select>
              </div>
            </div>
            <div className="small muted">
              <b>Why this risk:</b> {draft.riskRationale}
            </div>
            <div className="tag-row">
              {draft.tags.map((t) => (
                <span className="badge b-accent" key={t}>{t}</span>
              ))}
              <span className="badge b-outline mono">{draft.scope.join(' · ')}</span>
            </div>
            <div className="field">
              <label>Acceptance criteria</label>
              <ul className="criteria">
                {draft.acceptanceCriteria.map((c, i) => (
                  <li key={i}><span className="crit-mark faint">○</span> {c}</li>
                ))}
              </ul>
            </div>
            {recommended && (
              <div className="banner info" style={{ marginTop: 4 }}>
                <WorkerChip workerId={recommended.id} />
                <span className="small">
                  recommended — {draft.recommendation.reasons.join(' · ')}
                </span>
              </div>
            )}
          </div>
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setDraft(null)}>← Edit goal</button>
            <button className="btn primary" disabled={busy} onClick={create}>
              {busy ? 'Creating…' : 'Create task'}
            </button>
          </div>
        </>
      )}

      {error && <span className="small" style={{ color: 'var(--danger)' }}>{error}</span>}
    </Modal>
  );
}
