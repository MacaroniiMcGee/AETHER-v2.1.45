// AETHER_AZURE_DEBUG — the report views: Overview (where is it broken), Boards, SDK link, Cloud, Compare.
import React, { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Cable, Cloud, Cpu, DoorOpen, Settings2, Send, ArrowLeftRight, Loader2 } from 'lucide-react';
import { Badge, Segmented, Select, cx } from '../sunapi/ui';
import { fmtAt, fmtMs, type AzureClient, type Board, type Finding, type Frame, type Hop, type Meta, type Scan } from './api';
import { Dot, FindingList, Section, Stat, hopLabel, hopTone } from './parts';

// Same split as backend/analytics/azure.js HOPS, so the list under a hop matches its colour.
const EDGE = /^delivery\.(restart|ntp|heartbeat|log-gap|clock)/;
export const HOP_TEST: Record<string, (f: Finding) => boolean> = {
  cloud: f => f.cat === 'cloud' || EDGE.test(f.id) || f.area === 'cloud',
  delivery: f => f.cat === 'delivery' && !EDGE.test(f.id),
  sdk: f => (f.cat === 'panel' && f.id !== 'panel.reader-offline') || f.area === 'sdk',
  bus: f => f.id === 'panel.reader-offline' || f.area === 'bus',
  doors: f => f.cat === 'door' || f.cat === 'security' || f.area === 'io',
  config: f => f.cat === 'config' || f.area === 'config',
};
const HOP_ICON: Record<string, React.ReactNode> = {
  cloud: <Cloud size={16} />, delivery: <Send size={16} />, sdk: <Cpu size={16} />, bus: <Cable size={16} />, doors: <DoorOpen size={16} />, config: <Settings2 size={16} />,
};
export const allFindings = (s: Scan): Finding[] => [...(s.report.findings || []), ...(s.azure.checks || [])];

// ── Overview ──────────────────────────────────────────────────────────────────
export const Overview: React.FC<{ scan: Scan }> = ({ scan }) => {
  const { azure: a, report: r } = scan;
  const tz = r.zone?.tz;
  const hops = a.hops || [];
  const firstBad = hops.find(h => h.status === 'bad') || hops.find(h => h.status === 'warn') || hops[0];
  const [sel, setSel] = useState<string>(firstBad ? firstBad.id : 'cloud');
  useEffect(() => { setSel(firstBad ? firstBad.id : 'cloud'); }, [scan.meta.id]);   // eslint-disable-line react-hooks/exhaustive-deps
  const hop = hops.find(h => h.id === sel);
  const items = allFindings(scan).filter(HOP_TEST[sel] || (() => false));
  const c = a.controller;
  const bad = hops.filter(h => h.status === 'bad');
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
        <Stat label="Controller" value={c.model || (a.osdp.frames ? 'IC2 syslog' : '—')} sub={c.hostname || c.serialNo || undefined} />
        <Stat label="IC2 firmware" value={c.firmware || '—'} sub={c.hardware ? `hardware ${c.hardware}` : undefined} />
        <Stat label="Cloud Connector" value={c.connector || '—'} sub={c.claim ? c.claim.toLowerCase() : undefined} tone={c.claim && c.claim !== 'CLAIMED' ? 'warning' : undefined} />
        <Stat label="Downstream boards" value={a.boards.length} sub={a.com.map(x => `${x.port.toUpperCase()} ${x.baud ?? '?'}`).join(' · ') || undefined}
          tone={a.boards.some(b => b.status === 'offline') ? 'error' : undefined} />
        <Stat label="Log window" value={r.windowLocal && r.windowLocal.from ? r.windowLocal.from.slice(5, 16) : '—'} sub={r.windowLocal && r.windowLocal.to ? `to ${r.windowLocal.to.slice(5, 16)} · ${tz}` : undefined} />
      </div>

      {/* the chain */}
      <div className="rounded-hv-xs ring-1 ring-inset ring-hv-line bg-hv-surface p-3">
        <div className="text-[12px] text-hv-text-3 mb-2">
          {bad.length ? <>Problems along the path: <b className="text-hv-text">{bad.map(h => h.label).join(', ')}</b>. Pick a step to see why and what to check.</>
            : hops.some(h => h.status === 'warn') ? 'Nothing is clearly broken; the amber steps are worth a look. Pick a step to see the details.'
              : `Every step looks healthy in this ${r.clipped ? 'time range' : 'bundle'}. Pick a step to see the details.`}
        </div>
        <div className="flex items-stretch gap-1 overflow-x-auto pb-1">
          {hops.map((h, i) => (
            <React.Fragment key={h.id}>
              {i > 0 && <ArrowRight size={14} className="self-center text-hv-text-3 shrink-0" />}
              <HopCard h={h} active={sel === h.id} onClick={() => setSel(h.id)} />
            </React.Fragment>
          ))}
        </div>
      </div>

      {hop && (
        <Section title={<span className="inline-flex items-center gap-2">{HOP_ICON[hop.id]} {hop.label} <span className="font-normal text-hv-text-3 text-xs">{hop.sub}</span></span>}
          right={<Badge tone={hopTone(hop.status)}>{hopLabel(hop.status)}</Badge>}>
          <FindingList items={items} tz={tz} empty="Nothing found for this step." />
        </Section>
      )}
    </div>
  );
};

