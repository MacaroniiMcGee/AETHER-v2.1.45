// AETHER_TRAFFIC — Setup (what the Pi listens on) and Connect (how to point programs at it)
import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Save, Download, Monitor, Router, ShieldAlert, ArrowRight, Info, Smartphone, Network, Copy, Check } from 'lucide-react';
import type { DeviceRoute, Settings, Status, TrafficClient } from './api';
import { client as sunapiClient, defaultBackend, type Device } from '../sunapi/api';
import { Button, Field, IconButton, Input, Select, Toggle, copyText, cx, fmtBytes } from '../sunapi/ui';

const Card: React.FC<{ icon?: React.ReactNode; title: string; sub?: React.ReactNode; children?: React.ReactNode; className?: string }> = ({ icon, title, sub, children, className }) => (
  <section className={cx('rounded-hv-sm bg-hv-surface ring-1 ring-inset ring-hv-line p-4', className)}>
    <div className={cx('flex items-start gap-2.5', children ? 'mb-3' : '')}>
      {icon && <div className="text-hv-text-3 mt-0.5">{icon}</div>}
      <div><h3 className="text-sm font-bold text-hv-text">{title}</h3>{sub && <p className="text-xs text-hv-text-3 mt-0.5 leading-relaxed">{sub}</p>}</div>
    </div>
    {children}
  </section>
);

export const normalise = (s: Settings): Settings => ({
  ...s, proxyPort: Number(s.proxyPort), devices: s.devices.map(d => ({ ...d, listenPort: Number(d.listenPort) })),
  gateway: { ...s.gateway, port: Number(s.gateway.port), dnsPort: Number(s.gateway.dnsPort) },
});

const AUTO = [{ v: 30, l: '30 minutes' }, { v: 60, l: '1 hour' }, { v: 120, l: '2 hours' }, { v: 480, l: '8 hours' }, { v: 1440, l: '24 hours' }, { v: 0, l: 'Never (not recommended)' }];
const nextPort = (used: number[]) => { let p = 8443; while (used.includes(p)) p++; return p; };

/** The one-time root setup line, with a copy button. */
export const SetupCommand: React.FC<{ status: Status; what: string }> = ({ status, what }) => {
  const [copied, setCopied] = useState(false);
  const h = status.helper;
  return (
    <div className="rounded-hv-xs bg-hv-warning-tint ring-1 ring-inset ring-hv-warning/40 px-3 py-2.5 text-xs text-hv-warning-fg">
      <div className="font-semibold">{h?.installed && !h.current ? 'The root helper needs updating.' : `${what} needs a one-time root setup on the Pi.`}</div>
      <div className="mt-1 text-hv-text-2">Open a terminal on the Pi (or SSH in) and run:</div>
      <div className="mt-1.5 flex items-center gap-2">
        <code className="flex-1 font-mono text-[12px] px-2 py-1.5 rounded bg-hv-surface text-hv-text break-all">{status.setupCommand}</code>
        <IconButton label="Copy" onClick={() => copyText(status.setupCommand).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); })}>{copied ? <Check size={14} /> : <Copy size={14} />}</IconButton>
      </div>
      <div className="mt-1.5 text-hv-text-3">It installs tcpdump and a small helper that may only switch these capture rules on and off. Nothing stays after a reboot.</div>
    </div>
  );
};

