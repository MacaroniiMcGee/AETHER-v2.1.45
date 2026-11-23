// Setup › Remote Access — AETHER_REMOTE (bundle "remote-1")
// Reach this Pi from anywhere at https://r-<code>.aetheraccesstools.com through its own
// Cloudflare Tunnel. Backend: backend/lib/remoteAccess.js (/api/remote/*).
import React, { useCallback, useEffect, useState } from 'react';
import { Globe, Loader2, AlertTriangle, CheckCircle, Copy, ExternalLink, Power, RefreshCw, KeyRound, ShieldAlert } from 'lucide-react';
import { T, Card, Btn, inputCls, inputStyle, KV, Dot } from './ui';

type Line = { t: number; level: 'info' | 'warn' | 'error'; msg: string };
type Status = {
  success: boolean; serial: string; identitySet: boolean; authInstalled: boolean; enabled: boolean;
  hostname: string | null; url: string | null; activatedAt: number | null;
  running: boolean; connected: boolean; connections: number; upSince: number | null; lastError: string | null; busy: string | null;
  cloudflared: { path: string | null; version: string | null }; apiBase: string; log: Line[];
};
type Msg = { tone: 'ok' | 'err' | 'warn'; text: React.ReactNode } | null;
const KEY_RE = /^AK-[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{6}$/;

async function postJson(url: string, body?: any) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.success === false) throw new Error((j && j.error) || `HTTP ${r.status}`);
  return j;
}

function Banner({ msg }: { msg: Msg }) {
  if (!msg) return null;
  const c = msg.tone === 'ok' ? T.green : msg.tone === 'warn' ? T.warn : T.crit;
  return (
    <div className="rounded-lg border px-3 py-2 text-sm flex items-start gap-2" style={{ borderColor: c, color: T.text, background: T.well }}>
      {msg.tone === 'ok' ? <CheckCircle size={16} style={{ color: c }} className="mt-0.5 shrink-0" /> : <AlertTriangle size={16} style={{ color: c }} className="mt-0.5 shrink-0" />}
      <div className="min-w-0">{msg.text}</div>
    </div>
  );
}

