import React, { useState, useEffect, useCallback } from 'react';
import { Network, RotateCcw, RefreshCw, Lock, AlertTriangle, Radar, Plus, Save, Trash2, KeyRound, PlugZap, X, Zap, ZapOff, HardDriveDownload, Activity, ChevronDown, ChevronRight } from 'lucide-react';
import { Socket } from 'socket.io-client';

/** ---------- Types ---------- */
type PortStatus = 'up' | 'down' | 'disconnected' | 'unknown';

type PortState = {
  port: number;
  status: PortStatus;
  admin: 'up' | 'down' | 'unknown';
  oper: 'up' | 'down' | 'unknown';
  denied: boolean;
  held?: boolean;
  label?: string;
  labelSource?: 'lldp' | 'mac' | '';
  mac?: string;
  description?: string;
  remotePort?: string;
  speedMbps?: number;
  duplex?: string;
  inOctets?: number;
  outOctets?: number;
  inErrors?: number;
  outErrors?: number;
  inDiscards?: number;
  outDiscards?: number;
  rxBps?: number;
  txBps?: number;
  poe?: 'enabled' | 'disabled' | 'unknown';
  poeHeld?: boolean;
  poeRevertAt?: number | null;
  poeOper?: string;
  poePowerMw?: number;
  poeClass?: number | null;
  poeMaxMw?: number | null;
  poePriority?: string | null;
  poeDenied?: boolean;
  ip?: string;
  alias?: string;
  checkedAt?: number | null;
};

type TrafficPoint = { at: number; rxBps: number | null; txBps: number | null; gap?: boolean };

type SwitchEvent = {
  at: number;
  kind: 'link' | 'poe' | 'reboot';
  port: number | null;
  action: string;
  reason: string | null;
  holdMs?: number | null;
};

type Snapshot = {
  profileId: string;
  at: number;
  uptimeSeconds: number;
  rebootSuspected: boolean;
  poeCapable: boolean;
  poeBudget: {
    nominalW: number | null; allocatedW: number | null; requestedW: number | null;
    consumptionW: number | null; thresholdPct: number | null; thresholdW: number | null;
    operationalStatus: string | null; managementMode: string | null; powerSource: string | null;
    overSubscribed: boolean;
  } | null;
  arpCount: number;
  lldpCount: number;
  ports: PortState[];
};

type HeldPort = {
  profileId: string;
  port: number;
  reason: string | null;
  disabledAt: number;
  revertAt: number | null;
  holdMs: number;
  msRemaining: number | null;
};

type SwitchProfile = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  vendor: string;
  interfacePrefix: string;
  portCount: number;
  autoDetectSelfPort: boolean;
  hasCredential: boolean;
  configuredDenyPorts: number[];
  portAliases: Record<string, string>;
  denyPorts: number[];
  selfPort: number | null;
};

type ProfileDraft = {
  id: string; name: string; host: string; port: number; username: string;
  interfacePrefix: string; portCount: number; denyPorts: string;
  autoDetectSelfPort: boolean;
};

type SwitchStatus = {
  initialized: boolean;
  profiles: SwitchProfile[];
  heldPorts: HeldPort[];
  queueLength: number;
  processing: boolean;
  stats: Record<string, number | string | null>;
};

interface SwitchSectionProps {
  ipAddress: string;
  connected: boolean;
  socket: Socket | null;
  logSystem: (type: string, message: string) => void;
  logAudit: (message: string) => void;
}

/** Hold durations. Everything except the last auto-reverts, so a port taken down
 *  and forgotten comes back on its own. The indefinite option exists because
 *  decommissioning a port is a real operational need, but it is called out
 *  plainly and confirmed rather than being just another entry in the list. */
/** Beyond this many lines the chart is unreadable, so extra selections are
 *  charted-out rather than crammed in. */
const MAX_CHART_PORTS = 8;

/** Above this many ports the tiles drop to a compact faceplate - number,
 *  colour and sparkline only, everything else in the selection panel. A
 *  52-port switch cannot carry a label per tile and stay readable. */
const COMPACT_ABOVE = 12;

/** How often the board refreshes itself while the tab is open. This is the
 *  cheap two-command read, not a full scan. */
const LIVE_POLL_MS = 15000;

/** One colour per line, drawn from the existing palette so a chart with eight
 *  series still looks like the rest of the app. */
const SERIES_COLORS = ['#5FB7B0', '#F0A73C', '#8FB488', '#E0705F', '#8FD3CD', '#FFC66E', '#7BD497', '#C08578'];

const HOLDS = [
  // 0 means no auto-revert. Deliberately last and clearly worded: everything
  // above it heals itself, this one does not.
  { label: '30 seconds', ms: 30_000 },
  { label: '5 minutes', ms: 300_000 },
  { label: '15 minutes', ms: 900_000 },
  { label: '1 hour', ms: 3_600_000 },
  { label: '4 hours', ms: 14_400_000 },
  { label: '24 hours', ms: 86_400_000 },
  { label: '7 days', ms: 604_800_000 },
  { label: 'Permanent', ms: 0 },
];

async function fetchJson(url: string, init?: RequestInit, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || body.success === false) {
      throw new Error(body.error || `HTTP ${r.status}`);
    }
    return body;
  } finally {
    clearTimeout(t);
  }
}

function fmtRemaining(ms: number | null): string {
  if (ms == null) return 'no auto-revert';
  if (ms <= 0) return 'Now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function fmtBps(bps: number): string {
  if (!bps) return '0 bps';
  if (bps < 1000) return `${Math.round(bps)} bps`;
  if (bps < 1e6) return `${(bps / 1e3).toFixed(1)} Kbps`;
  if (bps < 1e9) return `${(bps / 1e6).toFixed(1)} Mbps`;
  return `${(bps / 1e9).toFixed(2)} Gbps`;
}

