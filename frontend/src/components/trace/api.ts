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
  status: 'pass' | 'warn' | 'fail'; notes: string[]; latency: { decision: number | null; push: number | null; api: number | null; output?: number | null; hardware?: number | null; ack?: number | null; reader?: number | null };
  reader?: { colour: string; flash: boolean; beep: string | null } | null;
}
export interface Stat { n: number; min?: number; p50?: number; p95?: number; max?: number }
export interface SyncResult { at: number; fc?: number; cn?: string; ch?: string; v?: number; set: string; idx: number; matched: boolean; eventT: number | null; type: string | null; offset: number | null; byPattern?: boolean }
export interface Analysis {
  meta: { id: string; name: string; start: number; end: number | null; endReason?: string; syncError?: string; imports: { at: number; what: string; count: number }[]; count: number; running: boolean; controllerClocks?: ClockCheck | null } | null;
  clock: { offset: number | null; drift: { startMs: number; endMs: number; changeMs: number; perHourMs: number | null } | null; sync: SyncResult[]; gaps: { set: string; sent: number; seen: number }[] };
  traces: Trace[]; unexplained: { type: string; t: number; at: number; cred: Cred | null; door: { id: string | null; name: string | null } | null; sources: Src[] }[];
  stats: KindStats & { unexplained: number; byKind: Record<Kind, KindStats> };
  roles: Record<string, Role>;
  integrity?: Integrity;
}
// ── TRACE-4 ──────────────────────────────────────────────────────────────
export interface IntegrityItem { type: string; t: number | null; at: number | null; door: string | null; cred: Cred | null; eventId: string | null; controllerId: string | null; where: string; copies?: number; gapMs?: number; byMs?: number; after?: IntegrityItem | null }
export interface Integrity { counts: { push: number; eventLog: number; controllerLog: number; har: number; uniquePushed: number }; verdict: 'pass' | 'warn' | 'fail' | 'no-data'; issues: number; lostInPush: IntegrityItem[]; notInLog: IntegrityItem[]; onlyInLog: IntegrityItem[]; duplicates: IntegrityItem[]; outOfOrder: IntegrityItem[]; apiOn: boolean }
export type StepKind = 'card' | 'rex' | 'dps' | 'command' | 'wait';
export interface StepExpect { result?: 'grant' | 'deny' | 'any'; events?: string[]; noEvents?: string[]; strike?: 'on' | 'off' | 'stays-on' | 'any'; minMs?: number; maxMs?: number; output?: string; withinMs?: number }
export interface Step { kind: StepKind; label?: string; door?: number | null; fc?: string; cn?: string; format?: string; holdMs?: number; state?: 'open' | 'close'; cmd?: 'override' | 'maintenance' | 'shunt' | 'lockdown'; value?: unknown; seconds?: number; ms?: number; expect?: StepExpect; afterMs?: number }
export interface Sequence { id?: string; name: string; note?: string; steps: Step[]; repeat: number; minutes: number; gapMs: number; sync: boolean; updatedAt?: number }
export interface TemplateInfo { id: string; label: string; hint: string }
export interface TestStatus { state: 'running' | 'grading' | 'done'; seqId: string; name: string; runId: string | null; startedAt: number; endedAt: number | null; iter: number; repeat: number; until: number | null; idx: number; steps: number; done: number; errors: number; abort: boolean; error: string | null; verdict: string | null; last: { iter: number; idx: number; text: string; at: number; error: string | null }[] }
export interface StepResult { iter: number; idx: number; kind: StepKind; text: string; door: string | null; at: number; status: 'pass' | 'warn' | 'fail' | 'error' | 'skipped'; checks: { what: string; want: string; got: string }[]; why: string[]; latency: { decision?: number | null; push?: number | null; api?: number | null; ack?: number | null; output?: number | null }; traceId: string | null; result?: string | null; held?: number | null }
export interface StepAgg { idx: number; text: string; kind: StepKind; runs: number; pass: number; warn: number; fail: number; decision: Stat; push: Stat; output: Stat }
export interface TestReport { runId: string; sequence: { id: string; name: string }; startedAt: number; endedAt: number | null; aborted: boolean; error: string | null; who: string; repeat: number; minutes: number; iterations: number;
  report: { steps: StepResult[]; byStep: StepAgg[]; totals: { steps: number; pass: number; warn: number; fail: number; skipped: number; verdict: string }; series: { at: number; iter: number; idx: number; decision: number | null; push: number | null; status: string }[]; health: { samples: number; pushDrops: number } } }
