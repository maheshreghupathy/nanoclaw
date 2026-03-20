import { useEffect, useRef, useState } from 'react';
import {
  ActivityEvent,
  RegisteredGroup,
  ScheduledTask,
  Status,
  fetchActivity,
  fetchGroups,
  fetchStatus,
  fetchTasks,
  subscribeEvents,
} from './api';
import styles from './App.module.css';

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatUptime(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function eventColor(type: string): string {
  switch (type) {
    case 'pool': return '#58a6ff';
    case 'container': return '#3fb950';
    case 'agent': return '#d2a8ff';
    case 'message': return '#79c0ff';
    case 'task': return '#ffa657';
    case 'error': return '#f85149';
    case 'warn': return '#d29922';
    default: return '#8b949e';
  }
}

function eventIcon(type: string): string {
  switch (type) {
    case 'pool': return '⚡';
    case 'container': return '📦';
    case 'agent': return '🤖';
    case 'message': return '💬';
    case 'task': return '📋';
    case 'error': return '❌';
    case 'warn': return '⚠️';
    default: return '·';
  }
}

// ── Components ────────────────────────────────────────────────────────────────
function Header({ status }: { status: Status | null }) {
  return (
    <header className={styles.header}>
      <div className={styles.headerLeft}>
        <span className={styles.logo}>🤖 AndyClaw</span>
        <span className={styles.subtitle}>Control Room</span>
      </div>
      <div className={styles.headerRight}>
        {status ? (
          <>
            <span className={styles.pill} style={{ background: '#1a4731', color: '#3fb950' }}>
              ● Running
            </span>
            <span className={styles.stat}>⏱ {formatUptime(status.uptimeSeconds)}</span>
            <span className={styles.stat}>📦 {status.queueDepth} active</span>
            <span className={styles.stat}>⚡ {status.pool.size} pool bots</span>
          </>
        ) : (
          <span className={styles.pill} style={{ background: '#3d1f1f', color: '#f85149' }}>
            ○ Connecting…
          </span>
        )}
      </div>
    </header>
  );
}

function GroupsPanel({ groups }: { groups: Record<string, RegisteredGroup> | null }) {
  const entries = groups ? Object.entries(groups) : [];
  return (
    <section className={styles.panel}>
      <h2 className={styles.panelTitle}>Groups <span className={styles.badge}>{entries.length}</span></h2>
      {entries.length === 0 && <p className={styles.empty}>No groups registered</p>}
      {entries.map(([jid, g]) => (
        <div key={jid} className={styles.card}>
          <div className={styles.cardRow}>
            <span className={styles.cardName}>{g.name}</span>
            {g.isMain && <span className={styles.tag} style={{ background: '#1a4731', color: '#3fb950' }}>main</span>}
            {g.channel && <span className={styles.tag} style={{ background: '#1a2740', color: '#79c0ff' }}>{g.channel}</span>}
          </div>
          <div className={styles.cardMeta}>{jid}</div>
          <div className={styles.cardMeta}>📁 {g.folder}</div>
          <div className={styles.cardMeta}>trigger: {g.requiresTrigger ? g.trigger : 'always-on'}</div>
        </div>
      ))}
    </section>
  );
}

function TasksPanel({ tasks }: { tasks: ScheduledTask[] | null }) {
  return (
    <section className={styles.panel}>
      <h2 className={styles.panelTitle}>Scheduled Tasks <span className={styles.badge}>{tasks?.length ?? 0}</span></h2>
      {(!tasks || tasks.length === 0) && <p className={styles.empty}>No scheduled tasks</p>}
      {tasks?.map((t) => (
        <div key={t.id} className={styles.card}>
          <div className={styles.cardRow}>
            <span className={styles.cardName}>{t.group_folder}</span>
            <span className={styles.tag} style={{
              background: t.status === 'active' ? '#1a4731' : '#3d1f1f',
              color: t.status === 'active' ? '#3fb950' : '#f85149',
            }}>{t.status}</span>
            <span className={styles.tag} style={{ background: '#1a2740', color: '#79c0ff' }}>{t.schedule_type}</span>
          </div>
          <div className={styles.cardMeta}>{t.prompt.slice(0, 80)}{t.prompt.length > 80 ? '…' : ''}</div>
          {t.next_run && <div className={styles.cardMeta}>Next: {new Date(t.next_run).toLocaleTimeString()}</div>}
          {t.last_result && <div className={styles.cardMeta}>Last: {t.last_result.slice(0, 60)}…</div>}
        </div>
      ))}
    </section>
  );
}

function SwarmPanel({ status }: { status: Status | null }) {
  const assignments = status?.pool.assignments ?? [];
  return (
    <section className={styles.panel}>
      <h2 className={styles.panelTitle}>Swarm Pool <span className={styles.badge}>{status?.pool.size ?? 0} bots</span></h2>
      {assignments.length === 0 && <p className={styles.empty}>No active assignments</p>}
      {assignments.map((a) => (
        <div key={`${a.groupFolder}:${a.sender}`} className={styles.card}>
          <div className={styles.cardRow}>
            <span style={{ color: '#58a6ff' }}>⚡ Bot #{a.index + 1}</span>
            <span className={styles.tag} style={{ background: '#1a2740', color: '#d2a8ff' }}>{a.sender}</span>
          </div>
          <div className={styles.cardMeta}>📁 {a.groupFolder}</div>
        </div>
      ))}
    </section>
  );
}

function ActivityFeed({ events }: { events: ActivityEvent[] }) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events.length]);

  return (
    <section className={styles.feedPanel}>
      <h2 className={styles.panelTitle}>Live Activity <span className={styles.liveDot}>●</span></h2>
      <div className={styles.feed}>
        {events.length === 0 && <p className={styles.empty}>Waiting for events…</p>}
        {events.map((ev) => (
          <div key={ev.id} className={styles.feedRow}>
            <span className={styles.feedTime}>{ev.ts}</span>
            <span style={{ color: eventColor(ev.type), minWidth: '1.2em' }}>{eventIcon(ev.type)}</span>
            <span className={styles.feedMsg} style={{ color: eventColor(ev.type) }}>{ev.message}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </section>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [groups, setGroups] = useState<Record<string, RegisteredGroup> | null>(null);
  const [tasks, setTasks] = useState<ScheduledTask[] | null>(null);
  const [events, setEvents] = useState<ActivityEvent[]>([]);

  // Initial fetch
  useEffect(() => {
    fetchStatus().then(setStatus).catch(() => {});
    fetchGroups().then(setGroups).catch(() => {});
    fetchTasks().then(setTasks).catch(() => {});
    fetchActivity().then(setEvents).catch(() => {});
  }, []);

  // Poll status + tasks every 5s
  useEffect(() => {
    const id = setInterval(() => {
      fetchStatus().then(setStatus).catch(() => {});
      fetchTasks().then(setTasks).catch(() => {});
      fetchGroups().then(setGroups).catch(() => {});
    }, 5000);
    return () => clearInterval(id);
  }, []);

  // SSE live events
  useEffect(() => {
    const unsub = subscribeEvents((ev) => {
      setEvents((prev) => [...prev.slice(-299), ev]);
    });
    return unsub;
  }, []);

  return (
    <div className={styles.app}>
      <Header status={status} />
      <main className={styles.main}>
        <div className={styles.sidebar}>
          <GroupsPanel groups={groups} />
          <TasksPanel tasks={tasks} />
          <SwarmPanel status={status} />
        </div>
        <ActivityFeed events={events} />
      </main>
    </div>
  );
}
