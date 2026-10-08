import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Gauge, Play, RotateCcw, CheckCircle2, AlertTriangle, XCircle, Save, X,
  Activity, History, Pause, Zap, Info, Layers, Star, RefreshCw, Pencil, Trash2
} from 'lucide-react';

/**
 * EOL Resistor Calibration
 *
 * Guided replacement for backend/4point.sh. Captures the four wiring states on a
 * supervised input and saves the resulting threshold bands as a named profile,
 * one per resistor pair (e.g. "1k/2.2k", "3k/4.5k"). One profile is the default;
 * individual zones can be pointed at another. Stored in
 * backend/data/supervision-calibration.json.
 *
 * Backend: /api/supervision/calibration/*
 */

type CalState = 'TAMPER' | 'ALARM' | 'NORMAL' | 'TROUBLE';

type Thresholds = {
  tamperMin: number; tamperMax: number;
  alarmMin: number; alarmMax: number;
  normalMin: number; normalMax: number;
  troubleMin: number; troubleMax: number;
};

type CalPoint = {
  millivolts: number; volts: number; min: number; max: number; spread: number;
  samplesOk: number; samplesRequested: number; failedReads: number;
  warnings: string[]; capturedAt: string;
};

type Session = {
  id: string; board: number; channel: number;
  eolResistor: number; alarmResistor: number; samples: number;
  technician: string | null; startedAt: string;
  targetProfileId: string | null; suggestedName: string;
  points: Partial<Record<CalState, CalPoint>>;
  captured: CalState[]; remaining: CalState[]; complete: boolean;
  preview: { thresholds: Thresholds | null; errors: string[]; warnings: string[] } | null;
};

/** One saved calibration for a resistor pair, e.g. "1k/2.2k" or "3k/4.5k". */
type Profile = {
  id: string; name: string; builtIn?: boolean;
  eolResistor: number; alarmResistor: number;
  thresholds: Thresholds;
  measurements?: Record<CalState, { volts: number; millivolts: number; spread?: number }> | null;
  calibrationDate?: string;
  board?: number; channel?: number;
  technician?: string | null;
};

type HistoryEvent = { at: string; action: string; profileId: string | null; name: string | null; zone?: string; from?: string };

type CalInfo = {
  thresholds: Thresholds;
  eolResistor: number; alarmResistor: number; vcc: number;
  maxBoards: number; zonesPerBoard: number;
  defaultProfileId: string;
  profiles: Profile[];
  zoneProfiles: Record<string, string>;
  session: Session | null;
  history: HistoryEvent[];
};

type LiveReading = { millivolts: number; spread: number; state: string; profileName?: string };

interface EOLCalibrationSectionProps {
  ipAddress: string;
  connected: boolean;
  logSystem?: (type: string, message: string) => void;
  logAudit?: (message: string) => void;
}

/** 1000 -> "1k", 2200 -> "2.2k" (matches the backend's naming). */
function fmtOhms(ohms: number) {
  if (!ohms || ohms <= 0) return '?';
  if (ohms >= 1e6) return `${+(ohms / 1e6).toFixed(2)}M`;
  if (ohms >= 1000) return `${+(ohms / 1000).toFixed(2)}k`;
  return String(Math.round(ohms));
}

const STATES: CalState[] = ['TAMPER', 'ALARM', 'NORMAL', 'TROUBLE'];

const STATE_INFO: Record<CalState, { label: string; color: string; wiring: string; detail: string }> = {
  TAMPER: {
    label: 'Tamper (short)', color: 'rgb(var(--hv-error-fg))',
    wiring: 'Short the two zone wires together, bypassing both resistors.',
    detail: 'Simulates a cut-and-jumpered loop. Should read close to 0 V.',
  },
  ALARM: {
    label: 'Alarm (contact open)', color: 'rgb(var(--hv-brand-fg))',
    wiring: 'Wire the EOL resistor in, then open the sensor contact.',
    detail: 'Current flows only through the alarm path.',
  },
  NORMAL: {
    label: 'Normal (secured)', color: 'rgb(var(--hv-success-text))',
    wiring: 'Close the sensor contact (door shut / sensor secured).',
    detail: 'Current flows through the EOL resistor and the closed contact.',
  },
  TROUBLE: {
    label: 'Trouble (wire cut)', color: 'rgb(var(--hv-info-fg))',
    wiring: 'Disconnect one zone wire completely.',
    detail: 'Open loop. Should read close to the supply rail.',
  },
};

const BAND_KEYS: Record<CalState, [keyof Thresholds, keyof Thresholds]> = {
  TAMPER: ['tamperMin', 'tamperMax'],
  ALARM: ['alarmMin', 'alarmMax'],
  NORMAL: ['normalMin', 'normalMax'],
  TROUBLE: ['troubleMin', 'troubleMax'],
};

