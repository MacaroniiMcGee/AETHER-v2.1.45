// AETHER_SUNAPI — Snapshots: read every "view" on a device (or many), save it, compare two captures.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Camera, Trash2, GitCompare, Download, Loader2, Square } from 'lucide-react';
import type { Catalog } from './catalog';
import { buildQuery, flatBody } from './catalog';
import type { Client, Device, Snapshot, SnapshotEntry, SnapshotMeta } from './api';
import { ResponseView } from './ResponseView';
import { Badge, Button, Empty, Input, Segmented, cx, download, fmtTime } from './ui';
import { KindIcon } from './kinds';

// Views that stream, return binaries, or are slow and add nothing to a config comparison.
const SKIP = new Set(['video/snapshot', 'eventstatus/eventstatus', 'recording/timeline', 'recording/calendarsearch', 'system/systemlog', 'system/accesslog', 'system/eventlog']);

export const Snapshots: React.FC<{ catalog: Catalog | null; device: Device | null; fleet: Device[]; devices: Device[]; online: boolean; api: Client }> = ({ catalog, device, fleet, devices, online, api }) => {
  const multi = fleet.length > 1;
  const [scope, setScope] = useState<'this' | 'all'>(() => (multi ? 'all' : 'this'));
  const [list, setList] = useState<SnapshotMeta[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [loaded, setLoaded] = useState<Record<string, Snapshot>>({});
  const [name, setName] = useState('');
  const [run, setRun] = useState<null | { done: number; total: number; current: string; failed: number }>(null);
  const [err, setErr] = useState<string | null>(null);
  const stop = useRef(false);

  const targets = useMemo(() => catalog ? catalog.cgis.flatMap(c => c.submenus.filter(s => s.actions.some(a => a.name === 'view') && !SKIP.has(`${c.name}/${s.name}`)).map(s => ({ cgi: c.name, sub: s })) ) : [], [catalog]);

  const refresh = () => api.snapshots(scope === 'this' ? device?.id : undefined).then(setList).catch(e => setErr(e.message));
  useEffect(() => { setPicked([]); refresh(); }, [device?.id, scope]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    for (const id of picked) if (!loaded[id]) api.snapshot(id).then(s => setLoaded(o => ({ ...o, [id]: s }))).catch(e => setErr(e.message));
  }, [picked]); // eslint-disable-line react-hooks/exhaustive-deps

  // Many devices: each menu goes out as one multi-device request; models without it are skipped.
  const captureFleet = async () => {
    stop.current = false; setErr(null);
    const per: Record<string, Record<string, SnapshotEntry>> = Object.fromEntries(fleet.map(d => [d.id, {}]));
    const t0 = Date.now(); let i = 0; let failed = 0;
    setRun({ done: 0, total: targets.length, current: '', failed: 0 });
    const worker = async () => {
      while (i < targets.length && !stop.current) {
        const t = targets[i++];
        const id = `${t.cgi}/${t.sub.name}`;
        setRun(r => r && { ...r, current: id });
        try {
          const r = await api.batch({ deviceIds: fleet.map(d => d.id), path: `/stw-cgi/${t.cgi}.cgi`, query: buildQuery(t.sub, 'view', {}), accept: 'json', history: false, timeoutMs: 20000 });
          for (const it of r.results) {
            if (it.skipped) continue;
            per[it.deviceId][id] = it.result ? { status: it.result.status, body: it.result.bodyEncoding === 'utf8' ? it.result.body : `(${it.result.contentType}, ${it.result.bytes} bytes)`, ms: it.result.ms } : { status: 0, error: it.error };
            if (!it.result || it.result.status !== 200) failed++;
          }
        } catch (e) { failed++; setErr((e as Error).message); }
        setRun(r => r && { ...r, done: r.done + 1, failed });
      }
    };
    await Promise.all([worker(), worker()]);
    const label = name.trim() || (stop.current ? 'Partial capture' : `Capture ${new Date().toLocaleString()}`);
    const saved: string[] = [];
    for (const d of fleet) {
      if (!Object.keys(per[d.id]).length) continue;
      try { saved.push((await api.saveSnapshot({ deviceId: d.id, name: label, model: d.model, firmware: d.firmware, ms: Date.now() - t0, results: per[d.id] })).id); } catch (e) { setErr((e as Error).message); }
    }
    setName(''); setScope('all'); await api.snapshots().then(setList).catch(() => {});
    setPicked(saved.slice(0, 2));
    setRun(null);
  };

  const capture = async () => {
    if (multi) return captureFleet();
    if (!device) return;
    stop.current = false; setErr(null);
    const results: Record<string, SnapshotEntry> = {};
    const t0 = Date.now(); let i = 0; let failed = 0;
    setRun({ done: 0, total: targets.length, current: '', failed: 0 });
    const worker = async () => {
      while (i < targets.length && !stop.current) {
        const t = targets[i++];
        const id = `${t.cgi}/${t.sub.name}`;
        setRun(r => r && { ...r, current: id });
        try {
          const r = await api.request(device.id, { path: `/stw-cgi/${t.cgi}.cgi`, query: buildQuery(t.sub, 'view', {}), accept: 'json', history: false, timeoutMs: 20000 });
          results[id] = { status: r.status, body: r.bodyEncoding === 'utf8' ? r.body : `(${r.contentType}, ${r.bytes} bytes)`, ms: r.ms };
          if (r.status !== 200) failed++;
        } catch (e) { results[id] = { status: 0, error: (e as Error).message }; failed++; }
        setRun(r => r && { ...r, done: r.done + 1, failed });
      }
    };
    await Promise.all([worker(), worker()]);   // two at a time — devices dislike bursts
    if (stop.current && !Object.keys(results).length) { setRun(null); return; }
    try {
      const meta = await api.saveSnapshot({ deviceId: device.id, name: name.trim() || (stop.current ? 'Partial capture' : `Capture ${new Date().toLocaleString()}`), model: device.model, firmware: device.firmware, ms: Date.now() - t0, results });
      setName(''); await refresh();
      setPicked(p => [meta.id, ...p].slice(0, 2));
    } catch (e) { setErr((e as Error).message); }
    setRun(null);
  };

  const togglePick = (id: string) => setPicked(p => (p.includes(id) ? p.filter(x => x !== id) : [id, ...p].slice(0, 2)));
  const a = picked[1] ? loaded[picked[1]] : undefined;   // older pick = A
  const b = picked[0] ? loaded[picked[0]] : undefined;
  const [A, B] = a && b && a.createdAt > b.createdAt ? [b, a] : [a, b];

  return (
    <div className="flex h-full min-h-0">
      <aside className="w-[320px] shrink-0 border-r border-hv-line flex flex-col min-h-0">
        <div className="p-4 border-b border-hv-line space-y-2.5">
          <div className="text-sm font-bold text-hv-text">Capture every view</div>
          <p className="text-xs text-hv-text-3 leading-relaxed">Reads {targets.length} read-only menus on {multi ? `${fleet.length} devices at once` : device?.name || 'the device'} and saves the answers on the Pi. Capture before and after a firmware or config change — or capture two devices and compare them to each other.</p>
          <Input value={name} onChange={e => setName(e.target.value)} placeholder="Name (e.g. Before FW 2.22)" disabled={!!run} />
          {run ? (
            <div className="space-y-1.5">
              <div className="h-1.5 rounded-full bg-hv-box overflow-hidden"><div className="h-full bg-hv-brand transition-all" style={{ width: `${(run.done / Math.max(1, run.total)) * 100}%` }} /></div>
              <div className="flex items-center gap-2 text-[11px] text-hv-text-3">
                <Loader2 size={12} className="animate-spin" /><span className="font-mono truncate flex-1">{run.current}</span>
                <span>{run.done}/{run.total}{run.failed ? ` · ${run.failed} failed` : ''}</span>
              </div>
              <Button size="sm" tone="ghost" icon={<Square size={12} />} onClick={() => { stop.current = true; }}>Stop and save what I have</Button>
            </div>
          ) : (
            <Button tone="primary" icon={<Camera size={15} />} disabled={!device || !online || !targets.length} onClick={capture} className="w-full">{multi ? `Capture ${fleet.length} devices` : 'Capture now'}</Button>
          )}
          {err && <div className="text-xs text-hv-error-fg">{err}</div>}
        </div>
        <div className="px-4 pt-3 pb-1 flex items-center text-[11px] font-bold uppercase tracking-wide text-hv-text-3">
          Saved<span className="ml-auto normal-case font-normal tracking-normal"><Segmented value={scope} onChange={setScope} items={[{ id: 'this', label: 'This device' }, { id: 'all', label: 'All devices' }]} /></span>
        </div>
        <div className="flex-1 min-h-0 overflow-auto px-2 pb-3">
          {!list.length && <div className="text-xs text-hv-text-3 px-2 py-4">No captures yet. Pick two to compare.</div>}
          {list.map(s => {
            const on = picked.includes(s.id);
            return (
              <div key={s.id} className={cx('group flex items-start gap-2.5 px-2 py-2 rounded-hv-xs cursor-pointer', on ? 'bg-hv-brand-tint' : 'hover:bg-hv-widget')} onClick={() => togglePick(s.id)}>
                <input type="checkbox" readOnly checked={on} className="mt-1 accent-[rgb(var(--hv-brand))]" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-hv-text truncate">{s.name}</div>
                  {scope === 'all' && <div className="text-[11px] text-hv-text-2 truncate flex items-center gap-1"><KindIcon kind={devices.find(d => d.id === s.deviceId)?.kind} size={11} className="text-hv-text-3" />{s.deviceName || 'removed device'}</div>}
                  <div className="text-[11px] text-hv-text-3">{fmtTime(s.createdAt)} · {s.count} menus{s.failed ? ` · ${s.failed} failed` : ''}</div>
                  {s.firmware && <div className="text-[11px] text-hv-text-3 font-mono truncate">{s.firmware}</div>}
                </div>
                <button title="Delete" className="opacity-0 group-hover:opacity-100 text-hv-text-3 hover:text-hv-error-fg mt-0.5" onClick={e => { e.stopPropagation(); if (window.confirm(`Delete “${s.name}”?`)) api.removeSnapshot(s.id).then(() => { setPicked(p => p.filter(x => x !== s.id)); refresh(); }); }}><Trash2 size={14} /></button>
              </div>
            );
          })}
        </div>
      </aside>
      <div className="flex-1 min-w-0 min-h-0">
        {picked.length === 0 && <Empty icon={<GitCompare size={28} />} title="Nothing selected">Pick one capture to browse it, or two to see every field that changed between them.</Empty>}
        {picked.length === 1 && b && <Browse s={b} />}
        {picked.length === 2 && A && B && <Compare a={A} b={B} />}
        {picked.length > 0 && picked.some(id => !loaded[id]) && <div className="p-6 text-sm text-hv-text-3 flex items-center gap-2"><Loader2 size={14} className="animate-spin" />Loading…</div>}
      </div>
    </div>
  );
};

