// AETHER_SUNAPI_LIMITS — compare two nhp_limits reports (firmware A vs firmware B).
// Pure functions: every row says exactly what changed, field by field.
export type Report = { name?: string; sheets: Record<string, unknown[][]> };
export type Status = 'worse' | 'better' | 'changed' | 'new' | 'removed' | 'values' | 'same';
export type Change =
  | { kind: 'val'; path: string; a: string; b: string; n: number }
  | { kind: 'onlyA' | 'onlyB'; path: string; v?: string; n: number }
  | { kind: 'text'; text: string }
  | { kind: 'add' | 'rem'; items: string[] };
export type Seg = { t: string; m?: 'a' | 'b' };
export type Row = {
  st: Status; key: string; label: string;
  a: string | null; b: string | null; ra?: string; rb?: string;   // ra/rb = result / verdict pill
  segA?: Seg[]; segB?: Seg[];                                      // highlighted cell text
  head?: string; changes: Change[]; note?: string;
};
export type Section = { id: string; label: string; note: string; item: string; rows: Row[] };

type Rec = Record<string, unknown>;
const norm = (v: unknown) => String(v ?? '').trim();
const numless = (s: unknown) => norm(s).replace(/-?\d+(\.\d+)?/g, '#');

export function rowsOf(rep: Report | null, sheet: string): Rec[] {
  const raw = rep?.sheets?.[sheet];
  if (!raw || !raw.length) return [];
  const head = (raw[0] as unknown[]).map(h => String(h ?? '').trim());
  return raw.slice(1).filter(r => (r as unknown[]).some(c => c !== '' && c != null)).map(r => {
    const o: Rec = {}; head.forEach((h, i) => { o[h] = (r as unknown[])[i] ?? ''; }); return o;
  });
}
export function meta(rep: Report | null): Record<string, string> {
  const m: Record<string, string> = {};
  for (const r of (rep?.sheets?.Summary || []).slice(1) as unknown[][]) { if (!r[0]) break; m[String(r[0])] = String(r[1] ?? ''); }
  return m;
}

