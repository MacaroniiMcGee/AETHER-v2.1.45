// AETHER_CLUSTER / AETHER_CAMERAS: Enroll node and Add stream dialogs.
import React, { useEffect, useRef, useState } from 'react';
import { X, Loader2, Search, CheckCircle2, AlertCircle } from 'lucide-react';
import { ApiError, addCamera, claimNode, setPrimary, NodeKey, PrimaryTile, startScan, getScan, cancelScan, addHanwha, ScanHost, HanwhaResult } from './clusterApi';

const inputCls = 'w-full h-9 px-3 rounded-hv-xs text-sm text-hv-text border outline-none focus:border-hv-brand';
const inputStyle: React.CSSProperties = { background: 'rgb(var(--hv-widget))', borderColor: 'rgb(var(--hv-line-strong))' };

const Field: React.FC<{ label: string; hint?: string; error?: boolean; children: React.ReactNode }> = ({ label, hint, children }) => (
  <label className="block mb-3">
    <span className="block text-xs font-semibold text-hv-text-2 mb-1">{label}</span>
    {children}
    {hint && <span className="block text-[11px] text-hv-text-3 mt-1">{hint}</span>}
  </label>
);

const Modal: React.FC<{ title: string; subtitle?: string; onClose: () => void; children: React.ReactNode }> = ({ title, subtitle, onClose, children }) => {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center p-4 bg-black/60" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title}
        className="w-full max-w-md rounded-xl border p-5 shadow-2xl"
        style={{ background: 'rgb(var(--hv-popup-panel, var(--hv-widget)))', borderColor: 'rgb(var(--hv-line-strong))' }}
        onMouseDown={e => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-lg font-bold text-hv-text">{title}</h2>
            {subtitle && <p className="text-xs text-hv-text-3 mt-0.5">{subtitle}</p>}
          </div>
          <button type="button" onClick={onClose} className="p-1 rounded text-hv-text-3 hover:text-hv-text" aria-label="Close"><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
};

const Footer: React.FC<{ busy: boolean; label: string; onCancel: () => void; error: string }> = ({ busy, label, onCancel, error }) => (
  <>
    {error && <div role="alert" className="mb-3 px-3 py-2 rounded-md text-xs bg-hv-danger-tint text-hv-danger-fg" style={{ background: 'rgb(var(--hv-danger-tint, 49 24 24))', color: 'rgb(var(--hv-danger-fg, 255 122 122))' }}>{error}</div>}
    <div className="flex justify-end gap-2 mt-2">
      <button type="button" onClick={onCancel} className="h-9 px-4 rounded-hv-xs text-sm font-semibold text-hv-text-2 hover:text-hv-text">Cancel</button>
      <button type="submit" disabled={busy} className="h-9 min-w-[110px] px-4 rounded-hv-xs text-sm font-semibold bg-hv-brand hover:bg-hv-brand-hover text-white disabled:opacity-60 inline-flex items-center justify-center gap-2">
        {busy && <Loader2 size={14} className="animate-spin" />}{label}
      </button>
    </div>
  </>
);

export const EnrollDialog: React.FC<{ initial?: { name?: string; host?: string }; onClose: () => void; onDone: () => void }> = ({ initial, onClose, onDone }) => {
  const [name, setName] = useState(initial?.name || '');
  const [host, setHost] = useState(initial?.host && initial.host !== '192.168.1.' ? initial.host : '');
  const [user, setUser] = useState('admin');
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const hostRef = useRef<HTMLInputElement>(null), passRef = useRef<HTMLInputElement>(null);
  useEffect(() => { (host ? passRef : hostRef).current?.focus(); }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    const raw = host.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const m = /^(.*?)(?::(\d+))?$/.exec(raw) || [];
    if (!m[1]) { setErr('Enter the node\'s IP address.'); hostRef.current?.focus(); return; }
    if (!pass) { setErr('Enter that node\'s admin password.'); passRef.current?.focus(); return; }
    setBusy(true);
    try {
      await claimNode({ host: m[1], port: Number(m[2]) || 3001, username: user.trim() || 'admin', password: pass, name: name.trim() });
      onDone();
    } catch (x: any) {
      setBusy(false); setErr(x?.message || 'Enroll failed');
      if (x instanceof ApiError && x.field === 'password') { setPass(''); passRef.current?.focus(); } else if (x instanceof ApiError && x.field === 'host') hostRef.current?.focus();
    }
  };

  return (
    <Modal title="Enroll a node" subtitle="Adds another Aether Pi to this cluster for everyone who signs in here." onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <Field label="Name"><input className={inputCls} style={inputStyle} value={name} onChange={e => setName(e.target.value)} placeholder="Pi Unit 2" maxLength={40} /></Field>
        <Field label="IP address" hint="The node's address on this network. Add :port only if it isn't 3001.">
          <input ref={hostRef} className={`${inputCls} font-mono`} style={inputStyle} value={host} onChange={e => setHost(e.target.value)} placeholder="192.168.1.33" autoCapitalize="none" spellCheck={false} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Node's user name"><input className={inputCls} style={inputStyle} value={user} onChange={e => setUser(e.target.value)} autoCapitalize="none" spellCheck={false} autoComplete="off" /></Field>
          <Field label="Node's password"><input ref={passRef} type="password" className={inputCls} style={inputStyle} value={pass} onChange={e => setPass(e.target.value)} autoComplete="new-password" /></Field>
        </div>
        <p className="text-[11px] text-hv-text-3 mb-3">Used once to prove you may manage that Pi. It isn't stored; the two Pis exchange their own key.</p>
        <Footer busy={busy} label="Enroll" onCancel={onClose} error={err} />
      </form>
    </Modal>
  );
};

export interface StreamTarget { key: NodeKey; name: string; online: boolean; cameraHosts?: string[] }

const isHanwhaCamera = (h: ScanHost) => h.vendor === 'Hanwha' && h.kind !== 'access' && h.kind !== 'recorder';

/** Find Hanwha cameras on the chosen Pi's network and add them with one login. */
const HanwhaFinder: React.FC<{ target: StreamTarget; onDone: () => void; onCancel: () => void }> = ({ target, onDone, onCancel }) => {
  const [job, setJob] = useState<{ id: string; phase: string; done: number; total: number; running: boolean; ranges: string } | null>(null);
  const [found, setFound] = useState<ScanHost[] | null>(null);
  const [others, setOthers] = useState(0);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [ranges, setRanges] = useState('');
  const [showRanges, setShowRanges] = useState(false);
  const [user, setUser] = useState('admin');
  const [pass, setPass] = useState('');
  const [quality, setQuality] = useState<'sub' | 'main'>('sub');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [results, setResults] = useState<HanwhaResult[] | null>(null);
  const passRef = useRef<HTMLInputElement>(null);
  const live = useRef<{ key: NodeKey; id: string } | null>(null);
  const already = new Set((target.cameraHosts || []).map(h => h.toLowerCase()));

  useEffect(() => () => { if (live.current) cancelScan(live.current.key, live.current.id); }, []);
  // A different Pi: start over.
  useEffect(() => { setFound(null); setJob(null); setResults(null); setPicked({}); setErr(''); }, [target.key]);

  const scan = async () => {
    setErr(''); setResults(null); setFound(null); setPicked({});
    try {
      let j = await startScan(target.key, ranges.trim());
      live.current = { key: target.key, id: j.id };
      while (j.state === 'running') {
        setJob({ id: j.id, phase: j.phase, done: j.done, total: j.total, running: true, ranges: j.ranges });
        await new Promise(r => setTimeout(r, 900));
        if (!live.current || live.current.id !== j.id) return;
        j = await getScan(target.key, j.id);
      }
      live.current = null;
      setJob({ id: j.id, phase: '', done: j.done, total: j.total, running: false, ranges: j.ranges });
      if (j.state === 'error') { setErr(j.error || 'The search failed'); return; }
      const cams = j.results.filter(isHanwhaCamera);
      setFound(cams); setOthers(j.results.length - cams.length);
      const pre: Record<string, boolean> = {};
      for (const h of cams) if (!already.has(h.ip.toLowerCase())) pre[h.ip] = true;
      setPicked(pre);
      if (cams.some(h => !already.has(h.ip.toLowerCase()))) setTimeout(() => passRef.current?.focus(), 50);
    } catch (e: any) { live.current = null; setJob(null); setErr(e?.message || 'The search failed'); }
  };

  const chosen = (found || []).filter(h => picked[h.ip]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    if (!chosen.length) { setErr('Tick at least one camera.'); return; }
    if (!pass) { setErr('Enter the cameras\' password.'); passRef.current?.focus(); return; }
    setBusy(true);
    try {
      const r = await addHanwha(target.key, { devices: chosen.map(h => ({ ip: h.ip, port: h.port, https: h.https, name: h.deviceName || h.name })), user: user.trim() || 'admin', password: pass, quality });
      setBusy(false);
      const failed = r.results.filter(x => !x.ok);
      if (!r.streaming && r.error && r.results.some(x => x.ok)) {
        setResults(r.results);
        setErr(`Saved, but ${target.name} can't play them yet: ${r.error} Install it on that Pi (cd streaming && sudo ./install.sh).`);
        return;
      }
      if (!failed.length) { onDone(); return; }
      setResults(r.results);
      const keep: Record<string, boolean> = {};
      for (const f of failed) keep[f.ip] = true;
      setPicked(keep);
      if (r.results.some(x => x.ok)) setErr(`${r.results.filter(x => x.ok).length} added. The ones below need another look.`);
    } catch (x: any) { setBusy(false); setErr(x?.message || 'Could not add the cameras'); }
  };

  const resultFor = (ip: string) => results?.find(r => r.ip === ip);
  return (
    <form onSubmit={submit} noValidate>
      {!found && (
        <div className="mb-3 rounded-lg border p-3 text-xs text-hv-text-2" style={{ borderColor: 'rgb(var(--hv-line-strong))' }}>
          {job?.running ? (
            <div className="flex items-center gap-2">
              <Loader2 size={14} className="animate-spin" />
              <span>{job.phase || 'Searching'}{job.total ? ` · ${job.done} of ${job.total}` : ''}...</span>
              <button type="button" className="ml-auto text-hv-text-3 hover:text-hv-text" onClick={() => { if (live.current) cancelScan(live.current.key, live.current.id); live.current = null; setJob(null); }}>Stop</button>
            </div>
          ) : (
            <>
              <p className="mb-2"><b className="text-hv-text">{target.name}</b> searches its own network for Wisenet cameras. This takes about 10 to 20 seconds.</p>
              {showRanges ? (
                <Field label="Addresses to check (optional)" hint="Leave empty for this Pi's own network. Use a range for another subnet: 192.168.5.0/24 or 192.168.5.10-60.">
                  <input className={`${inputCls} font-mono text-xs`} style={inputStyle} value={ranges} onChange={e => setRanges(e.target.value)} placeholder="192.168.5.0/24" spellCheck={false} />
                </Field>
              ) : (
                <button type="button" className="text-hv-brand text-xs font-semibold mb-2" onClick={() => setShowRanges(true)}>Cameras on another subnet?</button>
              )}
              <button type="button" onClick={scan} className="h-9 w-full rounded-hv-xs text-sm font-semibold bg-hv-brand hover:bg-hv-brand-hover text-white inline-flex items-center justify-center gap-2">
                <Search size={15} /> Search for cameras
              </button>
            </>
          )}
        </div>
      )}

      {found && (
        <>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-semibold text-hv-text-2">{found.length ? `Found ${found.length} Hanwha camera${found.length === 1 ? '' : 's'}` : 'No Hanwha cameras found'}</span>
            <button type="button" className="text-xs font-semibold text-hv-brand" onClick={() => { setFound(null); setJob(null); }}>Search again</button>
          </div>
          {!found.length && (
            <p className="text-xs text-hv-text-3 mb-3">
              {others ? `${others} other device${others === 1 ? '' : 's'} answered, but none were Hanwha cameras. ` : ''}
              Cameras on another subnet or VLAN aren't found automatically: search again with their address range, or type an RTSP address.
            </p>
          )}
          {found.length > 0 && (
            <div className="mb-3 max-h-56 overflow-auto rounded-lg border divide-y" style={{ borderColor: 'rgb(var(--hv-line-strong))' }}>
              {found.map(h => {
                const done = already.has(h.ip.toLowerCase());
                const r = resultFor(h.ip);
                return (
                  <label key={h.ip} className={`flex items-start gap-2.5 px-3 py-2 text-xs ${done ? 'opacity-55' : 'cursor-pointer'}`} style={{ borderColor: 'rgb(var(--hv-line))' }}>
                    <input type="checkbox" className="mt-0.5 accent-[rgb(var(--hv-brand))]" disabled={done} checked={!!picked[h.ip]} onChange={e => setPicked(p => ({ ...p, [h.ip]: e.target.checked }))} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-hv-text truncate">{h.deviceName || h.name || h.model || 'Hanwha camera'}</span>
                      <span className="block text-hv-text-3 font-mono">{h.ip}{h.model ? ` · ${h.model}` : ''}{h.mac ? ` · ${h.mac}` : ''}</span>
                      {done && <span className="block text-hv-text-3">Already has a tile</span>}
                      {r && (r.ok
                        ? <span className="flex items-center gap-1 text-emerald-400"><CheckCircle2 size={12} /> Added {r.added?.length || 0} stream{r.added?.length === 1 ? '' : 's'}</span>
                        : <span className="flex items-center gap-1" style={{ color: 'rgb(var(--hv-danger-fg, 255 122 122))' }}><AlertCircle size={12} /> {r.error}</span>)}
                    </span>
                  </label>
                );
              })}
            </div>
          )}
          {found.some(h => !already.has(h.ip.toLowerCase())) && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Cameras' user name"><input className={inputCls} style={inputStyle} value={user} onChange={e => setUser(e.target.value)} autoCapitalize="none" spellCheck={false} autoComplete="off" /></Field>
                <Field label="Cameras' password"><input ref={passRef} type="password" className={inputCls} style={inputStyle} value={pass} onChange={e => setPass(e.target.value)} autoComplete="new-password" /></Field>
              </div>
              <Field label="Video" hint="Tiles look the same either way; the sub stream uses far less network and Pi CPU.">
                <select className={inputCls} style={inputStyle} value={quality} onChange={e => setQuality(e.target.value as 'sub' | 'main')}>
                  <option value="sub">Sub stream (recommended)</option>
                  <option value="main">Main stream (full resolution)</option>
                </select>
              </Field>
              <p className="text-[11px] text-hv-text-3 mb-3">One login for every ticked camera. It is kept on {target.name}, and the cameras are also saved in Tools › SUNAPI Console.</p>
            </>
          )}
        </>
      )}

      <Footer busy={busy} label={found && found.length ? `Add ${chosen.length || ''} camera${chosen.length === 1 ? '' : 's'}`.replace('  ', ' ') : 'Add'} onCancel={onCancel} error={err} />
    </form>
  );
};

