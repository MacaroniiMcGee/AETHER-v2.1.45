// Network: live status on the left, settings on the right. Changes go through
// NetworkManager via the backend's root helper and roll back on their own after
// 90 s unless "Keep" is pressed from the new address.
import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, AlertTriangle, CheckCircle, Loader2 } from 'lucide-react';
import { T, Card, Btn, inputCls, inputStyle, KV } from './ui';
import TrafficChart from './TrafficChart';

type NetStatus = { hostname: string; ips: string[]; interfaces: string[]; ifDetails: Record<string, { ip: string | null; mac: string | null; state: string }> };
type NM = { manager: string; supported: boolean; connection?: string | null; helperInstalled?: boolean; method?: string; addresses?: string; gateway?: string; dns?: string };

const IP_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

export default function NetworkPage({ api }: { api: string }) {
  const [status, setStatus] = useState<NetStatus | null>(null);
  const [nm, setNm] = useState<NM | null>(null);
  const [loading, setLoading] = useState(false);
  const [iface, setIface] = useState('eth0');
  const [form, setForm] = useState({ mode: 'dhcp' as 'dhcp' | 'static', ip: '', prefix: '24', gateway: '', dns: '', hostname: '' });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err' | 'warn'; text: React.ReactNode } | null>(null);
  const [pending, setPending] = useState<{ pending: boolean; secondsLeft: number | null } | null>(null);

  const load = useCallback(async (which = iface) => {
    setLoading(true);
    try {
      const [s, n] = await Promise.all([
        fetch(`${api}/api/network/status`).then(r => r.json()).catch(() => null),
        fetch(`${api}/api/network/nm?iface=${encodeURIComponent(which)}`).then(r => r.json()).catch(() => null),
      ]);
      if (s?.success) setStatus(s);
      if (n?.success) {
        setNm(n);
        const [ip, prefix] = String(n.addresses || '').split(',')[0].split('/');
        setForm(f => ({ ...f, mode: n.method === 'manual' ? 'static' : 'dhcp', ip: ip || '', prefix: prefix || '24', gateway: n.gateway || '', dns: n.dns || '', hostname: f.hostname || s?.hostname || '' }));
      }
    } finally { setLoading(false); }
  }, [api, iface]);

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Rollback countdown (also shows up after reconnecting at the new address)
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try { const p = await (await fetch(`${api}/api/network/pending`)).json(); if (!stop) setPending(p?.success ? p : null); } catch { /* unreachable while it switches */ }
    };
    tick(); const t = setInterval(tick, 2000);
    return () => { stop = true; clearInterval(t); };
  }, [api]);

  const ifaces = status?.interfaces?.length ? status.interfaces : ['eth0', 'wlan0'];
  const valid = form.mode === 'dhcp' || (IP_RE.test(form.ip) && (!form.gateway || IP_RE.test(form.gateway)) && form.dns.trim().split(/\s+/).filter(Boolean).every(d => IP_RE.test(d)));
  const hostOk = !form.hostname || /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(form.hostname);
  const canApply = !!nm?.supported && nm.helperInstalled !== false && valid && hostOk;

  const apply = async () => {
    setConfirmOpen(false); setBusy(true); setMsg(null);
    const newIp = form.mode === 'static' ? form.ip : null;
    try {
      const r = await fetch(`${api}/api/network/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ iface, ...form }) });
      const j = await r.json();
      if (!j.success) { setMsg({ tone: 'err', text: j.error || 'Could not apply.' }); setBusy(false); return; }
      const here = window.location.hostname;
      setMsg({
        tone: 'warn',
        text: newIp && newIp !== here
          ? <>Applied. The Pi is moving to <b>{newIp}</b>. Open <a className="underline" href={`http://${newIp}:${window.location.port || 80}`}>{`http://${newIp}${window.location.port ? ':' + window.location.port : ''}`}</a>, go to Config → Network and press <b>Keep</b> within 90 s, or it switches back.</>
          : <>Applied. If this page still works in a few seconds, press <b>Keep</b>. Otherwise wait 90 s and it switches back on its own.</>,
      });
    } catch {
      setMsg({ tone: 'warn', text: 'Sent. The connection dropped while the Pi switched. Reconnect at the new address and press Keep within 90 s.' });
    }
    setBusy(false);
  };

  const keep = async () => {
    const j = await (await fetch(`${api}/api/network/confirm`, { method: 'POST' })).json().catch(() => ({}));
    setMsg(j.success ? { tone: 'ok', text: 'New network settings kept.' } : { tone: 'err', text: j.error || 'Could not confirm.' });
    setPending(null); load();
  };

  const f = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm(p => ({ ...p, [k]: e.target.value }));

  return (
    <div className="space-y-4">
      {pending?.pending && (
        <div className="rounded-xl border px-4 py-3 flex flex-wrap items-center gap-3" style={{ background: 'rgb(var(--hv-warning) / 0.1)', borderColor: 'rgb(var(--hv-text-3))' }}>
          <AlertTriangle size={18} style={{ color: T.warn }} />
          <div className="flex-1 min-w-[240px] text-sm" style={{ color: T.text }}>
            New network settings are on trial. They switch back in <b className="font-mono">{pending.secondsLeft ?? '…'} s</b> unless you keep them.
          </div>
          <Btn tone="primary" onClick={keep}>Keep these settings</Btn>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        {/* Status */}
        <Card title="Current status" right={<Btn onClick={() => load()} disabled={loading}>{loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}Refresh</Btn>}>
          {!status ? <p className="text-sm" style={{ color: T.dim }}>{loading ? 'Loading…' : 'Could not reach the backend.'}</p> : (
            <div className="space-y-4">
              <KV rows={[
                ['Hostname', <span className="font-mono">{status.hostname}</span>],
                ['Managed by', nm ? (nm.supported ? 'NetworkManager' : 'not NetworkManager') : '…'],
                ...(nm?.connection ? [['Connection', nm.connection] as [string, React.ReactNode]] : []),
                ['Address mode', nm?.method ? (nm.method === 'manual' ? 'Static' : 'DHCP (automatic)') : '—'],
              ]} />
              <div className="space-y-2">
                {Object.entries(status.ifDetails || {}).map(([name, d]) => (
                  <div key={name} className="rounded-lg border px-3 py-2 flex items-center gap-3" style={{ background: T.well, borderColor: T.line }}>
                    <span className="w-2.5 h-2.5 rounded-full" style={{ background: d.state === 'UP' ? T.green : 'rgb(var(--hv-line))' }} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold" style={{ color: T.text }}>{name} <span className="text-xs font-normal" style={{ color: T.dim }}>{d.state === 'UP' ? 'connected' : d.state.toLowerCase()}</span></div>
                      <div className="text-xs font-mono" style={{ color: T.text2 }}>{d.ip || 'no address'} <span style={{ color: T.faint }}>{d.mac || ''}</span></div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>

        {/* Settings */}
        <Card title="Change settings">
          {nm && !nm.supported && (
            <p className="text-sm mb-3 rounded-lg border px-3 py-2" style={{ color: T.warn, borderColor: 'rgb(var(--hv-text-3))' }}>This Pi doesn't use NetworkManager, so these settings can't be applied from here.</p>
          )}
          {nm?.supported && nm.helperInstalled === false && (
            <p className="text-sm mb-3 rounded-lg border px-3 py-2" style={{ color: T.warn, borderColor: 'rgb(var(--hv-text-3))' }}>The network helper isn't installed on this Pi yet. It's added by the Aether update; until then Apply is disabled.</p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <label className="block"><span className="block text-xs mb-1" style={{ color: T.text2 }}>Hostname</span>
              <input className={`${inputCls} font-mono`} style={{ ...inputStyle, borderColor: hostOk ? T.line2 : T.crit }} value={form.hostname} onChange={f('hostname')} placeholder="aether" /></label>
            <label className="block"><span className="block text-xs mb-1" style={{ color: T.text2 }}>Interface</span>
              <select className={inputCls} style={inputStyle} value={iface} onChange={e => { setIface(e.target.value); load(e.target.value); }}>{ifaces.map(i => <option key={i}>{i}</option>)}</select></label>
          </div>

          <div className="mt-4">
            <span className="block text-xs mb-1" style={{ color: T.text2 }}>Address</span>
            <div className="inline-flex p-0.5 rounded-md" style={{ background: T.input }}>
              {(['dhcp', 'static'] as const).map(m => (
                <button key={m} onClick={() => setForm(p => ({ ...p, mode: m }))} className="px-3 py-1.5 rounded text-sm font-semibold"
                  style={form.mode === m ? { background: 'rgb(var(--hv-success-tint-strong))', color: 'rgb(var(--hv-success-text))' } : { color: T.dim }}>{m === 'dhcp' ? 'Automatic (DHCP)' : 'Static'}</button>
              ))}
            </div>
          </div>

          {form.mode === 'static' && (
            <div className="grid grid-cols-6 gap-3 mt-3">
              <label className="col-span-4 block"><span className="block text-xs mb-1" style={{ color: T.text2 }}>IP address</span>
                <input className={`${inputCls} font-mono`} style={{ ...inputStyle, borderColor: form.ip && !IP_RE.test(form.ip) ? T.crit : T.line2 }} value={form.ip} onChange={f('ip')} placeholder="192.168.1.207" /></label>
              <label className="col-span-2 block"><span className="block text-xs mb-1" style={{ color: T.text2 }}>Subnet</span>
                <select className={inputCls} style={inputStyle} value={form.prefix} onChange={f('prefix')}>
                  {[['8', '255.0.0.0'], ['16', '255.255.0.0'], ['24', '255.255.255.0'], ['25', '255.255.255.128'], ['26', '255.255.255.192'], ['27', '255.255.255.224'], ['28', '255.255.255.240']].map(([p, m]) => <option key={p} value={p}>/{p} · {m}</option>)}
                </select></label>
              <label className="col-span-3 block"><span className="block text-xs mb-1" style={{ color: T.text2 }}>Gateway</span>
                <input className={`${inputCls} font-mono`} style={{ ...inputStyle, borderColor: form.gateway && !IP_RE.test(form.gateway) ? T.crit : T.line2 }} value={form.gateway} onChange={f('gateway')} placeholder="192.168.1.1" /></label>
              <label className="col-span-3 block"><span className="block text-xs mb-1" style={{ color: T.text2 }}>DNS servers</span>
                <input className={`${inputCls} font-mono`} style={inputStyle} value={form.dns} onChange={f('dns')} placeholder="1.1.1.1 8.8.8.8" /></label>
            </div>
          )}

          {msg && (
            <div className="mt-4 rounded-lg border px-3 py-2 text-sm flex gap-2" style={{ color: msg.tone === 'ok' ? 'rgb(var(--hv-success-text))' : msg.tone === 'err' ? 'rgb(var(--hv-error-text))' : T.warn, borderColor: msg.tone === 'ok' ? 'rgb(var(--hv-success-strong))' : msg.tone === 'err' ? 'rgb(var(--hv-error-hover))' : 'rgb(var(--hv-text-3))' }}>
              {msg.tone === 'ok' ? <CheckCircle size={16} className="shrink-0 mt-0.5" /> : <AlertTriangle size={16} className="shrink-0 mt-0.5" />}<span>{msg.text}</span>
            </div>
          )}

          <div className="flex items-center justify-between gap-3 mt-4">
            <p className="text-[11px]" style={{ color: T.dim }}>If you can't reach the Pi afterwards, it switches back by itself after 90 s.</p>
            <Btn tone="primary" disabled={!canApply || busy} onClick={() => setConfirmOpen(true)}>{busy ? <Loader2 size={14} className="animate-spin" /> : null}Apply</Btn>
          </div>
        </Card>
      </div>

      <TrafficChart api={api} />

      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setConfirmOpen(false)}>
          <div className="w-full max-w-md rounded-xl border p-5" style={{ background: 'rgb(var(--hv-widget-panel))', borderColor: 'rgb(var(--hv-line-strong))' }} onClick={e => e.stopPropagation()}>
            <h3 className="font-bold mb-2" style={{ color: T.text }}>Apply network settings?</h3>
            <ul className="text-sm space-y-1 mb-4" style={{ color: T.text2 }}>
              <li>{iface}: {form.mode === 'dhcp' ? 'automatic address (DHCP). The address may change.' : <>static <span className="font-mono">{form.ip}/{form.prefix}</span>{form.gateway && <>, gateway <span className="font-mono">{form.gateway}</span></>}</>}</li>
              {form.hostname && form.hostname !== status?.hostname && <li>Hostname becomes <span className="font-mono">{form.hostname}</span></li>}
              <li>The connection drops for a few seconds. You then have 90 s to press Keep, or the old settings come back.</li>
            </ul>
            <div className="flex justify-end gap-2">
              <Btn onClick={() => setConfirmOpen(false)}>Cancel</Btn>
              <Btn tone="primary" onClick={apply}>Apply</Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
