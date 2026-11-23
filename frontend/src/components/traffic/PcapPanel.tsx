// AETHER_TRAFFIC (TRAFFIC-2) — packet capture: every packet, every protocol, saved for Wireshark.
import React, { useEffect, useState } from 'react';
import { Play, Square, Download, Network, Waypoints, Loader2, FileSearch } from 'lucide-react';
import type { Status, TrafficClient } from './api';
import { SetupCommand } from './Setup';
import { Badge, Button, Field, Input, Segmented, Select, cx, fmtBytes, lsGet, lsSet } from '../sunapi/ui';

const Card: React.FC<{ icon?: React.ReactNode; title: string; sub?: React.ReactNode; children?: React.ReactNode }> = ({ icon, title, sub, children }) => (
  <section className="rounded-hv-sm bg-hv-surface ring-1 ring-inset ring-hv-line p-4">
    <div className={cx('flex items-start gap-2.5', children ? 'mb-3' : '')}>
      {icon && <div className="text-hv-text-3 mt-0.5">{icon}</div>}
      <div><h3 className="text-sm font-bold text-hv-text">{title}</h3>{sub && <p className="text-xs text-hv-text-3 mt-0.5 leading-relaxed">{sub}</p>}</div>
    </div>
    {children}
  </section>
);
const Code: React.FC<{ children: React.ReactNode }> = ({ children }) => <code className="font-mono text-[12px] px-1 py-0.5 rounded bg-hv-widget text-hv-text">{children}</code>;
const ago = (t: number) => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`; };

export const PcapPanel: React.FC<{ api: TrafficClient; status: Status; onChange: (s: Status) => void; onRead?: () => void }> = ({ api, status, onChange, onRead }) => {
  const p = status.pcap;
  const saved = lsGet<{ mode: 'devices' | 'all'; iface: string; devices: string; limitMB: number; minutes: number } | null>('aether.traffic.pcap', null);
  const defIface = status.addresses[0]?.iface || status.interfaces[0] || 'eth0';
  const [mode, setMode] = useState<'devices' | 'all'>(saved?.mode || 'devices');
  const [iface, setIface] = useState(saved?.iface && status.interfaces.includes(saved.iface) ? saved.iface : defIface);
  const [devices, setDevices] = useState(saved?.devices || status.settings.gateway.devices.join(', '));
  const [limitMB, setLimit] = useState(saved?.limitMB || 200);
  const [minutes, setMinutes] = useState(saved?.minutes || 60);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [, tick] = useState(0);
  useEffect(() => { if (!p.running) return; const t = setInterval(() => tick(x => x + 1), 1000); return () => clearInterval(t); }, [p.running]);
  const h = status.helper;
  const ready = !!(h && h.installed && h.current && h.tcpdump);

  const start = async () => {
    setBusy(true); setMsg(null);
    lsSet('aether.traffic.pcap', { mode, iface, devices, limitMB, minutes });
    try { onChange(await api.pcapStart({ mode, iface, devices: devices.split(/[\s,;]+/).filter(Boolean), limitMB, minutes })); }
    catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };
  const stop = async () => { setBusy(true); try { onChange(await api.pcapStop()); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); } };

  return (
    <div className="max-w-3xl space-y-4">
      <Card icon={<Waypoints size={17} />} title="Packet capture (Wireshark)"
        sub="Records every packet, any protocol — UDP, RTSP video, ONVIF, multicast, NTP, HTTPS as encrypted bytes — into a .pcap file. Read it in the Reader tab, or download it for Wireshark. Runs on its own; the capture above doesn't need to be on.">
        {!ready ? <SetupCommand status={status} what="Packet capture" /> : (
          <fieldset disabled={p.running || busy} className="space-y-3 disabled:opacity-60">
            <Segmented size="md" value={mode} onChange={setMode} items={[
              { id: 'devices', label: 'Chosen devices', title: 'Only packets to or from these IPs' },
              { id: 'all', label: 'Everything on a network port', title: 'All packets the port sees — use with a switch mirror port' },
            ]} />
            <div className="grid grid-cols-[1fr_240px] gap-3">
              {mode === 'devices'
                ? <Field label="Device IP addresses" hint="Packets to or from these. The Pi only sees a device's packets if they pass the Pi: gateway mode, a device port, or a switch mirror port."><Input mono value={devices} onChange={e => setDevices(e.target.value)} placeholder="192.168.1.101" /></Field>
                : <Field label="What it records" hint="Everything that network port sees, except Aether's own pages (3001) and SSH."><div className="h-8 flex items-center text-sm text-hv-text-2">All packets</div></Field>}
              <Field label="Network port">
                <Select value={iface} onChange={e => setIface(e.target.value)}>
                  {status.interfaces.map(i => <option key={i} value={i}>{i}{status.addresses.find(a => a.iface === i) ? ` · ${status.addresses.find(a => a.iface === i)!.address}` : ''}</option>)}
                </Select>
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3 max-w-sm">
              <Field label="Stop at size"><Select value={limitMB} onChange={e => setLimit(Number(e.target.value))}>{[50, 200, 500, 1000].map(v => <option key={v} value={v}>{v} MB</option>)}</Select></Field>
              <Field label="Stop after"><Select value={minutes} onChange={e => setMinutes(Number(e.target.value))}>{[10, 30, 60, 240, 720].map(v => <option key={v} value={v}>{v < 60 ? `${v} minutes` : `${v / 60} hour${v > 60 ? 's' : ''}`}</option>)}</Select></Field>
            </div>
          </fieldset>
        )}
        {ready && (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            {p.running
              ? <Button tone="danger-soft" icon={<Square size={13} />} busy={busy} onClick={stop}>Stop recording</Button>
              : <Button tone="primary" icon={<Play size={14} />} busy={busy} onClick={start}>Start recording</Button>}
            {p.running && p.startedAt && (
              <span className="text-xs text-hv-text-2 inline-flex items-center gap-2">
                <Loader2 size={13} className="animate-spin text-hv-success-fg" />
                Recording on <b>{p.iface}</b> for {ago(p.startedAt)} · <b>{fmtBytes(p.bytes)}</b>{p.limitMB ? ` of ${p.limitMB} MB` : ''}
              </span>
            )}
            {!p.running && p.bytes > 24 && (
              <>
                {onRead && <Button tone="primary" icon={<FileSearch size={13} />} onClick={onRead}>Open in reader</Button>}
                <Button icon={<Download size={13} />} onClick={() => api.savePcap().catch(e => setMsg(e.message))}>Download .pcap · {fmtBytes(p.bytes)}</Button>
                {p.endedAt && <Badge tone="neutral">{p.endReason ? `stopped by itself: ${p.endReason}` : 'stopped'}</Badge>}
              </>
            )}
            {msg && <span className="text-xs text-hv-error-fg">{msg}</span>}
          </div>
        )}
        <p className="mt-3 text-[11px] text-hv-text-3">The file stays on the Pi until the next recording starts. It holds whatever was sent unencrypted, including passwords on plain-HTTP logins.</p>
      </Card>

      <Card icon={<Network size={17} />} title="See a device without touching it: switch mirror port"
        sub="A managed switch can copy every packet of a device's port to another port. Plug a second network port of the Pi into that port (a USB Ethernet adapter works) and record 'Everything on a network port' on it. On most switches the mirror port carries only the copies, so don't mirror onto the Pi's normal network port.">
        <div className="text-xs text-hv-text-2 space-y-1.5">
          <div>Allied Telesis (AlliedWare Plus), device on port 5, Pi's capture adapter on port 24:</div>
          <pre className="font-mono text-[12px] leading-relaxed rounded-hv-xs bg-hv-widget px-3 py-2 text-hv-text">{`configure terminal
interface port1.0.24
 mirror interface port1.0.5 direction both
end`}</pre>
          <div>Remove it afterwards with <Code>no mirror interface port1.0.5</Code> on port1.0.24. Other brands call this "port mirroring" or "SPAN".</div>
        </div>
      </Card>
    </div>
  );
};