export const AddStreamDialog: React.FC<{ targets: StreamTarget[]; initialKey?: NodeKey; onClose: () => void; onDone: (key: NodeKey) => void }> = ({ targets, initialKey, onClose, onDone }) => {
  const [key, setKey] = useState<NodeKey>(initialKey || targets[0]?.key || 'self');
  const [tab, setTab] = useState<'hanwha' | 'rtsp'>('hanwha');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('rtsp://');
  const [transport, setTransport] = useState<'tcp' | 'udp'>('tcp');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const urlRef = useRef<HTMLInputElement>(null);
  const target = targets.find(t => t.key === key) || { key, name: 'This Pi', online: true };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    if (!/^rtsps?:\/\/[^/\s]+/i.test(url.trim())) { setErr('Enter the camera\'s RTSP address, for example rtsp://user:pass@192.168.1.50:554/stream1'); urlRef.current?.focus(); return; }
    setBusy(true);
    try {
      const r = await addCamera(key, { name: name.trim() || 'Camera', url: url.trim(), transport });
      if (!r.streaming && r.error) { setBusy(false); setErr(`Saved, but it can't play yet: ${r.error}`); return; }
      onDone(key);
    } catch (x: any) { setBusy(false); setErr(x?.message || 'Could not add the stream'); }
  };

  const tabBtn = (v: 'hanwha' | 'rtsp', label: string) => (
    <button type="button" onClick={() => { setTab(v); setErr(''); }}
      className={`flex-1 h-8 rounded-md text-xs font-semibold ${tab === v ? 'bg-hv-brand text-white' : 'text-hv-text-2 hover:text-hv-text'}`}>{label}</button>
  );

  return (
    <Modal title="Add a stream" subtitle="A camera shown live on the cluster overview." onClose={onClose}>
      <Field label="Pulled by" hint="The Pi that connects to the camera. Pick one on the camera's network.">
        <select className={inputCls} style={inputStyle} value={key} onChange={e => setKey(e.target.value)}>
          {targets.map(t => <option key={t.key} value={t.key}>{t.name}{t.online ? '' : ' (offline)'}</option>)}
        </select>
      </Field>
      <div className="flex gap-1 p-1 mb-3 rounded-lg" style={{ background: 'rgb(var(--hv-widget))' }}>
        {tabBtn('hanwha', 'Find Hanwha cameras')}
        {tabBtn('rtsp', 'RTSP address')}
      </div>
      {tab === 'hanwha' ? (
        <HanwhaFinder target={target} onDone={() => onDone(key)} onCancel={onClose} />
      ) : (
        <form onSubmit={submit} noValidate>
          <Field label="Name"><input autoFocus className={inputCls} style={inputStyle} value={name} onChange={e => setName(e.target.value)} placeholder="Front door" maxLength={60} /></Field>
          <Field label="RTSP address" hint="Include the camera's user name and password if it needs them. They stay on that Pi.">
            <input ref={urlRef} className={`${inputCls} font-mono text-xs`} style={inputStyle} value={url} onChange={e => setUrl(e.target.value)} placeholder="rtsp://user:pass@192.168.1.50:554/stream1" autoCapitalize="none" spellCheck={false} autoComplete="off" />
          </Field>
          <Field label="Transport">
            <select className={inputCls} style={inputStyle} value={transport} onChange={e => setTransport(e.target.value as 'tcp' | 'udp')}>
              <option value="tcp">TCP (recommended)</option>
              <option value="udp">UDP</option>
            </select>
          </Field>
          <Footer busy={busy} label="Add stream" onCancel={onClose} error={err} />
        </form>
      )}
    </Modal>
  );
};

