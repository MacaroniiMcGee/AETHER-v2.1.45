// Format builder: an editable bit map. Paint bits as facility code, card number,
// issue level, fixed bits or parity; set what each parity bit covers; test with
// real values (encoded on the Pi by the same encoder that sends); save it and it
// shows up as "MINE" in the OSDP and Wiegand composers.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Save, Trash2, FilePlus2, AlertTriangle, CheckCircle, Loader2, Eraser, Send } from 'lucide-react';
import BitStrip from './BitStrip';
import FormatPicker, { StatusTag } from './FormatPicker';
import { BitMap, Fmt, FIELD_STYLE, fmtMax } from './formatLib';
import { T, Card } from '../config/ui';

type Owner = 'pad' | 'facility' | 'card' | 'issue' | 'fixed0' | 'fixed1' | 'even' | 'odd';
interface Model { bits: number; owners: Owner[]; covers: Record<number, number[]> }   // owners 1-based

const TOOLS: { id: Owner; label: string; color: string; hint: string }[] = [
  { id: 'facility', label: 'Facility', color: FIELD_STYLE.facility.color, hint: 'Facility / site code bits' },
  { id: 'card', label: 'Card', color: FIELD_STYLE.card.color, hint: 'Card number bits' },
  { id: 'issue', label: 'Issue', color: FIELD_STYLE.issue.color, hint: 'Issue level bits' },
  { id: 'even', label: 'Even parity', color: FIELD_STYLE['parity-even'].color, hint: 'Click one bit; then set what it covers' },
  { id: 'odd', label: 'Odd parity', color: FIELD_STYLE['parity-odd'].color, hint: 'Click one bit; then set what it covers' },
  { id: 'fixed0', label: 'Fixed 0', color: 'rgb(var(--hv-text-3))', hint: 'Always sent as 0' },
  { id: 'fixed1', label: 'Fixed 1', color: 'rgb(var(--hv-text-2))', hint: 'Always sent as 1' },
  { id: 'pad', label: 'Clear', color: 'rgb(var(--hv-line))', hint: 'Unassigned (sent as 0)' },
];

const range = (a: number, b: number) => { const r: number[] = []; for (let i = a; i <= b; i++) r.push(i); return r; };

function fromMap(m: BitMap): Model {
  const owners: Owner[] = new Array(m.bits + 1).fill('pad');
  const covers: Record<number, number[]> = {};
  for (const f of m.fields || []) {
    for (let i = 0; i < f.len; i++) {
      const p = f.start + i;
      if (f.key === 'fixed') owners[p] = ((Number(f.value || 0) >> (f.len - 1 - i)) & 1) ? 'fixed1' : 'fixed0';
      else if (f.key === 'facility' || f.key === 'card' || f.key === 'issue') owners[p] = f.key;
      else owners[p] = 'fixed0';                   // tech/agency/other fields: sent as 0
    }
  }
  if (m.scramble) for (const [k, list] of Object.entries(m.scramble)) list.forEach(p => { owners[p] = (k === 'facility' || k === 'card') ? k : 'fixed0'; });
  for (const p of m.parity || []) {
    if (p.type === 'xor') { for (let i = 0; i < (p.len || 8); i++) owners[p.bit + i] = 'fixed0'; continue; }
    owners[p.bit] = p.type; covers[p.bit] = [...p.covers];
  }
  return { bits: m.bits, owners, covers };
}

