import React, { useEffect, useRef, useState } from 'react';
import {
  Lock, LockOpen, DoorOpen, ShieldAlert, Clock, WifiOff, Ban, Building, Zap, Radio, Cpu, Workflow,
  ShieldCheck, AlertTriangle, CircleDot, Activity, KeyRound, XCircle, CheckCircle2, Info, BellRing,
} from 'lucide-react';
import { useStreamData, StreamModel, StreamDoor, DoorState, ZoneState, AccessEvent } from './stream/useStreamData';
import { DoorScene } from './DoorAnimation';

/**
 * Stream View — the page the ONVIF/RTSP pipeline captures for the VMS.
 *
 * Always laid out on a fixed 1920×1080 canvas (what ffmpeg records) and scaled
 * to fit whatever box it is shown in, so the in-app preview matches the VMS feed.
 * Display-only: a camera tile can't be clicked.
 *
 *   /stream                 live data from this host's backend (:3001)
 *   /stream?backend=IP      live data from another unit
 *   /stream?demo=4|8|12     generated data, for previews
 *   /stream?capture=2       RTSP capture mode (set by streaming/capture.sh):
 *                           CSS animations are paused and stepped 2×/s, so
 *                           Chromium only repaints the frames ffmpeg records.
 */

const W = 1920;
const H = 1080;

// Text and surfaces (Aether palette)
const C = {
  bg: 'rgb(var(--hv-surface))',
  panel: 'rgb(var(--hv-widget-panel))',
  panel2: 'rgb(var(--hv-widget))',
  border: 'rgb(var(--hv-line))',
  text: 'rgb(var(--hv-text))',
  text2: 'rgb(var(--hv-text-2))',
  muted: 'rgb(var(--hv-text-3))',
  // Status — each is always paired with an icon and a label
  good: 'rgb(var(--hv-success))',
  info: 'rgb(var(--hv-info))',
  warn: 'rgb(var(--hv-brand))',
  crit: 'rgb(var(--hv-error))',
  off: 'rgb(var(--hv-text-3))',
  accent: 'rgb(var(--hv-brand))',
};

const DOOR_STATUS: Record<DoorState, { label: string; color: string; Icon: React.FC<any> }> = {
  SECURE:   { label: 'Secure',   color: C.good, Icon: Lock },
  UNLOCKED: { label: 'Unlocked', color: C.info, Icon: LockOpen },
  OPEN:     { label: 'Open',     color: C.info, Icon: DoorOpen },
  HELD:     { label: 'Held Open', color: C.warn, Icon: Clock },
  FORCED:   { label: 'Forced',   color: C.crit, Icon: ShieldAlert },
  OFFLINE:  { label: 'Offline',  color: C.off,  Icon: WifiOff },
  DISABLED: { label: 'Disabled', color: C.off,  Icon: Ban },
};

const ZONE_STATUS: Record<ZoneState, { label: string; color: string }> = {
  NORMAL:  { label: 'Normal',  color: C.good },
  ALARM:   { label: 'Alarm',   color: C.warn },
  TAMPER:  { label: 'Tamper',  color: C.crit },
  TROUBLE: { label: 'Trouble', color: C.info },
  UNKNOWN: { label: '?',       color: C.off },
  ERROR:   { label: 'Error',   color: C.off },
};

function ago(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function uptime(sec: number | null) {
  if (sec == null) return '—';
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : `${h}h ${m}m`;
}

// ---------- Building blocks ----------

const Panel: React.FC<{ title: string; icon: React.FC<any>; right?: React.ReactNode; style?: React.CSSProperties; children: React.ReactNode }> =
  ({ title, icon: Icon, right, style, children }) => (
    <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 14, padding: '14px 18px', display: 'flex', flexDirection: 'column', minHeight: 0, ...style }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: C.text, fontSize: 20, fontWeight: 700, letterSpacing: 0.3 }}>
          <Icon size={22} color={C.text2} /> {title}
        </div>
        {right && <div style={{ color: C.text2, fontSize: 16 }}>{right}</div>}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>{children}</div>
    </div>
  );

const StatusPill: React.FC<{ color: string; Icon: React.FC<any>; label: string; size?: 'lg' | 'md' | 'sm' }> = ({ color, Icon, label, size = 'md' }) => {
  const s = size === 'lg' ? { f: 26, i: 26, p: '6px 16px' } : size === 'md' ? { f: 18, i: 18, p: '4px 12px' } : { f: 14, i: 14, p: '2px 8px' };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: s.p, borderRadius: 999, background: `color-mix(in srgb, ${color} 13%, transparent)`, border: `2px solid ${color}`, color: C.text, fontSize: s.f, fontWeight: 800, letterSpacing: 0.5, textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
      <Icon size={s.i} color={color} strokeWidth={2.5} /> {label}
    </span>
  );
};

/** Lock / DPS / REX indicator: dot + label, so it reads without color. */
const Signal: React.FC<{ on: boolean; label: string; onText: string; offText: string; onColor: string; size?: number }> = ({ on, label, onText, offText, onColor, size = 16 }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: size, color: C.text2 }}>
    <span style={{ width: size * 0.7, height: size * 0.7, borderRadius: '50%', background: on ? onColor : 'transparent', border: `2px solid ${on ? onColor : C.muted}` }} />
    <span style={{ color: C.muted }}>{label}</span>
    <span style={{ color: on ? C.text : C.text2, fontWeight: 600 }}>{on ? onText : offText}</span>
  </div>
);

