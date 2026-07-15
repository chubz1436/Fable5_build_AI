import type { Task, TaskStatus } from '../../../shared/types';
import { TaskCard } from '../components/TaskCard';
import { useStore } from '../lib/store';

/** Kanban lanes: several statuses share a lane to keep the board readable. */
const LANES: Array<{ title: string; statuses: TaskStatus[] }> = [
  { title: 'Backlog', statuses: ['backlog'] },
  { title: 'Ready', statuses: ['ready'] },
  { title: 'Awaiting Approval', statuses: ['awaiting_approval'] },
  { title: 'Running', statuses: ['running', 'verifying', 'paused'] },
  { title: 'Blocked', statuses: ['blocked'] },
  { title: 'Review', statuses: ['review'] },
  { title: 'Done', statuses: ['completed', 'cancelled', 'failed'] },
];

function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority.localeCompare(b.priority);
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

export function Board({ onNewTask }: { onNewTask: () => void }) {
  const { tasks } = useStore();
  return (
    <>
      <div className="topbar">
        <h1>Task board</h1>
        <span className="spacer" />
        <button className="btn primary" onClick={onNewTask}>＋ New task</button>
      </div>
      <div className="board">
        {LANES.map((lane) => {
          const laneTasks = sortTasks(tasks.filter((t) => lane.statuses.includes(t.status)));
          return (
            <div className="board-col" key={lane.title}>
              <div className="board-col-head">
                <span>{lane.title}</span>
                <span className="count-pill">{laneTasks.length}</span>
              </div>
              {laneTasks.map((t) => (
                <TaskCard
                  task={t}
                  key={t.id}
                  showStatus={lane.statuses.length > 1}
                />
              ))}
              {laneTasks.length === 0 && <span className="small faint" style={{ padding: 6 }}>—</span>}
            </div>
          );
        })}
      </div>
    </>
  );
}
