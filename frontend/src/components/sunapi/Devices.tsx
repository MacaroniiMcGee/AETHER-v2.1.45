// AETHER_SUNAPI — Devices: saved devices, target selection for multi-device sends, network scan.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Radar, Pencil, Plus, Square, Loader2, Search, ArrowRight, CheckSquare, AlertTriangle } from 'lucide-react';
import type { Client, Device, ScanJob, ScanHost } from './api';
import { KINDS, KindIcon, kindLabel } from './kinds';
import { Badge, Button, Empty, Field, Input, Toggle, cx, fmtTime, lsGet, lsSet } from './ui';

interface Props {
  api: Client;
  devices: Device[];
  primaryId: string | null;
  targets: string[];
  setTargets: (ids: string[]) => void;
  onPrimary: (id: string) => void;          // open in Explorer
  onEdit: (d: Device | 'new') => void;
  onAdded: () => void;
}

export const Devices: React.FC<Props> = ({ api, devices, primaryId, targets, setTargets, onPrimary, onEdit, onAdded }) => {
  const [q, setQ] = useState('');
  const f = q.toLowerCase();
  const shown = devices.filter(d => !f || `${d.name} ${d.host} ${d.model || ''} ${d.firmware || ''} ${d.mac || ''}`.toLowerCase().includes(f));
  const groups = KINDS.map(k => ({ ...k, list: shown.filter(d => (d.kind || 'other') === k.id) })).filter(g => g.list.length);
  const sel = new Set(targets);
  const toggle = (id: string) => setTargets(sel.has(id) ? targets.filter(x => x !== id) : [...targets, id]);
  const setMany = (ids: string[], on: boolean) => setTargets(on ? [...new Set([...targets, ...ids])] : targets.filter(x => !ids.includes(x)));

  return (
    <div className="flex h-full min-h-0">
      {/* saved */}
      <section className="flex-1 min-w-0 flex flex-col min-h-0">
        <div className="px-5 py-3 border-b border-hv-line flex items-center gap-3 flex-wrap">
          <div className="relative w-64"><Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-hv-text-3" /><Input value={q} onChange={e => setQ(e.target.value)} placeholder="Search devices" className="pl-8" /></div>
          <div className="text-xs text-hv-text-3">
            {targets.length > 1 ? <><b className="text-hv-text">{targets.length}</b> selected — requests from the Explorer go to all of them at once.</> : 'Tick two or more devices to send the same request to all of them.'}
          </div>
          <div className="ml-auto flex items-center gap-1">
            {targets.length > 0 && <Button size="sm" tone="ghost" onClick={() => setTargets([])}>Clear selection</Button>}
            <Button size="sm" icon={<Plus size={13} />} onClick={() => onEdit('new')}>Add device</Button>
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-auto px-5 py-4 space-y-5">
          {!devices.length && <Empty icon={<Radar size={28} />} title="No devices yet">Scan the network on the right, or add one by address.</Empty>}
          {groups.map(g => {
            const ids = g.list.map(d => d.id);
            const all = ids.every(id => sel.has(id));
            return (
              <div key={g.id}>
                <div className="flex items-center gap-2 mb-1.5">
                  <KindIcon kind={g.id} size={14} className="text-hv-text-3" />
                  <h4 className="text-xs font-bold text-hv-text">{g.plural}</h4>
                  <span className="text-[11px] text-hv-text-3">{g.list.length}</span>
                  <button className="ml-2 text-[11px] text-hv-text-3 hover:text-hv-text-2 inline-flex items-center gap-1" onClick={() => setMany(ids, !all)}><CheckSquare size={12} />{all ? 'Unselect' : 'Select'} all {g.plural.toLowerCase()}</button>
                </div>
                <div className="rounded-hv-xs ring-1 ring-inset ring-hv-line overflow-hidden">
                  <table className="w-full text-[13px]">
                    <tbody>{g.list.map(d => {
                      const on = sel.has(d.id);
                      return (
                        <tr key={d.id} className={cx('border-b border-hv-line/60 last:border-0', on ? 'bg-hv-brand-tint/60' : 'hover:bg-hv-widget/60')}>
                          <td className="w-9 pl-3"><input type="checkbox" checked={on} onChange={() => toggle(d.id)} className="accent-[rgb(var(--hv-brand))]" aria-label={`Target ${d.name}`} /></td>
                          <td className="py-2 pr-3 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-hv-text font-semibold truncate">{d.name}</span>
                              {d.id === primaryId && <Badge tone="brand" title="Menus in the Explorer come from this device">Primary</Badge>}
                              {!d.hasPassword && <Badge tone="warning">No password</Badge>}
                            </div>
                            <div className="text-[11px] text-hv-text-3 font-mono">{d.https ? 'https://' : ''}{d.host}{d.port !== (d.https ? 443 : 80) ? `:${d.port}` : ''}{d.mac ? ` · ${d.mac}` : ''}</div>
                          </td>
                          <td className="py-2 pr-3 text-hv-text-2 whitespace-nowrap">{d.model || <span className="text-hv-text-3">—</span>}</td>
                          <td className="py-2 pr-3 font-mono text-[12px] text-hv-text-3 whitespace-nowrap">{d.firmware || ''}</td>
                          <td className="py-2 pr-3 text-[11px] text-hv-text-3 whitespace-nowrap">{d.lastSeen ? `seen ${fmtTime(d.lastSeen)}` : 'never connected'}</td>
                          <td className="py-2 pr-2 whitespace-nowrap text-right">
                            <Button size="sm" tone="ghost" icon={<Pencil size={13} />} onClick={() => onEdit(d)}>Edit</Button>
                            <Button size="sm" tone="ghost" icon={<ArrowRight size={13} />} onClick={() => onPrimary(d.id)}>Open</Button>
                          </td>
                        </tr>
                      );
                    })}</tbody>
                  </table>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <Scanner api={api} devices={devices} onAdded={onAdded} />
    </div>
  );
};

// ---------------------------------------------------------------- scanner
const Scanner: React.FC<{ api: Client; devices: Device[]; onAdded: () => void }> = ({ api, devices, onAdded }) => {
  const saved = lsGet<{ ranges: string; ports: string; onvif: boolean; sweep: boolean; identify: boolean; user: string }>('aether.sunapi.scan', { ranges: '', ports: '80, 443', onvif: true, sweep: true, identify: false, user: 'admin' });
  // first version defaulted to port 80 only, which misses HTTPS-only devices (access control)
  if (!saved.ports || saved.ports.trim() === '80') saved.ports = '80, 443';
  const [o, setO] = useState(saved);
  const [password, setPassword] = useState('');
  const [nets, setNets] = useState<{ cidr: string; iface: string; address: string }[]>([]);
  const [job, setJob] = useState<ScanJob | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [onlySunapi, setOnlySunapi] = useState(true);
  const [adding, setAdding] = useState(false);
  const [showOpts, setShowOpts] = useState(true);
  const [addMsg, setAddMsg] = useState<string | null>(null);
  const poll = useRef<number | null>(null);

  useEffect(() => { lsSet('aether.sunapi.scan', o); }, [o]);
  useEffect(() => { api.networks().then(setNets).catch(() => {}); return () => { if (poll.current) window.clearTimeout(poll.current); }; }, [api]);

  const follow = (id: string) => {
    api.scan(id).then(j => {
      setJob(j);
      if (j.state === 'running') poll.current = window.setTimeout(() => follow(id), 600);
      else { setPicked(new Set(j.results.filter(h => h.sunapi === 'yes' && !h.existingId).map(h => h.ip))); if (j.results.length) setShowOpts(false); }
    }).catch(e => setErr(e.message));
  };
  const start = async () => {
    setErr(null); setAddMsg(null); setPicked(new Set());
    try {
      const j = await api.startScan({ ranges: o.ranges, ports: o.ports, onvif: o.onvif, sweep: o.sweep, identify: o.identify && password ? { user: o.user, password } : null });
      setJob(j); follow(j.id);
    } catch (e) { setErr((e as Error).message); }
  };
  const running = job?.state === 'running';
  const rows = useMemo(() => (job?.results || []).filter(h => !onlySunapi || h.sunapi === 'yes' || h.sunapi === 'maybe' || h.vendor === 'Hanwha' || h.kind === 'access'), [job, onlySunapi]);
  const addable = rows.filter(h => picked.has(h.ip) && !h.existingId);

  const add = async () => {
    setAdding(true); setAddMsg(null);
    try {
      const r = await api.bulkAdd({ user: o.user, password, devices: addable.map(h => ({ host: h.ip, port: h.port || 80, https: !!h.https, model: h.model, mac: h.mac, kind: h.kind, name: h.deviceName && h.deviceName !== h.model ? h.deviceName : (h.name && h.name !== h.model ? h.name : '') })) });
      setAddMsg(`Added ${r.added.length} device${r.added.length === 1 ? '' : 's'}.`);
      onAdded();
      if (job) follow(job.id);
    } catch (e) { setAddMsg((e as Error).message); } finally { setAdding(false); }
  };

  return (
    <aside className="w-[460px] shrink-0 border-l border-hv-line flex flex-col min-h-0 bg-hv-widget-panel">
      <div className="p-4 border-b border-hv-line space-y-3">
        <div className="flex items-center gap-2"><Radar size={16} className="text-hv-text-2" /><h3 className="text-sm font-bold text-hv-text">Scan the network</h3>
          {!showOpts && <button className="ml-auto text-xs text-hv-text-3 hover:text-hv-text-2 underline" onClick={() => setShowOpts(true)}>Change options</button>}
        </div>
        {!showOpts && <div className="text-[11px] text-hv-text-3 font-mono truncate" title={job?.ranges}>{job?.ranges || o.ranges} · ports {o.ports}{o.onvif ? ' · ONVIF' : ''}{o.identify ? ' · identify' : ''}</div>}
        {showOpts && <>
        <Field label="Addresses" hint={nets.length ? <>Empty = the Pi’s own network{nets.length > 1 ? 's' : ''}: {nets.map(n => `${n.cidr} (${n.iface})`).join(', ')}</> : 'CIDR, range or single IPs — e.g. 192.168.1.0/24, 10.0.5.20-80'}>
          <Input mono value={o.ranges} onChange={e => setO({ ...o, ranges: e.target.value })} placeholder={nets.map(n => n.cidr).join(', ') || '192.168.1.0/24'} disabled={running} />
        </Field>
        <div className="grid grid-cols-[100px_1fr] gap-3 items-end">
          <Field label="Ports" hint="443 = HTTPS"><Input mono value={o.ports} onChange={e => setO({ ...o, ports: e.target.value })} disabled={running} /></Field>
          <div className="flex flex-col gap-1.5 pb-1">
            <Toggle on={o.onvif} onChange={v => setO({ ...o, onvif: v })} label="ONVIF discovery" disabled={running} />
            <Toggle on={o.sweep} onChange={v => setO({ ...o, sweep: v })} label="Probe every address for SUNAPI" disabled={running} />
          </div>
        </div>
        <Toggle on={o.identify} onChange={v => setO({ ...o, identify: v })} label="Identify with a login (model, firmware, type)" disabled={running} />
        {o.identify && (
          <div className="space-y-1.5">
            <div className="grid grid-cols-2 gap-2">
              <Input value={o.user} onChange={e => setO({ ...o, user: e.target.value })} placeholder="User" disabled={running} />
              <Input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Password" autoComplete="new-password" disabled={running} />
            </div>
            <p className="text-[11px] text-hv-text-3">One login attempt per device found — not enough to lock anything out. The same login is used when you add them.</p>
          </div>
        )}
        </>}
        <div className="flex items-center gap-2">
          {running ? (
            <Button icon={<Square size={13} />} onClick={() => job && api.cancelScan(job.id)}>Stop</Button>
          ) : (
            <Button tone="primary" icon={<Radar size={15} />} onClick={start} disabled={o.identify && !password}>Scan</Button>
          )}
          {running && job && (
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 text-[11px] text-hv-text-3"><Loader2 size={12} className="animate-spin" />{job.phase}{job.total ? ` · ${job.done}/${job.total}` : ''}<span className="ml-auto">{job.results.length} found</span></div>
              <div className="h-1 mt-1 rounded-full bg-hv-box overflow-hidden"><div className="h-full bg-hv-brand transition-all" style={{ width: `${job.total ? (job.done / job.total) * 100 : 8}%` }} /></div>
            </div>
          )}
          {!running && job && <span className="text-[11px] text-hv-text-3">{job.state === 'cancelled' ? 'Stopped' : 'Done'} in {(job.ms / 1000).toFixed(1)} s · {job.results.length} found</span>}
        </div>
        {err && <div className="text-xs text-hv-error-fg flex items-start gap-1.5"><AlertTriangle size={13} className="mt-0.5 shrink-0" />{err}</div>}
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {!job ? (
          <Empty title="Find Hanwha devices">Discovery asks ONVIF devices to announce themselves, then checks each address for SUNAPI without logging in — cameras, recorders and access control all answer the same way.</Empty>
        ) : (
          <>
            {addMsg && <div className="px-4 py-2 text-xs text-hv-success-fg bg-hv-success-tint border-b border-hv-line/60">{addMsg} Tick them on the left to send to several at once.</div>}
            <div className="px-4 py-2 flex items-center gap-2 text-[11px] text-hv-text-3 border-b border-hv-line/60">
              <Toggle on={onlySunapi} onChange={setOnlySunapi} label="Only SUNAPI / Hanwha" />
              {onlySunapi && (job.results.length - rows.length) > 0 && <button className="underline hover:text-hv-text-2" onClick={() => setOnlySunapi(false)}>{job.results.length - rows.length} other responder{job.results.length - rows.length === 1 ? '' : 's'} hidden</button>}
              <span className="ml-auto">{KINDS.map(k => ({ k, n: rows.filter(h => (h.kind || 'other') === k.id).length })).filter(x => x.n).map(x => `${x.n} ${x.n === 1 ? x.k.label : x.k.plural}`).join(' · ') || `${rows.length} shown`}</span>
            </div>
            {rows.map(h => <ScanRow key={h.ip} h={h} on={picked.has(h.ip)} onToggle={() => setPicked(p => { const n = new Set(p); n.has(h.ip) ? n.delete(h.ip) : n.add(h.ip); return n; })} />)}
            {!rows.length && !running && <div className="px-4 py-6 text-xs text-hv-text-3">Nothing found. Check the address range, or that the Pi is on the same network (VLAN) as the devices.</div>}
          </>
        )}
      </div>

      {job && !running && rows.some(h => !h.existingId) && (
        <div className="border-t border-hv-line p-4 space-y-2">
          {!o.identify && (
            <div className="grid grid-cols-2 gap-2">
              <Input value={o.user} onChange={e => setO({ ...o, user: e.target.value })} placeholder="User for these devices" />
              <Input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Password" autoComplete="new-password" />
            </div>
          )}
          <div className="flex items-center gap-2">
            <Button tone="primary" busy={adding} disabled={!addable.length || !password} onClick={add}>Add {addable.length || ''} selected</Button>
            {!password && addable.length > 0 && <span className="text-[11px] text-hv-text-3">Enter the login to add</span>}
          </div>
        </div>
      )}
    </aside>
  );
};

const ScanRow: React.FC<{ h: ScanHost; on: boolean; onToggle: () => void }> = ({ h, on, onToggle }) => (
  <label className={cx('flex items-start gap-3 px-4 py-2.5 border-b border-hv-line/60 cursor-pointer', h.existingId ? 'opacity-70' : on ? 'bg-hv-brand-tint/60' : 'hover:bg-hv-widget')}>
    <input type="checkbox" disabled={!!h.existingId} checked={on && !h.existingId} onChange={onToggle} className="mt-1 accent-[rgb(var(--hv-brand))]" />
    <KindIcon kind={h.kind} size={16} className="mt-0.5 text-hv-text-3 shrink-0" />
    <span className="min-w-0 flex-1">
      <span className="flex items-center gap-2">
        <span className="font-mono text-[13px] text-hv-text">{h.ip}{h.port && h.port !== 80 ? `:${h.port}` : ''}</span>
        <span className="text-sm text-hv-text-2 truncate">{h.model || h.name || ''}</span>
      </span>
      <span className="block text-[11px] text-hv-text-3 font-mono truncate">{[h.mac, h.firmware, kindLabel(h.kind)].filter(Boolean).join(' · ')}</span>
      {h.answer && h.sunapi !== 'yes' && <span className="block text-[11px] text-hv-text-3 truncate" title={h.answer}>Answered: {h.answer}</span>}
      <span className="flex flex-wrap gap-1 mt-1">
        {h.sunapi === 'yes' && <Badge tone="success">SUNAPI</Badge>}
        {h.sunapi === 'maybe' && <Badge tone="warning" title="Asks for a login on the SUNAPI path but did not say who it is">SUNAPI?</Badge>}
        {h.onvif && <Badge tone="info">ONVIF</Badge>}
        {h.https && <Badge>HTTPS</Badge>}
        {h.identify === 'wrong-login' && <Badge tone="error">Login refused</Badge>}
        {h.sunapi === 'no' && <Badge title={h.answer}>Not SUNAPI</Badge>}
        {h.onvif && !h.sunapi && <Badge tone="warning" title="Announced itself over ONVIF but did not answer SUNAPI on the ports scanned — try adding its port (e.g. 443)">No SUNAPI answer</Badge>}
        {h.identify === 'no-digest' && <Badge tone="warning" title="Only Basic auth offered — the password was not sent in clear text">Basic auth only</Badge>}
        {h.identify === 'error' && <Badge tone="error" title={h.identifyError}>No answer</Badge>}
        {h.existingId && <Badge tone="brand">Added as {h.existingName}</Badge>}
      </span>
    </span>
  </label>
);