/** The Doors-page animation (DoorScene), framed in the state colour. */
const DoorAnim: React.FC<{ d: StreamDoor; height: number }> = ({ d, height }) => {
  const live = d.state !== 'DISABLED' && d.state !== 'OFFLINE';
  const { color } = DOOR_STATUS[d.state];
  return (
    <div style={{ height, width: height * (200 / 260), flexShrink: 0, borderRadius: 8, background: C.bg, border: `2px solid color-mix(in srgb, ${color} 33%, transparent)`, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <DoorScene
        isLocked={!d.unlocked}
        isOpen={d.open}
        rexActive={d.rex}
        enabled={live}
        disabledLabel=""
        style={{ width: '100%', height: '100%', display: 'block' }}
      />
    </div>
  );
};

const CARD_RESULT_LABEL = { granted: 'Granted', denied: 'Denied', read: 'Presented' } as const;
const CardResultIcon: React.FC<{ r: 'granted' | 'denied' | 'read'; size: number }> = ({ r, size }) =>
  r === 'denied' ? <XCircle size={size} color={C.crit} /> : r === 'granted' ? <CheckCircle2 size={size} color={C.good} /> : <KeyRound size={size} color={C.text2} />;

/** Small badge for an emulated board the panel has stopped polling. */
const BoardOfflineBadge: React.FC<{ show?: boolean }> = ({ show }) => show ? (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 13, color: C.text, border: `1px solid ${C.warn}`, borderRadius: 999, padding: '1px 8px', whiteSpace: 'nowrap' }}>
    <WifiOff size={12} color={C.warn} /> Board not polled
  </span>
) : null;

// ---------- Doors ----------

const DoorCardLarge: React.FC<{ d: StreamDoor; now: number }> = ({ d, now }) => {
  const st = DOOR_STATUS[d.state];
  return (
    <div style={{ background: C.panel2, border: `1px solid ${C.border}`, borderLeft: `8px solid ${st.color}`, borderRadius: 12, padding: '18px 22px', display: 'flex', gap: 22, minHeight: 0, minWidth: 0, overflow: 'hidden' }}>
      <DoorAnim d={d} height={228} />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
          <div style={{ fontSize: 30, fontWeight: 800, color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.name}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 16, color: C.muted, whiteSpace: 'nowrap' }}><BoardOfflineBadge show={d.boardOffline} />Door {d.id}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <StatusPill color={st.color} Icon={st.Icon} label={st.label} size="lg" />
          <span style={{ color: C.text2, fontSize: 18, whiteSpace: 'nowrap' }}>for {ago(now - d.stateSince)}</span>
        </div>
        <div style={{ display: 'flex', gap: 22 }}>
          <Signal on={d.unlocked} label="Lock" onText="Unlocked" offText="Locked" onColor={C.info} />
          <Signal on={d.open} label="DPS" onText="Open" offText="Closed" onColor={d.unlocked ? C.info : C.crit} />
          <Signal on={d.rex} label="REX" onText="Active" offText="Idle" onColor={C.info} />
        </div>
        <div style={{ marginTop: 'auto', fontSize: 15, color: C.muted }}>{d.ioLabel}{d.readerName ? ` · Reader ${d.readerName}` : ''}</div>
        <div style={{ display: 'flex', gap: 12, fontSize: 16, color: C.text2 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            {d.lastCard ? (
              <>
                <CardResultIcon r={d.lastCard.result} size={16} />
                <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {CARD_RESULT_LABEL[d.lastCard.result]} {d.lastCard.text} · {ago(now - d.lastCard.at)} ago
                </span>
              </>
            ) : <span style={{ color: C.muted }}>No card reads yet</span>}
          </span>
        </div>
      </div>
    </div>
  );
};

const DoorCardCompact: React.FC<{ d: StreamDoor; now: number }> = ({ d, now }) => {
  const st = DOOR_STATUS[d.state];
  return (
    <div style={{ background: C.panel2, border: `1px solid ${C.border}`, borderTop: `6px solid ${st.color}`, borderRadius: 12, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0, minWidth: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 6 }}>
        <div style={{ fontSize: 22, fontWeight: 800, color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.name}</div>
        <div style={{ fontSize: 14, color: C.muted }}>D{d.id}</div>
      </div>
      <div style={{ display: 'flex', gap: 12, flex: 1, minHeight: 0 }}>
        <DoorAnim d={d} height={132} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
          <StatusPill color={st.color} Icon={st.Icon} label={st.label} size="md" />
          <span style={{ color: C.text2, fontSize: 14 }}>for {ago(now - d.stateSince)}</span>
          <BoardOfflineBadge show={d.boardOffline} />
          <Signal size={14} on={d.unlocked} label="Lock" onText="Unlocked" offText="Locked" onColor={C.info} />
          <Signal size={14} on={d.open} label="DPS" onText="Open" offText="Closed" onColor={d.unlocked ? C.info : C.crit} />
          <Signal size={14} on={d.rex} label="REX" onText="Active" offText="Idle" onColor={C.info} />
        </div>
      </div>
      <div style={{ fontSize: 13, color: C.text2, display: 'flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap', overflow: 'hidden' }}>
        {d.lastCard ? (
          <>
            <CardResultIcon r={d.lastCard.result} size={13} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.lastCard.text} · {ago(now - d.lastCard.at)}</span>
          </>
        ) : <span style={{ color: C.muted }}>No reads</span>}
      </div>
    </div>
  );
};

const DoorTile: React.FC<{ d: StreamDoor; sceneH: number }> = ({ d, sceneH }) => {
  const st = DOOR_STATUS[d.state];
  return (
    <div style={{ background: C.panel2, border: `1px solid ${C.border}`, borderLeft: `6px solid ${st.color}`, borderRadius: 10, padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, overflow: 'hidden' }}>
      <DoorAnim d={d} height={sceneH} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.id}. {d.name}</div>
        <div><StatusPill color={st.color} Icon={st.Icon} label={st.label} size="sm" /></div>
      </div>
    </div>
  );
};

