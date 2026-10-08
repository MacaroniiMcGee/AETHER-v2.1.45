/**
 * Stream View data layer.
 *
 * Pulls everything the VMS video-wall page shows from the real backend
 * (port 3001) and live socket.io events, and normalises it into one model.
 * `?demo=4` / `?demo=8` / `?demo=12` swaps in generated data for previews and
 * for checking the layout without hardware.
 */
import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';

// ---------- Model ----------

export type DoorState = 'SECURE' | 'UNLOCKED' | 'OPEN' | 'FORCED' | 'HELD' | 'DISABLED' | 'OFFLINE';
export type ZoneState = 'NORMAL' | 'ALARM' | 'TAMPER' | 'TROUBLE' | 'UNKNOWN' | 'ERROR';

export interface AccessEvent {
  at: number;
  kind: 'granted' | 'denied' | 'card' | 'door' | 'alarm' | 'system' | 'automation';
  text: string;
  where?: string;
}

export interface StreamDoor {
  id: number;
  name: string;
  enabled: boolean;
  source: 'hardware' | 'emulated';
  group: string;              // "Board 11" / "Hardware I/O" — used to break 8 doors down
  unlocked: boolean;
  open: boolean;
  rex: boolean;
  state: DoorState;
  stateSince: number;
  readerName: string | null;
  lastCard: { text: string; result: 'granted' | 'denied' | 'read'; at: number } | null;
  ioLabel: string;            // "Relay 1 · In 1/2" or "Board 11 · Out 0"
  boardOffline?: boolean;     // emulated board not being polled by the panel
}

export interface StreamDiag {
  socket: boolean;
  http: boolean;
  counts: Record<string, number>;   // socket events received, by name
  lastEventAt: number | null;
}

export interface StreamModel {
  connected: boolean;
  diag?: StreamDiag;
  nodeName: string;
  host: string;
  now: number;
  backendUptimeSec: number | null;
  systemOutputs: { key: string; name: string; active: boolean; configured: boolean }[];
  doors: StreamDoor[];
  elevator: {
    configured: boolean;
    carFloor: number;
    targetFloor: number | null;
    floors: { id: number; name: string; access: boolean; called: boolean }[];
    trips: number;
    granted: number;
    denied: number;
    live: boolean;           // true when the Elevator page is publishing state
  };
  io: {
    relays: (0 | 1 | null)[];
    inputs: (0 | 1 | null)[];
    zones: { channel: number; state: ZoneState; mv: number; profile: string }[];
    polledAt: number | null;
    error: string | null;
  };
  osdp: {
    rate: number[];          // frames per second, oldest -> newest (last 60 s)
    totalFrames: number;
    naks: number;
    readers: { id: string; name: string; address: number; status: string; secure: boolean; lastActivity: number | null }[];
    recent: { at: number; dir: 'TX' | 'RX'; address: number; cmd: string; len: number }[];
  };
  emulator: {
    running: boolean;
    port: string | null;
    devices: { address: number; model: string; online: boolean; polls: number; tamper: boolean; powerFail: boolean }[];
    framesIn: number;
    framesOut: number;
  };
  automation: {
    total: number;
    enabled: number;
    triggers: number;
    lastTriggerAt: number | null;
    rules: { name: string; enabled: boolean; trigger: string }[];
  };
  readers: { name: string; type: 'wiegand' | 'osdp'; online: boolean; door: string | null }[];
  events: AccessEvent[];
}

const EMPTY: StreamModel = {
  connected: false, nodeName: 'Aether', host: '', now: Date.now(), backendUptimeSec: null,
  systemOutputs: [], doors: [],
  elevator: { configured: false, carFloor: 1, targetFloor: null, floors: [], trips: 0, granted: 0, denied: 0, live: false },
  io: { relays: Array(8).fill(null), inputs: Array(8).fill(null), zones: [], polledAt: null, error: null },
  osdp: { rate: Array(60).fill(0), totalFrames: 0, naks: 0, readers: [], recent: [] },
  emulator: { running: false, port: null, devices: [], framesIn: 0, framesOut: 0 },
  automation: { total: 0, enabled: 0, triggers: 0, lastTriggerAt: null, rules: [] },
  readers: [],
  events: [],
};

// ---------- Door state logic ----------

const HELD_OPEN_MS = 30_000;
const LOCK_PULSE_HOLD_MS = 2_500;   // keep a short IC2 unlock pulse visible
const CARD_DECISION_MS = 5_000;     // card counts as granted if the lock pulses within this

