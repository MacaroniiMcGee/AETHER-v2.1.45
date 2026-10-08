// System & Backup: live health and inventory of the Pi, plus a full backup,
// restore and reset. Refreshes every 5 s while open; nothing here touches the
// HAT except a cached board query (every 10 min).
import React, { useEffect, useRef, useState } from 'react';
import { Download, Upload, RotateCcw, Usb, Cable, Loader2, AlertTriangle, CheckCircle, Cpu } from 'lucide-react';
import { T, Card, Btn, Meter, Stat, KV, Dot, fmtBytes, fmtDur } from './ui';

type Info = any;

export default function SystemPage({ api, onResetIO }: { api: string; onResetIO?: () => void }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [cpuHist, setCpuHist] = useState<number[]>([]);
  const [restore, setRestore] = useState<{ file: string; bundle: any; fileCount: number; browserKeys: number } | null>(null);
  const [bmsg, setBmsg] = useState<{ tone: 'ok' | 'err'; text: React.ReactNode } | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const j = await (await fetch(`${api}/api/system/info`)).json();
        if (stop) return;
        if (j.success) { setInfo(j); setErr(null); if (typeof j.cpu?.total === 'number') setCpuHist(h => [...h.slice(-59), j.cpu.total]); }
        else setErr(j.error || 'Could not read system info');
      } catch { if (!stop) setErr('Backend not reachable'); }
    };
    tick(); const t = setInterval(tick, 5000);
    return () => { stop = true; clearInterval(t); };
  }, [api]);

  // ---------- backup ----------
  const download = async () => {
    setBusy(true); setBmsg(null);
    try {
      const j = await (await fetch(`${api}/api/config/backup`)).json();
      if (!j.success) throw new Error(j.error);
      const browser: Record<string, string> = {};
      try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i)!; browser[k] = localStorage.getItem(k)!; } } catch { /* no storage */ }
      const bundle = { ...j.backup, browser };
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }));
      a.download = `aether-backup-${bundle.host || 'pi'}-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setBmsg({ tone: 'ok', text: `Backup downloaded: ${Object.keys(j.backup.files).length} config files from the Pi and ${Object.keys(browser).length} browser settings.` });
    } catch (e: any) { setBmsg({ tone: 'err', text: `Backup failed: ${e.message}` }); }
    setBusy(false);
  };

  const pick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const b = JSON.parse(String(r.result));
        if (b.aetherBackup !== 1 || !b.files) {
          // Older export (I/O only) - still restorable into the browser config
          if (b.inputs || b.outputs) { setRestore({ file: f.name, bundle: { legacy: b }, fileCount: 0, browserKeys: 1 }); return; }
          throw new Error('not an Aether backup');
        }
        setRestore({ file: f.name, bundle: b, fileCount: Object.keys(b.files).length, browserKeys: Object.keys(b.browser || {}).length });
      } catch (x: any) { setBmsg({ tone: 'err', text: `${f.name}: ${x.message}` }); }
    };
    r.readAsText(f);
  };

  const doRestore = async () => {
    if (!restore) return;
    setBusy(true); setBmsg(null);
    try {
      const b = restore.bundle;
      if (b.legacy) {
        const cur = JSON.parse(localStorage.getItem('systemConfig') || '{}');
        localStorage.setItem('systemConfig', JSON.stringify({ ...cur, ...b.legacy }));
        await fetch(`${api}/api/config/app`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...cur, ...b.legacy }) });
        setBmsg({ tone: 'ok', text: 'Old I/O export restored. Reloading…' }); setRestore(null);
        setTimeout(() => window.location.reload(), 1200); return;
      }
      const r = await fetch(`${api}/api/config/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ backup: { aetherBackup: 1, files: b.files } }) });
      const j = await r.json();
      if (!j.success) throw new Error(j.error);
      try { for (const [k, v] of Object.entries(b.browser || {})) localStorage.setItem(k, String(v)); } catch { /* */ }
      setRestore(null);
      setBmsg({ tone: 'ok', text: <>Restored {j.written.length} files. What was there before is saved on the Pi as <span className="font-mono">{j.previous}</span>. Restart the backend to load it, then refresh this page. <button className="underline ml-1" onClick={restartBackend}>Restart now</button></> });
    } catch (e: any) { setBmsg({ tone: 'err', text: `Restore failed: ${e.message}` }); }
    setBusy(false);
  };

  const restartBackend = async () => {
    const j = await (await fetch(`${api}/api/system/restart`, { method: 'POST' })).json().catch(() => ({ success: false, error: 'No response' }));
    if (!j.success) { setBmsg({ tone: 'err', text: j.error }); return; }
    setBmsg({ tone: 'ok', text: 'Backend restarting. This page reloads in 8 seconds.' });
    setTimeout(() => window.location.reload(), 8000);
  };

  // ---------- render ----------
  const d = info;
  const memUsed = d ? d.memory.total - d.memory.available : 0;
  const memPct = d ? Math.round(memUsed / d.memory.total * 100) : null;
  const diskPct = d?.disk ? Math.round(d.disk.used / (d.disk.used + d.disk.free) * 100) : null;
  const temp = d?.thermal?.cpuC;
  const tempTone = temp == null ? 'normal' : temp >= 80 ? 'crit' : temp >= 70 ? 'warn' : 'normal';
  const throttle: string[] = d?.thermal?.throttleFlags || [];
  const usb = d?.usb;

  return (
    <div className="space-y-4">
      {err && <div className="rounded-lg border px-3 py-2 text-sm" style={{ color: 'rgb(var(--hv-error-text))', borderColor: 'rgb(var(--hv-error-hover))' }}>{err}</div>}
      {!d && !err && <div className="flex items-center gap-2 text-sm" style={{ color: T.dim }}><Loader2 size={16} className="animate-spin" />Reading the Pi…</div>}

      {d && (<>
        {/* Headline */}
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
          <Stat label="CPU" value={`${d.cpu.total ?? '—'}%`} sub={`load ${d.cpu.load.join(' / ')}`} tone={d.cpu.total >= 90 ? 'crit' : d.cpu.total >= 70 ? 'warn' : 'normal'} />
          <Stat label="Memory" value={`${memPct}%`} sub={`${fmtBytes(memUsed)} of ${fmtBytes(d.memory.total)}`} tone={memPct! >= 90 ? 'crit' : memPct! >= 80 ? 'warn' : 'normal'} />
          <Stat label="CPU temperature" value={temp != null ? `${temp}°C` : '—'} sub={tempTone === 'crit' ? 'Hot: throttling likely' : tempTone === 'warn' ? 'Warm' : d.thermal.fan ? `fan ${d.thermal.fan.rpm} rpm` : 'Normal'} tone={tempTone} />
          <Stat label="Storage" value={`${diskPct ?? '—'}%`} sub={d.disk ? `${fmtBytes(d.disk.free)} free` : ''} tone={diskPct! >= 90 ? 'crit' : diskPct! >= 80 ? 'warn' : 'normal'} />
          <Stat label="USB devices" value={usb?.devices?.length ?? 0} sub={`${usb?.hubs?.length ?? 0} external hub${usb?.hubs?.length === 1 ? '' : 's'}`} />
          <Stat label="Uptime" value={fmtDur(d.device.uptimeS)} sub={`since ${new Date(d.device.bootedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}`} />
        </div>

        {throttle.length > 0 && (
          <div className="rounded-lg border px-3 py-2 text-sm flex items-center gap-2" style={{ color: T.warn, borderColor: 'rgb(var(--hv-text-3))' }}>
            <AlertTriangle size={16} />Power/thermal flags: {throttle.join(', ')}
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-3">
          {/* CPU */}
          <Card title={<span className="flex items-center gap-2"><Cpu size={14} />Processor</span>}>
            <div className="space-y-2.5">
              {(d.cpu.cores || []).map((c: number, i: number) => <Meter key={i} label={`Core ${i + 1}`} pct={c} value={`${c}%`} tone={c >= 90 ? 'crit' : c >= 75 ? 'warn' : 'normal'} />)}
            </div>
            {cpuHist.length > 1 && <Spark values={cpuHist} />}
            <div className="text-[11px] mt-2" style={{ color: T.dim }}>{d.cpu.count} cores{d.cpu.mhz ? ` · ${d.cpu.mhz} MHz` : ''} · last {Math.round(cpuHist.length * 5 / 60 * 10) / 10} min</div>
          </Card>

          {/* Memory & storage */}
          <Card title="Memory and storage">
            <div className="space-y-3">
              <Meter label="RAM" pct={memPct} value={`${fmtBytes(memUsed)} / ${fmtBytes(d.memory.total)}`} tone={memPct! >= 90 ? 'crit' : memPct! >= 80 ? 'warn' : 'normal'} />
              {d.memory.swapTotal > 0 && <Meter label="Swap" pct={Math.round((d.memory.swapTotal - d.memory.swapFree) / d.memory.swapTotal * 100)} value={`${fmtBytes(d.memory.swapTotal - d.memory.swapFree)} / ${fmtBytes(d.memory.swapTotal)}`} />}
              {d.disk && <Meter label={`Disk ${d.disk.mount}`} pct={diskPct} value={`${fmtBytes(d.disk.used)} / ${fmtBytes(d.disk.used + d.disk.free)}`} tone={diskPct! >= 90 ? 'crit' : diskPct! >= 80 ? 'warn' : 'normal'} />}
              <Meter label="Aether backend" pct={Math.round(d.backend.rss / d.memory.total * 100)} value={fmtBytes(d.backend.rss)} />
            </div>
          </Card>

          {/* Device */}
          <Card title="Device">
            <KV rows={[
              ['Model', d.device.model || '—'],
              ['Serial', <span className="font-mono">{d.device.serial || '—'}</span>],
              ['Hostname', <span className="font-mono">{d.device.hostname}</span>],
              ['OS', d.device.os || '—'],
              ['Kernel', <span className="font-mono">{d.device.kernel} ({d.device.arch})</span>],
              ['Fan', d.thermal.fan ? `${d.thermal.fan.rpm} rpm${d.thermal.fan.pwmPct != null ? ` · ${d.thermal.fan.pwmPct}%` : ''}` : 'none detected'],
            ]} />
          </Card>

          {/* HAT */}
          <Card title="Sequent IOplus HAT">
            <KV rows={[
              ['Board', d.hat?.hardware ? `hardware ${d.hat.hardware}` : (d.hat?.error ? <span style={{ color: T.crit }}>not answering</span> : '—')],
              ['Firmware', d.hat?.firmware ? <span>{d.hat.firmware}{Number(d.hat.firmware) < 1.38 && <span className="ml-2 text-xs font-semibold" style={{ color: T.warn }}>update to 01.38+</span>}</span> : '—'],
              ['Board temp / 3.3 V', d.hat?.tempC != null ? `${d.hat.tempC}°C · ${d.hat.volts} V` : '—'],
              ['I2C address', <span className="font-mono">{d.hat?.i2cAddress}</span>],
              ['I2C bus', <span className="flex items-center gap-2"><Dot on={d.i2c.healthy} color={T.green} />{d.i2c.healthy ? 'healthy' : <span style={{ color: T.crit }}>{d.i2c.consecutiveFailures} failures in a row</span>}</span>],
              ['Last minute', `${d.i2c.lastMinute?.calls ?? 0} calls · ${d.i2c.lastMinute?.errors ?? 0} errors · busy ${d.i2c.lastMinute?.busyPct ?? 0}%`],
              ['Gap between calls', `${d.i2c.minGapMs} ms`],
            ]} />
          </Card>

          {/* USB */}
          <Card title={<span className="flex items-center gap-2"><Usb size={14} />USB</span>} right={<span className="text-xs" style={{ color: T.dim }}>{usb.hubs.length} hub{usb.hubs.length === 1 ? '' : 's'} · {usb.devices.length} device{usb.devices.length === 1 ? '' : 's'}</span>}>
            {usb.hubs.length + usb.devices.length === 0 ? <p className="text-sm" style={{ color: T.dim }}>Nothing plugged in.</p> : (
              <ul className="space-y-1.5 text-sm">
                {[...usb.hubs.map((h: any) => ({ ...h, hub: true })), ...usb.devices].map((x: any) => (
                  <li key={x.port} className="flex items-center gap-2">
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0" style={{ background: x.hub ? 'rgb(var(--hv-info) / 0.15)' : 'rgb(var(--hv-popup-panel))', color: x.hub ? 'rgb(var(--hv-info-text))' : T.text2 }}>{x.hub ? 'HUB' : 'DEV'}</span>
                    <span className="truncate flex-1" style={{ color: T.text }} title={`${x.vid}:${x.pid}`}>{x.product || `${x.vid}:${x.pid}`}<span style={{ color: T.dim }}>{x.manufacturer ? ` · ${x.manufacturer}` : ''}</span></span>
                    <span className="text-[11px] font-mono shrink-0" style={{ color: T.dim }}>{x.speed ? `${x.speed} Mb/s` : ''} · {x.port}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* Serial */}
          <Card title={<span className="flex items-center gap-2"><Cable size={14} />Serial ports</span>} right={<span className="text-xs" style={{ color: T.dim }}>RS-485 / OSDP adapters</span>}>
            {d.serialPorts.length === 0 ? <p className="text-sm" style={{ color: T.dim }}>No serial adapters found.</p> : (
              <ul className="space-y-1.5 text-sm">
                {d.serialPorts.map((s: any) => (
                  <li key={s.dev || s.id} className="flex items-center gap-2">
                    <span className="font-mono shrink-0" style={{ color: T.text }}>{s.dev}</span>
                    <span className="truncate text-xs" style={{ color: T.dim }} title={s.id || ''}>{s.id || ''}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* Network */}
          <Card title="Network interfaces">
            {d.network.length === 0 ? <p className="text-sm" style={{ color: T.dim }}>No addresses.</p> : (
              <ul className="space-y-1.5 text-sm">{d.network.map((n: any) => (
                <li key={n.name + n.ip} className="flex justify-between gap-2"><span style={{ color: T.text2 }}>{n.name}</span><span className="font-mono" style={{ color: T.text }}>{n.cidr}</span></li>
              ))}</ul>
            )}
          </Card>

          {/* Services */}
          <Card title="Services">
            <ul className="space-y-1.5 text-sm">
              {d.services.map((s: any) => (
                <li key={s.name} className="flex items-center gap-2">
                  <Dot on={s.state === 'active'} color={T.green} />
                  <span className="flex-1" style={{ color: T.text }}>{s.name}</span>
                  <span className="text-xs" style={{ color: s.state === 'active' ? T.text2 : s.state === 'failed' ? T.crit : T.dim }}>{s.state}</span>
                </li>
              ))}
            </ul>
          </Card>

          {/* Processes */}
          <Card title="Busiest processes">
            <table className="w-full text-sm">
              <thead><tr style={{ color: T.dim }} className="text-[10px]"><th className="text-left font-bold">PROCESS</th><th className="text-right font-bold">CPU</th><th className="text-right font-bold">MEM</th></tr></thead>
              <tbody>{d.processes.map((p: any) => (
                <tr key={p.pid}><td className="truncate max-w-[140px] py-0.5" style={{ color: T.text }}>{p.name} <span className="text-[10px]" style={{ color: T.faint }}>{p.pid}</span></td>
                  <td className="text-right font-mono" style={{ color: T.text2 }}>{p.cpu}%</td><td className="text-right font-mono" style={{ color: T.text2 }}>{p.mem}%</td></tr>
              ))}</tbody>
            </table>
          </Card>

          {/* Aether */}
          <Card title="Aether">
            <KV rows={[
              ['Backend', `v${d.backend.version || '?'} · pid ${d.backend.pid}`],
              ['Frontend', `v${d.backend.frontendVersion || '?'}`],
              ['Node.js', d.backend.node],
              ['Running for', fmtDur(d.backend.uptimeS)],
              ['Installed in', <span className="font-mono text-xs">{d.backend.dir}</span>],
            ]} />
          </Card>
        </div>
      </>)}

      {/* Backup */}
      <Card title="Backup and restore">
        <p className="text-sm mb-3" style={{ color: T.text2 }}>
          One file with every setting: I/O mapping, doors, readers and card formats, OSDP, Wiegand, EOL calibration profiles, emulator configs, sequences, and this browser's settings (Elevator page, panels).
        </p>
        <div className="flex flex-wrap gap-2">
          <Btn tone="primary" onClick={download} disabled={busy}><Download size={15} />Download backup</Btn>
          <Btn onClick={() => fileRef.current?.click()} disabled={busy}><Upload size={15} />Restore from file…</Btn>
          <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={pick} />
          <Btn tone="danger" onClick={onResetIO} disabled={!onResetIO}><RotateCcw size={15} />Reset I/O mapping</Btn>
        </div>
        {bmsg && (
          <div className="mt-3 rounded-lg border px-3 py-2 text-sm flex gap-2" style={{ color: bmsg.tone === 'ok' ? 'rgb(var(--hv-success-text))' : 'rgb(var(--hv-error-text))', borderColor: bmsg.tone === 'ok' ? 'rgb(var(--hv-success-strong))' : 'rgb(var(--hv-error-hover))' }}>
            {bmsg.tone === 'ok' ? <CheckCircle size={16} className="shrink-0 mt-0.5" /> : <AlertTriangle size={16} className="shrink-0 mt-0.5" />}<span>{bmsg.text}</span>
          </div>
        )}
      </Card>

      {restore && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setRestore(null)}>
          <div className="w-full max-w-md rounded-xl border p-5" style={{ background: 'rgb(var(--hv-widget-panel))', borderColor: 'rgb(var(--hv-line-strong))' }} onClick={e => e.stopPropagation()}>
            <h3 className="font-bold mb-2" style={{ color: T.text }}>Restore {restore.file}?</h3>
            <p className="text-sm mb-4" style={{ color: T.text2 }}>
              {restore.bundle.legacy
                ? 'This is an older I/O-only export. It replaces the I/O mapping, reader pool and credential library.'
                : <>This replaces {restore.fileCount} config files on the Pi{restore.bundle.host ? <> (backup from <b>{restore.bundle.host}</b>, {new Date(restore.bundle.createdAt).toLocaleString()})</> : null} and {restore.browserKeys} browser settings. The current files are kept on the Pi first, so this can be undone.</>}
            </p>
            <div className="flex justify-end gap-2">
              <Btn onClick={() => setRestore(null)}>Cancel</Btn>
              <Btn tone="primary" onClick={doRestore} disabled={busy}>Restore</Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Single-series CPU sparkline with a hover readout. */
function Spark({ values }: { values: number[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 300, H = 44, n = values.length;
  const x = (i: number) => (i / Math.max(1, n - 1)) * W, y = (v: number) => H - 2 - (v / 100) * (H - 4);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  return (
    <div className="relative mt-3">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-11" preserveAspectRatio="none"
        onMouseMove={e => { const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect(); setHover(Math.round((e.clientX - r.left) / r.width * (n - 1))); }}
        onMouseLeave={() => setHover(null)} role="img" aria-label="CPU usage history">
        <line x1="0" x2={W} y1={y(50)} y2={y(50)} stroke="rgb(var(--hv-popup-panel))" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />
        <path d={d} fill="none" stroke={T.teal} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        {hover != null && hover >= 0 && hover < n && <line x1={x(hover)} x2={x(hover)} y1="0" y2={H} stroke={T.dim} vectorEffect="non-scaling-stroke" />}
      </svg>
      {hover != null && hover >= 0 && hover < n && (
        <div className="absolute -top-6 text-[11px] px-1.5 py-0.5 rounded font-mono" style={{ left: `${(hover / Math.max(1, n - 1)) * 100}%`, transform: 'translateX(-50%)', background: 'rgb(var(--hv-surface))', color: T.text, border: `1px solid ${T.line2}` }}>
          {values[hover]}% · {Math.round((n - 1 - hover) * 5)} s ago
        </div>
      )}
    </div>
  );
}
