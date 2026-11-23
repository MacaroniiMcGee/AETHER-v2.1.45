// AETHER_AZURE_DEBUG — client and types for /api/azure-debug
export const defaultBackend = () => (typeof window === 'undefined' ? 'http://localhost:3001' : `${window.location.protocol}//${window.location.hostname}:3001`);

export type Sev = 'high' | 'medium' | 'low' | 'info';
export type HopStatus = 'ok' | 'warn' | 'bad';
export interface Sample { t?: number; text?: string; file?: string; line?: number }
export interface Finding { id: string; sev: Sev; cat?: string; area?: string; title: string; detail?: string; fix?: string | string[]; basis?: string; ref?: string; samples?: Sample[]; boards?: string[] }
export interface Controller {
  isAzure: boolean; model: string | null; manufacturer: string | null; serialNo: string | null; mac: string | null; hostname: string | null;
  firmware: string | null; connector: string | null; hardware: string | null; claim: string | null; orgShortName: string | null; timezone: string | null;
}
export interface Board {
  id: string; port: string | null; addr: number | null; node: number | null; lda: number | null; model: string | null; status: string | null;
  info: { kind: string; label: string; readers: number | null; inputs: number | null; outputs: number | null };
  offline: number; online: number; relayChanges: number; lastEvent: DevStatus | null; readers: Reader[];
}
export interface Reader { label: string; node: number; lda: number; idx: number; mode: string | null; addr: number | null; baud: number | null; secure: boolean; assigned: boolean }
export interface DevStatus { t: number; kind: 'board' | 'reader'; node: number; lda: number; idx: number; reason: string; state: string }
export interface Hop { id: string; label: string; sub: string; status: HopStatus; count: number; top: { id: string; sev: Sev; title: string; src: string }[] }
export interface SyncRun { t: number; end: number | null; ms: number | null; finished: boolean; steps: { step: string; ms: number | null; entries: number; t: number }[]; fails: { t: number; what: string; status: string }[]; slowest: { step: string; ms: number | null } | null }
export interface Life { t: number; kind: string; state: string; fw?: string; cc?: string; msg?: string }
export interface OsdpDev { drv: number; addr: number; frames: number; codes: Record<string, number>; unknown: number; spanMin: number; inputs: { input: number; ic2: number | null; changes: number; unknown: number; perMin: number; last: number | null }[]; chatter: unknown[] }
export interface Azure {
  controller: Controller; com: { port: string; baud: number | null }[]; boards: Board[]; readers: Reader[];
  deviceStatus: DevStatus[]; relays: { lda: number; point: number; toggles: number; first: number; last: number }[];
  lifecycle: Life[]; sync: SyncRun[]; checks: Finding[]; hops: Hop[]; zone?: { tz: string };
  osdp: { devices: OsdpDev[]; frames: number; notes: number; unknownNotes: number; sample: { t: number; drv: number; addr: number; name: string; data: string; note: string }[] };
}
export interface Frame { t: number; dir: 'S' | 'R' | 'E' | string; peer: string; code: string; name: string; conf: string; seq?: number; len?: number; lenOk?: boolean; serial?: number; evName?: string; ackSerial?: number; ackOf?: string; hostname?: string; point?: string; hex?: string }
export interface Report {
  clipped?: boolean;   // AZURE-14: cut to a time range
  findings: Finding[]; frames: Frame[]; zone: { tz: string }; window: { from: number; to: number } | null; windowLocal?: { from: string; to: string };
  summary?: Record<string, unknown>; coverage?: Record<string, { from: number; to: number; n: number } | null>; files?: { rel: string; type: string; size: number; records: number }[];
}
export interface Meta { id: string; name: string; createdAt: number; scanMs: number; window: { from: number; to: number } | null; controller: Controller; boards: number; hops: { id: string; status: HopStatus }[]; bySeverity: Record<string, number> }
export interface Scan { meta: Meta; report: Report; azure: Azure }
export interface Probe {
  host: string; at: number; ms: number; hostname: string | null;
  ping: { ran: boolean; loss: number | null; avgMs: number | null };
  ports: { port: number; open: boolean; ms: number; error: string | null; what: string }[];
  tls: { ok: boolean; error?: string; protocol?: string; subject?: string | null; issuer?: string | null; validFrom?: string; validTo?: string; authorized?: boolean; authError?: string | null };
  web: { ok: boolean; error?: string; status?: number; server?: string | null; title?: string | null; azure?: boolean };
}
export interface BusDev { address: number; online: boolean; commands: number; replies: number; naks: number; timeouts: number; crcErrors: number; lastSeenAgoMs: number | null; id: { vendor: string; model: number; version: number; serial: string; firmware: string; azure: boolean } | null }


// ── board firmware (AETHER_AZURE_FW) ──
export interface FwFile { name: string; label: string; product: string; gen: number | null; kind: 'app' | 'bootloader'; format?: 'upd' | 'srec'; size: number; payload: number | null; signed: boolean; sha256: string; header?: string }
export interface FwPackage { id: string; addedAt: number; fileName: string; version: string | null; product: string; gen: number | null; label: string; sendable?: boolean; existed?: boolean; files: FwFile[]; notesHead: string | null; bootloaderFirstForGen3: boolean; mentionsXo8: boolean | null }
export interface FwBoard { address: number; azure?: boolean; vendor?: string; model?: number; family?: string; product?: string | null; gen?: number; firmware?: string; serial?: string; outputs?: number | null; inputs?: number | null; fileTransfer?: boolean | null; secureChannel?: boolean | null; rxBuffer?: number | null; error?: string }
export interface FwPlan { ok: boolean; why: string[]; notes?: string[]; steps: { kind: string; file: string; size: number; format?: 'upd' | 'srec' }[]; bootRequired: boolean; from: string; to: string | null }
export interface FwJob {
  id: string; state: 'running' | 'done' | 'failed'; startedAt: number; endedAt?: number; portPath: string; baudRate: number; address: number; package: string;
  step: string | null; steps: { kind: string; file: string; size: number; state: string; after?: string }[];
  progress: { phase: string; percent: number; bytesSent: number; totalBytes: number; fragment?: number; totalFragments?: number; at: number } | null;
  log: { t: number; level: string; msg: string }[]; result: string | null; error: string | null; before: FwBoard | null; after: FwBoard | null;
}
export interface FwImport { packages: FwPackage[]; errors: string[]; existing?: number; skipped?: number; skippedSample?: string[] }
export interface FwScan { port: string; baud: number; bus: { busy: boolean; commands: number; replies: number; addresses: number[] }; boards: FwBoard[] }

