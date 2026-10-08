// Searchable credential-format picker: type a name, bit count or vendor;
// filter by group; every row shows bits, field sizes and a Verified/Custom tag.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Search, Check } from 'lucide-react';
import { Fmt, CATEGORY_LABEL } from './formatLib';
import { T } from '../config/ui';

export function StatusTag({ f, small }: { f: Pick<Fmt, 'status' | 'user' | 'statusNote' | 'libraryStatus'>; small?: boolean }) {
  const cls = `inline-flex items-center rounded font-bold tracking-wide whitespace-nowrap ${small ? 'text-[9px] px-1 py-px' : 'text-[10px] px-1.5 py-0.5'}`;
  if (f.user) return <span className={cls} style={{ background: 'rgb(var(--hv-purple-text) / 0.15)', color: 'rgb(var(--hv-purple-text))', border: '1px solid rgb(var(--hv-purple-text) / 0.35)' }} title="Built in the format builder">MINE</span>;
  if (f.status === 'verified') return <span className={cls} style={{ background: 'rgb(var(--hv-success) / 0.12)', color: 'rgb(var(--hv-success-text))', border: '1px solid rgb(var(--hv-success) / 0.35)' }} title="Checked against the published layout">VERIFIED</span>;
  if (f.status === 'confirmed') return <span className={cls} style={{ background: 'rgb(var(--hv-info) / 0.12)', color: 'rgb(var(--hv-info-text))', border: '1px solid rgb(var(--hv-info) / 0.35)' }} title="Confirmed on your controller">CONFIRMED</span>;
  const tip = f.status === 'custom'
    ? `Unverified: the library definition was repaired. ${f.statusNote || ''} Test it on the controller, then mark it confirmed.`
    : 'Unverified: sent exactly as the library defines it, but not yet checked on a controller. Test it, then mark it confirmed.';
  return <span className={cls} style={{ background: 'rgb(var(--hv-warning) / 0.12)', color: T.warn, border: '1px solid rgb(var(--hv-warning) / 0.35)' }} title={tip}>UNVERIFIED</span>;
}

export function StatusDot({ f }: { f: Fmt }) {
  const [t, c] = f.user ? ['MINE', 'rgb(var(--hv-purple-text))'] : f.status === 'verified' ? ['VERIFIED', 'rgb(var(--hv-success-text))'] : f.status === 'confirmed' ? ['CONFIRMED', 'rgb(var(--hv-info-text))'] : ['UNVERIFIED', T.warn];
  return <span className="flex items-center gap-1.5 text-[10px] font-semibold tracking-wide whitespace-nowrap" style={{ color: c }}><span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: c }} />{t}</span>;
}

const fieldsText = (f: Fmt) => {
  const p: string[] = [];
  if (f.facilityBits) p.push(`FC ${f.facilityBits}`);
  if (f.cardBits) p.push(`CN ${f.cardBits}`);
  if (f.issueLevel) p.push(`IL ${f.issueLevel}`);
  return p.join(' · ');
};

interface Props { formats: Fmt[]; value: string; onChange: (id: string) => void; disabled?: boolean }