function toMap(md: Model): BitMap {
  const fields: BitMap['fields'] = [];
  let i = 1;
  while (i <= md.bits) {
    const o = md.owners[i];
    if (o === 'even' || o === 'odd' || o === 'pad') { i++; continue; }
    let j = i;
    const fixed = o === 'fixed0' || o === 'fixed1';
    while (j + 1 <= md.bits && (fixed ? (md.owners[j + 1] === 'fixed0' || md.owners[j + 1] === 'fixed1') : md.owners[j + 1] === o)) j++;
    if (fixed) {
      let v = 0; for (let k = i; k <= j; k++) v = v * 2 + (md.owners[k] === 'fixed1' ? 1 : 0);
      fields.push({ key: 'fixed', start: i, len: j - i + 1, value: v });
    } else fields.push({ key: o, start: i, len: j - i + 1 });
    i = j + 1;
  }
  const parity = range(1, md.bits).filter(p => md.owners[p] === 'even' || md.owners[p] === 'odd')
    .map(p => ({ bit: p, type: md.owners[p] as 'even' | 'odd', covers: (md.covers[p] || []).filter(c => c >= 1 && c <= md.bits && c !== p) }));
  return { bits: md.bits, fields, parity };
}

const resize = (md: Model, n: number): Model => {
  const owners = md.owners.slice(0, n + 1);
  while (owners.length < n + 1) owners.push('pad');
  const covers: Record<number, number[]> = {};
  Object.entries(md.covers).forEach(([k, v]) => { if (+k <= n) covers[+k] = v.filter(c => c <= n); });
  return { bits: n, owners, covers };
};

const rangesText = (list: number[]) => {
  const s = [...list].sort((a, b) => a - b); const out: string[] = [];
  for (let i = 0; i < s.length; i++) { let j = i; while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++; out.push(i === j ? `${s[i]}` : `${s[i]}–${s[j]}`); i = j; }
  return out.join(', ') || 'nothing';
};
const parseRanges = (t: string, n: number) => {
  const out = new Set<number>();
  t.split(/[,\s]+/).filter(Boolean).forEach(tok => { const m = tok.match(/^(\d+)(?:[-–](\d+))?$/); if (m) range(+m[1], +(m[2] || m[1])).forEach(p => { if (p >= 1 && p <= n) out.add(p); }); });
  return [...out];
};

interface Props { api: string; formats: Fmt[]; reload: () => Promise<any>; connected: boolean }

