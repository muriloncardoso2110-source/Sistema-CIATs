import { timingSafeEqual } from 'node:crypto';
import { one } from './db.mjs';

const httpTotals = new Map();
const startedAt = Date.now();
let activeRequests = 0;
let errors = 0;

function routeGroup(pathname) {
  if (pathname === '/api/health' || pathname === '/api/ready') return 'health';
  if (pathname === '/internal/metrics') return 'metrics';
  if (pathname.startsWith('/api/auth/')) return 'auth';
  if (pathname.startsWith('/api/teams/')) return 'teams';
  if (pathname.startsWith('/api/tickets')) return 'tickets';
  if (pathname.startsWith('/api/assets')) return 'assets';
  if (pathname.startsWith('/api/users')) return 'users';
  if (pathname.startsWith('/api/stock')) return 'stock';
  if (pathname.startsWith('/api/software')) return 'software';
  if (pathname.startsWith('/api/')) return 'other_api';
  return 'static';
}

// Métricas de baixa cardinalidade: nunca inclua ID, caminho bruto ou e-mail.
export function instrument(req, res, pathname) {
  const begin = performance.now();
  const group = routeGroup(pathname);
  activeRequests++;
  res.once('finish', () => {
    activeRequests = Math.max(0, activeRequests - 1);
    const status = `${Math.floor(res.statusCode / 100)}xx`;
    const key = `${req.method === 'GET' ? 'GET' : 'WRITE'}|${group}|${status}`;
    const metric = httpTotals.get(key) ?? { count: 0, duration: 0 };
    metric.count++;
    metric.duration += performance.now() - begin;
    httpTotals.set(key, metric);
    if (res.statusCode >= 500) errors++;
  });
}

export function authorized(req) {
  const token = process.env.METRICS_TOKEN || '';
  if (token.length < 24) return null; // ausente / fraco: endpoint desligado
  const given = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(given), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function renderMetrics() {
  const lines = [
    '# HELP solvia_uptime_seconds Tempo desde inicializacao',
    '# TYPE solvia_uptime_seconds gauge',
    `solvia_uptime_seconds ${((Date.now() - startedAt) / 1000).toFixed(3)}`,
    '# HELP solvia_http_active_requests Requisicoes HTTP em andamento',
    '# TYPE solvia_http_active_requests gauge',
    `solvia_http_active_requests ${activeRequests}`,
    '# HELP solvia_http_server_errors_total Respostas HTTP 5xx',
    '# TYPE solvia_http_server_errors_total counter',
    `solvia_http_server_errors_total ${errors}`,
    '# HELP solvia_process_resident_memory_bytes Memoria residente',
    '# TYPE solvia_process_resident_memory_bytes gauge',
    `solvia_process_resident_memory_bytes ${process.memoryUsage().rss}`,
    '# HELP solvia_http_requests_total Total de requisicoes por grupo/status',
    '# TYPE solvia_http_requests_total counter',
    '# HELP solvia_http_duration_milliseconds_sum Soma das duracoes em ms',
    '# TYPE solvia_http_duration_milliseconds_sum counter'
  ];
  for (const [key, {count, duration}] of httpTotals) {
    const [method, group, status] = key.split('|');
    const label = `{method="${method}",group="${group}",status="${status}"}`;
    lines.push(`solvia_http_requests_total${label} ${count}`);
    lines.push(`solvia_http_duration_milliseconds_sum${label} ${duration.toFixed(3)}`);
  }
  try {
    const opened = one("SELECT COUNT(*) c FROM tickets WHERE status NOT IN ('encerrado','resolvido')")?.c ?? 0;
    const unassigned = one("SELECT COUNT(*) c FROM tickets WHERE assignee_id IS NULL AND status NOT IN ('encerrado','resolvido')")?.c ?? 0;
    const stockLow = one('SELECT COUNT(*) c FROM stock WHERE active=1 AND quantity < minimum')?.c ?? 0;
    lines.push('# TYPE solvia_open_tickets gauge', `solvia_open_tickets ${opened}`);
    lines.push('# TYPE solvia_unassigned_tickets gauge', `solvia_unassigned_tickets ${unassigned}`);
    lines.push('# TYPE solvia_low_stock_items gauge', `solvia_low_stock_items ${stockLow}`);
  } catch { /* no banco ao desligar: métricas de processo continuam */ }
  return lines.join('\n') + '\n';
}
