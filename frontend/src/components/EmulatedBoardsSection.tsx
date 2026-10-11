// Emulated downstream boards (Controller Emulator) on the I/O page.
//
// One card per emulated Azure board, with the board photo behind it.
//  - Inputs are clickable. A click changes the input on the emulated board, and
//    the board reports it to the controller over OSDP (osdp_ISTATR) on its next
//    poll, exactly as a real contact closing would.
//  - Tamper / Power fail are sent the same way (osdp_LSTATR).
//  - Outputs are lamps. They're driven by the controller (osdp_OUT), so they
//    show what the controller commanded and aren't clickable here.
// Readers stay on the Controller Emulator tab.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { Socket } from 'socket.io-client';

type Device = {
  address: number;
  model: string;
  online?: boolean;
  pollCount?: number;
  lastPollAt?: number | null;
  numInputs: number;
  numOutputs: number;
  inputs: number[] | null;
  outputs: number[] | null;
  tamperActive?: boolean;
  powerFailActive?: boolean;
};

type Props = {
  ipAddress: string;
  connected: boolean;
  socket: Socket | null;
  logSystem: (type: any, message: string) => void;
};

// Board diagrams: native size + the white border to trim (top, right, bottom, left, in %)
type BoardImg = { src: string; w: number; h: number; crop: [number, number, number, number] };
const IO168S_IMG: BoardImg = { src: '/images/devices/IO168S.png', w: 701, h: 517, crop: [4.5, 4, 3, 2.5] };
const BOARD_IMG: Record<string, BoardImg> = {
  IO168S: IO168S_IMG, I16S: IO168S_IMG, O8S: IO168S_IMG,
  RI2MS: { src: '/images/devices/RI2MS.png', w: 329, h: 515, crop: [2, 2.5, 2, 6] },
  RI4S: { src: '/images/devices/RI4S.png', w: 656, h: 469, crop: [3, 1, 1, 1] },
};

// The whole board at its real proportions, as tall as the card, on the right,
// fading out toward the controls.
function BoardBackdrop({ img }: { img: BoardImg }) {
  const [t, r, b, l] = img.crop.map(v => v / 100);
  const cw = 1 - l - r, ch = 1 - t - b;
  const aspect = (img.w * cw) / (img.h * ch);
  return (
    <div className="absolute top-0 right-0 bottom-0 overflow-hidden pointer-events-none select-none"
      style={{
        aspectRatio: String(aspect), maxWidth: '62%',
        WebkitMaskImage: 'linear-gradient(to left, #000 55%, transparent 100%)',
        maskImage: 'linear-gradient(to left, #000 55%, transparent 100%)',
      }}>
      <img src={img.src} alt="" aria-hidden draggable={false}
        style={{
          position: 'absolute', maxWidth: 'none',
          width: `${100 / cw}%`, height: `${100 / ch}%`,
          left: `${(-l / cw) * 100}%`, top: `${(-t / ch) * 100}%`,
          opacity: 0.5, filter: 'saturate(0.85)',
        }} />
    </div>
  );
}

const C = {
  panel: 'rgb(var(--hv-widget) / 0.55)', border: 'rgb(var(--hv-line))', text: 'rgb(var(--hv-text))', dim: 'rgb(var(--hv-text-3))',
  in: 'rgb(var(--hv-success))', out: 'rgb(var(--hv-info))', warn: 'rgb(var(--hv-warning))', crit: 'rgb(var(--hv-error))', off: 'rgb(var(--hv-line-strong))',
};

