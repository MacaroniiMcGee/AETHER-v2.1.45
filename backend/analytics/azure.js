// analytics/azure.js — Azure BLU-IC2 layer on top of Log Analytics (AETHER_AZURE_DEBUG).
//
// Reads the parts of a Cloud Connector bundle that only an Azure controller has and
// turns them into what a tech needs at a door:
//   controller   identity, firmware, Cloud Connector version, claim state (system.conf …)
//   boards       downstream RS-485 panels from panelconfig.json (every snapshot in the bundle)
//                + their online/offline history and relay activity from CloudConnector.log
//   readers      reader ports from ioconfig.json (mode, OSDP address, baud, secure channel)
//   lifecycle    HealthMonitor start-up states (INIT → … → CLAIMED), NTP, versions
//   sync         SyncTiming steps (which part of a full sync is slow)
//   osdp         IC2 syslog lines "OSDPDriver[n]: << 53 …" (a pasted/attached IC2 log), decoded
//   checks       Azure-specific problems found in all of the above, each with a fix
//
// Wiring rules come from the NOP-IC2 hardware manual: 32 addresses per COM port, COM1 shares
// its serial bus with OSDP readers on reader port 1 (COM2 with reader port 2), one baud rate and
// unique addresses per bus, termination only at the two ends.
'use strict';

const fs = require('fs');

// Board catalogue (NOP-/BLU- datasheets). Names in panelconfig use the BLU- prefix.
const MODELS = {
  'BLU-IC2':    { kind: 'controller', label: 'IC2 controller', readers: 2, inputs: 8, outputs: 4 },
  'BLU-RI2M-S': { kind: 'reader', label: 'RI2MS reader interface', readers: 2, inputs: 6, outputs: 4 },
  'BLU-RI2MD-S':{ kind: 'reader', label: 'RI2MDS reader interface', readers: 2, inputs: 6, outputs: 4 },
  'BLU-RI4-S':  { kind: 'reader', label: 'RI4S reader interface', readers: 4, inputs: 8, outputs: 4 },
  'BLU-IO168':  { kind: 'io', label: 'IO168S input/output panel', readers: 0, inputs: 16, outputs: 8 },
  'BLU-IO168S': { kind: 'io', label: 'IO168S input/output panel', readers: 0, inputs: 16, outputs: 8 },
  'BLU-I16':    { kind: 'io', label: 'I16 input panel', readers: 0, inputs: 16, outputs: 0 },
  'BLU-O8':     { kind: 'io', label: 'O8 relay panel', readers: 0, inputs: 0, outputs: 8 },
};
const modelInfo = m => MODELS[String(m || '').toUpperCase()] || { kind: 'unknown', label: m || 'Unknown board', readers: null, inputs: null, outputs: null };

function readJson(f) {
  try { return JSON.parse(fs.readFileSync(f.abs, 'utf8')); } catch { return null; }
}
const base = rel => rel.split('/').pop();

