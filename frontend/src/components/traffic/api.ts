// AETHER_TRAFFIC — thin client for /api/traffic (Traffic Inspector, built on mitmproxy)
export interface DeviceRoute { listenPort: number; target: string; name: string }
export interface GatewaySettings { enabled: boolean; devices: string[]; decrypt: boolean; port: number; dnsPort: number }
export interface Settings { proxyEnabled: boolean; proxyPort: number; devices: DeviceRoute[]; onlyHosts: string; autoStopMin: number; bodyMaxKB: number; gateway: GatewaySettings }
export interface Listener { kind: 'proxy' | 'device' | 'gateway'; port: number; target?: string; name?: string; devices?: string[]; dnsPort?: number; decrypt?: boolean }
export interface HelperStatus { installed: boolean; current?: boolean; version?: number; gateway?: boolean; forwarding?: boolean; devices?: string; pcap?: boolean; tcpdump?: boolean; error?: string }
export interface PcapStatus { running: boolean; tcpdump: boolean; bytes: number; mode?: 'devices' | 'all'; iface?: string; devices?: string[]; startedAt?: number; stopAt?: number; limitMB?: number; endedAt?: number | null; endReason?: string | null }
export interface Status {
  installed: boolean; binary: string | null; version: string | null;
  state: 'stopped' | 'starting' | 'running' | 'stopping' | 'error'; error: string | null;
  settings: Settings; running: Settings | null; listeners: Listener[]; startedAt: number | null; autoStopAt: number | null;
  addresses: { iface: string; address: string }[]; interfaces: string[]; count: number; seq: number; caReady: boolean; sessionBytes: number;
  helper: HelperStatus | null; setupCommand: string; forwarding: string[]; pcap: PcapStatus;
}
export interface SunapiTag { root: string; cgi: string; submenu: string; action: string }
export type Kind = 'http' | 'tcp' | 'udp' | 'dns' | 'tls';
export interface FlowSummary {
  id: string; seq: number; ts: number; client: string; mode: string; kind: Kind; pending: boolean; error: string | null;
  method: string; scheme: string; host: string; port: number; path: string;
  status: number | null; reqBytes: number; resBytes: number | null; ms: number | null; contentType: string; sunapi: SunapiTag | null; challenge: boolean;
  ws: { count: number; up: number; down: number; closed: boolean } | null;
  stream?: { count: number; up: number; down: number; closed: boolean; sni: string | null };
  dns?: { question: string; answers: string[]; rcode: string };
  tls?: { sni: string | null; alpn: string[]; failed: boolean };
}
export interface Message { headers: [string, string][]; body: string | null; bodyEncoding: 'utf8' | 'base64'; bytes: number; truncated: boolean; httpVersion: string }
export interface StreamMsg { fromClient: boolean; ts: number; data: string | null; encoding: 'utf8' | 'base64'; bytes: number; truncated: boolean; text?: boolean }
export interface Flow {
  id: string; seq: number; ts: number; client: string; mode: string; kind: Kind; clientTls: boolean; pending: boolean; error: string | null; sunapi: SunapiTag | null;
  request: Message & { method: string; scheme: string; host: string; port: number; path: string; tsEnd?: number };
  response: (Message & { status: number; reason: string; tsStart?: number; tsEnd?: number; locationWas?: string }) | null;
  ws?: { messages: StreamMsg[]; count: number; up: number; down: number; closed?: boolean; closeCode?: number | null; dropped?: number };
}
export interface StreamFlow { id: string; kind: 'tcp' | 'udp'; ts: number; client: string; mode: string; server: [string, number]; sni: string | null; messages: StreamMsg[]; count: number; up: number; down: number; closed: boolean; error: string | null; dropped?: number }
export interface DnsRecord { name: string; type: string; class?: string; ttl?: number; data: string }
export interface DnsMsg { questions?: { name: string; type: string; class?: string }[]; answers?: DnsRecord[]; authorities?: DnsRecord[]; additionals?: DnsRecord[]; response_code?: string; [k: string]: unknown }
export interface DnsFlow { id: string; kind: 'dns'; ts: number; client: string; mode: string; request: DnsMsg | null; response: DnsMsg | null; error: string | null; pending: boolean }
export interface TlsFlow { id: string; kind: 'tls'; ts: number; client: string; mode: string; server: [string, number]; sni: string | null; alpn: string[]; failed: boolean; error: string | null }
export type AnyFlow = Flow | StreamFlow | DnsFlow | TlsFlow;
export interface FlowList { seq: number; epoch: number; count: number; flows: FlowSummary[] }

export const defaultBackend = () => (typeof window === 'undefined' ? 'http://localhost:3001' : `${window.location.protocol}//${window.location.hostname}:3001`);

export function trafficClient(backend: string) {
  const base = `${backend.replace(/\/$/, '')}/api/traffic`;
  async function call<T>(p: string, opt: { method?: string; body?: unknown } = {}): Promise<T> {
    const r = await fetch(base + p, {
      method: opt.method || 'GET',
      headers: opt.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: opt.body !== undefined ? JSON.stringify(opt.body) : undefined,
    });
    const ct = r.headers.get('content-type') || '';
    const data = ct.includes('json') ? await r.json() : await r.text();
    if (!r.ok) {
      const msg = (data && typeof data === 'object' && (data as { error?: string }).error) || (r.status === 404 ? 'The Traffic Inspector service is not on this Pi yet (404)' : `HTTP ${r.status}`);
      throw Object.assign(new Error(msg), { status: r.status });
    }
    return data as T;
  }
  /** Downloads go through fetch so they work the same through the cluster gateway. */
  async function save(p: string, fallbackName: string) {
    const r = await fetch(base + p);
    if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error((d as { error?: string }).error || `HTTP ${r.status}`); }
    const name = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') || '')?.[1] || fallbackName;
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement('a'); a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return {
    status: () => call<Status>('/status'),
    saveSettings: (s: Settings) => call<Settings>('/settings', { method: 'PUT', body: s }),
    start: () => call<Status>('/start', { method: 'POST', body: {} }),
    stop: () => call<Status>('/stop', { method: 'POST', body: {} }),
    releaseGateway: () => call<Status>('/gateway/release', { method: 'POST', body: {} }),
    flows: (since = 0) => call<FlowList>(`/flows?since=${since}`),
    flow: (id: string) => call<AnyFlow>(`/flows/${encodeURIComponent(id)}`),
    clear: () => call<{ ok: boolean }>('/flows', { method: 'DELETE' }),
    log: () => call<{ lines: string[] }>('/log'),
    pcapStart: (o: { mode: 'devices' | 'all'; iface: string; devices: string[]; limitMB: number; minutes: number }) => call<Status>('/pcap/start', { method: 'POST', body: o }),
    pcapStop: () => call<Status>('/pcap/stop', { method: 'POST', body: {} }),
    savePcap: () => save('/capture.pcap', 'aether-capture.pcap'),
    pcapBuffer: async () => { const r = await fetch(base + '/capture.pcap'); if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error((d as { error?: string }).error || `HTTP ${r.status}`); } return r.arrayBuffer(); },
    saveHar: (ids?: string[]) => save(`/export.har${ids && ids.length ? `?ids=${ids.map(encodeURIComponent).join(',')}` : ''}`, 'aether-traffic.har'),
    saveMitm: () => save('/export.mitm', 'aether-traffic.mitm'),
    saveCa: (fmt: 'cer' | 'pem' | 'p12') => save(`/ca/${fmt}`, `aether-capture-ca.${fmt}`),
  };
}
export type TrafficClient = ReturnType<typeof trafficClient>;