const card = { background: 'linear-gradient(160deg, rgb(var(--hv-widget)), rgb(var(--hv-widget-panel)))', borderColor: 'rgb(var(--hv-line))' };
const inputCls = 'w-full bg-hv-widget-panel border border-hv-line rounded-lg px-3 py-2 text-hv-text focus:border-hv-brand focus:outline-none disabled:opacity-50';
const btn = 'inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed';

function fmtDate(iso?: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** Horizontal 0..maxMv bar showing the four bands, with optional markers. */
const BandBar: React.FC<{ thresholds: Thresholds; markers?: { mv: number; color: string; label: string }[]; live?: number | null }> = ({ thresholds, markers = [], live }) => {
  // Log-ish scale so the small TAMPER/ALARM bands are visible next to a 3.3 V TROUBLE band.
  const maxMv = Math.max(thresholds.troubleMax, 3500);
  const scale = (mv: number) => (Math.sqrt(Math.max(0, Math.min(mv, maxMv))) / Math.sqrt(maxMv)) * 100;
  return (
    <div className="relative pt-5 pb-10">
      <div className="relative h-6 rounded-md overflow-hidden flex border border-hv-line">
        {STATES.map(s => {
          const [lo, hi] = BAND_KEYS[s];
          const w = scale(thresholds[hi]) - scale(thresholds[lo]);
          return (
            <div key={s} className="h-full flex items-center justify-center text-[10px] font-semibold text-[#101011]"
              style={{ width: `${w}%`, background: STATE_INFO[s].color, opacity: 0.85 }} title={`${s}: ${thresholds[lo]}–${thresholds[hi]} mV`}>
              {w > 9 ? s : ''}
            </div>
          );
        })}
      </div>
      {markers.map(m => (
        <div key={m.label} className="absolute top-0 -translate-x-1/2 flex flex-col items-center" style={{ left: `${scale(m.mv)}%` }}>
          <span className="text-[10px] text-hv-text-2 whitespace-nowrap">{m.mv}</span>
          <div className="w-0.5 h-8" style={{ background: m.color }} />
        </div>
      ))}
      {live != null && (
        <div className="absolute -translate-x-1/2 flex flex-col items-center transition-all duration-300" style={{ left: `${scale(live)}%`, top: '1.25rem' }}>
          <div className="w-1 h-6 bg-white rounded shadow" />
          <span className="text-[10px] font-bold text-hv-text whitespace-nowrap mt-0.5">{live} mV</span>
        </div>
      )}
      <div className="absolute bottom-0 left-0 text-[10px] text-hv-text-3">0 mV</div>
      <div className="absolute bottom-0 right-0 text-[10px] text-hv-text-3">{maxMv} mV</div>
    </div>
  );
};

const ThresholdTable: React.FC<{ current: Thresholds; proposed?: Thresholds | null }> = ({ current, proposed }) => (
  <table className="w-full text-sm">
    <thead>
      <tr className="text-hv-text-3 text-xs uppercase">
        <th className="text-left py-1">State</th>
        <th className="text-right py-1">Current (mV)</th>
        {proposed && <th className="text-right py-1">New (mV)</th>}
      </tr>
    </thead>
    <tbody>
      {STATES.map(s => {
        const [lo, hi] = BAND_KEYS[s];
        const changed = proposed && (proposed[lo] !== current[lo] || proposed[hi] !== current[hi]);
        return (
          <tr key={s} className="border-t border-hv-line">
            <td className="py-1.5 font-medium" style={{ color: STATE_INFO[s].color }}>{s}</td>
            <td className="py-1.5 text-right font-mono text-hv-text-2">{current[lo]} – {current[hi]}</td>
            {proposed && (
              <td className={`py-1.5 text-right font-mono ${changed ? 'text-hv-text font-semibold' : 'text-hv-text-2'}`}>
                {proposed[lo]} – {proposed[hi]}
              </td>
            )}
          </tr>
        );
      })}
    </tbody>
  </table>
);

const EOLCalibrationSection: React.FC<EOLCalibrationSectionProps> = ({ ipAddress, connected, logSystem, logAudit }) => {
  const base = `http://${ipAddress}:3001/api/supervision`;

  const [info, setInfo] = useState<CalInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Setup form
  const [board, setBoard] = useState(0);
  const [channel, setChannel] = useState(1);
  const [targetProfileId, setTargetProfileId] = useState('');   // '' = new profile
  const [eolOhms, setEolOhms] = useState(2200);
  const [alarmOhms, setAlarmOhms] = useState(1000);
  const [samples, setSamples] = useState(5);
  const [technician, setTechnician] = useState('');

  // Save form (review step)
  const [saveName, setSaveName] = useState('');
  const [saveMode, setSaveMode] = useState<'new' | 'overwrite'>('new');
  const [overwriteId, setOverwriteId] = useState('');
  const [makeDefault, setMakeDefault] = useState(false);
  const [assignZone, setAssignZone] = useState(true);

  // Live meter
  const [liveOn, setLiveOn] = useState(true);
  const [live, setLive] = useState<LiveReading | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const pauseLive = useRef(false);
  const setupRef = useRef<HTMLDivElement>(null);

  const session = info?.session ?? null;
  const activeState: CalState | null = session ? (session.remaining[0] ?? null) : null;
  const profiles = info?.profiles ?? [];
  const editableProfiles = profiles.filter(p => !p.builtIn);
  const profileById = (id?: string | null) => profiles.find(p => p.id === id) ?? null;
  const defaultProfile = profileById(info?.defaultProfileId) ?? profiles[0] ?? null;
  const zoneProfile = (b: number, ch: number) => profileById(info?.zoneProfiles[`${b}-${ch}`]) ?? defaultProfile;

  const zoneB = session ? session.board : board;
  const zoneCh = session ? session.channel : channel;
  const viewedProfile = zoneProfile(zoneB, zoneCh);

  const call = useCallback(async (path: string, body?: unknown, method = 'POST') => {
    const res = await fetch(`${base}${path}`, body === undefined && method === 'POST' ? {} : {
      method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }, [base]);

  const refresh = useCallback(async () => {
    try {
      const data: CalInfo = await call('/calibration');
      setInfo(data);
      setLoadError(null);
      if (data.session) {
        setBoard(data.session.board);
        setChannel(data.session.channel);
      }
    } catch (e: any) {
      setLoadError(e.message);
    }
  }, [call]);

  useEffect(() => { refresh(); }, [refresh, ipAddress]);

  // Prefill the save form once all four points are in.
  const sessionId = session?.id;
  const sessionComplete = !!session?.complete;
  useEffect(() => {
    if (!session || !session.complete) return;
    const target = profileById(session.targetProfileId);
    setSaveName(target ? target.name : session.suggestedName);
    setSaveMode(target ? 'overwrite' : 'new');
    setOverwriteId(target ? target.id : (editableProfiles[0]?.id ?? ''));
    const noSavedYet = editableProfiles.length === 0;
    const targetIsDefault = !!target && target.id === info?.defaultProfileId;
    setMakeDefault(noSavedYet || targetIsDefault);
    setAssignZone(!(noSavedYet || targetIsDefault));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, sessionComplete]);

  // Live reading on the selected channel. Paused while a capture runs so two
  // ADC reads never hit the I2C bus at once.
  useEffect(() => {
    if (!liveOn || !connected) { setLive(null); return; }
    let stop = false;
    const tick = async () => {
      if (stop || pauseLive.current) return;
      try {
        const r = await fetch(`${base}/calibration/sample/${zoneB}/${zoneCh}?samples=2`);
        const d = await r.json();
        if (!stop) {
          if (d.success === false) { setLiveError(d.error); setLive(null); }
          else { setLive({ millivolts: d.millivolts, spread: d.spread, state: d.state, profileName: d.profileName }); setLiveError(null); }
        }
      } catch (e: any) {
        if (!stop) setLiveError(e.message);
      }
    };
    tick();
    const id = setInterval(tick, 1200);
    return () => { stop = true; clearInterval(id); };
  }, [liveOn, connected, base, zoneB, zoneCh]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label); setError(null); setNotice(null);
    try { await fn(); } catch (e: any) { setError(e.message); logSystem?.('error', `[EOL Cal] ${e.message}`); }
    finally { setBusy(null); }
  };

  const chooseTarget = (id: string) => {
    setTargetProfileId(id);
    const p = profileById(id);
    if (p) { setEolOhms(p.eolResistor); setAlarmOhms(p.alarmResistor); }
  };

  const recalibrate = (p: Profile) => {
    chooseTarget(p.id);
    if (p.board !== undefined) setBoard(p.board);
    if (p.channel !== undefined) setChannel(p.channel);
    setupRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const start = () => run('start', async () => {
    await call('/calibration/start', {
      board, channel, eolResistor: eolOhms, alarmResistor: alarmOhms, samples,
      technician: technician.trim() || undefined,
      profileId: targetProfileId || undefined,
    });
    logSystem?.('info', `[EOL Cal] Started on zone ${board}-${channel}`);
    await refresh();
  });

  const capture = (state: CalState) => run(`capture-${state}`, async () => {
    pauseLive.current = true;
    try {
      const d = await call('/calibration/capture', { state, samples });
      logSystem?.('info', `[EOL Cal] ${state}: ${d.point.millivolts} mV (±${d.point.spread})`);
    } finally {
      pauseLive.current = false;
    }
    await refresh();
  });

  const apply = () => run('apply', async () => {
    const d = await call('/calibration/apply', {
      name: saveName.trim(),
      profileId: saveMode === 'overwrite' ? overwriteId : undefined,
      makeDefault,
      assignZone,
    });
    const p: Profile = d.profile;
    logSystem?.('success', `[EOL Cal] Profile "${p.name}" saved`);
    logAudit?.(`EOL calibration profile "${p.name}" saved (EOL ${p.eolResistor}Ω, alarm ${p.alarmResistor}Ω, zone ${p.board}-${p.channel})`);
    setNotice(`Saved "${p.name}".${makeDefault ? ' It is now the default profile.' : ''}${assignZone ? ` Zone ${p.board}-${p.channel} uses it.` : ''} Walk the zone through each state to verify.`);
    setTargetProfileId('');
    await refresh();
  });

  const cancel = () => run('cancel', async () => {
    await call('/calibration/cancel', {});
    await refresh();
  });

  const setDefault = (p: Profile) => run(`default-${p.id}`, async () => {
    await call(`/calibration/profiles/${encodeURIComponent(p.id)}/default`, {});
    logAudit?.(`EOL default profile set to "${p.name}"`);
    await refresh();
  });

  const rename = (p: Profile) => {
    const name = window.prompt('Profile name', p.name);
    if (!name || name.trim() === p.name) return;
    run(`rename-${p.id}`, async () => {
      await call(`/calibration/profiles/${encodeURIComponent(p.id)}`, { name: name.trim() }, 'PUT');
      await refresh();
    });
  };

  const remove = (p: Profile) => {
    const zones = Object.entries(info?.zoneProfiles ?? {}).filter(([, id]) => id === p.id).map(([z]) => z);
    const extra = zones.length ? ` Zones ${zones.join(', ')} will go back to the default profile.` : '';
    const def = p.id === info?.defaultProfileId ? ' It is the default, so the factory profile becomes the default.' : '';
    if (!window.confirm(`Delete profile "${p.name}"?${extra}${def}`)) return;
    run(`delete-${p.id}`, async () => {
      await call(`/calibration/profiles/${encodeURIComponent(p.id)}`, undefined, 'DELETE');
      logAudit?.(`EOL calibration profile "${p.name}" deleted`);
      await refresh();
    });
  };

  const assign = (b: number, ch: number, profileId: string) => run(`zone-${b}-${ch}`, async () => {
    await call(`/calibration/zones/${b}/${ch}`, { profileId: profileId === 'default' ? null : profileId }, 'PUT');
    await refresh();
  });

  const resetDefaults = () => {
    if (!window.confirm('Make the factory profile the default and clear all zone overrides? Saved profiles are kept.')) return;
    run('reset', async () => {
      await call('/calibration/reset', {});
      logAudit?.('EOL calibration reset to factory profile');
      setNotice('Factory profile is the default again and zone overrides were cleared.');
      await refresh();
    });
  };

  const maxBoards = info?.maxBoards ?? 1;
  const zonesPerBoard = info?.zonesPerBoard ?? 8;
  const preview = session?.preview ?? null;
  const targetProfile = profileById(targetProfileId);
  const plannedName = targetProfile ? targetProfile.name : `${fmtOhms(alarmOhms)}/${fmtOhms(eolOhms)}`;
  const nameClash = saveName.trim()
    ? profiles.find(p => p.name.trim().toLowerCase() === saveName.trim().toLowerCase() && !(saveMode === 'overwrite' && p.id === overwriteId))
    : undefined;
  const zoneCount = (id: string) => Object.values(info?.zoneProfiles ?? {}).filter(x => x === id).length;

  const markers = session
    ? STATES.filter(s => session.points[s]).map(s => ({ mv: session.points[s]!.millivolts, color: STATE_INFO[s].color, label: s }))
    : viewedProfile?.measurements
      ? STATES.filter(s => viewedProfile.measurements![s]).map(s => ({ mv: viewedProfile.measurements![s].millivolts, color: STATE_INFO[s].color, label: s }))
      : [];

  const actionLabel: Record<string, string> = {
    created: 'Saved', recalibrated: 'Recalibrated', renamed: 'Renamed', 'set-default': 'Set as default',
    deleted: 'Deleted', reset: 'Reset to factory', migrated: 'Imported from old calibration',
  };

  return (
    <div className="space-y-6">
      {/* Header + live bands */}
      <div className="rounded-xl p-6 border shadow-2xl" style={card}>
        <div className="flex items-start justify-between flex-wrap gap-4 mb-4">
          <div>
            <h2 className="text-2xl font-bold text-hv-text flex items-center gap-3">
              <Gauge className="w-7 h-7 text-hv-brand-fg" />
              EOL Resistor Calibration
            </h2>
            <p className="text-hv-text-2 mt-1 text-sm">
              Calibrate each resistor pair once and save it as a profile (1k/2.2k, 3k/4.5k, …). Zones use the default profile unless you assign them another.
            </p>
          </div>
          <div className="text-right text-sm">
            <div className="text-hv-text-3">Default profile</div>
            <div className="text-hv-text font-semibold">{defaultProfile?.name ?? '—'}</div>
            <div className="text-hv-text-3 text-xs mt-0.5">{editableProfiles.length} saved · {Object.keys(info?.zoneProfiles ?? {}).length} zone overrides</div>
          </div>
        </div>

        {loadError && (
          <div className="flex items-center gap-2 p-3 mb-4 rounded-lg bg-hv-error/10 border border-hv-error/40 text-hv-error-text text-sm">
            <XCircle className="w-4 h-4 shrink-0" /> Can't reach the calibration API on {ipAddress}: {loadError}
          </div>
        )}

        {info && viewedProfile && (
          <>
            <div className="text-xs text-hv-text-3 mb-1">
              {preview?.thresholds
                ? <>Bands from this calibration (not saved yet)</>
                : <>Bands for zone {zoneB}-{zoneCh}: <span className="text-hv-text-2">{viewedProfile.name}</span></>}
            </div>
            <BandBar thresholds={preview?.thresholds ?? viewedProfile.thresholds} markers={markers} live={live?.millivolts ?? null} />
            <div className="flex items-center justify-between flex-wrap gap-3 mt-1">
              <div className="flex items-center gap-3 text-sm flex-wrap">
                <button onClick={() => setLiveOn(v => !v)} className={`${btn} border border-hv-line text-hv-text-2 hover:text-hv-text`}>
                  {liveOn ? <Pause className="w-4 h-4" /> : <Activity className="w-4 h-4" />}
                  {liveOn ? 'Pause live' : 'Live reading'}
                </button>
                {live && (
                  <span className="text-hv-text-2">
                    Zone {zoneB}-{zoneCh}: <span className="font-mono text-hv-text">{live.millivolts} mV</span>{' '}
                    reads as <span className="font-semibold" style={{ color: STATE_INFO[live.state as CalState]?.color ?? 'rgb(var(--hv-text-2))' }}>{live.state}</span>
                    {live.profileName && <span className="text-hv-text-3"> ({live.profileName})</span>}
                  </span>
                )}
                {liveError && liveOn && <span className="text-hv-error-text text-xs">{liveError}</span>}
              </div>
              <button onClick={resetDefaults} disabled={!!busy || !!session} className={`${btn} text-hv-text-3 hover:text-hv-error-text`}>
                <RotateCcw className="w-4 h-4" /> Reset to factory
              </button>
            </div>
          </>
        )}
      </div>

      {error && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-hv-error/10 border border-hv-error/40 text-hv-error-text text-sm">
          <XCircle className="w-4 h-4 mt-0.5 shrink-0" /> <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)}><X className="w-4 h-4" /></button>
        </div>
      )}
      {notice && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-hv-success-text/10 border border-hv-success-text/40 text-hv-success-text text-sm">
          <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" /> <span className="flex-1">{notice}</span>
          <button onClick={() => setNotice(null)}><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* Step 1: setup */}
      {!session && info && (
        <div ref={setupRef} className="rounded-xl p-6 border" style={card}>
          <h3 className="text-lg font-semibold text-hv-text mb-1">1. Choose the resistor pair and test zone</h3>
          <p className="text-sm text-hv-text-2 mb-4">Wire a test loop with the resistors you're calibrating to one analog input.</p>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-4">
            <label className="text-sm text-hv-text-2 col-span-2 md:col-span-1 lg:col-span-1">Profile
              <select className={inputCls} value={targetProfileId} onChange={e => chooseTarget(e.target.value)}>
                <option value="">New resistor pair</option>
                {editableProfiles.map(p => <option key={p.id} value={p.id}>Recalibrate {p.name}</option>)}
              </select>
            </label>
            <label className="text-sm text-hv-text-2">Alarm resistor (Ω)
              <input type="number" min={1} className={inputCls} value={alarmOhms} onChange={e => setAlarmOhms(Number(e.target.value))} />
            </label>
            <label className="text-sm text-hv-text-2">EOL resistor (Ω)
              <input type="number" min={1} className={inputCls} value={eolOhms} onChange={e => setEolOhms(Number(e.target.value))} />
            </label>
            <label className="text-sm text-hv-text-2">Board
              <select className={inputCls} value={board} onChange={e => setBoard(Number(e.target.value))}>
                {Array.from({ length: maxBoards }, (_, i) => <option key={i} value={i}>{i}</option>)}
              </select>
            </label>
            <label className="text-sm text-hv-text-2">Channel
              <select className={inputCls} value={channel} onChange={e => setChannel(Number(e.target.value))}>
                {Array.from({ length: zonesPerBoard }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}
              </select>
            </label>
            <label className="text-sm text-hv-text-2">Samples per point
              <input type="number" min={1} max={50} className={inputCls} value={samples} onChange={e => setSamples(Math.max(1, Math.min(50, Number(e.target.value) || 5)))} />
            </label>
            <label className="text-sm text-hv-text-2">Technician
              <input className={inputCls} placeholder="optional" value={technician} onChange={e => setTechnician(e.target.value)} />
            </label>
          </div>
          <div className="mt-5 flex items-center gap-3 flex-wrap">
            <button onClick={start} disabled={!!busy || !connected} className={`${btn} bg-hv-brand text-[#101011] hover:bg-hv-brand-text`}>
              <Play className="w-4 h-4" /> {busy === 'start' ? 'Starting…' : targetProfile ? `Recalibrate ${targetProfile.name}` : 'Start calibration'}
            </button>
            <span className="text-xs text-hv-text-3">
              {targetProfile ? `Updates the existing "${targetProfile.name}" profile.` : <>Will save as <span className="text-hv-text-2">{plannedName}</span> (you can rename it before saving).</>}
            </span>
            {!connected && <span className="text-xs text-hv-text-3">Connect to a backend first.</span>}
          </div>
        </div>
      )}

      {/* Step 2: capture the four states */}
      {session && (
        <div className="rounded-xl p-6 border" style={card}>
          <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
            <div>
              <h3 className="text-lg font-semibold text-hv-text">2. Capture {session.suggestedName} on zone {session.board}-{session.channel}</h3>
              <p className="text-sm text-hv-text-2">
                Alarm {session.alarmResistor} Ω · EOL {session.eolResistor} Ω · {session.samples} samples each. Any order works; re-capture to overwrite.
              </p>
            </div>
            <button onClick={cancel} disabled={!!busy} className={`${btn} border border-hv-line text-hv-text-2 hover:text-hv-text`}>
              <X className="w-4 h-4" /> Cancel
            </button>
          </div>

          <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-4">
            {STATES.map((s, i) => {
              const p = session.points[s];
              const isNext = activeState === s;
              const meta = STATE_INFO[s];
              return (
                <div key={s} className="rounded-lg p-4 border-2 flex flex-col transition-all"
                  style={{ borderColor: isNext ? meta.color : p ? `color-mix(in srgb, ${meta.color} 40%, transparent)` : 'rgb(var(--hv-line))', background: isNext ? `color-mix(in srgb, ${meta.color} 7%, transparent)` : 'rgb(var(--hv-widget-panel) / 0.5)' }}>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-hv-text-3">Step {i + 1}</span>
                    {p ? <CheckCircle2 className="w-5 h-5" style={{ color: meta.color }} /> : isNext ? <Zap className="w-5 h-5" style={{ color: meta.color }} /> : null}
                  </div>
                  <h4 className="font-semibold mb-1" style={{ color: meta.color }}>{meta.label}</h4>
                  <p className="text-sm text-hv-text mb-1">{meta.wiring}</p>
                  <p className="text-xs text-hv-text-3 mb-3 flex-1">{meta.detail}</p>

                  {p && (
                    <div className="mb-3 p-2 rounded bg-hv-widget-panel border border-hv-line">
                      <div className="font-mono text-lg text-hv-text">{p.millivolts} mV</div>
                      <div className="text-xs text-hv-text-3">{p.volts.toFixed(3)} V · spread {p.spread} mV · {p.samplesOk}/{p.samplesRequested} reads</div>
                      {p.warnings.map(w => (
                        <div key={w} className="mt-1 text-xs text-hv-brand-text flex gap-1"><AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />{w}</div>
                      ))}
                    </div>
                  )}

                  <button onClick={() => capture(s)} disabled={!!busy}
                    className={`${btn} justify-center ${p ? 'border border-hv-line text-hv-text-2 hover:text-hv-text' : 'text-[#101011]'}`}
                    style={p ? undefined : { background: meta.color }}>
                    {busy === `capture-${s}` ? 'Reading…' : p ? 'Re-capture' : 'Capture'}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Step 3: review and save as a profile */}
      {session?.complete && preview && viewedProfile && (
        <div className="rounded-xl p-6 border" style={card}>
          <h3 className="text-lg font-semibold text-hv-text mb-3">3. Review and save profile</h3>

          {preview.errors.length > 0 && (
            <div className="mb-4 p-3 rounded-lg bg-hv-error/10 border border-hv-error/40 text-sm text-hv-error-text space-y-1">
              {preview.errors.map(e => <div key={e} className="flex gap-2"><XCircle className="w-4 h-4 mt-0.5 shrink-0" />{e}</div>)}
            </div>
          )}
          {preview.warnings.length > 0 && (
            <div className="mb-4 p-3 rounded-lg bg-hv-brand/10 border border-hv-brand/40 text-sm text-hv-brand-text space-y-1">
              {preview.warnings.map(w => <div key={w} className="flex gap-2"><AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />{w}</div>)}
            </div>
          )}

          <div className="grid md:grid-cols-2 gap-6">
            <div>
              <div className="text-xs uppercase text-hv-text-3 mb-1">Measured</div>
              <table className="w-full text-sm">
                <tbody>
                  {STATES.map(s => (
                    <tr key={s} className="border-t border-hv-line">
                      <td className="py-1.5 font-medium" style={{ color: STATE_INFO[s].color }}>{s}</td>
                      <td className="py-1.5 text-right font-mono text-hv-text">{session.points[s]!.millivolts} mV</td>
                      <td className="py-1.5 text-right text-xs text-hv-text-3">±{session.points[s]!.spread}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div>
              <div className="text-xs uppercase text-hv-text-3 mb-1">
                Thresholds vs {(saveMode === 'overwrite' ? profileById(overwriteId) : null)?.name ?? viewedProfile.name}
              </div>
              <ThresholdTable current={((saveMode === 'overwrite' ? profileById(overwriteId) : null) ?? viewedProfile).thresholds} proposed={preview.thresholds} />
            </div>
          </div>

          <p className="text-xs text-hv-text-3 mt-4 flex gap-1">
            <Info className="w-3 h-3 mt-0.5 shrink-0" />
            Boundaries sit halfway between Tamper/Alarm and Alarm/Normal, and one third of the way from Normal to Trouble (same maths as 4point.sh).
          </p>

          {/* Save options */}
          <div className="mt-5 p-4 rounded-lg border border-hv-line bg-hv-widget-panel/60 space-y-4">
            <div className="grid md:grid-cols-2 gap-4">
              <label className="text-sm text-hv-text-2">Profile name
                <input className={inputCls} value={saveName} maxLength={60} onChange={e => setSaveName(e.target.value)} placeholder="e.g. 1k/2.2k" />
              </label>
              <div className="text-sm text-hv-text-2">
                Save as
                <div className="flex items-center gap-4 mt-2 flex-wrap">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" checked={saveMode === 'new'} onChange={() => setSaveMode('new')} className="accent-hv-brand" />
                    New profile
                  </label>
                  <label className={`flex items-center gap-2 ${editableProfiles.length ? 'cursor-pointer' : 'opacity-40'}`}>
                    <input type="radio" disabled={!editableProfiles.length} checked={saveMode === 'overwrite'}
                      onChange={() => { setSaveMode('overwrite'); const p = profileById(overwriteId) ?? editableProfiles[0]; if (p) { setOverwriteId(p.id); setSaveName(p.name); } }}
                      className="accent-hv-brand" />
                    Overwrite
                  </label>
                  {saveMode === 'overwrite' && (
                    <select className={`${inputCls} w-auto`} value={overwriteId}
                      onChange={e => { setOverwriteId(e.target.value); const p = profileById(e.target.value); if (p) setSaveName(p.name); }}>
                      {editableProfiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  )}
                </div>
              </div>
            </div>
            <div className="flex flex-col gap-2 text-sm text-hv-text">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={makeDefault} onChange={e => setMakeDefault(e.target.checked)} className="accent-hv-brand" />
                Make this the default profile <span className="text-hv-text-3">(used by every zone without its own profile; now {defaultProfile?.name})</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={assignZone} onChange={e => setAssignZone(e.target.checked)} className="accent-hv-brand" />
                Use this profile for zone {session.board}-{session.channel}
              </label>
            </div>
            {nameClash && (
              <div className="text-xs text-hv-brand-text flex gap-1">
                <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                "{nameClash.name}" already exists. {nameClash.builtIn ? 'Pick another name.' : 'Choose Overwrite to replace it, or pick another name.'}
              </div>
            )}
            <div className="flex items-center gap-3">
              <button onClick={apply} disabled={!!busy || !preview.thresholds || !saveName.trim() || !!nameClash}
                className={`${btn} bg-hv-success-text text-[#101011] hover:bg-hv-success-text`}>
                <Save className="w-4 h-4" /> {busy === 'apply' ? 'Saving…' : saveMode === 'overwrite' ? 'Overwrite profile' : 'Save profile'}
              </button>
              <span className="text-xs text-hv-text-3">Takes effect immediately and is saved on the backend.</span>
            </div>
          </div>
        </div>
      )}

      {info && !session && (
        <>
          {/* Saved profiles */}
          <div className="rounded-xl p-6 border" style={card}>
            <h3 className="text-lg font-semibold text-hv-text mb-1 flex items-center gap-2"><Layers className="w-5 h-5 text-hv-text-3" /> Profiles</h3>
            <p className="text-sm text-hv-text-2 mb-4">One per resistor pair. The default applies to every zone without its own profile.</p>
            <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
              {profiles.map(p => {
                const isDefault = p.id === info.defaultProfileId;
                const count = zoneCount(p.id);
                return (
                  <div key={p.id} className="rounded-lg p-4 border flex flex-col"
                    style={{ borderColor: isDefault ? 'rgb(var(--hv-brand))' : 'rgb(var(--hv-line))', background: isDefault ? 'rgb(var(--hv-brand) / 0.05)' : 'rgb(var(--hv-widget-panel) / 0.5)' }}>
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <h4 className="font-semibold text-hv-text break-all">{p.name}</h4>
                      <div className="flex gap-1 shrink-0">
                        {isDefault && <span className="px-2 py-0.5 text-[10px] rounded-full bg-hv-brand/15 text-hv-brand-text border border-hv-brand/30 flex items-center gap-1"><Star className="w-3 h-3" />Default</span>}
                        {p.builtIn && <span className="px-2 py-0.5 text-[10px] rounded-full bg-hv-line text-hv-text-2">Built-in</span>}
                      </div>
                    </div>
                    <div className="text-xs text-hv-text-3 mb-3">
                      Alarm {fmtOhms(p.alarmResistor)}Ω · EOL {fmtOhms(p.eolResistor)}Ω · {fmtDate(p.calibrationDate)}
                      {p.technician ? ` · ${p.technician}` : ''}
                      {count > 0 && <span className="text-hv-text-2"> · {count} zone{count > 1 ? 's' : ''}</span>}
                    </div>
                    <div className="grid grid-cols-4 gap-1 mb-3 text-center">
                      {STATES.map(s => (
                        <div key={s} className="rounded py-1 bg-hv-widget-panel border border-hv-line">
                          <div className="text-[9px] font-semibold" style={{ color: STATE_INFO[s].color }}>{s}</div>
                          <div className="text-[11px] font-mono text-hv-text">{p.measurements?.[s]?.millivolts ?? '—'}</div>
                        </div>
                      ))}
                    </div>
                    <div className="flex flex-wrap gap-1 mt-auto">
                      {!isDefault && (
                        <button onClick={() => setDefault(p)} disabled={!!busy} className={`${btn} px-2 py-1 text-xs border border-hv-line text-hv-text-2 hover:text-hv-text`}>
                          <Star className="w-3 h-3" /> Make default
                        </button>
                      )}
                      {!p.builtIn && (
                        <>
                          <button onClick={() => recalibrate(p)} disabled={!!busy} className={`${btn} px-2 py-1 text-xs border border-hv-line text-hv-text-2 hover:text-hv-text`}>
                            <RefreshCw className="w-3 h-3" /> Recalibrate
                          </button>
                          <button onClick={() => rename(p)} disabled={!!busy} className={`${btn} px-2 py-1 text-xs border border-hv-line text-hv-text-2 hover:text-hv-text`}>
                            <Pencil className="w-3 h-3" /> Rename
                          </button>
                          <button onClick={() => remove(p)} disabled={!!busy} className={`${btn} px-2 py-1 text-xs border border-hv-line text-hv-text-3 hover:text-hv-error-text`}>
                            <Trash2 className="w-3 h-3" /> Delete
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="grid md:grid-cols-2 gap-6">
            {/* Zone assignment */}
            <div className="rounded-xl p-6 border" style={card}>
              <div className="flex items-center justify-between mb-1">
                <h3 className="text-lg font-semibold text-hv-text">Zones</h3>
                {maxBoards > 1 && (
                  <select className={`${inputCls} w-auto`} value={board} onChange={e => setBoard(Number(e.target.value))}>
                    {Array.from({ length: maxBoards }, (_, i) => <option key={i} value={i}>Board {i}</option>)}
                  </select>
                )}
              </div>
              <p className="text-sm text-hv-text-2 mb-3">Pick a profile for zones wired with different resistors.</p>
              <table className="w-full text-sm">
                <tbody>
                  {Array.from({ length: zonesPerBoard }, (_, i) => i + 1).map(ch => {
                    const key = `${board}-${ch}`;
                    const assigned = info.zoneProfiles[key];
                    return (
                      <tr key={ch} className="border-t border-hv-line">
                        <td className="py-1.5 text-hv-text-2 w-24">Zone {key}</td>
                        <td className="py-1.5">
                          <select className={`${inputCls} py-1`} value={assigned ?? 'default'} disabled={!!busy}
                            onChange={e => assign(board, ch, e.target.value)}>
                            <option value="default">Default ({defaultProfile?.name})</option>
                            {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                          </select>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* History */}
            <div className="rounded-xl p-6 border" style={card}>
              <h3 className="text-lg font-semibold text-hv-text mb-3 flex items-center gap-2"><History className="w-5 h-5 text-hv-text-3" /> History</h3>
              {info.history.length === 0 ? (
                <p className="text-sm text-hv-text-3">Nothing yet.</p>
              ) : (
                <ul className="space-y-2 text-sm">
                  {info.history.map((h, i) => (
                    <li key={`${h.at}-${i}`} className="flex justify-between gap-3 border-t border-hv-line pt-2">
                      <span className="text-hv-text">
                        {actionLabel[h.action] ?? h.action} <span className="text-hv-text-2">{h.name}</span>
                        {h.from && <span className="text-hv-text-3"> (was {h.from})</span>}
                        {h.zone && h.action !== 'renamed' && <span className="text-hv-text-3"> · zone {h.zone}</span>}
                      </span>
                      <span className="text-hv-text-3 whitespace-nowrap">{fmtDate(h.at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default EOLCalibrationSection;