const OSDP_CMD: Record<number, string> = {
  0x40: 'ACK', 0x41: 'NAK', 0x45: 'PDID', 0x46: 'PDCAP', 0x48: 'LSTATR', 0x49: 'ISTATR', 0x4A: 'OSTATR',
  0x4B: 'RSTATR', 0x50: 'RAW', 0x51: 'FMT', 0x53: 'KEYPAD', 0x76: 'CCRYPT', 0x78: 'RMAC_I', 0x79: 'BUSY',
  0x60: 'POLL', 0x61: 'ID', 0x62: 'CAP', 0x64: 'LSTAT', 0x65: 'ISTAT', 0x66: 'OSTAT', 0x67: 'RSTAT',
  0x68: 'OUT', 0x69: 'LED', 0x6A: 'BUZ', 0x6B: 'TEXT', 0x6E: 'COMSET', 0xA2: 'ACURXSIZE',
};
function frameCmdName(hex: string | undefined, cmd?: number): string {
  let c = typeof cmd === 'number' ? cmd : NaN;
  if (Number.isNaN(c) && hex && hex.length >= 12) c = parseInt(hex.slice(10, 12), 16);
  if (Number.isNaN(c)) return 'UNK';
  return OSDP_CMD[c] || `0x${c.toString(16).padStart(2, '0')}`;
}

export function deriveDoorState(d: { enabled: boolean; unlocked: boolean; open: boolean; openSince?: number | null }, now: number): DoorState {
  if (!d.enabled) return 'DISABLED';
  if (d.open && !d.unlocked) return 'FORCED';
  if (d.open && d.openSince && now - d.openSince > HELD_OPEN_MS) return 'HELD';
  if (d.open) return 'OPEN';
  if (d.unlocked) return 'UNLOCKED';
  return 'SECURE';
}

// ---------- Helpers ----------

async function getJson(url: string, timeoutMs = 4000): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

export function getBackendUrl() {
  const params = new URLSearchParams(window.location.search);
  const override = params.get('backend');
  if (override) return override.startsWith('http') ? override : `http://${override}:3001`;
  const host = window.location.hostname || 'localhost';
  return `http://${host}:3001`;
}

// ---------- Live hook ----------

export function useStreamData(backendOverride?: string): StreamModel {
  const params = new URLSearchParams(window.location.search);
  const demo = params.get('demo');
  const live = useLiveStreamData(demo ? null : (backendOverride || getBackendUrl()));
  const fake = useDemoData(demo ? Math.max(1, Math.min(16, parseInt(demo, 10) || 4)) : 0);
  return demo ? fake : live;
}

