// AETHER_TRACE (TRACE-3) — Event Trace on the Doors page.
//   DoorTracePairing  Settings › Basic: which OnCAFE door this Aether door is wired to, plus a description.
//                     Saved with the door; Event Trace's wiring map follows (and can change it back: last save wins).
//   DoorTraceStrip    on each door card: the OnCAFE pairing, the description and the latest traced card / DPS /
//                     strike / command for this door, from /api/trace/doors (one shared poll for all cards).
import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { Activity, CheckCircle2, AlertTriangle, XCircle, Link2, Link2Off } from 'lucide-react';
import { defaultBackend, fmtMs, type Status } from './api';

interface Brief { at: number; status: 'pass' | 'warn' | 'fail'; label: string; result: string | null; notes: string[]; push: number | null; decision: number | null; output: number | null; hardware: number | null; held: number | null; cause: string | null }
interface DoorSum {
  id: number; name: string; enabled: boolean; ioSource: string; oncafe: { id: string; name: string | null } | null; note: string; updatedAt: string | null; by: string | null;
  channels: { key: string; role: string | null; label: string; overridden: boolean }[]; grantMs: number | null;
  counts: { pass: number; warn: number; fail: number }; last: { card: Brief | null; input: Brief | null; output: Brief | null; command: Brief | null };
}
interface Summary { doors: DoorSum[]; run: { id: string; name: string } | null; sync: { by: string; at: number } | null; configSavedAt: string | null; error?: string }

// ── one poll for every door card on the page ─────────────────────────────
const store = (() => {
  let data: Summary | null = null;
  let off = false;          // Event Trace not installed: stop asking
  let timer: ReturnType<typeof setInterval> | null = null;
  const subs = new Set<() => void>();
  const tick = async () => {
    if (off) return;
    try {
      const r = await fetch(`${defaultBackend()}/api/trace/doors`, { credentials: 'include' });
      if (r.status === 404) { off = true; return; }
      if (r.ok) { data = await r.json(); subs.forEach(f => f()); }
    } catch { /* offline: keep the last data */ }
  };
  return {
    subscribe(f: () => void) {
      subs.add(f);
      if (!timer) { tick(); timer = setInterval(tick, 4000); }
      return () => { subs.delete(f); if (!subs.size && timer) { clearInterval(timer); timer = null; } };
    },
    get: () => data,
    refresh: tick,
  };
})();

