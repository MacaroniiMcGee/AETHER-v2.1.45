// AETHER_CLUSTER: the cluster list lives on the main Pi (the one you signed in to).
// Enrolled nodes are reached through it at /n/<host>:<port>/..., so one sign-in,
// HTTPS and a tunnel cover all of them.

export type NodeKey = 'self' | string;   // 'self' or "host:port"

export interface ServerNode { key: string; host: string; port: number; name: string; color: string; claimedAt: string }
export interface ClusterInfo {
  hubId: string;
  self: { name: string; color: string; hosts: string[] };
  nodes: ServerNode[];
  managedBy: { name: string; url: string | null; since: string }[];
}
export interface Camera {
  id: string; name: string; url: string; transport: 'tcp' | 'udp'; createdAt: string;
  source?: { vendor: string; host: string; model?: string; channel?: number } | null;
  live: { ready: boolean; readers: number; tracks: string[] };
}
/** The node's own tile: its built-in Aether stream (default) or an IP camera. */
export interface PrimaryTile {
  id: 'main'; type: 'builtin' | 'camera'; name: string; url?: string; transport?: 'tcp' | 'udp'; available?: boolean;
  live: { ready: boolean; readers: number; tracks: string[] };
}
export interface CameraList { streaming: boolean; error: string | null; primary?: PrimaryTile; cameras: Camera[] }

/** Backend origin: '' normally; the Pi's :3001 when the page comes from the Vite dev server. */
export const apiBase = (): string =>
  (typeof window !== 'undefined' && window.location.port === '5173') ? `${window.location.protocol}//${window.location.hostname}:3001` : '';

export const nodeApi = (key: NodeKey): string => (key === 'self' ? apiBase() : `${apiBase()}/n/${key}`);
export const hlsUrl = (key: NodeKey, cameraId: string): string => `${nodeApi(key)}/api/cameras/${cameraId}/hls/index.m3u8`;

export class ApiError extends Error { field?: string; status?: number; constructor(m: string, field?: string, status?: number) { super(m); this.field = field; this.status = status; } }

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  let r: Response;
  try {
    r = await fetch(url, { credentials: 'include', cache: 'no-store', ...init, headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...(init?.headers || {}) } });
  } catch {
    throw new ApiError('Could not reach the Pi');
  }
  let j: any = null;
  try { j = await r.json(); } catch { /* not JSON */ }
  if (!r.ok || !j || j.success === false) throw new ApiError((j && j.error) || `HTTP ${r.status}`, j && j.field, r.status);
  return j as T;
}

/** null when this backend has no cluster support (older update): the page keeps its old per-browser list. */
export async function getCluster(): Promise<ClusterInfo | null> {
  try { return await call<ClusterInfo>(`${apiBase()}/api/cluster/nodes`); }
  catch (e) { if (e instanceof ApiError && (e.status === 404 || e.status === undefined)) return null; throw e; }
}
export const claimNode = (b: { host: string; port: number; username: string; password: string; name: string }) =>
  call<{ node: ServerNode }>(`${apiBase()}/api/cluster/claim`, { method: 'POST', body: JSON.stringify({ ...b, hubUrl: window.location.origin }) });
export const renameNode = (key: NodeKey, name: string) =>
  key === 'self'
    ? call(`${apiBase()}/api/cluster/self`, { method: 'PATCH', body: JSON.stringify({ name }) })
    : call(`${apiBase()}/api/cluster/nodes/${encodeURIComponent(key)}`, { method: 'PATCH', body: JSON.stringify({ name }) });
export const removeNode = (key: string) =>
  call<{ nodeInformed: boolean }>(`${apiBase()}/api/cluster/nodes/${encodeURIComponent(key)}`, { method: 'DELETE' });

export const listCameras = (key: NodeKey) => call<CameraList>(`${nodeApi(key)}/api/cameras`);
export const addCamera = (key: NodeKey, b: { name: string; url: string; transport: 'tcp' | 'udp' }) =>
  call<{ camera: Camera; streaming: boolean; error: string | null }>(`${nodeApi(key)}/api/cameras`, { method: 'POST', body: JSON.stringify(b) });
export const setPrimary = (key: NodeKey, b: { type: 'builtin' } | { type: 'camera'; name: string; url: string; transport: 'tcp' | 'udp' }) =>
  call<{ primary: PrimaryTile; streaming: boolean; error: string | null }>(`${nodeApi(key)}/api/cameras/primary`, { method: 'PUT', body: JSON.stringify(b) });
export const deleteCamera = (key: NodeKey, id: string) => call(`${nodeApi(key)}/api/cameras/${id}`, { method: 'DELETE' });

// ---- Hanwha discovery (the Pi's SUNAPI scan) ----
export interface ScanHost { ip: string; port?: number; https?: boolean; model?: string; name?: string; deviceName?: string; mac?: string; vendor?: string; kind?: string; sunapi?: string; onvif?: boolean }
export interface ScanJob { id: string; state: 'running' | 'done' | 'cancelled' | 'error'; phase: string; done: number; total: number; error?: string; ranges: string; results: ScanHost[] }
export const startScan = (key: NodeKey, ranges?: string) =>
  call<ScanJob>(`${nodeApi(key)}/api/sunapi/scan`, { method: 'POST', body: JSON.stringify({ onvif: true, sweep: true, ranges: ranges || '' }) }).catch((e: ApiError) => {
    if (e.status === 404) throw new ApiError('This Pi has no SUNAPI Console yet, which camera search needs. Install the SUNAPI update on it, or type an RTSP address instead.');
    throw e;
  });
export const getScan = (key: NodeKey, id: string) => call<ScanJob>(`${nodeApi(key)}/api/sunapi/scan/${id}`);
export const cancelScan = (key: NodeKey, id: string) => call(`${nodeApi(key)}/api/sunapi/scan/${id}/cancel`, { method: 'POST' }).catch(() => {});
export interface HanwhaResult { ip: string; ok: boolean; model?: string; added?: string[]; skipped?: number; error?: string }
export const addHanwha = (key: NodeKey, b: { devices: { ip: string; port?: number; https?: boolean; name?: string }[]; user: string; password: string; quality: 'sub' | 'main' }) =>
  call<{ results: HanwhaResult[]; streaming: boolean; error: string | null }>(`${nodeApi(key)}/api/cameras/hanwha`, { method: 'POST', body: JSON.stringify(b) });