function fmtBytes(n: number): string {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

function fmtWatts(mw: number): string {
  if (!mw) return '0 W';
  return `${(mw / 1000).toFixed(1)} W`;
}

function fmtUptime(sec: number): string {
  if (!sec) return 'Unknown';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}

const SwitchSection: React.FC<SwitchSectionProps> = ({
  ipAddress, connected, socket, logSystem, logAudit,
}) => {
  const backendUrl = `http://${ipAddress}:3001`;

  const [status, setStatus] = useState<SwitchStatus | null>(null);
  const [profileId, setProfileId] = useState<string>('');
  const [ports, setPorts] = useState<PortState[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [multi, setMulti] = useState<number[]>([]);
  const [holdMs, setHoldMs] = useState<number>(HOLDS[2].ms);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [scanning, setScanning] = useState(false);
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [pwInput, setPwInput] = useState('');
  const [testResult, setTestResult] = useState<string | null>(null);
  const [aliasInput, setAliasInput] = useState('');
  const [maxWInput, setMaxWInput] = useState('');
  const [sparks, setSparks] = useState<Record<number, TrafficPoint[]>>({});
  const [events, setEvents] = useState<SwitchEvent[]>([]);
  const [showEvents, setShowEvents] = useState(false);
  const [livePolling, setLivePolling] = useState(true);
  const [traffic, setTraffic] = useState<{
    series: { port: number; points: TrafficPoint[] }[];
    monitoring: boolean;
    intervalMs: number | null;
  } | null>(null);
  const [, setTick] = useState(0);

  const loadStatus = useCallback(async () => {
    if (!connected) return;
    try {
      const d = await fetchJson(`${backendUrl}/api/switch/status`);
      setStatus(d);
      setError(null);
      setProfileId(prev => prev || d.profiles?.[0]?.id || '');
    } catch (e: any) {
      setError(e.message);
      setStatus(null);
    }
  }, [backendUrl, connected]);

  const loadPorts = useCallback(async (id: string) => {
    if (!connected || !id) return;
    try {
      // Prefer the last full scan - it carries labels and counters. Fall back to
      // the bare cached state when nothing has been scanned yet.
      const snap = await fetchJson(`${backendUrl}/api/switch/snapshot/${id}`);
      if (snap.ports) {
        setSnapshot(snap as Snapshot);
        setPorts(snap.ports);
        return;
      }
      const d = await fetchJson(`${backendUrl}/api/switch/ports/${id}`);
      setPorts((d.ports || []).map((p: any) => ({ ...p, status: p.admin === 'down' ? 'down' : 'unknown' })));
    } catch (e: any) {
      setError(e.message);
    }
  }, [backendUrl, connected]);

  /** Full read of the switch: status, LLDP labels, counters, uptime. */
  const scan = useCallback(async () => {
    if (!profileId) return;
    setScanning(true);
    setError(null);
    try {
      const snap = await fetchJson(`${backendUrl}/api/switch/snapshot/${profileId}`, { method: 'POST' }, 90000);
      setSnapshot(snap as Snapshot);
      setPorts(snap.ports || []);
      logSystem('success',
        `Switch ${profileId}: ${snap.ports.length} interfaces, ${snap.lldpCount} LLDP hostnames identified`);
      if (snap.rebootSuspected) {
        logSystem('warn', `Switch ${profileId} rebooted - ports were silently re-enabled, in-flight holds are void`);
      }
    } catch (e: any) {
      setError(e.message);
      logSystem('error', `Switch scan failed: ${e.message}`);
    } finally {
      setScanning(false);
    }
  }, [backendUrl, profileId, logSystem]);

  useEffect(() => { loadStatus(); }, [loadStatus]);
  useEffect(() => { loadPorts(profileId); }, [profileId, loadPorts]);

  const loadTraffic = useCallback(async () => {
    if (!connected || !profileId) { setTraffic(null); return; }
    // Chart whatever is selected. Capped at 8 lines - beyond that they stop
    // being individually readable and the chart is worse than a table.
    const wanted = (multi.length ? multi : (selected != null ? [selected] : [])).slice(0, MAX_CHART_PORTS);
    if (!wanted.length) { setTraffic(null); return; }
    try {
      const all = await Promise.all(wanted.map(async (port) => {
        const d = await fetchJson(`${backendUrl}/api/switch/traffic/${profileId}/${port}`);
        return { port, points: (d.points || []) as TrafficPoint[], monitoring: d.monitoring, intervalMs: d.intervalMs };
      }));
      setTraffic({
        series: all.map(a => ({ port: a.port, points: a.points })),
        monitoring: all[0].monitoring,
        intervalMs: all[0].intervalMs,
      });
    } catch { setTraffic(null); }
  }, [backendUrl, connected, profileId, selected, multi]);

  useEffect(() => { loadTraffic(); }, [loadTraffic]);

  /** Cheap state refresh - link and PoE only. The backend merges it into the
   *  cached snapshot, so labels and IPs from the last full scan survive. */
  const loadLive = useCallback(async () => {
    if (!connected || !profileId) return;
    try {
      const d = await fetchJson(`${backendUrl}/api/switch/live/${profileId}`, undefined, 40000);
      setPorts(prev => prev.map(p => {
        const fresh = (d.ports || []).find((x: any) => x.port === p.port);
        return fresh ? { ...p, ...fresh } : p;
      }));
      setSnapshot(prev => prev ? { ...prev, poeBudget: d.poeBudget, at: d.at } : prev);
    } catch { /* a failed poll is expected mid-disconnect; keep the last state */ }
  }, [backendUrl, connected, profileId]);

  const loadSparks = useCallback(async () => {
    if (!connected || !profileId) return;
    try {
      const d = await fetchJson(`${backendUrl}/api/switch/traffic/${profileId}`);
      setSparks(d.byPort || {});
    } catch { /* non-critical */ }
  }, [backendUrl, connected, profileId]);

  const loadEvents = useCallback(async () => {
    if (!connected || !profileId) return;
    try {
      const d = await fetchJson(`${backendUrl}/api/switch/events/${profileId}`);
      setEvents(d.events || []);
    } catch { /* non-critical */ }
  }, [backendUrl, connected, profileId]);

  useEffect(() => { loadEvents(); }, [loadEvents]);

  /**
   * Live board refresh, only while this tab is mounted and visible.
   *
   * React unmounts the component when you switch tabs, which tears the interval
   * down - so nothing polls the switch in the background. It also pauses when
   * the browser tab is hidden: a minimised window hammering a lab switch
   * overnight helps nobody.
   */
  useEffect(() => {
    if (!livePolling || !connected || !profileId) return;

    let stopped = false;
    const tick = () => {
      if (stopped || document.hidden) return;
      loadLive();
      loadSparks();
    };
    const id = setInterval(tick, LIVE_POLL_MS);
    const onVisible = () => { if (!document.hidden) tick(); };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      stopped = true;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [livePolling, connected, profileId, loadLive, loadSparks]);

  // Load the current name into the rename field whenever the selection changes.
  useEffect(() => {
    if (selected == null) { setAliasInput(''); return; }
    const p = ports.find(x => x.port === selected);
    setAliasInput(p?.alias || '');
    setMaxWInput(p?.poeMaxMw ? String(p.poeMaxMw / 1000) : '');
  }, [selected, ports]);

  // Countdown display only - the backend owns the real dead-man timers.
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!socket) return;

    const onPortChange = (d: any) => {
      logSystem('io', `Switch ${d.profileId} port ${d.port} → ${d.admin === 'down' ? 'DOWN' : 'UP'}${d.reason ? ` (${d.reason})` : ''}`);
      loadStatus();
      loadPorts(d.profileId);
      loadEvents();
    };
    const onDeadman = (d: any) => {
      logSystem('warn', `Switch port ${d.port} auto-restored - hold expired`);
      logAudit(`Dead-man revert: ${d.profileId} port ${d.port}`);
      loadStatus();
    };
    const onVerifyFailed = (d: any) => {
      logSystem('error', `Switch port ${d.port}: expected admin ${d.expected}, switch reports ${d.got}`);
    };
    const onReconcile = (d: any) => {
      logSystem('warn', `Switch reconciled ${d.repairs?.length ?? 0} port(s) against hardware`);
      loadStatus();
    };

    const onPoeChange = (d: any) => {
      logSystem(d.poe === 'disabled' ? 'warn' : 'io',
        `Switch ${d.profileId} port ${d.port} PoE ${d.poe === 'disabled' ? 'OFF' : 'ON'}${d.reason ? ` (${d.reason})` : ''}`);
      loadStatus();
      loadPorts(d.profileId);
    };

    const onSample = () => loadTraffic();
    socket.on('switch:traffic-sample', onSample);
    socket.on('switch:poe-change', onPoeChange);
    socket.on('switch:port-change', onPortChange);
    socket.on('switch:deadman-revert', onDeadman);
    socket.on('switch:verify-failed', onVerifyFailed);
    socket.on('switch:reconcile', onReconcile);
    return () => {
      socket.off('switch:traffic-sample', onSample);
      socket.off('switch:poe-change', onPoeChange);
      socket.off('switch:port-change', onPortChange);
      socket.off('switch:deadman-revert', onDeadman);
      socket.off('switch:verify-failed', onVerifyFailed);
      socket.off('switch:reconcile', onReconcile);
    };
  }, [socket, loadStatus, loadPorts, loadEvents, logSystem, logAudit]);

  const profile = status?.profiles.find(p => p.id === profileId) || status?.profiles[0];
  const held = (status?.heldPorts || []).filter(h => h.profileId === profileId);
  // A link hold and a PoE hold are separate things on the same port. Matching
  // on port alone made cutting power look like the port was already down -
  // the tile went gold and "Take port down" greyed out, so a device on an
  // external supply could not then have its link dropped.
  const heldFor = (port: number) =>
    held.find(h => h.port === port && (h as any).kind !== 'poe') || null;
  const poeHeldFor = (port: number) =>
    held.find(h => h.port === port && (h as any).kind === 'poe') || null;

  const selectedHeld = selected != null ? heldFor(selected) : null;
  const selectedPoeHeld = selected != null ? poeHeldFor(selected) : null;
  const selectedPort = selected != null ? ports.find(p => p.port === selected) || null : null;

  async function act(action: 'enable' | 'disable') {
    if (selected == null || !profile) return;
    setBusy(true);
    setError(null);
    try {
      const body: any = { profileId, port: selected, action, reason: reason.trim() || undefined };
      if (action === 'disable') body.holdMs = holdMs;
      await fetchJson(`${backendUrl}/api/switch/port`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      logAudit(`Switch ${profileId} port ${selected} ${action}d${reason ? ` - ${reason}` : ''}`);
    } catch (e: any) {
      setError(e.message);
      logSystem('error', `Switch port ${selected}: ${e.message}`);
    } finally {
      setBusy(false);
      loadStatus();
      loadPorts(profileId);
    }
  }

  /** PoE off cold-boots the device; a link shutdown does not. Separate action
   *  on purpose so it can't be hit by accident. */
  async function poeAct(action: 'enable' | 'disable') {
    if (selected == null || !profile) return;
    setBusy(true);
    setError(null);
    try {
      const body: any = { profileId, port: selected, action, reason: reason.trim() || undefined };
      if (action === 'disable') body.holdMs = holdMs;
      await fetchJson(`${backendUrl}/api/switch/poe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      logAudit(`Switch ${profileId} port ${selected} PoE ${action}d${reason ? ` - ${reason}` : ''}`);
      logSystem(action === 'disable' ? 'warn' : 'success',
        `Switch port ${selected} PoE ${action === 'disable' ? 'OFF - device will cold boot' : 'ON'}`);
    } catch (e: any) {
      setError(e.message);
      logSystem('error', `PoE change on port ${selected}: ${e.message}`);
    } finally {
      setBusy(false);
      loadStatus();
      loadPorts(profileId);
    }
  }

  /** Click selects. Ctrl/Cmd adds or removes. Shift extends from the last
   *  selection - the same conventions as a file list, so it needs no explaining. */
  function clickPort(port: number, e: React.MouseEvent) {
    if (e.shiftKey && selected != null) {
      const [lo, hi] = selected < port ? [selected, port] : [port, selected];
      const range: number[] = [];
      for (let p = lo; p <= hi; p++) {
        // A range can cross a protected port; it just isn't included, so
        // shift-selecting 1 through 10 doesn't silently arm the uplink.
        const t = ports.find(x => x.port === p);
        if (t && !t.denied) range.push(p);
      }
      setMulti(range);
      setSelected(port);
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      setMulti(prev => prev.includes(port) ? prev.filter(p => p !== port) : [...prev, port]);
      setSelected(port);
      return;
    }
    setMulti([]);
    setSelected(port);
  }

  /** Ports the action buttons will act on: the multi-selection if there is one,
   *  otherwise just the single selected port. */
  const targets = multi.length ? multi : (selected != null ? [selected] : []);

  async function bulkAct(endpoint: 'port' | 'poe', action: 'enable' | 'disable') {
    if (!targets.length || !profile) return;

    const indefinite = action === 'disable' && holdMs === 0;
    if (indefinite) {
      const what = endpoint === 'poe' ? 'stay unpowered' : 'stay down';
      if (!confirm(
        `${targets.length === 1 ? `Port ${targets[0]}` : `${targets.length} ports`} will ${what} until you ` +
        `turn ${targets.length === 1 ? 'it' : 'them'} back on.\n\n` +
        `No timer will restore ${targets.length === 1 ? 'it' : 'them'} - not after a reboot, not ever.`)) return;
    }

    setBusy(true);
    setError(null);
    try {
      const body: any = {
        profileId, action,
        reason: reason.trim() || undefined,
        ...(targets.length > 1 ? { ports: targets } : { port: targets[0] }),
      };
      if (action === 'disable') body.holdMs = holdMs;

      const d = await fetchJson(`${backendUrl}/api/switch/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, 120000);

      if (d.results) {
        const ok = d.results.filter((r: any) => r.ok);
        const bad = d.results.filter((r: any) => !r.ok);
        logAudit(`Switch ${profileId}: ${endpoint === 'poe' ? 'PoE ' : ''}${action} on ports ${targets.join(', ')}` +
          (reason ? ` - ${reason}` : ''));
        if (bad.length) {
          setError(`${bad.length} of ${d.results.length} failed: ` +
            bad.map((r: any) => `port ${r.port} (${r.error})`).join('; '));
          logSystem('error', `Switch bulk ${action}: ${bad.length} failed`);
        } else {
          logSystem('success', `Switch: ${ok.length} port(s) ${action}d`);
        }
      } else {
        logAudit(`Switch ${profileId} port ${targets[0]} ${endpoint === 'poe' ? 'PoE ' : ''}${action}d`);
      }
    } catch (e: any) {
      setError(e.message);
      logSystem('error', `Switch ${action}: ${e.message}`);
    } finally {
      setBusy(false);
      loadStatus();
      loadPorts(profileId);
    }
  }

  async function saveAlias() {
    if (selected == null || !profile) return;
    setBusy(true);
    try {
      await fetchJson(`${backendUrl}/api/switch/profiles/${profile.id}/alias`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: selected, alias: aliasInput }),
      });
      logAudit(`Switch port ${selected} named "${aliasInput || '(cleared)'}"`);
      await loadStatus();
      loadPorts(profileId);
    } catch (e: any) {
      setError(e.message);
    } finally { setBusy(false); }
  }

  /** Reservation cap, in watts on screen and milliwatts on the wire. */
  async function savePoeMax(clear = false) {
    if (selected == null || !profile) return;
    setBusy(true);
    setError(null);
    try {
      const maxMw = clear || !maxWInput.trim() ? null : Math.round(parseFloat(maxWInput) * 1000);
      const d = await fetchJson(`${backendUrl}/api/switch/poe-max`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId, port: selected, maxMw }),
      });
      logAudit(`Switch port ${selected} PoE cap ${maxMw === null ? 'cleared' : `${maxMw / 1000} W`}`);
      if (d.belowDraw) {
        logSystem('warn',
          `Port ${selected} cap is below its measured draw of ${(d.drawingMw / 1000).toFixed(1)} W - the switch may deny it power`);
      }
      if (clear) setMaxWInput('');
      await scan();
    } catch (e: any) {
      setError(e.message);
    } finally { setBusy(false); }
  }

  async function toggleMonitor() {
    if (!profile) return;
    setBusy(true);
    try {
      const on = !traffic?.monitoring;
      await fetchJson(`${backendUrl}/api/switch/monitor/${profile.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(on ? { enabled: true, intervalMs: 30000 } : { enabled: false }),
      }, 40000);
      logSystem('info', `Switch traffic monitor ${on ? 'started' : 'stopped'} for ${profile.name}`);
      await loadTraffic();
    } catch (e: any) {
      setError(e.message);
    } finally { setBusy(false); }
  }

  async function writeConfig() {
    if (!profile) return;
    if (!confirm('Save the running config to startup?\n\nPower caps will survive a reboot. ' +
      'Ports currently held down by a test will NOT be saved.')) return;
    setBusy(true);
    try {
      await fetchJson(`${backendUrl}/api/switch/write-config/${profile.id}`, { method: 'POST' }, 40000);
      logAudit(`Switch ${profile.id} config saved to startup`);
      logSystem('success', `Switch ${profile.name}: config saved`);
    } catch (e: any) {
      setError(e.message);
      logSystem('error', `Save config failed: ${e.message}`);
    } finally { setBusy(false); }
  }

  async function verify(port: number) {
    setBusy(true);
    try {
      const d = await fetchJson(`${backendUrl}/api/switch/verify/${profileId}/${port}`);
      logSystem('info', `Switch port ${port}: admin ${d.admin}, link ${d.oper}`);
      loadPorts(profileId);
    } catch (e: any) {
      logSystem('error', `Switch port ${port} read failed: ${e.message}`);
      setError(e.message);
    } finally { setBusy(false); }
  }

  async function revertAll() {
    if (!confirm('Bring every held port back up now?')) return;
    setBusy(true);
    try {
      const d = await fetchJson(`${backendUrl}/api/switch/revert-all`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'manual restore from Aether' }),
      });
      const ok = (d.results || []).filter((r: any) => r.ok).length;
      logSystem('warn', `Switch: restored ${ok} port(s)`);
      logAudit(`Restored all held switch ports (${ok})`);
    } catch (e: any) {
      logSystem('error', `Restore all failed: ${e.message}`);
    } finally {
      setBusy(false);
      loadStatus();
      loadPorts(profileId);
    }
  }

  function beginNew() {
    setIsNew(true);
    setTestResult(null);
    setDraft({
      id: '', name: '', host: '', port: 22, username: 'manager',
      interfacePrefix: 'port1.0.', portCount: 10, denyPorts: '',
      autoDetectSelfPort: true,
    });
  }

  function beginEdit() {
    if (!profile) return;
    setIsNew(false);
    setTestResult(null);
    setDraft({
      id: profile.id, name: profile.name, host: profile.host,
      port: profile.port || 22, username: profile.username,
      interfacePrefix: profile.interfacePrefix, portCount: profile.portCount,
      // Only what was configured - the auto-detected self port is not an
      // editable value and showing it here would invite saving it by accident.
      denyPorts: (profile.configuredDenyPorts || []).join(', '),
      autoDetectSelfPort: profile.autoDetectSelfPort,
    });
  }

  async function saveProfile() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const body = {
        ...draft,
        denyPorts: draft.denyPorts.split(/[,\s]+/).map(Number).filter(n => Number.isInteger(n) && n > 0),
      };
      const url = isNew
        ? `${backendUrl}/api/switch/profiles`
        : `${backendUrl}/api/switch/profiles/${draft.id}`;
      const d = await fetchJson(url, {
        method: isNew ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      logAudit(`Switch profile ${isNew ? 'added' : 'updated'}: ${d.profile.name} (${d.profile.host})`);
      logSystem('success', `Switch profile saved: ${d.profile.name}`);
      setDraft(null);
      await loadStatus();
      setProfileId(d.profile.id);
      loadPorts(d.profile.id);
    } catch (e: any) {
      setError(e.message);
    } finally { setBusy(false); }
  }

  async function deleteProfile() {
    if (!profile) return;
    if (!confirm(`Delete "${profile.name}"? Stored credentials for it are removed too.`)) return;
    setBusy(true);
    try {
      await fetchJson(`${backendUrl}/api/switch/profiles/${profile.id}`, { method: 'DELETE' });
      logAudit(`Switch profile deleted: ${profile.id}`);
      setDraft(null);
      setProfileId('');
      setPorts([]);
      setSnapshot(null);
      await loadStatus();
    } catch (e: any) {
      setError(e.message);
    } finally { setBusy(false); }
  }

  async function savePassword() {
    if (!profile || !pwInput) return;
    setBusy(true);
    try {
      await fetchJson(`${backendUrl}/api/switch/profiles/${profile.id}/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwInput }),
      });
      setPwInput('');
      logSystem('success', `Password stored for ${profile.name}`);
      await loadStatus();
    } catch (e: any) {
      setError(e.message);
    } finally { setBusy(false); }
  }

  async function testConnection() {
    if (!profile) return;
    setBusy(true);
    setTestResult(null);
    try {
      const d = await fetchJson(`${backendUrl}/api/switch/profiles/${profile.id}/test`, { method: 'POST' }, 40000);
      if (d.success) {
        setTestResult(`Connected to ${d.model || 'switch'}${d.version ? ` (${d.version})` : ''}` +
          `${d.note ? ` - ${d.note}` : ''}`);
        logSystem(d.privileged ? 'success' : 'warn', `Switch ${profile.name}: ${d.model || 'connected'}`);
      } else {
        setTestResult(`Failed: ${d.error}`);
        logSystem('error', `Switch ${profile.name}: ${d.error}`);
      }
    } catch (e: any) {
      setTestResult(`Failed: ${e.message}`);
    } finally { setBusy(false); }
  }

  /** ---------- Not connected / not initialized ---------- */
  if (!connected) {
    return (
      <div className="rounded-xl p-6 border" style={{ background: 'linear-gradient(160deg, #241E19, #1B1613)', borderColor: '#38302A' }}>
        <h1 className="text-3xl font-bold text-white flex items-center gap-3">
          <Network className="w-8 h-8 text-[#F0A73C]" />
          Switch Ports
        </h1>
        <p className="text-[#786D60] mt-3">Connect to the backend to control switch ports.</p>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="rounded-xl p-6 border" style={{ background: 'linear-gradient(160deg, #241E19, #1B1613)', borderColor: '#38302A' }}>
        <h1 className="text-3xl font-bold text-white flex items-center gap-3 mb-3">
          <Network className="w-8 h-8 text-[#F0A73C]" />
          Switch Ports
        </h1>
        {error ? (
          <>
            <p className="text-[#F5D4CD]">{error}</p>
            <p className="text-sm text-[#786D60] mt-2">
              Check that the backend started with SWITCH_PASS_LAB set and that switch/switch-config.json
              points at the right host.
            </p>
            <button onClick={loadStatus} className="mt-4 px-4 py-2 rounded-lg font-semibold bg-[#F0A73C] text-[#241503]">
              Try again
            </button>
          </>
        ) : (
          <p className="text-[#ADA294]">Loading switch status…</p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="rounded-xl p-6 border shadow-2xl" style={{ background: 'linear-gradient(160deg, #241E19, #1B1613)', borderColor: '#38302A' }}>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-3xl font-bold text-white flex items-center gap-3">
              <Network className="w-8 h-8 text-[#F0A73C]" />
              Switch Ports
            </h1>
            <p className="text-[#ADA294] mt-2">
              Take a controller's link down to test offline and recovery behaviour
            </p>
          </div>
          <div className="flex items-center gap-3">
            <select
              value={profileId}
              onChange={e => { setProfileId(e.target.value); setSelected(null); }}
              className="border rounded-lg px-3 py-2 text-white"
              style={{ background: '#241E19', borderColor: '#38302A' }}
            >
              {status.profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <button
              onClick={beginNew}
              disabled={busy}
              className="px-3 py-2 rounded-lg font-semibold flex items-center gap-1 text-[#ADA294] disabled:opacity-30"
              style={{ background: '#2A241E' }}
              title="Add a switch"
            >
              <Plus size={16} /> New
            </button>
            <button
              onClick={beginEdit}
              disabled={busy || !profile}
              className="px-3 py-2 rounded-lg font-semibold text-[#ADA294] disabled:opacity-30"
              style={{ background: '#2A241E' }}
            >
              Edit
            </button>
            <button
              onClick={scan}
              disabled={busy || scanning}
              className="px-4 py-2 rounded-lg font-semibold flex items-center gap-2 bg-[#F0A73C] text-[#241503] disabled:opacity-30"
            >
              <Radar size={16} /> {scanning ? 'Scanning…' : 'Scan switch'}
            </button>
            <button
              onClick={() => setLivePolling(v => !v)}
              title={livePolling
                ? 'Board refreshes itself every 15s while this tab is open'
                : 'Board only updates when you scan or refresh'}
              className="px-4 py-2 rounded-lg font-semibold flex items-center gap-2 text-[#ADA294]"
              style={{ background: '#2A241E' }}
            >
              <span className={`w-2 h-2 rounded-full ${livePolling ? 'bg-[#6FBF7E] animate-pulse' : 'bg-[#4A3F36]'}`} />
              {livePolling ? 'Live' : 'Paused'}
            </button>
            <button
              onClick={() => { loadStatus(); loadPorts(profileId); loadLive(); }}
              disabled={busy}
              className="px-4 py-2 rounded-lg font-semibold flex items-center gap-2 text-[#ADA294] disabled:opacity-30"
              style={{ background: '#2A241E' }}
            >
              <RefreshCw size={16} /> Refresh
            </button>
          </div>
        </div>

        {profile && (
          <div className="flex items-center gap-3 text-sm">
            <span className="px-2 py-1 rounded-full border text-[#8FD3CD]" style={{ background: 'rgba(95,183,176,.15)', borderColor: 'rgba(95,183,176,.3)' }}>
              {profile.host}
            </span>
            <span className="px-2 py-1 rounded-full border text-[#FFC66E]" style={{ background: 'rgba(240,167,60,.15)', borderColor: 'rgba(240,167,60,.3)' }}>
              {profile.portCount} ports
            </span>
            {snapshot && (
              <span className="px-2 py-1 rounded-full border text-[#ADA294]" style={{ background: '#241E19', borderColor: '#38302A' }}>
                Uptime {fmtUptime(snapshot.uptimeSeconds)} • {snapshot.lldpCount} named • {snapshot.arpCount} ARP
              </span>
            )}
            {profile.selfPort ? (
              <span className="text-[#786D60] flex items-center gap-1">
                <Lock size={13} /> Port {profile.selfPort} carries this host's own link - locked
              </span>
            ) : (
              <span className="text-[#E6C766] flex items-center gap-1">
                <AlertTriangle size={13} /> This host's own port was not identified - set denyPorts before unattended runs
              </span>
            )}
          </div>
        )}
      </div>

      {status.profiles.length === 0 && !draft && (
        <div className="rounded-xl p-8 border text-center" style={{ background: 'rgba(36, 30, 25, 0.55)', borderColor: '#38302A' }}>
          <Network className="w-10 h-10 text-[#4A3F36] mx-auto mb-3" />
          <p className="text-[#ADA294]">No switches configured yet.</p>
          <button onClick={beginNew}
                  className="mt-4 px-5 py-2 rounded-lg font-semibold bg-[#F0A73C] text-[#241503]">
            Add your first switch
          </button>
        </div>
      )}

      {/* Profile editor */}
      {draft && (
        <div className="rounded-xl p-6 border" style={{ background: 'linear-gradient(160deg, #241E19, #1B1613)', borderColor: '#F0A73C' }}>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold text-white">
              {isNew ? 'Add a switch' : `Edit ${draft.name || draft.id}`}
            </h2>
            <button onClick={() => { setDraft(null); setTestResult(null); }}
                    className="text-[#786D60] hover:text-[#F3ECE3]">
              <X size={20} />
            </button>
          </div>

          <div className="grid grid-cols-3 gap-4 mb-4">
            <Field label="Profile ID" hint={isNew ? 'letters, numbers, dash' : 'cannot be changed'}>
              <input value={draft.id} disabled={!isNew}
                     onChange={e => setDraft({ ...draft, id: e.target.value })}
                     placeholder="lab" className={inputCls} style={inputStyle} />
            </Field>
            <Field label="Display name">
              <input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })}
                     placeholder="GS970M Lab Switch" className={inputCls} style={inputStyle} />
            </Field>
            <Field label="Switch IP">
              <input value={draft.host} onChange={e => setDraft({ ...draft, host: e.target.value })}
                     placeholder="192.168.1.201" className={inputCls} style={inputStyle} />
            </Field>
            <Field label="Username">
              <input value={draft.username} onChange={e => setDraft({ ...draft, username: e.target.value })}
                     className={inputCls} style={inputStyle} />
            </Field>
            <Field label="SSH port">
              <input type="number" value={draft.port}
                     onChange={e => setDraft({ ...draft, port: Number(e.target.value) })}
                     className={inputCls} style={inputStyle} />
            </Field>
            <Field label="Interface prefix" hint="AlliedWare uses port1.0.">
              <input value={draft.interfacePrefix}
                     onChange={e => setDraft({ ...draft, interfacePrefix: e.target.value })}
                     className={inputCls} style={inputStyle} />
            </Field>
            <Field label="Port count" hint="physical ports on the unit">
              <input type="number" value={draft.portCount}
                     onChange={e => setDraft({ ...draft, portCount: Number(e.target.value) })}
                     className={inputCls} style={inputStyle} />
            </Field>
            <Field label="Never touch these ports" hint="uplink, management - comma separated">
              <input value={draft.denyPorts}
                     onChange={e => setDraft({ ...draft, denyPorts: e.target.value })}
                     placeholder="10" className={inputCls} style={inputStyle} />
            </Field>
            <Field label="Protect this host's port" hint="find it via the MAC table">
              <label className="flex items-center gap-2 mt-1 text-sm text-[#ADA294]">
                <input type="checkbox" checked={draft.autoDetectSelfPort}
                       onChange={e => setDraft({ ...draft, autoDetectSelfPort: e.target.checked })} />
                Detect automatically
              </label>
            </Field>
          </div>

          <p className="text-xs text-[#E6C766] mb-4 flex items-start gap-2">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            The uplink port carries every other device on the network. Listing it above is what stops a
            scheduled test from cutting this switch off from everything, including Aether.
          </p>

          <div className="flex gap-3">
            <button onClick={saveProfile} disabled={busy}
                    className="px-5 py-2 rounded-lg font-semibold flex items-center gap-2 bg-[#4F8B5C] hover:bg-[#3E6E48] disabled:opacity-30">
              <Save size={16} /> {isNew ? 'Add switch' : 'Save changes'}
            </button>
            {!isNew && (
              <button onClick={deleteProfile} disabled={busy}
                      className="px-5 py-2 rounded-lg font-semibold flex items-center gap-2 bg-[#C6604F] hover:bg-[#A84E3F] disabled:opacity-30">
                <Trash2 size={16} /> Delete
              </button>
            )}
          </div>
          {error && <p className="text-[#F5D4CD] text-sm mt-3">{error}</p>}
        </div>
      )}

      {/* Credentials + connection test */}
      {!draft && profile && (
        <div className="backdrop-blur rounded-xl p-6 border" style={{ background: 'rgba(36, 30, 25, 0.55)', borderColor: '#38302A' }}>
          <div className="flex items-center gap-3 flex-wrap">
            <span className={`px-2 py-1 rounded-full border text-xs ${profile.hasCredential ? 'text-[#7BD497]' : 'text-[#E6C766]'}`}
                  style={{ background: '#241E19', borderColor: '#38302A' }}>
              {profile.hasCredential ? 'Password stored' : 'No password stored'}
            </span>
            <input
              type="password" value={pwInput} onChange={e => setPwInput(e.target.value)}
              placeholder={`Password for ${profile.username}@${profile.host}`}
              className="border rounded-lg px-3 py-2 text-white w-72"
              style={{ background: '#241E19', borderColor: '#38302A' }}
            />
            <button onClick={savePassword} disabled={busy || !pwInput}
                    className="px-4 py-2 rounded-lg font-semibold flex items-center gap-2 text-[#ADA294] disabled:opacity-30"
                    style={{ background: '#2A241E' }}>
              <KeyRound size={16} /> Save password
            </button>
            <button onClick={testConnection} disabled={busy}
                    className="px-4 py-2 rounded-lg font-semibold flex items-center gap-2 text-[#ADA294] disabled:opacity-30"
                    style={{ background: '#2A241E' }}>
              <PlugZap size={16} /> Test connection
            </button>
          </div>
          {testResult && (
            <p className={`text-sm mt-3 ${testResult.startsWith('Failed') ? 'text-[#F5D4CD]' : 'text-[#CDEBD3]'}`}>
              {testResult}
            </p>
          )}
          <p className="text-xs text-[#786D60] mt-3">
            Stored on the Pi at switch/switch-credentials.json, permissions 0600. Kept out of the config file
            so that can be shared without leaking credentials.
          </p>
        </div>
      )}

      {snapshot?.rebootSuspected && (
        <div className="rounded-xl p-4 border flex items-start gap-3"
             style={{ background: 'rgba(198,96,79,.12)', borderColor: 'rgba(198,96,79,.5)' }}>
          <AlertTriangle className="text-[#E0705F] mt-0.5" size={20} />
          <div>
            <div className="font-semibold text-[#F5D4CD]">This switch rebooted</div>
            <p className="text-sm text-[#ADA294] mt-1">
              Port changes are never written to startup-config, so every port came back up on its own.
              Any hold that spanned the reboot is void - and so is the scenario result that depended on it.
            </p>
          </div>
        </div>
      )}

      {/* Held ports */}
      {held.length > 0 && (
        <div className="rounded-xl p-6 border" style={{ background: 'rgba(199,154,52,.10)', borderColor: 'rgba(199,154,52,.45)' }}>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xl font-bold text-[#F3E4BE] flex items-center gap-2">
              <div className="w-3 h-3 bg-[#E6C766] rounded-full animate-pulse" />
              {held.filter(h => (h as any).kind !== 'poe').length} down
              {held.some(h => (h as any).kind === 'poe') &&
                `, ${held.filter(h => (h as any).kind === 'poe').length} unpowered`}
            </h2>
            <button
              onClick={revertAll}
              disabled={busy}
              className="px-4 py-2 rounded-lg font-semibold flex items-center gap-2 bg-[#C79A34] text-[#241503] disabled:opacity-30"
            >
              <RotateCcw size={16} /> Restore all
            </button>
          </div>
          <div className="space-y-2">
            {held.map(h => (
              <div key={h.port} className="rounded-lg p-3 border flex items-center justify-between"
                   style={{ background: 'rgba(21, 17, 11, 0.5)', borderColor: '#2A241E' }}>
                <div>
                  <div className="font-semibold text-white">
                    Port {h.port}{(h as any).kind === 'poe' ? ' - power off' : ''}
                  </div>
                  <div className="text-xs text-[#786D60]">
                    Down since {new Date(h.disabledAt).toLocaleTimeString()}
                    {h.reason ? ` • ${h.reason}` : ''}
                  </div>
                </div>
                <div className={`text-sm font-semibold ${h.revertAt ? 'text-[#F3E4BE]' : 'text-[#E0705F]'}`}>
                  {h.revertAt
                    ? `back in ${fmtRemaining(h.revertAt - Date.now())}`
                    : 'held indefinitely'}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* PoE power budget */}
      {snapshot?.poeCapable && snapshot.poeBudget && (
        <div className="backdrop-blur rounded-xl p-6 border"
             style={{ background: 'rgba(36, 30, 25, 0.55)',
                      borderColor: snapshot.poeBudget.overSubscribed ? 'rgba(198,96,79,.5)' : '#38302A' }}>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-2xl font-bold flex items-center gap-2">
              <div className="w-3 h-3 bg-[#C79A34] rounded-full animate-pulse" />
              Power Budget
            </h2>
            <div className="flex items-center gap-3">
              <span className="text-sm text-[#786D60]">
                {snapshot.poeBudget.operationalStatus || 'Unknown'} • {snapshot.poeBudget.managementMode || '-'} • {snapshot.poeBudget.powerSource || '-'}
              </span>
              <button onClick={writeConfig} disabled={busy}
                      title="Persist power caps to startup config. Test port states are never saved."
                      className="px-3 py-1.5 rounded-lg font-semibold flex items-center gap-2 text-[#ADA294] disabled:opacity-30"
                      style={{ background: '#2A241E' }}>
                <HardDriveDownload size={15} /> Save config
              </button>
            </div>
          </div>

          {(() => {
            const b = snapshot.poeBudget!;
            const cap = b.allocatedW || b.nominalW || 0;
            const usedPct = cap ? Math.min(100, ((b.consumptionW || 0) / cap) * 100) : 0;
            const reqPct = cap ? Math.min(100, ((b.requestedW || 0) / cap) * 100) : 0;
            return (
              <>
                <div className="grid grid-cols-4 gap-4 mb-4">
                  <Stat label="Consumption" value={`${b.consumptionW ?? '-'} W`} />
                  <Stat label="Allocated" value={`${b.allocatedW ?? '-'} W`} />
                  <Stat label="Requested" value={`${b.requestedW ?? '-'} W`}
                        warn={b.overSubscribed} />
                  <Stat label="Threshold" value={b.thresholdW ? `${b.thresholdW} W (${b.thresholdPct}%)` : '-'} />
                </div>

                {/* Actual draw against capacity. The requested marker sits on the
                    same bar because that is the number that causes denials. */}
                <div className="relative h-3 rounded-full overflow-hidden" style={{ background: '#241E19' }}>
                  <div className="h-full" style={{
                    width: `${usedPct}%`,
                    background: usedPct > (b.thresholdPct || 80) ? '#C79A34' : '#4F8B5C',
                  }} />
                  {reqPct > 0 && (
                    <div className="absolute top-0 h-full w-0.5 bg-[#E0705F]"
                         style={{ left: `${Math.min(99.5, reqPct)}%` }}
                         title={`Requested ${b.requestedW} W`} />
                  )}
                </div>
                <div className="flex justify-between text-xs text-[#786D60] mt-1">
                  <span>{b.consumptionW ?? 0} W drawing now</span>
                  <span>{cap} W available</span>
                </div>

                {b.overSubscribed && (
                  <div className="mt-4 rounded-lg p-3 border flex items-start gap-2"
                       style={{ background: 'rgba(198,96,79,.12)', borderColor: 'rgba(198,96,79,.5)' }}>
                    <AlertTriangle size={16} className="text-[#E0705F] mt-0.5 shrink-0" />
                    <div className="text-sm">
                      <div className="font-semibold text-[#F5D4CD]">
                        Devices are asking for {b.requestedW} W but only {b.allocatedW} W is allocated
                      </div>
                      <p className="text-[#ADA294] mt-1">
                        {b.managementMode === 'Static'
                          ? `Nothing is actually drawing that much - only ${b.consumptionW ?? 0} W is in use. In static mode the switch reserves each device's advertised class maximum rather than its real draw, so a 6 W camera on a class 4 port still ties up 30 W. Cap the reservation per port below to free it.`
                          : 'The switch is refusing power to at least one port.'}
                      </p>
                      <p className="text-[#ADA294] mt-2">
                        Until it is resolved, cutting power to one device frees budget another may immediately
                        claim - so a PoE test can change which ports are powered as a side effect, and the
                        result won't be repeatable.
                      </p>
                    </div>
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}

      {/* Port grid */}
      {profile && <div className="backdrop-blur rounded-xl p-6 border" style={{ background: 'rgba(36, 30, 25, 0.55)', borderColor: '#38302A' }}>
        <h2 className="text-2xl font-bold mb-4 flex items-center gap-2">
          <div className="w-3 h-3 bg-[#F0A73C] rounded-full animate-pulse" />
          Interfaces
        </h2>

        {(() => {
          const compact = ports.length > COMPACT_ABOVE;
          // Faceplate order: odd ports on the top row, even beneath, matching
          // the physical unit. Makes "port 7" something you can point at in the
          // rack rather than a number in an arbitrary grid.
          const odd = ports.filter(p => p.port % 2 === 1);
          const even = ports.filter(p => p.port % 2 === 0);
          const cols = Math.max(odd.length, even.length, 1);

          const renderTile = (p: PortState) => {
            const h = heldFor(p.port);
            const ph = poeHeldFor(p.port);
            const isSel = selected === p.port;
            let bg = '#2A231C', fg = '#786D60', ring = '#2A241E';
            if (p.denied) {
              if (p.status === 'up') { bg = 'rgba(79,139,92,.18)'; fg = '#8FB488'; }
              else if (p.status === 'down') { bg = 'rgba(198,96,79,.18)'; fg = '#C08578'; }
              else if (p.status === 'disconnected') { bg = 'rgba(95,183,176,.15)'; fg = '#6E9C98'; }
              else { bg = '#241E19'; fg = '#5C5348'; }
              ring = '#38302A';
            }
            else if (h)                           { bg = 'rgba(199,154,52,.35)'; fg = '#F3E4BE'; ring = '#C79A34'; }
            else if (p.status === 'down')         { bg = 'rgba(198,96,79,.35)'; fg = '#F5D4CD'; ring = '#C6604F'; }
            else if (p.status === 'up')           { bg = 'rgba(79,139,92,.35)'; fg = '#CDEBD3'; ring = '#4F8B5C'; }
            else if (p.status === 'disconnected') { bg = 'rgba(95,183,176,.28)'; fg = '#8FD3CD'; ring = '#5FB7B0'; }

            const spark = sparks[p.port] || [];

            return (
              <button
                key={p.port}
                onClick={(e) => clickPort(p.port, e)}
                title={p.denied
                  ? 'Protected - view only. Uplink, management, or this host\'s own port.'
                  : `${p.status}${p.alias ? ` • ${p.alias}` : ''}${p.ip ? ` • ${p.ip}` : ''}` +
                    `${p.speedMbps ? ` • ${p.speedMbps} Mbps` : ''}` +
                    `${(p.poePowerMw || 0) > 0 ? ` • ${fmtWatts(p.poePowerMw || 0)}` : ''}`}
                className={`rounded-lg border-2 transition-all text-center flex flex-col justify-start ${compact ? 'px-1 py-2' : 'px-2 py-3'}`}
                style={{
                  // Fixed height so both rows align even when one port reports
                  // wattage and its neighbour does not.
                  minHeight: compact ? 88 : 210,
                  background: bg, color: fg,
                  borderColor: (isSel || multi.includes(p.port)) ? '#F0A73C' : ring,
                  boxShadow: multi.includes(p.port) ? '0 0 0 2px rgba(240,167,60,.35)' : undefined,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {/* The jack itself. Link LED follows the port being up; the
                    activity LED follows whether traffic has moved recently, so
                    a live board blinks roughly the way the hardware does. */}
                <RJ45
                  color={fg}
                  linkUp={p.status === 'up'}
                  active={(spark.at(-1)?.rxBps || 0) > 0 || (spark.at(-1)?.txBps || 0) > 0}
                  poePowered={(p.poePowerMw || 0) > 0}
                  poeDisabled={p.poe === 'disabled' || !!ph}
                  size={compact ? 28 : 60}
                />

                <div className={`font-bold flex items-center justify-center gap-1.5 truncate mt-2 ${
                  compact ? 'text-lg' : (p.alias ? 'text-2xl' : 'text-5xl')
                }`}>
                  {p.denied && <Lock size={compact ? 12 : 20} />}
                  {compact ? p.port : (p.alias ? p.alias : p.port)}
                </div>

                {!compact && p.alias && <div className="text-base opacity-60 leading-snug">Port {p.port}</div>}
                {!compact && (
                  <div className="text-base truncate leading-snug mt-1.5"
                       style={{ opacity: p.labelSource === 'lldp' ? 0.95 : 0.7 }}>
                    {p.ip || p.label || '\u2014'}
                  </div>
                )}

                <Sparkline points={spark} color={fg} />

                {(p.poe === 'disabled' || ph) && (
                  <div className={`mt-1.5 flex items-center justify-center gap-1.5 text-[#E6C766] ${compact ? 'text-[11px]' : 'text-base'}`}>
                    <ZapOff size={compact ? 11 : 18} />{compact ? '' : ' no power'}
                  </div>
                )}
                {p.poeDenied && (
                  <div className={`mt-1.5 flex items-center justify-center gap-1.5 text-[#E0705F] ${compact ? 'text-[11px]' : 'text-base'}`}
                       title="The switch refused power - it is over budget">
                    <AlertTriangle size={compact ? 11 : 18} />{compact ? '' : ' denied'}
                  </div>
                )}
                {!compact && !p.poeDenied && p.poe !== 'disabled' && (p.poePowerMw || 0) > 0 && (
                  <div className="text-lg mt-1.5 font-semibold" style={{ color: '#F0A73C', opacity: 0.95 }}>
                    {fmtWatts(p.poePowerMw || 0)}
                  </div>
                )}
              </button>
            );
          };

          return (
            <div className="mb-4 overflow-x-auto">
              {/* Chassis. The recessed inner panel and the brushed top edge are
                  what make two rows of jacks read as one piece of equipment
                  rather than a grid of buttons. */}
              {/* block, not inline-block: an inline chassis shrinks to its
                  content, so the 1fr columns inside never expand and the
                  faceplate ends up floating in empty space. */}
              <div
                className="rounded-lg p-3 min-w-full"
                style={{
                  background: 'linear-gradient(180deg, #221C17 0%, #191410 100%)',
                  border: '1px solid #3A322B',
                  boxShadow: 'inset 0 1px 0 rgba(255,255,255,.04), inset 0 -12px 20px rgba(0,0,0,.35)',
                }}
              >
                <div className="flex items-center justify-between mb-2 px-1">
                  <span className="text-base tracking-widest text-[#786D60] font-medium">
                    {profile?.name || 'SWITCH'}
                  </span>
                  <span className="text-base tracking-widest text-[#786D60] font-medium">
                    {ports.length} PORTS
                  </span>
                </div>
                <div className="grid gap-2"
                     style={{ gridTemplateColumns: `repeat(${cols}, minmax(${compact ? 56 : 150}px, 1fr))` }}>
                  {odd.map(renderTile)}
                  {even.map(renderTile)}
                </div>
              </div>
            </div>
          );
        })()}

        <div className="text-sm text-[#786D60]">
          {/* Two different kinds of thing, so they are grouped apart: the tile's
              colour is one state out of several, while the badges below it can
              appear on top of any of them. Run together, the PoE icon reads as
              if it belonged to whichever swatch precedes it. */}
          <div className="flex flex-wrap gap-4 items-center">
            <span className="text-[#5C5348]">State</span>
            <Legend color="#4F8B5C" label="Link up" />
            <Legend color="#C6604F" label="Admin down" />
            <Legend color="#5FB7B0" label="Disconnected" />
            <Legend color="#C79A34" label="Held by a Test" />
            <Legend color="#4A3F36" label="Not Scanned" />
          </div>
          <div className="flex flex-wrap gap-4 items-center mt-2 pt-2 border-t" style={{ borderColor: '#2A241E' }}>
            <span className="text-[#5C5348]">LEDs</span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-1.5 rounded-sm" style={{ background: '#2F6B3C' }} /> Link Up
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-1.5 rounded-sm" style={{ background: '#7BD497' }} /> Passing Traffic
            </span>
            {snapshot?.poeCapable && (
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-1.5 rounded-sm" style={{ background: '#F0A73C' }} /> Drawing Power
              </span>
            )}
            {snapshot?.poeCapable && (
              <span className="flex items-center gap-1.5">
                <ZapOff size={11} className="text-[#E6C766]" /> PoE Disabled
              </span>
            )}
          </div>

          <div className="flex flex-wrap gap-4 items-center mt-2 pt-2 border-t" style={{ borderColor: '#2A241E' }}>
            <span className="text-[#5C5348]">Badges</span>
            <span className="flex items-center gap-1.5">
              <Lock size={11} className="text-[#786D60]" /> protected (view only)
            </span>
            {/* Only explain badges that are actually on screen. A legend entry
                with nothing matching it is what made the PoE bolt look like it
                belonged to the swatch beside it. */}
            {ports.some(p => p.poeDenied) && (
              <span className="flex items-center gap-1.5">
                <AlertTriangle size={11} className="text-[#E0705F]" /> power denied (over budget)
              </span>
            )}
          </div>
        </div>
        {!snapshot && (
          <p className="text-xs text-[#786D60] mt-3">
            Tiles stay grey until you scan. Scanning reads status, LLDP neighbours, MAC table and counters.
          </p>
        )}
      </div>}

      {/* Selected port */}
      {selected != null && profile && (
        <div className="backdrop-blur rounded-xl p-6 border" style={{ background: 'rgba(36, 30, 25, 0.55)', borderColor: '#38302A' }}>
          <div className="flex items-center justify-between mb-4 gap-4 flex-wrap">
            <h2 className="text-2xl font-bold flex items-center gap-2">
              <div className="w-3 h-3 bg-[#5FB7B0] rounded-full" />
              {multi.length > 1
                ? `${multi.length} ports selected - ${multi.join(', ')}`
                : `Port ${selected}${selectedPort?.alias ? ` - ${selectedPort.alias}` : ''}`}
            </h2>
            <div className="flex items-center gap-2" style={{ display: multi.length > 1 ? 'none' : undefined }}>
              <input
                value={aliasInput}
                onChange={e => setAliasInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') saveAlias(); }}
                placeholder="Name this port"
                maxLength={40}
                className="border rounded-lg px-3 py-1.5 text-white w-56"
                style={{ background: '#241E19', borderColor: '#38302A' }}
              />
              <button onClick={saveAlias} disabled={busy}
                      className="px-3 py-1.5 rounded-lg font-semibold text-[#ADA294] disabled:opacity-30"
                      style={{ background: '#2A241E' }}>
                Save name
              </button>
              {snapshot?.poeCapable && (
                <>
                  <input
                    value={maxWInput}
                    onChange={e => setMaxWInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') savePoeMax(); }}
                    placeholder="Max W"
                    title="Power reserved for this port. Class 4 devices reserve 30 W by default."
                    className="border rounded-lg px-3 py-1.5 text-white w-24"
                    style={{ background: '#241E19', borderColor: '#38302A' }}
                  />
                  <button onClick={() => savePoeMax()} disabled={busy || !!selectedPort?.denied}
                          className="px-3 py-1.5 rounded-lg font-semibold text-[#ADA294] disabled:opacity-30"
                          style={{ background: '#2A241E' }}>
                    Set Wattage Cap
                  </button>
                  {selectedPort?.poeMaxMw ? (
                    <button onClick={() => savePoeMax(true)} disabled={busy}
                            title="Remove the cap and go back to the class default"
                            className="px-3 py-1.5 rounded-lg text-[#786D60] disabled:opacity-30"
                            style={{ background: '#2A241E' }}>
                      Clear
                    </button>
                  ) : null}
                </>
              )}
            </div>
          </div>

          {selectedPort?.denied && (
            <div className="rounded-lg p-3 border mb-4 flex items-start gap-2"
                 style={{ background: 'rgba(240,167,60,.08)', borderColor: 'rgba(240,167,60,.35)' }}>
              <Lock size={15} className="text-[#F0A73C] mt-0.5 shrink-0" />
              <div className="text-sm">
                <span className="font-semibold text-[#FFC66E]">View only.</span>
                <span className="text-[#ADA294]">
                  {' '}This port is on the protected list - it carries the uplink, management, or this host's own
                  connection. You can read it, name it and watch its traffic, but nothing here will change its
                  state. Remove it from denyPorts in the profile if that's really what you want.
                </span>
              </div>
            </div>
          )}

          <p className="text-xs text-[#786D60] mb-3">
            Ctrl-click to add ports, shift-click for a range.
            {multi.length > 1 && (
              <button onClick={() => { setMulti([]); }} className="ml-2 underline text-[#ADA294]">
                clear selection
              </button>
            )}
          </p>

          {selectedPoeHeld && (
            <p className="text-[#F3E4BE] mb-4 flex items-center gap-2">
              <ZapOff size={15} />
              Power cut since {new Date(selectedPoeHeld.disabledAt).toLocaleTimeString()} -{' '}
              {selectedPoeHeld.revertAt
                ? `restored in ${fmtRemaining(selectedPoeHeld.revertAt - Date.now())}`
                : 'stays off until you restore it'}.
              {' '}The link can still be taken down separately.
            </p>
          )}

          {selectedHeld ? (
            <p className="text-[#F3E4BE] mb-4">
              Held down since {new Date(selectedHeld.disabledAt).toLocaleTimeString()} - comes back in{' '}
              {fmtRemaining(selectedHeld.revertAt ? selectedHeld.revertAt - Date.now() : null)}.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-4 mb-4 max-w-2xl">
              <label className="text-sm text-[#ADA294]">
                Bring back after
                <select
                  value={holdMs}
                  onChange={e => setHoldMs(Number(e.target.value))}
                  className="mt-1 w-full border rounded-lg px-3 py-2 text-white"
                  style={{ background: '#241E19', borderColor: '#38302A' }}
                >
                  {HOLDS.map(h => <option key={h.ms} value={h.ms}>{h.label}</option>)}
                </select>
              </label>
              {holdMs === 0 && (
                <p className="col-span-2 text-xs text-[#E6C766] flex items-start gap-2">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                  Nothing will bring these back automatically. Use this to decommission a port, not to run a
                  test - a scheduled run that crashes would leave them down permanently.
                </p>
              )}
              <label className="text-sm text-[#ADA294]">
                Reason
                <input
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  placeholder="CLC-004"
                  className="mt-1 w-full border rounded-lg px-3 py-2 text-white"
                  style={{ background: '#241E19', borderColor: '#38302A' }}
                />
              </label>
            </div>
          )}

          <div className="flex gap-3">
            <button
              onClick={() => bulkAct('port', 'disable')}
              disabled={busy || !!selectedHeld || !!selectedPort?.denied}
              className="px-5 py-2 rounded-lg font-semibold bg-[#C6604F] hover:bg-[#A84E3F] disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Disable Port
            </button>
            <button
              onClick={() => bulkAct('port', 'enable')}
              disabled={busy || !!selectedPort?.denied}
              className="px-5 py-2 rounded-lg font-semibold bg-[#4F8B5C] hover:bg-[#3E6E48] disabled:opacity-30"
            >
              Enable Port
            </button>
            {snapshot?.poeCapable && (
              <>
                <button
                  onClick={() => bulkAct('poe', 'disable')}
                  disabled={busy || selectedPort?.poe === 'disabled' || !!selectedPoeHeld || !!selectedPort?.denied}
                  title="Cuts power - the device cold boots and loses volatile state"
                  className="px-5 py-2 rounded-lg font-semibold flex items-center gap-2 bg-[#C79A34] text-[#241503] disabled:opacity-30"
                >
                  <ZapOff size={22} /> Disable PoE
                </button>
                <button
                  onClick={() => bulkAct('poe', 'enable')}
                  disabled={busy || !!selectedPort?.denied}
                  className="px-5 py-2 rounded-lg font-semibold flex items-center gap-2 bg-[#5FB7B0] text-[#241503] hover:bg-[#4E9C96] disabled:opacity-30"
                >
                  <Zap size={22} /> Enable PoE
                </button>
              </>
            )}
            <button
              onClick={() => verify(selected)}
              disabled={busy}
              className="px-5 py-2 rounded-lg font-semibold bg-[#F0A73C] text-[#241503] hover:bg-[#C9862E] disabled:opacity-30"
            >
              Inspect Port
            </button>
          </div>

          {error && <p className="text-[#F5D4CD] text-sm mt-3">{error}</p>}

          {snapshot?.poeCapable && selectedPort && maxWInput &&
            parseFloat(maxWInput) * 1000 < (selectedPort.poePowerMw || 0) && (
            <p className="text-xs text-[#E6C766] mt-3 flex items-start gap-2">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              {parseFloat(maxWInput)} W is below the {fmtWatts(selectedPort.poePowerMw || 0)} this port is
              drawing right now - the switch would deny it power.
            </p>
          )}
          {snapshot?.poeCapable && (
            <p className="text-xs text-[#786D60] mt-3">
            </p>
          )}
          <p className="text-xs text-[#786D60] mt-4">
          </p>
        </div>
      )}

      {/* Event log - collapsed by default; it is a record to check after a run,
          not something you watch. */}
      {profile && events.length > 0 && (
        <div className="backdrop-blur rounded-xl border" style={{ background: 'rgba(36, 30, 25, 0.55)', borderColor: '#38302A' }}>
          <button
            onClick={() => setShowEvents(v => !v)}
            className="w-full flex items-center justify-between p-5 text-left"
          >
            <h2 className="text-xl font-bold flex items-center gap-2">
              {showEvents ? <ChevronDown size={20} className="text-[#786D60]" /> : <ChevronRight size={20} className="text-[#786D60]" />}
              Event Log
              <span className="text-sm font-normal text-[#786D60]">
                {events.length} change{events.length === 1 ? '' : 's'} on this switch
              </span>
            </h2>
            <span className="text-xs text-[#786D60]">
              {new Date(events[events.length - 1].at).toLocaleTimeString()} - most recent
            </span>
          </button>

          {showEvents && (
            <div className="px-5 pb-5">
              <div className="max-h-72 overflow-y-auto text-sm">
                {[...events].reverse().map((e, i) => {
                  const disable = e.action === 'disable';
                  const color = e.kind === 'reboot' ? '#E0705F' : disable ? '#F5D4CD' : '#CDEBD3';
                  return (
                    <div key={i} className="flex items-baseline gap-3 py-1.5 border-b"
                         style={{ borderColor: '#2A241E' }}>
                      <span className="text-[#786D60] tabular-nums whitespace-nowrap">
                        {new Date(e.at).toLocaleTimeString()}
                      </span>
                      <span className="px-2 py-0.5 rounded text-xs shrink-0"
                            style={{ background: '#2A241E', color: '#ADA294' }}>
                        {e.kind}
                      </span>
                      <span style={{ color }}>
                        {e.kind === 'reboot'
                          ? 'Switch rebooted - ports were silently re-enabled'
                          : `Port ${e.port} ${e.kind === 'poe' ? 'power' : 'link'} ${e.action}d`}
                        {e.holdMs ? ` for ${fmtRemaining(e.holdMs)}` : ''}
                      </span>
                      {e.reason && <span className="text-[#786D60] truncate">{e.reason}</span>}
                    </div>
                  );
                })}
              </div>
              <p className="text-xs text-[#786D60] mt-3">
                Kept in memory since the backend started, and drawn as markers on the traffic chart above.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Selected port monitor */}
      {selected != null && selectedPort && snapshot && (
        <div className="backdrop-blur rounded-xl p-6 border" style={{ background: 'rgba(36, 30, 25, 0.55)', borderColor: '#38302A' }}>
          <h2 className="text-2xl font-bold mb-4 flex items-center gap-2">
            <div className="w-3 h-3 bg-[#8FB488] rounded-full" />
            Port {selected} Monitor
          </h2>
          <div className="grid grid-cols-2 gap-x-10 gap-y-2 text-sm max-w-4xl">
            <Row label="Device" value={selectedPort.label || 'Unknown'} />
            <Row label="Link" value={
              selectedPort.status === 'up' ? 'Up'
              : selectedPort.status === 'disconnected' ? 'Down (nothing connected)'
              : selectedPort.status === 'down' ? 'Administratively down'
              : 'Unknown'} />
            <Row label="Identified via" value={
              selectedPort.labelSource === 'lldp' ? 'LLDP'
              : selectedPort.labelSource === 'mac' ? 'Learned MAC (not a hostname)'
              : 'Not identified'} />
            <Row label="Speed" value={selectedPort.speedMbps ? `${selectedPort.speedMbps} Mbps` : 'Not reported'} />
            <Row label="IP address" value={selectedPort.ip || 'Not in ARP table'} />
            <Row label="MAC" value={selectedPort.mac || '\u2014'} />
            <Row label="Duplex" value={selectedPort.duplex && selectedPort.duplex !== 'Unknown' ? selectedPort.duplex : 'Not reported'} />
            <Row label="Remote port" value={selectedPort.remotePort || '\u2014'} />
            <Row label="Throughput" value={`RX ${fmtBps(selectedPort.rxBps || 0)} • TX ${fmtBps(selectedPort.txBps || 0)}`} />
            <Row label="Description" value={selectedPort.description || '\u2014'} />
            <Row label="Traffic totals" value={`RX ${fmtBytes(selectedPort.inOctets || 0)} • TX ${fmtBytes(selectedPort.outOctets || 0)}`} />
            <Row label="PoE" value={
              selectedPort.poe === 'disabled' ? 'Disabled (no power)'
              : selectedPort.poeDenied ? 'Denied - switch is over budget'
              : selectedPort.poe === 'enabled' ? `Enabled (${selectedPort.poeOper || 'unknown'})`
              : 'Not reported'}
              warn={selectedPort.poe === 'disabled' || !!selectedPort.poeDenied} />
            <Row label="PoE draw" value={
              (selectedPort.poePowerMw || 0) > 0
                ? `${fmtWatts(selectedPort.poePowerMw || 0)}${selectedPort.poeMaxMw ? ` of ${fmtWatts(selectedPort.poeMaxMw)} max` : ''}` +
                  `${selectedPort.poeClass != null ? ` • class ${selectedPort.poeClass}` : ''}`
                : 'Not drawing power'} />
            <Row label="Errors" value={`IN ${selectedPort.inErrors || 0} • OUT ${selectedPort.outErrors || 0}`}
                 warn={!!((selectedPort.inErrors || 0) + (selectedPort.outErrors || 0))} />
            <Row label="Drops" value={`IN ${selectedPort.inDiscards || 0} • OUT ${selectedPort.outDiscards || 0}`}
                 warn={!!((selectedPort.inDiscards || 0) + (selectedPort.outDiscards || 0))} />
          </div>
          <p className="text-xs text-[#786D60] mt-4">
            Throughput is derived from the counter change between the last two scans, not a live rate.
            Scanned {new Date(snapshot.at).toLocaleTimeString()}.
          </p>
        </div>
      )}

      {/* Traffic over time */}
      {targets.length > 0 && profile && (
        <div className="backdrop-blur rounded-xl p-6 border" style={{ background: 'rgba(36, 30, 25, 0.55)', borderColor: '#38302A' }}>
          <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
            <h2 className="text-2xl font-bold flex items-center gap-2">
              <div className="w-3 h-3 bg-[#5FB7B0] rounded-full" />
              {targets.length > 1 ? `Traffic - ${Math.min(targets.length, MAX_CHART_PORTS)} ports` : `Port ${targets[0]} Traffic`}
            </h2>
            <div className="flex items-center gap-4">
              {targets.length > MAX_CHART_PORTS && (
                <span className="text-xs text-[#E6C766]">
                  showing the first {MAX_CHART_PORTS} of {targets.length}
                </span>
              )}
              <button onClick={toggleMonitor} disabled={busy}
                      className={`px-4 py-2 rounded-lg font-semibold flex items-center gap-2 disabled:opacity-30 ${
                        traffic?.monitoring ? 'bg-[#C6604F] hover:bg-[#A84E3F]' : 'text-[#ADA294]'}`}
                      style={traffic?.monitoring ? {} : { background: '#2A241E' }}>
                <Activity size={16} /> {traffic?.monitoring ? 'Stop monitoring' : 'Start monitoring'}
              </button>
            </div>
          </div>

          {traffic?.monitoring
            ? <TrafficChart
                series={traffic.series}
                events={events.filter(e => e.port === null || targets.includes(e.port))}
                labelFor={(port) => {
                  const p = ports.find(x => x.port === port);
                  return p?.alias ? `${port} - ${p.alias}` : `Port ${port}`;
                }}
              />
            : (
              <p className="text-sm text-[#786D60] py-8 text-center">
                Not monitoring. Sampling reads the switch every 30 seconds - worth running while a scenario
                is going, not around the clock.
              </p>
            )}

          {traffic?.monitoring && (
            <p className="text-xs text-[#786D60] mt-2">
              Sampled every {Math.round((traffic.intervalMs || 30000) / 1000)}s. Rates are derived from the
              change in the switch's counters between samples, so a disconnect shows up as traffic falling to
              zero - and a switch reboot breaks the line rather than drawing a spike.
            </p>
          )}
        </div>
      )}
    </div>
  );
};

const inputCls = 'border rounded-lg px-3 py-2 text-white w-full disabled:opacity-50';
const inputStyle: React.CSSProperties = { background: '#241E19', borderColor: '#38302A' };

/**
 * Traffic chart, drawn as plain SVG so it adds no dependency.
 *
 * Receive and transmit share one axis scaled to the largest value across both,
 * so the two are directly comparable - a separate scale each would make a
 * trickle look like a flood. Gaps (counter resets) break the line rather than
 * being interpolated across, because a straight line through a reboot implies
 * traffic that never happened.
 */
/**
 * 20px inline traffic line for a port tile.
 *
 * Scaled to its own peak rather than a shared one: a sparkline answers "is this
 * port doing anything, and did it stop", and a shared scale would flatten every
 * quiet port to a flat line indistinguishable from a dead one.
 */
/**
 * RJ45 jack outline: the wide body with the latch notch cut into the top.
 * Drawn rather than styled with CSS because the notch is a shape, not a border,
 * and it is the single feature that makes the tile read as an Ethernet port
 * rather than a rounded rectangle.
 *
 * The two LEDs sit where they do on real hardware: link and activity on the
 * left, PoE on the right, both above the jack.
 */
const RJ45: React.FC<{
  color: string;
  linkUp: boolean;
  active: boolean;
  poePowered: boolean;
  poeDisabled: boolean;
  size?: number;
}> = ({ color, linkUp, active, poePowered, poeDisabled, size = 34 }) => {
  const W = 40, H = 34;

  // Green LED, left, as on the hardware: dim when the link is merely up, bright
  // and pulsing when traffic is actually moving. Dark when there is no link.
  const linkFill = !linkUp ? '#3A322B' : active ? '#7BD497' : '#2F6B3C';

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: size * (W / H), height: size, display: 'block', margin: '0 auto' }}>
      <rect x="5" y="1" width="6" height="2.5" rx="1" fill={linkFill}>
        {linkUp && active && (
          <animate attributeName="opacity" values="1;0.35;1" dur="1.2s" repeatCount="indefinite" />
        )}
      </rect>

      {/* Right slot: amber PoE LED when the port is delivering power. When PoE
          has been switched off it becomes a bolt rather than going dark -
          "no power because someone disabled it" and "no power because nothing
          is plugged in" are different facts and should not look the same. */}
      {poeDisabled ? (
        <path d="M33.6,0 l-3.2,4.2 h2.1 l-1.4,3.2 4,-4.6 h-2.2 z"
              fill="#E6C766" />
      ) : (
        <rect x="29" y="1" width="6" height="2.5" rx="1"
              fill={poePowered ? '#F0A73C' : '#3A322B'} />
      )}

      {/* Jack body with the latch notch, centred in the 40-wide viewBox.
          The path closes exactly where it started - an earlier version began at
          x=3 and returned to x=4, which skewed the whole outline and pushed the
          notch off-centre. */}
      <path
        d="M4,8 h10 v-3 h12 v3 h10 a2,2 0 0 1 2,2 v20 a2,2 0 0 1 -2,2 h-32 a2,2 0 0 1 -2,-2 v-20 a2,2 0 0 1 2,-2 z"
        fill="rgba(0,0,0,.35)" stroke={color} strokeWidth="1.4" strokeLinejoin="round"
      />
      {/* Eight contacts, centred on the same axis as the body. */}
      {[0,1,2,3,4,5,6,7].map(i => (
        <rect key={i} x={7.2 + i * 3.2} y="12" width="1.4" height="8" rx="0.5"
              fill={color} opacity="0.45" />
      ))}
    </svg>
  );
};

const Sparkline: React.FC<{ points: TrafficPoint[]; color: string }> = ({ points, color }) => {
  const valid = points.filter(p => p.rxBps != null);
  const peak = valid.length ? Math.max(...valid.map(p => Math.max(p.rxBps || 0, p.txBps || 0))) : 0;

  // With no samples, or samples that are all zero, the old version still drew a
  // path along the baseline - a full-width horizontal rule on every tile that
  // read as a divider rather than "no traffic". Draw nothing instead.
  if (valid.length < 2 || peak <= 0) return null;

  const W = 100, H = 20;
  const t0 = points[0].at, t1 = points[points.length - 1].at;
  const span = Math.max(1, t1 - t0);

  let d = '', pen = false;
  for (const p of points) {
    if (p.rxBps == null) { pen = false; continue; }
    const v = Math.max(p.rxBps || 0, p.txBps || 0);
    const x = ((p.at - t0) / span) * W;
    const y = H - (v / peak) * (H - 3) - 1.5;
    d += `${pen ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)} `;
    pen = true;
  }

  return (
    // Inset panel so the trace sits inside the tile instead of running edge to
    // edge across it.
    <div className="mx-2 mt-2 rounded"
         style={{ background: 'rgba(0,0,0,.25)', padding: '2px 4px' }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
           style={{ width: '100%', height: 20, display: 'block' }}>
        <path d={d.trim()} fill="none" stroke={color} strokeWidth="1.5"
              opacity="0.9" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
};

const TrafficChart: React.FC<{
  series: { port: number; points: TrafficPoint[] }[];
  labelFor: (port: number) => string;
  events?: SwitchEvent[];
}> = ({ series, labelFor, events = [] }) => {
  const W = 900, H = 240, PAD_L = 60, PAD_B = 26, PAD_T = 12, PAD_R = 10;

  const all = series.flatMap(s => s.points).filter(p => p.rxBps != null && p.txBps != null);
  if (all.length < 2) {
    return (
      <p className="text-sm text-[#786D60] py-8 text-center">
        Collecting samples - a rate needs at least two readings.
      </p>
    );
  }

  // One shared scale across every port and both directions. Per-series scaling
  // would make an idle port's noise look like the busiest port's traffic.
  const peak = Math.max(...all.map(p => Math.max(p.rxBps || 0, p.txBps || 0)), 1);
  const times = series.flatMap(s => s.points.map(p => p.at));
  const t0 = Math.min(...times), t1 = Math.max(...times);
  const span = Math.max(1, t1 - t0);

  const x = (at: number) => PAD_L + ((at - t0) / span) * (W - PAD_L - PAD_R);
  const y = (v: number) => PAD_T + (1 - v / peak) * (H - PAD_T - PAD_B);

  // Break the path at gaps rather than drawing through them: a straight line
  // across a counter reset implies traffic that never happened.
  const buildPath = (points: TrafficPoint[], key: 'rxBps' | 'txBps') => {
    let d = '', pen = false;
    for (const p of points) {
      const v = p[key];
      if (v == null) { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${x(p.at).toFixed(1)},${y(v).toFixed(1)} `;
      pen = true;
    }
    return d.trim();
  };

  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => peak * f);
  const fmtAxis = (v: number) =>
    v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(0)}k` : String(Math.round(v));

  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 260 }}>
        {ticks.map((v, i) => (
          <g key={i}>
            <line x1={PAD_L} x2={W - PAD_R} y1={y(v)} y2={y(v)} stroke="#2A241E" strokeWidth="1" />
            <text x={PAD_L - 8} y={y(v) + 4} textAnchor="end" fontSize="11" fill="#786D60">{fmtAxis(v)}</text>
          </g>
        ))}
        <text x={12} y={H / 2} fontSize="11" fill="#786D60"
              transform={`rotate(-90 12 ${H / 2})`} textAnchor="middle">bits/sec</text>

        {series.map((s, i) => {
          const c = SERIES_COLORS[i % SERIES_COLORS.length];
          return (
            <g key={s.port}>
              {/* Transmit is dashed so a single colour can carry both directions
                  for a port - eight ports would otherwise need sixteen colours. */}
              <path d={buildPath(s.points, 'rxBps')} fill="none" stroke={c} strokeWidth="2" />
              <path d={buildPath(s.points, 'txBps')} fill="none" stroke={c} strokeWidth="1.5"
                    strokeDasharray="4 3" opacity="0.85" />
            </g>
          );
        })}

        {/* What Aether did, drawn over the traffic it caused. Without these the
            chart shows a line falling to zero and nothing saying why. */}
        {events
          .filter(e => e.at >= t0 && e.at <= t1)
          .map((e, i) => {
            const ex = x(e.at);
            const disable = e.action === 'disable';
            const c = e.kind === 'reboot' ? '#E0705F' : disable ? '#C6604F' : '#4F8B5C';
            return (
              <g key={i}>
                <line x1={ex} x2={ex} y1={PAD_T} y2={H - PAD_B}
                      stroke={c} strokeWidth="1" strokeDasharray="3 3" opacity="0.8" />
                <circle cx={ex} cy={PAD_T + 4} r="3.5" fill={c} />
                <title>
                  {`${new Date(e.at).toLocaleTimeString()} - ${e.kind === 'reboot' ? 'switch rebooted' : `port ${e.port} ${e.kind} ${e.action}`}${e.reason ? ` (${e.reason})` : ''}`}
                </title>
              </g>
            );
          })}

        <text x={PAD_L} y={H - 6} fontSize="11" fill="#786D60">{new Date(t0).toLocaleTimeString()}</text>
        <text x={W - PAD_R} y={H - 6} fontSize="11" fill="#786D60" textAnchor="end">
          {new Date(t1).toLocaleTimeString()}
        </text>
      </svg>

      <div className="flex flex-wrap gap-x-5 gap-y-2 mt-3 text-xs">
        {series.map((s, i) => (
          <span key={s.port} className="flex items-center gap-1.5 text-[#ADA294]">
            <span className="w-4 h-0.5" style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }} />
            {labelFor(s.port)}
          </span>
        ))}
        <span className="flex items-center gap-1.5 text-[#786D60] ml-auto">
          <span className="w-4 h-0.5 bg-[#786D60]" /> solid = receive
          <span className="w-4 h-0.5 ml-3"
                style={{ background: 'repeating-linear-gradient(90deg,#786D60 0 4px,transparent 4px 7px)' }} />
          dashed = transmit
        </span>
      </div>
    </>
  );
};

const Stat: React.FC<{ label: string; value: string; warn?: boolean }> = ({ label, value, warn }) => (
  <div className="rounded-lg p-3 border" style={{ background: 'rgba(21, 17, 11, 0.5)', borderColor: '#2A241E' }}>
    <div className="text-xs text-[#786D60]">{label}</div>
    <div className={`text-xl font-bold ${warn ? 'text-[#E6C766]' : 'text-[#F3ECE3]'}`}>{value}</div>
  </div>
);

const Field: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <label className="block">
    <span className="text-sm text-[#ADA294]">{label}</span>
    {hint && <span className="text-xs text-[#786D60] ml-2">{hint}</span>}
    <div className="mt-1">{children}</div>
  </label>
);

const Row: React.FC<{ label: string; value: string; warn?: boolean }> = ({ label, value, warn }) => (
  <div className="flex justify-between gap-4 border-b py-1" style={{ borderColor: '#2A241E' }}>
    <span className="text-[#786D60]">{label}</span>
    <span className={warn ? 'text-[#E6C766]' : 'text-[#F3ECE3]'}>{value}</span>
  </div>
);

const Legend: React.FC<{ color: string; label: string }> = ({ color, label }) => (
  <span className="flex items-center gap-1.5">
    <span className="w-3 h-3 rounded" style={{ background: color }} />
    {label}
  </span>
);

export default SwitchSection;
