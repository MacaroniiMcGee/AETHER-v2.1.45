// AETHER_TRACE (TRACE-5) — one view over runs from several Aether Pis (the cluster gateway reaches enrolled Pis at
// /n/<host>:<port>/..., one sign-in). Pick runs from any Pi; their traces are merged into one table, tagged with the
// Pi, with totals per Pi. Each Pi keeps its own clock (they are NTP-synced); controller hops were already corrected
// by each Pi's own sync markers.
import React, { useEffect, useMemo, useState } from 'react';
import { Layers, Loader2, X } from 'lucide-react';
import { Badge, Button, Empty, Toggle, cx } from '../sunapi/ui';
import { traceClient, fmtMs, clock, credText, type Analysis, type RunMeta, type Trace } from './api';
import { statusTone } from './views';

interface PiNode { key: string; name: string; base: string }
const pct = (a: number[], p: number) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

export const ClusterRuns: React.FC<{ backend: string; onClose: () => void }> = ({ backend, onClose }) => {
  const [pis, setPis] = useState<PiNode[] | null>(null);
  const [runs, setRuns] = useState<Record<string, RunMeta[] | string>>({});
  const [picked, setPicked] = useState<Record<string, string>>({});   // `${pi}|${runId}` -> pi key
  const [merged, setMerged] = useState<{ pi: PiNode; a: Analysis }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [onlyBad, setOnlyBad] = useState(false);
  useEffect(() => {
    (async () => {
      const self: PiNode = { key: 'self', name: 'This Pi', base: backend };
      let list: PiNode[] = [self];
      try {
        const r = await fetch(`${backend}/api/cluster/nodes`, { credentials: 'include' });
        if (r.ok) { const j = await r.json(); if (j && j.self && j.self.name) self.name = j.self.name; list = [self, ...((j && j.nodes) || []).map((n: { key: string; name: string }) => ({ key: n.key, name: n.name || n.key, base: `${backend}/n/${n.key}` }))]; }
      } catch { /* no cluster on this Pi: just this one */ }
      setPis(list);
      for (const p of list) traceClient(p.base).runs().then(r => setRuns(x => ({ ...x, [p.key]: r.runs.slice(0, 25) }))).catch(e => setRuns(x => ({ ...x, [p.key]: (e as Error).message })));
    })();
  }, [backend]);
  const combine = async () => {
    setBusy(true);
    try {
      const sel = Object.entries(picked);
      const out = await Promise.all(sel.map(async ([k, piKey]) => { const pi = pis!.find(p => p.key === piKey)!; const id = k.split('|')[1]; return { pi, a: await traceClient(pi.base).run(id) }; }));
      setMerged(out); setErr(null);
    } catch (e) { setErr(`Could not load a run: ${(e as Error).message}`); } finally { setBusy(false); }
  };
  const rows = useMemo(() => (merged || []).flatMap(m => m.a.traces.filter(t => !t.sync).map(t => ({ pi: m.pi, run: m.a.meta?.name || '', t }))).sort((x, y) => x.t.at - y.t.at), [merged]);
  const perPi = useMemo(() => (merged || []).map(m => {
    const r = m.a.traces.filter(t => !t.sync);
    return { pi: m.pi, run: m.a.meta?.name || '', n: r.length, pass: r.filter(t => t.status === 'pass').length, warn: r.filter(t => t.status === 'warn').length, fail: r.filter(t => t.status === 'fail').length,
      decision: pct(r.map(t => t.latency.decision).filter((v): v is number => v != null), 0.5), push: pct(r.map(t => t.latency.push).filter((v): v is number => v != null), 0.5), offset: m.a.clock.offset };
  }), [merged]);
  const all = rows.map(r => r.t);
  const tot = { n: all.length, fail: all.filter(t => t.status === 'fail').length, warn: all.filter(t => t.status === 'warn').length,
    push50: pct(all.map(t => t.latency.push).filter((v): v is number => v != null), 0.5), push95: pct(all.map(t => t.latency.push).filter((v): v is number => v != null), 0.95) };
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-hv-line">
        <Layers size={14} className="text-hv-text-3" /><span className="text-sm font-semibold text-hv-text">Runs on several Pis</span>
        <span className="text-xs text-hv-text-3">Pick runs from any Aether Pi in the cluster and see them as one.</span>
        <span className="ml-auto" />
        <Button size="sm" tone="primary" busy={busy} disabled={!Object.keys(picked).length} onClick={combine}>Combine {Object.keys(picked).length || ''}</Button>
        <Button size="sm" tone="ghost" icon={<X size={13} />} onClick={onClose}>Close</Button>
      </div>
      <div className="flex-1 min-h-0 flex">
        <div className="w-[300px] shrink-0 border-r border-hv-line overflow-auto">
          {!pis ? <div className="p-3 text-xs text-hv-text-3 flex items-center gap-2"><Loader2 size={12} className="animate-spin" />Finding Pis…</div> : pis.map(p => (
            <div key={p.key} className="border-b border-hv-line">
              <div className="px-3 pt-2 pb-1 text-[11px] font-semibold text-hv-text-2 uppercase tracking-wide">{p.name}{p.key !== 'self' ? <span className="ml-1 normal-case font-normal text-hv-text-3">{p.key}</span> : null}</div>
              {typeof runs[p.key] === 'string' ? <div className="px-3 pb-2 text-[11px] text-hv-error-fg">{runs[p.key] as string}</div>
                : !runs[p.key] ? <div className="px-3 pb-2 text-[11px] text-hv-text-3">Loading…</div>
                : !(runs[p.key] as RunMeta[]).length ? <div className="px-3 pb-2 text-[11px] text-hv-text-3">No runs</div>
                : (runs[p.key] as RunMeta[]).map(r => { const k = `${p.key}|${r.id}`; return (
                  <label key={k} className={cx('flex items-start gap-2 px-3 py-1 text-[12px] cursor-pointer', picked[k] ? 'bg-hv-brand-tint' : 'hover:bg-hv-widget')}>
                    <input type="checkbox" className="mt-0.5" checked={!!picked[k]} onChange={e => setPicked(x => { const n = { ...x }; if (e.target.checked) n[k] = p.key; else delete n[k]; return n; })} />
                    <span className="min-w-0"><span className="block truncate text-hv-text">{r.name}</span><span className="text-hv-text-3">{new Date(r.start).toLocaleString()}{r.count != null ? ` · ${r.count} events` : ''}</span></span>
                  </label>); })}
            </div>
          ))}
        </div>
        <div className="flex-1 min-w-0 overflow-auto p-3 space-y-3">
          {err && <div className="text-xs text-hv-error-fg">{err}</div>}
          {!merged ? <Empty icon={<Layers size={24} />} title="Pick runs, then Combine">Runs recorded at the same time on different Pis line up on one timeline (the Pis keep NTP time).</Empty> : (
            <>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Badge tone={tot.fail ? 'error' : tot.warn ? 'warning' : 'success'}>{tot.n} traced · {tot.fail} fail · {tot.warn} warn</Badge>
                <span className="text-hv-text-3">cloud push p50 {fmtMs(tot.push50)} · p95 {fmtMs(tot.push95)}</span>
                <span className="ml-auto" /><Toggle on={onlyBad} onChange={setOnlyBad} label="Only problems" />
              </div>
              <table className="w-full text-[12px]"><thead><tr className="text-left text-hv-text-3"><th className="py-1 pr-2">Pi</th><th className="pr-2">Run</th><th className="pr-2">Traced</th><th className="pr-2">Fail</th><th className="pr-2">Warn</th><th className="pr-2">Decision p50</th><th className="pr-2">Push p50</th><th className="pr-2">Controller clock</th></tr></thead><tbody>
                {perPi.map((x, i) => <tr key={i} className="border-t border-hv-line"><td className="py-1 pr-2 text-hv-text">{x.pi.name}</td><td className="pr-2 text-hv-text-2">{x.run}</td><td className="pr-2">{x.n}</td><td className={cx('pr-2', x.fail ? 'text-hv-error-fg font-semibold' : '')}>{x.fail}</td><td className="pr-2">{x.warn}</td><td className="pr-2 font-mono">{fmtMs(x.decision)}</td><td className="pr-2 font-mono">{fmtMs(x.push)}</td><td className="pr-2 font-mono">{x.offset == null ? 'unknown' : `${x.offset >= 0 ? '+' : ''}${fmtMs(x.offset)}`}</td></tr>)}
              </tbody></table>
              <table className="w-full text-[12px]"><thead><tr className="text-left text-hv-text-3"><th className="py-1 pr-2 w-[100px]">Time</th><th className="pr-2">Pi</th><th className="pr-2">What happened</th><th className="pr-2">Controller</th><th className="pr-2">Decision</th><th className="pr-2">Push</th><th className="pr-2">Why</th></tr></thead><tbody>
                {rows.filter(r => !onlyBad || r.t.status !== 'pass').slice(0, 2000).map((r, i) => <Row key={i} pi={r.pi.name} t={r.t} />)}
              </tbody></table>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
const Row: React.FC<{ pi: string; t: Trace }> = ({ pi, t }) => (
  <tr className="border-t border-hv-line">
    <td className="py-1 pr-2 font-mono text-hv-text-3">{clock(t.at)}</td>
    <td className="pr-2 text-hv-text-2">{pi}</td>
    <td className="pr-2 text-hv-text">{t.kind === 'card' && t.action.cred ? `Card ${credText(t.action.cred)}` : t.action.label}</td>
    <td className="pr-2">{t.result ? <Badge tone={statusTone(t.status)}>{t.result}</Badge> : <span className="text-hv-text-3">—</span>}{t.decision?.door?.name ? <span className="ml-1 text-hv-text-3">{t.decision.door.name}</span> : null}</td>
    <td className="pr-2 font-mono">{fmtMs(t.latency.decision)}</td><td className="pr-2 font-mono">{fmtMs(t.latency.push)}</td>
    <td className="pr-2 text-hv-text-3">{t.notes[0] || ''}</td>
  </tr>
);
