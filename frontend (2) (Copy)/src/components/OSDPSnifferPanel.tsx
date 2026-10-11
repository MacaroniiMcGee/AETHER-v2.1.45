import React, { useState, useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';

interface SnifferFrame {
  ts: string; address: number; isReply: boolean; sequence: number;
  cmd: string; cmdName: string; length: number;
  dataHex: string; fullHex: string; decoded: any;
}
interface PortInfo { path: string; manufacturer: string | null; serialNumber: string | null; reserved: boolean; }

export default function OSDPSnifferPanel() {
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [selectedPort, setSelectedPort] = useState('');
  const [baud, setBaud] = useState(9600);
  const [address, setAddress] = useState(0);
  const [pollMs, setPollMs] = useState(100);
  const [active, setActive] = useState(false);
  const [frames, setFrames] = useState<SnifferFrame[]>([]);
  const [hideAcks, setHideAcks] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const s = io({ transports: ['websocket', 'polling'] });
    socketRef.current = s;
    s.on('osdp-sniffer-frame', (f: SnifferFrame) => setFrames(prev => [f, ...prev].slice(0, 500)));
    s.on('osdp-sniffer-status', (st: any) => setActive(st.active));
    s.on('osdp-sniffer-error', (e: any) => setError(e.message));
    return () => { s.disconnect(); };
  }, []);

  useEffect(() => { void refreshPorts(); void refreshStatus(); }, []);

  async function refreshPorts() {
    try {
      const res = await fetch('/api/osdp/sniffer/ports');
      const json = await res.json();
      setPorts(json.ports || []);
      const first = (json.ports || []).find((p: PortInfo) => !p.reserved);
      if (first && !selectedPort) setSelectedPort(first.path);
    } catch (e: any) { setError(e.message); }
  }
  async function refreshStatus() {
    try { const j = await (await fetch('/api/osdp/sniffer/status')).json(); setActive(j.active); if (j.port) setSelectedPort(j.port); } catch {}
  }
  async function start() {
    setError(null);
    try {
      const res = await fetch('/api/osdp/sniffer/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: selectedPort, baud, address, pollMs })
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'start failed');
      setFrames([]);
    } catch (e: any) { setError(e.message); }
  }
  async function stop() {
    try { await fetch('/api/osdp/sniffer/stop', { method: 'POST' }); } catch (e: any) { setError(e.message); }
  }

  const visible = hideAcks ? frames.filter(f => f.cmdName !== 'ACK') : frames;

  return (
    <div className="space-y-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
        <h3 className="text-lg font-semibold mb-1">Reader Sniffer</h3>
        <p className="text-sm text-zinc-400 mb-4">
          Pi-as-ACU mode. Plug a real OSDP reader into a USB-RS485 adapter, pick the port, hit Start, then press keys on the reader.
          Replies appear below — KEYPAD/RAW frames are highlighted.
        </p>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
          <label className="flex flex-col text-xs">
            <span className="text-zinc-400 mb-1">Port</span>
            <select value={selectedPort} onChange={e => setSelectedPort(e.target.value)} disabled={active}
              className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm">
              <option value="">— select —</option>
              {ports.map(p => (
                <option key={p.path} value={p.path} disabled={p.reserved}>
                  {p.path}{p.reserved ? ' (in use)' : ''}{p.manufacturer ? ` — ${p.manufacturer}` : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col text-xs">
            <span className="text-zinc-400 mb-1">Baud</span>
            <select value={baud} onChange={e => setBaud(parseInt(e.target.value))} disabled={active}
              className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm">
              {[9600, 19200, 38400, 57600, 115200, 230400].map(b => <option key={b} value={b}>{b}</option>)}
            </select>
          </label>
          <label className="flex flex-col text-xs">
            <span className="text-zinc-400 mb-1">Address (0–127)</span>
            <input type="number" min={0} max={127} value={address}
              onChange={e => setAddress(Math.max(0, Math.min(127, parseInt(e.target.value) || 0)))}
              disabled={active}
              className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm" />
          </label>
          <label className="flex flex-col text-xs">
            <span className="text-zinc-400 mb-1">Poll interval (ms)</span>
            <input type="number" min={50} max={5000} step={10} value={pollMs}
              onChange={e => setPollMs(parseInt(e.target.value) || 100)}
              disabled={active}
              className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm" />
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button onClick={refreshPorts} className="px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 rounded text-sm">↻ Refresh ports</button>
          {!active ? (
            <button onClick={start} disabled={!selectedPort}
              className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded text-sm font-medium">
              ▶ Start sniff
            </button>
          ) : (
            <button onClick={stop}
              className="px-4 py-1.5 bg-red-600 hover:bg-red-500 rounded text-sm font-medium">■ Stop</button>
          )}
          <button onClick={() => setFrames([])} className="px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 rounded text-sm">Clear</button>
          <label className="flex items-center gap-1.5 text-sm text-zinc-400 ml-auto">
            <input type="checkbox" checked={hideAcks} onChange={e => setHideAcks(e.target.checked)} />Hide ACKs
          </label>
        </div>

        {error && <div className="mt-3 p-2 bg-red-950 border border-red-800 text-red-200 rounded text-sm">{error}</div>}
        {active && (
          <div className="mt-3 flex items-center gap-2 text-sm">
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
            <span className="text-emerald-400">Active — press keys on the reader</span>
          </div>
        )}
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        <div className="px-4 py-2 bg-zinc-950 border-b border-zinc-800 text-xs text-zinc-400">
          {visible.length} frames {hideAcks && frames.length !== visible.length && `(${frames.length - visible.length} ACKs hidden)`}
        </div>
        <div className="overflow-x-auto max-h-96 overflow-y-auto">
          <table className="w-full text-xs font-mono">
            <thead className="bg-zinc-950 text-zinc-400 sticky top-0">
              <tr>
                <th className="px-3 py-1.5 text-left">Time</th>
                <th className="px-3 py-1.5 text-left">Cmd</th>
                <th className="px-3 py-1.5 text-left">Addr</th>
                <th className="px-3 py-1.5 text-left">Seq</th>
                <th className="px-3 py-1.5 text-left">Data (hex)</th>
                <th className="px-3 py-1.5 text-left">Decoded</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((f, i) => {
                const interesting = ['KEYPAD', 'RAW', 'NAK'].includes(f.cmdName);
                return (
                  <tr key={i} className={`border-t border-zinc-800 ${interesting ? 'bg-amber-950/30' : ''}`}>
                    <td className="px-3 py-1 text-zinc-500">{f.ts.slice(11, 23)}</td>
                    <td className={`px-3 py-1 ${interesting ? 'text-amber-300 font-bold' : 'text-zinc-300'}`}>
                      {f.cmdName} <span className="text-zinc-600">({f.cmd})</span>
                    </td>
                    <td className="px-3 py-1 text-zinc-400">0x{f.address.toString(16).padStart(2,'0').toUpperCase()}</td>
                    <td className="px-3 py-1 text-zinc-400">{f.sequence}</td>
                    <td className="px-3 py-1 text-zinc-300">{f.dataHex || <span className="text-zinc-600">–</span>}</td>
                    <td className="px-3 py-1 text-emerald-300">{f.decoded ? JSON.stringify(f.decoded) : ''}</td>
                  </tr>
                );
              })}
              {visible.length === 0 && (
                <tr><td colSpan={6} className="px-3 py-6 text-center text-zinc-500">
                  {active ? 'Waiting for reader replies…' : 'Press Start to begin'}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