// ── controller identity ────────────────────────────────────────────────────
function controllerInfo(files) {
  const pick = name => files.filter(f => base(f.rel) === name && !f.skipped).map(readJson).filter(Boolean);
  const sys = pick('system.conf')[0] || {};
  const ver = pick('versions.conf')[0] || {};
  const host = pick('hostname.conf')[0] || {};
  const st = pick('device_status.conf')[0] || {};
  const tz = pick('timezone.json')[0] || {};
  const isAzure = /azure/i.test(sys.manufacturer || '') || /^BLU-/i.test(sys.modelNumber || '') || files.some(f => /\/mnt\/azuresdk\//.test('/' + f.rel));
  return {
    isAzure,
    model: sys.modelNumber || null, manufacturer: sys.manufacturer || null,
    serialNo: sys.serialNo || st.serialNo || null, mac: sys.macAddress || st.macAddress || null,
    hostname: host.hostname || null, firmware: ver.firmwareVersion || sys.firmwareVersion || null,
    connector: ver.edgeappVersion || sys.edgeappVersion || null, hardware: sys.hardwareVersion || null,
    claim: st.deviceStatus || null, services: st.serviceStatus || null, orgShortName: sys.orgShortName || null,
    timezone: tz.tz_location || tz.timezone || null,
  };
}

// ── boards (panelconfig.json, possibly several snapshots incl. archives) ─────────
function boardsFrom(files) {
  const snaps = files.filter(f => base(f.rel) === 'panelconfig.json' && !f.skipped).map(f => ({ rel: f.rel, json: readJson(f) })).filter(s => s.json);
  const boards = new Map(); const com = new Map(); const snapshots = [];
  for (const s of snaps) {
    const list = [];
    for (const [id, v] of Object.entries(s.json)) {
      if (!v || typeof v !== 'object') continue;
      if (Array.isArray(v.serialPort)) {
        for (const p of v.serialPort) com.set(String(p.panelChannel || '').toLowerCase(), { port: String(p.panelChannel || '').toLowerCase(), baud: p.panelBaudRate ?? null });
        continue;
      }
      const pid = v.panelId || {};
      const b = {
        id, port: String(v.panelChannel || '').toLowerCase() || null, addr: v.macAddress ?? null, node: pid.node ?? null, lda: pid.lda ?? null,
        model: v.modelNumber || null, status: v.status ? String(v.status).toLowerCase() : null, v: Number(v.v) || 0, file: s.rel,
      };
      list.push(b);
      const prev = boards.get(id);
      if (!prev || b.v >= prev.v) boards.set(id, b);
    }
    snapshots.push({ file: s.rel, boards: list.length });
  }
  const out = [...boards.values()].map(b => ({ ...b, info: modelInfo(b.model) }))
    .sort((a, b) => (a.port || '').localeCompare(b.port || '') || (a.addr ?? 99) - (b.addr ?? 99));
  return { boards: out, com: [...com.values()].sort((a, b) => a.port.localeCompare(b.port)), snapshots };
}

// ── readers (ioconfig.json) ──────────────────────────────────────────────────
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function readersFrom(files, ownIds) {
  const f = files.filter(x => base(x.rel) === 'ioconfig.json' && !x.skipped && !/\.d\//.test(x.rel))[0];
  const j = f ? readJson(f) : null;
  if (!j) return { readers: [], corrupt: [] };
  // Keys are "<org>#<controller-or-board id>#reader_readerN-L-I". Entries of removed boards and
  // keys with damaged (non-UUID) org ids can linger; keep ours, newest per reader, and report damage.
  const keys = Object.keys(j);
  const corrupt = keys.filter(k => k.includes('#') && !UUID.test(k.split('#')[0]));
  const own = new Set(ownIds.filter(Boolean));
  const mine = own.size && keys.some(k => own.has(k.split('#')[1]));
  const best = new Map();
  for (const k of keys) {
    const m = /reader_reader(\d+)-(\d+)-(\d+)$/.exec(k);
    const v = j[k];
    if (!m || !v || corrupt.includes(k)) continue;
    if (mine && !own.has(k.split('#')[1])) continue;
    const label = `reader${m[1]}-${m[2]}-${m[3]}`;
    const prev = best.get(label);
    if (!prev || (Number(v.v) || 0) >= (Number(prev.v.v) || 0)) best.set(label, { m, v });
  }
  const out = [];
  for (const { m, v } of best.values()) {
    out.push({
      label: `reader${m[1]}-${m[2]}-${m[3]}`, node: +m[1], lda: +m[2], idx: +m[3], mode: v.mode || null,
      addr: v.rdrAddr ?? null, baud: v.baudRate ?? null, secure: String(v.secureChannel) === 'true',
      assigned: !!v.entityId, accessPoint: v.accessPoint ?? null,
    });
  }
  return { readers: out.sort((a, b) => a.lda - b.lda || a.idx - b.idx), corrupt: corrupt.map(k => k.replace(/[^\x20-\x7e]/g, '?')), file: f.rel };
}

// ── CloudConnector.log: device status + relay activity ───────────────────────
// "Device Status Peripheral1-6-0 [DeviceStatus-NAK]offline"   "Device Status reader1-9-1 [DeviceStatus-Connection]online"
// "RelayEvent [out1-7-10] Online Status: On -> Off"
const DEV_ST = /Device Status (Peripheral|reader)(\d+)-(\d+)-(\d+) \[DeviceStatus-([^\]]*)\](\w+)/;
const RELAY = /RelayEvent \[out(\d+)-(\d+)-(\d+)\] Online Status: (\w+) -> (\w+)/;

function busActivity(cc) {
  const status = []; const relays = new Map();
  for (const r of cc) {
    const m = DEV_ST.exec(r.msg);
    if (m) { status.push({ t: r.t, kind: m[1] === 'reader' ? 'reader' : 'board', node: +m[2], lda: +m[3], idx: +m[4], reason: m[5], state: m[6].toLowerCase(), file: r.file, line: r.line }); continue; }
    const x = RELAY.exec(r.msg);
    if (x) {
      const key = `${x[2]}-${x[3]}`;
      const e = relays.get(key) || { lda: +x[2], point: +x[3], toggles: 0, first: r.t, last: r.t, on: 0 };
      e.toggles++; e.last = r.t; if (x[5] === 'On') e.on++;
      relays.set(key, e);
    }
  }
  status.sort((a, b) => a.t - b.t);
  return { status, relays: [...relays.values()].sort((a, b) => a.lda - b.lda || a.point - b.point) };
}

// ── HealthMonitor / SyncTiming ───────────────────────────────────────────────
function lifecycleFrom(health) {
  const out = [];
  for (const r of health) {
    let m;
    if ((m = /FSM state: (\w+)/.exec(r.msg))) out.push({ t: r.t, kind: 'state', state: m[1] });
    else if (/CloudConnector is starting/.test(r.msg)) out.push({ t: r.t, kind: 'start', state: 'STARTING' });
    else if ((m = /NTP sync (\w+)/.exec(r.msg))) out.push({ t: r.t, kind: 'ntp', state: /success/i.test(m[1]) ? 'NTP_OK' : 'NTP_FAIL' });
    else if ((m = /Device firmware version:\s*([\w.]+)\s+CloudConnector firmware version:\s*([\w.]+)/.exec(r.msg))) out.push({ t: r.t, kind: 'version', state: 'VERSION', fw: m[1], cc: m[2] });
    else if (/required files? (is |are )?(missing|not available)|FileSystem looks unhealthy/i.test(r.msg)) out.push({ t: r.t, kind: 'files', state: 'FILES_MISSING', msg: r.msg.slice(0, 200) });
  }
  return out;
}

const STEP = /do(\w+?)Sync(?:V\d)?\s*$/;
function syncFrom(sync) {
  const runs = []; let cur = null;
  const dur = s => { const m = /(?:(\d+)s)?(\d+)ms/.exec(s); return m ? (+(m[1] || 0)) * 1000 + +m[2] : null; };
  // Two log dialects: "****** Synchronization started ******" / "Synchronization finished" (CC 1.4)
  // and "Synchronization thread starting!" / "****** Synchronization finished in 9s123ms ******" (CC 1.5).
  for (const r of sync) {
    if (/Synchronization (started|thread starting)/.test(r.msg)) { cur = { t: r.t, steps: [], end: null, ms: null, fails: [] }; runs.push(cur); continue; }
    if (!cur) { cur = { t: r.t, steps: [], end: null, ms: null, fails: [] }; runs.push(cur); }
    let m;
    if ((m = /^(.*?) sync finished in (\S+) for entries (\d+)/i.exec(r.msg))) {
      const fn = STEP.exec(r.fn || '');
      cur.steps.push({ step: fn ? fn[1] : m[1].trim(), ms: dur(m[2]), entries: +m[3], t: r.t });
    } else if ((m = /Synchronization finished(?: in (\S+))?/.exec(r.msg))) {
      cur.end = r.t; if (m[1]) cur.ms = dur(m[1]);
    } else if ((m = /Sync fail for (\w+) \[(\w+)\](?:, status: (.*))?/.exec(r.msg)) && !/More Pages/i.test(m[3] || '')) {
      cur.fails.push({ t: r.t, what: `${m[1]} [${m[2]}]`, status: (m[3] || '').slice(0, 120) });
    }
  }
  return runs.map(r => ({
    ...r, ms: r.ms != null ? r.ms : r.end ? r.end - r.t : null, finished: !!r.end,
    slowest: r.steps.slice().sort((a, b) => (b.ms || 0) - (a.ms || 0))[0] || null,
  }));
}

// ── IC2 syslog "OSDPDriver[n]: << 53 …" ──────────────────────────────────────
// The IC2 prints each OSDP reply it receives from a downstream board WITHOUT its checksum.
const OSDP_LINE = /^(\w{3}\s+\d+ \d\d:\d\d:\d\d)\s+\S+\s+\S+:\s+OSDPDriver\[(\d+)\]:\s+(<<|>>)\s+((?:[0-9A-Fa-f]{2}\s?)+)(.*)$/;
const OSDP_NOTE = /^(\w{3}\s+\d+ \d\d:\d\d:\d\d)\s+\S+\s+\S+:\s+OSDPDriver\[(\d+)\]:\s+(.*)$/;
const REPLY = { 0x40: 'ACK', 0x41: 'NAK', 0x45: 'PDID', 0x46: 'PDCAP', 0x48: 'LSTATR', 0x49: 'ISTATR', 0x4a: 'OSTATR', 0x4b: 'RSTATR', 0x50: 'RAW', 0x51: 'FMT', 0x53: 'KEYPAD', 0x54: 'COM', 0x76: 'CCRYPT', 0x78: 'RMAC_I', 0x79: 'BUSY' };

function parseOsdpDriver(text, file, year = new Date().getFullYear(), tz = 'UTC') {
  const { parseSyslog } = require('./time');
  const lines = String(text).split(/\r?\n/);
  const frames = [], notes = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m = OSDP_LINE.exec(l);
    if (m) {
      const b = Buffer.from(m[4].replace(/\s+/g, ''), 'hex');
      if (b[0] !== 0x53 || b.length < 6) continue;
      const reply = !!(b[1] & 0x80), addr = b[1] & 0x7f, len = b[2] | (b[3] << 8), ctrl = b[4], code = b[5];
      const data = b.subarray(6);
      frames.push({
        t: parseSyslog(m[1], year, 0, tz), drv: +m[2], dir: m[3] === '<<' ? 'rx' : 'tx', addr, reply, len, seq: ctrl & 3, crc: !!(ctrl & 4),
        code, name: REPLY[code] || `0x${code.toString(16)}`, data: [...data], note: (m[5] || '').replace(/^\s*>\s*/, '').trim(), file, line: i + 1,
      });
      continue;
    }
    m = OSDP_NOTE.exec(l);
    if (m) notes.push({ t: parseSyslog(m[1], year, 0, tz), drv: +m[2], msg: m[3].trim(), file, line: i + 1 });
  }
  return { frames, notes };
}