const Browse: React.FC<{ s: Snapshot }> = ({ s }) => {
  const keys = Object.keys(s.results).sort();
  const [sel, setSel] = useState(keys[0]);
  const r = s.results[sel];
  return (
    <div className="flex h-full min-h-0">
      <div className="w-[240px] shrink-0 border-r border-hv-line overflow-auto py-2 px-2">
        {keys.map(k => (
          <button key={k} onClick={() => setSel(k)} className={cx('w-full flex items-center gap-2 px-2 h-7 rounded-hv-xs text-left text-[12.5px] font-mono', sel === k ? 'bg-hv-brand-tint text-hv-text' : 'text-hv-text-2 hover:bg-hv-widget')}>
            <span className="truncate flex-1">{k}</span>
            {s.results[k].status !== 200 && <span className="w-1.5 h-1.5 rounded-full bg-hv-error shrink-0" />}
          </button>
        ))}
      </div>
      <div className="flex-1 min-w-0">{r && <ResponseView r={{ status: r.status, body: r.body || '', error: r.error, ms: r.ms }} fileBase={`${s.name}-${sel}`.replace(/[^\w.-]+/g, '_')} />}</div>
    </div>
  );
};

type Row = { ep: string; field: string; a?: string; b?: string; kind: 'changed' | 'added' | 'removed' };

