// Shared credential-format library for the Readers pages.
// Formats come from GET /api/formats; every entry carries an exact bit map
// (backend/lib/credentialMap.js) so the page shows exactly what will be sent.
import { useCallback, useEffect, useState } from 'react';

export type FieldKey = 'facility' | 'card' | 'issue' | 'tech' | 'agency' | 'extra' | 'fixed';
export interface MapField { key: FieldKey | string; start: number; len: number; value?: number; label?: string }
export interface MapParity { bit: number; type: 'even' | 'odd' | 'xor'; covers: number[]; len?: number }
export interface BitMap {
  bits: number; fields: MapField[]; parity: MapParity[];
  scramble?: Record<string, number[]>; status?: string; source?: string; note?: string;
}
export interface Fmt {
  id: string; name: string; category: string; bits: number;
  facilityBits: number; cardBits: number; issueLevel?: number;
  maxFacility: number | string; maxCard: number | string; maxIssueLevel: number | string;
  status: 'verified' | 'defined' | 'custom' | 'confirmed'; libraryStatus?: string; confirmedAt?: string; statusNote?: string;
  map: BitMap; user?: boolean; description?: string; popularity?: string; manufacturer?: string; aliases?: string[];
}
export interface Segment { key: string; start: number; len: number; bits: string }

// ── one shared fetch for all components ──
let cache: { api: string; formats: Fmt[] } | null = null;
let inflight: Promise<Fmt[]> | null = null;
const listeners = new Set<() => void>();

async function load(api: string, force = false): Promise<Fmt[]> {
  if (!force && cache && cache.api === api) return cache.formats;
  if (!force && inflight) return inflight;
  inflight = fetch(`${api}/api/formats`).then(r => r.json()).then(j => {
    const formats: Fmt[] = (j.formats || []).filter((f: Fmt) => f && f.id && f.map);
    cache = { api, formats };
    listeners.forEach(fn => fn());
    return formats;
  }).finally(() => { inflight = null; });
  return inflight;
}

export function useFormatLibrary(api: string) {
  const [formats, setFormats] = useState<Fmt[]>(cache && cache.api === api ? cache.formats : []);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const fn = () => { if (cache && cache.api === api) setFormats(cache.formats); };
    listeners.add(fn);
    load(api).then(() => { fn(); setError(null); }).catch(e => setError(String(e.message || e)));
    return () => { listeners.delete(fn); };
  }, [api]);
  const reload = useCallback(() => load(api, true).then(() => setError(null)).catch(e => setError(String(e.message || e))), [api]);
  return { formats, error, loading: !formats.length && !error, reload };
}

// ── display helpers ──
export const FIELD_STYLE: Record<string, { color: string; label: string; short: string }> = {
  facility: { color: 'rgb(var(--hv-data-blue))', label: 'Facility code', short: 'FC' },
  card: { color: 'rgb(var(--hv-data-orange))', label: 'Card number', short: 'CN' },
  issue: { color: 'rgb(var(--hv-data-purple))', label: 'Issue level', short: 'IL' },
  tech: { color: 'rgb(var(--hv-data-sapphire))', label: 'Tech code', short: 'TC' },
  agency: { color: 'rgb(var(--hv-data-sapphire))', label: 'Agency code', short: 'AC' },
  extra: { color: 'rgb(var(--hv-data-gray))', label: 'Other field (sent as 0)', short: '··' },
  fixed: { color: 'rgb(var(--hv-line-strong))', label: 'Fixed bits', short: 'FX' },
  pad: { color: 'rgb(var(--hv-line))', label: 'Unused', short: '' },
  'parity-even': { color: 'rgb(var(--hv-data-green))', label: 'Even parity', short: 'EP' },
  'parity-odd': { color: 'rgb(var(--hv-data-red))', label: 'Odd parity', short: 'OP' },
  parity: { color: 'rgb(var(--hv-data-yellow))', label: 'Checksum', short: 'CK' },
};

export const CATEGORY_LABEL: Record<string, string> = {
  wiegand: 'Wiegand', hid: 'HID', wavelynx: 'Wavelynx', csn: 'Card serial', awid: 'AWID', indala: 'Indala',
  em: 'EM', mifare: 'MIFARE', piv: 'PIV', twic: 'TWIC / CAC', proprietary: 'Other vendors', generic: 'Generic', custom: 'My formats',
};

export const fmtMax = (v: number | string) => {
  const s = String(v);
  return s.length > 12 ? `2^${BigInt(s).toString(2).length}−1` : Number(s).toLocaleString();
};

export function fieldsOf(f: Fmt) {
  const has = (k: string) => (f.map.fields || []).some(x => x.key === k) || !!(f.map.scramble && f.map.scramble[k]);
  return { facility: has('facility'), card: has('card'), issue: has('issue') };
}

export function randomIn(max: number | string): string {
  const m = BigInt(String(max));
  if (m <= 0n) return '0';
  if (m < 2n ** 52n) return String(Math.floor(Math.random() * (Number(m) + 1)));
  let s = '';
  const digits = m.toString().length;
  for (let i = 0; i < digits; i++) s += Math.floor(Math.random() * 10);
  return (BigInt(s) % (m + 1n)).toString();
}

// PIN frames, same rules as the backend (lib/credentialMap.pinFrames)
export type PinMode = 'combined' | 'per-key-8' | 'per-key-4';
const KEYV: Record<string, number> = { '0': 0, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '*': 10, '#': 11 };
export function pinFrames(pin: string, mode: PinMode, terminator: string): string[] {
  const keys = pin.split('').concat(terminator ? [terminator] : []).filter(k => k in KEYV);
  const eight = (k: string) => (((~KEYV[k]) & 0xF) << 4 | KEYV[k]).toString(2).padStart(8, '0');
  const four = (k: string) => KEYV[k].toString(2).padStart(4, '0');
  if (mode === 'per-key-4') return keys.map(four);
  if (mode === 'per-key-8') return keys.map(eight);
  return keys.length ? [keys.map(eight).join('')] : [];
}

export const binToHex = (b: string) => {
  if (!b) return '';
  const n = Math.ceil(b.length / 8) * 8;
  const p = b.padEnd(n, '0');
  let h = '';
  for (let i = 0; i < n; i += 8) h += parseInt(p.slice(i, i + 8), 2).toString(16).padStart(2, '0');
  return h.toUpperCase();
};