export default function FormatBuilder({ api, formats, reload, connected }: Props) {
  const [base, setBase] = useState<string>('h10301');
  const [md, setMd] = useState<Model>(() => ({ bits: 26, owners: new Array(27).fill('pad'), covers: {} }));
  const [name, setName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [tool, setTool] = useState<Owner>('card');
  const [drag, setDrag] = useState<[number, number] | null>(null);
  const [covFor, setCovFor] = useState<number | null>(null);       // parity bit whose coverage is being edited
  const [vals, setVals] = useState({ facility: '1', card: '1', issue: '0' });
  const [enc, setEnc] = useState<{ binary: string; hex: string } | null>(null);
  const [encErr, setEncErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [readers, setReaders] = useState<{ id: string; name: string }[]>([]);
  const [testReader, setTestReader] = useState('reader-1');
  const covDrag = useRef<'add' | 'remove'>('add');
  const loaded = useRef(false);

  const map = useMemo(() => toMap(md), [md]);
  const has = { facility: md.owners.includes('facility'), card: md.owners.includes('card'), issue: md.owners.includes('issue') };
  const lens = { facility: md.owners.filter(o => o === 'facility').length, card: md.owners.filter(o => o === 'card').length, issue: md.owners.filter(o => o === 'issue').length };

  const loadFrom = (id: string) => {
    const f = formats.find(x => x.id === id); if (!f) return;
    setBase(id); setMd(fromMap(f.map)); setCovFor(null);
    if (f.user) { setEditingId(f.id); setName(f.name); } else { setEditingId(null); setName(`${f.name} (copy)`); }
    setMsg(null);
  };
  useEffect(() => { if (!loaded.current && formats.length) { loaded.current = true; loadFrom('h10301'); } }, [formats]); // eslint-disable-line
  useEffect(() => { fetch(`${api}/api/wiegand/readers`).then(r => r.json()).then(j => setReaders(j.readers || [])).catch(() => {}); }, [api]);

  // live encode on the Pi
  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`${api}/api/formats/encode`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ map, facility: has.facility ? vals.facility || 0 : 0, card: has.card ? vals.card || 0 : 0, issue: has.issue ? vals.issue || 0 : 0 }) });
        const j = await r.json();
        if (j.success) { setEnc({ binary: j.binary, hex: j.hex }); setEncErr(null); } else { setEnc(null); setEncErr(j.error); }
      } catch { setEnc(null); setEncErr('Can’t reach the Pi'); }
    }, 150);
    return () => clearTimeout(t);
  }, [api, map, vals]); // eslint-disable-line

  // painting
  useEffect(() => {
    const up = () => {
      if (!drag) return;
      const [a, b] = [Math.min(...drag), Math.max(...drag)];
      if (covFor != null) {
        setMd(p => {
          const cur = new Set(p.covers[covFor] || []);
          range(a, b).forEach(x => { if (x === covFor) return; covDrag.current === 'add' ? cur.add(x) : cur.delete(x); });
          return { ...p, covers: { ...p.covers, [covFor]: [...cur].sort((x, y) => x - y) } };
        });
      } else {
        setMd(p => {
          const owners = [...p.owners]; const covers = { ...p.covers };
          if (tool === 'even' || tool === 'odd') {             // parity: single bit
            owners[b] = tool; if (!covers[b]) covers[b] = []; setCovFor(b);
          } else {
            range(a, b).forEach(x => { if (owners[x] === 'even' || owners[x] === 'odd') delete covers[x]; owners[x] = tool; });
          }
          return { ...p, owners, covers };
        });
      }
      setDrag(null);
    };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, [drag, tool, covFor]);

  const parityBits = range(1, md.bits).filter(p => md.owners[p] === 'even' || md.owners[p] === 'odd');
  const dataBits = range(1, md.bits).filter(p => !(md.owners[p] === 'even' || md.owners[p] === 'odd'));
  const setCover = (p: number, list: number[]) => setMd(m => ({ ...m, covers: { ...m.covers, [p]: list.filter(x => x !== p) } }));

  // problems the builder can see before saving
  const problems: string[] = [];
  if (!has.card && !has.facility) problems.push('No facility or card bits yet: pick Card and drag across the bits.');
  parityBits.forEach(p => { if (!(md.covers[p] || []).length) problems.push(`Parity at bit ${p} doesn't cover anything yet.`); });
  const unused = md.owners.slice(1).filter(o => o === 'pad').length;

  const save = async () => {
    setSaving(true); setMsg(null);
    try {
      const r = await fetch(`${api}/api/formats/custom`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: editingId || undefined, name, map }) });
      const j = await r.json();
      if (!j.success) throw new Error(j.error);
      await reload();
      setEditingId(j.format.id); setBase(j.format.id);
      setMsg({ ok: true, text: `Saved as “${j.format.name}”. It's now in the format list on the OSDP and Wiegand pages (tagged MINE).` });
    } catch (e: any) { setMsg({ ok: false, text: e.message }); }
    setSaving(false);
  };
  const remove = async () => {
    if (!editingId) return;
    const r = await fetch(`${api}/api/formats/custom/${encodeURIComponent(editingId)}`, { method: 'DELETE' });
    const j = await r.json().catch(() => ({}));
    if (j.success) { await reload(); setMsg({ ok: true, text: 'Deleted.' }); setEditingId(null); setName(name.replace(/$/, '')); }
    else setMsg({ ok: false, text: j.error || 'Delete failed' });
  };
  const sendTest = async () => {
    if (!enc) return;
    try {
      const r = await fetch(`${api}/api/wiegand/raw`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ readerId: testReader, bits: enc.binary }) });
      const j = await r.json();
      setMsg(j.success ? { ok: true, text: `Sent ${enc.binary.length} bits to ${readers.find(x => x.id === testReader)?.name || testReader}.` } : { ok: false, text: j.error || 'Send failed' });
    } catch (e: any) { setMsg({ ok: false, text: e.message }); }
  };

  const input = 'rounded-lg px-3 py-2 text-sm outline-none border focus:border-hv-brand';
  const inputSt = { background: T.input, borderColor: T.line2, color: T.text };
  const baseFmt = formats.find(f => f.id === base);

  return (
    <div className="space-y-4">
      {/* Top: start from / name / size / save */}
      <Card>
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_120px_auto] items-end">
          <div>
            <div className="text-xs font-semibold mb-1" style={{ color: T.text2 }}>Start from</div>
            <FormatPicker formats={formats} value={base} onChange={loadFrom} />
          </div>
          <label className="block">
            <span className="block text-xs font-semibold mb-1" style={{ color: T.text2 }}>Name</span>
            <input className={`${input} w-full`} style={inputSt} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Site 40-bit test" />
          </label>
          <label className="block">
            <span className="block text-xs font-semibold mb-1" style={{ color: T.text2 }}>Total bits</span>
            <input type="number" min={1} max={256} className={`${input} w-full font-mono`} style={inputSt} value={md.bits}
              onChange={e => { const n = Math.max(1, Math.min(256, Number(e.target.value) || 1)); setMd(p => resize(p, n)); }} />
          </label>
          <div className="flex gap-2">
            <button type="button" onClick={() => { setMd({ bits: md.bits, owners: new Array(md.bits + 1).fill('pad'), covers: {} }); setEditingId(null); setName('New format'); setCovFor(null); }}
              className="px-3 py-2 rounded-lg border text-sm font-semibold inline-flex items-center gap-2" style={{ borderColor: T.line2, color: T.text2, background: 'rgb(var(--hv-widget-panel))' }}><FilePlus2 size={15} />Blank</button>
            <button type="button" onClick={save} disabled={saving || !name.trim()}
              className="px-4 py-2 rounded-lg text-sm font-bold inline-flex items-center gap-2 disabled:opacity-40" style={{ background: T.amber, color: '#101011' }}>
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}{editingId ? 'Save changes' : 'Save as mine'}</button>
            {editingId && <button type="button" onClick={remove} className="px-3 py-2 rounded-lg border text-sm inline-flex items-center gap-2" style={{ borderColor: 'rgb(var(--hv-error-hover))', color: 'rgb(var(--hv-error-text))' }} title="Delete this format"><Trash2 size={15} /></button>}
          </div>
        </div>
        {baseFmt && !editingId && baseFmt.status === 'custom' && baseFmt.statusNote && (
          <p className="text-xs mt-3 flex items-start gap-2" style={{ color: T.warn }}><StatusTag f={baseFmt} small /> {baseFmt.statusNote}</p>
        )}
        {msg && <p className="text-sm mt-3 flex items-start gap-2" style={{ color: msg.ok ? 'rgb(var(--hv-success-text))' : 'rgb(var(--hv-error-text))' }}>{msg.ok ? <CheckCircle size={16} className="shrink-0 mt-0.5" /> : <AlertTriangle size={16} className="shrink-0 mt-0.5" />}{msg.text}</p>}
      </Card>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        {/* Bit map */}
        <Card title="Bit map" right={<span className="text-xs" style={{ color: T.dim }}>{covFor != null ? `Drag to add or remove bits covered by the parity at bit ${covFor}` : 'Pick a tool, then drag across the bits'}</span>}>
          <div className="flex flex-wrap gap-1.5 mb-4">
            {TOOLS.map(t => (
              <button key={t.id} type="button" title={t.hint} onClick={() => { setTool(t.id); setCovFor(null); }}
                className="px-3 py-1.5 rounded-lg text-xs font-bold inline-flex items-center gap-2 border"
                style={tool === t.id && covFor == null ? { background: `color-mix(in srgb, ${t.color} 15%, transparent)`, borderColor: t.color, color: T.text } : { background: 'rgb(var(--hv-surface) / 0.25)', borderColor: T.line2, color: T.text2 }}>
                {t.id === 'pad' ? <Eraser size={13} /> : <span className="w-3 h-3 rounded-[2px]" style={{ background: t.color }} />}{t.label}
              </button>
            ))}
          </div>
          <div onMouseLeave={() => { /* keep drag until mouseup */ }}>
            <BitStrip map={map} binary={enc?.binary}
              selection={drag}
              coverage={covFor != null ? md.covers[covFor] || [] : null} coverageOf={covFor}
              onCellDown={(p) => {
                if (covFor != null) covDrag.current = (md.covers[covFor] || []).includes(p) ? 'remove' : 'add';
                setDrag([p, p]);
              }}
              onCellEnter={(p) => setDrag(d => (d ? [d[0], p] : d))} />
          </div>

          {/* fields summary */}
          <div className="grid grid-cols-3 gap-2 mt-4">
            {(['facility', 'card', 'issue'] as const).map(k => (
              <div key={k} className="rounded-lg border px-3 py-2" style={{ background: T.well, borderColor: T.line }}>
                <div className="flex items-center gap-2 text-xs font-semibold" style={{ color: T.text }}><span className="w-2.5 h-2.5 rounded-[2px]" style={{ background: FIELD_STYLE[k].color }} />{FIELD_STYLE[k].label}</div>
                <div className="font-mono text-[11px] mt-0.5" style={{ color: T.text2 }}>
                  {lens[k] ? <>{lens[k]} bits · bits {rangesText(range(1, md.bits).filter(p => md.owners[p] === k))} · max {fmtMax(lens[k] >= 53 ? (2n ** BigInt(lens[k]) - 1n).toString() : 2 ** lens[k] - 1)}</> : <span style={{ color: T.faint }}>not used</span>}
                </div>
              </div>
            ))}
          </div>

          {/* parity */}
          <div className="mt-4">
            <div className="text-[10px] font-bold tracking-wider mb-2" style={{ color: T.dim }}>PARITY</div>
            {parityBits.length === 0 && <p className="text-xs" style={{ color: T.faint }}>No parity bits. Pick Even or Odd parity and click the bit it sits in.</p>}
            <div className="space-y-2">
              {parityBits.map(p => {
                const list = md.covers[p] || [];
                const editing = covFor === p;
                const half = Math.ceil(dataBits.length / 2);
                return (
                  <div key={p} className="rounded-lg border px-3 py-2 flex flex-wrap items-center gap-2" style={{ background: editing ? 'rgb(var(--hv-brand) / 0.06)' : T.well, borderColor: editing ? T.amber : T.line }}>
                    <span className="w-2.5 h-2.5 rounded-[2px]" style={{ background: FIELD_STYLE[md.owners[p] === 'even' ? 'parity-even' : 'parity-odd'].color }} />
                    <span className="text-sm font-semibold" style={{ color: T.text }}>Bit {p}</span>
                    <select className="rounded px-2 py-1 text-xs border" style={inputSt} value={md.owners[p]}
                      onChange={e => setMd(m => { const o = [...m.owners]; o[p] = e.target.value as Owner; return { ...m, owners: o }; })}>
                      <option value="even">Even</option><option value="odd">Odd</option>
                    </select>
                    <span className="text-xs" style={{ color: T.text2 }}>covers</span>
                    <input className="rounded px-2 py-1 text-xs border font-mono w-44" style={inputSt} defaultValue={rangesText(list).replace(/–/g, '-')} key={list.join(',')}
                      onBlur={e => setCover(p, parseRanges(e.target.value, md.bits))} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
                    <span className="text-[11px]" style={{ color: T.dim }}>{list.length} bits</span>
                    <div className="flex gap-1 ml-auto">
                      <button type="button" onClick={() => setCover(p, dataBits.slice(0, half))} className="px-2 py-1 rounded text-[11px] border" style={{ borderColor: T.line2, color: T.text2 }}>First half</button>
                      <button type="button" onClick={() => setCover(p, dataBits.slice(dataBits.length - half))} className="px-2 py-1 rounded text-[11px] border" style={{ borderColor: T.line2, color: T.text2 }}>Second half</button>
                      <button type="button" onClick={() => setCover(p, range(1, md.bits).filter(x => x !== p))} className="px-2 py-1 rounded text-[11px] border" style={{ borderColor: T.line2, color: T.text2 }}>All</button>
                      <button type="button" onClick={() => setCovFor(editing ? null : p)} className="px-2 py-1 rounded text-[11px] font-bold border"
                        style={editing ? { background: T.amber, color: '#101011', borderColor: T.amber } : { borderColor: T.amber, color: 'rgb(var(--hv-brand-text))' }}>{editing ? 'Done' : 'Drag to set'}</button>
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="text-[11px] mt-2" style={{ color: T.dim }}>Parity bits are worked out in bit order, so a whole-frame parity placed after others includes them.</p>
          </div>
        </Card>

        {/* Test */}
        <div className="space-y-4">
          <Card title="Test values">
            <div className="space-y-3">
              {(['facility', 'card', 'issue'] as const).filter(k => has[k]).map(k => (
                <label key={k} className="block">
                  <span className="flex justify-between text-xs mb-1" style={{ color: T.text2 }}><span className="font-semibold">{FIELD_STYLE[k].label}</span><span className="font-mono text-[10px]" style={{ color: T.dim }}>{lens[k]} bits</span></span>
                  <input inputMode="numeric" className={`${input} w-full font-mono text-base`} style={inputSt} value={vals[k]} onChange={e => setVals(v => ({ ...v, [k]: e.target.value.replace(/[^\d]/g, '') }))} />
                </label>
              ))}
              <div className="rounded-lg border px-3 py-2 font-mono text-[11px] break-all" style={{ background: T.well, borderColor: T.line, color: T.text2 }}>
                {enc ? <><div style={{ color: T.dim }}>{enc.binary.length} bits · 0x{enc.hex}</div>{enc.binary}</> : <span style={{ color: 'rgb(var(--hv-error-text))' }}>{encErr}</span>}
              </div>
            </div>
          </Card>
          <Card title="Checks">
            <ul className="space-y-1.5 text-xs">
              {problems.map((p, i) => <li key={i} className="flex gap-2" style={{ color: T.warn }}><AlertTriangle size={13} className="shrink-0 mt-px" />{p}</li>)}
              {unused > 0 && <li className="flex gap-2" style={{ color: T.text2 }}><span className="w-3" />{unused} unassigned bit{unused > 1 ? 's' : ''} will be sent as 0.</li>}
              {!problems.length && !encErr && <li className="flex gap-2" style={{ color: 'rgb(var(--hv-success-text))' }}><CheckCircle size={13} className="shrink-0 mt-px" />Ready to save.</li>}
            </ul>
          </Card>
          <Card title="Send a test frame (Wiegand)">
            <div className="flex gap-2">
              <select className={`${input} flex-1`} style={inputSt} value={testReader} onChange={e => setTestReader(e.target.value)}>
                {(readers.length ? readers : [{ id: 'reader-1', name: 'Reader 1' }]).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
              <button type="button" onClick={sendTest} disabled={!enc || !connected} className="px-3 py-2 rounded-lg text-sm font-bold inline-flex items-center gap-2 disabled:opacity-40" style={{ background: 'rgb(var(--hv-info-tint))', color: 'rgb(var(--hv-info-fg))', boxShadow: 'inset 0 0 0 1px rgb(var(--hv-info) / 0.4)' }}><Send size={15} />Send</button>
            </div>
            <p className="text-[11px] mt-2" style={{ color: T.dim }}>Sends these exact bits without saving. To use the format over OSDP, save it and pick it on the OSDP page.</p>
          </Card>
        </div>
      </div>
    </div>
  );
}
