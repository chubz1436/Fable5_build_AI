import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';
import type {
  Approval,
  Attempt,
  EventRecord,
  Handoff,
  Project,
  StreamMessage,
  SystemStatus,
  Task,
  WorkerProfile,
} from '../../../shared/types';
import { api, AuthRequiredError } from './api';

const MAX_CLIENT_EVENTS = 600;

export interface AppState {
  loaded: boolean;
  connected: boolean;
  /** true when the local access token cookie is missing (401s) */
  authRequired: boolean;
  projects: Project[];
  tasks: Task[];
  workers: WorkerProfile[];
  approvals: Approval[];
  handoffs: Handoff[];
  attempts: Attempt[];
  /** newest first */
  events: EventRecord[];
  system: SystemStatus | null;
}

const initial: AppState = {
  loaded: false,
  connected: false,
  authRequired: false,
  projects: [],
  tasks: [],
  workers: [],
  approvals: [],
  handoffs: [],
  attempts: [],
  events: [],
  system: null,
};

type Action =
  | { type: 'bootstrap'; snapshot: Omit<AppState, 'loaded' | 'connected' | 'authRequired'> }
  | { type: 'connected'; connected: boolean }
  | { type: 'authRequired' }
  | { type: 'stream'; message: StreamMessage };

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'bootstrap':
      return { ...state, ...action.snapshot, loaded: true, authRequired: false };
    case 'connected':
      return { ...state, connected: action.connected };
    case 'authRequired':
      return { ...state, authRequired: true, loaded: true };
    case 'stream': {
      const m = action.message;
      switch (m.kind) {
        case 'task':
          return { ...state, tasks: upsert(state.tasks, m.task) };
        case 'worker':
          return { ...state, workers: upsert(state.workers, m.worker) };
        case 'approval':
          return { ...state, approvals: upsert(state.approvals, m.approval) };
        case 'handoff':
          return { ...state, handoffs: upsert(state.handoffs, m.handoff) };
        case 'attempt':
          return { ...state, attempts: upsert(state.attempts, m.attempt) };
        case 'event':
          return {
            ...state,
            events: [m.event, ...state.events].slice(0, MAX_CLIENT_EVENTS),
          };
        case 'hello':
          return { ...state, system: m.system };
        default:
          return state;
      }
    }
    default:
      return state;
  }
}

const StoreContext = createContext<AppState>(initial);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    let disposed = false;

    const bootstrap = async () => {
      try {
        const snap = await api.state();
        if (disposed) return;
        dispatch({
          type: 'bootstrap',
          snapshot: {
            projects: snap.projects,
            tasks: snap.tasks,
            workers: snap.workers,
            approvals: snap.approvals,
            handoffs: snap.handoffs,
            attempts: snap.attempts,
            events: snap.events,
            system: snap.system,
          },
        });
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          dispatch({ type: 'authRequired' });
          return;
        }
        // server not up yet; EventSource reconnect will trigger a retry
        setTimeout(bootstrap, 1500);
      }
    };

    const es = new EventSource('/api/stream');
    esRef.current = es;
    es.onopen = () => {
      dispatch({ type: 'connected', connected: true });
      // refetch on every (re)connect so nothing is missed while offline
      void bootstrap();
    };
    es.onerror = () => dispatch({ type: 'connected', connected: false });
    es.onmessage = (e) => {
      try {
        dispatch({ type: 'stream', message: JSON.parse(e.data) as StreamMessage });
      } catch {
        // ignore malformed frames
      }
    };

    return () => {
      disposed = true;
      es.close();
    };
  }, []);

  return <StoreContext.Provider value={state}>{children}</StoreContext.Provider>;
}

export function useStore(): AppState {
  return useContext(StoreContext);
}

/** convenience lookups */
export function useLookups() {
  const s = useStore();
  return useMemo(
    () => ({
      projectById: (id: string) => s.projects.find((p) => p.id === id),
      workerById: (id: string | null | undefined) =>
        id ? s.workers.find((w) => w.id === id) : undefined,
      taskById: (id: string) => s.tasks.find((t) => t.id === id),
    }),
    [s.projects, s.workers, s.tasks],
  );
}
