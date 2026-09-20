// OSDPSnifferTool.tsx
//
// Self-contained enhanced OSDP sniffer with anomaly detection.
//
// Replaces:
//   - The inline sniff JSX inside OSDPSection.tsx (lines 2124–2298)
//   - The orphaned OSDPSnifferPanel.tsx (~178 lines, never imported)
//
// Drop into:  frontend/src/components/OSDPSnifferTool.tsx
// Import as:  import OSDPSnifferTool from './OSDPSnifferTool';
// Render as:  <OSDPSnifferTool apiUrl={apiUrl} onLog={addHistory} />
//
// Backend endpoints used:
//   GET    /api/osdp/sniffer/ports
//   GET    /api/osdp/sniffer/status
//   POST   /api/osdp/sniffer/start   { port, baud, address, pollMs }
//   POST   /api/osdp/sniffer/stop
//   GET    /api/osdp/readers          (for address→name aliases)
//
// Socket.IO events listened for:
//   osdp-sniffer-frame      — full frame
//   osdp-sniffer-bad-frame  — malformed bytes (optional; needs backend tweak)
//   osdp-sniffer-status     — { active }
//   osdp-sniffer-error      — { message }

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import {
  Play, Square, Trash2, Pause, Download, Copy, Bookmark, BookmarkCheck,
  StickyNote, GitCompare, AlertTriangle, AlertCircle, Info, CheckCircle2,
  ChevronDown, ChevronRight, X, RefreshCw, Search, Filter,
} from 'lucide-react';

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

interface SnifferFrame {
  ts: string;
  address: number;
  isReply: boolean;
  sequence: number;
  cmd: string;
  cmdName: string;
  length: number;
  dataHex: string;
  fullHex: string;
  decoded: any;
}

interface BadFrame {
  ts: string;
  rawHex: string;
  reason: string;
}

interface PortInfo {
  path: string;
  manufacturer: string | null;
  serialNumber: string | null;
  reserved: boolean;
}

type Severity = 'critical' | 'warning' | 'info';

interface Anomaly {
  id: string;
  ts: number;
  severity: Severity;
  ruleId: string;
  title: string;
  description: string;
  suggestion?: string;
  frameIds: string[];  // ids of related frames
  address?: number;
  acknowledged: boolean;
}

interface FrameRecord extends SnifferFrame {
  id: string;          // stable id assigned at receive time
  receivedAt: number;  // ms timestamp
  bad?: never;
}

interface BadFrameRecord {
  id: string;
  receivedAt: number;
  ts: string;
  bad: true;
  rawHex: string;
  reason: string;
  // Shape-compatibility shims so the table can render uniformly
  address: number;     // -1 sentinel
  isReply: boolean;    // false
  sequence: number;    // -1
  cmd: string;         // ''
  cmdName: string;     // 'BAD_FRAME'
  length: number;
  dataHex: string;
  fullHex: string;
  decoded: any;
}

type AnyFrame = FrameRecord | BadFrameRecord;

interface Props {
  apiUrl?: string;
  onLog?: (msg: string) => void;
}

// ───────────────────────────────────────────────────────────────────────────
// OSDP constants
// ───────────────────────────────────────────────────────────────────────────

const NAK_CODES: Record<number, { code: string; label: string; suggestion: string }> = {
  0x01: { code: 'NAK_MSG_CHK',     label: 'Message check failure (bad CRC or checksum)', suggestion: 'Bus noise or baud mismatch. Verify cable shielding and baud rate.' },
  0x02: { code: 'NAK_CMD_LEN',     label: 'Command length error',                        suggestion: 'CP sent a frame with the wrong length. Check command construction.' },
  0x03: { code: 'NAK_UNKNOWN_CMD', label: 'Unknown command',                             suggestion: 'Reader does not implement this command. Check capabilities (osdp_CAP).' },
  0x04: { code: 'NAK_SEQ_ERR',     label: 'Sequence number error',                       suggestion: 'CP/PD sequence got out of sync. Send POLL with seq=0 to resync.' },
  0x05: { code: 'NAK_SCB_ERR',     label: 'Bad SCB (secure channel) block',              suggestion: 'Secure channel state mismatch. Restart secure session.' },
  0x06: { code: 'NAK_SC_REQUIRED', label: 'Encryption required',                         suggestion: 'Reader requires secure channel. Configure SCBK and establish SC first.' },
  0x07: { code: 'NAK_BIO_TYPE',    label: 'BIO type not supported',                      suggestion: 'Biometric reader does not support this BIO type.' },
  0x08: { code: 'NAK_BIO_FMT',     label: 'BIO format not supported',                    suggestion: 'Biometric reader does not support this BIO format.' },
  0x09: { code: 'NAK_CMD_UNABLE',  label: 'Unable to process command',                   suggestion: 'Reader rejected the command at its current state.' },
};

const CMD_COLOR_BY_NAME: Record<string, string> = {
  POLL:    'text-gray-500',
  ACK:     'text-emerald-400',
  NAK:     'text-red-400',
  KEYPAD:  'text-amber-300',
  RAW:     'text-amber-300',
  CCRD:    'text-amber-300',
  PDID:    'text-cyan-300',
  PDCAP:   'text-cyan-300',
  LED:     'text-purple-300',
  BUZ:     'text-purple-300',
  TEXT:    'text-purple-300',
  COMSET:  'text-blue-300',
  CHLNG:   'text-blue-300',
  SCRYPT:  'text-blue-300',
  RMAC_I:  'text-blue-300',
  FILETRANSFER: 'text-orange-300',
  FTSTAT:  'text-orange-300',
  BUSY:    'text-yellow-300',
};

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

const fmtAddr = (a: number) =>
  a < 0 ? '—' : `0x${a.toString(16).padStart(2, '0').toUpperCase()}`;

const fmtTime = (ts: string) => ts.slice(11, 23);