const HopCard: React.FC<{ h: Hop; active: boolean; onClick: () => void }> = ({ h, active, onClick }) => (
  <button onClick={onClick} aria-pressed={active}
    className={cx('min-w-[150px] flex-1 rounded-hv-xs px-3 py-2 text-left ring-1 ring-inset transition-colors',
      h.status === 'bad' ? 'bg-hv-error-tint ring-hv-error/50' : h.status === 'warn' ? 'bg-hv-warning-tint ring-hv-warning/50' : 'bg-hv-success-tint ring-hv-success/40',
      active && 'outline outline-2 outline-offset-1 outline-hv-info')}>
    <div className={cx('flex items-center gap-1.5 text-[12.5px] font-bold', h.status === 'bad' ? 'text-hv-error-fg' : h.status === 'warn' ? 'text-hv-warning-fg' : 'text-hv-success-fg')}>
      {HOP_ICON[h.id]} {h.label}
    </div>
    <div className="text-[11px] text-hv-text-2 mt-0.5">{h.count ? `${h.count} item${h.count > 1 ? 's' : ''}` : 'no issues'}</div>
    {h.top[0] && <div className="text-[11px] text-hv-text-3 mt-0.5 line-clamp-2">{h.top[0].title}</div>}
  </button>
);

// ── Boards ────────────────────────────────────────────────────────────────────
export const Boards: React.FC<{ scan: Scan }> = ({ scan }) => {
  const a = scan.azure; const tz = scan.report.zone?.tz;
  const ports = useMemo(() => {
    const p = new Map<string, Board[]>();
    for (const c of a.com) p.set(c.port, []);
    for (const b of a.boards) { const k = b.port || '?'; if (!p.has(k)) p.set(k, []); p.get(k)!.push(b); }
    return [...p.entries()];
  }, [a]);
  const busChecks = a.checks.filter(c => c.area === 'bus' || c.area === 'io');
  const onboard = a.readers.filter(r => r.lda === 1 || r.lda === 2);
  return (
    <div className="flex flex-col gap-3">
      {!a.boards.length && !a.osdp.frames && <div className="text-[13px] text-hv-text-3">No downstream board configuration (panelconfig.json) in this bundle.</div>}
      {ports.length > 0 && (
        <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(300px, 1fr))` }}>
          {ports.map(([port, list]) => {
            const baud = a.com.find(c => c.port === port)?.baud;
            const shared = onboard.filter(r => `com${r.lda}` === port && /osdp/i.test(r.mode || ''));
            return (
              <Section key={port} title={`${port.toUpperCase()} — RS-485`} right={<span className="text-[11px] text-hv-text-3">{baud ? `${baud} baud` : 'baud ?'} · {list.length} board{list.length === 1 ? '' : 's'}</span>}>
                {shared.length > 0 && <div className="text-[11px] text-hv-text-3 mb-2">Shares its bus with IC2 reader port {shared[0].lda} (OSDP address {shared.map(s => s.addr).join(', ')}).</div>}
                <div className="flex flex-col gap-1.5">
                  {list.map(b => <BoardRow key={b.id} b={b} flagged={a.checks.some(c => (c.boards || []).includes(b.id))} tz={tz} />)}
                  {!list.length && <div className="text-[12px] text-hv-text-3">No boards configured on this port.</div>}
                </div>
              </Section>
            );
          })}
        </div>
      )}
      {a.deviceStatus.length > 0 && <StatusStrip scan={scan} />}
      {busChecks.length > 0 && <Section title="Board and I/O checks"><FindingList items={busChecks} tz={tz} /></Section>}
      {a.readers.length > 0 && (
        <Section title="Reader ports" right={<span className="text-[11px] text-hv-text-3">from ioconfig.json</span>}>
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead><tr className="text-left text-[11px] text-hv-text-3"><th className="py-1 pr-3">Reader</th><th className="pr-3">On</th><th className="pr-3">Mode</th><th className="pr-3">OSDP address</th><th className="pr-3">Baud</th><th className="pr-3">Secure channel</th><th>Door</th></tr></thead>
              <tbody>
                {a.readers.map(r => {
                  const b = a.boards.find(x => x.lda === r.lda);
                  return (
                    <tr key={r.label + r.mode} className="border-t border-hv-line">
                      <td className="py-1 pr-3 font-mono">{r.label}</td>
                      <td className="pr-3 text-hv-text-2">{b ? b.model : r.lda <= 5 ? 'IC2' : `LDA ${r.lda}`}</td>
                      <td className="pr-3">{r.mode || '—'}</td>
                      <td className="pr-3">{/osdp/i.test(r.mode || '') ? r.addr : '—'}</td>
                      <td className="pr-3">{r.baud ?? '—'}</td>
                      <td className="pr-3">{/osdp/i.test(r.mode || '') ? (r.secure ? 'on' : 'off') : '—'}</td>
                      <td>{r.assigned ? <Badge tone="info">assigned</Badge> : <span className="text-hv-text-3">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Section>
      )}
      {a.osdp.frames > 0 && <OsdpDriverView scan={scan} />}
    </div>
  );
};

const BoardRow: React.FC<{ b: Board; flagged: boolean; tz?: string }> = ({ b, flagged, tz }) => {
  const tone = b.status === 'online' ? (b.offline ? 'warning' : 'success') : b.status === 'offline' ? 'error' : 'neutral';
  return (
    <div className={cx('rounded-hv-xs px-2.5 py-2 ring-1 ring-inset', flagged ? 'ring-hv-warning/50 bg-hv-warning-tint' : 'ring-hv-line bg-hv-widget')}>
      <div className="flex items-center gap-2">
        <Dot tone={tone} />
        <span className="text-[13px] font-semibold text-hv-text truncate">{b.model || 'Unknown board'}</span>
        <span className="text-[11px] text-hv-text-3 truncate">{b.info.label !== b.model ? b.info.label : ''}</span>
        <span className="ml-auto font-mono text-[12px] text-hv-text">addr {b.addr ?? '?'}</span>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-[11px] text-hv-text-3">
        <span>LDA {b.lda ?? '?'}</span>
        <span>status: <b className={cx(b.status === 'offline' ? 'text-hv-error-fg' : b.status === 'online' ? 'text-hv-text-2' : 'text-hv-warning-fg')}>{b.status || (b.lastEvent ? 'none saved' : 'never reported')}</b></span>
        {b.offline > 0 && <span className="text-hv-warning-fg">offline events: {b.offline}</span>}
        {b.relayChanges > 0 && <span>relay changes: {b.relayChanges}</span>}
        {b.info.inputs != null && <span>{b.info.readers ? `${b.info.readers}R · ` : ''}{b.info.inputs}in · {b.info.outputs}out</span>}
        {b.lastEvent && <span>last: {b.lastEvent.state} {fmtAt(b.lastEvent.t, tz)}</span>}
      </div>
    </div>
  );
};

/** Online/offline marks per device across the log window. */
const StatusStrip: React.FC<{ scan: Scan }> = ({ scan }) => {
  const a = scan.azure; const tz = scan.report.zone?.tz;
  const rows = useMemo(() => {
    const m = new Map<string, { key: string; label: string; marks: { t: number; off: boolean; reason: string }[] }>();
    for (const s of a.deviceStatus) {
      const key = `${s.kind}-${s.node}-${s.lda}-${s.idx}`;
      const b = a.boards.find(x => x.lda === s.lda);
      if (!m.has(key)) m.set(key, { key, label: `${s.kind === 'reader' ? 'Reader' : b ? b.model : 'Port'} ${s.node}-${s.lda}-${s.idx}`, marks: [] });
      m.get(key)!.marks.push({ t: s.t, off: s.state === 'offline', reason: s.reason });
    }
    return [...m.values()].sort((x, y) => y.marks.filter(k => k.off).length - x.marks.filter(k => k.off).length).slice(0, 16);
  }, [a]);
  const ts = a.deviceStatus.map(s => s.t);
  const from = Math.min(...ts, scan.report.window?.from ?? Infinity), to = Math.max(...ts, scan.report.window?.to ?? -Infinity);
  const W = 900, L = 170, H = 18;
  const x = (t: number) => L + ((t - from) / Math.max(1, to - from)) * (W - L - 8);
  return (
    <Section title="Online / offline history" right={<span className="text-[11px] text-hv-text-3"><Dot tone="error" /> offline <Dot tone="success" /> back online</span>}>
      <svg viewBox={`0 0 ${W} ${rows.length * H + 18}`} className="w-full h-auto block" role="img" aria-label="Device online and offline events over time">
        {rows.map((r, i) => (
          <g key={r.key} transform={`translate(0 ${i * H})`}>
            <text x={0} y={12} className="fill-hv-text-2" style={{ fontSize: 11 }}>{r.label.slice(0, 26)}</text>
            <line x1={L} x2={W - 8} y1={9} y2={9} className="stroke-hv-line" strokeWidth={1} />
            {r.marks.map((k, j) => (
              <rect key={j} x={x(k.t) - 1} y={k.off ? 2 : 5} width={2} height={k.off ? 14 : 8} rx={1} className={k.off ? 'fill-hv-error' : 'fill-hv-success'}>
                <title>{`${k.off ? 'offline' : 'online'} (${k.reason}) ${fmtAt(k.t, tz)}`}</title>
              </rect>
            ))}
          </g>
        ))}
        <text x={L} y={rows.length * H + 14} className="fill-hv-text-3" style={{ fontSize: 10 }}>{fmtAt(from, tz)}</text>
        <text x={W - 8} y={rows.length * H + 14} textAnchor="end" className="fill-hv-text-3" style={{ fontSize: 10 }}>{fmtAt(to, tz)}</text>
      </svg>
    </Section>
  );
};

const OsdpDriverView: React.FC<{ scan: Scan }> = ({ scan }) => {
  const o = scan.azure.osdp; const tz = scan.report.zone?.tz;
  return (
    <Section title="IC2 OSDP driver log" right={<span className="text-[11px] text-hv-text-3">{o.frames} replies · {o.unknownNotes} "unknown status" notes</span>}>
      <p className="text-[11.5px] text-hv-text-3 mb-2">Replies the IC2 received from its downstream boards (printed by the IC2 without the checksum). Each chip is input = last value: 00 normal, 01 active, FF unknown (supervision fault). Numbers follow the IC2's own input numbering when its log shows it.</p>
      <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
        {o.devices.map(d => (
          <div key={`${d.drv}/${d.addr}`} className="rounded-hv-xs ring-1 ring-inset ring-hv-line bg-hv-widget p-2">
            <div className="flex items-center gap-2 text-[12.5px] font-semibold text-hv-text">Driver {d.drv} · address {d.addr}
              <span className="ml-auto text-[11px] font-normal text-hv-text-3">{d.frames} replies · {d.spanMin} min</span></div>
            <div className="flex flex-wrap gap-1 mt-1.5">
              {d.inputs.map(i => (
                <span key={i.input} title={`OSDP byte ${i.input}${i.ic2 != null ? ` (IC2 input ${i.ic2})` : ''}: ${i.changes} changes, ${i.perMin}/min, ${i.unknown} unknown`}
                  className={cx('min-w-[34px] text-center px-1 py-0.5 rounded-[3px] text-[10.5px] font-mono ring-1 ring-inset',
                    i.unknown ? 'bg-hv-error-tint ring-hv-error/50 text-hv-error-fg' : i.changes >= 6 ? 'bg-hv-warning-tint ring-hv-warning/50 text-hv-warning-fg' : i.last === 1 ? 'bg-hv-info-tint ring-hv-info/40 text-hv-info-fg' : 'bg-hv-surface ring-hv-line text-hv-text-3')}>
                  {i.ic2 ?? i.input}={i.last == null ? '?' : i.last.toString(16).padStart(2, '0').toUpperCase()}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
      {o.sample.length > 0 && (
        <details className="mt-2">
          <summary className="text-[11.5px] text-hv-info-fg cursor-pointer">Last {o.sample.length} replies</summary>
          <div className="mt-1 max-h-56 overflow-auto rounded-hv-xs ring-1 ring-inset ring-hv-line">
            {o.sample.slice().reverse().map((f, i) => (
              <div key={i} className="flex gap-2 px-2 py-0.5 border-b border-hv-line font-mono text-[11px]">
                <span className="text-hv-text-3 w-[110px] shrink-0">{fmtAt(f.t, tz)}</span><span className="w-[70px] shrink-0">drv {f.drv}/{f.addr}</span>
                <span className="w-[60px] shrink-0 text-hv-text-2">{f.name}</span><span className="break-all">{f.data.replace(/(..)/g, '$1 ').trim()}</span>
                {f.note && <span className="text-hv-warning-fg">{f.note}</span>}
              </div>
            ))}
          </div>
        </details>
      )}
    </Section>
  );
};

// ── SDK link ──────────────────────────────────────────────────────────────────
function pairFrames(frames: Frame[]) {
  const pending = new Map<string, Frame[]>();
  const stats = new Map<string, { name: string; n: number; replied: number; lat: number[] }>();
  const answers = (r: Frame, c: Frame) => (r.code === '0800' ? !r.ackOf || r.ackOf === c.code
    : r.code.slice(0, 2) === c.code.slice(0, 2) && parseInt(r.code.slice(2), 16) === ((parseInt(c.code.slice(2), 16) + 1) & 0xff));
  let unanswered = 0;
  for (const f of frames) {
    if (f.dir === 'S') {
      const q = pending.get(f.peer) || []; q.push(f); pending.set(f.peer, q);
      const s = stats.get(f.code) || { name: f.name, n: 0, replied: 0, lat: [] }; s.n++; stats.set(f.code, s);
      while (q.length && f.t - q[0].t > 60000) { q.shift(); unanswered++; }
    } else if (f.dir === 'R') {
      const q = pending.get(f.peer) || [];
      const i = q.findIndex(c => answers(f, c));
      if (i >= 0) { const c = q.splice(i, 1)[0]; const s = stats.get(c.code)!; s.replied++; s.lat.push(f.t - c.t); }
    }
  }
  for (const q of pending.values()) unanswered += q.length;
  const pct = (a: number[], p: number) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  return {
    unanswered,
    rows: [...stats.entries()].map(([code, s]) => ({ code, name: s.name, n: s.n, replied: s.replied, p50: pct(s.lat, 0.5), p95: pct(s.lat, 0.95), max: s.lat.length ? Math.max(...s.lat) : null }))
      .sort((a, b) => b.n - a.n),
  };
}

export const SdkLink: React.FC<{ scan: Scan }> = ({ scan }) => {
  const frames = scan.report.frames || []; const tz = scan.report.zone?.tz;
  const [filter, setFilter] = useState<'all' | 'S' | 'E' | 'slow'>('all');
  const [page, setPage] = useState(0);
  const pair = useMemo(() => pairFrames(frames), [frames]);
  const evCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of frames) if (f.dir === 'E') m.set(f.evName || f.name, (m.get(f.evName || f.name) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
  }, [frames]);
  const peers = [...new Set(frames.map(f => f.peer).filter(Boolean))];
  const host = frames.find(f => f.hostname)?.hostname;
  const shown = useMemo(() => frames.filter(f => filter === 'all' || (filter === 'slow' ? f.lenOk === false : f.dir === filter || (filter === 'S' && f.dir === 'R'))), [frames, filter]);
  const PER = 200; const pages = Math.max(1, Math.ceil(shown.length / PER));
  const p = Math.min(page, pages - 1);
  const slice = shown.slice(Math.max(0, shown.length - (p + 1) * PER), shown.length - p * PER);
  const sdkFindings = allFindings(scan).filter(HOP_TEST.sdk);
  if (!frames.length) return <div className="text-[13px] text-hv-text-3">No ASP SDK trace (aspsdk_*.log) in this bundle. Turn on SDK trace logging on the controller and export the logs again.</div>;
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))' }}>
        <Stat label="Frames" value={frames.length.toLocaleString()} sub={`${peers.join(', ') || '—'}`} />
        <Stat label="Commands" value={frames.filter(f => f.dir === 'S').length.toLocaleString()} sub="Cloud Connector → IC2" />
        <Stat label="Events" value={frames.filter(f => f.dir === 'E').length.toLocaleString()} sub="IC2 → Cloud Connector" />
        <Stat label="No reply" value={pair.unanswered} tone={pair.unanswered ? 'warning' : 'success'} sub="commands left unanswered" />
        <Stat label="Controller" value={host || '—'} sub="from the session hello" />
      </div>
      {sdkFindings.length > 0 && <Section title="SDK link findings"><FindingList items={sdkFindings} tz={tz} /></Section>}
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))' }}>
        <Section title="Commands and reply times">
          <div className="max-h-72 overflow-auto">
            <table className="w-full text-[12px]">
              <thead><tr className="text-left text-[11px] text-hv-text-3"><th className="py-1 pr-2">Command</th><th className="pr-2 text-right">Sent</th><th className="pr-2 text-right">Replied</th><th className="pr-2 text-right">Median</th><th className="text-right">Worst</th></tr></thead>
              <tbody>{pair.rows.map(r => (
                <tr key={r.code} className="border-t border-hv-line">
                  <td className="py-1 pr-2"><span className="font-mono text-hv-text-3 mr-1.5">{r.code.slice(0, 2)}/{r.code.slice(2)}</span>{r.name}</td>
                  <td className="pr-2 text-right">{r.n}</td>
                  <td className={cx('pr-2 text-right', r.replied < r.n && 'text-hv-warning-fg')}>{r.replied}</td>
                  <td className="pr-2 text-right">{fmtMs(r.p50)}</td>
                  <td className={cx('text-right', (r.max || 0) > 1000 && 'text-hv-warning-fg')}>{fmtMs(r.max)}</td>
                </tr>))}</tbody>
            </table>
          </div>
        </Section>
        <Section title="Events from the controller">
          <div className="flex flex-col gap-1 max-h-72 overflow-auto">
            {evCounts.map(([n, c]) => (
              <div key={n} className="flex items-center gap-2 text-[12px]">
                <span className="flex-1 truncate text-hv-text-2">{n}</span>
                <div className="w-28 h-2 rounded-full bg-hv-widget overflow-hidden"><div className="h-full bg-hv-info" style={{ width: `${(c / evCounts[0][1]) * 100}%` }} /></div>
                <span className="w-12 text-right font-mono">{c}</span>
              </div>
            ))}
          </div>
        </Section>
      </div>
      <Section title="Conversation" right={<>
        <Segmented value={filter} onChange={v => { setFilter(v); setPage(0); }} items={[{ id: 'all', label: 'All' }, { id: 'S', label: 'Commands' }, { id: 'E', label: 'Events' }, { id: 'slow', label: 'Malformed' }]} />
        <button disabled={p >= pages - 1} onClick={() => setPage(p + 1)} className="text-xs text-hv-text-2 disabled:opacity-40">Older</button>
        <span className="text-[11px] text-hv-text-3">{p + 1}/{pages}</span>
        <button disabled={p === 0} onClick={() => setPage(p - 1)} className="text-xs text-hv-text-2 disabled:opacity-40">Newer</button>
      </>}>
        <div className="max-h-[420px] overflow-auto rounded-hv-xs ring-1 ring-inset ring-hv-line">
          {slice.map((f, i) => (
            <details key={i} className="border-b border-hv-line">
              <summary className="flex items-center gap-2 px-2 py-1 text-[11.5px] cursor-pointer list-none">
                <span className="font-mono text-hv-text-3 w-[118px] shrink-0">{fmtAt(f.t, tz)}</span>
                <span className={cx('w-[86px] shrink-0 font-semibold', f.dir === 'S' ? 'text-hv-info-fg' : f.dir === 'E' ? 'text-hv-purple-fg' : 'text-hv-success-fg')}>
                  {f.dir === 'S' ? 'CC → IC2' : f.dir === 'R' ? 'IC2 → CC reply' : f.dir === 'E' ? 'IC2 → CC event' : f.dir}
                </span>
                <span className="font-mono text-hv-text-3 w-[42px] shrink-0">{f.code.slice(0, 2)}/{f.code.slice(2)}</span>
                <span className="truncate flex-1 text-hv-text">{f.dir === 'E' && f.evName ? f.evName : f.name}{f.point ? ` · ${f.point}` : ''}</span>
                {f.serial != null && <span className="font-mono text-hv-text-3">#{f.serial}</span>}
                {f.ackSerial != null && <span className="font-mono text-hv-text-3">ack #{f.ackSerial}</span>}
                {f.conf !== 'high' && <span className="text-[10px] text-hv-text-3" title="How sure the decoder is of this name">{f.conf}</span>}
                {f.lenOk === false && <Badge tone="warning">length</Badge>}
              </summary>
              <div className="px-2 pb-1.5 pl-[128px] font-mono text-[10.5px] text-hv-text-2 break-all">{f.hex}</div>
            </details>
          ))}
        </div>
        <p className="text-[11px] text-hv-text-3 mt-1.5">Names come from Aether's decoder of the ASP SDK trace (no public spec). "low"/"medium" next to a name means it was inferred from timing.</p>
      </Section>
    </div>
  );
};

// ── Cloud ─────────────────────────────────────────────────────────────────────
export const CloudView: React.FC<{ scan: Scan }> = ({ scan }) => {
  const a = scan.azure; const tz = scan.report.zone?.tz;
  const boots = useMemo(() => {
    const out: { t: number; items: typeof a.lifecycle }[] = [];
    for (const l of a.lifecycle) { if (l.kind === 'start' || !out.length) out.push({ t: l.t, items: [] }); out[out.length - 1].items.push(l); }
    return out.slice(-8).reverse();
  }, [a]);
  const cloud = allFindings(scan).filter(f => HOP_TEST.cloud(f) || HOP_TEST.delivery(f));
  return (
    <div className="flex flex-col gap-3">
      <Section title="Cloud Connector start-ups" right={<span className="text-[11px] text-hv-text-3">HealthMonitor.log · newest first</span>}>
        {!boots.length && <div className="text-[13px] text-hv-text-3">No HealthMonitor.log in this bundle.</div>}
        <div className="flex flex-col gap-2">
          {boots.map((b, i) => {
            const claimed = b.items.some(x => x.state === 'CLAIMED');
            return (
              <div key={i} className="rounded-hv-xs ring-1 ring-inset ring-hv-line bg-hv-widget p-2">
                <div className="flex items-center gap-2 text-[12px] mb-1.5"><Dot tone={claimed ? 'success' : 'warning'} /><b className="text-hv-text">{fmtAt(b.t, tz)}</b>
                  <span className="text-hv-text-3">{claimed ? 'reached CLAIMED' : 'did not reach CLAIMED in this log'}</span>
                  {b.items.find(x => x.kind === 'version') && <span className="ml-auto text-[11px] text-hv-text-3">firmware {b.items.find(x => x.kind === 'version')!.fw} · Cloud Connector {b.items.find(x => x.kind === 'version')!.cc}</span>}
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  {b.items.filter(x => x.kind !== 'version').map((x, j) => (
                    <React.Fragment key={j}>
                      {j > 0 && <ArrowRight size={11} className="text-hv-text-3" />}
                      <span title={fmtAt(x.t, tz)} className={cx('px-1.5 py-0.5 rounded-[3px] text-[10.5px] font-mono ring-1 ring-inset',
                        x.state === 'CLAIMED' ? 'bg-hv-success-tint ring-hv-success/40 text-hv-success-fg' : /FAIL|MISSING/.test(x.state) ? 'bg-hv-error-tint ring-hv-error/40 text-hv-error-fg' : 'bg-hv-surface ring-hv-line text-hv-text-2')}>
                        {x.state}
                      </span>
                    </React.Fragment>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </Section>
      {a.sync.length > 0 && (
        <Section title="Full syncs from OnCAFE" right={<span className="text-[11px] text-hv-text-3">SyncTiming.log · newest first</span>}>
          <div className="max-h-72 overflow-auto">
            <table className="w-full text-[12px]">
              <thead><tr className="text-left text-[11px] text-hv-text-3"><th className="py-1 pr-2">Started</th><th className="pr-2 text-right">Took</th><th className="pr-2">Slowest step</th><th className="pr-2">Steps</th><th>Failed</th></tr></thead>
              <tbody>{a.sync.slice().reverse().map((s, i) => (
                <tr key={i} className="border-t border-hv-line align-top">
                  <td className="py-1 pr-2 font-mono whitespace-nowrap">{fmtAt(s.t, tz)}</td>
                  <td className={cx('pr-2 text-right whitespace-nowrap', (s.ms || 0) > 30000 && 'text-hv-warning-fg')}>{s.finished ? fmtMs(s.ms) : <span className="text-hv-text-3">not finished</span>}</td>
                  <td className="pr-2 whitespace-nowrap">{s.slowest ? `${s.slowest.step} ${fmtMs(s.slowest.ms)}` : '—'}</td>
                  <td className="pr-2 text-hv-text-3">{s.steps.map(x => `${x.step} ${x.entries}`).join(' · ').slice(0, 140) || '—'}</td>
                  <td className={cx(s.fails.length > 0 && 'text-hv-error-fg')}>{s.fails.length ? s.fails.map(f => f.what).join(', ') : '—'}</td>
                </tr>))}</tbody>
            </table>
          </div>
        </Section>
      )}
      <Section title="Cloud, MQTT and event delivery"><FindingList items={cloud} tz={tz} empty="No cloud or delivery problems in this bundle." /></Section>
    </div>
  );
};

// ── Compare ───────────────────────────────────────────────────────────────────
export const CompareView: React.FC<{ scan: Scan; reports: Meta[]; api: AzureClient }> = ({ scan, reports, api }) => {
  const others = reports.filter(r => r.id !== scan.meta.id);
  const [bid, setBid] = useState<string>(others[0]?.id || '');
  const [b, setB] = useState<Scan | null>(null);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  useEffect(() => {
    if (!bid) { setB(null); return; }
    let live = true; setBusy(true); setErr('');
    api.report(bid).then(x => { if (live) setB(x); }).catch(e => live && setErr(e.message)).finally(() => live && setBusy(false));
    return () => { live = false; };
  }, [bid, api]);
  if (!others.length) return <div className="text-[13px] text-hv-text-3">Scan a second bundle (for example a working controller, or the same one after a fix) to compare.</div>;
  const A = scan;
  const key = (x: Board) => `${x.port}/${x.addr}`;
  const rows = b ? [...new Set([...A.azure.boards.map(key), ...b.azure.boards.map(key)])].sort().map(k => ({ k, a: A.azure.boards.find(x => key(x) === k), b: b.azure.boards.find(x => key(x) === k) })) : [];
  const fa = allFindings(A), fb = b ? allFindings(b) : [];
  const ida = new Set(fa.map(f => f.id)), idb = new Set(fb.map(f => f.id));
  const onlyA = fa.filter(f => !idb.has(f.id)), onlyB = fb.filter(f => !ida.has(f.id));
  const ctl: [string, (s: Scan) => string | null][] = [['Model', s => s.azure.controller.model], ['IC2 firmware', s => s.azure.controller.firmware], ['Cloud Connector', s => s.azure.controller.connector], ['Claim', s => s.azure.controller.claim], ['COM ports', s => s.azure.com.map(c => `${c.port} ${c.baud}`).join(', ')], ['Boards', s => String(s.azure.boards.length)]];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[12px] text-hv-text-3">A</span><b className="text-[13px] text-hv-text truncate max-w-[280px]">{A.meta.name}</b>
        <ArrowLeftRight size={14} className="text-hv-text-3" />
        <span className="text-[12px] text-hv-text-3">B</span>
        <Select value={bid} onChange={e => setBid(e.target.value)} className="max-w-[360px]">
          {others.map(r => <option key={r.id} value={r.id}>{r.name} · {new Date(r.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</option>)}
        </Select>
        {busy && <Loader2 size={14} className="animate-spin text-hv-text-3" />}
        {err && <span className="text-xs text-hv-error-fg">{err}</span>}
      </div>
      {b && (<>
        <Section title="Path">
          <div className="grid gap-1" style={{ gridTemplateColumns: 'minmax(140px,1fr) 90px 90px' }}>
            <span className="text-[11px] text-hv-text-3">Step</span><span className="text-[11px] text-hv-text-3">A</span><span className="text-[11px] text-hv-text-3">B</span>
            {A.azure.hops.map(h => { const hb = b.azure.hops.find(x => x.id === h.id); return (
              <React.Fragment key={h.id}>
                <span className="text-[12.5px] text-hv-text">{h.label}</span>
                <span><Badge tone={hopTone(h.status)}>{hopLabel(h.status)} {h.count || ''}</Badge></span>
                <span>{hb && <Badge tone={hopTone(hb.status)}>{hopLabel(hb.status)} {hb.count || ''}</Badge>}</span>
              </React.Fragment>); })}
          </div>
        </Section>
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))' }}>
          <Section title="Controller">
            <table className="w-full text-[12.5px]"><tbody>{ctl.map(([l, g]) => { const va = g(A), vb = g(b); return (
              <tr key={l} className="border-t border-hv-line first:border-0"><td className="py-1 pr-2 text-hv-text-3">{l}</td><td className="pr-2">{va || '—'}</td><td className={cx(va !== vb && 'text-hv-warning-fg font-semibold')}>{vb || '—'}</td></tr>); })}</tbody></table>
          </Section>
          <Section title="Boards (by COM port / address)">
            <table className="w-full text-[12px]">
              <thead><tr className="text-left text-[11px] text-hv-text-3"><th className="py-1 pr-2">Bus/addr</th><th className="pr-2">A</th><th>B</th></tr></thead>
              <tbody>{rows.map(r => {
                const cell = (x?: Board) => x ? <span>{x.model} <span className={cx(x.status === 'offline' ? 'text-hv-error-fg' : !x.status ? 'text-hv-warning-fg' : 'text-hv-text-3')}>{x.status || (x.lastEvent ? 'no saved status' : 'never reported')}</span>{x.offline ? <span className="text-hv-warning-fg"> · {x.offline} offline</span> : null}</span> : <span className="text-hv-text-3">—</span>;
                const diff = !r.a || !r.b || r.a.model !== r.b.model || r.a.status !== r.b.status;
                return <tr key={r.k} className={cx('border-t border-hv-line', diff && 'bg-hv-warning-tint')}><td className="py-1 pr-2 font-mono">{r.k}</td><td className="pr-2">{cell(r.a)}</td><td>{cell(r.b)}</td></tr>;
              })}</tbody>
            </table>
          </Section>
        </div>
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))' }}>
          <Section title={`Only in A (${onlyA.length})`}><FindingList items={onlyA} tz={A.report.zone?.tz} empty="Nothing that B does not also have." limit={25} /></Section>
          <Section title={`Only in B (${onlyB.length})`}><FindingList items={onlyB} tz={b.report.zone?.tz} empty="Nothing that A does not also have." limit={25} /></Section>
        </div>
      </>)}
    </div>
  );
};