const Icon: React.FC<{ s?: string }> = ({ s }) => s === 'pass' ? <CheckCircle2 size={12} className="text-hv-success-fg shrink-0" /> : s === 'warn' ? <AlertTriangle size={12} className="text-hv-warning-fg shrink-0" /> : s === 'fail' ? <XCircle size={12} className="text-hv-error-fg shrink-0" /> : null;
const ago = (t: number) => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`; };

export const DoorTraceStrip: React.FC<{ doorId: number }> = ({ doorId }) => {
  const sum = useSyncExternalStore(store.subscribe, store.get, store.get);
  if (!sum) return null;
  const d = sum.doors.find(x => x.id === doorId);
  if (!d) return null;
  const rows: [string, Brief | null, string][] = [
    ['Card', d.last.card, d.last.card ? `${d.last.card.label} · ${d.last.card.result || 'no decision'}${d.last.card.push != null ? ` · cloud ${fmtMs(d.last.card.push)}` : ''}` : ''],
    ['Door', d.last.input, d.last.input ? `${d.last.input.result || d.last.input.label}${d.last.input.decision != null ? ` · ${fmtMs(d.last.input.decision)}` : ''}` : ''],
    ['Strike', d.last.output, d.last.output ? (d.last.output.held != null ? `held ${(d.last.output.held / 1000).toFixed(1)} s${d.grantMs ? ` (set ${(d.grantMs / 1000).toFixed(1)} s)` : ''}` : `${d.last.output.label}${d.last.output.cause ? ` · ${d.last.output.cause}` : ''}`) : ''],
    ['Command', d.last.command, d.last.command ? `${d.last.command.label}${d.last.command.output != null ? ` · door ${fmtMs(d.last.command.output)}` : ''}` : ''],
  ];
  const any = rows.some(r => r[1]);
  return (
    <div className="px-4 py-2 border-t border-hv-line">
      <div className="flex items-center gap-2 text-[10px] font-bold tracking-wider text-hv-text-3">
        <Activity size={11} /><span>EVENT TRACE</span>
        {d.oncafe
          ? <span className="inline-flex items-center gap-1 font-normal normal-case tracking-normal text-hv-success-fg" title="Paired OnCAFE door"><Link2 size={11} />{d.oncafe.name || 'OnCAFE door'}</span>
          : <span className="inline-flex items-center gap-1 font-normal normal-case tracking-normal" title="Pair it in this door's Settings › Basic, or in Event Trace › Setup › Wiring"><Link2Off size={11} />not paired</span>}
        <span className="flex-1" />
        {(d.counts.pass + d.counts.warn + d.counts.fail) > 0 && (
          <span className="font-normal tracking-normal tabular-nums">{d.counts.pass} ✓ · {d.counts.warn} ! · {d.counts.fail} ✗{sum.run ? ` · ${sum.run.name}` : ''}</span>
        )}
      </div>
      {d.note && <div className="text-[11px] text-hv-text-2 italic truncate" title={d.note}>{d.note}</div>}
      {any ? (
        <div className="mt-0.5 space-y-0.5">
          {rows.filter(r => r[1]).map(([k, b, text]) => (
            <div key={k} className="flex items-center gap-1.5 text-[11px] min-w-0" title={b!.notes.join(' · ')}>
              <Icon s={b!.status} />
              <span className="w-[52px] text-hv-text-3 shrink-0">{k}</span>
              <span className="text-hv-text truncate">{text}</span>
              <span className="ml-auto text-hv-text-3 shrink-0">{ago(b!.at)}</span>
            </div>
          ))}
        </div>
      ) : <div className="text-[11px] text-hv-text-3">No traces yet — start a run in Tools › Event Trace.</div>}
      {d.by && /event trace/.test(d.by) && d.updatedAt && (
        <div className="text-[10px] text-hv-warning-fg mt-0.5">Pairing changed in Event Trace {new Date(d.updatedAt).toLocaleTimeString()} — reload this page before saving doors, or the older copy wins.</div>
      )}
    </div>
  );
};

export const DoorTracePairing: React.FC<{ door: { id: number; trace?: { oncafeDoorId?: string; oncafeDoorName?: string; note?: string } }; onChange: (trace: Record<string, unknown>) => void }> = ({ door, onChange }) => {
  const [status, setStatus] = useState<Status | null>(null);
  const [missing, setMissing] = useState(false);
  const sum = useSyncExternalStore(store.subscribe, store.get, store.get);
  useEffect(() => {
    fetch(`${defaultBackend()}/api/trace/status`, { credentials: 'include' })
      .then(r => { if (r.status === 404) { setMissing(true); return null; } return r.ok ? r.json() : null; })
      .then(j => j && setStatus(j)).catch(() => {});
  }, []);
  if (missing) return null;
  const t = door.trace || {};
  const doors = status?.inventory?.doors || [];
  const mine = sum?.doors.find(x => x.id === door.id);
  const set = (patch: Record<string, unknown>) => onChange({ ...t, ...patch, updatedAt: new Date().toISOString(), by: 'doors page' });
  return (
    <div className="bg-hv-widget/60 rounded-lg p-6 border border-hv-line-strong space-y-3">
      <div className="flex items-center gap-2">
        <Activity size={16} className="text-hv-text-3" />
        <span className="text-sm font-semibold text-slate-300">Event Trace</span>
        <span className="text-xs text-slate-500">pairs this door with OnCAFE so its cards, DPS, REX and strike are traced end to end</span>
      </div>
      <div>
        <label className="block text-xs font-semibold text-slate-400 mb-1">OnCAFE door this one is wired to</label>
        <select value={t.oncafeDoorId || ''} onChange={e => { const id = e.target.value; set({ oncafeDoorId: id || undefined, oncafeDoorName: doors.find(x => x.id === id)?.name }); }}
          className="w-full bg-hv-widget border border-hv-line-strong/60 rounded-lg px-4 py-2.5 text-hv-text focus:outline-none focus:ring-2 focus:ring-hv-text-3">
          <option value="">{doors.length ? '-- not paired --' : t.oncafeDoorId ? (t.oncafeDoorName || t.oncafeDoorId) : '-- sign in to OnCAFE in Tools › Event Trace › Setup --'}</option>
          {t.oncafeDoorId && !doors.some(x => x.id === t.oncafeDoorId) && doors.length > 0 && <option value={t.oncafeDoorId}>{t.oncafeDoorName || t.oncafeDoorId} (not in the loaded list)</option>}
          {doors.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
      </div>
      <div>
        <label className="block text-xs font-semibold text-slate-400 mb-1">Description</label>
        <textarea value={t.note || ''} rows={2} maxLength={300} placeholder="e.g. NC DPS on REL 3, strike watched on OPTO 2 through relay board B"
          onChange={e => set({ note: e.target.value || undefined })}
          className="w-full bg-hv-widget border border-hv-line-strong/60 rounded-lg px-4 py-2 text-sm text-hv-text focus:outline-none focus:ring-2 focus:ring-hv-text-3" />
        <p className="text-xs text-slate-500 mt-1">Shown under the door, on its trace rows and in Event Trace's wiring. Saved with the door; editing it in Event Trace changes it here too (the last save wins).</p>
      </div>
      {mine && mine.channels.length > 0 && (
        <div className="text-xs text-slate-400">Traced as: {mine.channels.map(c => <span key={c.key} className={c.overridden ? 'line-through' : ''} title={c.overridden ? 'Changed in Event Trace › Setup › Wiring' : c.key}>{c.label.split(' · ').pop()}{' '}</span>)}</div>
      )}
    </div>
  );
};