export interface TestRunMeta { id: string; name: string; start: number; end: number | null; sequence: { id: string; name: string }; aborted: boolean }
export type Moved = 'same' | 'worse' | 'better' | 'only-one';
export interface Comparison {
  a: { id: string; name: string; start: number; verdict: string }; b: { id: string; name: string; start: number; verdict: string };
  summary: { worse: number; better: number; newFail: number; fixed: number; onlyA: number; onlyB: number };
  hops: { kind: string; hop: string; label: string; a: { n: number; p50: number | null; p95: number | null; max: number | null }; b: { n: number; p50: number | null; p95: number | null; max: number | null }; p50: Moved; p95: Moved }[];
  counts: Record<string, { a: { actions: number; pass: number; warn: number; fail: number }; b: { actions: number; pass: number; warn: number; fail: number } }>;
  newFail: { kind: string; label: string; expect: string | null; why: string; at: number }[]; fixed: { kind: string; label: string; expect: string | null; why: string; at: number }[];
  types: { onlyA: { type: string; n: number }[]; onlyB: { type: string; n: number }[] };
  clock: { a: { offset: number | null; drift: number | null }; b: { offset: number | null; drift: number | null } };
  integrity: Record<string, { a: number; b: number }> | null;
  steps: { idx: number; text: string; a: { runs: number; pass: number; fail: number; decision: number | null; push: number | null } | null; b: { runs: number; pass: number; fail: number; decision: number | null; push: number | null } | null; result: Moved; decision: Moved; push: Moved }[] | null;
  rule: string;
}
export interface ControllerClock { id: string; name: string; host: string; model: string | null; at?: number; offsetMs?: number; rttMs?: number; resolutionMs?: number; sync?: string | null; ntp?: string | null; tz?: string | null; error?: string; fields?: string[] }
export interface ClockCheck { available: boolean; reason?: string; at?: number; warnMs?: number; controllers: ControllerClock[] }
export interface JiraStatus { site: string; email: string; hasToken: boolean; configured: boolean; me?: { name: string } | null }
export interface JiraIssue { key: string; summary: string; status?: string; attachments: { id: string; filename: string; size: number; created: string; author?: string }[]; hars: { id: string; filename: string; size: number; created: string; author?: string }[] }
export interface SuggestRow { ch: string; role: string; door: string | null; active?: 'open' | 'closed'; source: 'probe' | 'doors page' | 'seen'; confidence: number; why: string[]; terminal: { kind: string; n?: number; id?: string; board?: number; label: string }; current: { role: string; door: string | null; active: string | null } | null; differs: boolean; aetherDoor?: number }
export interface SuggestSlot { ch: string; terminal: SuggestRow['terminal']; source: string; active: string | null }
export interface SuggestDoor { door: string; name: string; controllerId: string | null; reader: SuggestSlot | null; dps: SuggestSlot | null; rex: SuggestSlot | null; lock: SuggestSlot | null; inputs: SuggestSlot[]; outputs: SuggestSlot[] }
export interface Suggestion { at: number; rows: SuggestRow[]; controllers: { id: string; name: string; model: string; doors: SuggestDoor[] }[]; differs: number; probeAt: number | null }
export interface DiscoverStatus { state: 'running' | 'done'; at: number; end?: number | null; who: string; step?: string; done: number | null; total: number | null; error: string | null; aborted?: boolean;
  relays: { ch: string; role: string | null; door: string | null; doorName: string | null; active?: string; events: { type: string; door: string | null }[] }[]; readers: { ch: string; name: string; door: string | null; doorName: string | null; type: string | null }[]; locks: { door: string; doorName: string; ok: boolean; error: string | null; ch: string | null; ms: number | null }[] }
