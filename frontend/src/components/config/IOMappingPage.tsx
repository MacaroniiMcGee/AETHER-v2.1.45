// I/O Mapping: the HAT's 8 relay outputs, 8 monitored inputs, the 4 controller
// aux outputs, and a relay-usage strip that flags relays claimed twice.
// Channels are stored 0-based (as the backend expects) and shown 1-8, like the
// HAT's terminals and the `ioplus` command.
import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { T, Card, inputCls, inputStyle, Dot } from './ui';

type Item = { id: number; name: string; type: string; channel: number; active: boolean; [k: string]: any };

const INPUT_TYPES = ['None', 'REX-Button', 'Entry Sensor', 'Lock Sensor', 'Safety Beam', 'DPS', 'AUX', 'General'];
const OUTPUT_TYPES = ['None', 'Strike Follower', 'Lock', 'Auto Door', 'Sounder', 'Strobe', 'FAI', 'General'];
const CH = [0, 1, 2, 3, 4, 5, 6, 7];

interface Props {
  api: string;
  inputs: Item[];            // relay outputs (drive the device under test)
  outputs: Item[];           // monitored inputs (read from the device under test)
  controllerOutputs: Item[];
  onUpdateInput: (id: number, field: any, value: any) => void;
  onUpdateOutput: (id: number, field: any, value: any) => void;
  onUpdateControllerOutput?: (id: number, field: any, value: any) => void;
}

type Use = { who: string; kind: 'door' | 'elevator' | 'system' | 'controller' };

