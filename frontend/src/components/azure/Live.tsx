// AETHER_AZURE_DEBUG — Live: read-only checks of an IC2 on the network, and the RS-485 bus as Aether sees it.
import React, { useEffect, useState } from 'react';
import { Activity, Globe, RefreshCw, ShieldCheck } from 'lucide-react';
import { Badge, Button, Input, cx, lsGet, lsSet } from '../sunapi/ui';
import { fmtMs, type AzureClient, type BusDev, type Probe } from './api';
import { Dot, Section } from './parts';

function verdict(p: Probe): { tone: 'success' | 'warning' | 'error'; lines: string[] } {
  const lines: string[] = [];
  const open = (n: number) => p.ports.find(x => x.port === n)?.open;
  const anyOpen = p.ports.some(x => x.open);
  if (!anyOpen && (p.ping.loss == null || p.ping.loss === 100)) {
    lines.push('Nothing answers at this address from the Pi. Check the IP, the cable/switch port and that the Pi is on the same network or VLAN.');
    return { tone: 'error', lines };
  }
  if (p.ping.loss === 100 && anyOpen) lines.push('Ping is blocked but TCP answers — fine, many networks drop ping.');
  if (p.ping.loss != null && p.ping.loss > 0 && p.ping.loss < 100) lines.push(`${p.ping.loss}% ping loss: a flaky link or a duplicate IP on the network.`);
  if (open(443)) lines.push(`The web page answers on 443${p.web.ok ? ` (HTTP ${p.web.status}${p.web.title ? `, "${p.web.title}"` : ''})` : ''}. Sign in at https://${p.host} to see its own status pages.`);
  else lines.push('Port 443 is closed: the IC2 web server is down or blocked. Power-cycle the controller; if it stays closed, the firmware may not have started.');
  if (p.hostname) lines.push(`The certificate names it ${p.hostname} — an IC2 (the last six characters are the end of its MAC address).`);
  if (open(22)) lines.push('SSH (22) is open. That is unusual on a field controller; check the security settings.');
  if (open(5000)) lines.push('Port 5000 is open: the controller is set to accept a Direct host link (IP-Server mode).');
  if (p.tls.ok && p.tls.validTo) {
    const left = (Date.parse(p.tls.validTo) - Date.now()) / 86400000;
    if (left < 0) lines.push(`The controller certificate expired on ${p.tls.validTo}. Browsers will warn; cloud links that check it can fail.`);
    else if (left < 30) lines.push(`The controller certificate expires in ${Math.floor(left)} days.`);
  }
  return { tone: open(443) ? 'success' : 'warning', lines };
}