/* ---------- what exactly changed ---------- */
function flatJson(o: unknown, p = '', out: Record<string, unknown> = {}) {
  if (o && typeof o === 'object') {
    const keys = Array.isArray(o) ? o.map((_, i) => i) : Object.keys(o as Rec);
    if (!keys.length) out[p] = Array.isArray(o) ? '[]' : '{}';
    keys.forEach(k => flatJson((o as Rec)[k as string], Array.isArray(o) ? `${p}[${k}]` : (p ? `${p}.${k}` : String(k)), out));
  } else out[p] = o;
  return out;
}
function jsonIn(s: unknown) {
  const t = String(s ?? ''), i = t.search(/[{[]/);
  if (i < 0) return null;
  try { return JSON.parse(t.slice(i)); } catch { return null; }
}
const KV = /"?([A-Za-z_][\w.#[\]-]*)"?\s*[:=]\s*("(?:[^"\\]|\\.)*"|\[[^\]{]*\]|[^,;{}\s\]]+)/g;
function kvPairs(s: unknown): [string, string][] {
  const t = String(s ?? ''), ms = [...t.matchAll(KV)];
  const last = ms[ms.length - 1];
  if (last && last.index! + last[0].length >= t.replace(/\.\.\.$/, '').length - 1 && !/[}\]]\s*$/.test(t)) ms.pop();
  return ms.map(m => [m[1], m[2].replace(/^"|"$/g, '')]);
}
const looksCut = (s: unknown) => { const t = String(s ?? ''); return t.split('{').length !== t.split('}').length || /\.\.\.$/.test(t); };
function mapChanges(fa: Record<string, unknown>, fb: Record<string, unknown>, cutA: boolean, cutB: boolean): Change[] {
  const oa = Object.keys(fa), ob = Object.keys(fb);
  const lastShared = (order: string[], other: Record<string, unknown>) => { let i = -1; order.forEach((k, n) => { if (k in other) i = n; }); return i; };
  const reachA = lastShared(ob, fa), reachB = lastShared(oa, fb);
  const g = new Map<string, Change & { n: number }>();
  for (const k of [...new Set([...oa, ...ob])]) {
    const a = fa[k], b = fb[k];
    let kind: 'val' | 'onlyA' | 'onlyB';
    if (a === undefined) { if (cutA && ob.indexOf(k) > reachA) continue; kind = 'onlyB'; }
    else if (b === undefined) { if (cutB && oa.indexOf(k) > reachB) continue; kind = 'onlyA'; }
    else if (String(a) === String(b)) continue;
    else kind = 'val';
    const path = k.replace(/\[\d+\]/g, '[*]');
    const gk = `${path}|${kind}|${kind === 'val' ? `${a}|${b}` : ''}`;
    const e = g.get(gk);
    if (e) e.n++;
    else g.set(gk, kind === 'val' ? { kind, path, a: String(a), b: String(b), n: 1 } : { kind, path, v: String(kind === 'onlyA' ? a : b), n: 1 });
  }
  return [...g.values()];
}
function tokens(s: unknown) { return String(s ?? '').match(/[A-Za-z0-9_.:+\-/]+|\s+|./g) || []; }
export function tokenDiff(a: unknown, b: unknown): { A: Seg[]; B: Seg[]; frags: [string, string][] } | null {
  const x = tokens(a), y = tokens(b), n = x.length, m = y.length;
  if (n * m > 250000) return null;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const A: Seg[] = [], B: Seg[] = [], frags: [string, string][] = [];
  const push = (arr: Seg[], t: string, mk?: 'a' | 'b') => { const l = arr[arr.length - 1]; if (l && l.m === mk) l.t += t; else arr.push({ t, m: mk }); };
  let i = 0, j = 0, ca = '', cb = '';
  const flush = () => { if (ca.trim() || cb.trim()) frags.push([ca.trim(), cb.trim()]); ca = cb = ''; };
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) { flush(); push(A, x[i]); push(B, y[j]); i++; j++; }
    else if (j >= m || (i < n && L[i + 1][j] >= L[i][j + 1])) { push(A, x[i], 'a'); ca += x[i]; i++; }
    else { push(B, y[j], 'b'); cb += y[j]; j++; }
  }
  flush();
  return { A, B, frags };
}
const NOISE = /(^|\.)(LocalTime|UTCTime|SystemTime|CurrentTime|Time|Uptime|Timestamp|Response size)$/i;
/** Explain the difference between two texts (full bodies win when the report has them). */
export function explain(a: unknown, b: unknown, fullA?: unknown, fullB?: unknown): { changes: Change[]; note?: string; segA?: Seg[]; segB?: Seg[]; noise: boolean } {
  const ja = jsonIn(fullA ?? a), jb = jsonIn(fullB ?? b);
  let list: Change[] | null = null, note: string | undefined;
  if (ja && jb) list = mapChanges(flatJson(ja), flatJson(jb), false, false);
  else {
    const ka = kvPairs(fullA ?? a), kb = kvPairs(fullB ?? b);
    if (ka.length >= 2 && kb.length >= 2) {
      const cutA = looksCut(fullA ?? a), cutB = looksCut(fullB ?? b);
      const cnt: Record<string, number> = {};
      [ka, kb].forEach(l => { const c: Record<string, number> = {}; l.forEach(([k]) => { c[k] = (c[k] || 0) + 1; cnt[k] = Math.max(cnt[k] || 0, c[k]); }); });
      const toMap = (l: [string, string][]) => { const seen: Record<string, number> = {}, m: Record<string, unknown> = {}; l.forEach(([k, v]) => { const i = seen[k] = (seen[k] ?? -1) + 1; m[cnt[k] > 1 ? `${k}[${i}]` : k] = v; }); return m; };
      list = mapChanges(toMap(ka), toMap(kb), cutA, cutB);
      if (cutA || cutB) note = 'The report cut this text short, so only the visible part was compared.';
    }
  }
  const sa = String(a).match(/(\d+) bytes/), sb = String(b).match(/(\d+) bytes/);
  if (list && sa && sb && sa[1] !== sb[1]) list.unshift({ kind: 'val', path: 'Response size', a: `${sa[1]} bytes`, b: `${sb[1]} bytes`, n: 1 });
  const td = tokenDiff(a, b);
  let changes: Change[] = list && list.length ? list : [];
  if (!changes.length && td && td.frags.length) {
    changes = td.frags.slice(0, 8).map(([x, y]) => x && y ? { kind: 'val', path: '', a: x, b: y, n: 1 } as Change : x ? { kind: 'onlyA', path: x, n: 1 } as Change : { kind: 'onlyB', path: y, n: 1 } as Change);
  }
  const noise = !!(list && list.length && list.every(c => 'path' in c && NOISE.test(c.path)));
  return { changes, note: note || (!changes.length && list ? 'Only formatting or order differs.' : undefined), segA: td?.A, segB: td?.B, noise };
}
function listDiff(a: unknown, b: unknown): Change[] {
  const sa = new Set(norm(a).split(/\s*,\s*/).filter(Boolean)), sb = new Set(norm(b).split(/\s*,\s*/).filter(Boolean));
  const add = [...sb].filter(x => !sa.has(x)), rem = [...sa].filter(x => !sb.has(x));
  return [...(add.length ? [{ kind: 'add', items: add } as Change] : []), ...(rem.length ? [{ kind: 'rem', items: rem } as Change] : [])];
}

