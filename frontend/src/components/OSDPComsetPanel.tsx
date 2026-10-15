// AETHER-COMSET — Readers → OSDP → Firmware: change a reader's address / baud
// with osdp_COMSET (0x6E, SIA OSDP 2.2 §6.13) and check that it took.
// Backend: POST /api/osdp/firmware-comset (routes-osdp-firmware.js).
import React, { useEffect, useMemo, useState } from 'react';
import { ArrowRight, CheckCircle2, Cable, Loader2, RotateCw, Search, XCircle, AlertTriangle, Copy } from 'lucide-react';

const BAUDS = [9600, 19200, 38400, 57600, 115200, 230400];

type Step = { name: string; command?: string; ok?: boolean; reply?: string; error?: string; hint?: string | null; note?: string; nak?: number; dataHex?: string; replyHex?: string; matches?: boolean; attempts?: number };
type Wire = { t: number; dir: 'tx' | 'rx'; baud: number; hex: string };
type Result = {
  success: boolean; outcome: 'changed' | 'changed-other' | 'refused' | 'unchanged' | 'lost' | 'no-reader' | 'sent' | 'unknown';
  port: string; from: { address: number | 'broadcast'; baud: number }; requested: { address: number; baud: number };
  com: { address: number; baud: number } | null; steps: Step[]; wire: Wire[]; error?: string;
};
type Ident = { vendorName?: string | null; modelNumber?: number | null; serialHex?: string | null; firmwareString?: string | null; identityAvailable?: boolean };
type Recent = { at: string; port: string; from: string; to: string; outcome: string };