export const Live: React.FC<{ api: AzureClient; suggestHost?: string | null }> = ({ api }) => {
  const [host, setHost] = useState<string>(() => lsGet('aether.azure.host', ''));
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const [p, setP] = useState<Probe | null>(null);
  const [bus, setBus] = useState<{ available: boolean; source?: string; devices?: BusDev[]; stats?: Record<string, number> } | null>(null);
  const [busErr, setBusErr] = useState('');

  const run = async () => {
    setBusy(true); setErr(''); lsSet('aether.azure.host', host.trim());
    try { setP(await api.probe(host.trim())); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const loadBus = () => api.bus().then(b => { setBus(b); setBusErr(''); }).catch(e => setBusErr(e.message));
  useEffect(() => { loadBus(); const t = setInterval(loadBus, 3000); return () => clearInterval(t); }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const v = p ? verdict(p) : null;
  return (
    <div className="flex flex-col gap-3">
      <Section title={<span className="inline-flex items-center gap-2"><Globe size={15} /> Controller on the network</span>}>
        <form className="flex items-center gap-2 flex-wrap" onSubmit={e => { e.preventDefault(); run(); }}>
          <div className="w-72 max-w-full"><Input value={host} onChange={e => setHost(e.target.value)} placeholder="IC2 address, e.g. 192.168.1.50" mono aria-label="Controller IP address or host name" /></div>
          <Button tone="primary" busy={busy} disabled={!host.trim()} type="submit" icon={<Activity size={14} />}>Check</Button>
          <span className="text-[11px] text-hv-text-3">Read-only from this Pi: ping, a TCP connect to 443 / 80 / 22 / 5000, the TLS certificate and the login page. Nothing is changed on the controller.</span>
        </form>
        {err && <div className="mt-2 text-xs text-hv-error-fg">{err}</div>}
        {p && v && (
          <div className="mt-3 flex flex-col gap-3">
            <div className={cx('rounded-hv-xs p-3 ring-1 ring-inset', v.tone === 'success' ? 'bg-hv-success-tint ring-hv-success/40' : v.tone === 'warning' ? 'bg-hv-warning-tint ring-hv-warning/40' : 'bg-hv-error-tint ring-hv-error/40')}>
              <ul className="list-disc pl-5 text-[13px] text-hv-text space-y-0.5">{v.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
            </div>
            <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))' }}>
              <div className="rounded-hv-xs ring-1 ring-inset ring-hv-line bg-hv-widget p-2 text-[12px]">
                <div className="font-semibold text-hv-text mb-1">Ping</div>
                {p.ping.ran ? <>loss {p.ping.loss ?? '—'}% · avg {p.ping.avgMs != null ? `${p.ping.avgMs} ms` : '—'}</> : <span className="text-hv-text-3">ping is not available on this Pi</span>}
              </div>
              {p.ports.map(x => (
                <div key={x.port} className="rounded-hv-xs ring-1 ring-inset ring-hv-line bg-hv-widget p-2 text-[12px]">
                  <div className="flex items-center gap-2 font-semibold text-hv-text"><Dot tone={x.open ? 'success' : 'neutral'} /> TCP {x.port}
                    <span className="ml-auto font-normal text-hv-text-3">{x.open ? fmtMs(x.ms) : x.error}</span></div>
                  <div className="text-[11px] text-hv-text-3">{x.what}</div>
                </div>
              ))}
              <div className="rounded-hv-xs ring-1 ring-inset ring-hv-line bg-hv-widget p-2 text-[12px]">
                <div className="flex items-center gap-1.5 font-semibold text-hv-text mb-1"><ShieldCheck size={13} /> TLS</div>
                {p.tls.ok ? <>
                  <div>{p.tls.protocol} · {p.tls.subject || 'no name'}</div>
                  <div className="text-[11px] text-hv-text-3">issuer {p.tls.issuer || '—'} · until {p.tls.validTo || '—'}</div>
                </> : <span className="text-hv-text-3">{p.tls.error}</span>}
              </div>
            </div>
            <div className="text-[11px] text-hv-text-3">Checked {new Date(p.at).toLocaleTimeString()} in {fmtMs(p.ms)}.</div>
          </div>
        )}
      </Section>

      <Section title={<span className="inline-flex items-center gap-2"><Activity size={15} /> RS-485 bus seen by this Pi</span>}
        right={<button onClick={loadBus} className="text-xs text-hv-text-2 inline-flex items-center gap-1 hover:text-hv-text"><RefreshCw size={12} /> Refresh</button>}>
        {busErr && <div className="text-xs text-hv-error-fg">{busErr}</div>}
        {bus && !bus.available && <div className="text-[13px] text-hv-text-3">OSDP Trace is not running in this Aether build.</div>}
        {bus && bus.available && (!bus.devices || !bus.devices.length) && (
          <div className="text-[13px] text-hv-text-3 leading-relaxed">
            No OSDP traffic yet. To watch an IC2 talk to its boards, connect Aether's RS-485 sniffer across the COM1 or COM2 pair (TR+, TR−, SG) and start it in <b>Readers › OSDP Trace</b>. Boards then appear here by address, with Azure boards identified from their PDID reply (vendor 00:60:EE).
          </div>
        )}
        {bus && bus.devices && bus.devices.length > 0 && (
          <div className="overflow-x-auto">
            <div className="text-[11px] text-hv-text-3 mb-1.5">Source: {bus.source} · refreshes every 3 s</div>
            <table className="w-full text-[12.5px]">
              <thead><tr className="text-left text-[11px] text-hv-text-3"><th className="py-1 pr-2">Address</th><th className="pr-2">Device</th><th className="pr-2 text-right">Polls</th><th className="pr-2 text-right">Replies</th><th className="pr-2 text-right">NAK</th><th className="pr-2 text-right">No reply</th><th className="pr-2 text-right">CRC errors</th><th>Last seen</th></tr></thead>
              <tbody>{bus.devices.map(d => (
                <tr key={d.address} className="border-t border-hv-line">
                  <td className="py-1 pr-2 font-mono"><span className="inline-flex items-center gap-1.5"><Dot tone={d.online ? 'success' : 'error'} />{d.address}</span></td>
                  <td className="pr-2">{d.id ? <>{d.id.azure ? <Badge tone="info">Azure</Badge> : <span className="text-hv-text-3">{d.id.vendor}</span>} <span className="text-hv-text-3">model {d.id.model} · fw {d.id.firmware}</span></> : <span className="text-hv-text-3">not identified yet</span>}</td>
                  <td className="pr-2 text-right">{d.commands}</td><td className="pr-2 text-right">{d.replies}</td>
                  <td className={cx('pr-2 text-right', d.naks > 0 && 'text-hv-warning-fg')}>{d.naks}</td>
                  <td className={cx('pr-2 text-right', d.timeouts > 0 && 'text-hv-warning-fg')}>{d.timeouts}</td>
                  <td className={cx('pr-2 text-right', d.crcErrors > 0 && 'text-hv-error-fg')}>{d.crcErrors}</td>
                  <td className="text-hv-text-3">{d.lastSeenAgoMs == null ? '—' : `${fmtMs(d.lastSeenAgoMs)} ago`}</td>
                </tr>))}</tbody>
            </table>
            <p className="text-[11px] text-hv-text-3 mt-1.5">CRC errors point at wiring, termination or a missing signal ground; no-reply at address, baud or power; NAKs at configuration.</p>
          </div>
        )}
      </Section>
    </div>
  );
};
