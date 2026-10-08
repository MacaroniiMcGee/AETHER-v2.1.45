// Format analyzer: paste a frame (binary, or hex plus a bit count) and see which
// formats it could be: every format of that length is decoded with its bit map,
// parity is checked, and matches are listed first.
import React, { useMemo, useState } from 'react';
import { CheckCircle, XCircle } from 'lucide-react';
import BitStrip from './BitStrip';
import { StatusTag } from './FormatPicker';
import { Fmt, BitMap, FIELD_STYLE } from './formatLib';
import { T, Card } from '../config/ui';

function decode(map: BitMap, bits: string) {
  const get = (p: number) => (bits[p - 1] === '1' ? 1 : 0);
  const vals: Record<string, bigint> = {};
  const byKey: Record<string, { start: number; len: number }[]> = {};
  for (const f of map.fields || []) if (f.key !== 'fixed') (byKey[f.key] ||= []).push(f);
  for (const [k, list] of Object.entries(byKey)) {
    let v = 0n;
    for (const f of list) for (let i = 0; i < f.len; i++) v = (v << 1n) | BigInt(get(f.start + i));
    vals[k] = v;
  }
  if (map.scramble) for (const [k, list] of Object.entries(map.scramble)) { let v = 0n; list.forEach(p => { v = (v << 1n) | BigInt(get(p)); }); vals[k] = v; }
  const fixedOk = (map.fields || []).filter(f => f.key === 'fixed').every(f => {
    let v = 0; for (let i = 0; i < f.len; i++) v = v * 2 + get(f.start + i); return v === Number(f.value || 0);
  });
  const parity = (map.parity || []).map(p => {
    if (p.type === 'xor') {
      const w = p.len || 8; let x = 0;
      for (let i = 0; i + w <= p.covers.length; i += w) { let b = 0; for (let j = 0; j < w; j++) b = (b << 1) | get(p.covers[i + j]); x ^= b; }
      let got = 0; for (let j = 0; j < w; j++) got = (got << 1) | get(p.bit + j);
      return { bit: p.bit, type: p.type, ok: got === x };
    }
    const ones = p.covers.reduce((s, c) => s + get(c), 0) + get(p.bit);
    return { bit: p.bit, type: p.type, ok: p.type === 'even' ? ones % 2 === 0 : ones % 2 === 1 };
  });
  return { vals, parity, fixedOk, ok: fixedOk && parity.every(x => x.ok) };
}