/** The node's own tile: built-in Aether stream (default) or an IP camera. */
export const SourceDialog: React.FC<{ nodeKey: NodeKey; nodeName: string; current?: PrimaryTile; onClose: () => void; onDone: () => void }> = ({ nodeKey, nodeName, current, onClose, onDone }) => {
  const [type, setType] = useState<'builtin' | 'camera'>(current?.type === 'camera' ? 'camera' : 'builtin');
  const [name, setName] = useState(current?.type === 'camera' ? current.name : '');
  const [url, setUrl] = useState(current?.type === 'camera' && current.url ? current.url : 'rtsp://');
  const [transport, setTransport] = useState<'tcp' | 'udp'>(current?.transport || 'tcp');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const urlRef = useRef<HTMLInputElement>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    if (type === 'camera' && !/^rtsps?:\/\/[^/\s]+/i.test(url.trim())) { setErr('Enter the camera\'s RTSP address, for example rtsp://user:pass@192.168.1.50:554/stream1'); urlRef.current?.focus(); return; }
    setBusy(true);
    try {
      const r = await setPrimary(nodeKey, type === 'builtin' ? { type } : { type, name: name.trim() || 'IP camera', url: url.trim(), transport });
      if (!r.streaming && r.error) { setBusy(false); setErr(`Saved, but it can't play yet: ${r.error}`); return; }
      onDone();
    } catch (x: any) { setBusy(false); setErr(x?.message || 'Could not change the source'); }
  };

  const Option: React.FC<{ v: 'builtin' | 'camera'; title: string; text: string }> = ({ v, title, text }) => (
    <label className={`flex gap-3 p-3 mb-2 rounded-lg border cursor-pointer ${type === v ? 'ring-1 ring-hv-brand' : ''}`} style={{ borderColor: type === v ? 'rgb(var(--hv-brand))' : 'rgb(var(--hv-line-strong))' }}>
      <input type="radio" name="src" checked={type === v} onChange={() => setType(v)} className="mt-1 accent-[rgb(var(--hv-brand))]" />
      <span><span className="block text-sm font-semibold text-hv-text">{title}</span><span className="block text-xs text-hv-text-3">{text}</span></span>
    </label>
  );

  return (
    <Modal title={`${nodeName}: tile source`} subtitle="What this node's tile on the overview shows." onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <Option v="builtin" title="Aether Stream View" text="This Pi's doors, I/O, readers and events, live: the same picture your VMS stream shows." />
        <Option v="camera" title="RTSP camera" text="An IP camera, pulled by this Pi (needs its streaming service)." />
        {type === 'camera' && (
          <div className="mt-3">
            <Field label="Name"><input className={inputCls} style={inputStyle} value={name} onChange={e => setName(e.target.value)} placeholder="Front door" maxLength={60} /></Field>
            <Field label="RTSP address" hint="Include the camera's user name and password if it needs them. They stay on this Pi.">
              <input ref={urlRef} autoFocus className={`${inputCls} font-mono text-xs`} style={inputStyle} value={url} onChange={e => setUrl(e.target.value)} placeholder="rtsp://user:pass@192.168.1.50:554/stream1" autoCapitalize="none" spellCheck={false} autoComplete="off" />
            </Field>
            <Field label="Transport">
              <select className={inputCls} style={inputStyle} value={transport} onChange={e => setTransport(e.target.value as 'tcp' | 'udp')}>
                <option value="tcp">TCP (recommended)</option>
                <option value="udp">UDP</option>
              </select>
            </Field>
          </div>
        )}
        <Footer busy={busy} label="Save" onCancel={onClose} error={err} />
      </form>
    </Modal>
  );
};
