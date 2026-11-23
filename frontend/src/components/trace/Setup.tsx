// AETHER_TRACE — Event Trace › Setup
import React, { useEffect, useState } from 'react';
import { Cloud, LogIn, LogOut, RefreshCw, Send, Plus, Trash2, Shield, Waypoints, Fingerprint, Gauge, ListChecks, Save, Loader2, Cable, Megaphone } from 'lucide-react';
import { Badge, Button, Field, Input, Select, Toggle, cx } from '../sunapi/ui';
import { fmtMs, ROLE_LABEL, type Inventory, type OnCafeSession, type SeenChannel, type Settings, type Status, type TraceApi, type Wiring, wiringVersion } from './api';

const Card: React.FC<{ icon: React.ReactNode; title: string; sub?: React.ReactNode; right?: React.ReactNode; children: React.ReactNode }> = ({ icon, title, sub, right, children }) => (
  <section className="rounded-hv-sm bg-hv-widget-panel ring-1 ring-hv-line">
    <header className="flex items-center gap-2 px-4 py-2.5 border-b border-hv-line">
      <span className="text-hv-text-3">{icon}</span>
      <div className="min-w-0">
        <div className="text-sm font-semibold text-hv-text">{title}</div>
        {sub && <div className="text-[11px] text-hv-text-3">{sub}</div>}
      </div>
      <span className="ml-auto" />{right}
    </header>
    <div className="p-4 space-y-3">{children}</div>
  </section>
);

