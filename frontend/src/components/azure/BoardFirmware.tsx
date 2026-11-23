// AETHER_AZURE_FW — Azure Debugger › Firmware: update Azure downstream boards (IO168 / I16 / O8 / RI2M / RI4)
// over Aether's own RS-485 adapter, using the vendor's signed .upd images.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Cable, FileUp, RefreshCw, Search, Square, Trash2, Upload, AlertTriangle, CheckCircle2, ShieldCheck, Download } from 'lucide-react';
import { Badge, Button, Dialog, Input, Select, cx, lsGet, lsSet } from '../sunapi/ui';
import { fmtMs, type AzureClient, type FwBoard, type FwJob, type FwPackage, type FwPlan, type FwScan } from './api';
import { Dot, Section } from './parts';

const BAUDS = [9600, 19200, 38400, 57600, 115200];
const fmtBytes = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.round(n / 1e3)} KB`);
const verParts = (v: string | null) => (v || '').split('.').map(x => +x || 0);
const verDesc = (a: FwPackage, b: FwPackage) => { const x = verParts(a.version), y = verParts(b.version); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0); return (a.version ? 0 : 1) - (b.version ? 0 : 1); };
/** Packages for one board: same product and generation, sendable, newest version first. */
const matchesFor = (b: FwBoard, pkgs: FwPackage[]) => pkgs.filter(p => b.azure && p.sendable !== false && p.product === b.product && p.gen === b.gen).sort(verDesc);
const pkgText = (p: FwPackage) => `${p.version || 'version ?'} · ${p.files.some(f => f.kind === 'app') ? '' : 'bootloader only · '}${p.fileName}`;
const kb = (n: number) => `${Math.round(n / 1024)} KB`;
/** Rough wire time: every fragment carries ~18 B of OSDP framing and waits for a ~16 B reply. */
const etaMs = (bytes: number, baud: number, frag: number) => Math.round((bytes + Math.ceil(bytes / frag) * (18 + 16)) * 10 / baud * 1000 * 1.15 + Math.ceil(bytes / frag) * 25);

export const BoardFirmware: React.FC<{ api: AzureClient }> = ({ api }) => {
  const fw = api.fw;
  const [pkgs, setPkgs] = useState<FwPackage[]>([]);
  const [pkgId, setPkgId] = useState<string>(() => lsGet('aether.azure.fw.pkg', ''));
  const [ports, setPorts] = useState<{ path: string; manufacturer: string | null }[]>([]);
  const [port, setPort] = useState<string>(() => lsGet('aether.azure.fw.port', ''));
  const [baud, setBaud] = useState<number>(() => lsGet('aether.azure.fw.baud', 9600));
  const [custom, setCustom] = useState(false);
  const [from, setFrom] = useState(0); const [to, setTo] = useState(31);
  const [scan, setScan] = useState<FwScan | null>(null);
  const [plans, setPlans] = useState<Record<number, FwPlan>>({});
  const [rowPkg, setRowPkg] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(''); const [err, setErr] = useState('');
  const [job, setJob] = useState<FwJob | null>(null);
  const [history, setHistory] = useState<Awaited<ReturnType<AzureClient['fw']['history']>>>([]);
  const [confirm, setConfirm] = useState<{ board: FwBoard; pkg: FwPackage } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pkg = pkgs.find(p => p.id === pkgId) || null;

  const loadPkgs = useCallback(() => fw.packages().then(p => { setPkgs(p); if (p.length && !p.some(x => x.id === pkgId)) setPkgId(p[0].id); }).catch(e => setErr(e.message)), [fw, pkgId]);
  const loadPorts = useCallback(() => fw.ports().then(p => {
    setPorts(p);
    if (port && !p.some(x => x.path === port)) setCustom(true);
    else if (!port && p.length) setPort(p[0].path);
  }).catch(() => setPorts([])), [fw, port]);
  useEffect(() => { loadPkgs(); loadPorts(); fw.history().then(setHistory).catch(() => {}); fw.job().then(setJob).catch(() => {}); }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { lsSet('aether.azure.fw.pkg', pkgId); }, [pkgId]);
  useEffect(() => { lsSet('aether.azure.fw.port', port); lsSet('aether.azure.fw.baud', baud); }, [port, baud]);

  // follow a running job
  useEffect(() => {
    if (!job || job.state !== 'running') return;
    const t = setInterval(() => fw.job().then(j => { setJob(j); if (j && j.state !== 'running') fw.history().then(setHistory).catch(() => {}); }).catch(() => {}), 1000);
    return () => clearInterval(t);
  }, [job, fw]);

  // each board gets its own package: the newest one for its product and generation, unless picked otherwise
  const pkgForBoard = useCallback((b: FwBoard) => {
    const m = matchesFor(b, pkgs);
    return m.find(p => p.id === rowPkg[b.address]) || m.find(p => p.files.some(f => f.kind === 'app')) || m[0] || null;
  }, [pkgs, rowPkg]);
  useEffect(() => {
    if (!scan) { setPlans({}); return; }
    let live = true;
    Promise.all(scan.boards.filter(b => b.azure).map(b => {
      const p = pkgForBoard(b);
      return p ? fw.plan({ packageId: p.id, board: b }).then(pl => [b.address, pl] as const).catch(() => null) : Promise.resolve(null);
    })).then(r => { if (live) setPlans(Object.fromEntries(r.filter(Boolean) as [number, FwPlan][])); });
    return () => { live = false; };
  }, [scan, fw, pkgForBoard]);

  // library grouped by board type for the dropdown
  const groups = useMemo(() => {
    const m = new Map<string, FwPackage[]>();
    for (const p of pkgs) { const k = p.label || p.product || 'Other'; if (!m.has(k)) m.set(k, []); m.get(k)!.push(p); }
    for (const list of m.values()) list.sort(verDesc);
    return [...m];
  }, [pkgs]);

  const [note, setNote] = useState('');
  const addPkg = async (files: File[]) => {
    if (!files.length) return;
    const size = files.reduce((n, f) => n + f.size, 0);
    setErr(''); setNote(''); setBusy(`Uploading ${files.length === 1 ? files[0].name : `${files.length} files`} (${fmtBytes(size)})…`);
    try {
      const r = await fw.addPackages(files, f => setBusy(f < 1 ? `Uploading ${fmtBytes(size)}… ${Math.round(f * 100)}%` : 'Unpacking and sorting the packages…'));
      await loadPkgs();
      const fresh = r.packages.filter(p => !p.existed);
      const first = fresh.find(p => p.sendable !== false) || r.packages[0];
      if (first) setPkgId(first.id);
      const kinds = [...new Set(r.packages.map(p => p.label))].join(', ');
      setNote(`Found ${r.packages.length} package${r.packages.length === 1 ? '' : 's'} (${kinds})${r.existing ? `, ${r.existing} already in the library` : ''}${r.skipped ? `. Skipped ${r.skipped} file${r.skipped === 1 ? '' : 's'} that are not board firmware (IC2 images, tools)` : ''}.`);
      if (r.errors.length) setErr(`Could not read: ${r.errors.slice(0, 6).join('; ')}${r.errors.length > 6 ? ` (+${r.errors.length - 6} more)` : ''}`);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  };
  const doScan = async () => {
    setBusy(`Listening on ${port}, then polling addresses ${from}–${to}…`); setErr(''); setScan(null);
    try { setScan(await fw.scan({ port, baud, from, to })); } catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  };
  const running = job && job.state === 'running';

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-hv-xs p-3 ring-1 ring-inset bg-hv-warning-tint ring-hv-warning/40 text-[12.5px] text-hv-text flex gap-2">
        <AlertTriangle size={16} className="text-hv-warning-fg shrink-0 mt-0.5" />
        <div className="leading-relaxed">
          <b>Aether has to be the only controller on the bus.</b> Wire Aether's RS-485 adapter to the board (TR+, TR−, SG) and take the IC2 off that bus, or move the board onto Aether's bus on its own.
          Before every scan and update Aether listens for 2 seconds and stops if another controller is polling. Keep the board powered for the whole update. If an update is interrupted, the board stays in its bootloader
          (TMP and PFLT LEDs alternate) and can be updated again.
        </div>
      </div>

      <Section title="Firmware library" right={<>
        <Button size="sm" icon={<FileUp size={13} />} onClick={() => fileRef.current?.click()} disabled={!!busy} title="Vendor .zip packages, a bulk zip of many packages, .upd / .e19 images, or a library saved from Aether">Load</Button>
        <a href={pkgs.length ? fw.libraryUrl() : undefined} aria-disabled={!pkgs.length}
          className={cx('inline-flex items-center gap-1 h-7 px-2.5 rounded-hv-xs text-xs ring-1 ring-inset ring-hv-line-strong text-hv-text', pkgs.length ? 'hover:bg-hv-box' : 'opacity-50 pointer-events-none')}
          title="Save every package as one zip; Load it on another Pi"><Download size={13} /> Save all</a>
 <input ref={fileRef} type="file" multiple accept=".zip,.upd,.e19,.s19,.mot" className="hidden" onChange={e => { addPkg([...(e.target.files || [])]); e.target.value = ''; }} />
      </>}>
        {note && <div className="mb-2 text-[12px] text-hv-success-fg">{note}</div>}
        {busy && !busy.startsWith('Listening') && <div className="mb-2 text-[12px] text-hv-text-2">{busy}</div>}
        {!pkgs.length && <div className="text-[13px] text-hv-text-3">Load vendor packages (for example <span className="font-mono">io168_gen3_v1.27.zip</span>), single <span className="font-mono">.upd</span> / <span className="font-mono">.e19</span> images, a library saved from another Aether, or one bulk zip of everything (for example <span className="font-mono">All Azure Releases.zip</span>). Aether finds the board packages inside, skips IC2 firmware and tools, and sorts them by board, generation and version.</div>}
        {pkgs.length > 0 && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-1.5">
              {groups.map(([label, list]) => (
                <button key={label} onClick={() => setPkgId(list[0].id)}
                  className={cx('px-2 py-0.5 rounded-[3px] text-[11.5px] ring-1 ring-inset', pkg && pkg.label === label ? 'bg-hv-info-tint ring-hv-info/50 text-hv-text' : 'bg-hv-widget ring-hv-line text-hv-text-2 hover:text-hv-text')}>
                  {label} <span className="text-hv-text-3">· {list.length === 1 ? list[0].version || '?' : `${list.length} versions`}</span>
                </button>
              ))}
            </div>
            <label className="flex flex-col gap-1 text-[11px] text-hv-text-3 max-w-xl">Package
              <Select value={pkg ? pkg.id : ''} onChange={e => setPkgId(e.target.value)} aria-label="Firmware package">
                {groups.map(([label, list]) => (
                  <optgroup key={label} label={label}>
                    {list.map(p => <option key={p.id} value={p.id}>{label} {pkgText(p)}{p.sendable === false ? ' (stored only)' : ''}</option>)}
                  </optgroup>
                ))}
              </Select>
            </label>
            {pkg && (
              <div className="flex items-start gap-2 rounded-hv-xs px-2.5 py-2 ring-1 ring-inset bg-hv-widget ring-hv-line">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <b className="text-[13px] text-hv-text">{pkg.label}</b>
                    <Badge tone="info">{pkg.version || 'version ?'}</Badge>
                    {pkg.sendable === false && <Badge tone="warning">stored only</Badge>}
                    {pkg.files.every(f => f.signed) && <span className="inline-flex items-center gap-1 text-[11px] text-hv-success-fg"><ShieldCheck size={12} /> signed images</span>}
                    <span className="text-[11px] text-hv-text-3 truncate">{pkg.fileName}</span>
                  </div>
                  <div className="text-[11.5px] text-hv-text-3 mt-0.5">{pkg.files.map(f => `${f.kind === 'bootloader' ? 'bootloader' : 'application'} ${kb(f.size)}${f.format === 'srec' ? ' (S-record)' : ''}`).join(' · ')}
                    {pkg.bootloaderFirstForGen3 && ' · Gen3 boards older than 1.27 get the bootloader image first'}
                    {pkg.sendable === false && ' · Not a board Aether updates. Kept here so you can Save it.'}
                    {pkg.files.some(f => f.format === 'srec') && pkg.files.some(f => f.format === 'upd') && ' · Boards still on 1.26 get the S-record bootloader (.e19); boards on 1.27 get the .upd'}
                    {!pkg.files.some(f => f.kind === 'app') && ' · Bootloader only: send the application from the full package afterwards'}</div>
                  {pkg.notesHead && <details className="mt-1"><summary className="text-[11px] text-hv-info-fg cursor-pointer">Release notes</summary><pre className="mt-1 text-[11px] text-hv-text-2 whitespace-pre-wrap font-mono">{pkg.notesHead}</pre></details>}
                </div>
                <a href={fw.downloadUrl(pkg.id)} className="text-hv-text-3 hover:text-hv-text" aria-label={`Save ${pkg.label} ${pkg.version}`} title="Save this package as a zip"><Download size={13} /></a>
                <button onClick={() => fw.removePackage(pkg.id).then(loadPkgs)} className="text-hv-text-3 hover:text-hv-error-fg" aria-label={`Remove ${pkg.label} ${pkg.version}`} title="Remove from the library"><Trash2 size={13} /></button>
              </div>
            )}
            <div className="text-[11px] text-hv-text-3">{pkgs.length} package{pkgs.length === 1 ? '' : 's'} in the library. When you scan, each board gets the newest package for its type and generation; change it in the board's row.</div>
          </div>
        )}
      </Section>

      <Section title={<span className="inline-flex items-center gap-2"><Cable size={15} /> Boards on Aether's RS-485 port</span>}
        right={<button onClick={loadPorts} className="text-xs text-hv-text-2 inline-flex items-center gap-1 hover:text-hv-text"><RefreshCw size={12} /> Ports</button>}>
        <form className="flex flex-wrap items-end gap-2" onSubmit={e => { e.preventDefault(); doScan(); }}>
          <label className="flex flex-col gap-1 text-[11px] text-hv-text-3 w-56">Port
            {custom
              ? <Input mono value={port} onChange={e => setPort(e.target.value)} placeholder="/dev/ttyUSB0" onBlur={() => { if (ports.some(p => p.path === port)) setCustom(false); }} />
              : <Select value={port} onChange={e => { if (e.target.value === '__custom') { setCustom(true); setPort(''); } else setPort(e.target.value); }}>
                  {ports.map(p => <option key={p.path} value={p.path}>{p.path}{p.manufacturer ? ` · ${p.manufacturer}` : ''}</option>)}
                  {!ports.length && <option value="">No serial ports found</option>}
                  <option value="__custom">Type a path…</option>
                </Select>}
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-hv-text-3 w-28">Baud
            <Select value={baud} onChange={e => setBaud(+e.target.value)}>{BAUDS.map(b => <option key={b} value={b}>{b}</option>)}</Select>
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-hv-text-3 w-20">From<Input type="number" min={0} max={126} value={from} onChange={e => setFrom(+e.target.value)} /></label>
          <label className="flex flex-col gap-1 text-[11px] text-hv-text-3 w-20">To<Input type="number" min={0} max={126} value={to} onChange={e => setTo(+e.target.value)} /></label>
          <Button tone="primary" type="submit" icon={<Search size={14} />} busy={busy.startsWith('Listening')} disabled={!port || !!running}>Scan</Button>
          <span className="text-[11px] text-hv-text-3">Use the bus baud rate (DIP 6/7 on the board). Higher baud = faster update.</span>
        </form>
        {(busy.startsWith('Listening') || err) && <div className={cx('mt-2 text-xs', err ? 'text-hv-error-fg' : 'text-hv-text-2')}>{busy.startsWith('Listening') ? busy : err}</div>}
        {scan && scan.bus.busy && (
          <div className="mt-3 rounded-hv-xs p-3 ring-1 ring-inset bg-hv-error-tint ring-hv-error/40 text-[13px] text-hv-text">
            <b>Another controller is polling this bus</b> ({scan.bus.commands} commands to address {scan.bus.addresses.join(', ')} in 2 s). Nothing was sent. Disconnect the IC2 from this bus, then scan again.
          </div>
        )}
        {scan && !scan.bus.busy && (
          <div className="mt-3 overflow-x-auto">
            {!scan.boards.length && <div className="text-[13px] text-hv-text-3">No board answered between {from} and {to} at {baud} baud. Check the address DIP switches (1–5), the baud (6–7), wiring and power.</div>}
            {scan.boards.length > 0 && (
              <table className="w-full text-[12.5px]">
                <thead><tr className="text-left text-[11px] text-hv-text-3"><th className="py-1 pr-2">Addr</th><th className="pr-2">Board</th><th className="pr-2">Gen</th><th className="pr-2">Firmware</th><th className="pr-2">Serial</th><th className="pr-2">Outputs</th><th className="pr-2">Package</th><th className="pr-2">Plan</th><th /></tr></thead>
                <tbody>{scan.boards.map(b => {
                  const pl = plans[b.address];
                  const matches = matchesFor(b, pkgs);
                  const rp = pkgForBoard(b);
                  return (
                    <tr key={b.address} className="border-t border-hv-line align-top">
                      <td className="py-1.5 pr-2 font-mono">{b.address}</td>
                      <td className="pr-2">{b.error ? <span className="text-hv-error-fg">{b.error}</span> : <>{b.azure ? <Badge tone="info">Azure</Badge> : <span className="text-hv-text-3">{b.vendor}</span>} {b.family}</>}</td>
                      <td className="pr-2">{b.gen ?? '—'}</td>
                      <td className="pr-2 font-mono">{b.firmware ?? '—'}</td>
                      <td className="pr-2 font-mono">{b.serial ?? '—'}</td>
                      <td className="pr-2">{b.outputs ?? '—'}{b.outputs === 16 && <span className="text-hv-text-3"> (XO8)</span>}</td>
                      <td className="pr-2 min-w-[170px]">{!b.azure ? <span className="text-hv-text-3">—</span> : matches.length === 0
                        ? <span className="text-hv-warning-fg text-[12px]">No {b.product || 'matching'}{b.gen ? ` Gen${b.gen}` : ''} package in the library</span>
                        : <select value={rp ? rp.id : ''} onChange={e => setRowPkg(r => ({ ...r, [b.address]: e.target.value }))} aria-label={`Package for address ${b.address}`}
                            className="h-7 w-full max-w-[240px] rounded-hv-xs bg-hv-surface text-xs text-hv-text ring-1 ring-inset ring-hv-line-strong px-1">
                            {matches.map(p => <option key={p.id} value={p.id}>{p.label} {pkgText(p)}</option>)}
                          </select>}</td>
                      <td className="pr-2 max-w-[300px]">{!b.azure || !rp ? <span className="text-hv-text-3">—</span> : !pl ? '…'
                        : pl.ok ? <span className="text-hv-success-fg">{pl.from} → {pl.to || '?'}{pl.steps.length > 1 ? ' (bootloader first)' : pl.steps[0]?.kind === 'bootloader' ? ' (bootloader only)' : ''}</span>
                          : <span className="text-hv-warning-fg">{pl.why[0]}</span>}</td>
                      <td>{b.azure && rp && <Button size="sm" tone={pl && pl.ok ? 'primary' : 'secondary'} icon={<Upload size={12} />} disabled={!!running || !b.serial} onClick={() => setConfirm({ board: b, pkg: rp })}>Update</Button>}</td>
                    </tr>
                  );
                })}</tbody>
              </table>
            )}
          </div>
        )}
      </Section>

      {job && <JobView job={job} onStop={() => fw.abort().then(() => fw.job().then(setJob))} />}

      {history.length > 0 && (
        <Section title="Update history" right={<span className="text-[11px] text-hv-text-3">on this Aether</span>}>
          <div className="max-h-56 overflow-auto">
            <table className="w-full text-[12px]">
              <thead><tr className="text-left text-[11px] text-hv-text-3"><th className="py-1 pr-2">When</th><th className="pr-2">Board</th><th className="pr-2">Package</th><th className="pr-2">Before → after</th><th>Result</th></tr></thead>
              <tbody>{history.map((h, i) => (
                <tr key={i} className="border-t border-hv-line">
                  <td className="py-1 pr-2 whitespace-nowrap">{new Date(h.t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                  <td className="pr-2">addr {h.address} · {h.before?.serial || '?'}</td>
                  <td className="pr-2">{h.package}</td>
                  <td className="pr-2 font-mono">{h.before?.firmware || '?'} → {h.after?.firmware || '—'}{h.before && h.after && h.before.outputs !== h.after.outputs ? ` · outputs ${h.before.outputs}→${h.after.outputs}` : ''}</td>
                  <td className={h.state === 'done' ? 'text-hv-success-fg' : 'text-hv-error-fg'}>{h.state === 'done' ? 'updated' : h.error || h.state}</td>
                </tr>))}</tbody>
            </table>
          </div>
        </Section>
      )}

      {confirm && scan && (
        <ConfirmUpdate board={confirm.board} pkg={confirm.pkg} baud={scan.baud} port={scan.port} api={api}
          onClose={() => setConfirm(null)}
          onStarted={() => { setConfirm(null); fw.job().then(setJob); }} />
      )}
    </div>
  );
};

const ConfirmUpdate: React.FC<{ board: FwBoard; pkg: FwPackage; baud: number; port: string; api: AzureClient; onClose: () => void; onStarted: () => void }> = ({ board, pkg, baud, port, api, onClose, onStarted }) => {
  const [reinstall, setReinstall] = useState(false);
  const [bootloader, setBootloader] = useState<'auto' | 'yes' | 'no'>('auto');
  const fastOk = (board.rxBuffer || 0) >= 1100;
  const [fast, setFast] = useState(false);   // off by default: a Gen3 board timed out on 1000 B fragments at 9600 baud
  const [ack, setAck] = useState(false);
  const [plan, setPlan] = useState<FwPlan | null>(null);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  useEffect(() => { api.fw.plan({ packageId: pkg.id, board, reinstall, bootloader }).then(setPlan).catch(e => setErr(e.message)); }, [api, pkg.id, board, reinstall, bootloader]);
  const frag = fast ? 1000 : 110;
  const total = plan ? plan.steps.reduce((s, x) => s + x.size, 0) : 0;
  const go = async () => {
    setBusy(true); setErr('');
    try { await api.fw.update({ port, baud, address: board.address, serial: board.serial!, packageId: pkg.id, reinstall, bootloader, fragmentSize: frag }); onStarted(); }
    catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return (
    <Dialog open title={`Update board at address ${board.address}`} onClose={onClose} width={560}
      footer={<><Button onClick={onClose}>Cancel</Button><Button tone="primary" busy={busy} disabled={!plan || !plan.ok || !ack} onClick={go} icon={<Upload size={14} />}>Start update</Button></>}>
      <div className="flex flex-col gap-3 text-[13px]">
        <div className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1">
          <span className="text-hv-text-3">Board</span><span>{board.family}, Gen{board.gen}, serial <span className="font-mono">{board.serial}</span></span>
          <span className="text-hv-text-3">Firmware</span><span className="font-mono">{board.firmware} → {pkg.version}</span>
          <span className="text-hv-text-3">Port</span><span className="font-mono">{port} · {baud} baud</span>
          <span className="text-hv-text-3">Steps</span><span>{plan ? plan.steps.map(s => `${s.kind === 'bootloader' ? 'bootloader' : 'application'} (${kb(s.size)}${s.format === 'srec' ? ', S-record' : ''})`).join(', then ') : '…'}</span>
          <span className="text-hv-text-3">Time</span><span>{plan && plan.steps.length ? `about ${fmtMs(etaMs(total, baud, frag) + plan.steps.length * 20000)}` : '—'}{baud === 9600 && ' (set the bus to 38400 for a quicker update)'}</span>
        </div>
        {plan && !plan.ok && <div className="rounded-hv-xs p-2 bg-hv-warning-tint ring-1 ring-inset ring-hv-warning/40 text-hv-text">{plan.why.join(' ')}</div>}
        {plan && (plan.notes || []).map(n => <div key={n} className="rounded-hv-xs p-2 bg-hv-info-tint ring-1 ring-inset ring-hv-info/40 text-hv-text-2 text-[12.5px]">{n}</div>)}
        {plan && plan.bootRequired && <div className="text-[12px] text-hv-text-2">The release notes require the bootloader image first on Gen3 boards older than 1.27, so it is included.</div>}
        <div className="flex flex-col gap-1.5 text-[12.5px]">
          <label className="flex items-center gap-2"><input type="checkbox" checked={reinstall} onChange={e => setReinstall(e.target.checked)} /> Reinstall even if the board already has this version</label>
          <label className="flex items-center gap-2">Bootloader image
            <select value={bootloader} onChange={e => setBootloader(e.target.value as 'auto' | 'yes' | 'no')} className="h-7 rounded-hv-xs bg-hv-surface text-xs ring-1 ring-inset ring-hv-line-strong px-1">
              <option value="auto">only when required</option><option value="yes">always send it first</option><option value="no">never</option>
            </select></label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={fast} disabled={!fastOk} onChange={e => setFast(e.target.checked)} /> Large fragments (1000 B){!fastOk && ' — the board does not report a big enough buffer'}</label>
        </div>
        <label className="flex items-start gap-2 rounded-hv-xs p-2 ring-1 ring-inset ring-hv-line bg-hv-widget">
          <input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} className="mt-0.5" />
          <span>The IC2 is disconnected from this bus and the board will stay powered until Aether says it is done. Aether checks the serial number again before sending.</span>
        </label>
        {err && <div className="text-xs text-hv-error-fg">{err}</div>}
      </div>
    </Dialog>
  );
};

const JobView: React.FC<{ job: FwJob; onStop: () => void }> = ({ job, onStop }) => {
  const pct = job.progress ? job.progress.percent : 0;
  const elapsed = (job.endedAt || Date.now()) - job.startedAt;
  const rate = job.progress && job.progress.bytesSent ? job.progress.bytesSent / Math.max(1, (job.progress.at - job.startedAt)) : null;
  const left = rate && job.progress && job.progress.totalBytes > job.progress.bytesSent ? (job.progress.totalBytes - job.progress.bytesSent) / rate : null;
  const tone = job.state === 'done' ? 'success' : job.state === 'failed' ? 'error' : 'info';
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => { logRef.current?.scrollTo(0, 1e6); }, [job.log.length]);
  return (
    <Section title={<span className="inline-flex items-center gap-2"><Dot tone={tone === 'info' ? 'info' : tone} /> Update · address {job.address} · {job.package}</span>}
      right={job.state === 'running' ? <Button size="sm" tone="danger" icon={<Square size={12} />} onClick={onStop}>Stop</Button> : <Badge tone={tone}>{job.state === 'done' ? 'Done' : 'Failed'}</Badge>}>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          {job.steps.map(s => (
            <span key={s.kind} className={cx('px-2 py-0.5 rounded-[3px] text-[11.5px] ring-1 ring-inset',
              s.state === 'done' ? 'bg-hv-success-tint ring-hv-success/40 text-hv-success-fg' : s.state === 'failed' ? 'bg-hv-error-tint ring-hv-error/40 text-hv-error-fg' : s.state === 'pending' ? 'bg-hv-surface ring-hv-line text-hv-text-3' : 'bg-hv-info-tint ring-hv-info/40 text-hv-info-fg')}>
              {s.kind === 'bootloader' ? 'Bootloader' : 'Application'} · {s.state}{s.after ? ` → ${s.after}` : ''}
            </span>
          ))}
        </div>
        {job.state === 'running' && (
          <div>
            <div className="h-2 rounded-full bg-hv-widget overflow-hidden"><div className="h-full bg-hv-info transition-all" style={{ width: `${pct}%` }} /></div>
            <div className="text-[11px] text-hv-text-3 mt-1">{job.step === null ? 'checking the bus and the board…' : `${job.step} · ${pct}%`}{job.progress?.totalFragments ? ` · fragment ${job.progress.fragment}/${job.progress.totalFragments}` : ''} · {fmtMs(elapsed)} elapsed{left ? ` · about ${fmtMs(left)} left` : ''}</div>
          </div>
        )}
        {job.state === 'done' && job.result && <div className="flex items-center gap-2 text-[13px] text-hv-success-fg"><CheckCircle2 size={15} /> {job.result}</div>}
        {job.state === 'failed' && job.error && <div className="text-[13px] text-hv-error-fg">{job.error}</div>}
        <div ref={logRef} className="max-h-40 overflow-auto rounded-hv-xs ring-1 ring-inset ring-hv-line bg-hv-surface font-mono text-[11px]">
          {job.log.map((l, i) => <div key={i} className={cx('px-2 py-0.5', l.level === 'error' ? 'text-hv-error-fg' : l.level === 'success' ? 'text-hv-success-fg' : 'text-hv-text-2')}>{new Date(l.t).toLocaleTimeString()} {l.msg}</div>)}
        </div>
      </div>
    </Section>
  );
};