const fmtAge = (ms: number) => {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`;
};

const newId = (() => { let n = 0; return () => `f${++n}`; })();

// Parse a fullHex string into structured byte-level breakdown for the inspector.
// OSDP frame layout: SOM(0x53) | ADDR | LEN_LSB | LEN_MSB | CTRL | CMD | DATA... | CRC_LSB CRC_MSB  (CRC mode)
//                    or trailing single byte CHECKSUM in non-CRC mode.
interface FrameByte { offset: number; hex: string; ascii: string; field: string; meaning: string; }

function parseFrameBytes(fullHex: string): FrameByte[] {
  const clean = (fullHex || '').replace(/\s+/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 2) {
    const b = parseInt(clean.substring(i, i + 2), 16);
    if (Number.isFinite(b)) bytes.push(b);
  }
  if (bytes.length < 5) {
    return bytes.map((b, i) => ({
      offset: i, hex: b.toString(16).padStart(2, '0').toUpperCase(),
      ascii: b >= 32 && b < 127 ? String.fromCharCode(b) : '·',
      field: '?', meaning: 'truncated',
    }));
  }

  const result: FrameByte[] = [];
  const push = (i: number, field: string, meaning: string) => {
    const b = bytes[i];
    result.push({
      offset: i,
      hex: b.toString(16).padStart(2, '0').toUpperCase(),
      ascii: b >= 32 && b < 127 ? String.fromCharCode(b) : '·',
      field, meaning,
    });
  };

  push(0, 'SOM', bytes[0] === 0x53 ? 'Start-of-message marker' : `Expected 0x53, got 0x${bytes[0].toString(16)}`);
  const addr = bytes[1];
  const isReply = (addr & 0x80) !== 0;
  const baseAddr = addr & 0x7F;
  push(1, 'ADDR', `${isReply ? 'Reply' : 'Command'} · address ${fmtAddr(baseAddr)}`);
  const len = bytes[2] | (bytes[3] << 8);
  push(2, 'LEN_LSB', `Length low byte (frame is ${len} bytes total)`);
  push(3, 'LEN_MSB', 'Length high byte');
  const ctrl = bytes[4];
  const seq = ctrl & 0x03;
  const crcMode = (ctrl & 0x04) !== 0;
  const scb = (ctrl & 0x08) !== 0;
  push(4, 'CTRL', `seq=${seq}, ${crcMode ? 'CRC-16' : 'checksum'}${scb ? ', SCB present' : ''}`);
  if (bytes.length >= 6) {
    push(5, isReply ? 'REPLY' : 'CMD', `0x${bytes[5].toString(16).padStart(2, '0')}`);
  }

  const trailerBytes = crcMode ? 2 : 1;
  const dataEnd = bytes.length - trailerBytes;
  for (let i = 6; i < dataEnd; i++) push(i, 'DATA', `Payload byte ${i - 6}`);
  if (crcMode && bytes.length >= 8) {
    push(bytes.length - 2, 'CRC_LSB', 'CRC-16 low byte');
    push(bytes.length - 1, 'CRC_MSB', 'CRC-16 high byte');
  } else if (!crcMode && bytes.length >= 7) {
    push(bytes.length - 1, 'CKSUM', 'Checksum (8-bit)');
  }
  return result;
}

// ───────────────────────────────────────────────────────────────────────────
// Anomaly detection
// ───────────────────────────────────────────────────────────────────────────

interface DetectorContext {
  recent: AnyFrame[];                                  // last ~100 frames (rolling)
  lastFrameByAddr: Map<number, FrameRecord>;
  expectedSeqByAddr: Map<number, number>;
  pending: Map<number, { frame: FrameRecord; deadlineMs: number }>;
  consecutiveNakByAddr: Map<number, number>;
  consecutiveBusyByAddr: Map<number, number>;
  configuredAddrs: Set<number>;
  lastSeenByAddr: Map<number, number>;
  pollMs: number;
}

function makeCtx(): DetectorContext {
  return {
    recent: [], lastFrameByAddr: new Map(), expectedSeqByAddr: new Map(),
    pending: new Map(), consecutiveNakByAddr: new Map(),
    consecutiveBusyByAddr: new Map(), configuredAddrs: new Set(),
    lastSeenByAddr: new Map(), pollMs: 200,
  };
}

let anomalyCounter = 0;
const mkAnomaly = (a: Omit<Anomaly, 'id' | 'acknowledged' | 'ts'> & { ts?: number }): Anomaly => ({
  id: `a${++anomalyCounter}`,
  ts: a.ts ?? Date.now(),
  acknowledged: false,
  ...a,
});

function detectOnFrame(frame: AnyFrame, ctx: DetectorContext): Anomaly[] {
  const out: Anomaly[] = [];

  // BAD FRAME from backend parser
  if ('bad' in frame && frame.bad) {
    out.push(mkAnomaly({
      severity: 'critical',
      ruleId: 'bad-frame',
      title: 'Malformed frame on bus',
      description: frame.reason || 'Raw bytes did not parse as a valid OSDP frame',
      suggestion: 'Likely bus noise, wrong baud, or termination issue. Check cable and shield grounding.',
      frameIds: [frame.id],
    }));
    return out;
  }

  const f = frame as FrameRecord;
  ctx.lastSeenByAddr.set(f.address, f.receivedAt);

  // NAK with decoded reason
  if (f.cmdName === 'NAK') {
    const nakByte = parseInt((f.dataHex || '').slice(0, 2), 16);
    const info = NAK_CODES[nakByte] || { code: 'NAK_?', label: `Unknown NAK code 0x${nakByte.toString(16)}`, suggestion: '' };
    out.push(mkAnomaly({
      severity: 'critical', ruleId: 'nak',
      title: `NAK from ${aliasOrAddr(f.address, ctx)} — ${info.code}`,
      description: info.label,
      suggestion: info.suggestion,
      frameIds: [f.id], address: f.address,
    }));
    ctx.consecutiveNakByAddr.set(f.address, (ctx.consecutiveNakByAddr.get(f.address) || 0) + 1);
    if ((ctx.consecutiveNakByAddr.get(f.address) || 0) >= 3) {
      out.push(mkAnomaly({
        severity: 'critical', ruleId: 'repeated-nak',
        title: `Repeated NAKs from ${aliasOrAddr(f.address, ctx)}`,
        description: `${ctx.consecutiveNakByAddr.get(f.address)} consecutive NAKs`,
        suggestion: 'Reader is consistently rejecting frames. Check command construction or secure-channel state.',
        frameIds: [f.id], address: f.address,
      }));
    }
  } else {
    ctx.consecutiveNakByAddr.set(f.address, 0);
  }

  // Sustained BUSY
  if (f.cmdName === 'BUSY') {
    ctx.consecutiveBusyByAddr.set(f.address, (ctx.consecutiveBusyByAddr.get(f.address) || 0) + 1);
    if ((ctx.consecutiveBusyByAddr.get(f.address) || 0) >= 3) {
      out.push(mkAnomaly({
        severity: 'warning', ruleId: 'sustained-busy',
        title: `Sustained BUSY from ${aliasOrAddr(f.address, ctx)}`,
        description: `${ctx.consecutiveBusyByAddr.get(f.address)} consecutive BUSY replies`,
        suggestion: 'Normal during firmware flash; otherwise reader may be stuck. Send POLL.',
        frameIds: [f.id], address: f.address,
      }));
    }
  } else if (f.cmdName !== 'POLL') {
    ctx.consecutiveBusyByAddr.set(f.address, 0);
  }

  // Sequence anomalies
  const seq = f.sequence;
  const prevSeq = ctx.expectedSeqByAddr.get(f.address);
  if (seq === 0 && prevSeq !== undefined && prevSeq !== 0) {
    out.push(mkAnomaly({
      severity: 'warning', ruleId: 'seq-resync',
      title: `Sequence resync at ${aliasOrAddr(f.address, ctx)}`,
      description: `seq=0 after established session (last seq was ${prevSeq})`,
      suggestion: 'CP gave up and restarted. Often follows a NAK or timeout.',
      frameIds: [f.id], address: f.address,
    }));
  } else if (prevSeq !== undefined && seq !== 0 && seq !== (prevSeq === 3 ? 1 : prevSeq + 1)) {
    // OSDP rotates 0,1,2,3,1,2,3,1,2,3...
    out.push(mkAnomaly({
      severity: 'warning', ruleId: 'seq-gap',
      title: `Sequence gap at ${aliasOrAddr(f.address, ctx)}`,
      description: `expected seq=${prevSeq === 3 ? 1 : prevSeq + 1}, got seq=${seq}`,
      suggestion: 'Likely a dropped reply or bus interruption.',
      frameIds: [f.id], address: f.address,
    }));
  }
  ctx.expectedSeqByAddr.set(f.address, seq);

  // Pending command / no-reply
  if (!f.isReply) {
    // Set new pending entry, expiring older one if it didn't get a reply
    const prev = ctx.pending.get(f.address);
    if (prev && f.receivedAt - prev.frame.receivedAt > Math.max(ctx.pollMs * 3, 500) && prev.frame.cmdName !== 'POLL') {
      out.push(mkAnomaly({
        severity: 'warning', ruleId: 'no-reply',
        title: `No reply from ${aliasOrAddr(prev.frame.address, ctx)}`,
        description: `${prev.frame.cmdName} sent ${f.receivedAt - prev.frame.receivedAt}ms ago without reply`,
        suggestion: 'Reader silent. Check power, cable, baud rate, address configuration.',
        frameIds: [prev.frame.id], address: prev.frame.address,
      }));
    }
    ctx.pending.set(f.address, { frame: f, deadlineMs: f.receivedAt + Math.max(ctx.pollMs * 3, 500) });
  } else {
    ctx.pending.delete(f.address);
  }

  // Unknown address replying
  if (f.isReply && ctx.configuredAddrs.size > 0 && !ctx.configuredAddrs.has(f.address)) {
    out.push(mkAnomaly({
      severity: 'warning', ruleId: 'unknown-addr',
      title: `Unknown address replied: ${fmtAddr(f.address)}`,
      description: 'Reply received from an address that is not in the configured readers list',
      suggestion: 'Phantom device, address conflict, or unregistered reader. Verify with Bus Manager.',
      frameIds: [f.id], address: f.address,
    }));
  }

  // PDID unprompted = likely reboot
  if (f.cmdName === 'PDID' && ctx.lastFrameByAddr.get(f.address)?.cmdName !== 'osdp_ID') {
    out.push(mkAnomaly({
      severity: 'info', ruleId: 'reader-reboot',
      title: `${aliasOrAddr(f.address, ctx)} sent unsolicited PDID`,
      description: 'Reader announced its identity without being asked',
      suggestion: 'Reader likely just rebooted (e.g., post firmware-flash).',
      frameIds: [f.id], address: f.address,
    }));
  }

  ctx.lastFrameByAddr.set(f.address, f);
  return out;
}

function aliasOrAddr(addr: number, ctx: DetectorContext & { aliases?: Map<number, string> }): string {
  const alias = ctx.aliases?.get(addr);
  return alias ? `${alias} (${fmtAddr(addr)})` : fmtAddr(addr);
}

// ───────────────────────────────────────────────────────────────────────────
// Main component
// ───────────────────────────────────────────────────────────────────────────

const FRAME_BUFFER_MAX = 500;
const ANOMALY_BUFFER_MAX = 200;

export default function OSDPSnifferTool({ apiUrl = '', onLog }: Props) {
  // Config
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [port, setPort] = useState('');
  const [baud, setBaud] = useState(9600);
  const [address, setAddress] = useState(0);
  const [pollMs, setPollMs] = useState(100);
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Frames + anomalies + state
  const [frames, setFrames] = useState<AnyFrame[]>([]);
  const [anomalies, setAnomalies] = useState<Anomaly[]>([]);
  const [paused, setPaused] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [bookmarks, setBookmarks] = useState<Set<string>>(new Set());
  const [notes, setNotes] = useState<Map<string, string>>(new Map());
  const [compareSel, setCompareSel] = useState<string[]>([]);  // up to 2 frame ids
  const [showCompare, setShowCompare] = useState(false);

  // Filters
  const [search, setSearch] = useState('');
  const [hideAcks, setHideAcks] = useState(false);
  const [hidePolls, setHidePolls] = useState(false);
  const [showOnlyBookmarked, setShowOnlyBookmarked] = useState(false);

  // Reader aliases
  const [aliases, setAliases] = useState<Map<number, string>>(new Map());

  // Detector context — persistent across frames
  const ctxRef = useRef<DetectorContext & { aliases?: Map<number, string> }>(makeCtx());
  useEffect(() => { ctxRef.current.aliases = aliases; }, [aliases]);
  useEffect(() => { ctxRef.current.pollMs = pollMs; }, [pollMs]);

  // Buffered frames so paused display doesn't drop captures
  const pausedBufferRef = useRef<AnyFrame[]>([]);
  const pausedAnomaliesRef = useRef<Anomaly[]>([]);

  // Stats
  const fpsRef = useRef<{ stamps: number[] }>({ stamps: [] });
  const [, forceTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => forceTick(x => x + 1), 1000);
    return () => window.clearInterval(t);
  }, []);

  // Socket
  const socketRef = useRef<Socket | null>(null);
  useEffect(() => {
    const s: Socket = io(apiUrl || undefined, { transports: ['websocket', 'polling'] });
    socketRef.current = s;

    const onFrame = (raw: SnifferFrame) => {
      const rec: FrameRecord = { ...raw, id: newId(), receivedAt: Date.now() };
      ingestFrame(rec);
    };
    const onBadFrame = (raw: BadFrame) => {
      const rec: BadFrameRecord = {
        id: newId(), receivedAt: Date.now(), ts: raw.ts || new Date().toISOString(),
        bad: true, rawHex: raw.rawHex, reason: raw.reason,
        address: -1, isReply: false, sequence: -1, cmd: '', cmdName: 'BAD_FRAME',
        length: (raw.rawHex || '').replace(/\s/g, '').length / 2,
        dataHex: '', fullHex: raw.rawHex, decoded: { reason: raw.reason },
      };
      ingestFrame(rec);
    };
    const onStatus = (st: any) => setActive(!!st?.active);
    const onError  = (e: any) => setError(e?.message || 'sniffer error');

    s.on('osdp-sniffer-frame', onFrame);
    s.on('osdp-sniffer-bad-frame', onBadFrame);
    s.on('osdp-sniffer-status', onStatus);
    s.on('osdp-sniffer-error', onError);

    return () => { s.disconnect(); socketRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function ingestFrame(rec: AnyFrame) {
    fpsRef.current.stamps.push(rec.receivedAt);
    fpsRef.current.stamps = fpsRef.current.stamps.filter(t => Date.now() - t < 5000);

    const newAnoms = detectOnFrame(rec, ctxRef.current);
    ctxRef.current.recent.push(rec);
    if (ctxRef.current.recent.length > 100) ctxRef.current.recent.shift();

    if (paused) {
      pausedBufferRef.current.push(rec);
      pausedAnomaliesRef.current.push(...newAnoms);
      return;
    }
    setFrames(prev => {
      const next = [rec, ...prev];
      return next.length > FRAME_BUFFER_MAX ? next.slice(0, FRAME_BUFFER_MAX) : next;
    });
    if (newAnoms.length) {
      setAnomalies(prev => {
        const next = [...newAnoms.reverse(), ...prev];
        return next.length > ANOMALY_BUFFER_MAX ? next.slice(0, ANOMALY_BUFFER_MAX) : next;
      });
    }
  }

  // Drain paused buffer when un-pausing
  useEffect(() => {
    if (paused) return;
    if (pausedBufferRef.current.length === 0 && pausedAnomaliesRef.current.length === 0) return;
    const buf = pausedBufferRef.current.slice().reverse();
    pausedBufferRef.current = [];
    setFrames(prev => {
      const next = [...buf, ...prev];
      return next.length > FRAME_BUFFER_MAX ? next.slice(0, FRAME_BUFFER_MAX) : next;
    });
    const anoms = pausedAnomaliesRef.current.slice().reverse();
    pausedAnomaliesRef.current = [];
    if (anoms.length) {
      setAnomalies(prev => {
        const next = [...anoms, ...prev];
        return next.length > ANOMALY_BUFFER_MAX ? next.slice(0, ANOMALY_BUFFER_MAX) : next;
      });
    }
  }, [paused]);

  // Bootstrap data
  const refreshPorts = useCallback(async () => {
    try {
      const r = await fetch(`${apiUrl}/api/osdp/sniffer/ports`);
      const j = await r.json();
      setPorts(j.ports || []);
      // Functional setPort: only auto-select on first load (when port is empty).
      // Never overwrite the user's manual selection.
      setPort(current => {
        if (current) return current;
        const first = (j.ports || []).find((p: PortInfo) => !p.reserved);
        return first ? first.path : current;
      });
    } catch (e: any) { setError(e.message || String(e)); }
  }, [apiUrl]);

  const refreshReaders = useCallback(async () => {
    try {
      const r = await fetch(`${apiUrl}/api/osdp/readers`);
      const j = await r.json();
      const m = new Map<number, string>();
      const addrs = new Set<number>();
      for (const x of (j.readers || [])) {
        m.set(x.address, x.name);
        addrs.add(x.address);
      }
      setAliases(m);
      ctxRef.current.configuredAddrs = addrs;
    } catch { /* swallow */ }
  }, [apiUrl]);

  useEffect(() => {
    void refreshPorts();
    void refreshReaders();
    (async () => {
      try {
        const r = await fetch(`${apiUrl}/api/osdp/sniffer/status`);
        const j = await r.json();
        setActive(!!j.active);
        // Only set port from status if it's still empty (don't overwrite user selection)
        if (j.port) setPort(current => current || j.port);
      } catch { /* swallow */ }
    })();
  }, [apiUrl, refreshPorts, refreshReaders]);

  const start = async () => {
    setError(null);
    try {
      const r = await fetch(`${apiUrl}/api/osdp/sniffer/start`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port, baud, address, pollMs }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'start failed');
      setFrames([]); setAnomalies([]); pausedBufferRef.current = []; pausedAnomaliesRef.current = [];
      ctxRef.current = makeCtx();
      ctxRef.current.aliases = aliases;
      ctxRef.current.pollMs = pollMs;
      ctxRef.current.configuredAddrs = new Set(Array.from(aliases.keys()));
      onLog?.(`✓ Sniffer started on ${port}`);
    } catch (e: any) {
      setError(e.message || String(e));
    }
  };

  const stop = async () => {
    try {
      await fetch(`${apiUrl}/api/osdp/sniffer/stop`, { method: 'POST' });
      onLog?.('· Sniffer stopped');
    } catch (e: any) { setError(e.message || String(e)); }
  };

  const clear = () => { setFrames([]); setAnomalies([]); setExpanded(new Set()); setCompareSel([]); };

  // Derived state
  const fps = useMemo(() => {
    const now = Date.now();
    const recent = fpsRef.current.stamps.filter(t => now - t < 1000).length;
    return recent;
  }, [frames, paused]);

  const stats = useMemo(() => {
    let critical = 0, warning = 0;
    for (const a of anomalies) {
      if (a.severity === 'critical') critical++;
      else if (a.severity === 'warning') warning++;
    }
    const errFrames = frames.filter(f => ('bad' in f) || (f as FrameRecord).cmdName === 'NAK').length;
    return {
      total: frames.length, critical, warning, errFrames,
      errRate: frames.length ? Math.round((errFrames / frames.length) * 100) : 0,
    };
  }, [frames, anomalies]);

  const healthLevel: 'healthy' | 'degraded' | 'issues' =
    stats.critical > 0 || stats.errRate > 5 ? 'issues'
    : stats.warning > 0 ? 'degraded'
    : 'healthy';

  const filtered = useMemo(() => {
    return frames.filter(f => {
      const cmdName = (f as any).cmdName as string;
      if (hideAcks && cmdName === 'ACK') return false;
      if (hidePolls && cmdName === 'POLL') return false;
      if (showOnlyBookmarked && !bookmarks.has(f.id)) return false;
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        const hay = `${cmdName} ${f.fullHex || ''} ${JSON.stringify(f.decoded || {})}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [frames, hideAcks, hidePolls, showOnlyBookmarked, bookmarks, search]);

  // Action helpers
  const toggleExpand = (id: string) => setExpanded(prev => {
    const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next;
  });
  const toggleBookmark = (id: string) => setBookmarks(prev => {
    const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next;
  });
  const setNote = (id: string, text: string) => setNotes(prev => {
    const next = new Map(prev); if (text.trim()) next.set(id, text); else next.delete(id); return next;
  });
  const copyToClipboard = (text: string) => {
    navigator.clipboard?.writeText(text);
    onLog?.('✓ Copied to clipboard');
  };
  const toggleCompareSelection = (id: string) => {
    setCompareSel(prev => {
      if (prev.includes(id)) return prev.filter(x => x !== id);
      if (prev.length === 2) return [prev[1], id];
      return [...prev, id];
    });
  };
  const exportData = (format: 'json' | 'csv') => {
    const visibleFrames = filtered;
    let content: string, mime: string, ext: string;
    if (format === 'json') {
      content = JSON.stringify({
        capturedAt: new Date().toISOString(),
        port, baud, address, pollMs,
        anomalies, frames: visibleFrames,
        notes: Array.from(notes.entries()),
        bookmarks: Array.from(bookmarks),
      }, null, 2);
      mime = 'application/json'; ext = 'json';
    } else {
      const rows = ['ts,direction,address,cmd,sequence,length,dataHex,decoded'];
      for (const f of visibleFrames) {
        if ('bad' in f) {
          rows.push(`${f.ts},BAD,${fmtAddr(-1)},BAD_FRAME,,${f.length},${f.fullHex},"${(f.decoded?.reason || '').replace(/"/g, '""')}"`);
          continue;
        }
        const r = f as FrameRecord;
        rows.push([
          r.ts, r.isReply ? 'PD→CP' : 'CP→PD', fmtAddr(r.address),
          r.cmdName, String(r.sequence), String(r.length), r.dataHex,
          `"${JSON.stringify(r.decoded || {}).replace(/"/g, '""')}"`,
        ].join(','));
      }
      content = rows.join('\n'); mime = 'text/csv'; ext = 'csv';
    }
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `osdp-sniffer-${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')}.${ext}`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    onLog?.(`✓ Exported ${visibleFrames.length} frames as ${ext.toUpperCase()}`);
  };

  return (
    <div className="space-y-3">
      {/* Config bar */}
      <div className="bg-gray-900/40 border border-gray-700 rounded-lg p-3">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-2">
          <Field label="Port">
            <select value={port} onChange={e => setPort(e.target.value)} disabled={active} className={INPUT_CLS}>
              <option value="">— select —</option>
              {ports.map(p => (
                <option key={p.path} value={p.path} disabled={p.reserved}>
                  {p.path}{p.reserved ? ' (in use)' : ''}{p.manufacturer ? ` — ${p.manufacturer}` : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Baud">
            <select value={baud} onChange={e => setBaud(parseInt(e.target.value))} disabled={active} className={INPUT_CLS}>
              {[9600, 19200, 38400, 57600, 115200, 230400].map(b => <option key={b} value={b}>{b}</option>)}
            </select>
          </Field>
          <Field label="Address (0–127)">
            <input type="number" min={0} max={127} value={address} disabled={active}
              onChange={e => setAddress(Math.max(0, Math.min(127, parseInt(e.target.value) || 0)))}
              className={INPUT_CLS} />
          </Field>
          <Field label="Poll (ms)">
            <input type="number" min={50} max={5000} step={10} value={pollMs} disabled={active}
              onChange={e => setPollMs(parseInt(e.target.value) || 100)} className={INPUT_CLS} />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={refreshPorts} className="px-2.5 py-1 text-xs text-gray-300 bg-gray-800 border border-gray-700 rounded hover:bg-gray-700 flex items-center gap-1">
            <RefreshCw size={12}/> Refresh ports
          </button>
          {!active ? (
            <button onClick={start} disabled={!port}
              className="px-3 py-1.5 text-sm bg-emerald-600/30 hover:bg-emerald-600/50 disabled:opacity-40 text-emerald-200 border border-emerald-500/40 rounded flex items-center gap-1.5">
              <Play size={14}/> Start
            </button>
          ) : (
            <button onClick={stop}
              className="px-3 py-1.5 text-sm bg-red-600/30 hover:bg-red-600/50 text-red-200 border border-red-500/40 rounded flex items-center gap-1.5">
              <Square size={14}/> Stop
            </button>
          )}
          <button onClick={() => setPaused(p => !p)} disabled={!active}
            className={`px-2.5 py-1 text-xs border rounded flex items-center gap-1 disabled:opacity-40 ${paused
              ? 'text-amber-300 bg-amber-500/15 border-amber-500/40'
              : 'text-gray-300 bg-gray-800 border-gray-700 hover:bg-gray-700'}`}>
            <Pause size={12}/> {paused ? `Paused (${pausedBufferRef.current.length} buffered)` : 'Pause display'}
          </button>
          <button onClick={clear} className="px-2.5 py-1 text-xs text-gray-300 bg-gray-800 border border-gray-700 rounded hover:bg-gray-700 flex items-center gap-1">
            <Trash2 size={12}/> Clear
          </button>
          <div className="ml-auto flex gap-1">
            <button onClick={() => exportData('json')} disabled={frames.length === 0}
              className="px-2.5 py-1 text-xs text-cyan-300 bg-cyan-500/10 border border-cyan-500/40 rounded hover:bg-cyan-500/20 disabled:opacity-40 flex items-center gap-1">
              <Download size={12}/> JSON
            </button>
            <button onClick={() => exportData('csv')} disabled={frames.length === 0}
              className="px-2.5 py-1 text-xs text-cyan-300 bg-cyan-500/10 border border-cyan-500/40 rounded hover:bg-cyan-500/20 disabled:opacity-40 flex items-center gap-1">
              <Download size={12}/> CSV
            </button>
          </div>
        </div>
        {error && (
          <div className="mt-2 px-3 py-2 rounded bg-red-500/10 border border-red-500/30 text-red-300 text-xs flex items-center gap-2">
            <AlertCircle size={14}/> {error}
          </div>
        )}
      </div>

      {/* Health bar */}
      <HealthBar level={healthLevel} stats={stats} fps={fps} active={active} />

      {/* Anomalies panel */}
      <AnomalyPanel
        anomalies={anomalies}
        onAck={(id) => setAnomalies(prev => prev.map(a => a.id === id ? { ...a, acknowledged: true } : a))}
        onJump={(frameId) => {
          setExpanded(prev => new Set(prev).add(frameId));
          // Auto-scroll handled by browser via id anchor
          const el = document.getElementById(`fr-${frameId}`);
          el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }}
      />

      {/* Filter bar */}
      <div className="bg-gray-900/40 border border-gray-700 rounded-lg p-2.5 flex flex-wrap items-center gap-2 text-xs">
        <Filter size={12} className="text-gray-400"/>
        <label className="flex items-center gap-1 text-gray-300">
          <input type="checkbox" checked={hideAcks}  onChange={e => setHideAcks(e.target.checked)}/> Hide ACK
        </label>
        <label className="flex items-center gap-1 text-gray-300">
          <input type="checkbox" checked={hidePolls} onChange={e => setHidePolls(e.target.checked)}/> Hide POLL
        </label>
        <label className="flex items-center gap-1 text-gray-300">
          <input type="checkbox" checked={showOnlyBookmarked} onChange={e => setShowOnlyBookmarked(e.target.checked)}/>
          Only bookmarked
        </label>
        <div className="flex items-center gap-1 flex-1 min-w-[180px]">
          <Search size={12} className="text-gray-500"/>
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="search cmd / hex / decoded"
            className="flex-1 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-gray-200 text-xs focus:outline-none focus:border-cyan-500/50"/>
        </div>
        {compareSel.length > 0 && (
          <button onClick={() => setShowCompare(true)} disabled={compareSel.length !== 2}
            className="px-2 py-1 text-xs text-purple-300 bg-purple-500/15 border border-purple-500/40 rounded disabled:opacity-40 flex items-center gap-1">
            <GitCompare size={12}/> Compare ({compareSel.length}/2)
          </button>
        )}
        <span className="text-gray-500 ml-auto">
          {filtered.length} of {frames.length} frames
        </span>
      </div>

      {/* Frame table */}
      <div className="bg-gray-900/40 border border-gray-700 rounded-lg overflow-hidden">
        <div className="overflow-x-auto max-h-[70vh] overflow-y-auto">
          <table className="w-full text-xs font-mono">
            <thead className="bg-gray-900 text-gray-400 sticky top-0 z-10">
              <tr className="border-b border-gray-700">
                <th className="px-2 py-2 w-6"></th>
                <th className="px-2 py-2 text-left">Time</th>
                <th className="px-2 py-2 text-left">Dir</th>
                <th className="px-2 py-2 text-left">Address</th>
                <th className="px-2 py-2 text-left">Seq</th>
                <th className="px-2 py-2 text-left">Cmd</th>
                <th className="px-2 py-2 text-left">Data</th>
                <th className="px-2 py-2 text-left">Decoded</th>
                <th className="px-2 py-2 w-32"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={9} className="px-3 py-8 text-center text-gray-500">
                  {active ? 'Capturing — press a key on the reader' : 'Press Start to begin'}
                </td></tr>
              )}
              {filtered.map(f => (
                <FrameRow
                  key={f.id} frame={f}
                  expanded={expanded.has(f.id)} bookmarked={bookmarks.has(f.id)}
                  note={notes.get(f.id) || ''}
                  alias={'bad' in f ? '' : (aliases.get((f as FrameRecord).address) || '')}
                  inCompare={compareSel.includes(f.id)}
                  onToggleExpand={() => toggleExpand(f.id)}
                  onToggleBookmark={() => toggleBookmark(f.id)}
                  onSetNote={(t) => setNote(f.id, t)}
                  onCopyHex={() => copyToClipboard(f.fullHex || '')}
                  onCopyJson={() => copyToClipboard(JSON.stringify(f, null, 2))}
                  onToggleCompare={() => toggleCompareSelection(f.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showCompare && compareSel.length === 2 && (
        <CompareModal
          a={frames.find(f => f.id === compareSel[0]) || null}
          b={frames.find(f => f.id === compareSel[1]) || null}
          onClose={() => setShowCompare(false)}
        />
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Health bar
// ───────────────────────────────────────────────────────────────────────────

function HealthBar({ level, stats, fps, active }: {
  level: 'healthy' | 'degraded' | 'issues';
  stats: { total: number; critical: number; warning: number; errFrames: number; errRate: number };
  fps: number; active: boolean;
}) {
  const cfg = {
    healthy:  { color: 'text-emerald-300', bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', label: 'Healthy', icon: <CheckCircle2 size={16}/> },
    degraded: { color: 'text-amber-300',   bg: 'bg-amber-500/10',   border: 'border-amber-500/30',   label: 'Degraded', icon: <AlertTriangle size={16}/> },
    issues:   { color: 'text-red-300',     bg: 'bg-red-500/10',     border: 'border-red-500/30',     label: 'Issues',   icon: <AlertCircle size={16}/> },
  }[level];
  return (
    <div className={`flex items-center gap-3 px-3 py-2 rounded-lg border ${cfg.border} ${cfg.bg}`}>
      <div className={`flex items-center gap-2 font-medium ${cfg.color}`}>
        {cfg.icon} {cfg.label}
      </div>
      <div className="h-5 w-px bg-gray-700"/>
      <span className="text-xs text-gray-400">
        <span className="font-mono text-gray-200">{stats.total}</span> frames
      </span>
      <span className="text-xs text-gray-400">
        <span className="font-mono text-gray-200">{fps}</span> fps
      </span>
      {stats.critical > 0 && (
        <span className="text-xs text-red-300">
          <span className="font-mono">{stats.critical}</span> critical
        </span>
      )}
      {stats.warning > 0 && (
        <span className="text-xs text-amber-300">
          <span className="font-mono">{stats.warning}</span> warning{stats.warning === 1 ? '' : 's'}
        </span>
      )}
      {stats.errRate > 0 && (
        <span className="text-xs text-gray-400">
          err rate <span className="font-mono text-gray-200">{stats.errRate}%</span>
        </span>
      )}
      <span className="ml-auto text-xs text-gray-400 flex items-center gap-1.5">
        {active ? <><span className="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-pulse"/>capturing</> : 'idle'}
      </span>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Anomalies panel
// ───────────────────────────────────────────────────────────────────────────

function AnomalyPanel({ anomalies, onAck, onJump }: {
  anomalies: Anomaly[];
  onAck: (id: string) => void;
  onJump: (frameId: string) => void;
}) {
  const unack = anomalies.filter(a => !a.acknowledged);
  const [showAll, setShowAll] = useState(false);
  const list = showAll ? anomalies : unack;

  if (anomalies.length === 0) return null;

  return (
    <div className="bg-gray-900/40 border border-gray-700 rounded-lg overflow-hidden">
      <div className="px-3 py-2 border-b border-gray-700 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <AlertTriangle size={14} className="text-amber-400"/>
          <span className="text-sm font-medium text-gray-100">Anomalies &amp; errors</span>
          {unack.length > 0 && (
            <span className="px-2 py-0.5 text-[10px] rounded-full bg-red-500/15 text-red-300">
              {unack.length} unresolved
            </span>
          )}
        </div>
        <button onClick={() => setShowAll(s => !s)} className="text-xs text-gray-400 hover:text-gray-200">
          {showAll ? `show only unresolved (${unack.length})` : `show all (${anomalies.length})`}
        </button>
      </div>
      <div className="max-h-60 overflow-y-auto divide-y divide-gray-800">
        {list.length === 0 ? (
          <div className="px-3 py-4 text-center text-xs text-gray-500">All anomalies acknowledged</div>
        ) : (
          list.slice(0, 50).map(a => (
            <AnomalyRow key={a.id} a={a} onAck={() => onAck(a.id)} onJump={() => a.frameIds[0] && onJump(a.frameIds[0])} />
          ))
        )}
      </div>
    </div>
  );
}

function AnomalyRow({ a, onAck, onJump }: { a: Anomaly; onAck: () => void; onJump: () => void }) {
  const sev = {
    critical: { icon: <AlertCircle size={14}/>,     color: 'text-red-300',     bg: 'bg-red-500/5' },
    warning:  { icon: <AlertTriangle size={14}/>,    color: 'text-amber-300',   bg: 'bg-amber-500/5' },
    info:     { icon: <Info size={14}/>,             color: 'text-blue-300',    bg: 'bg-blue-500/5' },
  }[a.severity];
  return (
    <div className={`px-3 py-2 flex items-start gap-2.5 ${a.acknowledged ? 'opacity-40' : ''} ${sev.bg}`}>
      <span className={`mt-0.5 ${sev.color}`}>{sev.icon}</span>
      <div className="flex-1 min-w-0">
        <div className={`text-sm font-medium ${sev.color}`}>{a.title}</div>
        <div className="text-xs text-gray-300">{a.description}</div>
        {a.suggestion && <div className="text-xs text-gray-500 mt-1 italic">💡 {a.suggestion}</div>}
        <div className="text-[10px] text-gray-600 mt-0.5">{new Date(a.ts).toLocaleTimeString()}</div>
      </div>
      <div className="flex gap-1 shrink-0">
        {a.frameIds.length > 0 && (
          <button onClick={onJump} className="px-2 py-1 text-[10px] text-gray-300 border border-gray-700 rounded hover:bg-gray-800">
            jump to frame
          </button>
        )}
        {!a.acknowledged && (
          <button onClick={onAck} className="p-1 text-gray-500 hover:text-gray-300" title="Acknowledge">
            <X size={12}/>
          </button>
        )}
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Frame row (with inline inspector + actions)
// ───────────────────────────────────────────────────────────────────────────

function FrameRow({ frame, expanded, bookmarked, note, alias, inCompare,
  onToggleExpand, onToggleBookmark, onSetNote, onCopyHex, onCopyJson, onToggleCompare,
}: {
  frame: AnyFrame;
  expanded: boolean; bookmarked: boolean; note: string; alias: string; inCompare: boolean;
  onToggleExpand: () => void; onToggleBookmark: () => void; onSetNote: (t: string) => void;
  onCopyHex: () => void; onCopyJson: () => void; onToggleCompare: () => void;
}) {
  const isBad = 'bad' in frame;
  const cmdColor = isBad
    ? 'text-red-300'
    : CMD_COLOR_BY_NAME[(frame as FrameRecord).cmdName] || 'text-gray-300';
  const rowBg = isBad
    ? 'bg-red-500/10'
    : (frame as FrameRecord).cmdName === 'NAK' ? 'bg-red-500/5'
    : (frame as FrameRecord).cmdName === 'KEYPAD' || (frame as FrameRecord).cmdName === 'RAW' ? 'bg-amber-500/5'
    : '';

  return (
    <>
      <tr id={`fr-${frame.id}`}
        className={`border-t border-gray-800 hover:bg-white/5 transition-colors ${rowBg} ${inCompare ? 'outline outline-1 outline-purple-500/60' : ''}`}>
        <td className="px-2 py-1 text-center">
          <button onClick={onToggleExpand} className="text-gray-500 hover:text-gray-200">
            {expanded ? <ChevronDown size={12}/> : <ChevronRight size={12}/>}
          </button>
        </td>
        <td className="px-2 py-1 text-gray-500">{fmtTime(frame.ts)}</td>
        <td className="px-2 py-1">
          {isBad ? <span className="text-red-300">×</span>
            : (frame as FrameRecord).isReply
              ? <span className="text-cyan-400">PD→CP</span>
              : <span className="text-blue-400">CP→PD</span>}
        </td>
        <td className="px-2 py-1 text-gray-300">
          {isBad ? <span className="text-gray-600">—</span>
            : <>
              {fmtAddr((frame as FrameRecord).address)}
              {alias && <span className="text-gray-500 ml-1">({alias})</span>}
            </>}
        </td>
        <td className="px-2 py-1 text-gray-500">
          {isBad ? '—' : (frame as FrameRecord).sequence}
        </td>
        <td className={`px-2 py-1 ${cmdColor} font-medium`}>
          {(frame as any).cmdName}
          {!isBad && <span className="text-gray-600 ml-1">({(frame as FrameRecord).cmd})</span>}
        </td>
        <td className="px-2 py-1 text-gray-400 max-w-xs truncate">
          {isBad
            ? <span className="text-red-300/70 italic">{(frame.fullHex || '').slice(0, 32)}…</span>
            : ((frame as FrameRecord).dataHex || <span className="text-gray-600">—</span>)}
        </td>
        <td className="px-2 py-1 text-emerald-300/70 max-w-xs truncate">
          {isBad
            ? (frame.decoded?.reason || '')
            : ((frame as FrameRecord).decoded ? JSON.stringify((frame as FrameRecord).decoded) : '')}
        </td>
        <td className="px-1 py-1">
          <div className="flex items-center gap-0.5 justify-end">
            <button onClick={onToggleBookmark} className="p-1 text-gray-500 hover:text-amber-300" title={bookmarked ? 'Remove bookmark' : 'Bookmark'}>
              {bookmarked ? <BookmarkCheck size={12} className="text-amber-300"/> : <Bookmark size={12}/>}
            </button>
            <button onClick={onCopyHex} className="p-1 text-gray-500 hover:text-gray-200" title="Copy hex">
              <Copy size={12}/>
            </button>
            <button onClick={onToggleCompare}
              className={`p-1 hover:text-purple-300 ${inCompare ? 'text-purple-300' : 'text-gray-500'}`}
              title={inCompare ? 'Remove from compare' : 'Add to compare'}>
              <GitCompare size={12}/>
            </button>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className={`bg-gray-900/60 ${rowBg}`}>
          <td colSpan={9} className="px-3 py-3">
            <FrameInspector frame={frame} note={note} onSetNote={onSetNote} onCopyJson={onCopyJson}/>
          </td>
        </tr>
      )}
    </>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Frame inspector
// ───────────────────────────────────────────────────────────────────────────

function FrameInspector({ frame, note, onSetNote, onCopyJson }: {
  frame: AnyFrame; note: string; onSetNote: (t: string) => void; onCopyJson: () => void;
}) {
  const bytes = useMemo(() => parseFrameBytes(frame.fullHex || ''), [frame.fullHex]);
  const fieldColor: Record<string, string> = {
    SOM: 'text-gray-400', ADDR: 'text-blue-300', LEN_LSB: 'text-purple-300', LEN_MSB: 'text-purple-300',
    CTRL: 'text-amber-300', CMD: 'text-emerald-300', REPLY: 'text-cyan-300', DATA: 'text-gray-300',
    CRC_LSB: 'text-red-300', CRC_MSB: 'text-red-300', CKSUM: 'text-red-300',
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-400 font-medium">Byte-level breakdown</span>
        <button onClick={onCopyJson} className="text-[10px] text-gray-500 hover:text-gray-300 flex items-center gap-1">
          <Copy size={10}/> Copy frame JSON
        </button>
      </div>

      <div className="grid gap-1 font-mono text-[11px]" style={{ gridTemplateColumns: 'auto auto auto auto 1fr' }}>
        <div className="text-gray-500 px-2">offset</div>
        <div className="text-gray-500 px-2">hex</div>
        <div className="text-gray-500 px-2">ascii</div>
        <div className="text-gray-500 px-2">field</div>
        <div className="text-gray-500 px-2">meaning</div>
        {bytes.map((b, i) => (
          <React.Fragment key={i}>
            <div className="text-gray-600 px-2">{b.offset.toString().padStart(2, '0')}</div>
            <div className="text-gray-200 px-2">{b.hex}</div>
            <div className="text-gray-500 px-2">{b.ascii}</div>
            <div className={`${fieldColor[b.field] || 'text-gray-400'} px-2 font-medium`}>{b.field}</div>
            <div className="text-gray-400 px-2">{b.meaning}</div>
          </React.Fragment>
        ))}
      </div>

      {!('bad' in frame) && (frame as FrameRecord).decoded && Object.keys((frame as FrameRecord).decoded).length > 0 && (
        <div className="mt-2 p-2 bg-gray-950 border border-gray-800 rounded">
          <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">Decoded fields</div>
          <pre className="text-[11px] text-emerald-300 whitespace-pre-wrap break-all">
{JSON.stringify((frame as FrameRecord).decoded, null, 2)}
          </pre>
        </div>
      )}

      <div className="mt-2 flex items-start gap-2">
        <StickyNote size={12} className="text-gray-500 mt-1.5"/>
        <textarea value={note} onChange={e => onSetNote(e.target.value)}
          placeholder="Add a note for this frame…"
          className="flex-1 px-2 py-1.5 text-xs bg-gray-950 border border-gray-800 rounded text-gray-200 placeholder-gray-600 resize-none focus:outline-none focus:border-cyan-500/50"
          rows={1}
        />
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Compare modal (frame A vs B)
// ───────────────────────────────────────────────────────────────────────────

function CompareModal({ a, b, onClose }: { a: AnyFrame | null; b: AnyFrame | null; onClose: () => void }) {
  if (!a || !b) return null;
  const aBytes = parseFrameBytes(a.fullHex || '');
  const bBytes = parseFrameBytes(b.fullHex || '');
  const maxLen = Math.max(aBytes.length, bBytes.length);

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-lg max-w-5xl w-full max-h-[85vh] flex flex-col">
        <div className="px-5 py-3 border-b border-gray-800 flex items-center justify-between">
          <h3 className="text-base font-medium text-gray-100 flex items-center gap-2">
            <GitCompare size={16} className="text-purple-400"/> Compare frames
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-200"><X size={16}/></button>
        </div>
        <div className="px-5 py-4 overflow-y-auto">
          <div className="grid grid-cols-2 gap-4 text-xs mb-4">
            {[a, b].map((f, i) => (
              <div key={i} className="border border-gray-800 rounded p-2">
                <div className="text-gray-500 text-[10px] uppercase tracking-wide mb-1">{i === 0 ? 'Frame A' : 'Frame B'}</div>
                <div className="font-mono">
                  <div className="text-gray-200">{(f as any).cmdName} {' '}
                    <span className="text-gray-500">({'bad' in f ? '—' : (f as FrameRecord).cmd})</span></div>
                  <div className="text-gray-500 text-[10px]">{f.ts}</div>
                  {!('bad' in f) && (
                    <div className="text-gray-400 text-[10px]">
                      {(f as FrameRecord).isReply ? 'PD→CP' : 'CP→PD'} · addr {fmtAddr((f as FrameRecord).address)} · seq {(f as FrameRecord).sequence}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="text-xs font-medium text-gray-400 mb-2">Byte diff</div>
          <div className="font-mono text-[11px]">
            <div className="grid grid-cols-[40px,60px,1fr,60px,1fr] gap-1 text-gray-500 sticky top-0 bg-gray-900 py-1 border-b border-gray-800">
              <span>off</span><span>A hex</span><span>A field</span><span>B hex</span><span>B field</span>
            </div>
            {Array.from({ length: maxLen }, (_, i) => {
              const aB = aBytes[i], bB = bBytes[i];
              const same = aB && bB && aB.hex === bB.hex;
              const rowCls = same
                ? 'text-gray-500'
                : aB && bB
                  ? 'text-amber-300 bg-amber-500/5'
                  : 'text-red-300 bg-red-500/5';
              return (
                <div key={i} className={`grid grid-cols-[40px,60px,1fr,60px,1fr] gap-1 py-0.5 ${rowCls}`}>
                  <span>{i.toString().padStart(2, '0')}</span>
                  <span>{aB?.hex || '··'}</span>
                  <span className="text-gray-500 truncate">{aB?.field || ''}</span>
                  <span>{bB?.hex || '··'}</span>
                  <span className="text-gray-500 truncate">{bB?.field || ''}</span>
                </div>
              );
            })}
          </div>

          <div className="mt-3 text-[10px] text-gray-500">
            <span className="text-amber-300">amber</span> = different byte ·
            <span className="text-red-300 ml-2">red</span> = one side has no byte at that offset
          </div>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Shared bits
// ───────────────────────────────────────────────────────────────────────────

const INPUT_CLS = 'w-full px-2 py-1 bg-gray-800 border border-gray-700 rounded text-sm text-gray-100 focus:outline-none focus:border-cyan-500/50';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-0.5">{label}</div>
      {children}
    </div>
  );
}
