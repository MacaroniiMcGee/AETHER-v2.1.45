// AETHER_TRACE — send a door / area / zone command to OnCAFE from Aether and trace it to the door.
import React, { useMemo, useState } from 'react';
import { AlertTriangle, Send } from 'lucide-react';
import { Button, Dialog, Field, Input, Select } from '../sunapi/ui';
import type { Status, TraceApi } from './api';

type K = 'override' | 'lockdown' | 'maintenance' | 'shunt' | 'outputzone' | 'inputzone';
const KINDS: { id: K; label: string; on: string; off: string; target: 'door' | 'area' | 'zone' }[] = [
  { id: 'override', label: 'Temporary unlock (door)', on: 'unlock', off: 'lock', target: 'door' },
  { id: 'lockdown', label: 'Lockdown (area)', on: 'on', off: 'off', target: 'area' },
  { id: 'maintenance', label: 'Maintenance mode (door)', on: 'on', off: 'off', target: 'door' },
  { id: 'shunt', label: 'Shunt reader (door)', on: 'shunt', off: 'unshunt', target: 'door' },
  { id: 'outputzone', label: 'Output zone', on: 'activate', off: 'deactivate', target: 'zone' },
  { id: 'inputzone', label: 'Input zone', on: 'arm', off: 'disarm', target: 'zone' },
];

export const CommandDialog: React.FC<{ open: boolean; onClose: () => void; api: TraceApi; status: Status; onSent: (msg: string) => void }> = ({ open, onClose, api, status, onSent }) => {
  const inv = status.inventory;
  const doors = useMemo(() => (inv ? inv.doors.filter(d => status.settings.cloud.doors.includes(d.id)) : []), [inv, status.settings.cloud.doors]);
  const areas = useMemo(() => (inv ? inv.areas.filter(a => doors.some(d => d.areaIds.includes(a.id))) : []), [inv, doors]);
  const zones = inv ? inv.zones.filter(z => status.settings.cloud.zones.includes(z.id)) : [];
  const [kind, setKind] = useState<K>('override');
  const [target, setTarget] = useState('');
  const [on, setOn] = useState(true);
  const [seconds, setSeconds] = useState(10);
  const [revert, setRevert] = useState(10);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const k = KINDS.find(x => x.id === kind)!;
  const targets = k.target === 'door' ? doors : k.target === 'area' ? areas : zones;
  const tName = (targets as { id: string; name: string }[]).find(x => x.id === target)?.name || '';
  const value = kind === 'override' ? (on ? 'unlock' : 'lock') : kind === 'outputzone' ? (on ? 'activate' : 'deactivate') : kind === 'inputzone' ? (on ? 'arm' : 'disarm') : on;
  const canRevert = kind !== 'override' && on;   // only an "on" command is turned back
  React.useEffect(() => { if (open) { setTarget(''); setConfirm(false); setErr(null); } }, [open]);
  const send = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.command({ kind, target, value, seconds: kind === 'override' ? seconds : undefined, revertSec: canRevert ? revert : 0 });
      if (!r.ok) throw new Error(`OnCAFE refused it: ${r.error || 'HTTP ' + r.status}`);
      onSent(`${k.label.replace(/ \(.*/, '')} ${on ? k.on : k.off} → ${tName}: OnCAFE answered in ${r.ackMs} ms${r.revertIn ? `; turning it back in ${r.revertIn} s` : ''}`);
      setConfirm(false); onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={() => { setConfirm(false); onClose(); }} title="Send a command from Aether" width={520}
      footer={confirm ? (
        <>
          <Button tone="ghost" onClick={() => setConfirm(false)}>Back</Button>
          <Button tone="danger" icon={<Send size={13} />} busy={busy} onClick={send}>Yes, send it</Button>
        </>
      ) : (
        <>
          <Button tone="ghost" onClick={onClose}>Cancel</Button>
          <Button tone="primary" disabled={!target} onClick={() => setConfirm(true)}>Review</Button>
        </>
      )}>
      {!inv ? <div className="text-sm text-hv-text-3">Load the controllers and doors in Setup › OnCAFE first.</div> : confirm ? (
        <div className="space-y-2 text-sm">
          <div className="flex gap-2 rounded-hv-xs bg-hv-warning-tint text-hv-warning-fg ring-1 ring-inset ring-hv-warning/40 p-3">
            <AlertTriangle size={16} className="shrink-0 mt-0.5" />
            <div>This changes the real {k.target} <b>{tName}</b> in OnCAFE: <b>{k.label.replace(/ \(.*/, '')} {on ? k.on : k.off}</b>
              {kind === 'override' ? ` for ${seconds} s` : canRevert && revert ? `, turned back after ${revert} s` : ' (not turned back automatically)'}.
              {kind === 'lockdown' && on ? ' Every door in the area locks down.' : ''} It is recorded in OnCAFE's audit log under the Pi's OnCAFE account.</div>
          </div>
          {err && <div className="text-xs text-hv-error-fg">{err}</div>}
        </div>
      ) : (
        <div className="space-y-3">
          <Field label="Command">
            <Select value={kind} onChange={e => { setKind(e.target.value as K); setTarget(''); }}>{KINDS.map(x => <option key={x.id} value={x.id}>{x.label}</option>)}</Select>
          </Field>
          <Field label={k.target === 'door' ? 'Door (doors under test only)' : k.target === 'area' ? 'Area (areas with a door under test)' : 'Zone (zones under test only)'}>
            <Select value={target} onChange={e => setTarget(e.target.value)}>
              <option value="">{targets.length ? 'Pick…' : 'none available'}</option>
              {(targets as { id: string; name: string }[]).map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Action"><Select value={on ? '1' : '0'} onChange={e => setOn(e.target.value === '1')}><option value="1">{k.on}</option><option value="0">{k.off}</option></Select></Field>
            {kind === 'override'
              ? <Field label="For (seconds)" hint="OnCAFE ends it by itself"><Input type="number" min={5} max={3600} value={seconds} onChange={e => setSeconds(Math.max(5, Math.min(3600, Number(e.target.value) || 5)))} /></Field>
              : canRevert ? <Field label="Turn it back after (s)" hint="0 = leave it"><Input type="number" min={0} max={3600} value={revert} onChange={e => setRevert(Number(e.target.value))} /></Field> : <div />}
          </div>
          <div className="text-[11px] text-hv-text-3">The trace follows it: OnCAFE's answer → the controller's event → the door state in the cloud → Aether seeing the strike or output (map them in Setup › Wiring).</div>
        </div>
      )}
    </Dialog>
  );
};
