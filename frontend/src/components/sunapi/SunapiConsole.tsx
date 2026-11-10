// AETHER_SUNAPI — SUNAPI Console: drive Hanwha devices (cameras, recorders, access control)
// through the Pi — one at a time or many at once — and find them with a network scan.
// Replaces the Windows "SUNAPI Test Client": the menu tree, parameter types and allowed
// values all come from the device's own attributes.cgi, so every model works unchanged.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Pencil, Plug, RefreshCw, FileUp, ChevronDown, Trash2, Search, History as HistoryIcon, ExternalLink, Loader2, AlertTriangle, Radar, X, Layers } from 'lucide-react';
import { client, defaultBackend, type Device, type DeviceKind, type HistoryEntry } from './api';
import { parseAttributes, type Catalog } from './catalog';
import { Explorer, type Target } from './Explorer';
import { Snapshots } from './Snapshots';
import { ReaderFile } from './ReaderFile';
import { Devices } from './Devices';
import { ResponseView } from './ResponseView';
import { KINDS, KindIcon, kindLabel } from './kinds';
import { Badge, Button, Dialog, Empty, Field, IconButton, Input, Select, Tabs, Toggle, actionTone, cx, fmtBytes, fmtTime, lsGet, lsSet, statusTone } from './ui';

type Page = 'devices' | 'explorer' | 'capabilities' | 'history' | 'snapshots' | 'readerfile';
type Conn = { state: 'idle' | 'connecting' | 'online' | 'error'; message?: string; ms?: number; auth?: string };