/** Summarise decoded OSDPDriver traffic per driver/address: input states, chatter, unknown-status. */
function summariseOsdp({ frames, notes }) {
  const devs = new Map();
  for (const f of frames) {
    const key = `${f.drv}/${f.addr}`;
    const d = devs.get(key) || { drv: f.drv, addr: f.addr, frames: 0, codes: {}, inputs: {}, unknown: 0, first: f.t, last: f.t };
    d.frames++; d.last = f.t; d.codes[f.name] = (d.codes[f.name] || 0) + 1;
    if (f.code === 0x49) {
      f.data.forEach((v, i) => {
        const inp = d.inputs[i] || (d.inputs[i] = { input: i + 1, changes: 0, last: null, unknown: 0, states: {} });
        if (v === 0xff) { inp.unknown++; d.unknown++; }
        inp.states[v] = (inp.states[v] || 0) + 1;
        if (inp.last != null && inp.last !== v) inp.changes++;
        inp.last = v;
      });
    }
    devs.set(key, d);
  }
  // The IC2 numbers inputs its own way in "unknown status received for input K"; learn the
  // offset from those notes so titles use the IC2's numbers (byte index is shown too).
  const noted = {};
  for (const n of notes) { const m = /unknown status received for input (\d+)/i.exec(n.msg); if (m) (noted[n.drv] = noted[n.drv] || new Set()).add(+m[1]); }
  const out = [...devs.values()].map(d => {
    const span = Math.max(1, (d.last - d.first) / 60000);
    const unkIdx = Object.values(d.inputs).filter(i => i.unknown).map(i => i.input);
    const ks = noted[d.drv] ? [...noted[d.drv]] : [];
    const offset = unkIdx.length && ks.length === unkIdx.length ? Math.min(...ks) - Math.min(...unkIdx) : null;
    const inputs = Object.values(d.inputs).map(i => ({ ...i, ic2: offset != null ? i.input + offset : null, perMin: +(i.changes / span).toFixed(1) }));
    return { ...d, inputs, chatter: inputs.filter(i => i.changes >= 6 && i.changes / span >= 2), spanMin: +span.toFixed(1) };
  }).sort((a, b) => a.drv - b.drv || a.addr - b.addr);
  const unknownNotes = notes.filter(n => /unknown status received for input/i.test(n.msg));
  return { devices: out, frames: frames.length, notes: notes.length, unknownNotes: unknownNotes.length };
}