/* ---------- section builders ---------- */
const RANK: Record<string, number> = { PASS: 0, INFO: 1, SKIP: 1, LIMIT: 2, FAIL: 3, ERROR: 3 };
const VRANK: Record<string, number> = { APPLIED: 0, REFUSED: 0, UNVERIFIED: 1, 'REFUSED?': 1, 'NOT APPLIED': 2, PARTIAL: 2 };
const VIEW_RANK: Record<string, number> = { OK: 0, NG: 2 };
function joinMap(a: Rec[], b: Rec[], keyFn: (r: Rec) => string) {
  const ma = new Map<string, Rec>(), mb = new Map<string, Rec>(), keys: string[] = [];
  a.forEach(r => { const k = keyFn(r); if (!ma.has(k)) { ma.set(k, r); keys.push(k); } });
  b.forEach(r => { const k = keyFn(r); if (!mb.has(k)) { mb.set(k, r); if (!ma.has(k)) keys.push(k); } });
  return keys.map(k => ({ k, a: ma.get(k), b: mb.get(k) }));
}
function uniqKeys(rows: Rec[], fn: (r: Rec) => string) {
  const seen: Record<string, number> = {};
  return rows.map(r => { const k = fn(r); seen[k] = (seen[k] || 0) + 1; return { ...r, _key: seen[k] > 1 ? `${k} #${seen[k]}` : k }; });
}
const presence = (a?: Rec, b?: Rec): Status | null => (!a ? 'new' : !b ? 'removed' : null);
const rankStatus = (ra: number, rb: number): Status | null => (rb > ra ? 'worse' : rb < ra ? 'better' : null);
const num = (v: unknown) => { const t = String(v ?? ''); if (!/^\s*>?=?\s*-?[\d.]+\s*$/.test(t)) return null; const n = parseFloat(t.replace(/^\s*>=?/, '')); return Number.isFinite(n) ? n : null; };
function direction(name: string) {
  if (/latency|\(ms\)|first part|slot release|check size/i.test(name)) return -1;
  if (/release duration|lockout|Timings\.|Doors configured|initial state/i.test(name)) return 0;
  if (/max|concurrent|streams|reuse|URL length|rate|MaxCount|objects|length/i.test(name)) return 1;
  return 0;
}
const NOISY = (name: string, src: string) => src === 'measured' && /latency|rate|\(s\)|\(ms\)|first part|slot release|size/i.test(name);
function fullBodies(rep: Report) {
  const m: Record<string, string> = {};
  rowsOf(rep, 'Responses').forEach(r => { m[`${norm(r.Level)} · ${norm(r.Test)}`] = String(r.Body ?? ''); });
  return m;
}
const onlyNote = (st: Status, what = 'test') => (st === 'new' ? `Only in B (new ${what}, or its level was not run in A)` : `Only in A (${what} not run in B)`);

