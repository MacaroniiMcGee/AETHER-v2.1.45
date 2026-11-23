// AETHER_SUNAPI_LIMITS — client for /api/sunapi/limits (NHP limits test + firmware comparison)
import type { Report } from './limitsDiff';

export type Level = 'discovery' | 'protocol' | 'validation' | 'load' | 'connector' | 'door' | 'capacity' | 'lockout';
export interface RunMeta {
  id: string; source: 'run' | 'import'; fileName?: string; deviceId: string | null; deviceName: string; host: string;
  model: string; firmware: string; levels: Level[] | string; doorToken?: string | null; startedAt: number; endedAt: number | null;
  state: 'running' | 'done' | 'stopped' | 'error'; counts: Record<string, number>; level?: string | null; error?: string | null; tool?: string; steps?: Step[];
}
export interface Step {
  menu: string; phase: 'pending' | 'inspect' | 'push' | 'validate' | 'done' | 'cleanup' | 'finished';
  declared?: number | null; declaredKey?: string; existing?: number; target?: number; pushed?: number; stored?: number; expected?: number;
  refused?: string | null; readbackOk?: boolean | null; result?: string; message?: string; removed?: number; left?: number;
}
export interface MockState { running: boolean; https: boolean | null; startedAt: number | null; deviceId: string; port: number; log: string[] }
export interface RunEvent { t: 'result'; id: string; level: string; test: string; result: string; measured: string; at: number }
export interface Job extends RunMeta { events: RunEvent[]; eventCount: number; outputTail: string[]; steps: Step[] }
export interface StartRun {
  deviceId: string; levels: Level[]; doorToken?: string; doorCommands?: string; capacityMenus?: string; capacityCap?: number;
  lockoutUser?: string; lockoutPassword?: string; confirmed: Partial<Record<'door' | 'capacity' | 'lockout', boolean>>;
}

export function limitsClient(backend: string) {
  const base = `${backend.replace(/\/$/, '')}/api/sunapi/limits`;
  async function call<T>(p: string, opt: { method?: string; body?: unknown } = {}): Promise<T> {
    const r = await fetch(base + p, {
      method: opt.method || 'GET',
      headers: opt.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: opt.body !== undefined ? JSON.stringify(opt.body) : undefined,
    });
    const data = (r.headers.get('content-type') || '').includes('json') ? await r.json() : await r.text();
    if (!r.ok) {
      const msg = (data && typeof data === 'object' && (data as { error?: string }).error) || (r.status === 404 ? 'The limits service is not on this Pi yet. Install Update SUNAPI-5.' : `HTTP ${r.status}`);
      throw Object.assign(new Error(msg), { status: r.status });
    }
    return data as T;
  }
  return {
    runs: (deviceId?: string) => call<RunMeta[]>(`/runs${deviceId ? `?deviceId=${encodeURIComponent(deviceId)}` : ''}`),
    run: (id: string) => call<RunMeta & { report: Report | null }>(`/runs/${id}`),
    remove: (id: string) => call<{ ok: boolean }>(`/runs/${id}`, { method: 'DELETE' }),
    start: (b: StartRun) => call<RunMeta>('/runs', { method: 'POST', body: b }),
    job: (since = 0) => call<Job | null>(`/job?since=${since}`),
    stop: () => call<{ ok: boolean }>('/job/stop', { method: 'POST', body: {} }),
    mock: () => call<MockState>('/mock'),
    mockStart: (accessLevels?: number) => call<MockState>('/mock/start', { method: 'POST', body: { accessLevels } }),
    mockStop: () => call<MockState>('/mock/stop', { method: 'POST', body: {} }),
    xlsxUrl: (id: string) => `${base}/runs/${id}/xlsx`,
    exportXlsx: async (name: string, sheets: Record<string, unknown[][]>) => {
      const r = await fetch(`${base}/export-xlsx`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, sheets }) });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error((d && d.error) || `HTTP ${r.status}`); }
      return r.blob();
    },
    importXlsx: async (f: File) => {
      const r = await fetch(`${base}/import?name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((d && d.error) || `HTTP ${r.status}`);
      return d as RunMeta;
    },
  };
}
export type LimitsClient = ReturnType<typeof limitsClient>;

export const LEVELS: { id: Level; label: string; what: string; risk?: 'door' | 'capacity' | 'lockout'; busy?: boolean }[] = [
  { id: 'discovery', label: 'Discovery', what: 'Device info, the full API spec, capabilities, doors, every read command' },
  { id: 'protocol', label: 'Protocol', what: 'HTTP / HTTPS, TLS, login types, nonce reuse, keep-alive, URL length' },
  { id: 'validation', label: 'Validation', what: 'Bad tokens, commands and values → which error codes come back' },
  { id: 'load', label: 'Load', what: 'Latency, concurrent clients, event streams', busy: true },
  { id: 'connector', label: 'Cloud Connector', what: 'The reads the Cloud Connector makes, and the monitordiff event stream' },
  { id: 'door', label: 'Door', what: 'Releases a real door: timing, repeats, burst, event latency', risk: 'door' },
  { id: 'capacity', label: 'Capacity', what: 'Adds ZZT test objects until the controller refuses, then removes them', risk: 'capacity' },
  { id: 'lockout', label: 'Login lockout', what: 'Wrong passwords until the login locks, then how long it lasts', risk: 'lockout' },
];
export const levelList = (l: RunMeta['levels']) => (Array.isArray(l) ? l : String(l || '').split(/,\s*/).filter(Boolean));
export const runLabel = (m: RunMeta) => `${m.firmware || 'firmware ?'} · ${m.model || '?'} · ${m.source === 'import' ? `imported ${m.fileName || ''}` : m.deviceName} · ${new Date(m.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