// ── checks ───────────────────────────────────────────────────────────────────
function check(list, c) { list.push({ basis: 'confirmed', samples: [], ...c }); }

function runChecks(ctx) {
  const { controller, boards, com, readers, bus, lifecycle, sync, osdp } = ctx;
  const C = [];
  const comBaud = Object.fromEntries(com.map(c => [c.port, c.baud]));

  // Addresses: unique per bus and 0..31
  const byBus = {};
  for (const b of boards) (byBus[b.port || '?'] = byBus[b.port || '?'] || []).push(b);
  for (const [port, list] of Object.entries(byBus)) {
    const seen = {};
    for (const b of list) (seen[b.addr] = seen[b.addr] || []).push(b);
    for (const [addr, same] of Object.entries(seen)) if (same.length > 1) check(C, {
      id: 'bus.dup-address', area: 'bus', sev: 'high', title: `Two boards share address ${addr} on ${port.toUpperCase()}`,
      detail: `${same.map(b => `${b.model} (LDA ${b.lda})`).join(' and ')} are both set to ${addr}. Only one of them can answer; the other shows offline or flaps.`,
      fix: ['Change the DIP-switch address on one board so every board on this COM port is unique.', 'Power-cycle that board, then re-sync the controller from OnCAFE.'],
      ref: '4.1', boards: same.map(b => b.id),
    });
    for (const b of list) if (b.addr != null && (b.addr < 0 || b.addr > 31)) check(C, {
      id: 'bus.addr-range', area: 'bus', sev: 'medium', title: `${b.model} on ${port.toUpperCase()} uses address ${b.addr}`,
      detail: 'Each IC2 COM port has 32 addresses (0–31).', fix: ['Set the board DIP switches to an address between 0 and 31.'], ref: '4.1', boards: [b.id],
    });
  }

  // COM shares its bus with the IC2 reader port of the same number (manual 3.3.2)
  for (const r of readers.filter(x => x.lda === 1 || x.lda === 2)) {
    if (!/osdp/i.test(r.mode || '')) continue;
    const port = `com${r.lda}`;
    const clash = (byBus[port] || []).filter(b => b.addr === r.addr);
    if (clash.length) check(C, {
      id: 'bus.reader-clash', area: 'bus', sev: 'medium', basis: 'heuristic',
      title: `IC2 reader port ${r.lda} (OSDP address ${r.addr}) may clash with ${clash[0].model} on ${port.toUpperCase()}`,
      detail: `Reader port ${r.lda} and ${port.toUpperCase()} share one serial bus inside the IC2, so an OSDP reader there and the boards on ${port.toUpperCase()} need different addresses.`,
      fix: [`Give the OSDP reader on reader port ${r.lda} an address no board on ${port.toUpperCase()} uses.`], ref: '4.2',
    });
    if (comBaud[port] && r.baud && comBaud[port] !== r.baud) check(C, {
      id: 'bus.reader-baud', area: 'bus', sev: 'medium', basis: 'heuristic',
      title: `Reader port ${r.lda} runs at ${r.baud} baud but ${port.toUpperCase()} runs at ${comBaud[port]}`,
      detail: `They share one serial bus, so both must use the same baud rate.`, fix: [`Set the reader and ${port.toUpperCase()} to the same baud rate.`], ref: '4.2',
    });
  }

  // Boards configured on a COM port the controller has not set up
  for (const b of boards) if (b.port && com.length && comBaud[b.port] === undefined) check(C, {
    id: 'bus.port-missing', area: 'bus', sev: 'medium', title: `${b.model} is on ${b.port.toUpperCase()}, which has no serial-port settings`,
    detail: 'The board is configured but the controller has no baud rate for that COM port in this bundle.', fix: ['Open the controller in OnCAFE, check the COM port settings and sync.'], ref: '4.1', boards: [b.id],
  });

  // Offline / never reported
  for (const b of boards) {
    if (b.status === 'offline') check(C, {
      id: 'bus.board-offline', area: 'bus', sev: 'high', title: `${b.model} (address ${b.addr}, ${String(b.port).toUpperCase()}) is offline`,
      detail: 'The controller reports this board offline in its saved configuration.', fix: ['Check RS-485 polarity (TR+ to TR+), signal ground and power at the board.', 'Confirm its DIP address and baud match OnCAFE.', 'Termination only at the two ends of the bus.'], ref: '4.1', boards: [b.id],
    });
    else if (!b.status && !b.lastEvent) check(C, {
      id: 'bus.board-unreported', area: 'bus', sev: 'medium', title: `${b.model} (address ${b.addr}, ${String(b.port).toUpperCase()}) never reported a status`,
      detail: 'The board is in the controller configuration but has never been reported online or offline. It may be disabled in OnCAFE, or not wired, addressed or powered as configured.',
      fix: ['Check whether the board is enabled in OnCAFE.', 'Confirm the board is physically on that COM port at that address.', 'Watch its status LEDs; re-sync the controller.'], ref: '4.1', boards: [b.id],
    });
    else if (!b.status) check(C, {
      id: 'bus.board-no-status', area: 'bus', sev: 'low', basis: 'derived',
      title: `${b.model} (address ${b.addr}, ${String(b.port).toUpperCase()}) has no saved status; last seen ${b.lastEvent.state}`,
      detail: 'The controller configuration keeps no status for this board (it is usually cleared when the board is disabled in OnCAFE), yet the log last saw it ' + b.lastEvent.state + '. If the board was turned off in OnCAFE, check that its outputs and inputs really stopped.',
      fix: ['Compare the board state in OnCAFE with what the controller still does with it.'], ref: '4.1', boards: [b.id],
      samples: [{ t: b.lastEvent.t, file: b.lastEvent.file, line: b.lastEvent.line, text: `${b.lastEvent.reason} ${b.lastEvent.state}` }],
    });
  }

  // Status history from the log
  const offl = bus.status.filter(s => s.state === 'offline');
  if (offl.length) {
    const byDev = {};
    for (const s of offl) { const k = `${s.kind} ${s.node}-${s.lda}-${s.idx}`; (byDev[k] = byDev[k] || []).push(s); }
    for (const [k, list] of Object.entries(byDev)) {
      const b = boards.find(x => x.lda === list[0].lda);
      const reasons = [...new Set(list.map(s => s.reason))].join(', ');
      check(C, {
        id: 'bus.offline-events', area: 'bus', sev: list.length >= 10 ? 'high' : 'medium', basis: 'confirmed',
        title: `${list[0].kind === 'reader' ? `Reader ${list[0].node}-${list[0].lda}-${list[0].idx}${b ? ` on ${b.model}` : ''}` : b ? b.model : `Device at LDA ${list[0].lda} (no board configured there; an IC2 on-board port)`} went offline ${list.length} time${list.length > 1 ? 's' : ''} (${reasons})`,
        detail: (/NAK/.test(reasons) ? 'NAK means the board answered but refused the command: usually configuration or firmware, not wiring. ' : '')
          + (/Connection/.test(reasons) ? 'Connection means the board stopped answering: wiring, power, address or baud. ' : ''),
        fix: /NAK/.test(reasons) ? ['Compare the board model and firmware with what OnCAFE expects.', 'Delete and re-add the board only after checking its address.'] : ['Check RS-485 wiring, ground and termination.', 'Check board power under load.'],
        ref: '4.1', boards: b ? [b.id] : [],
        samples: list.slice(0, 20).map(s => ({ t: s.t, file: s.file, line: s.line, text: `${s.kind} ${s.node}-${s.lda}-${s.idx} [${s.reason}] ${s.state}` })),
        times: list.map(s => s.t),   // every occurrence (AZURE-14 time range)
      });
    }
  }

  // Relay chatter (outputs toggling a lot)
  const hot = bus.relays.filter(r => r.toggles >= 20);
  if (hot.length) {
    const b = l => boards.find(x => x.lda === l);
    check(C, {
      id: 'bus.relay-chatter', area: 'io', sev: 'low', basis: 'derived',
      title: `Outputs switching often (${hot.length} relay${hot.length > 1 ? 's' : ''} with 20+ changes)`,
      detail: hot.slice(0, 8).map(r => `${b(r.lda) ? b(r.lda).model : 'LDA ' + r.lda} output ${r.point}: ${r.toggles} changes`).join('; ') + '. Expected during an output-group test; otherwise check automations and schedules.',
      fix: ['Check automations, output groups and schedules that drive these outputs.'], ref: '4.4',
      first: Math.min(...hot.map(r => r.first)), last: Math.max(...hot.map(r => r.last)),
    });
  }

  // Lifecycle
  // Start-ups: each STARTING begins a new boot of the Cloud Connector; judge every boot.
  const boots = [];
  for (const l of lifecycle) {
    if (l.kind === 'start' || !boots.length) boots.push({ t: l.t, states: [] });
    if (l.kind === 'state') boots[boots.length - 1].states.push(l.state);
  }
  const stuck = boots.filter(b => b.states.length && !b.states.includes('CLAIMED'));
  if (stuck.length) {
    const last = stuck[stuck.length - 1];
    const onlyLast = stuck.length === 1 && last === boots[boots.length - 1];
    check(C, {
      id: 'cloud.not-claimed', area: 'cloud', sev: onlyLast ? 'medium' : 'high', basis: onlyLast ? 'heuristic' : 'confirmed',
      title: onlyLast ? `Last Cloud Connector start stopped at ${last.states[last.states.length - 1]} before the log ends`
        : `${stuck.length} Cloud Connector start${stuck.length > 1 ? 's' : ''} never reached CLAIMED`,
      detail: 'After every start the Cloud Connector must register with the cloud and confirm its claim before it syncs and sends events. '
        + (onlyLast ? 'The log may simply end mid-start (the bundle was exported right after a restart).' : `It stopped at: ${stuck.map(b => b.states[b.states.length - 1]).join(', ')}.`),
      fix: ['Check DNS and HTTPS (443) to the cloud from the controller network.', 'Check the Cloud Connector app and Hanwha firmware are both installed.', 'If it stays unclaimed, claim the controller again in OnCAFE.'], ref: '4.5',
      samples: stuck.slice(-5).map(b => ({ t: b.t, text: b.states.join(' → ') })), times: stuck.map(b => b.t),
    });
  }
  const ntpFail = lifecycle.filter(l => l.state === 'NTP_FAIL');
  if (ntpFail.length) check(C, { id: 'cloud.ntp', area: 'cloud', sev: 'medium', title: `NTP time sync failed (${ntpFail.length})`, detail: 'Wrong time breaks TLS and event times.', fix: ['Allow NTP (UDP 123) from the controller.'], ref: '4.5', times: ntpFail.map(l => l.t) });
  const files = lifecycle.filter(l => l.kind === 'files');
  if (files.length) check(C, { id: 'cloud.files', area: 'cloud', sev: 'high', title: 'Cloud Connector reported missing required files', detail: files[0].msg, fix: ['Reinstall the Cloud Connector app.'], ref: '4.5' });
  if (controller.claim && controller.claim !== 'CLAIMED') check(C, { id: 'cloud.claim-state', area: 'cloud', sev: 'medium', title: `Device status is ${controller.claim}`, detail: 'device_status.conf does not say CLAIMED.', fix: ['Claim the controller in OnCAFE.'], ref: '4.5' });

  // Slow sync step
  const slowSteps = [];
  for (const r of sync) for (const s of r.steps) if ((s.ms || 0) > 10000) slowSteps.push(s);
  if (slowSteps.length) check(C, {
    id: 'sync.slow-step', area: 'config', sev: 'low', basis: 'derived', title: `Slow sync steps (${slowSteps.length} over 10 s)`,
    detail: [...new Set(slowSteps.map(s => s.step))].join(', ') + ' — large databases or a slow link to the cloud.',
    fix: ['Compare entries per step; very large credential sets sync slowly over a weak link.'], ref: '4.5', times: slowSteps.map(s => s.t),
  });

  const fails = [];
  for (const r of sync) for (const f of r.fails || []) fails.push(f);
  if (fails.length) check(C, {
    id: 'sync.fail', area: 'config', sev: 'medium', title: `Sync steps failed (${fails.length})`,
    detail: [...new Set(fails.map(f => f.what + (f.status ? ` — ${f.status}` : '')))].slice(0, 6).join('; '),
    fix: ['Re-sync the controller from OnCAFE and watch whether the same step fails again.'], ref: '4.5',
    samples: fails.slice(0, 20).map(f => ({ t: f.t, text: `${f.what} ${f.status}` })), times: fails.map(f => f.t),
  });

  // OSDPDriver (IC2 syslog)
  for (const d of osdp.devices) {
    const unk = d.inputs.filter(i => i.unknown);
    if (unk.length) check(C, {
      id: 'osdp.unknown-input', area: 'io', sev: 'medium', title: `Driver ${d.drv} address ${d.addr}: input ${unk.map(i => i.ic2 != null ? `${i.ic2} (OSDP byte ${i.input})` : i.input).join(', ')} reported "unknown" (0xFF) ${unk.reduce((s, i) => s + i.unknown, 0)} time${unk.reduce((s, i) => s + i.unknown, 0) > 1 ? 's' : ''}`,
      detail: 'A supervised input that is neither normal nor active: wrong or missing end-of-line resistor, cut wire or wrong supervision setting.',
      fix: ['Measure the input loop and fit the EOL resistors the input is configured for.', 'Check normally-open / normally-closed and supervised settings in OnCAFE.'], ref: '4.3',
    });
    if (d.chatter.length) check(C, {
      id: 'osdp.input-chatter', area: 'io', sev: 'low', basis: 'derived',
      title: `Driver ${d.drv} address ${d.addr}: input ${d.chatter.map(i => `${i.ic2 != null ? i.ic2 : i.input} (${i.perMin}/min)`).join(', ')} keeps changing`,
      detail: 'Fast, repeated changes are a bouncing contact, electrical noise or a test in progress.', fix: ['Check the contact and wiring; raise the input debounce time.'], ref: '4.3',
    });
  }
  return C;
}

