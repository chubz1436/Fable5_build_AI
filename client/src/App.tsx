import { useState } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { NewTaskModal } from './components/NewTaskModal';
import { useStore } from './lib/store';
import { Activity } from './views/Activity';
import { Approvals } from './views/Approvals';
import { Board } from './views/Board';
import { Dashboard } from './views/Dashboard';
import { TaskDetail } from './views/TaskDetail';
import { Workers } from './views/Workers';

export default function App() {
  const { approvals, connected, system } = useStore();
  const [showNewTask, setShowNewTask] = useState(false);
  const pendingCount = approvals.filter((a) => a.status === 'pending').length;

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
