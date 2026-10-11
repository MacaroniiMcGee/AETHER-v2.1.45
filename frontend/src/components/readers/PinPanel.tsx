// Wiegand PIN entry: collect every digit first, then send them together.
// Default is one frame with 8 bits per key (HID 8-bit codes); per-key 8-bit
// and 4-bit frames are available for controllers that want those.
import React, { useEffect, useState } from 'react';
import { Delete, Eye, EyeOff, Loader2, Send } from 'lucide-react';
import { PinMode, pinFrames, binToHex } from './formatLib';
import { T } from '../config/ui';

const MODES: { id: PinMode; label: string; hint: string }[] = [
  { id: 'combined', label: 'One frame', hint: 'All keys in one frame, 8 bits per key' },
  { id: 'per-key-8', label: '8-bit per key', hint: 'Each key as its own 8-bit frame, back to back' },
  { id: 'per-key-4', label: '4-bit per key', hint: 'Each key as its own 4-bit frame, back to back' },
];

interface Props { onSend: (pin: string, mode: PinMode, terminator: string) => Promise<void>; disabledReason?: string | null }

export default function PinPanel({ onSend, disabledReason }: Props) {
  const saved = (() => { try { return JSON.parse(localStorage.getItem('aether.pin.v2') || '{}'); } catch { return {}; } })();
  const [pin, setPin] = useState('');
  const [mode, setMode] = useState<PinMode>(saved.mode || 'combined');
  const [term, setTerm] = useState<string>(saved.term ?? '#');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => { try { localStorage.setItem('aether.pin.v2', JSON.stringify({ mode, term })); } catch { /* */ } }, [mode, term]);

  const press = (k: string) => setPin(p => (p.length >= 12 ? p : p + k));
  const send = async () => {
    if (!pin || disabledReason) return;
    setBusy(true); setFlash(null);
    try { await onSend(pin, mode, term); setFlash({ ok: true, text: `Sent ${pin.length}-digit PIN` }); setPin(''); }
    catch (e: any) { setFlash({ ok: false, text: e?.message || String(e) }); }
    setBusy(false); setTimeout(() => setFlash(null), 4000);
  };

  // keyboard entry while the panel has focus
  const onKey = (e: React.KeyboardEvent) => {
    if (/^[0-9*#]$/.test(e.key)) { press(e.key); e.preventDefault(); }
    else if (e.key === 'Backspace') { setPin(p => p.slice(0, -1)); e.preventDefault(); }
    else if (e.key === 'Enter') { send(); e.preventDefault(); }
    else if (e.key === 'Escape') setPin('');
  };

  const frames = pin ? pinFrames(pin, mode, term) : [];
  const total = frames.reduce((s, f) => s + f.length, 0);

  return (
    <div className="space-y-3 outline-none" tabIndex={0} onKeyDown={onKey}>
      <div className="flex items-center gap-2 rounded-lg border px-3" style={{ background: 'rgb(var(--hv-surface))', borderColor: T.line2, height: 52 }}>
        <div className="flex-1 font-mono text-2xl tracking-[0.35em]" style={{ color: pin ? 'rgb(var(--hv-brand-text))' : T.faint }}>
          {pin ? (show ? pin : '•'.repeat(pin.length)) : 'PIN'}
        </div>
        <button type="button" onClick={() => setShow(s => !s)} className="p-1.5 rounded" style={{ color: T.dim }} title={show ? 'Hide' : 'Show'}>{show ? <EyeOff size={16} /> : <Eye size={16} />}</button>
        <button type="button" onClick={() => setPin(p => p.slice(0, -1))} className="p-1.5 rounded" style={{ color: T.dim }} title="Backspace"><Delete size={16} /></button>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map(k => (
          <button key={k} type="button" onClick={() => press(k)}
            className="h-12 rounded-lg border font-mono text-xl font-bold active:scale-95 transition-transform"
            style={{ background: 'linear-gradient(180deg,rgb(var(--hv-widget)),rgb(var(--hv-widget-panel)))', borderColor: 'rgb(var(--hv-line))', color: T.text }}>{k}</button>
        ))}
      </div>

      <div>
        <div className="text-[10px] font-bold tracking-wider mb-1" style={{ color: T.dim }}>SEND AS</div>
        <div className="grid grid-cols-3 gap-1 p-0.5 rounded-lg" style={{ background: T.input }}>
          {MODES.map(m => (
            <button key={m.id} type="button" onClick={() => setMode(m.id)} title={m.hint}
              className="px-2 py-1.5 rounded-md text-xs font-semibold"
              style={mode === m.id ? { background: 'rgb(var(--hv-brand-tint))', color: 'rgb(var(--hv-brand-text))', boxShadow: `inset 0 0 0 1px ${T.amber}` } : { color: T.dim }}>{m.label}</button>
          ))}
        </div>
        <div className="flex items-center justify-between mt-2 text-xs" style={{ color: T.text2 }}>
          <span>End with</span>
          <div className="inline-flex p-0.5 rounded-md" style={{ background: T.input }}>
            {[['#', '# key'], ['', 'nothing']].map(([t, l]) => (
              <button key={l} type="button" onClick={() => setTerm(t)} className="px-2.5 py-1 rounded text-xs font-semibold"
                style={term === t ? { background: 'rgb(var(--hv-popup-panel))', color: T.text } : { color: T.dim }}>{l}</button>
            ))}
          </div>
        </div>
      </div>

      <div className="rounded-lg border px-3 py-2 font-mono text-[11px] min-h-[52px]" style={{ background: T.well, borderColor: T.line, color: T.text2 }}>
        {frames.length === 0 ? <span style={{ color: T.faint }}>Frames appear here as you type.</span> : (
          <>
            <div className="mb-1" style={{ color: T.dim }}>{frames.length} frame{frames.length > 1 ? 's' : ''} · {total} bits</div>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {frames.map((fr, i) => (
                <span key={i} className="whitespace-nowrap">{show ? fr.match(/.{1,8}/g)!.join(' ') : fr.replace(/./g, '•').match(/.{1,8}/g)!.join(' ')}{fr.length >= 8 && show ? <span style={{ color: T.dim }}> 0x{binToHex(fr)}</span> : null}</span>
              ))}
            </div>
          </>
        )}
      </div>

      <button type="button" onClick={send} disabled={busy || !pin || !!disabledReason}
        className="w-full py-2.5 rounded-lg text-sm font-bold inline-flex items-center justify-center gap-2 disabled:opacity-40"
        style={{ background: 'rgb(var(--hv-info-tint))', color: 'rgb(var(--hv-info-fg))', boxShadow: 'inset 0 0 0 1px rgb(var(--hv-info) / 0.4)' }}>
        {busy ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}{disabledReason || 'Send PIN'}
      </button>
      {flash && <div className="text-xs px-1" style={{ color: flash.ok ? 'rgb(var(--hv-success-text))' : 'rgb(var(--hv-error-text))' }}>{flash.ok ? '✓ ' : '✗ '}{flash.text}</div>}
    </div>
  );
}
