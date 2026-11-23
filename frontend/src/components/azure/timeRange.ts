// AETHER_AZURE_DEBUG — time range filter for an open scan (AZURE-14).
// clipScan() returns a copy of the scan with only what happened between `from` and `to`:
// alerts (findings and Azure checks) are kept only if they occurred in the range, with their
// in-range count, first/last and log lines; the path (hops) is re-coloured from what is left;
// board status changes, start-ups, syncs, relays and SDK frames are cut to the range too.
// Nothing is re-scanned: every alert already carries the time of each occurrence.
import { HOP_TEST } from './views';
import type { Finding, Hop, HopStatus, Scan } from './api';

export interface TimeRange { from: number; to: number }
export type RangeFinding = Finding & { inRange?: number; approx?: boolean; untimed?: boolean; first?: number | null; last?: number | null; times?: number[] };

const SEV_RANK: Record<string, number> = { high: 3, medium: 2, low: 1, info: 0 };
const fin = (t: unknown): t is number => typeof t === 'number' && Number.isFinite(t);

// ── wall clock in the controller's time zone <-> epoch ms ──
function parts(t: number, tz?: string) {
  const p: Record<string, string> = {};
  for (const x of new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(t))) p[x.type] = x.value;
  return p;
}
const offset = (t: number, tz?: string) => { const p = parts(t, tz); return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - Math.floor(t / 1000) * 1000; };
/** epoch ms → "YYYY-MM-DDTHH:mm" (for <input type="datetime-local">) in tz */
export function toWall(t: number, tz?: string) { const p = parts(t, tz); return `${p.year}-${p.month}-${p.day}T${String(+p.hour % 24).padStart(2, '0')}:${p.minute}`; }
/** "YYYY-MM-DDTHH:mm[:ss]" in tz → epoch ms (null if not a date) */
export function fromWall(s: string, tz?: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s || '');
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  const t1 = guess - offset(guess, tz);
  return guess - offset(t1, tz);          // second pass settles DST edges
}

/** Every timed thing in the scan: the range the user can pick from. */
export function scanSpan(s: Scan): TimeRange | null {
  const w = s.report.window;
  let from = w ? w.from : Infinity, to = w ? w.to : -Infinity;
  for (const f of [...(s.report.findings || []), ...(s.azure.checks || [])] as RangeFinding[]) {
    if (fin(f.first)) from = Math.min(from, f.first); if (fin(f.last)) to = Math.max(to, f.last);
    for (const x of f.samples || []) if (fin(x.t)) { from = Math.min(from, x.t); to = Math.max(to, x.t); }
  }
  return Number.isFinite(from) && Number.isFinite(to) ? { from, to } : null;
}

function clipFinding(f: RangeFinding, r: TimeRange, keepUntimed: boolean): RangeFinding | null {
  const inR = (t: unknown) => fin(t) && t >= r.from && t <= r.to;
  const timed = (f.samples || []).filter(x => fin(x.t));
  let n: number | undefined, first: number | null | undefined, last: number | null | undefined, approx = false;
  if (f.times && f.times.length) {
    const t = f.times.filter(inR).sort((a, b) => a - b); n = t.length; first = t[0] ?? null; last = t[t.length - 1] ?? null;
  } else if (timed.length) {
    const t = timed.map(x => x.t as number).filter(inR).sort((a, b) => a - b); n = t.length; first = t[0] ?? null; last = t[t.length - 1] ?? null;
    if (timed.length >= 20) approx = true;     // samples were capped at 20: there may be more (rescan for exact counts)
  } else if (fin(f.first) && fin(f.last)) {
    if (f.last < r.from || f.first > r.to) return null;       // span known, count per occurrence not
    return { ...f };
  } else return keepUntimed ? { ...f, untimed: true } : null;
  if (!n) return null;
  return { ...f, inRange: n, approx, first, last, samples: (f.samples || []).filter(x => !fin(x.t) || inR(x.t)) };
}