export interface Alert { seq: number; at: number; traceAt: number; traceId: string; runId: string | null; status: 'fail' | 'warn'; kind: Kind; label: string; why: string; door: string | null }
export interface DoorRow { id: number; name: string; enabled?: boolean; oncafe: { id: string; name: string | null } | null; note?: string | null; reader?: string | null; channels: { key: string; role: string; label?: string; overridden?: boolean }[] }
export interface KindStats { actions: number; pass: number; warn: number; fail: number; decision: Stat; push: Stat; api: Stat; decisionToPush: Stat; output: Stat; hardware: Stat; ack: Stat; reader?: Stat; credMismatch: number; unexplained?: number; verdict: 'pass' | 'warn' | 'fail' | 'no-data' }
export interface Role { role: string; door?: string; active?: 'open' | 'closed'; ioId?: string; label?: string; auto?: boolean; score?: number; kind?: string; count?: number }
/** Version of a wiring map (newest entry time): sent back on save so a stale tab cannot overwrite newer door imports. */
export const wiringVersion = (w: Record<string, { at?: number }>) => Math.max(0, ...Object.values(w || {}).map(e => Number(e.at) || 0));
export type Wiring = Record<string, { role: string; door?: string; active?: 'open' | 'closed'; ioId?: string; label?: string; note?: string; src?: string; at?: number; dir?: 'in' | 'out'; doorName?: string; via?: string; pin?: boolean; was?: Record<string, unknown>; reset?: boolean }>;
export interface SeenChannel { ch: string; kind: string; count: number; last: number; inferred: Role | null }
export interface InvDoor { id: string; name: string; controllerId: string; areaIds: string[]; locationId?: string }
export interface InvArea { id: string; name: string; locationId: string; location: string; tz: string | null }
export interface InvZone { id: string; name: string; type: string; state: string }
export interface Settings {
  cloud: { url: string; org: string; controllers: string[]; doors: string[]; zones: string[]; poll: boolean; pollMs: number; autoConnect: boolean; doorConfig: Record<string, { grantMs: number | null; extendedMs: number | null; name: string }> };
  sync: { channel: { kind: 'wiegand' | 'osdp' | 'emu' | 'relay' | 'emu-in'; readerId: string; address: number; port: number; relay: number; input: number }; format: string; cards: { fc: number; cn: string }[]; gapsMs: number[]; atStart: boolean; atEnd: boolean; everyMin: number };
  wire: { controllerIps: string[] };
  thresholds: { decisionWarn: number; decisionFail: number; pushWarn: number; pushFail: number; matchWindowMs: number; inputWindowMs: number; outputWindowMs: number; commandWarn: number; commandFail: number; heldToleranceMs: number };
  commands: { enabled: boolean };
  alerts?: { enabled: boolean; level: 'fail' | 'warn'; automation: boolean };
  clock?: { check: boolean; warnMs: number };
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
  me?: { admin: boolean };
  pendingReverts?: { id: string; due: number; kind: string; value: unknown; target: string | string[] }[];
  inventory: { org: string; at: number; doors: InvDoor[]; areas: InvArea[]; zones: InvZone[]; controllers: Inventory['controllers'] } | null;
  test?: TestStatus | null; alertSeq?: number; alerts?: Alert[]; clockCheck?: ClockCheck | null;
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
    saveWiring: (wiring: Wiring, base?: number) => call<{ wiring: Wiring }>('/wiring', { method: 'PUT', body: { wiring, base } }),
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
    // TRACE-4
    tests: () => call<{ sequences: Sequence[]; templates: TemplateInfo[]; current: TestStatus | null; runs: TestRunMeta[] }>('/tests'),
    saveTest: (q: Sequence) => q.id ? call<Sequence>(`/tests/${encodeURIComponent(q.id)}`, { method: 'PUT', body: q }) : call<Sequence>('/tests', { method: 'POST', body: q }),
    delTest: (id: string) => call<{ ok: boolean }>(`/tests/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    template: (b: { kind: string; door: number | null; fc?: string; cn?: string; badCn?: string; grantMs?: number; heldMs?: number; output?: string }) => call<{ steps: Step[] }>('/tests/template', { method: 'POST', body: b }),
    runTest: (id: string, o: { repeat?: number; minutes?: number; gapMs?: number }) => call<{ current: TestStatus }>(`/tests/${encodeURIComponent(id)}/run`, { method: 'POST', body: o }),
    stopTest: () => call<{ current: TestStatus | null }>('/tests/stop', { method: 'POST', body: {} }),
    testReport: (runId: string) => call<TestReport>(`/runs/${encodeURIComponent(runId)}/test`),
    saveTestCsv: (runId: string) => save(`/runs/${encodeURIComponent(runId)}/test.csv`, `${runId}-test.csv`),
    compare: (a: string, b: string) => call<Comparison>(`/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`),
    alerts: (since: number) => call<{ seq: number; alerts: Alert[] }>(`/alerts?since=${since}`),
    doors: () => call<{ doors: DoorRow[] }>('/doors'),
    // TRACE-5
    clocks: () => call<ClockCheck>('/clocks'),
    jira: () => call<JiraStatus>('/jira'),
    saveJira: (b: { site?: string; email?: string; token?: string; test?: boolean }) => call<JiraStatus>('/jira', { method: 'PUT', body: b }),
    jiraIssue: (key: string) => call<JiraIssue>(`/jira/issue/${encodeURIComponent(key)}`),
    importJira: (id: string, key: string, attachmentId: string) => call<{ imported: number; from: string }>(`/runs/${encodeURIComponent(id)}/import/jira`, { method: 'POST', body: { key, attachmentId } }),
    sendJira: (id: string, key: string, comment: boolean) => call<{ key: string; attached: { id: string; filename: string }[]; commented: boolean }>(`/runs/${encodeURIComponent(id)}/jira`, { method: 'POST', body: { key, comment } }),
    suggest: () => call<Suggestion>('/suggest'),
    applySuggestion: (channels: string[]) => call<{ applied: string[]; skipped: { ch: string; why: string }[] }>('/suggest/apply', { method: 'POST', body: { channels } }),
    discover: (o: { relays?: number[]; readers?: boolean; locks?: boolean; holdMs?: number; watchMs?: number }) => call<{ current: DiscoverStatus }>('/discover', { method: 'POST', body: o }),
    discoverStatus: () => call<{ current: DiscoverStatus | null }>('/discover'),
    stopDiscover: () => call<{ current: DiscoverStatus | null }>('/discover/stop', { method: 'POST', body: {} }),
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