export const SetupPanel: React.FC<{ api: TraceApi; status: Status; onSaved: () => void }> = ({ api, status, onSaved }) => {
  const [s, setS] = useState<Settings>(status.settings);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [session, setSession] = useState<OnCafeSession | null>(null);
  const [login, setLogin] = useState({ user: '', pass: '' });
  const [busy, setBusy] = useState<string | null>(null);
  const [inv, setInv] = useState<Inventory | null>(null);
  const [ipText, setIpText] = useState(status.settings.wire.controllerIps.join(', '));
  const cloud = status.sources.cloud;

  const upd = (f: (x: Settings) => Settings) => { setS(x => f(structuredClone(x))); setDirty(true); };
  const save = async (next?: Settings) => {
    setSaving(true); setErr(null);
    try {
      const body = next || { ...s, wire: { controllerIps: ipText.split(/[\s,]+/).filter(Boolean) } };
      const r = await api.saveSettings(body); setS(r); setIpText(r.wire.controllerIps.join(', ')); setDirty(false); onSaved();
      return r;
    } catch (e) { setErr((e as Error).message); return null; } finally { setSaving(false); }
  };

  const loadSession = async (url = s.cloud.url) => {
    if (!/oncafe\.hanwhavision\.cloud/.test(url)) { setSession(null); return; }
    try { const r = await api.oncafeSession(url); setSession(r); if (r.signedIn && r.org && !s.cloud.org) upd(x => { x.cloud.org = r.org!; return x; }); }
    catch (e) { setSession({ signedIn: false, error: (e as Error).message }); }
  };
  useEffect(() => { loadSession(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const signin = async () => {
    setBusy('signin'); setErr(null);
    try { const r = await api.oncafeSignin(s.cloud.url, login.user, login.pass); setSession(r); setLogin({ user: login.user, pass: '' }); if (r.org) upd(x => { x.cloud.org = x.cloud.org || r.org!; return x; }); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };
  const signout = async () => { setBusy('signout'); try { setSession(await api.oncafeSignout(s.cloud.url)); } catch (e) { setErr((e as Error).message); } finally { setBusy(null); } };
  const loadInv = async () => {
    setBusy('inv'); setErr(null);
    try { setInv(await api.inventory(s.cloud.url, s.cloud.org)); } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };
  useEffect(() => { if (session?.signedIn && s.cloud.org && !inv) loadInv(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [session?.signedIn, s.cloud.org]);
  const connect = async () => {
    setBusy('connect'); setErr(null);
    try { if (dirty) await save(); await api.connect(); onSaved(); } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };
  const disconnect = async () => { setBusy('disconnect'); try { await api.disconnect(); onSaved(); } finally { setBusy(null); } };
  const sendSync = async () => {
    setBusy('sync'); setErr(null);
    try { if (dirty) await save(); await api.sync('check'); } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };
  const toggleIn = (list: string[], id: string) => (list.includes(id) ? list.filter(x => x !== id) : [...list, id]);
  const ch = s.sync.channel;
  const pulse = ch.kind === 'relay' || ch.kind === 'emu-in';
  const doorsKnown = inv ? inv.doors : status.inventory ? status.inventory.doors : [];
  const readers = ch.kind === 'wiegand' ? status.channels.wiegand : ch.kind === 'osdp' ? status.channels.osdp : [];
  const pushTone = cloud.push.state === 'connected' ? 'success' : cloud.push.state === 'off' ? 'neutral' : cloud.push.error ? 'error' : 'warning';

  return (
    <div className="space-y-4 pb-20 max-w-[1100px]">
      {/* OnCAFE */}
      <Card icon={<Cloud size={16} />} title="OnCAFE (cloud)" sub="The same live feed the OnCAFE web app uses, plus the event log. Uses this Pi's OnCAFE sign-in."
        right={<div className="flex items-center gap-2">
          <Badge tone={pushTone}>push {cloud.push.state}</Badge>
          {cloud.api.enabled && <Badge tone={cloud.api.state === 'running' ? 'success' : cloud.api.state === 'error' ? 'error' : 'neutral'}>event log {cloud.api.state}</Badge>}
          {cloud.push.state === 'off'
            ? <Button size="sm" tone="primary" busy={busy === 'connect'} disabled={!session?.signedIn || !s.cloud.org || !s.cloud.controllers.length} onClick={connect}>Connect</Button>
            : <Button size="sm" busy={busy === 'disconnect'} onClick={disconnect}>Disconnect</Button>}
        </div>}>
        <div className="grid grid-cols-[1fr_auto] gap-3 items-end">
          <Field label="OnCAFE address" hint="For example https://qa.oncafe.hanwhavision.cloud">
            <Input value={s.cloud.url} placeholder="https://oncafe.hanwhavision.cloud" onChange={e => upd(x => { x.cloud.url = e.target.value; return x; })} onBlur={() => loadSession()} />
          </Field>
          {session?.signedIn && <Button size="md" icon={<LogOut size={13} />} busy={busy === 'signout'} onClick={signout}>Sign out {session.user}</Button>}
        </div>
        {session && !session.signedIn && /oncafe\.hanwhavision\.cloud/.test(s.cloud.url) && (
          <div className="grid grid-cols-[1fr_1fr_auto] gap-3 items-end">
            <Field label="OnCAFE username"><Input value={login.user} autoComplete="username" onChange={e => setLogin(l => ({ ...l, user: e.target.value }))} /></Field>
            <Field label="Password" hint="Used once for the sign-in; only the refresh token is kept on the Pi (48 h)."><Input type="password" autoComplete="current-password" value={login.pass} onChange={e => setLogin(l => ({ ...l, pass: e.target.value }))} onKeyDown={e => { if (e.key === 'Enter') signin(); }} /></Field>
            <Button tone="primary" icon={<LogIn size={14} />} busy={busy === 'signin'} disabled={!login.user || !login.pass} onClick={signin}>Sign in</Button>
          </div>
        )}
        {session?.signedIn && (
          <>
            <div className="grid grid-cols-[1fr_auto] gap-3 items-end">
              <Field label="Organisation">
                <Select value={s.cloud.org} onChange={e => { upd(x => { x.cloud.org = e.target.value; x.cloud.controllers = []; x.cloud.doors = []; x.cloud.zones = []; return x; }); setInv(null); }}>
                  <option value="">Pick…</option>{(session.orgs || []).map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                </Select>
              </Field>
              <Button icon={<RefreshCw size={13} />} busy={busy === 'inv'} disabled={!s.cloud.org} onClick={loadInv}>Load controllers and doors</Button>
            </div>
            {inv && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-xs font-semibold text-hv-text-2 mb-1">Controllers to follow live <span className="font-normal text-hv-text-3">(d/rt-events and d/settings)</span></div>
                  <div className="max-h-48 overflow-auto rounded-hv-xs ring-1 ring-inset ring-hv-line divide-y divide-hv-line">
                    {inv.controllers.map(c => (
                      <label key={c.id} className="flex items-center gap-2 px-2 py-1 text-xs cursor-pointer hover:bg-hv-widget">
                        <input type="checkbox" checked={s.cloud.controllers.includes(c.id)} onChange={() => upd(x => { x.cloud.controllers = toggleIn(x.cloud.controllers, c.id); return x; })} />
                        <span className="text-hv-text truncate">{c.name}</span><span className="text-hv-text-3 truncate">{c.model}</span>
                        <span className={cx('ml-auto text-[10px]', /online/i.test(c.status) ? 'text-hv-success-fg' : 'text-hv-text-3')}>{c.status}</span>
                      </label>
                    ))}
                    {!inv.controllers.length && <div className="px-2 py-2 text-xs text-hv-text-3">No controllers in this organisation.</div>}
                  </div>
                </div>
                <div>
                  <div className="text-xs font-semibold text-hv-text-2 mb-1">Doors under test <span className="font-normal text-hv-text-3">(event log check)</span></div>
                  <div className="max-h-48 overflow-auto rounded-hv-xs ring-1 ring-inset ring-hv-line divide-y divide-hv-line">
                    {inv.doors.filter(d => !s.cloud.controllers.length || s.cloud.controllers.includes(d.controllerId)).map(d => (
                      <label key={d.id} className="flex items-center gap-2 px-2 py-1 text-xs cursor-pointer hover:bg-hv-widget">
                        <input type="checkbox" checked={s.cloud.doors.includes(d.id)} onChange={() => upd(x => { x.cloud.doors = toggleIn(x.cloud.doors, d.id); return x; })} />
                        <span className="text-hv-text truncate">{d.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            )}
            {inv && inv.zones.length > 0 && (
              <div>
                <div className="text-xs font-semibold text-hv-text-2 mb-1">Zones under test <span className="font-normal text-hv-text-3">(the only zones Commands may change)</span></div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 max-h-24 overflow-auto rounded-hv-xs ring-1 ring-inset ring-hv-line px-2 py-1">
                  {inv.zones.map(z => (
                    <label key={z.id} className="flex items-center gap-1.5 text-xs cursor-pointer">
                      <input type="checkbox" checked={s.cloud.zones.includes(z.id)} onChange={() => upd(x => { x.cloud.zones = toggleIn(x.cloud.zones, z.id); return x; })} />
                      <span className="text-hv-text">{z.name}</span><span className="text-hv-text-3">{z.type}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-4">
              <Toggle on={s.cloud.poll} onChange={v => upd(x => { x.cloud.poll = v; return x; })} label="Also watch the event log (API)" />
              <label className="flex items-center gap-2 text-xs text-hv-text-2">every
                <Input className="w-20" type="number" min={1} max={30} value={s.cloud.pollMs / 1000} onChange={e => upd(x => { x.cloud.pollMs = Math.round(Number(e.target.value) * 1000) || 2000; return x; })} /> s
              </label>
              <Toggle on={s.cloud.autoConnect} onChange={v => upd(x => { x.cloud.autoConnect = v; return x; })} label="Connect when Aether starts" />
            </div>
          </>
        )}
        {cloud.push.state !== 'off' && (
          <div className="text-[11px] text-hv-text-3 space-y-0.5">
            <div>{cloud.push.host ? <>Broker <span className="font-mono">{cloud.push.host}</span> · </> : null}{cloud.push.acked.filter(a => a.ok).length}/{cloud.push.topics.length} topics · {cloud.push.received} messages{cloud.push.lastAt ? ` · last ${new Date(cloud.push.lastAt).toLocaleTimeString()}` : ''}{cloud.push.tokenExpiry ? ` · token renews before ${new Date(cloud.push.tokenExpiry).toLocaleString()}` : ''}</div>
            {cloud.push.error && <div className="text-hv-error-fg">{cloud.push.error}</div>}
            {cloud.api.error && <div className="text-hv-error-fg">Event log: {cloud.api.error}</div>}
          </div>
        )}
      </Card>

      {/* Sync cards */}
      <Card icon={<Fingerprint size={16} />} title="Sync markers" sub="Two known cards with a fixed gap — or one DPS / REX pulse — mark the start (and end) of a run, so controller timestamps line up with the Pi's clock."
        right={<Button size="sm" icon={<Send size={13} />} busy={busy === 'sync' || status.syncBusy} onClick={sendSync}>Send now</Button>}>
        {pulse ? (
          <div className="rounded-hv-xs bg-hv-info-tint text-hv-info-fg ring-1 ring-inset ring-hv-info/40 px-3 py-2 text-xs">
            Aether turns the input on, waits, and turns it off. The controller's open / closed (or REX) events for that pulse give the clock offset — no enrolled cards needed. Map the channel in Wiring with its door.
          </div>
        ) : <div className="rounded-hv-xs bg-hv-info-tint text-hv-info-fg ring-1 ring-inset ring-hv-info/40 px-3 py-2 text-xs">
          Enrol both cards in OnCAFE with access to the test door. A granted card is always published; an unknown card may not be (NHP does not publish anonymous grants). If the cloud leaves card numbers out, the gap between the two cards still identifies them.
        </div>}
        <div className="grid grid-cols-4 gap-3">
          <Field label="Send through">
            <Select value={ch.kind} onChange={e => upd(x => { x.sync.channel.kind = e.target.value as Settings['sync']['channel']['kind']; x.sync.channel.readerId = ''; return x; })}>
              <option value="wiegand">Wiegand output (cards)</option><option value="osdp">OSDP reader (cards)</option><option value="emu">Emulated board reader (cards)</option>
              <option value="relay" disabled={!status.channels.relay}>Relay pulse on a DPS / REX input</option><option value="emu-in">Emulated board input pulse</option>
            </Select>
          </Field>
          {ch.kind === 'relay' ? (
            <Field label="Relay" hint={`relay:${ch.relay} must be mapped (Wiring)`}><Input type="number" min={0} max={63} value={ch.relay} onChange={e => upd(x => { x.sync.channel.relay = Number(e.target.value); return x; })} /></Field>
          ) : ch.kind === 'emu-in' ? (
            <>
              <Field label="Board address"><Input type="number" min={0} max={126} value={ch.address} onChange={e => upd(x => { x.sync.channel.address = Number(e.target.value); return x; })} /></Field>
              <Field label="Input" hint={`emu:${ch.address}:in:${ch.input} must be mapped`}><Input type="number" min={0} max={31} value={ch.input} onChange={e => upd(x => { x.sync.channel.input = Number(e.target.value); return x; })} /></Field>
            </>
          ) : ch.kind !== 'emu' ? (
            <Field label="Reader">
              <Select value={ch.readerId} onChange={e => upd(x => { x.sync.channel.readerId = e.target.value; return x; })}>
                <option value="">{readers.length ? 'Pick…' : 'none running'}</option>{readers.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              </Select>
            </Field>
          ) : (
            <>
              <Field label="Board address"><Input type="number" min={0} max={126} value={ch.address} onChange={e => upd(x => { x.sync.channel.address = Number(e.target.value); return x; })} /></Field>
              <Field label="Reader port"><Input type="number" min={0} max={7} value={ch.port} onChange={e => upd(x => { x.sync.channel.port = Number(e.target.value); return x; })} /></Field>
            </>
          )}
          {!pulse && <Field label="Card format" hint="Aether format id, e.g. w26, h10302"><Input mono value={s.sync.format} onChange={e => upd(x => { x.sync.format = e.target.value; return x; })} /></Field>}
        </div>
        {pulse ? (
          <div className="grid grid-cols-2 gap-3 text-xs">
            <Field label="On for (s)" hint="door open / REX pressed"><Input type="number" step={0.5} min={0.5} value={(s.sync.gapsMs[0] ?? 2000) / 1000} onChange={e => upd(x => { x.sync.gapsMs[0] = Math.round(Number(e.target.value) * 1000); return x; })} /></Field>
            <Field label="Then wait (s)"><Input type="number" step={0.5} min={0.5} value={(s.sync.gapsMs[1] ?? 2000) / 1000} onChange={e => upd(x => { x.sync.gapsMs[1] = Math.round(Number(e.target.value) * 1000); return x; })} /></Field>
          </div>
        ) : <div className="grid grid-cols-[auto_1fr_1fr_1fr] gap-x-3 gap-y-2 items-center text-xs">
          <span /><span className="text-hv-text-3">Facility</span><span className="text-hv-text-3">Card number</span><span className="text-hv-text-3">Wait after</span>
          {s.sync.cards.map((c, i) => (
            <React.Fragment key={i}>
              <span className="text-hv-text-2">Card {i + 1}</span>
              <Input mono type="number" value={c.fc} onChange={e => upd(x => { x.sync.cards[i].fc = Number(e.target.value); return x; })} />
              <Input mono value={c.cn} onChange={e => upd(x => { x.sync.cards[i].cn = e.target.value.replace(/\D/g, ''); return x; })} />
              <div className="flex items-center gap-1"><Input type="number" step={0.5} min={0.5} value={(s.sync.gapsMs[i] ?? 2000) / 1000} onChange={e => upd(x => { x.sync.gapsMs[i] = Math.round(Number(e.target.value) * 1000); return x; })} /><span className="text-hv-text-3">s</span></div>
            </React.Fragment>
          ))}
        </div>}
        <div className="flex flex-wrap items-center gap-4">
          <Toggle on={s.sync.atStart} onChange={v => upd(x => { x.sync.atStart = v; return x; })} label="At the start of a run" />
          <Toggle on={s.sync.atEnd} onChange={v => upd(x => { x.sync.atEnd = v; return x; })} label="At the end (measures drift)" />
          <label className="flex items-center gap-2 text-xs text-hv-text-2 whitespace-nowrap">and every
            <Input className="w-20" type="number" min={0} max={240} value={s.sync.everyMin} onChange={e => upd(x => { x.sync.everyMin = Number(e.target.value); return x; })} /> min (0 = off)
          </label>
        </div>
      </Card>

      {/* Wire */}
      <Card icon={<Waypoints size={16} />} title="Wire (Traffic Inspector)" sub="Controller addresses whose traffic marks the moment an event leaves the controller.">
        <Field label="Controller IP addresses" hint={<>Live: put the controller behind the Pi with Traffic Inspector › Setup › Gateway (encrypted MQTT is fine — only the timing is used). After the fact: import a packet capture into a run (switch mirror + Packet capture adds no hop). {status.sources.wire.traffic ? <>Traffic Inspector is <b>{status.sources.wire.traffic.state}</b>{status.sources.wire.traffic.gateway ? ' with gateway mode' : ''}.</> : 'Traffic Inspector is not installed.'}</>}>
          <Input mono value={ipText} placeholder="192.168.1.50, 192.168.1.51" onChange={e => { setIpText(e.target.value); setDirty(true); }} />
        </Field>
      </Card>

      <WiringCard api={api} status={status} doors={doorsKnown} />

      {/* Commands */}
      <Card icon={<Megaphone size={16} />} title="Commands" sub="Let Aether send door, area and zone commands to OnCAFE (temporary unlock, lockdown, maintenance, shunt, zones) and trace them to the door.">
        <Toggle on={s.commands.enabled} onChange={v => upd(x => { x.commands.enabled = v; return x; })} label="Allow commands from Event Trace (admins only)" />
        <div className="text-xs text-hv-text-3">Commands change real doors through the Pi's OnCAFE account and appear in OnCAFE's audit log. They only go to the doors under test (and their areas); each one asks for confirmation and can be turned back automatically. Commands sent from the OnCAFE web app are traced too when that PC goes through the Traffic Inspector or you add a HAR to a run.</div>
      </Card>

      {/* Expectations */}
      <Card icon={<ListChecks size={16} />} title="Expected results" sub="Known cards and what the controller should decide. A different decision fails the trace."
        right={<Button size="sm" icon={<Plus size={13} />} onClick={() => upd(x => { x.expectations.push({ fc: '', cn: '', expect: 'grant', note: '' }); return x; })}>Add card</Button>}>
        {!s.expectations.length ? <div className="text-xs text-hv-text-3">None yet. Without expectations a trace passes on any decision.</div> : (
          <div className="grid grid-cols-[100px_1fr_120px_1fr_28px] gap-2 items-center text-xs">
            <span className="text-hv-text-3">Facility</span><span className="text-hv-text-3">Card number</span><span className="text-hv-text-3">Should be</span><span className="text-hv-text-3">Note</span><span />
            {s.expectations.map((x, i) => (
              <React.Fragment key={i}>
                <Input mono value={x.fc} placeholder="any" onChange={e => upd(y => { y.expectations[i].fc = e.target.value.replace(/\D/g, ''); return y; })} />
                <Input mono value={x.cn} onChange={e => upd(y => { y.expectations[i].cn = e.target.value.replace(/\D/g, ''); return y; })} />
                <Select value={x.expect} onChange={e => upd(y => { y.expectations[i].expect = e.target.value as 'grant' | 'deny'; return y; })}><option value="grant">granted</option><option value="deny">denied</option></Select>
                <Input value={x.note} placeholder="e.g. expired card" onChange={e => upd(y => { y.expectations[i].note = e.target.value; return y; })} />
                <button className="text-hv-text-3 hover:text-hv-error-fg" aria-label="Remove" onClick={() => upd(y => { y.expectations.splice(i, 1); return y; })}><Trash2 size={14} /></button>
              </React.Fragment>
            ))}
          </div>
        )}
      </Card>

      {/* Thresholds + privacy */}
      <div className="grid grid-cols-2 gap-4">
        <Card icon={<Gauge size={16} />} title="Limits">
          <div className="grid grid-cols-2 gap-3">
            {([['decisionWarn', 'Decision: warn after'], ['decisionFail', 'Decision: fail after'], ['pushWarn', 'Cloud push: warn after'], ['pushFail', 'Cloud push: fail after'], ['matchWindowMs', 'Give up waiting after']] as const).map(([k, l]) => (
              <Field key={k} label={l} hint={fmtMs(s.thresholds[k])}>
                <Input type="number" min={50} value={s.thresholds[k]} onChange={e => upd(x => { x.thresholds[k] = Number(e.target.value); return x; })} />
              </Field>
            ))}
          </div>
        </Card>
        <Card icon={<Shield size={16} />} title="Privacy" sub="Tokens, passwords, PINs and signed URLs are removed from everything shown and stored.">
          <Toggle on={s.allowRaw} onChange={v => upd(x => { x.allowRaw = v; return x; })} label="Allow “Show plain text” on an event" />
          <div className="text-xs text-hv-text-3">Plain text is never shown by default. When allowed, it opens for one event at a time, hides itself after 60 s, and every look is recorded on the Pi with the Aether user. Originals are kept in the run folder, readable only by the Aether service.</div>
        </Card>
      </div>

      <div className={cx('sticky bottom-0 flex items-center gap-3 px-4 py-3 rounded-hv-sm ring-1 ring-hv-line bg-hv-popup-panel shadow-hv-2 transition-opacity', dirty || err ? 'opacity-100' : 'opacity-0 pointer-events-none')}>
        {err ? <span className="text-xs text-hv-error-fg flex-1">{err}</span> : <span className="text-xs text-hv-text-2 flex-1">Unsaved changes</span>}
        {saving && <Loader2 size={14} className="animate-spin text-hv-text-3" />}
        <Button size="sm" tone="ghost" disabled={!dirty} onClick={() => { setS(status.settings); setIpText(status.settings.wire.controllerIps.join(', ')); setDirty(false); setErr(null); }}>Discard</Button>
        <Button size="sm" tone="primary" icon={<Save size={13} />} disabled={!dirty} busy={saving} onClick={() => save()}>Save</Button>
      </div>
    </div>
  );
};

const PinTag: React.FC<{ onReset: () => void }> = ({ onReset }) => (
  <span className="ml-1 text-[10px] text-hv-warning-fg" title="Changed here, so saving the door no longer overwrites it">edited · <button className="underline hover:text-hv-text" onClick={onReset}>use door's</button></span>
);

const DRIVE_ROLES = ['dps', 'rex', 'input', 'ignore'];
const OBSERVE_ROLES = ['lock', 'output', 'ignore'];
const isDrive = (kind: string) => ['relay', 'gpio', 'emu-in', 'door-in'].includes(kind);

/** Wiring map editor — the same map Log Analytics › Product Test uses. */
export const WiringCard: React.FC<{ api: TraceApi; status: Status; doors: { id: string; name: string }[] }> = ({ api, status, doors }) => {
  const [w, setW] = useState<Wiring>(status.wiring || {});
  const [seen, setSeen] = useState<SeenChannel[]>([]);
  const [extra, setExtra] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [base, setBase] = useState<number>(wiringVersion(status.wiring || {}));
  const load = () => api.wiring().then(r => { setW(r.wiring); setBase(wiringVersion(r.wiring)); setSeen(r.channels); setDirty(false); setMsg(null); }).catch(e => setMsg(e.message));
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  const rows = [...new Set([...seen.map(c => c.ch), ...Object.keys(w)])].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const info = (ch: string) => seen.find(c => c.ch === ch);
  const kindOf = (ch: string) => info(ch)?.kind || (w[ch]?.dir === 'out' ? 'door-out' : w[ch]?.dir === 'in' ? 'door-in' : /^(relay|gpio):|:in:/.test(ch) ? 'relay' : 'opto');
  const set = (ch: string, patch: Partial<Wiring[string]> | null) => {
    setW(x => { const n = { ...x }; if (patch === null) delete n[ch]; else n[ch] = { ...(n[ch] || { role: isDrive(kindOf(ch)) ? 'dps' : 'lock' }), ...patch }; return n; });
    setDirty(true);
  };
  const save = async () => { setBusy(true); setMsg(null); try { const r = await api.saveWiring(w, base); setW(r.wiring); setBase(wiringVersion(r.wiring)); setDirty(false); setMsg(Object.values(r.wiring).some(e => e.src) ? 'Saved — door pairings go back to the Doors page; Product Test uses the same map.' : 'Saved — Log Analytics › Product Test uses the same map.'); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); } };
  return (
    <Card icon={<Cable size={16} />} title="Wiring" sub="What each Aether channel is wired to. Doors from the Doors page fill this in (and get your changes back — the last save wins). Shared with Log Analytics › Product Test."
      right={<div className="flex items-center gap-2">{msg && <span className="text-[11px] text-hv-text-3">{msg}</span>}<Button size="sm" icon={<RefreshCw size={13} />} onClick={load}>Refresh</Button><Button size="sm" tone="primary" icon={<Save size={13} />} disabled={!dirty} busy={busy} onClick={save}>Save wiring</Button></div>}>
      {!rows.length ? <div className="text-xs text-hv-text-3">No relays, inputs or outputs used in the last 24 h. Add a channel by name (relay:6, opto:2, emu:2:in:3, emu:2:out:0).</div> : (
        <div className="grid grid-cols-[minmax(130px,1.1fr)_100px_170px_minmax(0,1fr)_130px_minmax(0,1fr)_28px] gap-2 items-center text-xs">
          <span className="text-hv-text-3">Channel</span><span className="text-hv-text-3">Direction</span><span className="text-hv-text-3">Role</span><span className="text-hv-text-3">Door</span><span className="text-hv-text-3">DPS on means</span><span className="text-hv-text-3">Guess / description</span><span />
          {rows.map(ch => {
            const i = info(ch), m = w[ch], drive = isDrive(kindOf(ch));
            return (
              <React.Fragment key={ch}>
                {m?.src && /^door:/.test(ch)
                  ? <span className="text-hv-text truncate" title={`${ch} — from the Doors page`}>{m.label || ch}<span className="ml-1 text-[10px] text-hv-info-fg">Doors page</span>{m.pin ? <PinTag onReset={() => set(ch, { reset: true, pin: undefined })} /> : null}</span>
                  : <span className="font-mono text-hv-text truncate" title={m?.via ? `Wired to ${m.doorName || 'a door'} — traced as ${m.via} while the door reports; Product Test and sync pulses use this wire` : i ? `${i.count} changes in 24 h` : ''}>{ch}{m?.via ? <span className="ml-1 font-sans text-[10px] text-hv-text-3">via {m.doorName || 'door'}</span> : null}{m?.src && m.pin ? <PinTag onReset={() => set(ch, { reset: true, pin: undefined })} /> : null}</span>}
                <span className="text-hv-text-3">{drive ? 'Aether → panel' : 'panel → Aether'}</span>
                <Select value={m?.role || ''} onChange={e => set(ch, e.target.value ? { role: e.target.value } : m?.src ? { role: 'ignore' } : null)}>
                  <option value="">not mapped</option>{(drive ? DRIVE_ROLES : OBSERVE_ROLES).map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                </Select>
                <Select value={m?.door || ''} disabled={!m || m.role === 'ignore'} onChange={e => set(ch, { door: e.target.value || undefined })}>
                  <option value="">{doors.length ? 'any door' : 'load doors in OnCAFE'}</option>{doors.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                </Select>
                <Select value={m?.active || 'open'} disabled={m?.role !== 'dps'} onChange={e => set(ch, { active: e.target.value as 'open' | 'closed' })}><option value="open">door open</option><option value="closed">door closed</option></Select>
                {m?.src && /^door:/.test(ch)
                  ? <Input value={m.note || ''} placeholder="description (shared with the door)" onChange={e => set(ch, { note: e.target.value || undefined })} />
                  : <span className="text-hv-text-3 truncate" title={m?.src ? m.label : undefined}>{m?.src ? (m.label || '') : i?.inferred ? `${ROLE_LABEL[i.inferred.role] || i.inferred.role}${i.inferred.score != null ? ` (${Math.round(i.inferred.score * 100)} %)` : ''}` : ''}</span>}
                <button className="text-hv-text-3 hover:text-hv-error-fg disabled:opacity-30" disabled={!m || (!!m.src && m.role === 'ignore')} aria-label="Unmap" title={m?.src ? 'Ignore this channel (the door keeps it off until you choose “use door’s”)' : 'Unmap'} onClick={() => set(ch, m?.src ? { role: 'ignore' } : null)}><Trash2 size={14} /></button>
              </React.Fragment>
            );
          })}
        </div>
      )}
      <div className="flex items-center gap-2">
        <Input mono className="w-48" placeholder="add channel, e.g. relay:6" value={extra} onChange={e => setExtra(e.target.value.trim())} />
        <Button size="sm" icon={<Plus size={13} />} disabled={!/^[\w:.\-]{3,80}$/.test(extra)} onClick={() => { set(extra, {}); setExtra(''); }}>Add</Button>
      </div>
    </Card>
  );
};