const DoorSummary: React.FC<{ doors: StreamDoor[] }> = ({ doors }) => {
  const count = (states: DoorState[]) => doors.filter(d => states.includes(d.state)).length;
  const items = [
    { ...DOOR_STATUS.SECURE, label: 'Secure', n: count(['SECURE']) },
    { ...DOOR_STATUS.UNLOCKED, label: 'Unlocked / Open', n: count(['UNLOCKED', 'OPEN']) },
    { ...DOOR_STATUS.HELD, label: 'Held Open', n: count(['HELD']) },
    { ...DOOR_STATUS.FORCED, label: 'Forced', n: count(['FORCED']) },
    { ...DOOR_STATUS.OFFLINE, label: 'Offline / Disabled', n: count(['OFFLINE', 'DISABLED']) },
  ];
  return (
    <div style={{ display: 'flex', gap: 12 }}>
      {items.map(i => (
        <div key={i.label} style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 12, background: C.panel2, border: `1px solid ${i.n ? i.color : C.border}`, borderRadius: 10, padding: '8px 14px', opacity: i.n ? 1 : 0.6 }}>
          <i.Icon size={24} color={i.n ? i.color : C.muted} />
          <span style={{ fontSize: 30, fontWeight: 800, color: C.text, fontVariantNumeric: 'tabular-nums' }}>{i.n}</span>
          <span style={{ fontSize: 16, color: C.text2 }}>{i.label}</span>
        </div>
      ))}
    </div>
  );
};