export default function FormatAnalyzer({ formats }: { formats: Fmt[] }) {
  const [mode, setMode] = useState<'bin' | 'hex'>('bin');
  const [text, setText] = useState('10000000111101110110010011011101');
  const [hexBits, setHexBits] = useState('26');

  const { bits, err } = useMemo(() => {
    const t = text.replace(/[\s_:-]/g, '');
    if (!t) return { bits: '', err: null as string | null };
    if (mode === 'bin') return /^[01]+$/.test(t) ? { bits: t, err: null } : { bits: '', err: 'Binary may only contain 0 and 1' };
    const h = t.replace(/^0x/i, '');
    if (!/^[0-9a-f]+$/i.test(h)) return { bits: '', err: 'Hex may only contain 0-9 and A-F' };
    const n = Number(hexBits);
    if (!Number.isInteger(n) || n < 1 || n > 256) return { bits: '', err: 'Bit count must be 1-256' };
    const all = h.split('').map(c => parseInt(c, 16).toString(2).padStart(4, '0')).join('');
    if (all.length < n) return { bits: '', err: `That hex is only ${all.length} bits` };
    return { bits: all.slice(0, n), err: null };           // left-aligned, as OSDP sends it
  }, [text, mode, hexBits]);

  const results = useMemo(() => {
    if (!bits) return [];
    return formats.filter(f => f.bits === bits.length).map(f => ({ f, d: decode(f.map, bits) }))
      // matches first; among matches, formats with parity (a stronger check) before raw ones
      .sort((a, b) => Number(b.d.ok) - Number(a.d.ok) || b.d.parity.length - a.d.parity.length || (a.f.status === 'verified' ? -1 : 0) - (b.f.status === 'verified' ? -1 : 0));
  }, [bits, formats]);
  const matches = results.filter(r => r.d.ok).length;
  const inputSt = { background: T.input, borderColor: T.line2, color: T.text };

  return (
    <div className="space-y-4">
      <Card title="Frame to analyze">
        <div className="flex flex-wrap items-end gap-3">
          <div className="inline-flex p-0.5 rounded-md" style={{ background: T.input }}>
            {(['bin', 'hex'] as const).map(m => (
              <button key={m} type="button" onClick={() => setMode(m)} className="px-3 py-1.5 rounded text-xs font-bold"
                style={mode === m ? { background: 'rgb(var(--hv-popup-panel))', color: T.text } : { color: T.dim }}>{m === 'bin' ? 'Binary' : 'Hex'}</button>
            ))}
          </div>
          <input className="flex-1 min-w-[260px] rounded-lg px-3 py-2 font-mono text-sm outline-none border focus:border-hv-brand" style={inputSt}
            value={text} onChange={e => setText(e.target.value)} placeholder={mode === 'bin' ? '1000 0000 1111…' : '80F764DD'} />
          {mode === 'hex' && (
            <label className="block">
              <span className="block text-[11px] mb-1" style={{ color: T.dim }}>Bit count</span>
              <input className="w-20 rounded-lg px-3 py-2 font-mono text-sm outline-none border" style={inputSt} value={hexBits} onChange={e => setHexBits(e.target.value.replace(/\D/g, ''))} />
            </label>
          )}
        </div>
        <p className="text-xs mt-2" style={{ color: err ? 'rgb(var(--hv-error-text))' : T.dim }}>
          {err || (bits ? `${bits.length} bits · ${results.length} format${results.length === 1 ? '' : 's'} of that length · ${matches} with correct parity` : 'Paste a frame from the history, a sniffer capture or a controller log.')}
        </p>
      </Card>

      {results.map(({ f, d }) => (
        <Card key={f.id} title={<span className="flex items-center gap-2">{d.ok ? <CheckCircle size={16} style={{ color: T.green }} /> : <XCircle size={16} style={{ color: T.crit }} />}{f.name} <StatusTag f={f} small /></span>}
          right={<span className="text-xs font-mono" style={{ color: T.dim }}>{f.id}</span>}>
          <BitStrip map={f.map} binary={bits} legend={false} />
          <div className="flex flex-wrap gap-x-6 gap-y-1 mt-2 text-sm">
            {(['facility', 'card', 'issue', 'tech', 'agency'] as const).filter(k => k in d.vals).map(k => (
              <span key={k}><span style={{ color: FIELD_STYLE[k].color }}>{FIELD_STYLE[k].label}</span> <b className="font-mono" style={{ color: T.text }}>{d.vals[k].toString()}</b></span>
            ))}
            {d.parity.map(p => (
              <span key={p.bit} className="text-xs" style={{ color: p.ok ? 'rgb(var(--hv-success-text))' : 'rgb(var(--hv-error-text))' }}>{p.type === 'xor' ? 'Checksum' : `${p.type === 'even' ? 'Even' : 'Odd'} parity`} at bit {p.bit}: {p.ok ? 'OK' : 'wrong'}</span>
            ))}
            {!d.fixedOk && <span className="text-xs" style={{ color: 'rgb(var(--hv-error-text))' }}>Fixed bits don't match</span>}
          </div>
        </Card>
      ))}
      {bits && results.length === 0 && <p className="text-sm px-1" style={{ color: T.dim }}>No format is {bits.length} bits long. Build one in the Format builder.</p>}
    </div>
  );
}
