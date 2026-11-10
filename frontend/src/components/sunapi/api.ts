// AETHER_SUNAPI — thin client for /api/sunapi
export type DeviceKind = 'camera' | 'recorder' | 'access' | 'other';
export interface Device { id: string; name: string; host: string; port: number; https: boolean; user: string; kind?: DeviceKind; kindManual?: boolean; cgiRoot?: string; hasPassword?: boolean; model?: string; firmware?: string; mac?: string; lastSeen?: number; source?: string }
export interface ScanHost { ip: string; sunapi?: 'yes' | 'maybe' | 'no'; onvif?: boolean; onvifXAddr?: string; port?: number; https?: boolean; realm?: string; server?: string; mac?: string; model?: string; name?: string; deviceName?: string; firmware?: string; deviceType?: string; serial?: string; kind?: DeviceKind; vendor?: string; identify?: string; identifyError?: string; answer?: string; kindHint?: DeviceKind; existingId?: string | null; existingName?: string | null }
export interface ScanJob { id: string; state: 'running' | 'done' | 'cancelled' | 'error'; phase: string; done: number; total: number; startedAt: number; ms: number; error?: string; ranges: string; results: ScanHost[] }
export interface SunapiResult { status: number; statusText: string; headers: Record<string, string>; contentType: string; ms: number; bytes: number; truncated: boolean; bodyEncoding: 'utf8' | 'base64'; body: string; auth: string; url: string }
export interface HistoryEntry { at: number; method: string; path: string; query: string; cgi: string; submenu: string; action: string; origin?: string; status: number; ms?: number; bytes?: number; contentType?: string; body?: string | null; clipped?: boolean; error?: string }
export interface SnapshotMeta { id: string; deviceId: string | null; deviceName: string; name: string; model: string; firmware: string; createdAt: number; count: number; failed: number; ms: number }
export interface SnapshotEntry { status: number; body?: string; error?: string; ms?: number }
export interface Snapshot extends SnapshotMeta { results: Record<string, SnapshotEntry> }

export interface LibraryFile { id: string; filename: string; model: string | null; version: string | null; sizeBytes: number; sha256: string; notes: string | null }
export interface ReaderFileJob {
  id: string; deviceId: string; state: 'running' | 'done' | 'refused' | 'error'; phase: 'login' | 'uploading' | 'waiting' | 'ended';
  startedAt: number; sentAt: number | null; endedAt: number | null; ms: number; file: { name: string; bytes: number; sha256: string };
  portIndex: number; readerIndex: number; fileType: 'firmware' | 'config'; path: string; query: string; url: string;
  result: (SunapiResult & { body: string }) | null; error: string | null;
}
export interface ReaderFileSend { portIndex: number; readerIndex: number; fileType: 'firmware' | 'config'; path?: string; query?: string; timeoutMin?: number; file?: File; libraryId?: string }

export interface BatchItem { deviceId: string; name: string; host?: string; model?: string; kind?: DeviceKind; skipped?: string; error?: string; result?: SunapiResult; readback?: { status: number; body?: string; error?: string } }
export interface BatchResponse { ms: number; results: BatchItem[] }

export const defaultBackend = () => (typeof window === 'undefined' ? 'http://localhost:3001' : `${window.location.protocol}//${window.location.hostname}:3001`);