function useLiveStreamData(backendUrl: string | null): StreamModel {
  const [model, setModel] = useState<StreamModel>(EMPTY);
  const doorCfg = useRef<any[]>([]);
  const sysOut = useRef<Record<string, any>>({});
  const doorRuntime = useRef<Map<number, { openSince: number | null; stateSince: number; last: DoorState | null; lastCard: StreamDoor['lastCard']; prevCard?: StreamDoor['lastCard'] }>>(new Map());
  const emuDevices = useRef<Map<number, any>>(new Map());
  const hw = useRef<{ relays: (0 | 1 | null)[]; inputs: (0 | 1 | null)[] }>({ relays: Array(8).fill(null), inputs: Array(8).fill(null) });
  const frameCount = useRef(0);
  const nakCount = useRef(0);
  const totalFrames = useRef(0);
  const recentFrames = useRef<StreamModel['osdp']['recent']>([]);
  const rate = useRef<number[]>(Array(60).fill(0));
  const events = useRef<AccessEvent[]>([]);
  const lockPulse = useRef<Map<string, number>>(new Map());          // "addr:out" -> hold-until ms
  const pendingCard = useRef<Map<number, { text: string; at: number; port: number }>>(new Map()); // by board
  const lastRaw = useRef<Map<number, { unlocked: boolean; open: boolean; rex: boolean }>>(new Map());
  const counts = useRef<Record<string, number>>({});
  const lastEventAt = useRef<number | null>(null);
  const frameEventAt = useRef<number>(0);
  const emuFramePrev = useRef<{ total: number; at: number } | null>(null);
  const httpOk = useRef(false);
  const count = (name: string) => { counts.current[name] = (counts.current[name] || 0) + 1; lastEventAt.current = Date.now(); };

  const pushEvent = (e: AccessEvent) => {
    events.current = [e, ...events.current].slice(0, 40);
  };

  useEffect(() => {
    if (!backendUrl) return;
    let stopped = false;
    // Default transport order (polling, then upgrade) so it still connects where WebSocket is blocked
    const socket: Socket = io(backendUrl, { reconnection: true });
    socket.onAny((name: string) => count(name));

    const merge = (patch: Partial<StreamModel>) => setModel(m => ({ ...m, ...patch }));

    socket.on('connect', () => merge({ connected: true }));
    socket.on('disconnect', () => merge({ connected: false }));

    // OSDP wire traffic (both reader emulation and controller emulator share this tap)
    const addFrame = (f: { dir: 'TX' | 'RX'; address: number; cmd: string; len: number }) => {
      frameEventAt.current = Date.now();
      frameCount.current++;
      totalFrames.current++;
      if (f.cmd === 'NAK') nakCount.current++;
      recentFrames.current = [{ at: Date.now(), ...f }, ...recentFrames.current].slice(0, 12);
    };
    // Controller emulator traffic (panel <-> emulated boards): 'in' = command from the panel
    socket.on('emulator-frame', (f: any) => {
      addFrame({
        dir: f?.direction === 'out' ? 'RX' : 'TX',
        address: Number(f?.addr ?? -1),
        cmd: frameCmdName(f?.hex, typeof f?.cmd === 'number' ? f.cmd : undefined),
        len: f?.hex ? f.hex.length / 2 : 0,
      });
    });
    // Reader emulation traffic (this unit acting as OSDP readers)
    socket.on('osdp-wire-frame', (f: any) => {
      frameEventAt.current = Date.now();
      frameCount.current++;
      totalFrames.current++;
      if (f?.cmdName === 'NAK') nakCount.current++;
      recentFrames.current = [{
        at: Date.now(), dir: (f?.isReply ? 'RX' : 'TX') as 'RX' | 'TX', address: Number(f?.address ?? -1),
        cmd: String(f?.cmdName || 'UNK'), len: Number(f?.length || 0),
      }, ...recentFrames.current].slice(0, 12);
    });

    socket.on('osdp_card_read', (d: any) => {
      pushEvent({ at: Date.now(), kind: 'card', text: `Card ${d?.card ?? d?.uid ?? ''}`.trim(), where: d?.readerId });
    });
    socket.on('output-changed', (d: any) => {
      const addr = Number(d?.address);
      const dev = emuDevices.current.get(addr);
      if (dev && Array.isArray(dev.outputs)) dev.outputs[d.outNum] = d.state ? 1 : 0;
      // IC2 unlocks with a short pulse; hold it so the 1 Hz view can't miss it
      if (d?.state) lockPulse.current.set(`${addr}:${d.outNum}`, Date.now() + LOCK_PULSE_HOLD_MS);
    });
    socket.on('emulator-device-update', (snap: any) => {
      if (snap && typeof snap.address === 'number') emuDevices.current.set(snap.address, snap);
    });
    socket.on('gpio_state_change', (d: any) => {
      const pin = Number(d?.pin);
      if (pin >= 0 && pin < 8) hw.current.relays[pin] = d.value ? 1 : 0;
    });
    socket.on('input_state_change', (d: any) => {
      const ch = Number(d?.channel ?? d?.pin);
      if (ch >= 0 && ch < 8) hw.current.inputs[ch] = (d?.state ?? d?.value) ? 1 : 0;
    });
    socket.on('vms:elevator', (el: any) => {
      if (el && Array.isArray(el.floors)) merge({ elevator: { ...el, configured: true, live: true } });
    });
    socket.on('vms:event', (e: any) => {
      if (!e || !e.text) return;
      if (e.kind === 'card' && typeof e.address === 'number') {
        // pair with the door on this board/reader port; resolved in tick()
        pendingCard.current.set(e.address, { text: String(e.text).replace(/^Card /, ''), at: e.at || Date.now(), port: Number(e.port ?? 0) });
        const door = doorCfg.current.find((d: any) => d.ioSource === 'emulated' && Number(d.emuBoard) === e.address && Number(d.emuReaderPort ?? 0) === Number(e.port ?? 0));
        pushEvent({ at: e.at || Date.now(), kind: 'card', text: `Card presented · ${String(e.text).replace(/^Card /, '')}`, where: door?.name || e.where });
        return;
      }
      pushEvent({ at: e.at || Date.now(), kind: e.kind || 'system', text: e.text, where: e.where });
    });

    // Slow-changing config: doors, readers, automation, elevator snapshot
    const loadConfig = async () => {
      const [doors, wReaders, oReaders, rules, aStats, elevator, health] = await Promise.allSettled([
        getJson(`${backendUrl}/api/doors/config`),
        getJson(`${backendUrl}/api/wiegand/readers`),
        getJson(`${backendUrl}/api/osdp/readers`),
        getJson(`${backendUrl}/api/automation/rules`),
        getJson(`${backendUrl}/api/automation/stats`),
        getJson(`${backendUrl}/api/vms/elevator-state`),
        getJson(`${backendUrl}/api/health`),
      ]);
      if (stopped) return;
      if (doors.status === 'fulfilled' && doors.value?.config) {
        doorCfg.current = Array.isArray(doors.value.config.doors) ? doors.value.config.doors : [];
        sysOut.current = doors.value.config.systemOutputs || {};
      }
      const readers: StreamModel['readers'] = [];
      const osdpReaders: StreamModel['osdp']['readers'] = [];
      if (wReaders.status === 'fulfilled' && Array.isArray(wReaders.value?.readers)) {
        for (const r of wReaders.value.readers) readers.push({ name: r.name || r.id, type: 'wiegand', online: r.enabled !== false, door: null });
      }
      if (oReaders.status === 'fulfilled' && Array.isArray(oReaders.value?.readers)) {
        for (const r of oReaders.value.readers) {
          readers.push({ name: r.name || r.id, type: 'osdp', online: r.status === 'online' || r.status === 'connected', door: null });
          osdpReaders.push({
            id: r.id, name: r.name || r.id, address: r.address, status: r.status || 'unknown',
            secure: !!r.secureChannelEstablished,
            lastActivity: r.lastActivity ? new Date(r.lastActivity).getTime() : null,
          });
        }
      }
      const automation: StreamModel['automation'] = { ...EMPTY.automation };
      if (rules.status === 'fulfilled' && Array.isArray(rules.value?.rules)) {
        automation.rules = rules.value.rules.map((r: any) => ({ name: r.name || r.id, enabled: r.enabled !== false, trigger: r.trigger?.type || 'event' }));
        automation.total = automation.rules.length;
        automation.enabled = automation.rules.filter(r => r.enabled).length;
      }
      if (aStats.status === 'fulfilled' && aStats.value?.stats) {
        automation.triggers = aStats.value.stats.triggers || 0;
        automation.lastTriggerAt = aStats.value.stats.lastTriggerAt ? new Date(aStats.value.stats.lastTriggerAt).getTime() : null;
      }
      const patch: Partial<StreamModel> = { readers, automation };
      if (elevator.status === 'fulfilled' && elevator.value?.state?.floors) {
        patch.elevator = { ...elevator.value.state, configured: true, live: true };
      }
      if (health.status === 'fulfilled') {
        const h = health.value || {};
        patch.nodeName = h.nodeName || h.hostname || 'Aether';
        patch.backendUptimeSec = typeof h.uptime === 'number' ? h.uptime : null;
      }
      setModel(m => ({ ...m, ...patch, osdp: { ...m.osdp, readers: osdpReaders.length ? osdpReaders : m.osdp.readers } }));
    };

    // Emulator every 3 s (no I2C). Supervision zones are 8 ADC reads on the
    // I2C bus, so only every 15 s (the backend also shares one scan between viewers).
    let lastSupAt = 0;
    const loadStatus = async () => {
      const wantSup = Date.now() - lastSupAt >= 15000;
      if (wantSup) lastSupAt = Date.now();
      const [emu, sup] = await Promise.allSettled([
        getJson(`${backendUrl}/api/emulator/status`),
        wantSup ? getJson(`${backendUrl}/api/supervision/status`, 8000) : Promise.reject(new Error('skip')),
      ]);
      if (stopped) return;
      httpOk.current = emu.status === 'fulfilled' || sup.status === 'fulfilled';
      if (emu.status === 'fulfilled' && emu.value?.status) {
        const s = emu.value.status;
        for (const d of s.devices || []) emuDevices.current.set(d.address, d);
        // No live frame events? Estimate traffic from the emulator's own frame counters.
        const total = (s.framesIn || 0) + (s.framesOut || 0);
        const now = Date.now();
        const prev = emuFramePrev.current;
        if (prev && now - frameEventAt.current > 8000 && total >= prev.total) {
          const delta = total - prev.total;
          frameCount.current += Math.round(delta / Math.max(1, (now - prev.at) / 1000));
          totalFrames.current = Math.max(totalFrames.current, total);
        }
        emuFramePrev.current = { total, at: now };
        setModel(m => ({
          ...m,
          emulator: {
            running: !!s.running, port: s.port || null, framesIn: s.framesIn || 0, framesOut: s.framesOut || 0,
            devices: (s.devices || []).map((d: any) => ({
              address: d.address, model: d.model || 'board', online: !!d.online, polls: d.pollCount || 0,
              tamper: !!d.tamperActive, powerFail: !!d.powerFailActive,
            })),
          },
        }));
      }
      if (sup.status === 'fulfilled' && sup.value?.boards?.[0]?.zones) {
        const zones = sup.value.boards[0].zones.map((z: any) => ({
          channel: z.channel, state: z.state, mv: z.voltage, profile: z.profileName || '',
        }));
        setModel(m => ({ ...m, io: { ...m.io, zones } }));
      }
    };

    // Hardware I/O. Every read goes through the I2C queue (~150 ms apart), so:
    //  - relays come from 'gpio_state_change' events (every /api/gpio/set emits one)
    //  - only the opto inputs hardware doors actually use are polled, like the Doors page
    //  - the full 16-read board scan runs once at start and then every 60 s for the I/O panel
    const hwDoors = () => doorCfg.current.filter((d: any) => d.ioSource !== 'emulated' && d.enabled !== false);
    const loadGpioFull = async () => {
      try {
        const g = await getJson(`${backendUrl}/api/gpio/status`, 8000);
        if (stopped || !g?.relays) return;
        hw.current.relays = g.relays.map((r: any) => (r.error ? null : r.state ? 1 : 0));
        hw.current.inputs = g.inputs.map((r: any) => (r.error ? null : r.state ? 1 : 0));
        setModel(m => ({ ...m, io: { ...m.io, polledAt: Date.now(), error: null } }));
      } catch (e: any) {
        if (!stopped) setModel(m => ({ ...m, io: { ...m.io, error: e.message } }));
      }
    };
    const loadGpioDoorInputs = async () => {
      const chans = new Set<number>();
      for (const d of hwDoors()) {
        for (const io of [d.dps, d.rexIn]) {
          const ch = Number(io?.channel ?? -1);
          if (io?.hardwareType === 'opto' && ch >= 0 && ch < 8) chans.add(ch);
        }
      }
      for (const ch of chans) {
        if (stopped) return;
        try {
          const r = await getJson(`${backendUrl}/api/gpio/opto/${ch}`, 4000);
          hw.current.inputs[ch] = r?.state ? 1 : 0;
        } catch { /* keep last value */ }
      }
      if (chans.size && !stopped) setModel(m => ({ ...m, io: { ...m.io, polledAt: Date.now() } }));
    };

    // 1 Hz tick: recompute doors from config + live I/O, roll the OSDP rate window
    const tick = () => {
      const now = Date.now();
      rate.current = [...rate.current.slice(1), frameCount.current];
      frameCount.current = 0;

      const doors: StreamDoor[] = doorCfg.current.map((d: any) => {
        const emulated = d.ioSource === 'emulated';
        const dev = emulated ? emuDevices.current.get(Number(d.emuBoard)) : null;
        const outVal = (ch: number) => (dev && Array.isArray(dev.outputs) ? dev.outputs[ch] : null);
        const inVal = (ch: number) => (dev && Array.isArray(dev.inputs) ? dev.inputs[ch] : null);
        const lockCh = Number(d.lock?.channel ?? -1);
        const dpsCh = Number(d.dps?.channel ?? -1);
        const rexCh = Number(d.rexIn?.channel ?? -1);
        const pulseHeld = emulated && (lockPulse.current.get(`${Number(d.emuBoard)}:${lockCh}`) || 0) > now;
        const unlocked = emulated ? (!!outVal(lockCh) || pulseHeld) : lockCh >= 0 ? hw.current.relays[lockCh] === 1 : !!d.lock?.active;
        const open = emulated ? !!inVal(dpsCh) : dpsCh >= 0 ? hw.current.inputs[dpsCh] === 1 : !!d.dps?.active;
        const rex = emulated ? !!inVal(rexCh) : rexCh >= 0 ? hw.current.inputs[rexCh] === 1 : !!d.rexIn?.active;
        // A board the panel isn't polling still has valid I/O; flag it instead of hiding state.
        const boardOffline = emulated && !!dev && dev.online === false;
        const missing = emulated && !dev;

        const rt = doorRuntime.current.get(d.id) || { openSince: null, stateSince: now, last: null, lastCard: null };
        rt.openSince = open ? (rt.openSince ?? now) : null;
        let state = deriveDoorState({ enabled: d.enabled !== false, unlocked, open, openSince: rt.openSince }, now);
        if (missing) state = 'OFFLINE';

        // Door events from raw changes
        const prevRaw = lastRaw.current.get(d.id);
        const board = Number(d.emuBoard);
        const pc = emulated ? pendingCard.current.get(board) : undefined;
        if (prevRaw && d.enabled !== false) {
          if (unlocked && !prevRaw.unlocked) {
            if (pc && now - pc.at <= CARD_DECISION_MS) {
              rt.lastCard = { text: pc.text, result: 'granted', at: pc.at };
              // the other doors that showed this swipe as "presented" go back to their last result
              for (const [id, other] of doorRuntime.current) {
                if (id !== d.id && other.lastCard?.result === 'read' && other.lastCard.at === pc.at) other.lastCard = other.prevCard ?? null;
              }
              pushEvent({ at: now, kind: 'granted', text: `Access granted · ${pc.text}`, where: d.name });
              pendingCard.current.delete(board);
            } else {
              pushEvent({ at: now, kind: 'door', text: 'Unlocked', where: d.name });
            }
          }
          if (open && !prevRaw.open && !(state === 'FORCED')) pushEvent({ at: now, kind: 'door', text: 'Door opened', where: d.name });
          if (!open && prevRaw.open) pushEvent({ at: now, kind: 'door', text: 'Door closed', where: d.name });
          if (rex && !prevRaw.rex) pushEvent({ at: now, kind: 'door', text: 'REX pressed', where: d.name });
        }
        if (pc && pc.port === Number(d.emuReaderPort ?? 0) && (!rt.lastCard || rt.lastCard.at < pc.at)) {
          if (rt.lastCard?.result !== 'read') rt.prevCard = rt.lastCard;
          rt.lastCard = { text: pc.text, result: 'read', at: pc.at };
        }
        lastRaw.current.set(d.id, { unlocked, open, rex });
        if (state !== rt.last) {
          if (rt.last !== null && (state === 'FORCED' || state === 'HELD')) {
            pushEvent({ at: now, kind: 'alarm', text: `${d.name}: door ${state.toLowerCase()}` });
          }
          rt.stateSince = now;
          rt.last = state;
        }
        doorRuntime.current.set(d.id, rt);

        return {
          id: d.id, name: d.name || `Door ${d.id}`, enabled: d.enabled !== false,
          source: emulated ? 'emulated' : 'hardware',
          group: emulated ? `Board ${d.emuBoard}` : 'Hardware I/O',
          unlocked, open, rex, state, stateSince: rt.stateSince,
          readerName: d.reader || null, lastCard: rt.lastCard, boardOffline,
          ioLabel: emulated
            ? `Board ${d.emuBoard} · Out ${lockCh} · In ${dpsCh}/${rexCh}`
            : `Relay ${lockCh + 1} · In ${dpsCh + 1}/${rexCh + 1}`,
        };
      });

      for (const [board, pc] of Array.from(pendingCard.current.entries())) {
        if (now - pc.at <= CARD_DECISION_MS) continue;
        pendingCard.current.delete(board);
        const cfgDoor = doorCfg.current.find((d: any) => d.ioSource === 'emulated' && Number(d.emuBoard) === board && Number(d.emuReaderPort ?? 0) === pc.port)
          || doorCfg.current.find((d: any) => d.ioSource === 'emulated' && Number(d.emuBoard) === board);
        if (cfgDoor) {
          const rt = doorRuntime.current.get(cfgDoor.id);
          if (rt) rt.lastCard = { text: pc.text, result: 'denied', at: pc.at };
          for (const [id, other] of doorRuntime.current) {
            if (id !== cfgDoor.id && other.lastCard?.result === 'read' && other.lastCard.at === pc.at) other.lastCard = other.prevCard ?? null;
          }
          const sd = doors.find(x => x.id === cfgDoor.id);
          if (sd && rt) sd.lastCard = rt.lastCard;
        }
        pushEvent({ at: now, kind: 'denied', text: `Access denied · ${pc.text}`, where: cfgDoor?.name || `Board ${board}` });
      }

      const systemOutputs = Object.entries(sysOut.current).map(([key, o]: [string, any]) => {
        const ch = Number(o?.channel ?? -1);
        return { key, name: o?.name || key, configured: ch >= 0, active: ch >= 0 ? hw.current.relays[ch] === 1 : !!o?.active };
      });

      setModel(m => ({
        ...m,
        now,
        host: new URL(backendUrl).hostname,
        doors,
        systemOutputs,
        io: { ...m.io, relays: [...hw.current.relays], inputs: [...hw.current.inputs] },
        osdp: { ...m.osdp, rate: rate.current, totalFrames: totalFrames.current, naks: nakCount.current, recent: recentFrames.current },
        events: events.current,
        diag: { socket: socket.connected, http: httpOk.current, counts: { ...counts.current }, lastEventAt: lastEventAt.current },
      }));
    };

    loadConfig().then(() => { loadGpioFull(); });
    loadStatus();
    const t1 = setInterval(tick, 1000);
    const t2 = setInterval(loadStatus, 3000);
    const t3 = setInterval(() => { if (hwDoors().length) loadGpioDoorInputs(); }, 3000);
    const t5 = setInterval(loadGpioFull, 120000);
    const t4 = setInterval(loadConfig, 30000);
    return () => {
      stopped = true;
      [t1, t2, t3, t4, t5].forEach(clearInterval);
      socket.close();
    };
  }, [backendUrl]);

  return model;
}

