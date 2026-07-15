import { useEffect, useRef } from 'react';
import type { EventRecord } from '../../../shared/types';
import { clock, timeAgo } from '../lib/format';
import { EmptyState } from './bits';

/**
 * Human-readable milestone timeline. Expects events OLDEST-FIRST (arrival
 * order); renders newest at the top. Raw log lines live in LogConsole.
 */
export function Timeline({ events, limit }: { events: EventRecord[]; limit?: number }) {
  const milestones = events
    .filter((e) => e.type !== 'run.log' && e.type !== 'run.phase')
    .reverse();
  const shown = limit ? milestones.slice(0, limit) : milestones;
  if (shown.length === 0) return <EmptyState>No activity yet.</EmptyState>;
  return (
    <div className="timeline">
      {shown.map((e) => (
        <div className="tl-item" key={e.id}>
          <span className={`tl-dot ${e.level}`} />
          <div className="tl-body">
            <span className="tl-msg">{e.message}</span>
            <span className="tl-time" title={new Date(e.at).toLocaleString()}>
              {timeAgo(e.at)}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Monospace live console for worker output (run.log + run.phase events).
 * Expects events OLDEST-FIRST; reads top-down and follows the tail.
 */
export function LogConsole({ events }: { events: EventRecord[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const lines = events.filter((e) => e.type === 'run.log' || e.type === 'run.phase');

  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  if (lines.length === 0) {
    return <EmptyState>No worker output yet — logs stream here live during execution.</EmptyState>;
  }
  return (
    <div className="log-console" ref={ref}>
      {lines.map((e) => (
        <div className={`log-line ${e.level}`} key={e.id}>
          <span className="log-time">{clock(e.at)}</span>
          {e.type === 'run.phase' ? `── ${e.message} ──` : e.message}
        </div>
      ))}
    </div>
  );
}
