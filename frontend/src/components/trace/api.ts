// AETHER_TRACE — client and types for /api/trace (Event Trace)
export const defaultBackend = () => (typeof window === 'undefined' ? 'http://localhost:3001' : `${window.location.protocol}//${window.location.hostname}:3001`);

export type Lane = 'aether' | 'controller' | 'wire' | 'cloud';
export type Src = 'journal' | 'cloud-mqtt' | 'cloud-api' | 'wire' | 'controller' | 'har';
export interface Cred { fc?: string; cn?: string; format?: string }
export interface TEvent {
  id: string; seq: number; src: Src; lane: Lane; at: number | null; t: number | null; clock: 'pi' | 'controller' | 'cloud' | 'browser';
  type: string; label: string; door: { id: string | null; name: string | null } | null; controllerId: string | null; cred: Cred | null;
  clientType: string | null; eventId: string | null; topic: string | null; info?: Record<string, unknown>; access?: boolean;
  hasRaw?: boolean; secret?: boolean; detail?: unknown; cloudAt?: number | null; publishAt?: number | null; dir?: 'in' | 'out'; pollMs?: number; harVia?: string;
}
export type Kind = 'card' | 'input' | 'output' | 'command';
export interface Cmd { kind: string; target: string | string[]; value: unknown; area?: string; targetName?: string | null }
export interface Hop { id: string; label: string; at: number; ms: number; clock: string; corrected?: boolean; raw?: number; resolution?: number }
export interface Trace {
  id: string; kind: Kind; at: number; sync: boolean; role?: string; held?: number | null;
  cause?: { kind: string; label: string; at: number; traceId?: string } | null;
  action: { label: string; ch?: string | null; cred: Cred | null; type: string; v?: number; cmd?: Cmd };
  decision: { type: string; t: number; cred: Cred | null; door: { id: string | null; name: string | null } | null; sources: Src[]; matchedBy: string; clientType: string | null; eventIds: string[] } | null;
  hops: Hop[]; expect: string | null; result: string | null; credCheck: 'match' | 'mismatch' | 'not-reported' | 'n/a';
  status: 'pass' | 'warn' | 'fail'; notes: string[]; latency: { decision: number | null; push: number | null; api: number | null; output?: number | null; hardware?: number | null; ack?: number | null };
}
export interface Stat { n: number; min?: number; p50?: number; p95?: number; max?: number }
export interface SyncResult { at: number; fc?: number; cn?: string; ch?: string; v?: number; set: string; idx: number; matched: boolean; eventT: number | null; type: string | null; offset: number | null; byPattern?: boolean }
export interface Analysis {
  meta: { id: string; name: string; start: number; end: number | null; endReason?: string; syncError?: string; imports: { at: number; what: string; count: number }[]; count: number; running: boolean } | null;
  clock: { offset: number | null; drift: { startMs: number; endMs: number; changeMs: number; perHourMs: number | null } | null; sync: SyncResult[]; gaps: { set: string; sent: number; seen: number }[] };
  traces: Trace[]; unexplained: { type: string; t: number; at: number; cred: Cred | null; door: { id: string | null; name: string | null } | null; sources: Src[] }[];
  stats: KindStats & { unexplained: number; byKind: Record<Kind, KindStats> };
  roles: Record<string, Role>;
}
export interface KindStats { actions: number; pass: number; warn: number; fail: number; decision: Stat; push: Stat; api: Stat; decisionToPush: Stat; output: Stat; hardware: Stat; ack: Stat; credMismatch: number; unexplained?: number; verdict: 'pass' | 'warn' | 'fail' | 'no-data' }
export interface Role { role: string; door?: string; active?: 'open' | 'closed'; ioId?: string; label?: string; auto?: boolean; score?: number; kind?: string; count?: number }
export type Wiring = Record<string, { role: string; door?: string; active?: 'open' | 'closed'; ioId?: string; label?: string }>;
export interface SeenChannel { ch: string; kind: string; count: number; last: number; inferred: Role | null }
export interface InvDoor { id: string; name: string; controllerId: string; areaIds: string[]; locationId?: string }
export interface InvArea { id: string; name: string; locationId: string; location: string; tz: string | null }
export interface InvZone { id: string; name: string; type: string; state: string }
export interface Settings {
  cloud: { url: string; org: string; controllers: string[]; doors: string[]; poll: boolean; pollMs: number; autoConnect: boolean; doorConfig: Record<string, { grantMs: number | null; extendedMs: number | null; name: string }> };
  sync: { channel: { kind: 'wiegand' | 'osdp' | 'emu' | 'relay' | 'emu-in'; readerId: string; address: number; port: number; relay: number; input: number }; format: string; cards: { fc: number; cn: string }[]; gapsMs: number[]; atStart: boolean; atEnd: boolean; everyMin: number };
  wire: { controllerIps: string[] };
  thresholds: { decisionWarn: number; decisionFail: number; pushWarn: number; pushFail: number; matchWindowMs: number; inputWindowMs: number; outputWindowMs: number; commandWarn: number; commandFail: number; heldToleranceMs: number };
  commands: { enabled: boolean };
  expectations: { fc: string; cn: string; expect: 'grant' | 'deny'; note: string }[];
  allowRaw: boolean;
}
export interface CloudStatus {
  configured: boolean; url: string | null; org: string | null; controllers: string[]; doors: string[];
  push: { state: string; error: string | null; topics: string[]; acked: { topic: string; ok: boolean; code: number }[]; host: string | null; connectedAt: number | null; received: number; lastAt: number | null; tokenExpiry: number | null; retryAt?: number };
  api: { state: string; error: string | null; lastAt: number | null; seen: number; ms: number | null; enabled: boolean };
}
export interface Status {
  run: { id: string; name: string; start: number; count: number; syncs: SyncResult[] } | null; syncBusy: boolean; seq: number;
  sources: { journal: { ok: boolean }; cloud: CloudStatus; wire: { controllerIps: string[]; traffic: { state: string; gateway: boolean } | null } };
  channels: { wiegand: { id: string; name: string }[]; osdp: { id: string; name: string }[]; emu: { id: string; name: string }[]; relay?: boolean };
  settings: Settings;
  wiring: Wiring;
  inventory: { org: string; at: number; doors: InvDoor[]; areas: InvArea[]; zones: InvZone[]; controllers: Inventory['controllers'] } | null;
}
export interface RunMeta { id: string; name: string; start: number; end: number | null; endReason?: string; count?: number; imports?: { at: number; what: string; count: number }[] }
export interface OnCafeSession { signedIn: boolean; host?: string; user?: string; name?: string; orgs?: { id: string; name: string }[]; org?: string; expiresAt?: string | null; error?: string }
export interface Inventory { controllers: { id: string; name: string; model: string; status: string; type: string }[]; doors: InvDoor[]; areas: InvArea[]; zones: InvZone[] }
export interface ReportMeta { id: string; name?: string; createdAt?: number; mode?: string; files?: number; window?: { from: number; to: number } }