export default function IOMappingPage({ api, inputs, outputs, controllerOutputs, onUpdateInput, onUpdateOutput, onUpdateControllerOutput }: Props) {
  const [doorCfg, setDoorCfg] = useState<any>(null);
  useEffect(() => {
    fetch(`${api}/api/doors/config`).then(r => r.json()).then(j => setDoorCfg(j?.config || null)).catch(() => setDoorCfg(null));
  }, [api]);

  const aux = controllerOutputs.filter(o => o.id < 100);

  // Who else switches each HAT relay (1-8)
  const usage = useMemo(() => {
    const u: Record<number, Use[]> = {};
    const add = (relay1: number, x: Use) => { if (relay1 >= 1 && relay1 <= 8) (u[relay1] ||= []).push(x); };
    for (const d of doorCfg?.doors || []) {
      if (d.enabled === false || (d.ioSource && d.ioSource !== 'physical')) continue;
      if (d.lock && typeof d.lock.channel === 'number' && !(d.lock.stackLevel > 0)) add(d.lock.channel + 1, { who: `${d.name} strike`, kind: 'door' });
    }
    const so = doorCfg?.systemOutputs || {};
    for (const [k, label] of [['powerFault', 'Power fault'], ['batteryFault', 'Battery fault'], ['tamper', 'System tamper'], ['fai', 'Fire alarm']] as const) {
      const ch = so[k]?.channel; if (typeof ch === 'number' && ch >= 0) add(ch + 1, { who: `${label} output`, kind: 'system' });
    }
    try {
      const el = JSON.parse(localStorage.getItem('aether.elevator.v2') || 'null');
      for (const f of el?.floors || []) if (f.relay > 0) add(f.relay, { who: `Elevator floor ${f.id} tracking`, kind: 'elevator' });
    } catch { /* none */ }
    for (const o of aux) add(o.channel + 1, { who: o.name, kind: 'controller' });
    return u;
  }, [doorCfg, aux]);

  const conflicts = Object.entries(usage).filter(([, l]) => l.length > 1);
  const relayName = (n1: number) => inputs.find(i => i.channel === n1 - 1)?.name;

  const Th = ({ children, w }: { children?: React.ReactNode; w?: string }) =>
    <th className={`text-left text-[10px] font-bold tracking-wider px-2 py-2 ${w || ''}`} style={{ color: T.dim }}>{children}</th>;
  const td = 'px-2 py-1.5 align-middle';

  return (
    <div className="space-y-4">
      {/* Relay usage */}
      <Card title="Relay usage" right={conflicts.length
        ? <span className="flex items-center gap-1.5 text-xs font-semibold" style={{ color: T.crit }}><AlertTriangle size={14} />{conflicts.length} relay{conflicts.length > 1 ? 's' : ''} used twice</span>
        : <span className="text-xs" style={{ color: T.dim }}>No relay is used twice</span>}>
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
          {CH.map(c => {
            const n = c + 1, users = usage[n] || [], clash = users.length > 1;
            return (
              <div key={n} className="rounded-lg border px-2.5 py-2 min-h-[84px]"
                style={{ background: T.well, borderColor: clash ? T.crit : T.line }}>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold font-mono" style={{ color: T.text }}>Relay {n}</span>
                  {clash && <AlertTriangle size={13} style={{ color: T.crit }} aria-label="used twice" />}
                </div>
                <div className="text-[10px] truncate" style={{ color: T.dim }} title={relayName(n)}>{relayName(n) || '—'}</div>
                <div className="mt-1 space-y-0.5">
                  {users.length === 0
                    ? <div className="text-[10px]" style={{ color: T.faint }}>not claimed</div>
                    : users.map((x, i) => <div key={i} className="text-[10px] leading-tight truncate" title={x.who} style={{ color: clash ? 'rgb(var(--hv-error-text))' : T.text2 }}>{x.who}</div>)}
                </div>
              </div>
            );
          })}
        </div>
        {conflicts.length > 0 && (
          <p className="text-xs mt-3" style={{ color: T.text2 }}>
            A relay used twice switches whenever <em>either</em> user switches it. Move one of them to a free relay on the Doors page, the Elevator page (Settings), or below.
          </p>
        )}
      </Card>

      {/* Relay outputs */}
      <Card title={<>Relay outputs <span className="font-normal text-xs" style={{ color: T.dim }}>· the HAT drives these into the device under test</span></>} pad={false}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b" style={{ borderColor: T.line }}><Th w="w-8" /><Th>Name</Th><Th w="w-44">Function</Th><Th w="w-28">Relay</Th><Th w="w-48">Resting state</Th></tr></thead>
            <tbody>
              {inputs.map(i => (
                <tr key={i.id} className="border-b last:border-b-0" style={{ borderColor: T.line }}>
                  <td className={td}><Dot on={i.active} title={i.active ? 'Energized' : 'Off'} /></td>
                  <td className={td}><input className={inputCls} style={inputStyle} value={i.name} onChange={e => onUpdateInput(i.id, 'name', e.target.value)} /></td>
                  <td className={td}><select className={inputCls} style={inputStyle} value={i.type} onChange={e => onUpdateInput(i.id, 'type', e.target.value)}>{INPUT_TYPES.map(t => <option key={t}>{t}</option>)}</select></td>
                  <td className={td}><select className={inputCls} style={inputStyle} value={i.channel} onChange={e => onUpdateInput(i.id, 'channel', parseInt(e.target.value))}>{CH.map(c => <option key={c} value={c}>Relay {c + 1}</option>)}</select></td>
                  <td className={td}><select className={inputCls} style={inputStyle} value={i.restingState || 'NO'} onChange={e => onUpdateInput(i.id, 'restingState', e.target.value)}><option value="NO">NO · normally open</option><option value="NC">NC · normally closed</option></select></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Monitored inputs */}
      <Card title={<>Monitored inputs <span className="font-normal text-xs" style={{ color: T.dim }}>· the HAT reads these from the device under test</span></>} pad={false}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b" style={{ borderColor: T.line }}><Th w="w-8" /><Th>Name</Th><Th w="w-40">Function</Th><Th w="w-28">Input</Th><Th w="w-40">Kind</Th><Th w="w-48">Wiring</Th></tr></thead>
            <tbody>
              {outputs.map(o => {
                const sup = o.supervisionState && o.supervisionState !== 'normal' ? o.supervisionState : null;
                return (
                  <tr key={o.id} className="border-b last:border-b-0" style={{ borderColor: T.line }}>
                    <td className={td}><Dot on={o.active || !!sup} color={sup === 'trouble' ? T.warn : sup === 'short' ? T.crit : T.teal} title={sup ? sup.toUpperCase() : o.active ? 'Active' : 'Normal'} /></td>
                    <td className={td}><input className={inputCls} style={inputStyle} value={o.name} onChange={e => onUpdateOutput(o.id, 'name', e.target.value)} /></td>
                    <td className={td}><select className={inputCls} style={inputStyle} value={o.type} onChange={e => onUpdateOutput(o.id, 'type', e.target.value)}>{OUTPUT_TYPES.map(t => <option key={t}>{t}</option>)}</select></td>
                    <td className={td}><select className={inputCls} style={inputStyle} value={o.channel} onChange={e => onUpdateOutput(o.id, 'channel', parseInt(e.target.value))}>{CH.map(c => <option key={c} value={c}>Input {c + 1}</option>)}</select></td>
                    <td className={td}><select className={inputCls} style={inputStyle} value={o.inputType || 'opto'} onChange={e => onUpdateOutput(o.id, 'inputType', e.target.value)}><option value="opto">Opto</option><option value="analog">Analog 0–10 V</option></select></td>
                    <td className={td}><select className={inputCls} style={inputStyle} value={o.supervisionType || 'NO'} onChange={e => onUpdateOutput(o.id, 'supervisionType', e.target.value)}>
                      <option value="NO">NO</option><option value="NC">NC</option><option value="Supervised-NO">Supervised NO (EOL)</option><option value="Supervised-NC">Supervised NC (EOL)</option></select></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] px-4 py-2 border-t" style={{ color: T.dim, borderColor: T.line }}>Supervised inputs use the analog channel and the EOL calibration profile (EOL Calibration tab).</p>
      </Card>

      {/* Controller aux outputs */}
      {aux.length > 0 && (
        <Card title={<>Controller aux outputs <span className="font-normal text-xs" style={{ color: T.dim }}>· shown on the I/O page, switch a HAT relay</span></>} pad={false}>
          <table className="w-full text-sm">
            <thead><tr className="border-b" style={{ borderColor: T.line }}><Th w="w-8" /><Th>Name</Th><Th w="w-44">Function</Th><Th w="w-28">Relay</Th></tr></thead>
            <tbody>
              {aux.map(o => (
                <tr key={o.id} className="border-b last:border-b-0" style={{ borderColor: T.line }}>
                  <td className={td}><Dot on={o.active} color={T.amber} /></td>
                  <td className={td}><input className={inputCls} style={inputStyle} value={o.name} onChange={e => onUpdateControllerOutput?.(o.id, 'name', e.target.value)} /></td>
                  <td className={td}><select className={inputCls} style={inputStyle} value={o.type} onChange={e => onUpdateControllerOutput?.(o.id, 'type', e.target.value)}>{OUTPUT_TYPES.map(t => <option key={t}>{t}</option>)}</select></td>
                  <td className={td}><select className={inputCls} style={inputStyle} value={o.channel} onChange={e => onUpdateControllerOutput?.(o.id, 'channel', parseInt(e.target.value))}>{CH.map(c => <option key={c} value={c}>Relay {c + 1}</option>)}</select></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
