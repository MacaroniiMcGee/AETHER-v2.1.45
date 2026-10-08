/**
 * DeviceFirmwareTool — send Aether updates and single script files to this Pi from the browser.
 *
 * Talks to backend/routes-device-firmware.js (/api/device-firmware). Jobs run outside the
 * backend process, so the page keeps following a job's log straight through a backend restart.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  UploadCloud, FileCode2, Package, Play, X, RotateCcw, RefreshCw, Hammer, Power, CheckCircle2,
  AlertTriangle, XCircle, Loader2, Copy, Check, FolderOpen, Folder, File as FileIcon, ChevronRight,
  ChevronDown, ShieldCheck, History, ArrowUp,
} from 'lucide-react';

type JobState = 'staged' | 'queued' | 'running' | 'success' | 'failed' | 'rolled_back' | 'rollback_failed' | 'interrupted';
interface Job {
  id: string; type: 'bundle' | 'file' | 'restore' | 'action'; title: string; source?: string; size?: number;
  createdAt: number; finishedAt?: number | null; state: JobState; step?: string; result?: string | null;
  does?: { rebuild: boolean; restart: boolean }; notes?: string[]; files?: (string | { path: string; exists: boolean })[];
  fileCount?: number; payload?: 'apply' | 'overlay'; dest?: string; hasBackup?: boolean;
}
interface Status { setupReady: boolean; setupCommand: string; root: string; service: string; flashing: any; jobs: Job[] }
type After = 'none' | 'rebuild' | 'restart';

const C = {
  panel: 'linear-gradient(160deg, rgb(var(--hv-widget)), rgb(var(--hv-widget-panel)))', border: 'rgb(var(--hv-line))', sub: 'rgb(var(--hv-popup-panel))', text: 'rgb(var(--hv-text))',
  dim: 'rgb(var(--hv-text-2))', faint: 'rgb(var(--hv-text-3))', accent: 'rgb(var(--hv-brand))', green: 'rgb(var(--hv-success-text))', red: 'rgb(var(--hv-error))', amber: 'rgb(var(--hv-brand-text))', teal: 'rgb(var(--hv-info))',
};
const ACCEPT_BUNDLE = '.zip,.tgz,.gz,.tar,.txt';
const done = (s?: JobState) => !!s && !['staged', 'queued', 'running'].includes(s);
const fmtSize = (n = 0) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const fmtTime = (t?: number | null) => t ? new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
const effectOf = (p: string): After =>
  /^frontend\/(src|public|index\.html|vite\.config|tailwind\.config|postcss\.config|tsconfig|package\.json)/.test(p) ? 'rebuild'
    : /^backend\//.test(p) ? 'restart' : 'none';

function StateBadge({ s }: { s: JobState }) {
  const m: Record<JobState, [string, string, React.ReactNode]> = {
    staged: ['Ready to apply', C.amber, <Package size={12} />],
    queued: ['Starting', C.amber, <Loader2 size={12} className="animate-spin" />],
    running: ['Running', C.amber, <Loader2 size={12} className="animate-spin" />],
    success: ['Done', C.green, <CheckCircle2 size={12} />],
    failed: ['Failed', C.red, <XCircle size={12} />],
    rolled_back: ['Rolled back', C.amber, <RotateCcw size={12} />],
    rollback_failed: ['Rollback failed', C.red, <AlertTriangle size={12} />],
    interrupted: ['Interrupted', C.red, <AlertTriangle size={12} />],
  };
  const [label, color, icon] = m[s] || [s, C.dim, null];
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold whitespace-nowrap"
      style={{ color, background: `color-mix(in srgb, ${color} 12%, transparent)`, border: `1px solid color-mix(in srgb, ${color} 33%, transparent)` }}>{icon}{label}</span>
  );
}

function Card({ title, icon, right, children }: { title: string; icon: React.ReactNode; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border p-5" style={{ background: C.panel, borderColor: C.border }}>
      <div className="flex items-center justify-between gap-3 mb-4">
        <h3 className="text-lg font-semibold text-hv-text flex items-center gap-2">{icon}{title}</h3>
        {right}
      </div>
      {children}
    </div>
  );
}

function DropZone({ accept, onFile, label, hint, disabled }: { accept?: string; onFile: (f: File) => void; label: string; hint: string; disabled?: boolean }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div
      onClick={() => !disabled && input.current?.click()}
      onDragOver={e => { e.preventDefault(); if (!disabled) setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={e => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files?.[0]; if (f && !disabled) onFile(f); }}
      className={`rounded-lg border-2 border-dashed px-4 py-7 text-center transition-colors ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
      style={{ borderColor: over ? C.accent : 'rgb(var(--hv-line-strong))', background: over ? `color-mix(in srgb, ${C.accent} 6%, transparent)` : 'rgb(var(--hv-widget-panel) / 0.5)' }}
    >
      <UploadCloud className="mx-auto mb-2" size={30} style={{ color: over ? C.accent : C.faint }} />
      <div className="text-sm font-semibold" style={{ color: C.text }}>{label}</div>
      <div className="text-xs mt-1" style={{ color: C.faint }}>{hint}</div>
      <input ref={input} type="file" accept={accept} className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
    </div>
  );
}

const Btn = ({ onClick, children, kind = 'ghost', disabled, title }: { onClick?: () => void; children: React.ReactNode; kind?: 'primary' | 'ghost' | 'danger'; disabled?: boolean; title?: string }) => (
  <button onClick={onClick} disabled={disabled} title={title}
    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
    style={kind === 'primary' ? { background: C.accent, color: '#101011' }
      : kind === 'danger' ? { background: 'rgb(var(--hv-error) / 0.13)', color: C.red, border: `1px solid color-mix(in srgb, ${C.red} 33%, transparent)` }
      : { background: C.sub, color: C.text, border: `1px solid ${C.border}` }}>
    {children}
  </button>
);

export default function DeviceFirmwareTool({ backendUrl }: { backendUrl: string }) {
  const API = `${backendUrl.replace(/\/$/, '')}/api/device-firmware`;
  const [status, setStatus] = useState<Status | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'err' | 'ok'; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

  // bundle
  const [staged, setStaged] = useState<Job | null>(null);
  const [bundlePct, setBundlePct] = useState<number | null>(null);
  const [showFiles, setShowFiles] = useState(false);

  // single file
  const [file, setFile] = useState<File | null>(null);
  const [dest, setDest] = useState('');
  const [matches, setMatches] = useState<{ path: string }[]>([]);
  const [after, setAfter] = useState<After>('none');
  const [afterTouched, setAfterTouched] = useState(false);
  const [browseDir, setBrowseDir] = useState<string | null>(null);
  const [browseList, setBrowseList] = useState<{ name: string; dir: boolean }[]>([]);
  const [filePct, setFilePct] = useState<number | null>(null);

  // followed job
  const [followId, setFollowId] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [log, setLog] = useState('');
  const [offline, setOffline] = useState(false);
  const offsetRef = useRef(0);
  const logBox = useRef<HTMLPreElement>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`${API}/status`);
      if (r.status === 404) throw new Error('This backend has no Device firmware routes yet. Install the update from a terminal once.');
      const j = await r.json();
      if (!j.success) throw new Error(j.error || 'Status failed');
      setStatus(j); setLoadErr(null);
      return j as Status;
    } catch (e: any) { setLoadErr(e.message === 'Failed to fetch' ? `Can't reach ${backendUrl}` : e.message); return null; }
  }, [API, backendUrl]);

  // On load, pick up a job that is still running (e.g. after the page was reloaded mid-update)
  useEffect(() => {
    refresh().then(s => {
      const live = s?.jobs.find(j => j.state === 'queued' || j.state === 'running');
      if (live) setFollowId(live.id);
      const st = s?.jobs.find(j => j.state === 'staged');
      if (st && !live) fetch(`${API}/jobs/${st.id}`).then(r => r.json()).then(d => d.success && setStaged(d.job)).catch(() => {});
    });
  }, [refresh, API]);

  // Follow a job's log; keeps polling while the backend restarts
  useEffect(() => {
    if (!followId) return;
    let stop = false, timer: any;
    offsetRef.current = 0; setLog(''); setJob(null);
    const tick = async () => {
      try {
        const r = await fetch(`${API}/jobs/${followId}?offset=${offsetRef.current}`, { cache: 'no-store' });
        const d = await r.json();
        if (stop) return;
        setOffline(false);
        if (d.success) {
          if (d.log) setLog(l => l + d.log);
          offsetRef.current = d.offset;
          setJob(d.job);
          if (done(d.job.state)) { refresh(); return; }
        }
      } catch (e) { if (!stop) setOffline(true); }
      if (!stop) timer = setTimeout(tick, 1000);
    };
    tick();
    return () => { stop = true; clearTimeout(timer); };
  }, [followId, API, refresh]);

  useEffect(() => { if (logBox.current) logBox.current.scrollTop = logBox.current.scrollHeight; }, [log]);

  const running = !!job && !done(job.state);
  const busy = running || bundlePct !== null || filePct !== null;

  // multipart upload with progress
  const send = (url: string, form: FormData, onPct: (p: number | null) => void) => new Promise<any>((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', url);
    x.upload.onprogress = e => e.lengthComputable && onPct(Math.round(e.loaded / e.total * 100));
    x.onload = () => { onPct(null); try { resolve(JSON.parse(x.responseText)); } catch { reject(new Error(`Upload failed (${x.status})`)); } };
    x.onerror = () => { onPct(null); reject(new Error(`Can't reach ${backendUrl}`)); };
    x.send(form);
  });

  // ---------- bundle
  const uploadBundle = async (f: File) => {
    setMsg(null); setStaged(null); setShowFiles(false);
    const fd = new FormData(); fd.append('file', f);
    try {
      setBundlePct(0);
      const d = await send(`${API}/bundle`, fd, setBundlePct);
      if (!d.success) throw new Error(d.error);
      setStaged(d.job);
    } catch (e: any) { setMsg({ kind: 'err', text: e.message }); }
  };
  const applyBundle = async () => {
    if (!staged) return;
    setMsg(null);
    try {
      const d = await (await fetch(`${API}/jobs/${staged.id}/apply`, { method: 'POST' })).json();
      if (!d.success) throw new Error(d.error);
      setFollowId(staged.id); setStaged(null);
    } catch (e: any) { setMsg({ kind: 'err', text: e.message }); }
  };
  const discard = async (id: string) => {
    await fetch(`${API}/jobs/${id}`, { method: 'DELETE' }).catch(() => {});
    if (staged?.id === id) setStaged(null);
    refresh();
  };

  // ---------- single file
  const pickFile = async (f: File) => {
    setMsg(null); setFile(f); setMatches([]); setAfterTouched(false);
    try {
      const d = await (await fetch(`${API}/find?name=${encodeURIComponent(f.name)}`)).json();
      const m = d.matches || [];
      setMatches(m);
      if (m.length === 1) { setDest(m[0].path); setAfter(effectOf(m[0].path)); }
      else if (dest && !dest.endsWith('/')) { const dir = dest.split('/').slice(0, -1).join('/'); setDest(dir ? `${dir}/${f.name}` : f.name); }
      else setDest(dest ? `${dest.replace(/\/$/, '')}/${f.name}` : '');
    } catch { /* destination stays manual */ }
  };
  useEffect(() => { if (!afterTouched) setAfter(effectOf(dest)); }, [dest, afterTouched]);

  const browse = async (dir: string) => {
    try {
      const d = await (await fetch(`${API}/browse?dir=${encodeURIComponent(dir)}`)).json();
      if (d.success) { setBrowseDir(d.dir); setBrowseList(d.entries); }
    } catch { /* ignore */ }
  };
  const uploadFile = async () => {
    if (!file || !dest) return;
    setMsg(null);
    const fd = new FormData(); fd.append('dest', dest); fd.append('after', after); fd.append('file', file);
    try {
      setFilePct(0);
      const d = await send(`${API}/file`, fd, setFilePct);
      if (!d.success) throw new Error(d.error);
      setFile(null); setMatches([]);
      setFollowId(d.job.id);
      if (done(d.job.state)) refresh();
    } catch (e: any) { setMsg({ kind: 'err', text: e.message }); }
  };

  // ---------- restore / actions
  const restore = async (j: Job) => {
    const what = j.type === 'bundle' ? 'the whole Aether folder (except node_modules and .git) to how it was before this update' : `${j.dest} to how it was before`;
    if (!window.confirm(`Put ${what}?${j.type === 'bundle' || effectOf(j.dest || '') === 'restart' ? '\n\nThe backend will restart.' : ''}`)) return;
    setMsg(null);
    try {
      const d = await (await fetch(`${API}/jobs/${j.id}/restore`, { method: 'POST' })).json();
      if (!d.success) throw new Error(d.error);
      setFollowId(d.job.id);
    } catch (e: any) { setMsg({ kind: 'err', text: e.message }); }
  };
  const action = async (a: 'rebuild' | 'restart') => {
    if (a === 'restart' && !window.confirm(`Restart ${status?.service || 'the backend'} now?`)) return;
    setMsg(null);
    try {
      const d = await (await fetch(`${API}/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: a }) })).json();
      if (!d.success) throw new Error(d.error);
      setFollowId(d.job.id);
    } catch (e: any) { setMsg({ kind: 'err', text: e.message }); }
  };
  const viewJob = (id: string) => { setFollowId(null); setTimeout(() => setFollowId(id), 0); };

  const copySetup = () => {
    if (!status) return;
    navigator.clipboard?.writeText(status.setupCommand).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {});
  };

  const setupReady = !!status?.setupReady;
  const flashing = status?.flashing;
  const fileList = (staged?.files || []).map(f => typeof f === 'string' ? { path: f, exists: true } : f);
  const pathParts = (browseDir || '').split('/').filter(Boolean);

  // ---------- render
  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="rounded-xl p-6 border shadow-2xl" style={{ background: C.panel, borderColor: C.border }}>
        <div className="flex items-start justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-3xl font-bold text-hv-text flex items-center gap-3">
              <UploadCloud className="w-8 h-8" style={{ color: C.accent }} /> Device firmware
            </h1>
            <p className="mt-2" style={{ color: C.dim }}>Send Aether updates and script files to this Pi. Every change is backed up first.</p>
            {status && <p className="mt-1 text-xs font-mono" style={{ color: C.faint }}>{status.root}</p>}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {status && (setupReady
              ? <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold" style={{ color: C.green, background: 'rgb(var(--hv-success-text) / 0.1)', border: '1px solid rgb(var(--hv-success-text) / 0.33)' }}><ShieldCheck size={13} />Restarts enabled</span>
              : <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold" style={{ color: C.amber, background: 'rgb(var(--hv-brand-text) / 0.1)', border: '1px solid rgb(var(--hv-brand-text) / 0.33)' }}><AlertTriangle size={13} />Setup needed</span>)}
            <Btn onClick={() => action('rebuild')} disabled={busy || !status} title="Run npm run build in frontend/"><Hammer size={14} />Rebuild pages</Btn>
            <Btn onClick={() => action('restart')} disabled={busy || !setupReady || !!flashing} title={setupReady ? '' : 'Needs the one-time setup'}><Power size={14} />Restart backend</Btn>
            <Btn onClick={refresh} title="Refresh"><RefreshCw size={14} /></Btn>
          </div>
        </div>

        {loadErr && <div className="mt-4 rounded-lg px-4 py-3 text-sm" style={{ background: 'rgb(var(--hv-error) / 0.1)', color: C.red, border: `1px solid color-mix(in srgb, ${C.red} 33%, transparent)` }}>{loadErr}</div>}

        {status && !setupReady && (
          <div className="mt-4 rounded-lg px-4 py-3" style={{ background: 'rgb(var(--hv-brand-text) / 0.07)', border: '1px solid rgb(var(--hv-brand-text) / 0.27)' }}>
            <div className="text-sm font-semibold" style={{ color: C.amber }}>One-time setup, needed for anything that restarts the backend</div>
            <div className="text-xs mt-1" style={{ color: C.dim }}>Run this once in the Pi terminal. It lets Aether restart only its own services and run updates outside the backend, so a restart can't cut an update off.</div>
            <div className="mt-2 flex items-center gap-2">
              <code className="flex-1 text-xs font-mono px-3 py-2 rounded overflow-x-auto whitespace-nowrap" style={{ background: 'rgb(var(--hv-surface))', color: C.text }}>{status.setupCommand}</code>
              <Btn onClick={copySetup}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? 'Copied' : 'Copy'}</Btn>
            </div>
            <div className="text-xs mt-2" style={{ color: C.faint }}>Until then you can still send frontend files and updates that don't restart anything.</div>
          </div>
        )}

        {flashing && (
          <div className="mt-4 rounded-lg px-4 py-3 text-sm flex items-center gap-2" style={{ background: 'rgb(var(--hv-error) / 0.1)', color: C.red, border: `1px solid color-mix(in srgb, ${C.red} 33%, transparent)` }}>
            <AlertTriangle size={16} /> A reader firmware transfer is in progress{flashing.readerId ? ` on ${flashing.readerId}` : ''}. Anything that restarts the backend waits until it finishes.
          </div>
        )}
        {msg && (
          <div className="mt-4 rounded-lg px-4 py-3 text-sm flex items-start justify-between gap-3"
            style={msg.kind === 'err' ? { background: 'rgb(var(--hv-error) / 0.1)', color: C.red, border: `1px solid color-mix(in srgb, ${C.red} 33%, transparent)` } : { background: 'rgb(var(--hv-success-text) / 0.1)', color: C.green, border: '1px solid rgb(var(--hv-success-text) / 0.33)' }}>
            <span>{msg.text}</span><button onClick={() => setMsg(null)}><X size={14} /></button>
          </div>
        )}
      </div>

      {/* Live job */}
      {followId && (
        <Card
          title={job ? job.title : 'Starting…'}
          icon={job?.type === 'file' ? <FileCode2 size={18} style={{ color: C.accent }} /> : <Package size={18} style={{ color: C.accent }} />}
          right={<div className="flex items-center gap-2">{job && <StateBadge s={job.state} />}{job && done(job.state) && <button onClick={() => setFollowId(null)} style={{ color: C.faint }}><X size={16} /></button>}</div>}
        >
          {offline && running && (
            <div className="mb-3 text-sm flex items-center gap-2" style={{ color: C.amber }}>
              <Loader2 size={14} className="animate-spin" /> Backend is restarting. Reconnecting… the update keeps running on the Pi.
            </div>
          )}
          {job && !done(job.state) && job.step && <div className="mb-2 text-sm" style={{ color: C.dim }}>{job.step}</div>}
          {job && done(job.state) && job.result && (
            <div className="mb-3 text-sm font-semibold" style={{ color: job.state === 'success' ? C.green : job.state === 'rolled_back' ? C.amber : C.red }}>{job.result}</div>
          )}
          <pre ref={logBox} className="text-xs font-mono rounded-lg p-3 overflow-auto whitespace-pre-wrap"
            style={{ background: 'rgb(var(--hv-surface))', color: 'rgb(var(--hv-text-2))', maxHeight: 340, minHeight: 80, border: `1px solid ${C.border}` }}>{log || 'Waiting for output…'}</pre>
          {job && job.state === 'success' && job.does?.rebuild && (
            <div className="mt-3 flex items-center gap-3 text-sm" style={{ color: C.dim }}>
              New web pages are built.<Btn kind="primary" onClick={() => window.location.reload()}><RefreshCw size={14} />Reload this page</Btn>
            </div>
          )}
          {job && job.state === 'success' && job.type === 'bundle' && !job.does?.rebuild && (
            <div className="mt-3 text-sm" style={{ color: C.dim }}>If the update changed any screens, press Ctrl+Shift+R.</div>
          )}
        </Card>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Update bundle */}
        <Card title="Update bundle" icon={<Package size={18} style={{ color: C.accent }} />}>
          {!staged && (
            <>
              <DropZone accept={ACCEPT_BUNDLE} onFile={uploadBundle} disabled={busy}
                label={bundlePct !== null ? `Uploading… ${bundlePct}%` : 'Drop an update here, or click to choose'}
                hint=".zip · .tgz · the paste-uNN.txt file. Nothing changes until you press Apply." />
              <div className="mt-3 text-xs leading-relaxed" style={{ color: C.faint }}>
                A bundle with an <span className="font-mono">apply.sh</span> runs it against this Aether folder. A bundle of plain
                <span className="font-mono"> backend/</span> and <span className="font-mono">frontend/</span> files is copied in, then the pages rebuild and the backend restarts as needed.
                If the backend doesn't come back within a minute, the backup goes back automatically.
              </div>
            </>
          )}
          {staged && (
            <div>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-semibold" style={{ color: C.text }}>{staged.title}</div>
                  <div className="text-xs mt-0.5" style={{ color: C.faint }}>{staged.source} · {fmtSize(staged.size)} · {staged.payload === 'apply' ? 'runs apply.sh' : 'copies files'}</div>
                </div>
                <StateBadge s="staged" />
              </div>
              <div className="flex flex-wrap gap-2 mt-3">
                {staged.does?.rebuild && <span className="text-xs px-2 py-0.5 rounded-full" style={{ color: C.teal, border: `1px solid color-mix(in srgb, ${C.teal} 33%, transparent)` }}>Rebuilds web pages</span>}
                {staged.does?.restart && <span className="text-xs px-2 py-0.5 rounded-full" style={{ color: C.amber, border: `1px solid color-mix(in srgb, ${C.amber} 33%, transparent)` }}>Restarts the backend</span>}
                {!staged.does?.rebuild && !staged.does?.restart && <span className="text-xs px-2 py-0.5 rounded-full" style={{ color: C.dim, border: `1px solid ${C.border}` }}>Files only</span>}
              </div>
              {(staged.notes || []).map((n, i) => <div key={i} className="text-xs mt-2" style={{ color: C.dim }}>• {n}</div>)}
              {staged.does?.restart && !setupReady && <div className="text-xs mt-2" style={{ color: C.amber }}>• This one restarts the backend, so it needs the one-time setup above first.</div>}
              {fileList.length > 0 && (
                <div className="mt-3">
                  <button onClick={() => setShowFiles(v => !v)} className="text-xs flex items-center gap-1" style={{ color: C.dim }}>
                    {showFiles ? <ChevronDown size={13} /> : <ChevronRight size={13} />}{fileList.length} file{fileList.length === 1 ? '' : 's'} in the bundle
                  </button>
                  {showFiles && (
                    <div className="mt-1 max-h-44 overflow-auto rounded p-2 text-xs font-mono" style={{ background: 'rgb(var(--hv-surface))', color: C.dim }}>
                      {fileList.map(f => <div key={f.path}>{f.path}{staged.payload === 'overlay' && !f.exists && <span style={{ color: C.green }}>  (new)</span>}</div>)}
                    </div>
                  )}
                </div>
              )}
              <div className="flex gap-2 mt-4">
                <Btn kind="primary" onClick={applyBundle} disabled={busy || (!!staged.does?.restart && (!setupReady || !!flashing))}><Play size={14} />Apply</Btn>
                <Btn onClick={() => discard(staged.id)} disabled={busy}><X size={14} />Discard</Btn>
              </div>
            </div>
          )}
        </Card>

        {/* Single file */}
        <Card title="Single file" icon={<FileCode2 size={18} style={{ color: C.accent }} />}>
          {!file ? (
            <DropZone onFile={pickFile} disabled={busy}
              label="Drop a script or source file, or click to choose"
              hint="The old copy is backed up and can be restored from History." />
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2 rounded-lg px-3 py-2" style={{ background: C.sub, border: `1px solid ${C.border}` }}>
                <div className="flex items-center gap-2 min-w-0"><FileIcon size={15} style={{ color: C.accent }} />
                  <span className="text-sm font-mono truncate" style={{ color: C.text }}>{file.name}</span>
                  <span className="text-xs" style={{ color: C.faint }}>{fmtSize(file.size)}</span></div>
                <button onClick={() => { setFile(null); setMatches([]); }} style={{ color: C.faint }}><X size={15} /></button>
              </div>

              <div>
                <label className="text-xs font-semibold" style={{ color: C.dim }}>Goes to (inside the Aether folder)</label>
                <div className="flex gap-2 mt-1">
                  <input value={dest} onChange={e => setDest(e.target.value.replace(/\\/g, '/'))} placeholder="backend/routes-osdp.js"
                    className="flex-1 px-3 py-1.5 rounded-lg text-sm font-mono outline-none"
                    style={{ background: 'rgb(var(--hv-surface))', color: C.text, border: `1px solid ${C.border}` }} />
                  <Btn onClick={() => browseDir === null ? browse(dest.includes('/') ? dest.split('/').slice(0, -1).join('/') : '') : setBrowseDir(null)}><FolderOpen size={14} />Browse</Btn>
                </div>
                {matches.length > 1 && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    <span className="text-xs" style={{ color: C.faint }}>Found {matches.length} files with this name:</span>
                    {matches.map(m => (
                      <button key={m.path} onClick={() => setDest(m.path)} className="text-xs font-mono px-2 py-0.5 rounded"
                        style={{ background: dest === m.path ? `color-mix(in srgb, ${C.accent} 15%, transparent)` : C.sub, color: dest === m.path ? C.amber : C.dim, border: `1px solid ${C.border}` }}>{m.path}</button>
                    ))}
                  </div>
                )}
                {matches.length === 0 && file && dest && <div className="text-xs mt-1" style={{ color: C.faint }}>No file with this name yet, so this adds a new one.</div>}
                {browseDir !== null && (
                  <div className="mt-2 rounded-lg overflow-hidden" style={{ border: `1px solid ${C.border}` }}>
                    <div className="flex items-center gap-1 px-2 py-1.5 text-xs font-mono flex-wrap" style={{ background: C.sub, color: C.dim }}>
                      <button onClick={() => browse('')} className="hover:underline">Aether</button>
                      {pathParts.map((p, i) => <React.Fragment key={i}><span>/</span><button onClick={() => browse(pathParts.slice(0, i + 1).join('/'))} className="hover:underline">{p}</button></React.Fragment>)}
                      {pathParts.length > 0 && <button onClick={() => browse(pathParts.slice(0, -1).join('/'))} className="ml-auto" title="Up"><ArrowUp size={13} /></button>}
                    </div>
                    <div className="max-h-48 overflow-auto text-sm" style={{ background: 'rgb(var(--hv-surface))' }}>
                      {browseList.map(e => (
                        <button key={e.name} className="w-full text-left px-3 py-1 flex items-center gap-2 hover:bg-hv-contrast/5 font-mono text-xs"
                          style={{ color: e.dir ? C.text : C.dim }}
                          onClick={() => {
                            const p = browseDir ? `${browseDir}/${e.name}` : e.name;
                            if (e.dir) { browse(p); setDest(`${p}/${file.name}`); } else { setDest(p); setBrowseDir(null); }
                          }}>
                          {e.dir ? <Folder size={13} style={{ color: C.accent }} /> : <FileIcon size={13} />}{e.name}
                        </button>
                      ))}
                      {browseList.length === 0 && <div className="px-3 py-2 text-xs" style={{ color: C.faint }}>Empty folder</div>}
                    </div>
                  </div>
                )}
              </div>

              <div>
                <label className="text-xs font-semibold" style={{ color: C.dim }}>Then</label>
                <div className="flex gap-1 mt-1 p-1 rounded-lg w-fit" style={{ background: 'rgb(var(--hv-surface))', border: `1px solid ${C.border}` }}>
                  {([['none', 'Nothing'], ['rebuild', 'Rebuild pages'], ['restart', 'Restart backend']] as [After, string][]).map(([v, l]) => (
                    <button key={v} onClick={() => { setAfter(v); setAfterTouched(true); }}
                      disabled={v === 'restart' && !setupReady}
                      className="px-3 py-1 rounded-md text-xs font-semibold disabled:opacity-40"
                      style={after === v ? { background: C.accent, color: '#101011' } : { color: C.dim }}>{l}</button>
                  ))}
                </div>
                {effectOf(dest) !== 'none' && after !== effectOf(dest) && (
                  <div className="text-xs mt-1" style={{ color: C.amber }}>
                    {effectOf(dest) === 'rebuild' ? 'Frontend files only show up after the pages rebuild.' : 'Backend files only take effect after a restart.'}
                    {effectOf(dest) === 'restart' && !setupReady ? ' Restarting needs the one-time setup.' : ''}
                  </div>
                )}
                {after === 'restart' && <div className="text-xs mt-1" style={{ color: C.faint }}>If the backend doesn't come back within a minute, the old file goes back automatically.</div>}
              </div>

              <div className="flex gap-2">
                <Btn kind="primary" onClick={uploadFile} disabled={busy || !dest || dest.endsWith('/') || (after === 'restart' && !!flashing)}>
                  {filePct !== null ? <><Loader2 size={14} className="animate-spin" />{filePct}%</> : <><UploadCloud size={14} />Send to Pi</>}
                </Btn>
              </div>
            </div>
          )}
        </Card>
      </div>

      {/* History */}
      <Card title="History and backups" icon={<History size={18} style={{ color: C.accent }} />}
        right={<span className="text-xs" style={{ color: C.faint }}>Last {status?.jobs.length || 0}, newest first</span>}>
        {!status || status.jobs.length === 0 ? (
          <div className="text-sm" style={{ color: C.faint }}>Nothing sent yet.</div>
        ) : (
          <div className="divide-y" style={{ borderColor: C.border }}>
            {status.jobs.map(j => (
              <div key={j.id} className="py-2.5 flex items-center gap-3 flex-wrap" style={{ borderColor: C.border }}>
                <div className="w-28 text-xs" style={{ color: C.faint }}>{fmtTime(j.createdAt)}</div>
                <div className="w-6">{j.type === 'file' ? <FileCode2 size={15} style={{ color: C.dim }} /> : j.type === 'restore' ? <RotateCcw size={15} style={{ color: C.dim }} /> : j.type === 'action' ? <Power size={15} style={{ color: C.dim }} /> : <Package size={15} style={{ color: C.dim }} />}</div>
                <div className="flex-1 min-w-[180px]">
                  <div className={`text-sm ${j.type === 'file' ? 'font-mono' : ''}`} style={{ color: C.text }}>{j.title}</div>
                  {j.result && done(j.state) && j.state !== 'success' && <div className="text-xs" style={{ color: C.faint }}>{j.result}</div>}
                </div>
                <StateBadge s={j.state} />
                <div className="flex gap-1.5">
                  {j.state !== 'staged' && <Btn onClick={() => viewJob(j.id)}>Log</Btn>}
                  {j.state === 'staged' && <Btn onClick={() => fetch(`${API}/jobs/${j.id}`).then(r => r.json()).then(d => d.success && setStaged(d.job))}>Open</Btn>}
                  {j.state === 'staged' && <Btn kind="danger" onClick={() => discard(j.id)}>Discard</Btn>}
                  {j.hasBackup && (j.type === 'bundle' || j.type === 'file') && ['success', 'failed', 'interrupted'].includes(j.state) && (
                    <Btn onClick={() => restore(j)} disabled={busy} title="Put back what was there before this"><RotateCcw size={13} />Restore</Btn>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