export function azureClient(backend: string) {
  const base = `${backend.replace(/\/$/, '')}/api/azure-debug`;
  async function call<T>(p: string, init?: RequestInit): Promise<T> {
    const r = await fetch(base + p, init);
    const j = (r.headers.get('content-type') || '').includes('json') ? await r.json() : null;
    if (!r.ok || (j && j.success === false)) throw new Error((j && j.error) || (r.status === 404 ? 'The Azure Debugger service is not on this Pi yet. Install Update AZURE-1.' : `HTTP ${r.status}`));
    return j as T;
  }
  const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return {
    reports: () => call<{ reports: Meta[] }>('/reports').then(r => r.reports),
    report: (id: string) => call<Scan>(`/reports/${id}`),
    remove: (id: string) => call<unknown>(`/reports/${id}`, { method: 'DELETE' }),
    scan: (files: File[], name?: string) => {
      const fd = new FormData();
      files.forEach(f => fd.append('bundle', f, f.name));
      if (name) fd.append('name', name);
      return call<{ meta: Meta }>('/scan', { method: 'POST', body: fd }).then(r => r.meta);
    },
    scanText: (text: string, name?: string) => call<{ meta: Meta }>('/scan-text', json({ text, name })).then(r => r.meta),
    probe: (host: string) => call<Probe & { success: boolean }>('/probe', json({ host })),
    bus: () => call<{ available: boolean; source?: string; stats?: Record<string, number>; devices?: BusDev[] }>('/bus'),
    fw: {
      packages: () => call<{ packages: FwPackage[] }>('/firmware/packages').then(r => r.packages),
      /** Upload with progress (XHR): bulk archives can be large. onProgress gets 0..1 while uploading, then 1. */
      addPackages: (files: File[], onProgress?: (f: number) => void) => new Promise<FwImport>((resolve, reject) => {
        const fd = new FormData(); files.forEach(f => fd.append('package', f, f.name));
        const x = new XMLHttpRequest();
        x.open('POST', `${base}/firmware/packages`);
        x.upload.onprogress = e => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
        x.onload = () => {
          let j: (FwImport & { success?: boolean; error?: string }) | null = null;
          try { j = JSON.parse(x.responseText); } catch { /* */ }
          if (x.status >= 200 && x.status < 300 && j && j.success !== false) resolve(j);
          else reject(new Error((j && j.error) || (x.status === 404 ? 'The Azure Debugger service is not on this Pi yet.' : `HTTP ${x.status}`)));
        };
        x.onerror = () => reject(new Error('Upload failed (network)'));
        x.send(fd);
      }),
      downloadUrl: (id: string) => `${base}/firmware/packages/${id}/download`,
      libraryUrl: () => `${base}/firmware/library/export`,
      removePackage: (id: string) => call<unknown>(`/firmware/packages/${id}`, { method: 'DELETE' }),
      ports: () => call<{ ports: { path: string; manufacturer: string | null }[] }>('/firmware/ports').then(r => r.ports),
      scan: (b: { port: string; baud: number; from: number; to: number }) => call<FwScan & { success: boolean }>('/firmware/scan', json(b)),
      plan: (b: { packageId: string; board: FwBoard; reinstall?: boolean; bootloader?: string }) => call<{ plan: FwPlan }>('/firmware/plan', json(b)).then(r => r.plan),
      update: (b: { port: string; baud: number; address: number; serial: string; packageId: string; reinstall?: boolean; bootloader?: string; fragmentSize?: number }) => call<{ id: string }>('/firmware/update', json(b)),
      job: () => call<{ job: FwJob | null }>('/firmware/job').then(r => r.job),
      abort: () => call<unknown>('/firmware/job/abort', { method: 'POST' }),
      history: () => call<{ history: { t: number; endedAt: number; state: string; port: string; address: number; package: string; before: FwBoard | null; after: FwBoard | null; error: string | null }[] }>('/firmware/history').then(r => r.history),
    },
  };
}
export type AzureClient = ReturnType<typeof azureClient>;

/** Format a UTC time in the controller's own time zone. */
export function fmtAt(t: number | null | undefined, tz?: string, withDate = true) {
  if (t == null || !Number.isFinite(t)) return '—';
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz || undefined, month: withDate ? 'short' : undefined, day: withDate ? 'numeric' : undefined, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(t));
  } catch { return new Date(t).toISOString().replace('T', ' ').slice(0, 19); }
}
export const fmtMs = (ms: number | null | undefined) => (ms == null ? '—' : ms < 1000 ? `${Math.round(ms)} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : ms < 3600000 ? `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s` : `${(ms / 3600000).toFixed(1)} h`);
export const fixList = (f?: string | string[]) => (!f ? [] : Array.isArray(f) ? f : [f]);