export function client(backend: string) {
  const base = `${backend.replace(/\/$/, '')}/api/sunapi`;
  async function call<T>(p: string, opt: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
    const r = await fetch(base + p, {
      method: opt.method || 'GET', signal: opt.signal,
      headers: opt.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: opt.body !== undefined ? JSON.stringify(opt.body) : undefined,
    });
    const ct = r.headers.get('content-type') || '';
    const data = ct.includes('json') ? await r.json() : await r.text();
    if (!r.ok) {
      const msg = (data && typeof data === 'object' && (data as { error?: string }).error) || (r.status === 404 ? 'The SUNAPI service is not on this Pi yet (404)' : `HTTP ${r.status}`);
      throw Object.assign(new Error(msg), { status: r.status });
    }
    return data as T;
  }
  return {
    devices: () => call<Device[]>('/devices'),
    addDevice: (d: Partial<Device> & { password?: string }) => call<Device>('/devices', { method: 'POST', body: d }),
    updateDevice: (id: string, d: Partial<Device> & { password?: string }) => call<Device>(`/devices/${id}`, { method: 'PUT', body: d }),
    bulkAdd: (body: { devices: Partial<ScanHost & { host: string; name: string }>[]; user: string; password: string; cgiRoot?: string }) => call<{ added: Device[] }>('/devices/bulk', { method: 'POST', body }),
    networks: () => call<{ iface: string; address: string; cidr: string }[]>('/scan/networks'),
    startScan: (body: { ranges?: string; ports?: string; onvif?: boolean; sweep?: boolean; cgiRoot?: string; identify?: { user: string; password: string } | null }) => call<ScanJob>('/scan', { method: 'POST', body }),
    scan: (id: string) => call<ScanJob>(`/scan/${id}`),
    cancelScan: (id: string) => call<{ ok: boolean }>(`/scan/${id}/cancel`, { method: 'POST', body: {} }),
    removeDevice: (id: string) => call<{ ok: boolean }>(`/devices/${id}`, { method: 'DELETE' }),
    connect: (id: string, refresh = false) => call<{ ok: boolean; status: number; switchedToHttps?: boolean; info: Record<string, string>; ms: number; auth: string; attributes: { bytes: number; error: string | null } }>(`/devices/${id}/connect`, { method: 'POST', body: { refresh } }),
    attributes: (id: string, refresh = false) => call<string>(`/devices/${id}/attributes${refresh ? '?refresh=1' : ''}`),
    request: (id: string, body: { path: string; query: string; method?: string; body?: string; accept?: 'json' | 'text'; confirmed?: boolean; timeoutMs?: number; history?: boolean; origin?: string }, signal?: AbortSignal) =>
      call<SunapiResult>(`/devices/${id}/request`, { method: 'POST', body, signal }),
    batch: (body: { deviceIds: string[]; path: string; query: string; accept?: 'json' | 'text'; confirmed?: boolean; timeoutMs?: number; verifyQuery?: string; history?: boolean }, signal?: AbortSignal) =>
      fetch(`${base}/batch`, { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(async r => { const d = await r.json(); if (!r.ok) throw Object.assign(new Error(d.error || `HTTP ${r.status}`), { status: r.status }); return d as BatchResponse; }),
    history: (id: string) => call<HistoryEntry[]>(`/devices/${id}/history`),
    clearHistory: (id: string) => call<{ ok: boolean }>(`/devices/${id}/history`, { method: 'DELETE' }),
    snapshots: (deviceId?: string) => call<SnapshotMeta[]>(`/snapshots${deviceId ? `?deviceId=${deviceId}` : ''}`),
    snapshot: (sid: string) => call<Snapshot>(`/snapshots/${sid}`),
    saveSnapshot: (s: { deviceId: string; name: string; model?: string; firmware?: string; ms: number; results: Record<string, SnapshotEntry> }) => call<SnapshotMeta>('/snapshots', { method: 'POST', body: s }),
    removeSnapshot: (sid: string) => call<{ ok: boolean }>(`/snapshots/${sid}`, { method: 'DELETE' }),
    firmwareLibrary: () => call<LibraryFile[]>('/firmware-library'),
    readerFile: (id: string) => call<ReaderFileJob | null>(`/devices/${id}/reader-file`),
    sendReaderFile: async (id: string, o: ReaderFileSend) => {
      const qs = new URLSearchParams({ confirmed: '1', portIndex: String(o.portIndex), readerIndex: String(o.readerIndex), fileType: o.fileType });
      if (o.path) qs.set('path', o.path);
      if (o.query) qs.set('query', o.query);
      if (o.timeoutMin) qs.set('timeoutMin', String(o.timeoutMin));
      if (o.libraryId) qs.set('libraryId', o.libraryId);
      if (o.file) qs.set('name', o.file.name);
      const r = await fetch(`${base}/devices/${id}/reader-file?${qs}`, o.file
        ? { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: o.file }
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error((d && d.error) || `HTTP ${r.status}`), { status: r.status });
      return d as ReaderFileJob;
    },
  };
}
export type Client = ReturnType<typeof client>;