export default function FormatPicker({ formats, value, onChange, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<string>('all');
  const [hi, setHi] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const cur = formats.find(f => f.id === value);

  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', off);
    setTimeout(() => input.current?.focus(), 0);
    return () => document.removeEventListener('mousedown', off);
  }, [open]);

  const cats = useMemo(() => {
    const c: Record<string, number> = {};
    formats.forEach(f => { c[f.category || 'other'] = (c[f.category || 'other'] || 0) + 1; });
    return Object.entries(c).sort((a, b) => (a[0] === 'custom' ? -1 : b[0] === 'custom' ? 1 : b[1] - a[1]));
  }, [formats]);

  const list = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return formats
      .filter(f => cat === 'all' || f.category === cat)
      .filter(f => words.every(w => {
        const hay = `${f.id} ${f.name} ${f.bits}bit ${f.bits}-bit ${f.manufacturer || ''} ${(f.aliases || []).join(' ')} ${CATEGORY_LABEL[f.category] || f.category}`.toLowerCase();
        return /^\d+$/.test(w) ? String(f.bits) === w || hay.includes(w) : hay.includes(w);
      }))
      .sort((a, b) => (a.user === b.user ? 0 : a.user ? -1 : 1) || a.bits - b.bits || Number(b.status === 'verified') - Number(a.status === 'verified') || a.name.localeCompare(b.name));
  }, [formats, q, cat]);

  useEffect(() => { setHi(0); }, [q, cat]);

  const pick = (id: string) => { onChange(id); setOpen(false); setQ(''); };

  return (
    <div className="relative" ref={box}>
      <button type="button" disabled={disabled} onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 rounded-lg border px-3 py-2 text-left disabled:opacity-50"
        style={{ background: T.input, borderColor: open ? T.amber : T.line2 }}>
        <span className="font-mono font-bold text-lg w-12 shrink-0 text-center rounded-md py-0.5" style={{ background: 'rgb(var(--hv-brand) / 0.12)', color: T.amber }}>{cur?.bits ?? '–'}</span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="text-sm font-semibold truncate" style={{ color: T.text }}>{cur?.name || (formats.length ? 'Choose a format' : 'Loading formats…')}</span>
            {cur && <StatusTag f={cur} small />}
          </span>
          <span className="block text-[11px] truncate" style={{ color: T.dim }}>{cur ? `${cur.id} · ${fieldsText(cur)}${cur.map.parity.length ? ' · parity' : ' · no parity'}` : ''}</span>
        </span>
        <ChevronDown size={16} style={{ color: T.dim }} />
      </button>

      {open && (
        <div className="absolute z-40 left-0 mt-1 rounded-xl border shadow-2xl overflow-hidden grid grid-cols-[168px_minmax(0,1fr)]"
          style={{ background: 'rgb(var(--hv-widget-panel))', borderColor: 'rgb(var(--hv-line-strong))', width: 'min(760px, 92vw)', height: 460 }}>
          {/* vendors */}
          <div className="border-r overflow-y-auto py-1" style={{ borderColor: T.line }}>
            {[['all', formats.length] as [string, number], ...cats].map(([c, n]) => (
              <button key={c} type="button" onClick={() => setCat(c)} className="w-full flex justify-between items-center px-3 py-1.5 text-sm text-left"
                style={cat === c ? { background: 'rgb(var(--hv-brand) / 0.1)', color: 'rgb(var(--hv-brand-text))', boxShadow: `inset 2px 0 0 ${T.amber}` } : { color: T.text2 }}>
                <span className="truncate">{c === 'all' ? 'All formats' : CATEGORY_LABEL[c] || c}</span><span className="text-xs" style={{ color: T.faint }}>{n}</span>
              </button>
            ))}
          </div>
          {/* table */}
          <div className="flex flex-col min-h-0">
            <div className="flex items-center gap-2 px-3 border-b" style={{ borderColor: T.line }}>
              <Search size={15} style={{ color: T.dim }} />
              <input ref={input} value={q} onChange={e => setQ(e.target.value)} placeholder="Search name, bits (e.g. 37)…"
                onKeyDown={e => {
                  if (e.key === 'ArrowDown') { e.preventDefault(); setHi(h => Math.min(list.length - 1, h + 1)); }
                  if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(0, h - 1)); }
                  if (e.key === 'Enter' && list[hi]) pick(list[hi].id);
                  if (e.key === 'Escape') setOpen(false);
                }}
                className="flex-1 bg-transparent outline-none text-sm py-3" style={{ color: T.text }} />
              <span className="text-[11px]" style={{ color: T.dim }}>{list.length}</span>
            </div>
            <div className="overflow-y-auto flex-1">
              <table className="w-full text-sm table-fixed">
                <thead className="sticky top-0 z-10" style={{ background: 'rgb(var(--hv-widget-panel))' }}>
                  <tr className="text-[10px] font-bold tracking-wider text-left" style={{ color: T.dim }}>
                    <th className="px-3 py-1.5 w-12">BITS</th><th className="py-1.5">NAME</th><th className="py-1.5 w-32">FIELDS</th><th className="py-1.5 w-28 pr-3">STATUS</th>
                  </tr>
                </thead>
                <tbody>
                  {list.length === 0 && <tr><td colSpan={4} className="px-3 py-8 text-center" style={{ color: T.dim }}>No format matches “{q}”.</td></tr>}
                  {list.map((f, i) => (
                    <tr key={f.id} onClick={() => pick(f.id)} onMouseEnter={() => setHi(i)} className="border-t cursor-pointer" title={`${f.id}${f.statusNote ? ' · ' + f.statusNote : ''}`}
                      style={{ borderColor: T.line, background: f.id === value ? 'rgb(var(--hv-brand) / 0.1)' : i === hi ? 'rgb(var(--hv-contrast) / 0.03)' : undefined }}>
                      <td className="px-3 py-1.5 font-mono font-bold" style={{ color: T.amber }}>{f.bits}</td>
                      <td className="py-1.5 truncate" style={{ color: T.text }}>{f.name}</td>
                      <td className="py-1.5 font-mono text-[11px] truncate" style={{ color: T.dim }}>{fieldsText(f) || '—'}</td>
                      <td className="py-1.5 pr-3"><StatusDot f={f} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
