// readerDirectory.ts — AETHER_READER_DIR (Update 71)
//
// Every reader enrolled on this Pi, for pages that associate a reader with a door:
//   Wiegand: GET /api/wiegand/config  -> doors[] {door, name, d0, d1, readerId}
//            id 'wg-<door>'; cards go out on /api/wiegand/transmit with its D0/D1 pins
//   OSDP:    GET /api/osdp/readers    -> readers[] {id, name, address, enabled, status}
//            id 'osdp-<reader id>'; cards go out on /api/osdp/card-read
// Emulated board readers ('ctrl-emu-<addr>-<port>') are handled by the pages.
//
// Older doors saved a fixed local pool id ('reader1'..'reader4' with D0/D1 pins).
// resolveLegacyReaderId() maps those to the enrolled Wiegand reader on the same pins.

export type DirReader = {
  id: string;
  type: 'wiegand' | 'osdp';
  name: string;
  enabled: boolean;
  d0?: number;
  d1?: number;
  address?: number;
  wiegandDoor?: number;
  osdpId?: string;
  status?: string;
};

async function getJson(url: string, timeoutMs = 6000): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    const text = await r.text();
    let j: any = null;
    try { j = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!r.ok) throw new Error((j && (j.error || j.message)) || `HTTP ${r.status}`);
    return j;
  } finally { clearTimeout(t); }
}

async function postJson(url: string, body: any, timeoutMs = 8000): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
    const text = await r.text();
    let j: any = null;
    try { j = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!r.ok || (j && (j.success === false || j.ok === false))) throw new Error((j && (j.error || j.message)) || `HTTP ${r.status}`);
    return j || {};
  } finally { clearTimeout(t); }
}

/** Load every enrolled Wiegand and OSDP reader. A source that fails is skipped (errors listed). */
export async function loadEnrolledReaders(base: string): Promise<{ readers: DirReader[]; errors: string[] }> {
  const readers: DirReader[] = [];
  const errors: string[] = [];
  const [wg, os] = await Promise.allSettled([getJson(`${base}/api/wiegand/config`), getJson(`${base}/api/osdp/readers`)]);
  if (wg.status === 'fulfilled') {
    for (const d of (wg.value && Array.isArray(wg.value.doors) ? wg.value.doors : [])) {
      const n = Number(d && d.door);
      if (!Number.isFinite(n)) continue;
      readers.push({
        id: `wg-${n}`, type: 'wiegand', name: d.name || `Wiegand reader ${n}`, enabled: true,
        d0: d.d0 !== undefined ? Number(d.d0) : undefined, d1: d.d1 !== undefined ? Number(d.d1) : undefined, wiegandDoor: n,
      });
    }
  } else errors.push(`Wiegand: ${wg.reason && wg.reason.message ? wg.reason.message : wg.reason}`);
  if (os.status === 'fulfilled') {
    for (const r of (os.value && Array.isArray(os.value.readers) ? os.value.readers : [])) {
      if (!r || r.id === undefined || r.id === null) continue;
      readers.push({
        id: `osdp-${r.id}`, type: 'osdp', name: r.name || `OSDP reader ${r.address ?? r.id}`, enabled: r.enabled !== false,
        address: r.address !== undefined ? Number(r.address) : undefined, osdpId: String(r.id), status: r.status,
      });
    }
  } else errors.push(`OSDP: ${os.reason && os.reason.message ? os.reason.message : os.reason}`);
  return { readers, errors };
}

export function dirReaderLabel(r: DirReader): string {
  if (r.type === 'wiegand') return `${r.name} · Wiegand${r.d0 !== undefined ? ` (D0 ${r.d0} / D1 ${r.d1})` : ''}`;
  return `${r.name} · OSDP${r.address !== undefined ? ` addr ${r.address}` : ''}${r.enabled ? '' : ' (disabled)'}`;
}

/**
 * Map a saved reader id to an enrolled one. 'wg-*' / 'osdp-*' / 'ctrl-emu-*' are
 * returned unchanged. A legacy pool id ('reader1' etc.) maps to the enrolled
 * Wiegand reader on the same D0/D1 pins; if there is none it is returned unchanged.
 */
export function resolveLegacyReaderId(id: string | null | undefined, legacyPool: { id: string; d0?: number; d1?: number }[], dir: DirReader[]): string | null {
  if (!id) return null;
  if (dir.some(r => r.id === id)) return id;                    // already an enrolled-reader id
  const byOsdp = dir.find(r => r.type === 'osdp' && r.osdpId === id);   // raw OSDP id, e.g. 'osdp-reader-1'
  if (byOsdp) return byOsdp.id;
  if (id.startsWith('wg-') || id.startsWith('osdp-') || id.startsWith('ctrl-emu-')) return id;
  const old = (legacyPool || []).find(r => r.id === id);
  if (!old || old.d0 === undefined) return id;
  const hit = dir.find(r => r.type === 'wiegand' && r.d0 === Number(old.d0) && r.d1 === Number(old.d1));
  return hit ? hit.id : id;
}

/**
 * Present a card on an enrolled reader. Resolves to a short description.
 * Wiegand uses /api/wiegand/transmit with the reader's pins (the path Doors has always used);
 * OSDP uses /api/osdp/card-read with the catalog format id.
 */
export async function sendCardToDirReader(
  base: string, r: DirReader,
  cred: { bits: number; facility: number; card: number; formatId?: string }
): Promise<string> {
  if (r.type === 'osdp') {
    if (!r.enabled) throw new Error(`${r.name} is disabled`);
    await postJson(`${base}/api/osdp/card-read`, { readerId: r.osdpId, facility: cred.facility, card: cred.card, format: cred.formatId || `wiegand${cred.bits}` });
    return `${r.name} (OSDP)`;
  }
  if (r.d0 === undefined || r.d1 === undefined) throw new Error(`${r.name} has no D0/D1 pins`);
  await postJson(`${base}/api/wiegand/transmit`, {
    d0Pin: r.d0, d1Pin: r.d1, facility: cred.facility, card: cred.card, bits: cred.bits, format: cred.formatId, pulseWidth: 50,
  });
  return `${r.name} (Wiegand)`;
}