// CRC-16 used by OSDP (CCITT, poly 0x1021, start 0x1D0F) — for the frame preview only.
function crc16(bytes: number[]) {
  let c = 0x1D0F;
  for (const b of bytes) { c ^= b << 8; for (let i = 0; i < 8; i++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF; }
  return c;
}
const h2 = (n: number) => n.toString(16).padStart(2, '0').toUpperCase();
const fmtAddr = (a: number | 'broadcast') => a === 'broadcast' ? 'broadcast (0x7F)' : `${a} (0x${h2(a)})`;

const OUTCOME: Record<Result['outcome'], { tone: 'success' | 'warning' | 'error'; title: string; body: (r: Result) => string }> = {
  'changed':       { tone: 'success', title: 'Changed', body: r => `The reader now answers at address ${r.com?.address ?? r.requested.address}, ${(r.com?.baud ?? r.requested.baud).toLocaleString()} baud. Update the panel's reader settings to match.` },
  'changed-other': { tone: 'warning', title: 'Changed, but not to what you asked', body: r => `The reader said it would use address ${r.com?.address}, ${r.com?.baud.toLocaleString()} baud, and it answers there. It could not do ${r.requested.address} at ${r.requested.baud.toLocaleString()}.` },
  'refused':       { tone: 'error',   title: 'Reader refused (NAK)', body: () => 'Nothing was changed. See the reason below.' },
  'unchanged':     { tone: 'error',   title: 'Not changed', body: () => 'The reader still answers at its old settings. It replied but did not apply the change.' },
  'lost':          { tone: 'error',   title: 'Reader not found afterwards', body: r => `It does not answer at the new settings or the old ones. Try a scan at ${r.requested.baud.toLocaleString()} baud, then power-cycle it.` },
  'no-reader':     { tone: 'error',   title: 'No reader answered', body: () => 'Nothing answered at the current address and baud, so COMSET was not sent. Check the port, address, baud and wiring.' },
  'sent':          { tone: 'success', title: 'Sent (not checked)', body: () => 'The reader answered with COM. The check was turned off.' },
  'unknown':       { tone: 'warning', title: 'Sent, result unknown', body: () => 'The reader did not answer with COM and the check was turned off.' },
};

const TONE = {
  success: 'bg-hv-success-tint text-hv-success-text ring-1 ring-inset ring-hv-success/40',
  warning: 'bg-hv-warning-tint text-hv-warning-text ring-1 ring-inset ring-hv-warning/40',
  error:   'bg-hv-error-tint text-hv-error-text ring-1 ring-inset ring-hv-error/40',
};
const INPUT = 'w-full px-2.5 py-1.5 rounded-hv-sm bg-hv-box border border-hv-line text-sm text-hv-text placeholder:text-hv-text-3 focus:outline-none focus:border-hv-brand';
const BTN_GHOST = 'px-3 py-1.5 rounded-hv-sm text-sm border border-hv-line text-hv-text-2 hover:text-hv-text hover:border-hv-line-strong disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5';

function Field({ label, children, hint }: { label: string; children?: React.ReactNode; hint?: string }) {
  return (
    <label className="flex flex-col gap-1 min-w-0">
      <span className="text-xs text-hv-text-2">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-hv-text-3">{hint}</span>}
    </label>
  );
}

export default function OSDPComsetPanel() {
  const [ports, setPorts] = useState<{ path: string; label?: string }[]>([]);
  const [port, setPort] = useState('ttyACM0');
  const [baud, setBaud] = useState(9600);
  const [address, setAddress] = useState(0);
  const [broadcast, setBroadcast] = useState(false);
  const [newAddress, setNewAddress] = useState(1);
  const [newBaud, setNewBaud] = useState(9600);
  const [verify, setVerify] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<'identify' | 'send' | null>(null);
  const [ident, setIdent] = useState<Ident | null>(null);
  const [identErr, setIdentErr] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<Recent[]>(() => { try { return JSON.parse(sessionStorage.getItem('aether.comset.recent') || '[]'); } catch { return []; } });

  useEffect(() => {
    fetch('/api/osdp/enroll/ports').then(r => r.json()).then(j => {
      const list = (j.ports || []).map((p: any) => ({ path: String(p.path || '').replace(/^\/dev\//, ''), label: p.label || p.manufacturer || '' })).filter((p: any) => p.path);
      setPorts(list);
      if (list[0]) setPort(list[0].path);
    }).catch(() => {});
  }, []);

  // Anything changed → the old identity / confirmation no longer applies
  useEffect(() => { setConfirming(false); }, [port, baud, address, broadcast, newAddress, newBaud]);
  useEffect(() => { setIdent(null); setIdentErr(null); }, [port, baud, address, broadcast]);

  const portFull = port.startsWith('/dev/') ? port : `/dev/${port}`;
  const target: number | 'broadcast' = broadcast ? 'broadcast' : address;
  const sameAsNow = !broadcast && newAddress === address && newBaud === baud;
  const valid = !!port && Number.isInteger(newAddress) && newAddress >= 0 && newAddress <= 126 && (broadcast || (Number.isInteger(address) && address >= 0 && address <= 126));

  // The exact COMSET frame Aether will send (after the sequence-0 POLL, so sequence 1)
  const frame = useMemo(() => {
    const a = broadcast ? 0x7F : (address & 0x7F);
    const b = newBaud >>> 0;
    const body = [0x53, a, 13, 0x00, 0x05, 0x6E, newAddress & 0x7F, b & 0xFF, (b >> 8) & 0xFF, (b >> 16) & 0xFF, (b >>> 24) & 0xFF];
    const c = crc16(body);
    const bytes = [...body, c & 0xFF, c >> 8];
    const parts: { label: string; tone: string; bytes: number[] }[] = [
      { label: 'SOM', tone: 'bg-hv-data-gray-tint ring-hv-data-gray/40', bytes: bytes.slice(0, 1) },
      { label: 'ADDR', tone: 'bg-hv-data-blue-tint ring-hv-data-blue/40', bytes: bytes.slice(1, 2) },
      { label: 'LEN', tone: 'bg-hv-data-violet-tint ring-hv-data-violet/40', bytes: bytes.slice(2, 4) },
      { label: 'CTRL', tone: 'bg-hv-data-orange-tint ring-hv-data-orange/40', bytes: bytes.slice(4, 5) },
      { label: 'COMSET', tone: 'bg-hv-data-emerald-tint ring-hv-data-emerald/40', bytes: bytes.slice(5, 6) },
      { label: 'NEW ADDR', tone: 'bg-hv-data-green-tint ring-hv-data-green/40', bytes: bytes.slice(6, 7) },
      { label: 'NEW BAUD', tone: 'bg-hv-data-green-tint ring-hv-data-green/40', bytes: bytes.slice(7, 11) },
      { label: 'CRC', tone: 'bg-hv-data-red-tint ring-hv-data-red/40', bytes: bytes.slice(11, 13) },
    ];
    return { hex: bytes.map(h2).join(' '), parts };
  }, [broadcast, address, newAddress, newBaud]);

  const identify = async () => {
    setBusy('identify'); setIdent(null); setIdentErr(null);
    try {
      const j = await (await fetch('/api/osdp/firmware-identify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port: portFull, baud, address }) })).json();
      if (!j.success) throw new Error(j.error || 'No reply');
      setIdent(j);
    } catch (e: any) { setIdentErr(e.message || String(e)); }
    finally { setBusy(null); }
  };

  const send = async () => {
    setBusy('send'); setResult(null); setError(null); setConfirming(false);
    try {
      const r = await fetch('/api/osdp/firmware-comset', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: portFull, baud, address: broadcast ? undefined : address, broadcast, newAddress, newBaud, verify }),
      });
      const j: Result = await r.json();
      if (!j.outcome) throw new Error(j.error || `Request failed (${r.status})`);
      setResult(j);
      const entry: Recent = { at: new Date().toLocaleTimeString(), port: portFull, from: `${broadcast ? 'broadcast' : address} @ ${baud}`, to: `${newAddress} @ ${newBaud}`, outcome: OUTCOME[j.outcome]?.title || j.outcome };
      const next = [entry, ...recent].slice(0, 8);
      setRecent(next);
      try { sessionStorage.setItem('aether.comset.recent', JSON.stringify(next)); } catch { /* */ }
      // Follow the reader: next test starts from where it is now
      if (j.outcome === 'changed' || j.outcome === 'changed-other') {
        const to = j.com || j.requested;
        setBroadcast(false); setAddress(to.address); setBaud(to.baud);
      }
    } catch (e: any) { setError(e.message || String(e)); }
    finally { setBusy(null); }
  };

  const copy = (text: string) => { try { navigator.clipboard.writeText(text); } catch { /* */ } };

  return (
    <section className="rounded-hv-md border border-hv-line bg-hv-widget-panel p-5 flex flex-col gap-4 mt-4">
      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-start gap-2 min-w-0">
          <Cable size={18} className="text-hv-brand-fg mt-0.5 shrink-0" />
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-hv-text">Address &amp; baud (COMSET)</h3>
            <p className="text-xs text-hv-text-2 max-w-3xl">
              Change a reader's OSDP address or speed with <span className="font-mono">osdp_COMSET 0x6E</span> (SIA OSDP 2.2 §6.13). Standard OSDP, no vendor code needed.
              The reader answers with <span className="font-mono">osdp_COM 0x54</span> from its old address, then switches.
            </p>
          </div>
        </div>
      </header>

      {/* Current */}
      <div className="flex flex-col gap-2">
        <div className="text-[11px] font-semibold tracking-wider uppercase text-hv-text-3">Reader now</div>
        <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-[1.4fr_0.9fr_0.9fr_auto] items-end">
          <Field label="Port">
            <input id="comset-port" list="comset-ports" value={port} onChange={e => setPort(e.target.value)} className={`${INPUT} font-mono`} placeholder="ttyACM0" />
            <datalist id="comset-ports">{ports.map(p => <option key={p.path} value={p.path}>{p.label}</option>)}</datalist>
          </Field>
          <Field label="Baud">
            <select id="comset-baud" value={baud} onChange={e => setBaud(Number(e.target.value))} className={INPUT}>
              {BAUDS.map(b => <option key={b} value={b}>{b.toLocaleString()}</option>)}
            </select>
          </Field>
          <Field label="Address (0–126)">
            <input id="comset-addr" type="number" min={0} max={126} value={address} disabled={broadcast} onChange={e => setAddress(Number(e.target.value))} className={`${INPUT} font-mono disabled:opacity-40`} />
          </Field>
          <button type="button" onClick={identify} disabled={!port || broadcast || busy !== null} className={BTN_GHOST}>
            {busy === 'identify' ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />} Identify
          </button>
        </div>
        <label className="flex items-start gap-2 text-xs text-hv-text-2 cursor-pointer">
          <input id="comset-broadcast" type="checkbox" checked={broadcast} onChange={e => setBroadcast(e.target.checked)} className="mt-0.5 accent-[rgb(var(--hv-brand))]" />
          <span>Address unknown: send to broadcast (0x7F). <b className="text-hv-warning-fg">Only with this one reader on the wire</b>; every reader answers broadcast.</span>
        </label>
        {ident && (
          <div className="text-xs text-hv-text-2 px-3 py-2 rounded-hv-sm bg-hv-box border border-hv-line">
            {ident.identityAvailable === false ? 'Reader answered, but did not report its identity.'
              : <>Found <b className="text-hv-text">{ident.vendorName || 'unknown vendor'}</b> · model {ident.modelNumber ?? '—'} · serial <span className="font-mono">{ident.serialHex || '—'}</span> · firmware {ident.firmwareString || '—'}</>}
          </div>
        )}
        {identErr && <div className={`text-xs px-3 py-2 rounded-hv-sm ${TONE.error}`}>{identErr}</div>}
      </div>

      {/* New */}
      <div className="flex flex-col gap-2">
        <div className="text-[11px] font-semibold tracking-wider uppercase text-hv-text-3">Change to</div>
        <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-[0.9fr_0.9fr_2fr] items-end">
          <Field label="New address (0–126)">
            <input id="comset-new-addr" type="number" min={0} max={126} value={newAddress} onChange={e => setNewAddress(Number(e.target.value))} className={`${INPUT} font-mono`} />
          </Field>
          <Field label="New baud">
            <select id="comset-new-baud" value={newBaud} onChange={e => setNewBaud(Number(e.target.value))} className={INPUT}>
              {BAUDS.map(b => <option key={b} value={b}>{b.toLocaleString()}</option>)}
            </select>
          </Field>
          <label className="flex items-center gap-2 text-xs text-hv-text-2 cursor-pointer pb-2">
            <input id="comset-verify" type="checkbox" checked={verify} onChange={e => setVerify(e.target.checked)} className="accent-[rgb(var(--hv-brand))]" />
            Afterwards, check the reader answers at the new settings
          </label>
        </div>
        <p className="text-[11px] text-hv-text-3">To change only the address, keep the baud the same (and the other way round). A reader only has to support one speed; if it can't do yours, its COM reply says what it will use.</p>
      </div>

      {/* Frame preview */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[11px] font-semibold tracking-wider uppercase text-hv-text-3">Frame Aether will send <span className="normal-case tracking-normal font-normal">(after a sequence-0 POLL)</span></div>
          <button type="button" onClick={() => copy(frame.hex)} className="text-[11px] text-hv-text-2 hover:text-hv-text flex items-center gap-1"><Copy size={12} />Copy hex</button>
        </div>
        <div className="overflow-x-auto">
          <div className="flex gap-1.5 w-max">
            {frame.parts.map(p => (
              <div key={p.label} className={`flex flex-col items-center gap-1 px-2 py-1.5 rounded-hv-xs ring-1 ring-inset ${p.tone}`}>
                <span className="font-mono text-sm text-hv-text">{p.bytes.map(h2).join(' ')}</span>
                <span className="text-[9.5px] font-semibold tracking-wider text-hv-text-2">{p.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Send */}
      <div className="flex flex-col gap-2">
        {!confirming ? (
          <div className="flex items-center gap-3 flex-wrap">
            <button type="button" disabled={!valid || sameAsNow || busy !== null} onClick={() => setConfirming(true)}
              className="px-4 py-2 rounded-hv-sm text-sm font-semibold bg-hv-brand hover:bg-hv-brand-hover text-white disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2">
              {busy === 'send' ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
              {busy === 'send' ? 'Sending…' : 'Send COMSET'}
            </button>
            {sameAsNow && <span className="text-xs text-hv-text-3">New settings are the same as the current ones.</span>}
          </div>
        ) : (
          <div className={`flex flex-col gap-2 px-4 py-3 rounded-hv-sm ${TONE.warning}`}>
            <div className="text-sm">
              Move the reader on <span className="font-mono">{portFull}</span> from <b>{fmtAddr(target)} @ {baud.toLocaleString()}</b> to <b>{newAddress} @ {newBaud.toLocaleString()}</b>?
              The panel will lose this reader until its settings are changed to match. The emulator pauses on this port while it runs.
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={send} className="px-4 py-1.5 rounded-hv-sm text-sm font-semibold bg-hv-brand hover:bg-hv-brand-hover text-white">Yes, send</button>
              <button type="button" onClick={() => setConfirming(false)} className={BTN_GHOST}>Cancel</button>
            </div>
          </div>
        )}
        {error && <div className={`text-xs px-3 py-2 rounded-hv-sm flex items-center gap-2 ${TONE.error}`}><AlertTriangle size={14} />{error}</div>}
      </div>

      {/* Result */}
      {result && (
        <div className="flex flex-col gap-3">
          <div className={`px-4 py-3 rounded-hv-sm ${TONE[OUTCOME[result.outcome].tone]}`}>
            <div className="font-semibold text-sm">{OUTCOME[result.outcome].title}</div>
            <div className="text-xs mt-0.5">{OUTCOME[result.outcome].body(result)}</div>
          </div>

          <ol className="flex flex-col gap-1.5">
            {result.steps.map((s, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                {s.ok ? <CheckCircle2 size={16} className="text-hv-success-fg mt-0.5 shrink-0" /> : <XCircle size={16} className="text-hv-error-fg mt-0.5 shrink-0" />}
                <div className="min-w-0">
                  <div className="text-hv-text">{s.name}
                    {s.reply && <span className="text-hv-text-2"> → {s.reply}</span>}
                    {s.attempts && s.attempts > 1 && <span className="text-hv-text-3"> ({s.attempts} tries)</span>}
                  </div>
                  {s.name === 'COMSET' && result.com && (
                    <div className="text-xs text-hv-text-2">
                      COM reply: address <b>{result.com.address}</b>, <b>{result.com.baud.toLocaleString()}</b> baud
                      {s.matches === false && <span className="text-hv-warning-fg"> (not what was asked)</span>}
                    </div>
                  )}
                  {s.error && <div className="text-xs text-hv-error-fg">{s.error}</div>}
                  {s.hint && <div className="text-xs text-hv-text-2">{s.hint}</div>}
                  {s.note && <div className="text-xs text-hv-text-2">{s.note}</div>}
                </div>
              </li>
            ))}
          </ol>

          {result.wire?.length > 0 && (
            <details className="rounded-hv-sm border border-hv-line bg-hv-box" open>
              <summary className="px-3 py-2 text-xs text-hv-text-2 cursor-pointer select-none flex items-center justify-between gap-2">
                <span>Bytes on the wire ({result.wire.length})</span>
                <button type="button" onClick={e => { e.preventDefault(); copy(result.wire.map(w => `${String(w.t).padStart(5)}ms ${w.dir.toUpperCase()} @${w.baud} ${w.hex}`).join('\n')); }}
                  className="text-[11px] hover:text-hv-text flex items-center gap-1"><Copy size={12} />Copy</button>
              </summary>
              <div className="overflow-x-auto px-3 pb-3">
                <table className="text-xs font-mono w-max">
                  <tbody>
                    {result.wire.map((w, i) => (
                      <tr key={i}>
                        <td className="pr-3 text-right text-hv-text-3 tabular-nums">{w.t} ms</td>
                        <td className={`pr-3 font-semibold ${w.dir === 'tx' ? 'text-hv-info-fg' : 'text-hv-success-fg'}`}>{w.dir === 'tx' ? 'TX →' : 'RX ←'}</td>
                        <td className="pr-3 text-hv-text-3 tabular-nums">{w.baud}</td>
                        <td className="text-hv-text whitespace-nowrap">{w.hex}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </div>
      )}

      {recent.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <div className="text-[11px] font-semibold tracking-wider uppercase text-hv-text-3">This session</div>
            <button type="button" onClick={() => { setRecent([]); try { sessionStorage.removeItem('aether.comset.recent'); } catch { /* */ } }} className="text-[11px] text-hv-text-3 hover:text-hv-text flex items-center gap-1"><RotateCw size={11} />Clear</button>
          </div>
          <div className="overflow-x-auto rounded-hv-sm border border-hv-line">
            <table className="w-full text-xs">
              <thead><tr className="text-left text-hv-text-3 bg-hv-box">
                <th className="px-3 py-1.5 font-semibold">Time</th><th className="px-3 py-1.5 font-semibold">Port</th>
                <th className="px-3 py-1.5 font-semibold">From</th><th className="px-3 py-1.5 font-semibold">To</th><th className="px-3 py-1.5 font-semibold">Result</th>
              </tr></thead>
              <tbody>
                {recent.map((r, i) => (
                  <tr key={i} className="border-t border-hv-line text-hv-text-2">
                    <td className="px-3 py-1.5 tabular-nums">{r.at}</td><td className="px-3 py-1.5 font-mono">{r.port}</td>
                    <td className="px-3 py-1.5 font-mono">{r.from}</td><td className="px-3 py-1.5 font-mono">{r.to}</td><td className="px-3 py-1.5">{r.outcome}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
