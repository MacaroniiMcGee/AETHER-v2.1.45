// Wiegand reader emulator: pick one of the configured readers (D0/D1 pairs),
// send cards in any format, or a PIN, and see what went out.
import React, { useCallback, useEffect, useState } from 'react';
import { CreditCard, KeyRound, History, Trash2, RefreshCw } from 'lucide-react';
import CredentialComposer, { CardValues } from './CredentialComposer';
import InteractiveWiegandReader from '../InteractiveWiegandReader';
import { Fmt, PinMode } from './formatLib';
import { T, Card } from '../config/ui';

interface Reader { id: string; name: string; door: number; pins: { d0: number; d1: number }; enabled: boolean }
interface Hist {
  timestamp: string; kind?: string; formatId?: string; formatName?: string; facility?: number; card?: string | number; issueLevel?: number;
  bits: number; binary?: string; frames?: string[]; mode?: string; pinLength?: number; d0Pin: number; d1Pin: number; success: boolean; error?: string | null;
}

const FALLBACK: Reader[] = [
  { id: 'reader-1', name: 'Main Entrance', door: 1, pins: { d0: 17, d1: 27 }, enabled: true },
  { id: 'reader-2', name: 'Back Door', door: 2, pins: { d0: 22, d1: 23 }, enabled: true },
  { id: 'reader-3', name: 'Side Door', door: 3, pins: { d0: 24, d1: 25 }, enabled: true },
  { id: 'reader-4', name: 'Elevator', door: 4, pins: { d0: 5, d1: 6 }, enabled: true },
];

const PIN_MODES: { id: PinMode; label: string }[] = [
  { id: 'combined', label: 'One frame · 8 bits per key' },
  { id: 'per-key-8', label: '8-bit burst · one frame per key' },
  { id: 'per-key-4', label: '4-bit burst · one frame per key' },
];