const DoorsArea: React.FC<{ doors: StreamDoor[]; now: number }> = ({ doors, now }) => {
  if (!doors.length) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.muted, fontSize: 22, border: `2px dashed ${C.border}`, borderRadius: 12 }}>
        No doors configured. Set them up under Access Control Modules → Doors and save.
      </div>
    );
  }
  if (doors.length <= 4) {
    const cols = doors.length === 1 ? 1 : 2;
    return (
      <div style={{ height: '100%', display: 'grid', gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${Math.ceil(doors.length / cols)}, 1fr)`, gap: 14 }}>
        {doors.map(d => <DoorCardLarge key={d.id} d={d} now={now} />)}
      </div>
    );
  }
  if (doors.length <= 8) {
    // Break it down by controller: one labelled row per board / hardware group.
    const groups: { name: string; doors: StreamDoor[] }[] = [];
    for (const d of doors) {
      const g = groups.find(x => x.name === d.group);
      g ? g.doors.push(d) : groups.push({ name: d.group, doors: [d] });
    }
    const rows = groups.length <= 2 && groups.every(g => g.doors.length <= 4) ? groups : [{ name: 'All doors', doors }];
    return (
      <div style={{ height: '100%', display: 'grid', gridTemplateRows: `repeat(${rows.length === 1 ? 2 : rows.length}, 1fr)`, gap: 12 }}>
        {rows.length === 1
          ? [doors.slice(0, 4), doors.slice(4)].map((row, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12, minHeight: 0 }}>
                {row.map(d => <DoorCardCompact key={d.id} d={d} now={now} />)}
              </div>
            ))
          : rows.map(g => {
              const alerts = g.doors.filter(d => d.state === 'FORCED' || d.state === 'HELD').length;
              return (
                <div key={g.name} style={{ display: 'flex', flexDirection: 'column', gap: 6, minHeight: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 16, color: C.text2 }}>
                    <Cpu size={16} color={C.muted} />
                    <span style={{ color: C.text, fontWeight: 700 }}>{g.name}</span>
                    <span>· {g.doors.length} door{g.doors.length > 1 ? 's' : ''}</span>
                    <span>· {g.doors.filter(d => d.state === 'SECURE').length} secure</span>
                    {alerts > 0 && <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: C.text }}><AlertTriangle size={15} color={C.warn} /> {alerts} alert{alerts > 1 ? 's' : ''}</span>}
                  </div>
                  <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12, minHeight: 0 }}>
                    {g.doors.map(d => <DoorCardCompact key={d.id} d={d} now={now} />)}
                  </div>
                </div>
              );
            })}
      </div>
    );
  }
  return (
    <div style={{ height: '100%', display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gridAutoRows: '1fr', gap: 10 }}>
      {doors.slice(0, 16).map(d => <DoorTile key={d.id} d={d} sceneH={doors.length > 12 ? 104 : 148} />)}
    </div>
  );
};

// ---------- Elevator ----------

const ElevatorPanel: React.FC<{ el: StreamModel['elevator'] }> = ({ el }) => {
  if (!el.configured) {
    return (
      <Panel title="Elevator" icon={Building} style={{ height: 300 }}>
        <div style={{ color: C.muted, fontSize: 18, paddingTop: 8 }}>Open the Elevator page on this unit to publish its state here.</div>
      </Panel>
    );
  }
  const moving = el.targetFloor != null && el.targetFloor !== el.carFloor;
  const floors = [...el.floors].sort((a, b) => b.id - a.id).slice(0, 8);
  return (
    <Panel title="Elevator" icon={Building} style={{ height: 300 }}
      right={<span>Floor <b style={{ color: C.text, fontSize: 22 }}>{el.carFloor}</b>{moving ? ` → ${el.targetFloor}` : ''}</span>}>
      <div style={{ display: 'flex', gap: 16, height: '100%' }}>
        <div style={{ flex: 1, display: 'grid', gridTemplateRows: `repeat(${floors.length}, 1fr)`, gap: 3 }}>
          {floors.map(f => {
            const here = f.id === el.carFloor;
            return (
              <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 10px', borderRadius: 6, background: here ? `color-mix(in srgb, ${C.accent} 15%, transparent)` : C.panel2, border: `1px solid ${here ? C.accent : C.border}`, fontSize: 15 }}>
                <span style={{ width: 26, fontWeight: 800, color: C.text, fontVariantNumeric: 'tabular-nums' }}>{f.id}</span>
                <span style={{ flex: 1, color: C.text2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.name}</span>
                {f.called && <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: C.text, fontSize: 13 }}><BellRing size={13} color={C.warn} />Call</span>}
                {f.access
                  ? <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: C.text, fontSize: 13 }}><KeyRound size={13} color={C.good} />Access</span>
                  : <span style={{ color: C.muted, fontSize: 13 }}>Locked</span>}
                {here && <span style={{ width: 10, height: 10, borderRadius: 2, background: C.accent }} />}
              </div>
            );
          })}
        </div>
        <div style={{ width: 150, display: 'flex', flexDirection: 'column', gap: 10, justifyContent: 'center' }}>
          {[['Trips', el.trips, C.text], ['Granted', el.granted, C.text], ['Denied', el.denied, C.text]].map(([l, v]) => (
            <div key={l as string} style={{ background: C.panel2, border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 12px' }}>
              <div style={{ fontSize: 13, color: C.muted }}>{l}</div>
              <div style={{ fontSize: 26, fontWeight: 800, color: C.text, fontVariantNumeric: 'tabular-nums' }}>{v as number}</div>
            </div>
          ))}
        </div>
      </div>
    </Panel>
  );
};

// ---------- I/O ----------

const IOPanel: React.FC<{ io: StreamModel['io']; now: number }> = ({ io, now }) => {
  const cell = (v: 0 | 1 | null, i: number, color: string, onText: string) => (
    <div key={i} style={{ background: v === 1 ? `color-mix(in srgb, ${color} 19%, transparent)` : C.panel2, border: `2px solid ${v === 1 ? color : C.border}`, borderRadius: 6, textAlign: 'center', padding: '3px 0' }}>
      <div style={{ fontSize: 13, color: C.muted }}>{i + 1}</div>
      <div style={{ fontSize: 13, fontWeight: 700, color: v === 1 ? C.text : C.text2 }}>{v === null ? '?' : v ? onText : 'off'}</div>
    </div>
  );
  return (
    <Panel title="I/O Status" icon={Zap} style={{ height: 240 }}
      right={io.error ? <span style={{ color: C.text }}><AlertTriangle size={14} color={C.warn} style={{ verticalAlign: -2 }} /> I/O read failed</span> : io.polledAt ? `polled ${ago(now - io.polledAt)} ago` : ''}>
      <div style={{ display: 'grid', gridTemplateColumns: '70px 1fr', rowGap: 6, alignItems: 'center' }}>
        <span style={{ color: C.text2, fontSize: 15 }}>Relays</span>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 5 }}>{io.relays.map((v, i) => cell(v, i, C.info, 'ON'))}</div>
        <span style={{ color: C.text2, fontSize: 15 }}>Inputs</span>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 5 }}>{io.inputs.map((v, i) => cell(v, i, C.info, 'ACT'))}</div>
        <span style={{ color: C.text2, fontSize: 15 }}>Zones</span>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 5 }}>
          {(io.zones.length ? io.zones : Array.from({ length: 8 }, (_, i) => ({ channel: i + 1, state: 'UNKNOWN' as ZoneState, mv: 0, profile: '' }))).slice(0, 8).map(z => {
            const s = ZONE_STATUS[z.state] || ZONE_STATUS.UNKNOWN;
            const alert = z.state !== 'NORMAL' && z.state !== 'UNKNOWN';
            return (
              <div key={z.channel} title={z.profile} style={{ background: alert ? `color-mix(in srgb, ${s.color} 19%, transparent)` : C.panel2, border: `2px solid ${alert ? s.color : C.border}`, borderRadius: 6, textAlign: 'center', padding: '3px 0' }}>
                <div style={{ fontSize: 13, color: C.muted }}>Z{z.channel}</div>
                <div style={{ fontSize: 12, fontWeight: 800, color: alert ? C.text : C.text2, textTransform: 'uppercase' }}>{s.label}</div>
                <div style={{ fontSize: 11, color: C.muted, fontVariantNumeric: 'tabular-nums' }}>{z.mv ? `${z.mv}mV` : '—'}</div>
              </div>
            );
          })}
        </div>
      </div>
    </Panel>
  );
};

// ---------- OSDP ----------

const Sparkline: React.FC<{ values: number[]; w: number; h: number; color: string }> = ({ values, w, h, color }) => {
  const max = Math.max(5, ...values);
  const step = w / Math.max(1, values.length - 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - 4 - (v / max) * (h - 12)).toFixed(1)}`).join(' ');
  return (
    <svg width={w} height={h} style={{ display: 'block' }}>
      <line x1="0" y1={h - 4} x2={w} y2={h - 4} stroke={C.border} strokeWidth="1" />
      <polyline points={`0,${h - 4} ${pts} ${w},${h - 4}`} fill={`color-mix(in srgb, ${color} 13%, transparent)`} stroke="none" />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
};

const OSDPPanel: React.FC<{ osdp: StreamModel['osdp']; now: number }> = ({ osdp, now }) => {
  const fps = osdp.rate[osdp.rate.length - 1] || 0;
  return (
    <Panel title="OSDP Traffic" icon={Radio} style={{ flex: 1 }}
      right={<span><b style={{ color: C.text, fontSize: 22, fontVariantNumeric: 'tabular-nums' }}>{fps}</b> frames/s</span>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%' }}>
        <div>
          <Sparkline values={osdp.rate} w={582} h={48} color={C.info} />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: C.muted, marginTop: 2, whiteSpace: 'nowrap' }}>
            <span>last 60 s</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {osdp.totalFrames.toLocaleString()} frames ·
              {osdp.naks > 0 && <AlertTriangle size={12} color={C.warn} />}
              <span style={{ color: osdp.naks ? C.text : C.muted }}>{osdp.naks} NAK</span>
            </span>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {osdp.readers.slice(0, 2).map(r => {
            const online = r.status === 'online' || r.status === 'connected';
            return (
              <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, color: C.text2 }}>
                {online ? <CircleDot size={14} color={C.good} /> : <WifiOff size={14} color={C.off} />}
                <span style={{ color: C.text, fontWeight: 600 }}>{r.name}</span>
                <span style={{ color: C.muted }}>@{r.address}</span>
                {r.secure && <span style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 13 }}><ShieldCheck size={13} color={C.good} />SC</span>}
                <span style={{ marginLeft: 'auto', color: C.muted, fontSize: 13 }}>{online ? 'online' : r.status}{r.lastActivity ? ` · ${ago(now - r.lastActivity)}` : ''}</span>
              </div>
            );
          })}
          {!osdp.readers.length && <div style={{ color: C.muted, fontSize: 15 }}>No OSDP readers configured</div>}
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 13, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: '6px 10px' }}>
          {osdp.recent.slice(0, 4).map((f, i) => (
            <div key={i} style={{ display: 'flex', gap: 12, color: i === 0 ? C.text : C.text2, lineHeight: '19px' }}>
              <span style={{ width: 22, color: f.dir === 'TX' ? C.text2 : C.muted }}>{f.dir}</span>
              <span style={{ width: 44 }}>0x{Math.max(0, f.address).toString(16).padStart(2, '0')}</span>
              <span style={{ width: 70, fontWeight: f.cmd === 'NAK' ? 800 : 500 }}>{f.cmd}</span>
              <span style={{ color: C.muted }}>{f.len}B</span>
            </div>
          ))}
          {!osdp.recent.length && <div style={{ color: C.muted }}>Waiting for bus traffic…</div>}
        </div>
      </div>
    </Panel>
  );
};

