// Card composer shared by the OSDP and Wiegand pages: pick a format, enter the
// values, see the exact bits that will go out, send.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Send, Shuffle, AlertTriangle, Loader2, Info } from 'lucide-react';
import FormatPicker from './FormatPicker';
import BitStrip from './BitStrip';
import { Fmt, fieldsOf, fmtMax, randomIn, binToHex } from './formatLib';
import { T } from '../config/ui';

export interface CardValues { formatId: string; facility: string; card: string; issue: string }

interface Props {
  api: string;
  formats: Fmt[];
  storageKey: string;
  onSend: (v: CardValues, f: Fmt) => Promise<void>;
  sendLabel?: string;
  disabledReason?: string | null;
  compact?: boolean;
  reload?: () => any;
  onValues?: (v: CardValues, f: Fmt | undefined) => void;
}

const DEFAULTS: CardValues = { formatId: 'h10301', facility: '123', card: '45678', issue: '0' };
const load = (k: string): CardValues => { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(k) || '{}') }; } catch { return DEFAULTS; } };

export default function CredentialComposer({ api, formats, storageKey, onSend, sendLabel = 'Send card', disabledReason, compact, reload, onValues }: Props) {
  const [v, setV] = useState<CardValues>(() => load(storageKey));
  const [enc, setEnc] = useState<{ binary: string; hex: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null);
  const seq = useRef(0);

  const f = formats.find(x => x.id === v.formatId) || formats.find(x => x.id === 'h10301') || formats[0];
  const has = f ? fieldsOf(f) : { facility: false, card: false, issue: false };

  useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify(v)); } catch { /* */ } }, [v, storageKey]);
  useEffect(() => { onValues?.(v, f); }, [v, f]); // eslint-disable-line
  const [confirming, setConfirming] = useState(false);
  const confirm = async (yes: boolean) => {
    if (!f) return;
    setConfirming(true);
    try {
      const r = await fetch(`${api}/api/formats/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: f.id, confirmed: yes }) });
      const j = await r.json();
      if (!j.success) throw new Error(j.error);
      await reload?.();
    } catch (e: any) { setFlash({ ok: false, text: e?.message || String(e) }); }
    setConfirming(false);
  };
  useEffect(() => { if (f && f.id !== v.formatId) setV(p => ({ ...p, formatId: f.id })); }, [f]); // eslint-disable-line

  // Live encode on the Pi (same encoder that sends)
  useEffect(() => {
    if (!f) return;
    const my = ++seq.current;
    const t = setTimeout(async () => {
      const bad = (['facility', 'card', 'issue'] as const).find(k => has[k] && !/^\d+$/.test(v[k].trim()));
      if (bad) { setEnc(null); setErr(`${bad === 'facility' ? 'Facility code' : bad === 'card' ? 'Card number' : 'Issue level'} must be a whole number`); return; }
      try {
        const r = await fetch(`${api}/api/formats/encode`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ formatId: f.id, facility: has.facility ? v.facility.trim() : 0, card: has.card ? v.card.trim() : 0, issue: has.issue ? v.issue.trim() : 0 }) });
        const j = await r.json();
        if (my !== seq.current) return;
        if (j.success) { setEnc({ binary: j.binary, hex: j.hex }); setErr(null); } else { setEnc(null); setErr(j.error); }
      } catch { if (my === seq.current) { setEnc(null); setErr('Can’t reach the Pi to check this credential'); } }
    }, 120);
    return () => clearTimeout(t);
  }, [api, f, v.facility, v.card, v.issue]); // eslint-disable-line

  const set = (k: keyof CardValues) => (e: React.ChangeEvent<HTMLInputElement>) => setV(p => ({ ...p, [k]: e.target.value.replace(/[^\d]/g, '') }));
  const randomize = () => f && setV(p => ({ ...p, facility: has.facility ? randomIn(f.maxFacility) : p.facility, card: randomIn(f.maxCard), issue: has.issue ? randomIn(f.maxIssueLevel) : p.issue }));

  const send = async () => {
    if (!f || err || disabledReason) return;
    setBusy(true); setFlash(null);
    try { await onSend(v, f); setFlash({ ok: true, text: `Sent ${f.bits}-bit ${f.name}` }); }
    catch (e: any) { setFlash({ ok: false, text: e?.message || String(e) }); }
    setBusy(false);
    setTimeout(() => setFlash(null), 4000);
  };

  const inputCls = 'w-full rounded-lg px-3 py-2 font-mono text-lg outline-none border focus:border-hv-brand';
  const inputSt = { background: T.input, borderColor: T.line2, color: T.text };
  const numField = (k: 'facility' | 'card' | 'issue', label: string, max: number | string) => (
    <label className="block min-w-0">
      <span className="flex items-baseline justify-between text-xs mb-1" style={{ color: T.text2 }}>
        <span className="font-semibold">{label}</span><span className="font-mono text-[10px]" style={{ color: T.dim }}>0 – {fmtMax(max)}</span>
      </span>
      <input inputMode="numeric" className={inputCls} style={inputSt} value={v[k]} onChange={set(k)}
        onKeyDown={e => { if (e.key === 'Enter') send(); }} />
    </label>
  );

  const grid = [has.facility, has.card, has.issue].filter(Boolean).length;

  return (
    <div className="space-y-3">
      <FormatPicker formats={formats} value={f?.id || ''} onChange={id => setV(p => ({ ...p, formatId: id }))} />

      {f && (
        <>
          <div className={`grid gap-3 ${grid === 3 ? 'grid-cols-[1fr_1.4fr_0.7fr]' : grid === 2 ? 'grid-cols-[1fr_1.4fr]' : 'grid-cols-1'}`}>
            {has.facility && numField('facility', 'Facility code', f.maxFacility)}
            {has.card && numField('card', 'Card number', f.maxCard)}
            {has.issue && numField('issue', 'Issue level', f.maxIssueLevel)}
          </div>
          {!has.facility && <p className="text-[11px] -mt-1" style={{ color: T.dim }}>This format has no facility code; the whole value is the card number.</p>}

          <div className="rounded-lg border p-3" style={{ background: T.well, borderColor: T.line }}>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-bold tracking-wider" style={{ color: T.dim }}>BITS THAT WILL BE SENT · {f.bits}</span>
              {enc && <span className="font-mono text-[11px]" style={{ color: T.text2 }}>0x{enc.hex}</span>}
            </div>
            <BitStrip map={f.map} binary={enc?.binary} legend={!compact} />
            {err && <div className="mt-2 flex items-start gap-2 text-xs" style={{ color: 'rgb(var(--hv-error-text))' }}><AlertTriangle size={14} className="shrink-0 mt-px" />{err}</div>}
            {!f.user && (f.status === 'defined' || f.status === 'custom') && (
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]" style={{ color: T.warn }}>
                <span className="flex items-start gap-2 flex-1 min-w-[220px]"><Info size={13} className="shrink-0 mt-px" />
                  {f.status === 'custom' && f.statusNote ? `Unverified: ${f.statusNote}` : 'Unverified: sent as the library defines it. Once the controller reads it correctly, mark it confirmed.'}</span>
                {reload && <button type="button" disabled={confirming} onClick={() => confirm(true)} className="px-2 py-1 rounded border font-bold disabled:opacity-50"
                  style={{ borderColor: 'rgb(var(--hv-info) / 0.5)', color: 'rgb(var(--hv-info-text))' }}>Mark confirmed</button>}
              </div>
            )}
            {!f.user && f.status === 'confirmed' && (
              <div className="mt-2 flex items-center gap-3 text-[11px]" style={{ color: 'rgb(var(--hv-info-text))' }}>
                <span>Confirmed on your controller{f.confirmedAt ? ` · ${new Date(f.confirmedAt).toLocaleDateString()}` : ''}</span>
                {reload && <button type="button" disabled={confirming} onClick={() => confirm(false)} className="underline disabled:opacity-50" style={{ color: T.dim }}>Undo</button>}
              </div>
            )}
          </div>
        </>
      )}

      <div className="flex items-center gap-2">
        <button type="button" onClick={randomize} className="px-3 py-2.5 rounded-lg border text-sm font-semibold inline-flex items-center gap-2"
          style={{ borderColor: T.line2, color: T.text2, background: 'rgb(var(--hv-widget-panel))' }} title="Random values in range"><Shuffle size={15} />Random</button>
        <button type="button" onClick={send} disabled={busy || !!err || !!disabledReason || !f}
          className="flex-1 py-2.5 rounded-lg text-sm font-bold inline-flex items-center justify-center gap-2 disabled:opacity-40"
          style={{ background: T.amber, color: '#101011' }} title={disabledReason || ''}>
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}{disabledReason || sendLabel}
        </button>
      </div>
      {flash && <div className="text-xs px-1" style={{ color: flash.ok ? 'rgb(var(--hv-success-text))' : 'rgb(var(--hv-error-text))' }}>{flash.ok ? '✓ ' : '✗ '}{flash.text}</div>}
    </div>
  );
}

export { binToHex };