export default function RemoteAccessPanel({ api }: { api: string }) {
  const [st, setSt] = useState<Status | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [showLog, setShowLog] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${api}/api/remote/status`, { cache: 'no-store' });
      if (r.status === 404) { setLoadErr('The backend does not have Remote Access yet (restart it after the update).'); return; }
      const j: Status = await r.json();
      if (!j.success) throw new Error('bad status');
      setSt(j); setLoadErr(null);
    } catch (e: any) { setLoadErr(`Can't reach the Pi: ${e?.message || e}`); }
  }, [api]);
  useEffect(() => { load(); }, [load]);
  const fast = !!st && st.enabled && !st.connected;
  useEffect(() => { const t = setInterval(load, fast ? 2000 : 8000); return () => clearInterval(t); }, [load, fast]);

  const act = async (name: string, path: string, body?: any, ok?: React.ReactNode) => {
    setBusy(name); setMsg(null);
    try { const j = await postJson(`${api}${path}`, body); setSt(j); if (ok) setMsg({ tone: 'ok', text: ok }); }
    catch (e: any) { setMsg({ tone: 'err', text: e.message }); }
    setBusy(null);
  };

  const keyNorm = key.trim().toUpperCase().replace(/\s+/g, '');
  const copy = async (s: string) => { try { await navigator.clipboard.writeText(s); setMsg({ tone: 'ok', text: 'Address copied.' }); } catch { setMsg({ tone: 'warn', text: s }); } };

  if (!st) {
    return <Card title="Remote Access"><div className="text-sm flex items-center gap-2" style={{ color: loadErr ? T.crit : T.dim }}>{loadErr ? <AlertTriangle size={15} /> : <Loader2 size={15} className="animate-spin" />}{loadErr || 'Loading…'}</div></Card>;
  }

  const tone = !st.enabled ? T.dim : st.connected ? T.green : st.lastError ? T.crit : T.warn;
  const headline = !st.enabled ? 'Remote Access is off. This Pi can only be reached on the local network.'
    : st.connected ? 'On: this Pi can be reached from anywhere'
    : st.lastError ? `Not connected: ${st.lastError}`
    : 'Connecting to Cloudflare…';

  return (
    <div className="space-y-4">
      <Banner msg={msg} />

      <Card title={<span className="inline-flex items-center gap-2"><Globe size={15} />Remote Access</span>}
        right={<span className="inline-flex items-center gap-2 text-xs" style={{ color: tone }}><Dot on={st.enabled && st.connected} color={tone} />{st.enabled ? (st.connected ? 'Connected' : 'Not connected') : 'Off'}</span>}>
        <div className="space-y-3">
          <div className="text-sm font-semibold" style={{ color: tone === T.dim ? T.text2 : tone }}>{headline}</div>

          {st.url && (
            <div className="rounded-lg border px-3 py-2 flex flex-wrap items-center gap-2" style={{ borderColor: T.line2, background: T.well }}>
              <span className="text-xs" style={{ color: T.dim }}>Remote address</span>
              <span className="font-mono text-sm break-all" style={{ color: T.text }}>{st.url}</span>
              <span className="flex-1" />
              <Btn onClick={() => copy(st.url!)}><Copy size={14} />Copy</Btn>
              {st.enabled && st.connected && <a href={st.url} target="_blank" rel="noreferrer"><Btn><ExternalLink size={14} />Open</Btn></a>}
            </div>
          )}

          {!st.authInstalled && (
            <div className="rounded-lg border px-3 py-2 text-sm flex items-start gap-2" style={{ borderColor: T.crit, background: T.well, color: T.text }}>
              <ShieldAlert size={16} style={{ color: T.crit }} className="mt-0.5 shrink-0" />
              <div>The sign-in update (LOGIN-2) is not installed. Remote Access stays off until it is, because without it anyone on the internet could control this Pi.</div>
            </div>
          )}

          {!st.identitySet ? (
            <div className="space-y-2">
              <div className="text-sm" style={{ color: T.text2 }}>Enter the activation key from the label on this unit.</div>
              <div className="flex flex-wrap gap-2 items-center">
                <KeyRound size={15} style={{ color: T.dim }} />
                <input className={inputCls} style={{ ...inputStyle, maxWidth: 380, fontFamily: 'monospace' }} placeholder="AK-XXXXXX-XXXXXX-XXXXXX-XXXXXX"
                  value={key} onChange={e => setKey(e.target.value)} autoComplete="off" spellCheck={false} />
                <Btn tone="primary" disabled={!KEY_RE.test(keyNorm) || !!busy} onClick={() => act('key', '/api/remote/identity', { key: keyNorm }, 'Activation key saved.').then(() => setKey(''))}>
                  {busy === 'key' ? <Loader2 size={14} className="animate-spin" /> : null}Save key
                </Btn>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {!st.enabled
                ? <Btn tone="primary" disabled={!st.authInstalled || !!busy} onClick={() => act('on', '/api/remote/enable', undefined, 'Remote Access is on. It can take up to a minute for the address to start working.')}>
                    {busy === 'on' ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} />}Turn on Remote Access
                  </Btn>
                : <>
                    <Btn tone="danger" disabled={!!busy} onClick={() => act('off', '/api/remote/disable', undefined, 'Remote Access is off. The address is kept for this unit.')}>
                      {busy === 'off' ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} />}Turn off
                    </Btn>
                    <Btn disabled={!!busy} onClick={() => act('restart', '/api/remote/restart')}><RefreshCw size={14} />Reconnect</Btn>
                    {st.lastError && <Btn disabled={!!busy} onClick={() => act('on', '/api/remote/enable', undefined, 'Set up again.')}>Set up again</Btn>}
                  </>}
            </div>
          )}

          <div className="text-xs leading-relaxed" style={{ color: T.dim }}>
            Anyone opening the remote address must sign in with an Aether account. Live camera video stays on the local network.
            Inside the building you can still use this Pi's local address, even when the internet is down.
          </div>
        </div>
      </Card>

      <Card title="Details" right={<Btn onClick={() => setShowLog(v => !v)}>{showLog ? 'Hide log' : 'Show log'}</Btn>}>
        <KV rows={[
          ['Serial number', <span className="font-mono">{st.serial}</span>],
          ['Activation key', st.identitySet ? 'Saved on this Pi' : 'Not entered'],
          ['Connections to Cloudflare', st.enabled ? String(st.connections) : '—'],
          ['Connected since', st.connected && st.upSince ? new Date(st.upSince).toLocaleString() : '—'],
          ['cloudflared', st.cloudflared.path ? (st.cloudflared.version || st.cloudflared.path) : <span style={{ color: T.crit }}>not installed</span>],
        ]} />
        {showLog && (
          <pre className="mt-3 text-[11px] leading-snug rounded-lg p-2 overflow-auto max-h-64" style={{ background: T.well, color: T.text2 }}>
            {st.log.length ? st.log.map(l => `${new Date(l.t).toLocaleTimeString()}  ${l.level === 'info' ? '' : l.level.toUpperCase() + '  '}${l.msg}`).join('\n') : 'Nothing yet.'}
          </pre>
        )}
      </Card>
    </div>
  );
}