export const SetupPanel: React.FC<{ api: TrafficClient; status: Status; draft: Settings | null; setDraft: (s: Settings | null) => void; onSaved: () => void }> = ({ api, status, draft, setDraft, onSaved }) => {
  const s = draft ?? status.settings;
  const setS = (v: Settings | ((x: Settings) => Settings)) => setDraft(typeof v === 'function' ? v(s) : v);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [sunapiDevices, setSunapiDevices] = useState<Device[]>([]);
  const locked = status.state === 'running' || status.state === 'starting';
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(status.settings);
  useEffect(() => { sunapiClient(defaultBackend()).devices().then(setSunapiDevices).catch(() => setSunapiDevices([])); }, []);

  const set = (p: Partial<Settings>) => { setS(x => ({ ...x, ...p })); setMsg(null); };
  const setGw = (p: Partial<Settings['gateway']>) => set({ gateway: { ...s.gateway, ...p } });
  const [gwText, setGwText] = useState(s.gateway.devices.join(', '));
  useEffect(() => { if (!draft) setGwText(status.settings.gateway.devices.join(', ')); }, [draft, status.settings.gateway.devices]);
  const setDev = (i: number, p: Partial<DeviceRoute>) => set({ devices: s.devices.map((d, j) => (j === i ? { ...d, ...p } : d)) });
  const used = [...(s.proxyEnabled ? [s.proxyPort] : []), ...s.devices.map(d => d.listenPort)];
  const addDevice = (d?: Device) => set({ devices: [...s.devices, { listenPort: nextPort(used), target: d ? `${d.https ? 'https' : 'http'}://${d.host}${d.port && d.port !== (d.https ? 443 : 80) ? ':' + d.port : ''}` : '', name: d?.name || '' }] });

  const save = async () => {
    setBusy(true);
    try { await api.saveSettings(normalise(s)); setDraft(null); setMsg({ ok: true, text: 'Saved — used the next time the capture starts' }); onSaved(); }
    catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    finally { setBusy(false); }
  };

  return (
    <div className="max-w-3xl space-y-4">
      {locked && <div className="rounded-hv-xs bg-hv-info-tint ring-1 ring-inset ring-hv-info/40 px-3 py-2 text-xs text-hv-info-fg flex items-center gap-2"><Info size={14} />Stop the capture to change these.</div>}
      <fieldset disabled={locked} className="space-y-4 disabled:opacity-60">
        <Card icon={<Router size={17} />} title="Device ports" sub="One Pi port per device. Point a program at the Pi's port instead of the device's address and every call goes through the Pi to the device. Nothing to install on the PC.">
          <div className="space-y-2">
            {s.devices.map((d, i) => (
              <div key={i} className="grid grid-cols-[1fr_92px_20px_1.4fr_28px] items-center gap-2">
                <Input placeholder="Name (optional)" value={d.name} onChange={e => setDev(i, { name: e.target.value })} aria-label="Name" />
                <Input mono type="number" value={d.listenPort} onChange={e => setDev(i, { listenPort: Number(e.target.value) })} aria-label="Pi port" title="Port on the Pi" />
                <ArrowRight size={15} className="text-hv-text-3" />
                <Input mono placeholder="https://10.0.0.20:443" value={d.target} onChange={e => setDev(i, { target: e.target.value })} aria-label="Device address" />
                <IconButton label="Remove" onClick={() => set({ devices: s.devices.filter((_, j) => j !== i) })}><Trash2 size={14} /></IconButton>
              </div>
            ))}
            {!s.devices.length && <div className="text-xs text-hv-text-3">No device ports yet.</div>}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" icon={<Plus size={13} />} onClick={() => addDevice()} disabled={s.devices.length >= 16}>Add device</Button>
            {sunapiDevices.length > 0 && (
              <Select className="!w-auto" value="" onChange={e => { const d = sunapiDevices.find(x => x.id === e.target.value); if (d) addDevice(d); }} aria-label="Add from SUNAPI Console">
                <option value="">Add from SUNAPI Console…</option>
                {sunapiDevices.map(d => <option key={d.id} value={d.id}>{d.name} · {d.host}</option>)}
              </Select>
            )}
          </div>
        </Card>

        <Card icon={<Network size={17} />} title="Gateway — everything a device sends out"
          sub="Set a device's gateway to the Pi. Every connection it opens goes through the Pi: web calls, other TCP connections (events, RTSP out, cloud), its DNS lookups, and where its HTTPS goes. See How to connect.">
          <Toggle on={s.gateway.enabled} onChange={v => setGw({ enabled: v })} label="Use gateway mode" />
          {s.gateway.enabled && (
            <div className="mt-3 space-y-3">
              {status.helper && (!status.helper.installed || !status.helper.current) && <SetupCommand status={status} what="Gateway mode" />}
              <Field label="Device IP addresses" hint="The devices whose gateway you set to the Pi. Comma separated.">
                <Input mono placeholder="192.168.1.101" value={gwText}
                  onChange={e => { setGwText(e.target.value); setGw({ devices: e.target.value.split(/[\s,;]+/).filter(Boolean) }); }} />
              </Field>
              {sunapiDevices.length > 0 && (
                <Select className="!w-auto" value="" onChange={e => { const d = sunapiDevices.find(x => x.id === e.target.value); if (d && !s.gateway.devices.includes(d.host)) { const v = [...s.gateway.devices, d.host]; setGwText(v.join(', ')); setGw({ devices: v }); } }} aria-label="Add from SUNAPI Console">
                  <option value="">Add from SUNAPI Console…</option>
                  {sunapiDevices.map(d => <option key={d.id} value={d.id}>{d.name} · {d.host}</option>)}
                </Select>
              )}
              <div>
                <Toggle on={s.gateway.decrypt} onChange={v => setGw({ decrypt: v })} label="Try to decrypt their HTTPS" />
                <p className="mt-1 text-[11px] text-hv-text-3 leading-relaxed">Off: HTTPS is passed through untouched (you see where it goes, not what's inside) and the device keeps working. On: the device is shown the Pi's certificate — most devices refuse it and those connections fail until you turn this off again.</p>
              </div>
              <div className="grid grid-cols-2 gap-4 max-w-sm">
                <Field label="Capture port"><Input mono type="number" value={s.gateway.port} onChange={e => setGw({ port: Number(e.target.value) })} /></Field>
                <Field label="DNS port (UDP)"><Input mono type="number" value={s.gateway.dnsPort} onChange={e => setGw({ dnsPort: Number(e.target.value) })} /></Field>
              </div>
            </div>
          )}
        </Card>

        <Card icon={<Monitor size={17} />} title="Proxy" sub="For programs and phones you can set a proxy on. HTTPS is only readable when that PC or phone trusts the Pi's capture certificate (see How to connect).">
          <div className="flex items-end gap-4">
            <Toggle on={s.proxyEnabled} onChange={v => set({ proxyEnabled: v })} label="Pi acts as a proxy" />
            <div className="w-28"><Field label="Port"><Input mono type="number" value={s.proxyPort} disabled={!s.proxyEnabled} onChange={e => set({ proxyPort: Number(e.target.value) })} /></Field></div>
          </div>
          <div className="mt-3">
            <Field label="Only open up these hosts" hint="Blank = every site the program visits. With a list, other sites pass through unread and are not listed (keeps Windows updates and cloud logins out). IPs or names, comma separated; 10.0.1.* works.">
              <Input mono placeholder="10.0.0.20, 10.0.1.*" value={s.onlyHosts} onChange={e => set({ onlyHosts: e.target.value })} />
            </Field>
          </div>
        </Card>

        <Card title="Limits">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Stop by itself after" hint="The proxy is open to the whole LAN while it runs."><Select value={s.autoStopMin} onChange={e => set({ autoStopMin: Number(e.target.value) })}>{AUTO.map(a => <option key={a.v} value={a.v}>{a.l}</option>)}</Select></Field>
            <Field label="Keep of each body" hint="Firmware uploads are cut to this; the request still goes through whole.">
              <Select value={s.bodyMaxKB} onChange={e => set({ bodyMaxKB: Number(e.target.value) })}>{[64, 256, 1024, 4096, 8192].map(k => <option key={k} value={k}>{fmtBytes(k * 1024)}</option>)}</Select>
            </Field>
          </div>
        </Card>
      </fieldset>
      <div className={cx('sticky bottom-0 -mx-4 px-4 py-3 flex items-center gap-3 border-t', dirty ? 'bg-hv-widget-panel border-hv-line' : 'border-transparent')}>
        <Button tone="primary" icon={<Save size={14} />} onClick={save} busy={busy} disabled={locked || !dirty}>Save</Button>
        {dirty && !locked && <><Button tone="ghost" onClick={() => { setDraft(null); setMsg(null); }}>Undo changes</Button><span className="text-xs text-hv-warning-fg">Not saved yet — Start capture saves it too</span></>}
        {msg && <span className={cx('text-xs', msg.ok ? 'text-hv-success-fg' : 'text-hv-error-fg')}>{msg.text}</span>}
      </div>
    </div>
  );
};

const Code: React.FC<{ children: React.ReactNode }> = ({ children }) => <code className="font-mono text-[12px] px-1 py-0.5 rounded bg-hv-widget text-hv-text">{children}</code>;

export const ConnectPanel: React.FC<{ api: TrafficClient; status: Status }> = ({ api, status }) => {
  const s = status.running || status.settings;
  const ips = status.addresses.map(a => a.address);
  const pi = ips[0] || window.location.hostname;
  const [err, setErr] = useState<string | null>(null);
  const get = (f: 'cer' | 'pem' | 'p12') => { setErr(null); api.saveCa(f).catch(e => setErr(e.message)); };
  const piList = useMemo(() => (ips.length > 1 ? ips.join(' or ') : pi), [ips, pi]);

  return (
    <div className="max-w-3xl space-y-4">
      <Card icon={<Router size={17} />} title="Through a device port (easiest)" sub="Use the Pi's address and port wherever the program asks for the device's address. Logins pass through unchanged.">
        {s.devices.length ? (
          <table className="w-full text-xs">
            <thead><tr className="text-left text-hv-text-3"><th className="font-semibold pb-1">Use this address</th><th className="font-semibold pb-1">instead of</th><th className="font-semibold pb-1"></th></tr></thead>
            <tbody>
              {s.devices.map(d => {
                const scheme = d.target.startsWith('http://') ? 'http' : 'https';
                return (
                  <tr key={d.listenPort} className="border-t border-hv-line">
                    <td className="py-1.5 font-mono text-hv-text">{scheme}://{pi}:{d.listenPort}</td>
                    <td className="py-1.5 font-mono text-hv-text-2">{d.target}</td>
                    <td className="py-1.5 text-hv-text-3">{d.name}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : <div className="text-xs text-hv-text-3">Add a device port in Setup first.</div>}
        <ul className="mt-3 text-xs text-hv-text-2 space-y-1 list-disc pl-4">
          <li><b>SUNAPI Test Client / browser:</b> type the Pi address and port in the device address field.</li>
          <li><b>Wisenet WAVE:</b> add the device manually with the Pi address and port. WAVE's own server makes the calls, so this works from any PC.</li>
          <li>The program sees the Pi's capture certificate instead of the device's. Tools that accept a device's self-signed certificate usually accept it too; a browser shows a warning you can click through.</li>
          <li>Only web (HTTP/HTTPS) calls go through. Video over RTSP (port 554) still goes straight to the device.</li>
        </ul>
      </Card>

      <Card icon={<Network size={17} />} title="Gateway: everything a device sends on its own" sub={s.gateway.enabled ? undefined : 'Turn on gateway mode in Setup first.'}>
        <ol className="text-xs text-hv-text-2 space-y-2 list-decimal pl-4">
          <li>Setup › Gateway: add the device's IP address, Save. The one-time root setup must be done (Setup shows the command if not).</li>
          <li>In the device's own network settings (its web page, or Hanwha's IP installer), change only the <b>Gateway</b> to <Code>{piList}</Code>. Leave its IP, mask and DNS as they are — DNS lookups to any server are caught.</li>
          <li>Start the capture. Everything the device opens toward other networks shows in Requests: <b>HTTP</b>, <b>TCP</b>, <b>DNS</b>, and <b>HTTPS</b> (where it went).</li>
        </ol>
        <ul className="mt-3 text-xs text-hv-text-2 space-y-1 list-disc pl-4">
          <li>A device talks to others <b>on its own subnet</b> directly, not through its gateway. To see that too (e.g. events to a WAVE server on the same LAN), use a packet capture with a switch mirror port, or — if the device accepts it — set its subnet mask to <Code>255.255.255.255</Code> so everything goes through the Pi.</li>
          <li>Only the device's own outgoing connections pass through the gateway. For calls other programs make <i>to</i> the device, use a device port.</li>
        </ul>
        <div className="mt-3 rounded-hv-xs bg-hv-warning-tint ring-1 ring-inset ring-hv-warning/40 px-3 py-2 text-[11.5px] text-hv-warning-fg flex gap-2">
          <ShieldAlert size={15} className="shrink-0 mt-px" />
          <span>When you're done, set the device's gateway back to your router, then press <b>Release</b>. Stopping the capture keeps the Pi forwarding so the device stays online — but if the Pi restarts while a device still points at it, that device is offline until its gateway is set back.</span>
        </div>
      </Card>

      <Card icon={<Monitor size={17} />} title="Pi as a proxy (Windows PC)" sub={s.proxyEnabled ? undefined : 'The proxy is off in Setup.'}>
        <ol className="text-xs text-hv-text-2 space-y-2 list-decimal pl-4">
          <li>Download the capture certificate and double-click it: <b>Install Certificate › Local Machine › Place all certificates in › Trusted Root Certification Authorities</b>. Without it, HTTPS calls fail instead of being read.</li>
          <li>Windows <b>Settings › Network &amp; internet › Proxy › Manual proxy setup</b>: address <Code>{piList}</Code>, port <Code>{s.proxyPort}</Code>. Some programs (and Firefox) have their own proxy setting instead.</li>
          <li>Start the capture here, then use the program. Turn the proxy off in Windows when you are done.</li>
        </ol>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" icon={<Download size={13} />} disabled={!status.caReady} onClick={() => get('cer')}>Certificate for Windows (.cer)</Button>
          <Button size="sm" tone="ghost" icon={<Download size={13} />} disabled={!status.caReady} onClick={() => get('pem')}>.pem (Linux, macOS, Firefox)</Button>
          <Button size="sm" tone="ghost" icon={<Download size={13} />} disabled={!status.caReady} onClick={() => get('p12')}>.p12</Button>
          {!status.caReady && <span className="text-[11px] text-hv-text-3">Made the first time the capture starts.</span>}
          {err && <span className="text-[11px] text-hv-error-fg">{err}</span>}
        </div>
        <div className="mt-3 rounded-hv-xs bg-hv-warning-tint ring-1 ring-inset ring-hv-warning/40 px-3 py-2 text-[11.5px] text-hv-warning-fg flex gap-2">
          <ShieldAlert size={15} className="shrink-0 mt-px" />
          <span>A PC that trusts this certificate lets this Pi read all of its HTTPS traffic while it uses the proxy. Use a test PC, and remove the certificate afterwards (<Code>certlm.msc</Code> › Trusted Root Certification Authorities › delete "mitmproxy").</span>
        </div>
      </Card>

      <Card icon={<Smartphone size={17} />} title="Phones" sub="Wi-Fi settings › the network › Proxy › Manual: the Pi address and port above. Then open the Pi's certificate on the phone and install it (Android: Settings › Security › Install a certificate › CA certificate; iPhone: install the profile, then Settings › General › About › Certificate Trust Settings). Many phone apps ignore installed certificates — their HTTPS calls fail and show as errors here."/>

      <Card title="Open a capture in desktop mitmproxy" sub="The whole session (including passwords as they were sent) is kept on the Pi until the next start. Open it with mitmweb -r file.mitm for mitmproxy's own tools.">
        <Button size="sm" icon={<Download size={13} />} disabled={!status.sessionBytes} onClick={() => { setErr(null); api.saveMitm().catch(e => setErr(e.message)); }}>
          Download session (.mitm{status.sessionBytes ? ` · ${fmtBytes(status.sessionBytes)}` : ''})
        </Button>
      </Card>
    </div>
  );
};