export default function EmulatedBoardsSection({ ipAddress, connected, socket, logSystem }: Props) {
  const api = `http://${ipAddress}:3001/api/emulator`;
  const [devices, setDevices] = useState<Record<number, Device>>({});
  const [running, setRunning] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({});

  const refresh = useCallback(async () => {
    try {
      const j = await (await fetch(`${api}/status`)).json();
      const st = j.status || {};
      setRunning(!!st.running);
      const map: Record<number, Device> = {};
      for (const d of st.devices || []) map[d.address] = d;
      setDevices(map);
    } catch { setRunning(null); }
  }, [api]);

  // Initial load + light polling for online/poll counters (no I2C involved)
  useEffect(() => {
    if (!connected) return;
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [connected, refresh]);

  // Live updates
  useEffect(() => {
    if (!socket) return;
    const upd = (d: Device) => { if (d && d.address != null) setDevices(p => ({ ...p, [d.address]: { ...p[d.address], ...d } })); };
    const removed = (p: { address: number }) => setDevices(prev => { const n = { ...prev }; delete n[p.address]; return n; });
    const stopped = () => { setRunning(false); refresh(); };
    socket.on('emulator-device-update', upd);
    socket.on('emulator-device-added', upd);
    socket.on('emulator-device-removed', removed);
    socket.on('emulator-started', refresh);
    socket.on('emulator-config-applied', refresh);
    socket.on('emulator-stopped', stopped);
    return () => {
      socket.off('emulator-device-update', upd);
      socket.off('emulator-device-added', upd);
      socket.off('emulator-device-removed', removed);
      socket.off('emulator-started', refresh);
      socket.off('emulator-config-applied', refresh);
      socket.off('emulator-stopped', stopped);
    };
  }, [socket, refresh]);

  const post = async (path: string, body: any) => {
    const r = await fetch(`${api}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.success === false) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  };

  const toggleInput = async (d: Device, idx: number) => {
    const key = `${d.address}:in:${idx}`;
    const next = !(d.inputs && d.inputs[idx]);
    setBusy(b => ({ ...b, [key]: true }));
    // optimistic
    setDevices(p => {
      const cur = p[d.address]; if (!cur || !cur.inputs) return p;
      const inputs = [...cur.inputs]; inputs[idx] = next ? 1 : 0;
      return { ...p, [d.address]: { ...cur, inputs } };
    });
    try {
      await post(`/device/${d.address}/input/${idx}`, { active: next });
      logSystem('io', `#${d.address} ${d.model} Input ${idx} → ${next ? 'ACTIVE' : 'NORMAL'} (OSDP input status sent to controller)`);
    } catch (e: any) {
      logSystem('error', `#${d.address} Input ${idx}: ${e.message}`);
      refresh();
    } finally { setBusy(b => { const n = { ...b }; delete n[key]; return n; }); }
  };

  const toggleStatus = async (d: Device, kind: 'tamper' | 'powerfail') => {
    const cur = kind === 'tamper' ? !!d.tamperActive : !!d.powerFailActive;
    try {
      await post(`/device/${d.address}/${kind}`, { active: !cur });
      setDevices(p => ({ ...p, [d.address]: { ...p[d.address], ...(kind === 'tamper' ? { tamperActive: !cur } : { powerFailActive: !cur }) } }));
      logSystem('io', `#${d.address} ${d.model} ${kind === 'tamper' ? 'Tamper' : 'Power fail'} ${!cur ? 'ALARM' : 'cleared'} (OSDP local status sent)`);
    } catch (e: any) { logSystem('error', `#${d.address} ${kind}: ${e.message}`); }
  };

  const clearInputs = async (d: Device) => {
    const on = (d.inputs || []).map((v, i) => (v ? i : -1)).filter(i => i >= 0);
    for (const i of on) { await toggleInput({ ...d, inputs: d.inputs }, i); }
  };

  const list = useMemo(() => Object.values(devices).sort((a, b) => a.address - b.address), [devices]);
  const activeIns = list.reduce((a, d) => a + (d.inputs || []).filter(Boolean).length, 0);
  const activeOuts = list.reduce((a, d) => a + (d.outputs || []).filter(Boolean).length, 0);
  const alarms = list.filter(d => d.tamperActive || d.powerFailActive).length;
  const allCollapsed = list.length > 0 && list.every(d => collapsed[d.address]);

  return (
    <div className="backdrop-blur rounded-xl p-6 border" style={{ background: C.panel, borderColor: C.border }}>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h2 className="text-2xl font-bold flex items-center gap-2">
          <div className="w-3 h-3 rounded-full animate-pulse" style={{ background: C.in }} />
          Emulated Downstream Boards
          <span className="text-sm font-normal" style={{ color: C.dim }}>OSDP · Controller Emulator</span>
        </h2>
        {list.length > 0 && (
          <div className="flex items-center gap-3 text-xs" style={{ color: C.dim }}>
            <span>{list.length} board{list.length === 1 ? '' : 's'}</span>
            <span style={{ color: activeIns ? C.in : C.dim }}>{activeIns} inputs active</span>
            <span style={{ color: activeOuts ? C.out : C.dim }}>{activeOuts} outputs on</span>
            {alarms > 0 && <span style={{ color: C.crit }}>{alarms} alarm{alarms === 1 ? '' : 's'}</span>}
            <button
              onClick={() => setCollapsed(allCollapsed ? {} : Object.fromEntries(list.map(d => [d.address, true])))}
              className="px-2 py-1 rounded border hover:bg-hv-contrast/5" style={{ borderColor: C.border, color: C.text }}>
              {allCollapsed ? 'Expand all' : 'Collapse all'}
            </button>
          </div>
        )}
      </div>

      {list.length > 0 && running === false && (
        <div className="rounded-lg px-4 py-2 mb-3 text-sm border" style={{ borderColor: 'rgb(var(--hv-line-strong))', color: 'rgb(var(--hv-brand-text))', background: 'rgb(var(--hv-brand-hover) / 0.12)' }}>
          The Controller Emulator is stopped. Changes here are kept on the boards and reach the controller once it's started again.
        </div>
      )}
      {list.length === 0 ? (
        <div className="rounded-lg p-6 text-center text-sm border" style={{ borderColor: 'rgb(var(--hv-popup-panel))', color: C.dim, background: 'rgb(var(--hv-surface) / 0.5)' }}>
          {running === false || running === null
            ? 'The Controller Emulator isn’t running. Start it on the Controller Emulator tab to drive emulated board inputs from here.'
            : 'No boards configured. Add boards on the Controller Emulator tab.'}
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {list.map(d => {
            const img = BOARD_IMG[d.model] || BOARD_IMG[String(d.model).toUpperCase()];
            const online = d.online !== false && (d.pollCount ?? 1) > 0;
            const alarm = d.tamperActive || d.powerFailActive;
            const isCollapsed = !!collapsed[d.address];
            const nIn = (d.inputs || []).filter(Boolean).length;
            const nOut = (d.outputs || []).filter(Boolean).length;
            return (
              <div key={d.address} className="relative overflow-hidden rounded-lg border"
                style={{ borderColor: alarm ? C.crit : online ? 'rgb(var(--hv-modal))' : 'rgb(var(--hv-popup-panel))', background: 'rgb(var(--hv-surface))' }}>
                {img && <BoardBackdrop img={img} />}
                <div className="absolute inset-0 pointer-events-none"
                  style={{ background: 'linear-gradient(90deg, rgb(var(--hv-surface) / 0.35) 0%, rgb(var(--hv-surface) / 0.25) 100%)' }} />

                <div className="relative p-4">
                  {/* header */}
                  <div className="flex items-center justify-between gap-2">
                    <button className="flex items-center gap-3 min-w-0 text-left" onClick={() => setCollapsed(c => ({ ...c, [d.address]: !c[d.address] }))}>
                      <span className="w-3 h-3 rounded-full shrink-0" title={online ? 'Being polled by the controller' : 'Not polled yet'}
                        style={{ background: online ? C.in : C.off, boxShadow: online ? `0 0 8px color-mix(in srgb, ${C.in} 40%, transparent)` : 'none' }} />
                      <div className="min-w-0">
                        <div className="font-bold truncate" style={{ color: C.text }}>#{d.address} {d.model}</div>
                        <div className="text-xs" style={{ color: 'rgb(var(--hv-text-2))', textShadow: '0 1px 3px #000' }}>
                          {d.numInputs} in / {d.numOutputs} out · {online ? `polls ${d.pollCount ?? '–'}` : 'waiting for controller'}
                          {isCollapsed && ` · ${nIn} in active, ${nOut} out on`}
                        </div>
                      </div>
                    </button>
                    <div className="flex items-center gap-2 shrink-0">
                      <StatusBtn label="Tamper" on={!!d.tamperActive} onClick={() => toggleStatus(d, 'tamper')} disabled={!connected} />
                      <StatusBtn label="Power" on={!!d.powerFailActive} onClick={() => toggleStatus(d, 'powerfail')} disabled={!connected} />
                    </div>
                  </div>

                  {!isCollapsed && (
                    <>
                      {d.numInputs > 0 && (
                        <div className="mt-4">
                          <div className="flex items-center justify-between mb-1.5">
                            <div className="text-[11px] font-semibold tracking-wider" style={{ color: 'rgb(var(--hv-text-2))', textShadow: '0 1px 3px #000' }}>INPUTS · click to send over OSDP</div>
                            {nIn > 0 && (
                              <button onClick={() => clearInputs(d)} className="text-[11px] underline" style={{ color: 'rgb(var(--hv-text-2))', textShadow: '0 1px 3px #000' }}>all normal</button>
                            )}
                          </div>
                          <div className="grid grid-cols-8 gap-1.5">
                            {Array.from({ length: d.numInputs }, (_, i) => {
                              const on = !!(d.inputs && d.inputs[i]);
                              const b = busy[`${d.address}:in:${i}`];
                              return (
                                <button key={i} onClick={() => toggleInput(d, i)} disabled={!connected || b}
                                  title={`Input ${i}: ${on ? 'ACTIVE' : 'normal'}. Click to ${on ? 'restore' : 'activate'}; the board reports it to the controller on its next poll.`}
                                  className="h-9 rounded-md text-xs font-bold border transition-all disabled:opacity-50"
                                  style={{
                                    background: on ? 'rgb(var(--hv-success-strong) / 0.92)' : 'rgb(var(--hv-surface) / 0.82)',
                                    borderColor: on ? C.in : 'rgb(var(--hv-line))',
                                    color: on ? 'rgb(var(--hv-text))' : 'rgb(var(--hv-text-2))',
                                    boxShadow: on ? `0 0 10px color-mix(in srgb, ${C.in} 33%, transparent)` : 'none',
                                  }}>
                                  {i}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {d.numOutputs > 0 && (
                        <div className="mt-3">
                          <div className="text-[11px] font-semibold tracking-wider mb-1.5" style={{ color: 'rgb(var(--hv-text-2))', textShadow: '0 1px 3px #000' }}>OUTPUTS · set by the controller</div>
                          <div className="grid grid-cols-8 gap-1.5">
                            {Array.from({ length: d.numOutputs }, (_, i) => {
                              const on = !!(d.outputs && d.outputs[i]);
                              return (
                                <div key={i} title={`Output ${i}: ${on ? 'ON' : 'off'} (commanded by the controller)`}
                                  className="h-7 rounded-md text-xs font-bold flex items-center justify-center gap-1 border"
                                  style={{
                                    background: on ? 'rgb(var(--hv-info-tint-strong) / 0.92)' : 'rgb(var(--hv-surface) / 0.8)',
                                    borderColor: on ? C.out : 'rgb(var(--hv-popup-panel))',
                                    color: on ? 'rgb(var(--hv-success-text))' : C.dim,
                                  }}>
                                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: on ? C.out : C.off, boxShadow: on ? `0 0 6px ${C.out}` : 'none' }} />
                                  {i}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StatusBtn({ label, on, onClick, disabled }: { label: string; on: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled}
      title={`${label} ${on ? 'ALARM — click to clear' : 'normal — click to raise'} (sent to the controller over OSDP)`}
      className="px-2.5 py-1 rounded-md text-[11px] font-bold border transition-all disabled:opacity-40"
      style={{
        background: on ? 'rgb(var(--hv-error-strong) / 0.35)' : 'rgb(var(--hv-surface) / 0.7)',
        borderColor: on ? 'rgb(var(--hv-error))' : 'rgb(var(--hv-line))',
        color: on ? 'rgb(var(--hv-error-text))' : 'rgb(var(--hv-text-2))',
      }}>
      {label}{on ? ' !' : ''}
    </button>
  );
}