/**
 * Extract the Azure layer from an opened bundle manifest.
 * @param manifest  bundle.open() result
 * @param parsed    parsers.parseBundle(manifest) result (cc, health, sync records with UTC times)
 */
function extract(manifest, parsed) {
  const files = manifest.files;
  const controller = controllerInfo(files);
  const { boards, com, snapshots } = boardsFrom(files);
  const st = files.filter(f => base(f.rel) === 'device_status.conf' && !f.skipped).map(readJson).filter(Boolean)[0] || {};
  const io = readersFrom(files, [st.deviceId, ...boards.map(b => b.id)]);
  const readers = io.readers;
  const bus = busActivity(parsed.cc);
  const lifecycle = lifecycleFrom(parsed.health);
  const sync = syncFrom(parsed.sync);

  // IC2 syslog text anywhere in the inputs (e.g. a pasted "IC2 Logs.txt")
  let osdpRaw = { frames: [], notes: [] };
  const year = (parsed.cc[0] && new Date(parsed.cc[0].t).getUTCFullYear()) || new Date().getFullYear();
  for (const f of files.filter(x => (x.type === 'otherlog' || x.type === 'other') && !x.skipped && x.size < 32 * 1024 * 1024)) {
    let text; try { text = fs.readFileSync(f.abs, 'latin1'); } catch { continue; }
    if (!/OSDPDriver\[\d+\]/.test(text)) continue;
    const r = parseOsdpDriver(text, f.rel, year, parsed.zone.tz);
    osdpRaw.frames.push(...r.frames); osdpRaw.notes.push(...r.notes);
  }
  const osdp = summariseOsdp(osdpRaw);

  // Per-board activity
  for (const b of boards) {
    const st = bus.status.filter(s => s.kind === 'board' && s.lda === b.lda);
    b.offline = st.filter(s => s.state === 'offline').length;
    b.online = st.filter(s => s.state === 'online').length;
    b.lastEvent = st.length ? st[st.length - 1] : null;
    b.relayChanges = bus.relays.filter(r => r.lda === b.lda).reduce((s, r) => s + r.toggles, 0);
    b.readers = readers.filter(r => r.lda === b.lda);
  }

  const ctx = { controller, boards, com, readers, bus, lifecycle, sync, osdp };
  const checks = runChecks(ctx);
  if (io.corrupt && io.corrupt.length) checks.push({
    id: 'config.ioconfig-corrupt', area: 'config', sev: 'medium', basis: 'confirmed', ref: '4.5',
    title: `I/O configuration file has ${io.corrupt.length} damaged entr${io.corrupt.length > 1 ? 'ies' : 'y'}`,
    detail: `${io.file} holds keys whose organization id is not readable (binary bytes instead of a UUID). The Cloud Connector may apply stale or wrong settings to those points.`,
    fix: ['Re-sync the controller from OnCAFE; if the damaged keys stay, remove and re-add the affected board or reader.', 'Attach this bundle to the ticket for the Cloud Connector team.'],
    samples: io.corrupt.slice(0, 10).map(k => ({ text: k })),
  });
  return {
    controller, com, boards, readers, snapshots,
    deviceStatus: bus.status.slice(-2000), relays: bus.relays,
    lifecycle, sync: sync.slice(-60),
    osdp: { ...osdp, sample: osdpRaw.frames.slice(-400).map(f => ({ ...f, data: Buffer.from(f.data).toString('hex') })) },
    checks,
  };
}