// ---------- Events / emulator / automation ----------

const EVENT_ICON: Record<AccessEvent['kind'], { Icon: React.FC<any>; color: string }> = {
  granted: { Icon: CheckCircle2, color: C.good },
  denied: { Icon: XCircle, color: C.crit },
  card: { Icon: KeyRound, color: C.text2 },
  door: { Icon: LockOpen, color: C.info },
  alarm: { Icon: ShieldAlert, color: C.crit },
  system: { Icon: Info, color: C.text2 },
  automation: { Icon: Workflow, color: C.text2 },
};

/** Compact event list: icon, what, where, age. One line each. */
const EventsPanel: React.FC<{ events: AccessEvent[]; now: number; rows: number }> = ({ events, now, rows }) => (
  <Panel title="Recent Events" icon={Activity} style={{ flex: 1 }}>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {events.slice(0, rows).map((e, i) => {
        const { Icon, color } = EVENT_ICON[e.kind] || EVENT_ICON.system;
        return (
          <div key={`${e.at}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, color: C.text2, minWidth: 0 }}>
            <Icon size={15} color={color} style={{ flexShrink: 0 }} />
            <span style={{ color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>
              {e.text}{e.where ? <span style={{ color: C.muted }}> · {e.where}</span> : null}
            </span>
            <span style={{ marginLeft: 'auto', paddingLeft: 8, color: C.muted, fontSize: 13, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{ago(now - e.at)}</span>
          </div>
        );
      })}
      {!events.length && <div style={{ color: C.muted, fontSize: 15 }}>No events since this view opened.</div>}
    </div>
  </Panel>
);

// Board photos from the Controller Emulator page (frontend/public/images/devices).
// `crop` trims each photo's white border (top right bottom left, %).
const BOARD_IMG: Record<string, { src: string; crop: string }> = {
  IO168S: { src: '/images/devices/IO168S.png', crop: '4.5% 4% 3% 2.5%' },
  I16S:   { src: '/images/devices/IO168S.png', crop: '4.5% 4% 3% 2.5%' },
  O8S:    { src: '/images/devices/IO168S.png', crop: '4.5% 4% 3% 2.5%' },
  RI2MS:  { src: '/images/devices/RI2MS.png',  crop: '2% 2.5% 2% 6%' },
  RI4S:   { src: '/images/devices/RI4S.png',   crop: '3% 1% 1% 1%' },
};

const BoardCard: React.FC<{ d: StreamModel['emulator']['devices'][number]; imgH: number; compact: boolean }> = ({ d, imgH, compact }) => {
  const img = BOARD_IMG[d.model] || BOARD_IMG[String(d.model).toUpperCase()];
  const alert = d.tamper || d.powerFail;
  const ring = alert ? C.crit : d.online ? C.good : C.muted;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, minWidth: 0 }}>
      <div style={{ position: 'relative', height: imgH, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {img ? (
          <img src={img.src} alt={d.model}
            style={{ maxHeight: imgH, maxWidth: '100%', objectFit: 'contain', objectViewBox: `inset(${img.crop})`, borderRadius: 4, border: `2px solid ${ring}`, opacity: d.online ? 1 : 0.45, filter: d.online ? 'none' : 'grayscale(0.8)' } as React.CSSProperties} />
        ) : (
          <div style={{ height: imgH, aspectRatio: '4 / 3', maxWidth: '100%', borderRadius: 4, border: `2px solid ${ring}`, background: C.panel2, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Cpu size={Math.min(40, imgH / 2)} color={C.muted} />
          </div>
        )}
        {alert && (
          <span style={{ position: 'absolute', top: 2, right: 2, display: 'flex', alignItems: 'center', gap: 3, background: '#000c', border: `1px solid ${C.crit}`, borderRadius: 6, padding: '1px 5px', fontSize: 11, color: C.text }}>
            <AlertTriangle size={11} color={C.crit} />{d.tamper ? 'Tamper' : 'Power'}
          </span>
        )}
      </div>
      {compact ? (
        <div style={{ textAlign: 'center', lineHeight: 1.15, maxWidth: '100%' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, fontSize: 14 }}>
            {d.online ? <CircleDot size={11} color={C.good} /> : <WifiOff size={11} color={C.off} />}
            <span style={{ color: C.text, fontWeight: 700 }}>@{d.address}</span>
          </div>
          <div style={{ fontSize: 12, color: C.text2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.model}</div>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 14, whiteSpace: 'nowrap', maxWidth: '100%' }}>
          {d.online ? <CircleDot size={12} color={C.good} /> : <WifiOff size={12} color={C.off} />}
          <span style={{ color: C.text, fontWeight: 700 }}>@{d.address}</span>
          <span style={{ color: C.text2, overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.model}</span>
        </div>
      )}
    </div>
  );
};

/** Dense tile for 17-32 boards: thumbnail, address, model; frame colour = state. */
const BoardTile: React.FC<{ d: StreamModel['emulator']['devices'][number] }> = ({ d }) => {
  const img = BOARD_IMG[d.model] || BOARD_IMG[String(d.model).toUpperCase()];
  const alert = d.tamper || d.powerFail;
  const ring = alert ? C.crit : d.online ? C.border : C.muted;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, padding: '2px 4px', borderRadius: 6,
      background: alert ? `color-mix(in srgb, ${C.crit} 15%, transparent)` : C.panel2, border: `1px solid ${ring}`, opacity: d.online || alert ? 1 : 0.55 }}>
      {img
        ? <img src={img.src} alt="" style={{ height: 26, width: 22, objectFit: 'contain', objectViewBox: `inset(${img.crop})`, flexShrink: 0, filter: d.online ? 'none' : 'grayscale(0.8)' } as React.CSSProperties} />
        : <Cpu size={20} color={C.muted} style={{ flexShrink: 0 }} />}
      <div style={{ minWidth: 0, lineHeight: 1.1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 13, color: C.text, fontWeight: 700, whiteSpace: 'nowrap' }}>
          {alert ? <AlertTriangle size={11} color={C.crit} /> : d.online ? <CircleDot size={10} color={C.good} /> : <WifiOff size={10} color={C.off} />}
          @{d.address}
        </div>
        <div style={{ fontSize: 11, letterSpacing: -0.3, color: alert ? C.text : C.text2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'clip' }}>
          {alert ? (d.tamper ? 'Tamper' : 'Power') : d.model}
        </div>
      </div>
    </div>
  );
};

const EmulatorPanel: React.FC<{ emu: StreamModel['emulator'] }> = ({ emu }) => {
  const all = emu.devices.slice().sort((a, b) => a.address - b.address);
  const n = all.length;
  const online = all.filter(d => d.online).length;
  const alerts = all.filter(d => d.tamper || d.powerFail).length;
  const header = emu.running
    ? <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: C.text }}>
        <CircleDot size={14} color={C.good} />Running{emu.port ? ` · ${emu.port}` : ''} · {online}/{n} polled
        {alerts > 0 && <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>· <AlertTriangle size={13} color={C.crit} />{alerts}</span>}
      </span>
    : <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Ban size={14} color={C.off} />Stopped</span>;

  if (!n) {
    return <Panel title="Controller Emulator" icon={Cpu} style={{ flex: 1.45 }} right={header}><span style={{ color: C.muted, fontSize: 15 }}>No emulated boards</span></Panel>;
  }

  // 17+ boards: dense tiles, 8 across x 4 down = all 32 emulator addresses
  if (n > 16) {
    return (
      <Panel title="Controller Emulator" icon={Cpu} style={{ flex: 1.45 }} right={header}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, minmax(0, 1fr))', gridTemplateRows: `repeat(${Math.ceil(Math.min(n, 32) / 8)}, 1fr)`, gap: 5, height: '100%' }}>
          {all.slice(0, 32).map(d => <BoardTile key={d.address} d={d} />)}
        </div>
      </Panel>
    );
  }

  const cols = n <= 4 ? 4 : n <= 6 ? 6 : 8;
  const rows = Math.max(1, Math.ceil(n / cols));
  const compact = cols >= 8;
  // panel body is ~196 px tall; leave room for the label under each board
  const imgH = rows === 1 ? (n <= 4 ? 150 : compact ? 128 : 132) : 62;
  return (
    <Panel title="Controller Emulator" icon={Cpu} style={{ flex: 1.45 }} right={header}>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, columnGap: rows === 1 ? 14 : 8, rowGap: 6, alignContent: 'center', height: '100%' }}>
        {all.map(d => <BoardCard key={d.address} d={d} imgH={imgH} compact={compact} />)}
      </div>
    </Panel>
  );
};

const AutomationStrip: React.FC<{ auto: StreamModel['automation']; now: number }> = ({ auto, now }) => (
  <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 14, padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 12, fontSize: 15, color: C.text2, whiteSpace: 'nowrap', overflow: 'hidden' }}>
    <Workflow size={18} color={C.text2} />
    <span style={{ color: C.text, fontWeight: 700 }}>Automation</span>
    <span><b style={{ color: C.text }}>{auto.enabled}</b>/{auto.total} on</span>
    <span><b style={{ color: C.text, fontVariantNumeric: 'tabular-nums' }}>{auto.triggers.toLocaleString()}</b> triggers</span>
    <span style={{ marginLeft: 'auto', color: C.muted }}>last {auto.lastTriggerAt ? `${ago(now - auto.lastTriggerAt)} ago` : '—'}</span>
  </div>
);

// ---------- Page ----------

export const StreamCanvas: React.FC<{ m: StreamModel }> = ({ m }) => {
  const now = m.now;
  const time = new Date(now);
  const activeOutputs = m.systemOutputs.filter(o => o.configured);
  return (
    <div style={{ position: 'relative', width: W, height: H, background: C.bg, color: C.text, fontFamily: 'Inter, "Segoe UI", Roboto, Arial, sans-serif', padding: 20, display: 'flex', flexDirection: 'column', gap: 16, boxSizing: 'border-box', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ height: 76, display: 'flex', alignItems: 'center', gap: 24, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 14, padding: '0 24px' }}>
        <div>
          <div style={{ fontSize: 30, fontWeight: 900, color: C.accent, letterSpacing: 1 }}>AETHER</div>
          <div style={{ fontSize: 15, color: C.text2 }}>{m.nodeName}{m.host ? ` · ${m.host}` : ''}</div>
        </div>
        <div style={{ flex: 1, display: 'flex', gap: 10, justifyContent: 'center' }}>
          {activeOutputs.map(o => (
            o.active
              ? <StatusPill key={o.key} color={C.crit} Icon={AlertTriangle} label={o.name} size="md" />
              : <span key={o.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 12px', borderRadius: 999, border: `1px solid ${C.border}`, color: C.text2, fontSize: 16 }}>
                  <CheckCircle2 size={15} color={C.good} /> {o.name} OK
                </span>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 22 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 17, color: C.text }}>
            {m.connected ? <CircleDot size={18} color={C.good} /> : m.diag?.http ? <AlertTriangle size={18} color={C.warn} /> : <WifiOff size={18} color={C.crit} />}
            {m.connected ? 'Live' : m.diag?.http ? 'Polling only' : 'Backend offline'}
          </span>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 34, fontWeight: 800, fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>{time.toLocaleTimeString([], { hour12: false })}</div>
            <div style={{ fontSize: 14, color: C.text2 }}>{time.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}</div>
          </div>
        </div>
      </div>

      {/* Body */}
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 620px', gap: 16, minHeight: 0 }}>
        {/* Left */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minHeight: 0 }}>
          <DoorSummary doors={m.doors} />
          <div style={{ flex: 1, minHeight: 0 }}><DoorsArea doors={m.doors} now={now} /></div>
          <div style={{ height: 262, display: 'flex', gap: 14 }}>
            <EmulatorPanel emu={m.emulator} />
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0, minHeight: 0 }}>
              <EventsPanel events={m.events} now={now} rows={5} />
              <AutomationStrip auto={m.automation} now={now} />
            </div>
          </div>
        </div>
        {/* Right */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minHeight: 0 }}>
          <ElevatorPanel el={m.elevator} />
          <IOPanel io={m.io} now={now} />
          <OSDPPanel osdp={m.osdp} now={now} />
        </div>
      </div>

      {new URLSearchParams(window.location.search).get('debug') && m.diag && (
        <div style={{ position: 'absolute', right: 30, bottom: 60, width: 420, background: '#000000e6', border: `1px solid ${C.warn}`, borderRadius: 10, padding: 14, fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 14, color: C.text, zIndex: 5 }}>
          <div>socket.io: {m.diag.socket ? 'connected' : 'NOT connected'} · http: {m.diag.http ? 'ok' : 'failing'}</div>
          <div>last event: {m.diag.lastEventAt ? `${ago(now - m.diag.lastEventAt)} ago` : 'none'}</div>
          {Object.entries(m.diag.counts).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => <div key={k}>{k}: {v}</div>)}
          {!Object.keys(m.diag.counts).length && <div style={{ color: C.warn }}>no socket events received</div>}
        </div>
      )}

      {/* Footer */}
      <div style={{ height: 28, display: 'flex', alignItems: 'center', gap: 24, fontSize: 14, color: C.muted, padding: '0 6px' }}>
        <span>Doors {m.doors.length}</span>
        <span>OSDP readers {m.osdp.readers.length}</span>
        <span>Emulated boards {m.emulator.devices.length}</span>
        <span>Backend uptime {uptime(m.backendUptimeSec)}</span>
        <span style={{ marginLeft: 'auto' }}>Aether Stream View · updated {time.toLocaleTimeString([], { hour12: false })}</span>
      </div>
    </div>
  );
};

/**
 * Capture mode: pause every CSS animation and advance it by hand at the capture
 * frame rate. The door animation still moves on the VMS, but the browser does
 * ~2 style updates a second instead of repainting at 60 Hz.
 */
function useCaptureStepping(): boolean {
  const fps = Number(new URLSearchParams(window.location.search).get('capture')) || 0;
  useEffect(() => {
    if (!fps) return;
    const root = document.documentElement;
    root.classList.add('aether-capture');
    const t0 = performance.now();
    const step = () => root.style.setProperty('--aether-t', `${((performance.now() - t0) / 1000).toFixed(2)}s`);
    step();
    const id = setInterval(step, Math.max(100, Math.round(1000 / fps)));
    return () => { clearInterval(id); root.classList.remove('aether-capture'); };
  }, [fps]);
  return fps > 0;
}

const CAPTURE_CSS = `
  html.aether-capture *, html.aether-capture *::before, html.aether-capture *::after {
    animation-play-state: paused !important;
    animation-delay: calc(var(--aether-t, 0s) * -1) !important;
    transition: none !important;
  }
  html.aether-capture, html.aether-capture body { cursor: none; overflow: hidden; }
`;

/** Scales the fixed 1920×1080 canvas to fit its container (or the window). */
const StreamView: React.FC<{ backendUrl?: string; embedded?: boolean }> = ({ backendUrl, embedded }) => {
  const m = useStreamData(backendUrl);
  const capturing = useCaptureStepping();
  const boxRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const fit = () => {
      const el = boxRef.current;
      const w = embedded && el ? el.clientWidth : window.innerWidth;
      const h = embedded ? w * (H / W) : window.innerHeight;
      setScale(Math.min(w / W, h / H));
    };
    fit();
    window.addEventListener('resize', fit);
    const ro = typeof ResizeObserver !== 'undefined' && boxRef.current ? new ResizeObserver(fit) : null;
    if (ro && boxRef.current) ro.observe(boxRef.current);
    return () => { window.removeEventListener('resize', fit); ro?.disconnect(); };
  }, [embedded]);

  return (
    <div ref={boxRef} style={embedded
      ? { width: '100%', height: H * scale, overflow: 'hidden', borderRadius: 12, border: `1px solid ${C.border}` }
      : { width: '100vw', height: '100vh', overflow: 'hidden', background: C.bg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {capturing && <style>{CAPTURE_CSS}</style>}
      <div style={{ width: W * scale, height: H * scale }}>
        <div style={{ transform: `scale(${scale})`, transformOrigin: 'top left', width: W, height: H }}>
          <StreamCanvas m={m} />
        </div>
      </div>
    </div>
  );
};

export default StreamView;