export function traceClient(backend: string) {
  const root = backend.replace(/\/$/, '');
  const base = `${root}/api/trace`;
  async function call<T>(p: string, opt: { method?: string; body?: unknown; raw?: string; url?: string } = {}): Promise<T> {
    const r = await fetch(opt.url || base + p, {
      method: opt.method || 'GET',
      credentials: 'include',
      headers: opt.raw !== undefined ? { 'Content-Type': 'text/plain' } : opt.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: opt.raw !== undefined ? opt.raw : opt.body !== undefined ? JSON.stringify(opt.body) : undefined,
    });
    const ct = r.headers.get('content-type') || '';
    const data = ct.includes('json') ? await r.json() : await r.text();
    if (!r.ok) {
      const msg = (data && typeof data === 'object' && ((data as { error?: string }).error)) || (r.status === 404 ? 'Event Trace is not installed on this Pi (404)' : `HTTP ${r.status}`);
      throw Object.assign(new Error(msg), { status: r.status });
    }
    return data as T;
  }
  async function save(p: string, name: string) {
    const r = await fetch(base + p, { credentials: 'include' });
    if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error((d as { error?: string }).error || `HTTP ${r.status}`); }
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement('a'); a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return {
    status: () => call<Status>('/status'),
    saveSettings: (s: Partial<Settings>) => call<Settings>('/settings', { method: 'PUT', body: s }),
    live: (since: number) => call<{ seq: number; events: TEvent[] }>(`/live?since=${since}`),
    liveAnalysis: () => call<Analysis>('/live/analysis'),
    inventory: (url: string, org: string) => call<Inventory>(`/cloud/inventory?url=${encodeURIComponent(url)}&org=${encodeURIComponent(org)}`),
    connect: () => call<CloudStatus>('/cloud/connect', { method: 'POST', body: {} }),
    disconnect: () => call<CloudStatus>('/cloud/disconnect', { method: 'POST', body: {} }),
    wiring: () => call<{ wiring: Wiring; channels: SeenChannel[] }>('/wiring'),
    saveWiring: (wiring: Wiring) => call<{ wiring: Wiring }>('/wiring', { method: 'PUT', body: { wiring } }),
    command: (c: { kind: string; target: string; value: unknown; seconds?: number; revertSec?: number }) => call<{ ok: boolean; status: number; ackMs: number; error: string | null; revertIn: number | null }>('/command', { method: 'POST', body: c }),
    sync: (set: 'start' | 'end' | 'check' = 'check') => call<{ sent: unknown[] }>('/sync', { method: 'POST', body: { set } }),
    start: (name: string, sync: boolean) => call<RunMeta>('/runs/start', { method: 'POST', body: { name, sync } }),
    stop: (sync: boolean) => call<RunMeta>('/runs/stop', { method: 'POST', body: { sync } }),
    runs: () => call<{ runs: RunMeta[]; current: string | null }>('/runs'),
    run: (id: string) => call<Analysis>(`/runs/${encodeURIComponent(id)}`),
    events: (id: string) => call<{ events: TEvent[] }>(`/runs/${encodeURIComponent(id)}/events`),
    del: (id: string) => call<{ ok: boolean }>(`/runs/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    importHar: (id: string, text: string) => call<{ imported: number }>(`/runs/${encodeURIComponent(id)}/import/har`, { method: 'POST', raw: text }),
    importWire: (id: string, packets: unknown[]) => call<{ imported: number }>(`/runs/${encodeURIComponent(id)}/import/wire`, { method: 'POST', body: { packets } }),
    importReport: (id: string, reportId: string) => call<{ imported: number }>(`/runs/${encodeURIComponent(id)}/import/report`, { method: 'POST', body: { reportId } }),
    reports: () => call<{ reports: ReportMeta[] }>('/reports'),
    reveal: (run: string | null, event: string) => call<{ raw: unknown }>(`/reveal?${run ? `run=${encodeURIComponent(run)}&` : ''}event=${encodeURIComponent(event)}`),
    reveals: (id: string) => call<{ reveals: { at: string; who: string; id: string; what: string }[] }>(`/runs/${encodeURIComponent(id)}/reveals`),
    saveJson: (id: string) => save(`/runs/${encodeURIComponent(id)}/export.json`, `${id}.json`),
    saveCsv: (id: string) => save(`/runs/${encodeURIComponent(id)}/export.csv`, `${id}.csv`),
    // OnCAFE sign-in lives in routes-oncafe (Update 58); Event Trace reuses it
    oncafeSession: (url: string) => call<OnCafeSession>('', { url: `${root}/api/oncafe/session?url=${encodeURIComponent(url)}` }),
    oncafeSignin: (url: string, username: string, password: string) => call<OnCafeSession>('', { url: `${root}/api/oncafe/signin`, method: 'POST', body: { url, username, password } }),
    oncafeSignout: (url: string) => call<OnCafeSession>('', { url: `${root}/api/oncafe/signout`, method: 'POST', body: { url } }),
  };
}
export type TraceApi = ReturnType<typeof traceClient>;

export const fmtMs = (ms: number | null | undefined) => (ms == null ? '—' : Math.abs(ms) >= 10000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
export const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) + '.' + String(Math.round(t) % 1000).padStart(3, '0');
export const credText = (c: Cred | null | undefined) => (c ? `${c.fc ?? '?'}-${c.cn ?? '?'}` : '—');
export const LANES: { id: Lane; label: string }[] = [
  { id: 'aether', label: 'Aether' }, { id: 'controller', label: 'Controller' }, { id: 'wire', label: 'Wire' }, { id: 'cloud', label: 'Cloud' },
];
export const SRC_LABEL: Record<Src, string> = { journal: 'Aether journal', 'cloud-mqtt': 'Cloud push (MQTT)', 'cloud-api': 'Event log (API)', wire: 'Wire', controller: 'Controller logs', har: 'HAR' };
export const KIND_LABEL: Record<Kind, string> = { card: 'Cards', input: 'Inputs', output: 'Outputs', command: 'Commands' };
export const ROLE_LABEL: Record<string, string> = { dps: 'DPS (door contact)', rex: 'REX', input: 'Input', lock: 'Lock / strike', output: 'Output', card: 'Card', keypad: 'Keypad', ignore: 'Ignore', unmapped: 'Not mapped' };
