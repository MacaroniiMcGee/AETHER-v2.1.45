// Network traffic: received / sent per interface, from the backend's 2 s samples
// of /proc/net/dev (last 10 minutes). Two series, one axis (bytes/s), legend +
// end labels, crosshair tooltip.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { T, Card } from './ui';

const C_RX = 'rgb(var(--hv-info-strong))', C_TX = 'rgb(var(--hv-brand))';   // validated pair (dark surface)
type Sample = { t: number; ifaces: Record<string, { rx: number; tx: number }> };

const fmtRate = (b: number) => {
  const bits = b * 8;
  if (bits >= 1e9) return `${(bits / 1e9).toFixed(bits >= 1e10 ? 0 : 1)} Gb/s`;
  if (bits >= 1e6) return `${(bits / 1e6).toFixed(bits >= 1e7 ? 0 : 1)} Mb/s`;
  if (bits >= 1e3) return `${(bits / 1e3).toFixed(bits >= 1e4 ? 0 : 1)} kb/s`;
  return `${Math.round(bits)} b/s`;
};
const fmtTotal = (b: number) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
};
// "Nice" axis max in bytes/s so the ticks land on round bit rates
const niceMax = (b: number) => {
  const bits = Math.max(8000, b * 8 * 1.15);
  const p = Math.pow(10, Math.floor(Math.log10(bits)));
  const m = [1, 2, 2.5, 5, 10].find(k => k * p >= bits)! * p;
  return m / 8;
};

