import fs from 'fs';
import http from 'http';
import path from 'path';

import { getAllChats, getAllRegisteredGroups, getAllTasks, getRecentMessages } from './db.js';
import { logger } from './logger.js';

const LOG_PATH = path.resolve(process.cwd(), 'logs', 'nanoclaw.log');
const ANSI_RE = /\x1b\[[0-9;]*m/g;

// ── SSE client registry ───────────────────────────────────────────────────────
const sseClients = new Set<http.ServerResponse>();

// ── In-memory activity buffer (last 300 parsed events) ───────────────────────
export interface ActivityEvent {
  id: number;
  ts: string;
  level: string;
  type: string;
  message: string;
  details?: Record<string, string>;
}

let eventSeq = 0;
const activityBuffer: ActivityEvent[] = [];
const MAX_BUFFER = 300;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

function classifyEvent(msg: string): string {
  if (
    msg.includes('Pool message sent') ||
    msg.includes('Assigned and renamed pool bot')
  )
    return 'pool';
  if (msg.includes('Spawning container agent')) return 'container';
  if (msg.includes('Agent output')) return 'agent';
  if (msg.includes('message stored') || msg.includes('message sent'))
    return 'message';
  if (
    msg.includes('Task created') ||
    msg.includes('Task paused') ||
    msg.includes('Task resumed')
  )
    return 'task';
  if (msg.includes('ERROR') || msg.includes('error')) return 'error';
  if (msg.includes('WARN') || msg.includes('warn')) return 'warn';
  return 'info';
}

// Pino-pretty line: [HH:MM:SS.mmm] LEVEL (context/pid): message
const LINE_RE =
  /^\[(\d{2}:\d{2}:\d{2}\.\d{3})\].*?(INFO|WARN|ERROR|DEBUG|FATAL).*?(?:\d+\)|\)): (.*)/;

function parseLine(raw: string): ActivityEvent | null {
  const line = stripAnsi(raw.trim());
  if (!line) return null;
  const m = line.match(LINE_RE);
  if (!m) return null;
  const [, ts, level, message] = m;
  return {
    id: ++eventSeq,
    ts,
    level,
    type: classifyEvent(message),
    message,
  };
}

function pushEvent(ev: ActivityEvent) {
  activityBuffer.push(ev);
  if (activityBuffer.length > MAX_BUFFER) activityBuffer.shift();
  const data = `data: ${JSON.stringify(ev)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(data);
    } catch {
      sseClients.delete(client);
    }
  }
}

// ── Tail the log file ─────────────────────────────────────────────────────────
function startLogTail() {
  if (!fs.existsSync(LOG_PATH)) return;

  // Seed buffer with last 100 lines
  try {
    const content = fs.readFileSync(LOG_PATH, 'utf-8');
    const lines = content.split('\n').slice(-100);
    for (const line of lines) {
      const ev = parseLine(line);
      if (ev) activityBuffer.push(ev);
    }
  } catch {
    // ignore
  }

  let position = fs.statSync(LOG_PATH).size;

  fs.watch(LOG_PATH, () => {
    try {
      const stat = fs.statSync(LOG_PATH);
      if (stat.size < position) position = 0; // rotated
      if (stat.size === position) return;
      const fd = fs.openSync(LOG_PATH, 'r');
      const length = stat.size - position;
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, position);
      fs.closeSync(fd);
      position = stat.size;
      const chunk = buf.toString('utf-8');
      for (const line of chunk.split('\n')) {
        const ev = parseLine(line);
        if (ev) pushEvent(ev);
      }
    } catch {
      // ignore
    }
  });
}

// ── CORS + JSON helpers ───────────────────────────────────────────────────────
function setCors(res: http.ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res: http.ServerResponse, data: unknown, status = 200) {
  setCors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function sse(res: http.ServerResponse) {
  setCors(res);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 3000\n\n');
}

// ── Request router ────────────────────────────────────────────────────────────
export interface DashboardDeps {
  getPoolStatus: () => {
    size: number;
    assignments: { index: number; sender: string; groupFolder: string }[];
  };
  getQueueDepth: () => number;
  startedAt: Date;
}

function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: DashboardDeps,
) {
  const url = req.url?.split('?')[0] ?? '/';

  if (req.method === 'OPTIONS') {
    setCors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  switch (url) {
    case '/api/status': {
      const uptimeSecs = Math.floor(
        (Date.now() - deps.startedAt.getTime()) / 1000,
      );
      json(res, {
        running: true,
        uptimeSeconds: uptimeSecs,
        queueDepth: deps.getQueueDepth(),
        pool: deps.getPoolStatus(),
      });
      break;
    }

    case '/api/groups': {
      try {
        json(res, getAllRegisteredGroups());
      } catch (err) {
        json(res, { error: String(err) }, 500);
      }
      break;
    }

    case '/api/tasks': {
      try {
        json(res, getAllTasks());
      } catch (err) {
        json(res, { error: String(err) }, 500);
      }
      break;
    }

    case '/api/messages': {
      try {
        const msgs = getRecentMessages(100).reverse(); // chronological order
        json(res, msgs);
      } catch (err) {
        json(res, { error: String(err) }, 500);
      }
      break;
    }

    case '/api/chats': {
      try {
        json(res, getAllChats());
      } catch (err) {
        json(res, { error: String(err) }, 500);
      }
      break;
    }

    case '/api/activity': {
      // Return buffered events
      json(res, activityBuffer.slice(-200));
      break;
    }

    case '/api/events': {
      // SSE stream of live activity events
      sse(res);
      // Send buffered events immediately
      for (const ev of activityBuffer.slice(-50)) {
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
      }
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      break;
    }

    default: {
      if (req.method === 'GET' && url === '/') {
        json(res, {
          status: 'AndyClaw Dashboard API',
          endpoints: [
            '/api/status',
            '/api/groups',
            '/api/tasks',
            '/api/chats',
            '/api/activity',
            '/api/events',
          ],
        });
      } else {
        json(res, { error: 'Not found' }, 404);
      }
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────
export function startDashboardServer(
  port: number,
  deps: DashboardDeps,
): Promise<http.Server> {
  startLogTail();

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        handleRequest(req, res, deps);
      } catch (err) {
        logger.error({ err }, 'Dashboard request error');
        res.writeHead(500);
        res.end('Internal error');
      }
    });

    server.listen(port, '127.0.0.1', () => {
      logger.info({ port }, 'Dashboard server started');
      resolve(server);
    });

    server.on('error', reject);
  });
}