export default function WiegandEmulator({ api, formats, reload, connected, onLog }: { api: string; formats: Fmt[]; reload?: () => any; connected: boolean; onLog?: (m: string) => void }) {
  const savedPin = (() => { try { return JSON.parse(localStorage.getItem('aether.pin.v2') || '{}'); } catch { return {}; } })();
  const [pinMode, setPinMode] = useState<PinMode>(savedPin.mode || 'combined');
  const [pinEnd, setPinEnd] = useState<string>(savedPin.term ?? '#');
  useEffect(() => { try { localStorage.setItem('aether.pin.v2', JSON.stringify({ mode: pinMode, term: pinEnd })); } catch { /* */ } }, [pinMode, pinEnd]);
  const [cur, setCur] = useState<{ v: CardValues; f?: Fmt } | null>(null);
  const [readers, setReaders] = useState<Reader[]>([]);
  const [fromConfig, setFromConfig] = useState(true);
  const [sel, setSel] = useState<string>(() => { try { return localStorage.getItem('aether.wiegand.reader') || 'reader-1'; } catch { return 'reader-1'; } });
  const [hist, setHist] = useState<Hist[]>([]);

  const loadReaders = useCallback(async () => {
    try {
      const j = await (await fetch(`${api}/api/wiegand/readers`)).json();
      if (j.success && j.readers?.length) { setReaders(j.readers); setFromConfig(true); return; }
      throw new Error('none');
    } catch { setReaders(FALLBACK); setFromConfig(false); }
  }, [api]);
  const loadHist = useCallback(async () => {
    try { const j = await (await fetch(`${api}/api/wiegand/history`)).json(); if (j.success) setHist(j.history || []); } catch { /* */ }
  }, [api]);

  useEffect(() => { loadReaders(); loadHist(); }, [loadReaders, loadHist]);
  useEffect(() => { try { localStorage.setItem('aether.wiegand.reader', sel); } catch { /* */ } }, [sel]);

  const reader = readers.find(r => r.id === sel) || readers[0];
  const why = !connected ? 'Not connected' : !reader ? 'No reader' : !reader.enabled ? 'Reader disabled' : null;
  const nameFor = (d0: number) => readers.find(r => r.pins.d0 === d0)?.name || `D0 ${d0}`;

  const sendCard = async (v: CardValues, f: Fmt) => {
    const r = await fetch(`${api}/api/wiegand/transmit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ d0Pin: reader.pins.d0, d1Pin: reader.pins.d1, formatId: f.id, facility: v.facility || 0, card: v.card || 0, issueLevel: v.issue || 0 }),
    });
    const j = await r.json();
    loadHist();
    if (!j.success) throw new Error(j.error || 'Send failed');
    onLog?.(`Wiegand ${f.id} FC ${v.facility} card ${v.card} → ${reader.name}`);
  };
  const sendPin = async (pin: string, mode: PinMode, terminator: string) => {
    const r = await fetch(`${api}/api/wiegand/pin`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ d0Pin: reader.pins.d0, d1Pin: reader.pins.d1, pin, mode, terminator }),
    });
    const j = await r.json();
    loadHist();
    if (!j.success) throw new Error(j.error || 'Send failed');
    onLog?.(`Wiegand PIN (${mode}) → ${reader.name}`);
  };

  return (
    <div className="space-y-4">
      {/* Reader picker */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {readers.map(r => {
          const on = r.id === reader?.id;
          return (
            <button key={r.id} type="button" onClick={() => setSel(r.id)}
              className="rounded-xl border px-4 py-3 text-left transition-colors"
              style={{ background: on ? 'rgb(var(--hv-brand) / 0.08)' : T.panel, borderColor: on ? T.amber : T.line2, boxShadow: on ? `0 0 0 1px ${T.amber}` : 'none' }}>
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold tracking-wider" style={{ color: on ? 'rgb(var(--hv-brand-text))' : T.dim }}>READER {r.door}</span>
                <span className="w-2 h-2 rounded-full" style={{ background: r.enabled ? T.green : 'rgb(var(--hv-line))' }} title={r.enabled ? 'Enabled' : 'Disabled'} />
              </div>
              <div className="text-sm font-bold mt-0.5 truncate" style={{ color: T.text }}>{r.name}</div>
              <div className="font-mono text-[11px] mt-0.5" style={{ color: T.text2 }}>D0 GPIO {r.pins.d0} · D1 GPIO {r.pins.d1}</div>
            </button>
          );
        })}
      </div>
      {!fromConfig && <p className="text-xs -mt-2" style={{ color: T.warn }}>Couldn’t read the reader list from the Pi; showing the default wiring.</p>}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_500px]">
        <Card title={<span className="flex items-center gap-2"><CreditCard size={16} style={{ color: T.amber }} />Card</span>}
          right={reader && <span className="text-xs" style={{ color: T.dim }}>to <b style={{ color: T.text2 }}>{reader.name}</b></span>}>
          <CredentialComposer api={api} formats={formats} storageKey="aether.composer.wiegand" onSend={sendCard} reload={reload}
            onValues={(v, f) => setCur({ v, f })}
            sendLabel={reader ? `Send to ${reader.name}` : 'Send card'} disabledReason={why} />
        </Card>
        <Card title={<span className="flex items-center gap-2"><KeyRound size={16} style={{ color: T.teal }} />Interactive Wiegand Reader</span>}>
          <div className="grid grid-cols-[1fr_auto] gap-2 mb-3 items-end">
            <label className="block">
              <span className="block text-[11px] mb-1" style={{ color: T.dim }}>Keypad format</span>
              <select className="w-full rounded-md px-2 py-1.5 text-xs border" style={{ background: T.input, borderColor: T.line2, color: T.text }}
                value={pinMode} onChange={e => setPinMode(e.target.value as PinMode)}>
                {PIN_MODES.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="block text-[11px] mb-1" style={{ color: T.dim }}>End with</span>
              <select className="rounded-md px-2 py-1.5 text-xs border" style={{ background: T.input, borderColor: T.line2, color: T.text }}
                value={pinEnd} onChange={e => setPinEnd(e.target.value)}>
                <option value="#"># key</option><option value="">nothing</option>
              </select>
            </label>
          </div>
          {reader && (
            <div className="flex justify-center">
              <InteractiveWiegandReader
                key={reader.id}
                reader={{ name: reader.name, readerId: reader.id, d0Pin: reader.pins.d0, d1Pin: reader.pins.d1, pulseWidth: 50 }}
                backendUrl={api}
                pocketCard={cur && cur.f ? ({ facilityCode: cur.f.facilityBits ? Number(cur.v.facility || 0) : 0, cardNumber: (cur.v.card || '0') as any, format: cur.f.id }) : undefined}
                onSendCard={async () => { if (!cur || !cur.f) throw new Error('Pick a format first'); if (why) throw new Error(why); await sendCard(cur.v, cur.f); }}
                onSendPin={async (pin) => { if (why) throw new Error(why); await sendPin(pin, pinMode, pinEnd); }}
                pinModeLabel={PIN_MODES.find(m => m.id === pinMode)?.label.split(' · ')[0]}
              />
            </div>
          )}
          <p className="text-[11px] mt-2" style={{ color: T.dim }}>Tap the card area to send the credential on the left. Type a PIN and press # or Send; all digits go out together.</p>
        </Card>
      </div>

      <Card title={<span className="flex items-center gap-2"><History size={16} style={{ color: T.text2 }} />Sent</span>} pad={false}
        right={<div className="flex gap-1">
          <button type="button" onClick={loadHist} className="p-1.5 rounded hover:bg-hv-contrast/5" style={{ color: T.text2 }} title="Refresh"><RefreshCw size={14} /></button>
          <button type="button" onClick={async () => { await fetch(`${api}/api/wiegand/history`, { method: 'DELETE' }).catch(() => {}); loadHist(); }} className="p-1.5 rounded hover:bg-hv-contrast/5" style={{ color: T.text2 }} title="Clear"><Trash2 size={14} /></button>
        </div>}>
        <div className="max-h-[300px] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0" style={{ background: 'rgb(var(--hv-widget-panel))' }}>
              <tr className="text-left text-[10px] font-bold tracking-wider" style={{ color: T.dim }}>
                <th className="px-4 py-2 w-28">TIME</th><th className="px-2 py-2 w-36">READER</th><th className="px-2 py-2">SENT</th><th className="px-2 py-2 w-14 text-right">BITS</th><th className="px-2 py-2">FRAME</th><th className="px-4 py-2 w-16" />
              </tr>
            </thead>
            <tbody>
              {hist.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-sm" style={{ color: T.dim }}>Nothing sent yet.</td></tr>}
              {hist.map((h, i) => (
                <tr key={i} className="border-t align-top" style={{ borderColor: T.line }}>
                  <td className="px-4 py-2 font-mono text-xs whitespace-nowrap" style={{ color: T.dim }}>{new Date(h.timestamp).toLocaleTimeString()}</td>
                  <td className="px-2 py-2 text-xs" style={{ color: T.text2 }}>{nameFor(h.d0Pin)}</td>
                  <td className="px-2 py-2 text-xs" style={{ color: T.text }}>
                    {h.kind === 'pin'
                      ? <>PIN · {h.pinLength} digits <span style={{ color: T.dim }}>({h.mode === 'combined' ? 'one frame' : h.mode === 'per-key-8' ? '8-bit per key' : '4-bit per key'})</span></>
                      : <>{h.formatName || h.formatId || `${h.bits}-bit`} <span style={{ color: T.dim }}>· {h.facility != null && h.facility !== 0 ? `FC ${h.facility} · ` : ''}#{String(h.card)}{h.issueLevel ? ` · IL ${h.issueLevel}` : ''}</span></>}
                  </td>
                  <td className="px-2 py-2 text-right font-mono text-xs" style={{ color: T.text2 }}>{h.bits}</td>
                  <td className="px-2 py-2 font-mono text-[11px] break-all" style={{ color: T.text2 }}>
                    {h.kind === 'pin' ? (h.frames || []).map(f => '•'.repeat(Math.min(f.length, 8)) + (f.length > 8 ? '…' : '')).join(' ') : (h.binary || '')}
                  </td>
                  <td className="px-4 py-2 text-xs font-semibold" style={{ color: h.success ? 'rgb(var(--hv-success-text))' : 'rgb(var(--hv-error-text))' }} title={h.error || ''}>{h.success ? 'Sent' : 'Failed'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