const HOPS_ORDER = ['cloud', 'delivery', 'sdk', 'bus', 'doors', 'config'];
export function rehop(old: Hop[], findings: Finding[], checks: Finding[]): Hop[] {
  const ids = old.length ? old.map(h => h.id) : HOPS_ORDER;
  return ids.map(id => {
    const h0 = old.find(h => h.id === id) || { id, label: id, sub: '', status: 'ok' as HopStatus, count: 0, top: [] };
    const test = HOP_TEST[id] || (() => false);
    const all = [
      ...findings.filter(x => test(x) && !/archived logs/.test(x.title || '')).map(x => ({ id: x.id, sev: x.sev, title: x.title, src: 'analytics' })),
      ...checks.filter(test).map(x => ({ id: x.id, sev: x.sev, title: x.title, src: 'azure' })),
    ].sort((a, b) => (SEV_RANK[b.sev] || 0) - (SEV_RANK[a.sev] || 0));
    const worst = all.length ? SEV_RANK[all[0].sev] || 0 : 0;
    return { ...h0, status: (worst >= 3 ? 'bad' : worst === 2 ? 'warn' : 'ok') as HopStatus, count: all.length, top: all.slice(0, 6) };
  });
}

const wallLocal = (t: number, tz?: string) => toWall(t, tz).replace('T', ' ') + ':00';

/** The scan as it looked between r.from and r.to. */
export function clipScan(s: Scan, r: TimeRange, keepUntimed = true): Scan {
  const inR = (t: unknown) => fin(t) && t >= r.from && t <= r.to;
  const tz = s.report.zone?.tz;
  const findings = (s.report.findings || []).map(f => clipFinding(f as RangeFinding, r, keepUntimed)).filter(Boolean) as Finding[];
  // scans made before AZURE-14 have no occurrence times on "went offline" checks: take them from the status log
  const withTimes = (s.azure.checks || []).map(f => {
    const g = f as RangeFinding;
    if (g.id !== 'bus.offline-events' || (g.times && g.times.length)) return g;
    const key = /^(\S+ \d+-\d+-\d+)/.exec(g.samples?.[0]?.text || '')?.[1];
    const times = key ? (s.azure.deviceStatus || []).filter(x => x.state === 'offline' && `${x.kind} ${x.node}-${x.lda}-${x.idx}` === key).map(x => x.t) : [];
    return times.length ? { ...g, times } : g;
  });
  const checks = withTimes.map(f => clipFinding(f, r, keepUntimed)).filter(Boolean) as Finding[];
  const a = s.azure;
  const deviceStatus = (a.deviceStatus || []).filter(x => inR(x.t));
  const relays = (a.relays || []).filter(x => !(x.last < r.from || x.first > r.to));
  const boards = (a.boards || []).map(b => {
    const st = deviceStatus.filter(x => x.kind === 'board' && x.lda === b.lda);
    return { ...b, offline: st.filter(x => x.state === 'offline').length, online: st.filter(x => x.state === 'online').length,
      lastEvent: st.length ? st[st.length - 1] : null, relayChanges: relays.filter(x => x.lda === b.lda).reduce((n, x) => n + x.toggles, 0) };
  });
  const w0 = s.report.window;
  const window = { from: w0 ? Math.max(w0.from, r.from) : r.from, to: w0 ? Math.min(w0.to, r.to) : r.to };
  return {
    meta: s.meta,
    report: { ...s.report, clipped: true, findings, frames: (s.report.frames || []).filter(x => inR(x.t)), window, windowLocal: { from: wallLocal(window.from, tz), to: wallLocal(window.to, tz) } },
    azure: {
      ...a, checks, deviceStatus, relays, boards,
      lifecycle: (a.lifecycle || []).filter(x => inR(x.t)),
      sync: (a.sync || []).filter(x => inR(x.t)),
      osdp: { ...a.osdp, sample: (a.osdp?.sample || []).filter(x => inR(x.t)) },
      hops: rehop(a.hops || [], findings, checks),
    },
  };
}

/** How many alerts the scan has, and how many are left after clipping. */
export const alertCount = (s: Scan) => (s.report.findings || []).length + (s.azure.checks || []).length;
