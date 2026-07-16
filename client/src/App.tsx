import { useState } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { NewTaskModal } from './components/NewTaskModal';
import { useStore } from './lib/store';
import { Activity } from './views/Activity';
import { Approvals } from './views/Approvals';
import { Board } from './views/Board';
import { Dashboard } from './views/Dashboard';
import { Projects } from './views/Projects';
import { TaskDetail } from './views/TaskDetail';
import { Workers } from './views/Workers';

export default function App() {
  const { approvals, authRequired, connected, system } = useStore();
  const [showNewTask, setShowNewTask] = useState(false);
  const pendingCount = approvals.filter((a) => a.status === 'pending').length;

  if (authRequired) {
    return (
      <div className="modal-overlay" style={{ position: 'fixed' }}>
        <div className="modal" style={{ maxWidth: 480 }}>
          <h2>Sign in required</h2>
          <p className="small">
            This Command Center is protected by a local access token. Open the <b>sign-in link</b> printed
            in the server console (it looks like <span className="mono">http://127.0.0.1:4680/auth/&lt;token&gt;</span>),
            then reload this page.
          </p>
          <p className="small faint" style={{ margin: 0 }}>
            The token lives in <span className="mono">data/auth-token.txt</span> next to the database.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">⌘</div>
          <div>
            <div className="brand-name">CHUBZ</div>
            <div className="brand-sub">AI Command Center</div>
          </div>
        </div>

        <nav className="nav">
          <NavLink to="/" end>
            <span className="icon">◉</span> Overview
          </NavLink>
          <NavLink to="/board">
            <span className="icon">▦</span> Board
          </NavLink>
          <NavLink to="/projects">
            <span className="icon">⛁</span> Projects
          </NavLink>
          <NavLink to="/workers">
            <span className="icon">☰</span> Workers
          </NavLink>
          <NavLink to="/approvals">
            <span className="icon">✓</span> Approvals
            {pendingCount > 0 && <span className="nav-badge">{pendingCount}</span>}
          </NavLink>
          <NavLink to="/activity">
            <span className="icon">≋</span> Activity
          </NavLink>
        </nav>

        <div className="sys-panel">
          <div className="sys-row">
            <span>Link</span>
            <b>
              <span className={`conn-dot ${connected ? 'on' : 'off'}`} />{' '}
              {connected ? 'live' : 'reconnecting…'}
            </b>
          </div>
          <div className="sys-row">
            <span>Engine</span>
            <b>{system ? `${system.engine} ×${system.simSpeed}` : '—'}</b>
          </div>
          <div className="sys-row">
            <span>Owner</span>
            <b>Chubz</b>
          </div>
        </div>
      </aside>

      <main className="main">
        <Routes>
          <Route path="/" element={<Dashboard onNewTask={() => setShowNewTask(true)} />} />
          <Route path="/board" element={<Board onNewTask={() => setShowNewTask(true)} />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/tasks/:id" element={<TaskDetail />} />
          <Route path="/workers" element={<Workers />} />
          <Route path="/approvals" element={<Approvals />} />
          <Route path="/activity" element={<Activity />} />
        </Routes>
      </main>

      {showNewTask && <NewTaskModal onClose={() => setShowNewTask(false)} />}
    </div>
  );
}