export function compare(A: Report, B: Report): Section[] {
  const S: Section[] = [];

  { // results
    const kf = (r: Rec) => `${norm(r.Level)} · ${norm(r.Test)}`, fa = fullBodies(A), fb = fullBodies(B);
    const rows = joinMap(uniqKeys(rowsOf(A, 'Results'), kf), uniqKeys(rowsOf(B, 'Results'), kf), r => String(r._key)).map(({ k, a, b }): Row => {
      const r = (a || b)!;
      let st = presence(a, b); let head: string | undefined; let ex: ReturnType<typeof explain> | null = null; let note: string | undefined;
      if (!st && a && b) {
        st = rankStatus(RANK[String(a.Result)] ?? 1, RANK[String(b.Result)] ?? 1);
        if (st) head = `${a.Result} → ${b.Result}`;
        const fullDiff = fa[k] != null && fb[k] != null && norm(fa[k]) !== norm(fb[k]);
        if (!st) st = norm(a.Measured) === norm(b.Measured) && !fullDiff ? 'same' : (numless(a.Measured) === numless(b.Measured) && !fullDiff ? 'values' : 'changed');
        if (st !== 'same' && (norm(a.Measured) !== norm(b.Measured) || fullDiff)) {
          ex = explain(a.Measured, b.Measured, fa[k], fb[k]);
          if (st === 'changed' && ex.noise) st = 'values';
        }
      } else {
        note = onlyNote(st!);
        if (/^V09/.test(norm(r.ID))) note += '. Out-of-range tests pick parameters from each firmware’s own spec, so the picks differ when the spec changes.';
      }
      const ids = [...new Set([a?.ID, b?.ID].filter(Boolean).map(String))];
      return { st: st!, key: norm(r.Test), label: `${r.Level} · ${ids.join(' / ')}`, a: a ? norm(a.Measured) : null, b: b ? norm(b.Measured) : null,
        ra: a ? String(a.Result) : undefined, rb: b ? String(b.Result) : undefined, segA: ex?.segA, segB: ex?.segB, head, changes: ex?.changes || [], note: note || ex?.note };
    });
    S.push({ id: 'results', label: 'Test results', item: 'Test', rows, note: 'Worse / better compares the result grade (PASS < INFO/SKIP < LIMIT < FAIL/ERROR). When only timings moved, the row counts as a number-only change.' });
  }

  { // limits
    const rows = joinMap(rowsOf(A, 'Limits'), rowsOf(B, 'Limits'), r => norm(r['Limit / property'])).map(({ k, a, b }): Row => {
      const r = (a || b)!, src = norm(r.Source), va = a ? norm(a.Value) : '', vb = b ? norm(b.Value) : '';
      let st = presence(a, b); let head: string | undefined; let changes: Change[] = [];
      if (!st) {
        if (va === vb) st = 'same';
        else {
          const na = num(va), nb = num(vb), dir = direction(k);
          if (na != null && nb != null) {
            const d = nb - na, pct = na !== 0 ? (d / Math.abs(na)) * 100 : null;
            head = `${d > 0 ? '+' : ''}${+d.toFixed(3)}${pct != null ? ` (${pct > 0 ? '+' : ''}${pct.toFixed(0)}%)` : ''}`;
            const absSmall = /\(ms\)/i.test(k) ? Math.abs(d) < 20 : /\(s\)/i.test(k) ? Math.abs(d) < 0.25 : false;
            if (NOISY(k, src) && ((pct != null && Math.abs(pct) < 25) || absSmall)) st = 'values';
            else st = dir === 0 ? 'changed' : (d > 0) === (dir > 0) ? 'better' : 'worse';
          } else if (/^>=?/.test(va) !== /^>=?/.test(vb)) { st = 'changed'; head = 'Reached the test cap in one run only'; }
          else { st = 'changed'; changes = /,/.test(va + vb) ? listDiff(va, vb) : [{ kind: 'val', path: '', a: va, b: vb, n: 1 }]; }
        }
      }
      return { st: st!, key: k, label: `${norm(r['What it means'])}${src ? ` (${src})` : ''}`, a: a ? va : null, b: b ? vb : null, head, changes, note: !a || !b ? onlyNote(st!, 'limit') : undefined };
    });
    S.push({ id: 'limits', label: 'Limits', item: 'Limit', rows, note: 'Declared limits (capabilities, API spec, door settings) count any change. Measured timings count as number-only unless they move by 25% or more and by a real amount (20 ms / 0.25 s).' });
  }

  { // push checks
    const kf = (r: Rec) => `${norm(r.Level)} · ${norm(r.Test)}`;
    const rows = joinMap(uniqKeys(rowsOf(A, 'Push checks'), kf), uniqKeys(rowsOf(B, 'Push checks'), kf), r => String(r._key)).map(({ a, b }): Row => {
      const r = (a || b)!; let st = presence(a, b); let head: string | undefined; let ex: ReturnType<typeof explain> | null = null;
      const aa = a ? norm(a['After (reinspect)']) : '', bb = b ? norm(b['After (reinspect)']) : '';
      if (!st && a && b) {
        st = rankStatus(VRANK[String(a.Verdict)] ?? 1, VRANK[String(b.Verdict)] ?? 1) || (aa === bb ? 'same' : numless(aa) === numless(bb) ? 'values' : 'changed');
        if (a.Verdict !== b.Verdict) head = `${a.Verdict} → ${b.Verdict}`;
        if (aa !== bb) ex = explain(aa, bb);
      }
      return { st: st!, key: norm(r.Test), label: norm(r.Level), a: a ? aa : null, b: b ? bb : null, ra: a ? String(a.Verdict) : undefined, rb: b ? String(b.Verdict) : undefined,
        segA: ex?.segA, segB: ex?.segB, head, changes: ex?.changes || [], note: !a || !b ? onlyNote(st!, 'check') : undefined };
    });
    S.push({ id: 'push', label: 'Push checks', item: 'Change', rows, note: 'Inspect → push → reinspect verdicts. APPLIED and REFUSED are healthy; NOT APPLIED (said OK, readback disagrees) and PARTIAL are defects.' });
  }

  { // api spec
    const key = (r: Rec) => `${r.CGI}/${r.Submenu}/${r.Action}${r.Parameter ? ' · ' + r.Parameter : ''}`;
    const desc = (r?: Rec) => (r ? (r.Parameter ? `${r.Type || '?'}${r.Req ? ' · required' : ''}${r['Allowed values / range'] ? ' · ' + r['Allowed values / range'] : ''}` : 'action') : null);
    const rows = joinMap(rowsOf(A, 'API spec'), rowsOf(B, 'API spec'), key).map(({ k, a, b }): Row => {
      let st = presence(a, b); const changes: Change[] = [];
      if (!st && a && b) {
        if (desc(a) === desc(b)) st = 'same';
        else {
          st = 'changed';
          if (norm(a.Type) !== norm(b.Type)) changes.push({ kind: 'val', path: 'type', a: norm(a.Type), b: norm(b.Type), n: 1 });
          if (norm(a.Req) !== norm(b.Req)) changes.push({ kind: 'text', text: b.Req ? 'now required' : 'no longer required' });
          const va = norm(a['Allowed values / range']), vb = norm(b['Allowed values / range']);
          if (va !== vb) changes.push(...(/,/.test(va + vb) ? listDiff(va, vb) : [{ kind: 'val', path: 'allowed', a: va || '-', b: vb || '-', n: 1 } as Change]));
        }
      }
      return { st: st!, key: k, label: '', a: desc(a), b: desc(b), changes, note: st === 'new' ? 'Added in B' : st === 'removed' ? 'Removed in B' : undefined };
    });
    S.push({ id: 'api', label: 'API spec', item: 'Command / parameter', rows, note: 'Commands and parameters from each firmware’s attributes.cgi: new menus, actions, parameters, changed allowed values and new door commands.' });
  }

  { // features
    const rows = joinMap(rowsOf(A, 'Features'), rowsOf(B, 'Features'), r => norm(r['Feature / capability'])).map(({ k, a, b }): Row => {
      let st = presence(a, b); let changes: Change[] = [];
      const va = a ? norm(a.Value) : '', vb = b ? norm(b.Value) : '';
      if (!st) { if (va === vb) st = 'same'; else { st = 'changed'; changes = /,/.test(va + vb) ? listDiff(va, vb) : [{ kind: 'val', path: '', a: va, b: vb, n: 1 }]; } }
      return { st: st!, key: k, label: norm((a || b)!.Source), a: a ? va : null, b: b ? vb : null, changes, note: !a || !b ? onlyNote(st!, 'feature') : undefined };
    });
    S.push({ id: 'features', label: 'Features', item: 'Feature', rows, note: 'Yes/no capabilities and properties the controller reports.' });
  }

  { // read commands
    const rows = joinMap(rowsOf(A, 'View sweep'), rowsOf(B, 'View sweep'), r => `${r.CGI}/${r.Submenu}/${r.Action}`).map(({ k, a, b }): Row => {
      let st = presence(a, b); let head: string | undefined; let ex: ReturnType<typeof explain> | null = null;
      const ra = a ? String(a.Result).split(' ')[0] : '', rb = b ? String(b.Result).split(' ')[0] : '';
      if (!st && a && b) {
        st = rankStatus(VIEW_RANK[ra] ?? 1, VIEW_RANK[rb] ?? 1) || (norm(a.Error) === norm(b.Error) ? 'same' : 'changed');
        if (ra !== rb) head = `${ra} → ${rb}`;
        if (norm(a.Error) !== norm(b.Error)) ex = explain(a.Error || '', b.Error || '');
      }
      return { st: st!, key: k, label: '', a: a ? norm(a.Error) : null, b: b ? norm(b.Error) : null, ra: a ? ra : undefined, rb: b ? rb : undefined, head, changes: ex?.changes || [], note: !a || !b ? onlyNote(st!, 'command') : undefined };
    });
    S.push({ id: 'views', label: 'Read commands', item: 'Command', rows, note: 'Every view command in the spec, and whether it answered. OK → NG is a regression.' });
  }

  { // error codes
    const d = (x?: Rec) => (x ? [x['Details seen'], x['Reasons seen']].filter(Boolean).join(' / ') : null);
    const rows = joinMap(rowsOf(A, 'Error codes'), rowsOf(B, 'Error codes'), r => norm(r['Error code'])).map(({ k, a, b }): Row => {
      let st = presence(a, b); let ex: ReturnType<typeof explain> | null = null;
      if (!st) { st = d(a) === d(b) ? 'same' : 'changed'; if (st === 'changed') ex = explain(d(a), d(b)); }
      return { st: st!, key: k, label: String((b || a)!['Where (first 12)'] ?? '').split('\n').slice(0, 2).join(', '), a: d(a), b: d(b), changes: ex?.changes || [],
        note: st === 'new' ? 'Only returned in B' : st === 'removed' ? 'Only returned in A' : undefined };
    });
    S.push({ id: 'errors', label: 'Error codes', item: 'Code', rows, note: 'Error codes the controller returned during the runs, and what caused them.' });
  }

  { // doors
    const rows = joinMap(rowsOf(A, 'Doors'), rowsOf(B, 'Doors'), r => norm(r.Token)).map(({ k, a, b }): Row => {
      let st = presence(a, b); const changes: Change[] = [];
      if (!st && a && b) {
        for (const c of Object.keys(a).filter(c => c !== 'Token' && norm(a[c]) !== norm(b[c]))) {
          if (/commands|supported/i.test(c)) { const l = listDiff(a[c], b[c]); l.forEach(x => changes.push(x)); changes.push({ kind: 'text', text: `(${c})` }); }
          else changes.push({ kind: 'val', path: c, a: norm(a[c]), b: norm(b[c]), n: 1 });
        }
        st = changes.length ? 'changed' : 'same';
      }
      const cell = (x?: Rec) => (x ? `${x.Name} · release ${x['Release s']}s · lock wired ${x['Lock wired']}` : null);
      return { st: st!, key: `Door ${k}`, label: '', a: cell(a), b: cell(b), changes, note: !a || !b ? onlyNote(st!, 'door') : undefined };
    });
    S.push({ id: 'doors', label: 'Doors', item: 'Door', rows, note: 'Door wiring, timings and supported commands.' });
  }

  const ORDER: Record<Status, number> = { worse: 0, changed: 1, new: 2, removed: 3, better: 4, values: 5, same: 6 };
  S.forEach(s => s.rows.sort((x, y) => ORDER[x.st] - ORDER[y.st]));
  return S;
}

export const changeText = (c: Change): string =>
  c.kind === 'val' ? `${c.path ? c.path + ': ' : ''}${c.a} -> ${c.b}${c.n > 1 ? ` (${c.n}x)` : ''}`
    : c.kind === 'onlyA' ? `${c.path}: only in A${c.v ? ` (was ${c.v})` : ''}`
      : c.kind === 'onlyB' ? `${c.path}: new in B${c.v ? ` (${c.v})` : ''}`
        : c.kind === 'add' ? c.items.map(i => `+${i}`).join(' ') : c.kind === 'rem' ? c.items.map(i => `-${i}`).join(' ') : 'text' in c ? c.text : '';
export const rowText = (r: Row) => [r.head, ...r.changes.map(changeText), r.note].filter(Boolean).join('; ');