// ── hop verdicts: where along the chain is it broken? ─────────────────────────
const SEV_RANK = { high: 3, medium: 2, low: 1, info: 0 };
const HOPS = [
  { id: 'cloud', label: 'OnCAFE cloud', sub: 'Cloud Connector ↔ MQTT / HTTPS', test: f => f.cat === 'cloud' || /^delivery\.(restart|ntp|heartbeat|log-gap|clock)/.test(f.id) },
  { id: 'delivery', label: 'Event delivery', sub: 'Controller events reaching OnCAFE', test: f => f.cat === 'delivery' && !/^delivery\.(restart|ntp|heartbeat|log-gap|clock)/.test(f.id) },
  { id: 'sdk', label: 'IC2 firmware link', sub: 'Cloud Connector ↔ ASP SDK', test: f => f.cat === 'panel' && f.id !== 'panel.reader-offline' },
  { id: 'bus', label: 'RS-485 boards', sub: 'IC2 ↔ downstream panels', test: f => f.id === 'panel.reader-offline' },
  { id: 'doors', label: 'Doors & I/O', sub: 'Readers, locks, inputs, outputs', test: f => f.cat === 'door' || f.cat === 'security' },
  { id: 'config', label: 'Configuration & sync', sub: 'What OnCAFE pushed', test: f => f.cat === 'config' },
];
const AREA_TO_HOP = { cloud: 'cloud', bus: 'bus', io: 'doors', config: 'config', sdk: 'sdk' };

function hops(report, azure) {
  return HOPS.map(h => {
    const f = (report.findings || []).filter(x => h.test(x) && !/archived logs/.test(x.title || ''));
    const c = (azure.checks || []).filter(x => AREA_TO_HOP[x.area] === h.id);
    const all = [...f.map(x => ({ id: x.id, sev: x.sev, title: x.title, src: 'analytics' })), ...c.map(x => ({ id: x.id, sev: x.sev, title: x.title, src: 'azure' }))]
      .sort((a, b) => (SEV_RANK[b.sev] || 0) - (SEV_RANK[a.sev] || 0));
    const worst = all.length ? SEV_RANK[all[0].sev] || 0 : 0;
    return { id: h.id, label: h.label, sub: h.sub, status: worst >= 3 ? 'bad' : worst === 2 ? 'warn' : 'ok', count: all.length, top: all.slice(0, 6) };
  });
}

module.exports = { extract, hops, parseOsdpDriver, summariseOsdp, MODELS, modelInfo };
