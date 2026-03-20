const BASE = '/api';

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  isMain?: boolean;
  requiresTrigger?: boolean;
  channel?: string;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: string;
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface PoolAssignment {
  index: number;
  sender: string;
  groupFolder: string;
}

export interface Status {
  running: boolean;
  uptimeSeconds: number;
  queueDepth: number;
  pool: { size: number; assignments: PoolAssignment[] };
}

export interface ActivityEvent {
  id: number;
  ts: string;
  level: string;
  type: string;
  message: string;
}

export async function fetchStatus(): Promise<Status> {
  const r = await fetch(`${BASE}/status`);
  return r.json();
}

export async function fetchGroups(): Promise<Record<string, RegisteredGroup>> {
  const r = await fetch(`${BASE}/groups`);
  return r.json();
}

export async function fetchTasks(): Promise<ScheduledTask[]> {
  const r = await fetch(`${BASE}/tasks`);
  return r.json();
}

export interface ChatMessage {
  id: string;
  chat_jid: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: number;
  is_bot_message: number;
}

export async function fetchMessages(): Promise<ChatMessage[]> {
  const r = await fetch(`${BASE}/messages`);
  return r.json();
}

export async function fetchActivity(): Promise<ActivityEvent[]> {
  const r = await fetch(`${BASE}/activity`);
  return r.json();
}

export function subscribeEvents(
  onEvent: (ev: ActivityEvent) => void,
  onError?: () => void,
): () => void {
  const es = new EventSource(`${BASE}/events`);
  es.onmessage = (e) => {
    try {
      onEvent(JSON.parse(e.data));
    } catch {
      // ignore malformed
    }
  };
  es.onerror = () => onError?.();
  return () => es.close();
}