export default function TrafficChart({ api }: { api: string }) {
  const [samples, setSamples] = useState<Sample[]>([]);
  const [ifaces, setIfaces] = useState<string[]>([]);
  const [totals, setTotals] = useState<Record<string, { rx: number; tx: number }>>({});
  const [iface, setIface] = useState<string | null>(null);
  const [range, setRange] = useState(5);        // minutes
  const [hover, setHover] = useState<number | null>(null);
  const [err, setErr] = useState(false);
  const lastT = useRef(0);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const j = await (await fetch(`${api}/api/network/traffic?since=${lastT.current}`)).json();
        if (stop || !j.success) return;
        setErr(false);
        setIfaces(j.ifaces.filter((n: string) => (j.totals?.[n]?.rx || 0) + (j.totals?.[n]?.tx || 0) > 0)); setTotals(j.totals || {});
        if (j.samples.length) {
          lastT.current = j.samples[j.samples.length - 1].t;
          setSamples(prev => [...prev, ...j.samples].slice(-300));
        }
      } catch { if (!stop) setErr(true); }
    };
    tick(); const t = setInterval(tick, 2000);
    return () => { stop = true; clearInterval(t); };
  }, [api]);

  // Default to the busiest real interface (eth0 / wlan0 first)
  useEffect(() => {
    if (iface && ifaces.includes(iface)) return;
    const pref = ifaces.find(n => n === 'eth0') || ifaces.find(n => n.startsWith('wlan')) || ifaces[0];
    if (pref) setIface(pref);
  }, [ifaces, iface]);

  const data = useMemo(() => {
    if (!iface) return [];
    const from = Date.now() - range * 60000;
    return samples.filter(s => s.t >= from && s.ifaces[iface]).map(s => ({ t: s.t, rx: s.ifaces[iface].rx, tx: s.ifaces[iface].tx }));
  }, [samples, iface, range]);

  const stats = useMemo(() => {
    const f = (k: 'rx' | 'tx') => {
      const v = data.map(d => d[k]);
      return { now: v[v.length - 1] ?? 0, avg: v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0, peak: v.length ? Math.max(...v) : 0 };
    };
    return { rx: f('rx'), tx: f('tx') };
  }, [data]);

  // Geometry
  const W = 1000, H = 220, PL = 64, PR = 110, PT = 12, PB = 26;
  const iw = W - PL - PR, ih = H - PT - PB;
  const tEnd = Date.now(), tStart = tEnd - range * 60000;
  const yMax = niceMax(Math.max(stats.rx.peak, stats.tx.peak));
  const x = (t: number) => PL + ((t - tStart) / (tEnd - tStart)) * iw;
  const y = (v: number) => PT + ih - (v / yMax) * ih;
  const path = (k: 'rx' | 'tx') => data.map((d, i) => `${i ? 'L' : 'M'}${x(d.t).toFixed(1)},${y(d[k]).toFixed(1)}`).join('');
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => f * yMax);
  const stepS = range === 1 ? 15 : range === 5 ? 60 : 120, spanS = range * 60;
  const xTicks = Array.from({ length: spanS / stepS + 1 }, (_, i) => spanS - i * stepS);   // seconds ago
  const ago = (sec: number) => sec === 0 ? 'now' : sec < 60 ? `−${sec} s` : `−${sec / 60} min`;
  const last = data[data.length - 1];

  // End labels: keep them apart
  let ly = last ? { rx: y(last.rx), tx: y(last.tx) } : null;
  if (ly && Math.abs(ly.rx - ly.tx) < 16) { const mid = (ly.rx + ly.tx) / 2, up = ly.rx <= ly.tx; ly = { rx: mid + (up ? -8 : 8), tx: mid + (up ? 8 : -8) }; }

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!data.length) return;
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const t = tStart + ((px - PL) / iw) * (tEnd - tStart);
    let best = 0, bd = Infinity;
    data.forEach((d, i) => { const dd = Math.abs(d.t - t); if (dd < bd) { bd = dd; best = i; } });
    setHover(px >= PL - 4 && px <= PL + iw + 4 && bd < 5000 ? best : null);
  };
  const h = hover != null ? data[hover] : null;

  return (
    <Card title="Traffic" right={
      <div className="flex items-center gap-2">
        <div className="inline-flex p-0.5 rounded-md" style={{ background: T.input }}>
          {ifaces.map(n => (
            <button key={n} onClick={() => setIface(n)} className="px-2.5 py-1 rounded text-xs font-semibold font-mono"
              style={iface === n ? { background: 'rgb(var(--hv-popup-panel))', color: T.text } : { color: T.dim }}>{n}</button>
          ))}
        </div>
        <div className="inline-flex p-0.5 rounded-md" style={{ background: T.input }}>
          {[1, 5, 10].map(m => (
            <button key={m} onClick={() => setRange(m)} className="px-2.5 py-1 rounded text-xs font-semibold"
              style={range === m ? { background: 'rgb(var(--hv-popup-panel))', color: T.text } : { color: T.dim }}>{m} min</button>
          ))}
        </div>
      </div>
    }>
      {err && !samples.length ? <p className="text-sm" style={{ color: T.dim }}>Traffic data isn't available (backend not reachable).</p> : (<>
        {/* Legend with the numbers (identity never by colour alone) */}
        <div className="flex flex-wrap gap-x-8 gap-y-2 mb-2 text-xs">
          {([['rx', 'Received', C_RX, '↓'], ['tx', 'Sent', C_TX, '↑']] as const).map(([k, label, c, arrow]) => (
            <div key={k} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="flex items-center gap-2 whitespace-nowrap">
                <span className="w-4 h-[3px] rounded-full" style={{ background: c }} />
                <span className="font-semibold" style={{ color: T.text }}>{arrow} {label}</span>
                <span className="font-mono" style={{ color: T.text }}>{fmtRate(stats[k].now)}</span>
              </span>
              <span className="whitespace-nowrap" style={{ color: T.dim }}>avg {fmtRate(stats[k].avg)} · peak {fmtRate(stats[k].peak)}</span>
              {iface && totals[iface] && <span className="whitespace-nowrap" style={{ color: T.dim }}>· {fmtTotal(totals[iface][k])} since boot</span>}
            </div>
          ))}
        </div>

        <div className="relative">
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" onMouseMove={onMove} onMouseLeave={() => setHover(null)}
            role="img" aria-label={`${iface || ''} traffic over the last ${range} minutes: received now ${fmtRate(stats.rx.now)}, peak ${fmtRate(stats.rx.peak)}; sent now ${fmtRate(stats.tx.now)}, peak ${fmtRate(stats.tx.peak)}`}>
            {ticks.map((v, i) => (
              <g key={i}>
                <line x1={PL} x2={PL + iw} y1={y(v)} y2={y(v)} stroke={i ? 'rgb(var(--hv-popup-panel))' : 'rgb(var(--hv-line))'} strokeWidth={1} />
                <text x={PL - 8} y={y(v) + 4} textAnchor="end" fontSize={11} fill={T.dim}>{fmtRate(v)}</text>
              </g>
            ))}
            {xTicks.map(sec => (
              <text key={sec} x={x(tEnd - sec * 1000)} y={H - 6} textAnchor={sec === spanS ? 'start' : sec === 0 ? 'end' : 'middle'} fontSize={11} fill={T.dim}>{ago(sec)}</text>
            ))}
            {data.length > 1 && (<>
              <path d={path('rx')} fill="none" stroke={C_RX} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              <path d={path('tx')} fill="none" stroke={C_TX} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            </>)}
            {last && ly && (<>
              <circle cx={x(last.t)} cy={y(last.rx)} r={4} fill={C_RX} stroke="rgb(var(--hv-widget-panel))" strokeWidth={2} />
              <circle cx={x(last.t)} cy={y(last.tx)} r={4} fill={C_TX} stroke="rgb(var(--hv-widget-panel))" strokeWidth={2} />
              <text x={x(last.t) + 10} y={ly.rx + 4} fontSize={11} fill={T.text}>↓ {fmtRate(last.rx)}</text>
              <text x={x(last.t) + 10} y={ly.tx + 4} fontSize={11} fill={T.text}>↑ {fmtRate(last.tx)}</text>
            </>)}
            {h && (<>
              <line x1={x(h.t)} x2={x(h.t)} y1={PT} y2={PT + ih} stroke={T.dim} strokeDasharray="3 3" />
              <circle cx={x(h.t)} cy={y(h.rx)} r={4} fill={C_RX} stroke="rgb(var(--hv-widget-panel))" strokeWidth={2} />
              <circle cx={x(h.t)} cy={y(h.tx)} r={4} fill={C_TX} stroke="rgb(var(--hv-widget-panel))" strokeWidth={2} />
            </>)}
            {data.length < 2 && <text x={PL + iw / 2} y={PT + ih / 2} textAnchor="middle" fontSize={13} fill={T.dim}>Collecting samples…</text>}
          </svg>
          {h && (
            <div className="absolute top-2 px-2.5 py-1.5 rounded-md text-xs pointer-events-none"
              style={{ left: `${(x(h.t) / W) * 100}%`, transform: `translateX(${x(h.t) > W * 0.7 ? '-105%' : '8%'})`, background: 'rgb(var(--hv-surface))', border: `1px solid ${T.line2}`, color: T.text }}>
              <div className="font-mono mb-0.5" style={{ color: T.dim }}>{new Date(h.t).toLocaleTimeString()}</div>
              <div className="flex items-center gap-1.5"><span className="w-2.5 h-[3px] rounded-full" style={{ background: C_RX }} />↓ {fmtRate(h.rx)}</div>
              <div className="flex items-center gap-1.5"><span className="w-2.5 h-[3px] rounded-full" style={{ background: C_TX }} />↑ {fmtRate(h.tx)}</div>
            </div>
          )}
        </div>
      </>)}
    </Card>
  );
}