const Compare: React.FC<{ a: Snapshot; b: Snapshot }> = ({ a, b }) => {
  // captures from one multi-device run share a name — label by device instead
  const la = a.name === b.name && a.deviceId !== b.deviceId ? a.deviceName : a.name;
  const lb = a.name === b.name && a.deviceId !== b.deviceId ? b.deviceName : b.name;
  const [mode, setMode] = useState<'changes' | 'all'>('changes');
  const [filter, setFilter] = useState('');
  const { rows, endpoints, summary } = useMemo(() => {
    const rows: Row[] = []; const eps = new Set([...Object.keys(a.results), ...Object.keys(b.results)]);
    const endpoints: { ep: string; status: 'same' | 'changed' | 'only-a' | 'only-b' | 'error'; n: number }[] = [];
    for (const ep of [...eps].sort()) {
      const ra = a.results[ep]; const rb = b.results[ep];
      if (!ra || !rb) { endpoints.push({ ep, status: ra ? 'only-a' : 'only-b', n: 0 }); continue; }
      if (ra.status !== 200 || rb.status !== 200) {
        endpoints.push({ ep, status: ra.status !== rb.status ? 'changed' : 'error', n: ra.status !== rb.status ? 1 : 0 });
        if (ra.status !== rb.status) rows.push({ ep, field: '(HTTP status)', a: String(ra.status), b: String(rb.status), kind: 'changed' });
        continue;
      }
      const fa = flatBody(ra.body || ''); const fb = flatBody(rb.body || '');
      let n = 0;
      for (const f of new Set([...Object.keys(fa), ...Object.keys(fb)])) {
        if (fa[f] === fb[f]) continue;
        n++; rows.push({ ep, field: f, a: fa[f], b: fb[f], kind: fa[f] === undefined ? 'added' : fb[f] === undefined ? 'removed' : 'changed' });
      }
      endpoints.push({ ep, status: n ? 'changed' : 'same', n });
    }
    const summary = { menus: endpoints.length, changedMenus: endpoints.filter(e => e.status === 'changed').length, fields: rows.length, added: rows.filter(r => r.kind === 'added').length, removed: rows.filter(r => r.kind === 'removed').length };
    return { rows, endpoints, summary };
  }, [a, b]);

  const f = filter.toLowerCase();
  const shown = rows.filter(r => !f || r.ep.includes(f) || r.field.toLowerCase().includes(f) || (r.a || '').toLowerCase().includes(f) || (r.b || '').toLowerCase().includes(f));
  const byEp = shown.reduce<Record<string, Row[]>>((m, r) => { (m[r.ep] ||= []).push(r); return m; }, {});

  const exportCsv = () => {
    const esc = (s?: string) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const lines = [['Menu', 'Field', 'Change', la, lb].map(esc).join(',')];
    for (const r of rows) lines.push([r.ep, r.field, r.kind, r.a, r.b].map(esc).join(','));
    download(`sunapi-compare-${la}-vs-${lb}.csv`.replace(/[^\w.-]+/g, '_'), lines.join('\r\n'), 'text/csv');
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-5 py-3 border-b border-hv-line">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="min-w-0">
            <div className="text-sm text-hv-text"><b>{a.name}</b>{a.deviceId !== b.deviceId && <span className="text-hv-text-3"> · {a.deviceName}</span>} <span className="text-hv-text-3">→</span> <b>{b.name}</b>{a.deviceId !== b.deviceId && <span className="text-hv-text-3"> · {b.deviceName}</span>}</div>
            <div className="text-[11px] text-hv-text-3">{fmtTime(a.createdAt)} → {fmtTime(b.createdAt)}{a.firmware !== b.firmware && a.firmware && b.firmware ? ` · firmware ${a.firmware} → ${b.firmware}` : ''}</div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter" className="w-44 h-7 text-xs" />
            <Segmented value={mode} onChange={setMode} items={[{ id: 'changes', label: 'Changes' }, { id: 'all', label: 'All menus' }]} />
            <Button size="sm" icon={<Download size={13} />} onClick={exportCsv} disabled={!rows.length}>CSV</Button>
          </div>
        </div>
        <div className="flex gap-2 mt-2.5 flex-wrap">
          <Badge tone={summary.changedMenus ? 'warning' : 'success'}>{summary.changedMenus} of {summary.menus} menus differ</Badge>
          <Badge>{summary.fields} fields</Badge>
          {summary.added > 0 && <Badge tone="success">+{summary.added} new</Badge>}
          {summary.removed > 0 && <Badge tone="error">−{summary.removed} gone</Badge>}
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-auto px-5 py-4">
        {mode === 'all' ? (
          <table className="w-full text-[13px]">
            <tbody>{endpoints.filter(e => !f || e.ep.includes(f)).map(e => (
              <tr key={e.ep} className="border-b border-hv-line/60">
                <td className="py-1.5 font-mono text-[12.5px] text-hv-text-2">{e.ep}</td>
                <td className="py-1.5 text-right">
                  {e.status === 'same' && <Badge tone="success">same</Badge>}
                  {e.status === 'changed' && <Badge tone="warning">{e.n} changed</Badge>}
                  {e.status === 'error' && <Badge tone="neutral">no answer in both</Badge>}
                  {e.status === 'only-a' && <Badge tone="error">only in {la}</Badge>}
                  {e.status === 'only-b' && <Badge tone="info">only in {lb}</Badge>}
                </td>
              </tr>
            ))}</tbody>
          </table>
        ) : !shown.length ? (
          <Empty title={rows.length ? 'No changes match the filter' : 'Identical'}>{rows.length ? '' : `Every field in ${summary.menus} menus is the same in both captures.`}</Empty>
        ) : (
          <div className="space-y-5">
            {Object.entries(byEp).map(([ep, rs]) => (
              <section key={ep}>
                <div className="flex items-center gap-2 mb-1.5"><h4 className="font-mono text-xs font-bold text-hv-text">{ep}</h4><span className="text-[11px] text-hv-text-3">{rs.length}</span></div>
                <div className="rounded-hv-xs ring-1 ring-inset ring-hv-line overflow-hidden">
                  <table className="w-full text-[12.5px] table-fixed">
                    <colgroup><col className="w-[38%]" /><col /><col /></colgroup>
                    <thead><tr className="bg-hv-widget text-left text-[11px] text-hv-text-3">
                      <th className="px-3 py-1 font-semibold">Field</th><th className="px-3 py-1 font-semibold truncate">{la}</th><th className="px-3 py-1 font-semibold truncate">{lb}</th>
                    </tr></thead>
                    <tbody>{rs.map(r => (
                      <tr key={r.field} className="border-t border-hv-line/60 align-top">
                        <td className="px-3 py-1.5 font-mono text-[12px] text-hv-text-2 break-all">{r.field}</td>
                        <td className={cx('px-3 py-1.5 font-mono break-all', r.kind === 'added' ? 'text-hv-text-disabled' : 'text-hv-error-fg bg-hv-error-tint/40')}>{r.a ?? '—'}</td>
                        <td className={cx('px-3 py-1.5 font-mono break-all', r.kind === 'removed' ? 'text-hv-text-disabled' : 'text-hv-success-fg bg-hv-success-tint/40')}>{r.b ?? '—'}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