const SunapiConsole: React.FC<{ backendUrl?: string }> = ({ backendUrl }) => {
  const api = useMemo(() => client(backendUrl || defaultBackend()), [backendUrl]);
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(() => lsGet('aether.sunapi.device', null));
  const [targets, setTargetsRaw] = useState<string[]>(() => lsGet('aether.sunapi.targets', []));
  const [conn, setConn] = useState<Conn>({ state: 'idle' });
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [fileCatalog, setFileCatalog] = useState<{ name: string; catalog: Catalog } | null>(null);
  const [page, setPage] = useState<Page>(() => lsGet('aether.sunapi.page', 'explorer'));
  const [editing, setEditing] = useState<Device | 'new' | null>(null);
  const [menu, setMenu] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [jump, setJump] = useState<Target | null>(null);
  const [histTick, setHistTick] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  const device = devices?.find(d => d.id === deviceId) || null;
  useEffect(() => lsSet('aether.sunapi.device', deviceId), [deviceId]);
  useEffect(() => lsSet('aether.sunapi.page', page), [page]);
  const setTargets = (ids: string[]) => { setTargetsRaw(ids); lsSet('aether.sunapi.targets', ids); };

  // Everything a request goes to: the primary (menus come from it) plus any ticked devices.
  const fleet = useMemo(() => {
    if (!devices || !device) return [];
    const ids = targets.filter(id => devices.some(d => d.id === id));
    if (ids.length < 1 || (ids.length === 1 && ids[0] === device.id)) return [device];
    return [device, ...ids.filter(id => id !== device.id).map(id => devices.find(d => d.id === id)!)];
  }, [devices, device, targets]);

  const loadDevices = useCallback(() => api.devices().then(d => { setDevices(d); setLoadErr(null); return d; }).catch(e => { setLoadErr(e.message); setDevices([]); return [] as Device[]; }), [api]);
  useEffect(() => {
    loadDevices().then(d => {
      if (d.length && !d.some(x => x.id === deviceId)) setDeviceId(d[0].id);
      if (!d.length) setPage('devices');
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const connect = useCallback(async (d: Device, refresh = false) => {
    setConn({ state: 'connecting' }); setFileCatalog(null);
    try {
      const r = await api.connect(d.id, refresh);
      if (!r.ok) throw new Error(`Device answered HTTP ${r.status}`);
      const xml = await api.attributes(d.id);
      setCatalog(parseAttributes(xml));
      setConn({ state: 'online', ms: r.ms, auth: r.auth, message: [r.switchedToHttps ? 'switched to HTTPS (the device redirects HTTP)' : '', r.attributes.error ? `attributes: ${r.attributes.error}` : ''].filter(Boolean).join(' · ') || undefined });
      loadDevices();
    } catch (e) {
      setConn({ state: 'error', message: (e as Error).message });
      api.attributes(d.id).then(x => setCatalog(parseAttributes(x))).catch(() => setCatalog(null));
    }
  }, [api, loadDevices]);

  const lastAuto = useRef<string | null>(null);
  useEffect(() => {
    if (!device || lastAuto.current === device.id) return;
    lastAuto.current = device.id; setCatalog(null);
    connect(device);
  }, [device, connect]);

  const openFile = (f: File) => {
    f.text().then(t => { try { setFileCatalog({ name: f.name, catalog: parseAttributes(t) }); setPage('explorer'); } catch (e) { alert((e as Error).message); } });
  };

  const shownCatalog = fileCatalog?.catalog || catalog;
  const online = conn.state === 'online' && !fileCatalog;
  const multi = fleet.length > 1 && !fileCatalog;

  if (devices === null) return <div className="h-[calc(100vh-210px)] flex items-center justify-center text-hv-text-3 text-sm gap-2"><Loader2 size={16} className="animate-spin" />Loading…</div>;

  const needsCatalog = page === 'explorer' || page === 'capabilities' || page === 'snapshots';

  return (
    <div className="flex flex-col rounded-hv-sm bg-hv-widget-panel ring-1 ring-hv-line overflow-hidden" style={{ height: 'calc(100vh - 210px)', minHeight: 560 }}>
      {/* device bar */}
      <div className="flex items-center gap-3 px-4 h-14 border-b border-hv-line shrink-0">
        <div className="relative">
          <button onClick={() => setMenu(m => !m)} disabled={!devices.length}
            className="flex items-center gap-2.5 h-10 pl-2.5 pr-2 rounded-hv-xs hover:bg-hv-widget min-w-[260px] max-w-[400px] text-left disabled:opacity-60" title="Primary device — the Explorer's menus come from it">
            <span className={cx('w-2.5 h-2.5 rounded-full shrink-0', fileCatalog ? 'bg-hv-info' : conn.state === 'online' ? 'bg-hv-success' : conn.state === 'error' ? 'bg-hv-error' : conn.state === 'connecting' ? 'bg-hv-warning animate-pulse' : 'bg-hv-line-strong')} />
            {!fileCatalog && device && <KindIcon kind={device.kind} size={16} className="text-hv-text-3 shrink-0" />}
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-hv-text truncate">{fileCatalog ? fileCatalog.name : device ? device.name : 'No device yet'}</span>
              <span className="block text-[11px] text-hv-text-3 truncate font-mono">
                {fileCatalog ? `${fileCatalog.catalog.model || 'attributes file'} · offline` : device ? `${device.host}${device.port !== (device.https ? 443 : 80) ? ':' + device.port : ''}${device.model ? ' · ' + device.model : ''}${device.firmware ? ' · ' + device.firmware : ''}` : 'Scan or add one to start'}
              </span>
            </span>
            {devices.length > 0 && <ChevronDown size={15} className="text-hv-text-3" />}
          </button>
          {menu && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setMenu(false)} />
              <div className="absolute z-50 mt-1 w-[380px] max-h-[60vh] overflow-auto rounded-hv-xs bg-hv-popup-panel shadow-hv-2 ring-1 ring-hv-line-strong py-1">
                {KINDS.map(k => {
                  const list = devices.filter(d => (d.kind || 'other') === k.id);
                  if (!list.length) return null;
                  return (
                    <div key={k.id}>
                      <div className="px-3 pt-2 pb-1 text-[10.5px] font-bold uppercase tracking-wide text-hv-text-3">{k.plural}</div>
                      {list.map(d => (
                        <button key={d.id} onClick={() => { setMenu(false); setFileCatalog(null); if (d.id === deviceId) connect(d); else setDeviceId(d.id); }}
                          className={cx('w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-hv-box', d.id === deviceId && 'bg-hv-brand-tint')}>
                          <KindIcon kind={d.kind} size={15} className="text-hv-text-3 shrink-0" />
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm text-hv-text truncate">{d.name}</span>
                            <span className="block text-[11px] text-hv-text-3 font-mono truncate">{d.host}{d.model ? ` · ${d.model}` : ''}{d.lastSeen ? ` · seen ${fmtTime(d.lastSeen)}` : ''}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  );
                })}
                <div className="border-t border-hv-line mt-1 pt-1">
                  <button onClick={() => { setMenu(false); setPage('devices'); }} className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-hv-text-2 hover:bg-hv-box"><Radar size={15} />Scan the network</button>
                  <button onClick={() => { setMenu(false); setEditing('new'); }} className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-hv-text-2 hover:bg-hv-box"><Plus size={15} />Add device by address</button>
                </div>
              </div>
            </>
          )}
        </div>

        {device && !fileCatalog && (
          <div className="flex items-center gap-1">
            <Button size="sm" tone={conn.state === 'online' ? 'ghost' : 'secondary'} busy={conn.state === 'connecting'} icon={conn.state === 'online' ? <RefreshCw size={13} /> : <Plug size={13} />}
              onClick={() => connect(device, conn.state === 'online')} title={conn.state === 'online' ? 'Reconnect and re-read attributes.cgi' : 'Connect'}>
              {conn.state === 'online' ? 'Refresh' : conn.state === 'connecting' ? 'Connecting' : 'Connect'}
            </Button>
            <IconButton label="Edit device" onClick={() => setEditing(device)}><Pencil size={14} /></IconButton>
          </div>
        )}
        {fileCatalog && <Button size="sm" tone="ghost" onClick={() => setFileCatalog(null)}>Close file</Button>}

        {multi && (
          <span className="inline-flex items-center gap-1 h-7 pl-2 pr-1 rounded-hv-xs bg-hv-brand-tint text-hv-brand-fg ring-1 ring-inset ring-hv-brand/40 text-xs font-semibold">
            <button className="inline-flex items-center gap-1.5" onClick={() => setPage('devices')} title={fleet.map(d => d.name).join(', ')}><Layers size={13} />Sending to {fleet.length} devices</button>
            <button className="p-0.5 rounded hover:bg-hv-brand-tint-strong" title="Back to one device" onClick={() => setTargets([])}><X size={12} /></button>
          </span>
        )}

        <div className="min-w-0 flex-1 text-xs">
          {conn.state === 'error' && !fileCatalog && <span className="inline-flex items-center gap-1.5 text-hv-error-fg"><AlertTriangle size={14} className="shrink-0" /><span className="truncate">{conn.message}</span></span>}
          {conn.state === 'online' && !fileCatalog && !multi && <span className="text-hv-text-3">Connected · {conn.ms} ms{conn.auth && conn.auth !== 'cached' ? ` · ${conn.auth}` : ''}{conn.message ? ` · ${conn.message}` : ''}</span>}
        </div>

        <input ref={fileRef} type="file" accept=".xml,text/xml" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) openFile(f); e.target.value = ''; }} />
        <Button size="sm" tone="ghost" icon={<FileUp size={13} />} onClick={() => fileRef.current?.click()} title="Browse an attributes.xml without a device">Open attributes.xml</Button>
      </div>

      <Tabs className="px-4 shrink-0" value={page} onChange={setPage} items={[
        { id: 'devices', label: 'Devices', count: devices.length },
        { id: 'explorer', label: 'Explorer' },
        { id: 'capabilities', label: 'Capabilities', count: shownCatalog?.capabilities.length, disabled: !shownCatalog },
        { id: 'history', label: 'History', disabled: !device || !!fileCatalog },
        { id: 'snapshots', label: 'Snapshots', disabled: !device || !!fileCatalog },
        { id: 'readerfile', label: 'Reader file', disabled: !device || !!fileCatalog },
      ]} />

      <div className="flex-1 min-h-0">
        {loadErr ? (
          <Empty icon={<AlertTriangle size={28} />} title="Can’t reach the SUNAPI service on the Pi">{loadErr}</Empty>
        ) : page === 'devices' ? (
          <Devices api={api} devices={devices} primaryId={deviceId} targets={targets} setTargets={setTargets}
            onPrimary={id => { setFileCatalog(null); if (id === deviceId && device) connect(device); else setDeviceId(id); setPage('explorer'); }}
            onEdit={setEditing} onAdded={() => loadDevices().then(d => { if (!deviceId && d[0]) setDeviceId(d[0].id); })} />
        ) : page === 'readerfile' && device && !fileCatalog ? (
          <ReaderFile api={api} device={device} onSent={() => setHistTick(t => t + 1)} />
        ) : needsCatalog && !shownCatalog ? (
          !devices.length ? (
            <Empty icon={<Radar size={30} />} title="Find your Hanwha devices"
              action={<div className="flex gap-2 justify-center"><Button tone="primary" icon={<Radar size={14} />} onClick={() => setPage('devices')}>Scan the network</Button><Button icon={<Plus size={14} />} onClick={() => setEditing('new')}>Add by address</Button><Button icon={<FileUp size={14} />} onClick={() => fileRef.current?.click()}>Open attributes.xml</Button></div>}>
              Cameras, recorders and access control all speak SUNAPI. The Pi reads each device’s attributes.cgi and builds every menu, field and allowed value from it — nothing to configure per model.
            </Empty>
          ) : conn.state === 'connecting' ? (
            <div className="h-full flex items-center justify-center gap-2 text-sm text-hv-text-3"><Loader2 size={16} className="animate-spin" />Reading attributes.cgi from {device?.name}…</div>
          ) : (
            <Empty icon={<Plug size={28} />} title={conn.state === 'error' ? 'Not connected' : 'Connect to load the device’s menus'} action={device && <Button tone="primary" onClick={() => connect(device)}>Connect</Button>}>{conn.message}</Empty>
          )
        ) : page === 'explorer' ? (
          <Explorer catalog={shownCatalog} device={fileCatalog ? null : device} fleet={fileCatalog ? [] : fleet} online={online} api={api} jump={jump} onSent={() => setHistTick(t => t + 1)} />
        ) : page === 'capabilities' && shownCatalog ? (
          <Capabilities catalog={shownCatalog} />
        ) : page === 'history' && device ? (
          <History api={api} device={device} tick={histTick} onOpen={t => { setJump({ ...t }); setPage('explorer'); }} />
        ) : page === 'snapshots' && device ? (
          <Snapshots catalog={shownCatalog} device={device} fleet={fleet} devices={devices} online={online} api={api} />
        ) : null}
      </div>

      <DeviceDialog api={api} editing={editing} onClose={() => setEditing(null)}
        onSaved={async (d, isNew) => { setEditing(null); await loadDevices(); lastAuto.current = null; setFileCatalog(null); if (isNew || d.id !== deviceId) setDeviceId(d.id); else connect(d); }}
        onRemoved={async id => { setEditing(null); setTargets(targets.filter(x => x !== id)); const left = await loadDevices(); if (id === deviceId) { setCatalog(null); setConn({ state: 'idle' }); setDeviceId(left[0]?.id || null); lastAuto.current = null; } }} />
    </div>
  );
};

export default SunapiConsole;

// ---------------------------------------------------------------- add / edit device
const DeviceDialog: React.FC<{ api: ReturnType<typeof client>; editing: Device | 'new' | null; onClose: () => void; onSaved: (d: Device, isNew: boolean) => void; onRemoved: (id: string) => void }> =
  ({ api, editing, onClose, onSaved, onRemoved }) => {
    const isNew = editing === 'new';
    const d = editing && editing !== 'new' ? editing : null;
    const blank = { name: '', host: '', https: false, port: '80', user: 'admin', password: '', kind: 'auto' as DeviceKind | 'auto', cgiRoot: 'stw-cgi' };
    const [f, setF] = useState(blank);
    const [adv, setAdv] = useState(false);
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState<string | null>(null);
    useEffect(() => {
      if (!editing) return;
      setErr(null);
      setF(d ? { name: d.name, host: d.host, https: d.https, port: String(d.port), user: d.user, password: '', kind: d.kindManual ? (d.kind || 'other') : 'auto', cgiRoot: d.cgiRoot || 'stw-cgi' } : blank);
      setAdv(!!d && (d.cgiRoot || 'stw-cgi') !== 'stw-cgi');
    }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps
    const set = (k: keyof typeof f, v: string | boolean) => setF(o => ({ ...o, [k]: v }));
    const save = async () => {
      setBusy(true); setErr(null);
      try {
        const body = { name: f.name, host: f.host, https: f.https, port: Number(f.port) || (f.https ? 443 : 80), user: f.user, cgiRoot: f.cgiRoot, ...(f.kind !== 'auto' ? { kind: f.kind } : {}), ...(f.password ? { password: f.password } : {}) };
        const saved = d ? await api.updateDevice(d.id, body) : await api.addDevice(body);
        onSaved(saved, isNew);
      } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
    };
    return (
      <Dialog open={!!editing} onClose={onClose} title={isNew ? 'Add a Hanwha device' : `Edit ${d?.name}`} width={500}
        footer={<>
          {d && <Button tone="danger-soft" className="mr-auto" icon={<Trash2 size={14} />} onClick={() => { if (window.confirm(`Remove ${d.name} and its history from Aether? Snapshots stay.`)) api.removeDevice(d.id).then(() => onRemoved(d.id)); }}>Remove</Button>}
          <Button tone="ghost" onClick={onClose}>Cancel</Button>
          <Button tone="primary" busy={busy} disabled={!f.host.trim() || (isNew && !f.password)} onClick={save}>{isNew ? 'Save and connect' : 'Save'}</Button>
        </>}>
        <form className="space-y-3.5" onSubmit={e => { e.preventDefault(); save(); }}>
          <div className="grid grid-cols-[1fr_96px] gap-3">
            <Field label="IP address or host name"><Input autoFocus value={f.host} onChange={e => set('host', e.target.value)} placeholder="192.168.1.223" mono /></Field>
            <Field label="Port"><Input value={f.port} onChange={e => set('port', e.target.value.replace(/\D/g, ''))} mono /></Field>
          </div>
          <Toggle on={f.https} onChange={v => setF(o => ({ ...o, https: v, port: o.port === (v ? '80' : '443') || !o.port ? (v ? '443' : '80') : o.port }))} label="Use HTTPS (self-signed certificates are accepted)" />
          <div className="grid grid-cols-[1fr_170px] gap-3">
            <Field label="Name" hint="Leave empty to use the address."><Input value={f.name} onChange={e => set('name', e.target.value)} placeholder="Lobby dome / Door 3 controller" /></Field>
            <Field label="Type" hint={f.kind === 'auto' ? 'Detected on connect' : undefined}>
              <Select value={f.kind} onChange={e => set('kind', e.target.value)}>
                <option value="auto">Detect{d && !d.kindManual && d.kind ? ` (${kindLabel(d.kind)})` : ''}</option>
                {KINDS.map(k => <option key={k.id} value={k.id}>{k.label}</option>)}
              </Select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="User"><Input value={f.user} onChange={e => set('user', e.target.value)} autoComplete="off" /></Field>
            <Field label="Password" hint={d ? (d.hasPassword ? 'Leave empty to keep the saved one' : 'No password saved') : undefined}>
              <Input type="password" value={f.password} onChange={e => set('password', e.target.value)} autoComplete="new-password" placeholder={d?.hasPassword ? '••••••••' : ''} />
            </Field>
          </div>
          <button type="button" className="text-xs text-hv-text-3 hover:text-hv-text-2 inline-flex items-center gap-1" onClick={() => setAdv(a => !a)}><ChevronDown size={13} className={cx('transition-transform', !adv && '-rotate-90')} />Advanced</button>
          {adv && (
            <Field label="CGI folder" hint={<>Most Hanwha devices serve SUNAPI under <code>/stw-cgi/</code>. Change only if this device uses another folder.</>}>
              <Input mono value={f.cgiRoot} onChange={e => set('cgiRoot', e.target.value.replace(/[^a-z0-9_-]/gi, ''))} />
            </Field>
          )}
          <p className="text-[11px] text-hv-text-3 leading-relaxed">The password stays on the Pi (backend/data/sunapi, readable only by the Aether service) and is never sent back to the browser. Hanwha devices lock the account for a while after several wrong passwords.</p>
          {err && <div className="text-xs text-hv-error-fg">{err}</div>}
          <button type="submit" className="hidden" />
        </form>
      </Dialog>
    );
  };

// ---------------------------------------------------------------- capabilities
const Capabilities: React.FC<{ catalog: Catalog }> = ({ catalog }) => {
  const [q, setQ] = useState('');
  const [group, setGroup] = useState<string>('All');
  const groups = useMemo(() => ['All', ...Array.from(new Set(catalog.capabilities.map(c => c.group)))], [catalog]);
  const f = q.toLowerCase();
  const rows = catalog.capabilities.filter(c => (group === 'All' || c.group === group) && (!f || c.name.toLowerCase().includes(f) || c.value.toLowerCase().includes(f) || c.category.toLowerCase().includes(f)));
  const byCat = rows.reduce<Record<string, typeof rows>>((m, c) => { (m[`${c.group} › ${c.category}`] ||= []).push(c); return m; }, {});
  return (
    <div className="flex h-full min-h-0">
      <aside className="w-[220px] shrink-0 border-r border-hv-line p-3 overflow-auto">
        <div className="text-[11px] text-hv-text-3 mb-2 px-1">{catalog.model} · SUNAPI {catalog.sunapiVersion} · {catalog.maxChannel} channel{catalog.maxChannel === 1 ? '' : 's'}</div>
        {groups.map(g => (
          <button key={g} onClick={() => setGroup(g)} className={cx('w-full flex items-center px-2 h-8 rounded-hv-xs text-sm text-left', group === g ? 'bg-hv-brand-tint text-hv-text font-semibold' : 'text-hv-text-2 hover:bg-hv-widget')}>
            {g}<span className="ml-auto text-[11px] text-hv-text-3">{g === 'All' ? catalog.capabilities.length : catalog.capabilities.filter(c => c.group === g).length}</span>
          </button>
        ))}
      </aside>
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        <div className="px-5 py-3 border-b border-hv-line flex items-center gap-3">
          <div className="relative w-72"><Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-hv-text-3" /><Input value={q} onChange={e => setQ(e.target.value)} placeholder="Search capabilities (e.g. PTZ, MaxUser)" className="pl-8" /></div>
          <span className="text-xs text-hv-text-3">{rows.length} shown · what this model supports, from attributes.cgi</span>
        </div>
        <div className="flex-1 min-h-0 overflow-auto px-5 py-4 space-y-5">
          {Object.entries(byCat).map(([cat, cs]) => (
            <section key={cat}>
              <h4 className="text-xs font-bold text-hv-text mb-1.5">{cat}</h4>
              <table className="w-full text-[13px]"><tbody>{cs.map(c => (
                <tr key={c.name} className="border-b border-hv-line/60">
                  <td className="py-1.5 pr-4 font-mono text-[12px] text-hv-text-2 w-[45%] break-all">{c.name}</td>
                  <td className="py-1.5 pr-4">{c.type === 'bool' ? (c.value === 'True' ? <Badge tone="success">Yes</Badge> : <Badge>No</Badge>) : <span className="text-hv-text font-mono text-[12.5px] break-all">{c.value}</span>}</td>
                  <td className="py-1.5 text-right text-[11px] text-hv-text-3 whitespace-nowrap">{c.access}</td>
                </tr>
              ))}</tbody></table>
            </section>
          ))}
          {!rows.length && <div className="text-sm text-hv-text-3">Nothing matches.</div>}
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------- history
const History: React.FC<{ api: ReturnType<typeof client>; device: Device; tick: number; onOpen: (t: Target) => void }> = ({ api, device, tick, onOpen }) => {
  const [items, setItems] = useState<HistoryEntry[] | null>(null);
  const [sel, setSel] = useState(0);
  const [q, setQ] = useState('');
  useEffect(() => { api.history(device.id).then(h => { setItems(h); setSel(0); }).catch(() => setItems([])); }, [api, device.id, tick]);
  if (!items) return <div className="p-6 text-sm text-hv-text-3">Loading…</div>;
  if (!items.length) return <Empty icon={<HistoryIcon size={28} />} title={`No requests to ${device.name} yet`}>Everything sent from the Explorer is kept here (last 150 per device, including multi-device sends), on the Pi, so it’s the same on every PC.</Empty>;
  const f = q.toLowerCase();
  const shown = items.map((h, i) => ({ h, i })).filter(({ h }) => !f || `${h.cgi} ${h.submenu} ${h.action} ${h.query}`.toLowerCase().includes(f));
  const cur = items[sel];
  return (
    <div className="flex h-full min-h-0">
      <aside className="w-[380px] shrink-0 border-r border-hv-line flex flex-col min-h-0">
        <div className="p-3 flex items-center gap-2 border-b border-hv-line">
          <Input value={q} onChange={e => setQ(e.target.value)} placeholder={`Filter ${device.name} history`} className="h-7 text-xs" />
          <Button size="sm" tone="ghost" onClick={() => { if (window.confirm(`Clear the request history for ${device.name}?`)) api.clearHistory(device.id).then(() => setItems([])); }}>Clear</Button>
        </div>
        <div className="flex-1 min-h-0 overflow-auto">
          {shown.map(({ h, i }) => (
            <button key={i} onClick={() => setSel(i)} className={cx('w-full text-left px-3 py-2 border-b border-hv-line/60 flex items-center gap-2.5', sel === i ? 'bg-hv-brand-tint' : 'hover:bg-hv-widget')}>
              <Badge tone={actionTone(h.action)} className="w-[62px] justify-center">{h.action || '—'}</Badge>
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-hv-text truncate">{h.cgi}<span className="text-hv-text-3"> › </span>{h.submenu}{h.origin === 'verify' && <span className="text-[11px] text-hv-text-3"> · read-back</span>}{h.origin === 'fleet' && <span className="text-[11px] text-hv-text-3"> · multi-device</span>}</span>
                <span className="block text-[11px] text-hv-text-3">{fmtTime(h.at)}{h.ms !== undefined ? ` · ${h.ms} ms` : ''}{h.bytes !== undefined ? ` · ${fmtBytes(h.bytes)}` : ''}</span>
              </span>
              <Badge tone={statusTone(h.status)}>{h.status || 'ERR'}</Badge>
            </button>
          ))}
        </div>
      </aside>
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        {cur && (
          <>
            <div className="px-4 py-2.5 border-b border-hv-line flex items-center gap-2">
              <code className="flex-1 min-w-0 font-mono text-[12px] text-hv-text-2 break-all">{cur.path}?{cur.query}</code>
              <Button size="sm" icon={<ExternalLink size={13} />} onClick={() => onOpen({ cgi: cur.cgi, sub: cur.submenu, action: cur.action, query: cur.query })}>Open in Explorer</Button>
            </div>
            <div className="flex-1 min-h-0">
              <ResponseView r={{ status: cur.status, body: cur.body || '', error: cur.error, ms: cur.ms, bytes: cur.bytes, contentType: cur.contentType, clipped: cur.clipped }} fileBase={`${device.name}-${cur.cgi}-${cur.submenu}`.replace(/[^\w.-]+/g, '_')} />
            </div>
          </>
        )}
      </div>
    </div>
  );
};