// ---------- Demo data (preview / layout testing) ----------

const DEMO_NAMES = ['Main Entrance', 'Lobby Turnstile', 'Server Room', 'Loading Dock', 'Stairwell B', 'Exec Suite', 'Parking Gate', 'Roof Access',
  'Lab 1', 'Lab 2', 'Mail Room', 'Gym', 'Cafeteria', 'Warehouse', 'North Exit', 'South Exit'];

function useDemoData(doorCount: number): StreamModel {
  const [model, setModel] = useState<StreamModel>(EMPTY);
  const start = useRef(Date.now());

  useEffect(() => {
    if (!doorCount) return;
    const rate: number[] = Array.from({ length: 60 }, (_, i) => 18 + Math.round(6 * Math.sin(i / 5) + Math.random() * 4));
    let total = 48213;
    const recent: StreamModel['osdp']['recent'] = [];
    const cmds = ['POLL', 'ACK', 'POLL', 'ACK', 'LSTAT', 'LSTATR', 'POLL', 'RAW', 'LED', 'ACK', 'OSTAT', 'OSTATR'];
    let ci = 0;
    const cards = ['FC 123 · #12345', 'FC 123 · #99999', 'FC 511 · #1234567', 'FC 123 · #40021'];

    const build = () => {
      const now = Date.now();
      const phase = Math.floor((now - start.current) / 1000);
      const doors: StreamDoor[] = Array.from({ length: doorCount }, (_, i) => {
        const id = i + 1;
        const emulated = i < 4;
        let state: DoorState = 'SECURE';
        if (id === 2 && phase % 12 < 5) state = 'UNLOCKED';
        if (id === 2 && phase % 12 >= 2 && phase % 12 < 5) state = 'OPEN';
        if (id === 4) state = 'HELD';
        if (id === 7) state = 'FORCED';
        if (id === 6 && doorCount > 5) state = 'DISABLED';
        if (id === 8) state = 'OFFLINE';
        return {
          id, name: DEMO_NAMES[i] || `Door ${id}`, enabled: state !== 'DISABLED',
          source: emulated ? 'emulated' : 'hardware',
          group: emulated ? 'Board 11' : 'Hardware I/O',
          unlocked: state === 'UNLOCKED' || state === 'OPEN' || state === 'HELD',
          open: state === 'OPEN' || state === 'HELD' || state === 'FORCED',
          rex: id === 2 && phase % 12 === 3,
          state,
          stateSince: now - (id === 4 ? 47_000 : id === 7 ? 12_000 : (id * 61_000)),
          readerName: emulated ? `ctrl-emu-11-${i}` : `Wiegand Reader ${i - 3}`,
          lastCard: id === 3 ? { text: cards[2], result: 'denied', at: now - 95_000 }
            : { text: cards[i % 4], result: 'granted', at: now - (id * 37_000) },
          ioLabel: emulated ? `Board 11 · Out ${i} · In ${i * 2}/${i * 2 + 1}` : `Relay ${i - 3} · In ${(i - 4) * 2 + 1}/${(i - 4) * 2 + 2}`,
        };
      });

      rate.shift();
      const r = 18 + Math.round(6 * Math.sin(phase / 5) + Math.random() * 4);
      rate.push(r);
      total += r;
      for (let k = 0; k < 2; k++) {
        const cmd = cmds[ci++ % cmds.length];
        recent.unshift({ at: now, dir: ['ACK', 'LSTATR', 'OSTATR'].includes(cmd) ? 'RX' : 'TX', address: [0x0b, 0x01, 0x02][ci % 3], cmd, len: cmd === 'POLL' ? 8 : cmd === 'RAW' ? 17 : 12 });
      }
      recent.length = Math.min(recent.length, 12);

      const car = [1, 1, 2, 3, 4, 5, 5, 5, 4, 3, 2, 1][phase % 12];

      setModel({
        connected: true, nodeName: 'Pi Unit 1', host: '192.168.1.207', now, backendUptimeSec: 86400 * 3 + 7260 + phase,
        systemOutputs: [
          { key: 'powerFault', name: 'Power Fault', active: false, configured: true },
          { key: 'batteryFault', name: 'Battery Fault', active: false, configured: true },
          { key: 'tamper', name: 'System Tamper', active: phase % 20 < 3, configured: true },
          { key: 'fai', name: 'Fire Alarm Input', active: false, configured: false },
        ],
        doors,
        elevator: {
          configured: true, carFloor: car, targetFloor: phase % 12 < 5 ? 5 : 1, live: true,
          floors: [8, 7, 6, 5, 4, 3, 2, 1].map(f => ({
            id: f,
            name: ['', 'Lobby', 'Retail', 'Office Suites', 'Office Suites', 'IT & Operations', 'Conference', 'Executive', 'Penthouse'][f],
            access: f === 1 || f === 5 || (f === 3 && phase % 12 < 4),
            called: f === 5 && phase % 12 < 5,
          })),
          trips: 214 + Math.floor(phase / 12), granted: 188, denied: 9,
        },
        io: {
          relays: [0, 1, 0, 0, 1, 0, 0, 0].map((v, i) => (i === 1 ? (phase % 12 < 5 ? 1 : 0) : v)) as (0 | 1)[],
          inputs: [0, 0, 1, 0, 0, 0, 1, 0].map((v, i) => (i === 2 ? (phase % 12 >= 2 && phase % 12 < 5 ? 1 : 0) : v)) as (0 | 1)[],
          zones: [
            { channel: 1, state: 'NORMAL', mv: 381, profile: '1k/2.2k' },
            { channel: 2, state: 'NORMAL', mv: 1519, profile: '3k/4.5k' },
            { channel: 3, state: 'ALARM', mv: 205, profile: '1k/2.2k' },
            { channel: 4, state: 'NORMAL', mv: 379, profile: '1k/2.2k' },
            { channel: 5, state: 'TROUBLE', mv: 3301, profile: '1k/2.2k' },
            { channel: 6, state: 'NORMAL', mv: 383, profile: '1k/2.2k' },
            { channel: 7, state: 'TAMPER', mv: 4, profile: '1k/2.2k' },
            { channel: 8, state: 'NORMAL', mv: 380, profile: '1k/2.2k' },
          ],
          polledAt: now - 2000, error: null,
        },
        osdp: {
          rate: [...rate], totalFrames: total, naks: 3,
          readers: [
            { id: 'r1', name: 'Lobby OSDP Reader', address: 1, status: 'online', secure: true, lastActivity: now - 400 },
            { id: 'r2', name: 'Server Room OSDP', address: 2, status: 'online', secure: false, lastActivity: now - 900 },
          ],
          recent: [...recent],
        },
        emulator: {
          running: true, port: '/dev/ttyUSB1', framesIn: 91822 + phase * 12, framesOut: 91820 + phase * 12,
          devices: Array.from({ length: Number(new URLSearchParams(window.location.search).get('boards')) || 4 }, (_, i) => ({
            address: 11 + i, model: ['IO168S', 'RI4S', 'RI2MS', 'RI2MS', 'I16S', 'O8S'][i % 6], online: i !== 5,
            polls: 45110 + phase * 6, tamper: i === 3 && phase % 20 < 5, powerFail: false,
          })),
        },
        automation: {
          total: 5, enabled: 4, triggers: 1289 + Math.floor(phase / 7), lastTriggerAt: now - (phase % 7) * 1000,
          rules: [
            { name: 'Door 2 cycle test', enabled: true, trigger: 'schedule' },
            { name: 'Forced door → PoE bounce', enabled: true, trigger: 'event' },
            { name: 'Nightly relock', enabled: true, trigger: 'schedule' },
            { name: 'Switch action smoke test', enabled: true, trigger: 'event' },
            { name: 'Elevator floor sweep', enabled: false, trigger: 'schedule' },
          ],
        },
        readers: [],
        events: [
          { at: now - 4_000, kind: 'granted', text: 'Access granted · FC 123 #12345', where: 'Lobby Turnstile' },
          { at: now - 12_000, kind: 'alarm', text: 'Door forced open', where: DEMO_NAMES[6] },
          { at: now - 31_000, kind: 'automation', text: 'Rule fired: Door 2 cycle test' },
          { at: now - 47_000, kind: 'alarm', text: 'Door held open', where: 'Loading Dock' },
          { at: now - 95_000, kind: 'denied', text: 'Access denied · FC 511 #1234567', where: 'Server Room' },
          { at: now - 130_000, kind: 'granted', text: 'Floor 5 access granted', where: 'Elevator' },
          { at: now - 190_000, kind: 'system', text: 'Controller emulator online · /dev/ttyUSB1' },
          { at: now - 240_000, kind: 'granted', text: 'Access granted · FC 123 #99999', where: 'Main Entrance' },
        ].filter(e => doorCount > 6 || e.where !== DEMO_NAMES[6]) as AccessEvent[],
      });
    };
    build();
    const t = setInterval(build, 1000);
    return () => clearInterval(t);
  }, [doorCount]);

  return model;
}
