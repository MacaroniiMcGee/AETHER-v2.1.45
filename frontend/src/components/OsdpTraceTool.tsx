import React, { useState, useMemo, useRef, useEffect } from 'react';

type WireFrame = {
  ts: string;
  direction?: 'tx' | 'rx';
  portPath?: string;
  address: number | null;
  isReply?: boolean;
  sequence?: number;
  cmd?: number | null;
  cmdName: string;
  length?: number;
  dataHex: string;
  fullHex?: string;
};

type Props = {
  frames: WireFrame[];
  onClear: () => void;
  selectedReaderAddress?: number;
};

const COLORS: Record<string, string> = {
  POLL: '#475569', ACK: '#475569',
  KEYPAD: '#fbbf24', RAW: '#22c55e',
  LED: '#cbd5e1', BUZ: '#a78bfa',
  NAK: '#ef4444',
  PDID: '#8b5cf6', PDCAP: '#8b5cf6',
  ID: '#94a3b8', CAP: '#94a3b8',
  LSTAT: '#94a3b8', LSTATR: '#94a3b8',
  ISTAT: '#94a3b8', ISTATR: '#94a3b8',
  OSTAT: '#94a3b8', OSTATR: '#94a3b8',
  RSTAT: '#94a3b8', RSTATR: '#94a3b8',
};

const OSDP_COL: Record<number, string> = { 0:'off',1:'red',2:'green',3:'amber',4:'blue',5:'magenta',6:'cyan',7:'white' };
const OSDP_NAK: Record<number, string> = { 0:'No error',1:'Msg/CRC',2:'Cmd length',3:'Unknown cmd',4:'Bad sequence',5:'Sec block',6:'Comm sec',9:'Cannot process' };

// commands we retain as evidence: LED 0x69, BUZ 0x6A, CARD 0x50, NAK 0x41,
// secure channel CHLNG 0x76 / SCRYPT 0x77 / KEYSET 0x75 (+ their replies 0x76/0x78/0x79)
const RETAIN = new Set([0x69, 0x6A, 0x50, 0x41, 0x75, 0x76, 0x77, 0x78, 0x79]);

function hexToBytes(h: string): number[] {
  const s = (h || '').replace(/[^0-9a-fA-F]/g, '');
  const out: number[] = [];
  for (let i = 0; i + 1 < s.length; i += 2) out.push(parseInt(s.substr(i, 2), 16));
  return out;
}

type Decoded = { kind: 'led'|'buz'|'card'|'nak'|'sec'|'other'; klass: string; text: string; sig: string };

function decodeFrame(f: WireFrame): Decoded {
  const cmd = (f.cmd === null || f.cmd === undefined) ? -1 : f.cmd;
  const buf = hexToBytes(f.fullHex || f.dataHex || '');
  let s = buf.indexOf(0x53); if (s < 0) s = 0;
  const d = buf.slice(s + 6, Math.max(s + 6, buf.length - 2));
  const out: Decoded = { kind: 'other', klass: '#94a3b8', text: f.cmdName || '?', sig: '' };
  try {
    if (cmd === 0x69) {
      const recs: string[] = [];
      for (let o = 0; o + 14 <= d.length; o += 14) {
        const x = d.slice(o, o + 14), pc = x[9], tc = x[2];
        let on, off, oc, fc, mode: string;
        if (pc === 1) { on = x[10]; off = x[11]; oc = x[12]; fc = x[13]; mode = 'permanent'; }
        else { on = x[3]; off = x[4]; oc = x[5]; fc = x[6]; mode = tc === 2 ? 'temporary' : tc === 1 ? 'cancel-temp' : 'nop'; }
        if (mode === 'cancel-temp') { recs.push('LED ' + x[1] + ' cancel temp'); continue; }
        if (mode === 'nop') { recs.push('LED ' + x[1] + ' no-op'); continue; }
        if (oc === fc) recs.push('LED ' + x[1] + ' steady ' + (OSDP_COL[oc] || oc) + ' (' + mode + ')');
        else recs.push('LED ' + x[1] + ' blink ' + (OSDP_COL[oc] || oc) + '/' + (OSDP_COL[fc] || fc) + ' ' + on * 100 + '/' + off * 100 + 'ms (' + mode + ')');
      }
      out.kind = 'led'; out.text = recs.join(' | ') || 'LED (empty)';
      out.sig = d.slice(9, 14).map(b => b.toString(16).padStart(2, '0')).join(' ');
      if (/steady red/.test(out.text)) out.klass = '#ef4444';
      else if (/amber/.test(out.text)) out.klass = '#ffb13d';
      else if (/green/.test(out.text)) out.klass = '#22c55e';
      else if (/red/.test(out.text)) out.klass = '#ef4444';
    } else if (cmd === 0x6A) {
      out.kind = 'buz';
      out.text = d.length >= 5
        ? 'BUZ ' + (d[1] === 0 ? 'no-op' : d[1] === 1 ? 'off(silent)' : d[1] === 2 ? 'default' : 'tone' + d[1]) + ' ' + d[2] * 100 + '/' + d[3] * 100 + 'ms x' + d[4]
        : 'BUZ (short)';
      out.klass = '#a78bfa';
      out.sig = d.slice(1, 5).map(b => b.toString(16).padStart(2, '0')).join(' ');
    } else if (cmd === 0x50) {
      if (d.length >= 4) {
        const n = d[2] | (d[3] << 8); let extra = '';
        if (n === 26) {
          const c = d.slice(4); const b: number[] = [];
          for (let i = 0; i < c.length; i++) for (let k = 7; k >= 0; k--) b.push((c[i] >> k) & 1);
          if (b.length >= 26) { const X = b.slice(0, 26);
            extra = ' -> FC ' + parseInt(X.slice(1, 9).join(''), 2) + ' card ' + parseInt(X.slice(9, 25).join(''), 2); }
        }
        out.text = 'CARD read ' + n + '-bit' + extra;
      } else out.text = 'CARD (short)';
      out.kind = 'card'; out.klass = '#3dd6e0';
    } else if (cmd === 0x41) {
      out.kind = 'nak'; out.text = 'NAK - ' + (OSDP_NAK[d[0]] || ('0x' + (d[0] || 0).toString(16))); out.klass = '#ef4444';
    } else if (cmd === 0x76) { out.kind = 'sec'; out.text = f.isReply ? 'SEC CCRYPT (reply)' : 'SEC CHLNG'; out.klass = '#fbbf24'; }
    else if (cmd === 0x77) { out.kind = 'sec'; out.text = 'SEC SCRYPT'; out.klass = '#fbbf24'; }
    else if (cmd === 0x78) { out.kind = 'sec'; out.text = 'SEC RMAC (reply)'; out.klass = '#fbbf24'; }
    else if (cmd === 0x75) { out.kind = 'sec'; out.text = 'SEC KEYSET'; out.klass = '#fbbf24'; }
    else if (cmd === 0x79) { out.kind = 'sec'; out.text = 'SEC reply'; out.klass = '#fbbf24'; }
    else if (cmd === 0x60) out.text = 'poll';
    else if (cmd === 0x40) out.text = 'ACK';
    else if (cmd === 0x61) out.text = 'request ID';
    else if (cmd === 0x62) out.text = 'request CAP';
  } catch (e) { /* leave defaults */ }
  return out;
}

function idleVerdict(sig: string, text: string): [string, string] {
  if (/^01 01 01 01 01$/.test(sig) || /steady red/.test(text)) return ['OK — steady red', '#22c55e'];
  if (/0a 0a 01 03/i.test(sig) || /red\/amber/.test(text)) return ['DEFECT — red/amber blink at idle (alarm-masking)', '#ef4444'];
  if (/steady/.test(text)) return ['non-spec — steady but not red', '#ffb13d'];
  if (text === '(none seen)') return ['(no idle LED captured yet)', '#475569'];
  return ['non-spec — ' + text, '#ffb13d'];
}

const KEYNOTES_SPEC = [
  'KEYNOTES — OSDP reader-indication evidence',
  '',
  'Specified correct behavior:',
  '  Idle / secure (no activity) ...... steady RED            (LED bytes: 01 01 01 01 01)',
  '  Valid card presented (grant) ..... GREEN',
  '  Door HELD open too long .......... red/amber flash + beep (alarm only)',
  '  Door FORCED open ................. red/amber alternate    (alarm only)',
  '',
  'Flagged defect (alarm-masking):',
  '  A reader showing red/amber blink AT IDLE (LED bytes: 01 0A 0A 01 03)',
  '  instead of steady red. Idle then looks identical to a forced/held alarm,',
  '  so a genuine forced-door condition is visually indistinguishable from idle.',
  '',
  'Scope: standard OSDP (LED 0x69, BUZ 0x6A, RAW 0x50, NAK 0x41, secure-channel)',
  'is decoded and authoritative. Mercury/HID 0x80 (00 60 EE) vendor frames are',
  'NOT decoded (proprietary). Buffer retains evidentiary frames only.',
];

export default function OsdpTraceTool({ frames, onClear, selectedReaderAddress }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [filterToReader, setFilterToReader] = useState(false);
  const [hideAcks, setHideAcks] = useState(true);
  const [view, setView] = useState<'flat' | 'sections'>('flat');
  const [cmpA, setCmpA] = useState<string>('');
  const [cmpB, setCmpB] = useState<string>('');

  // ---- retained evidence buffer (survives the 500-frame prop churn) ----
  const bufRef = useRef<WireFrame[]>([]);
  const seenRef = useRef<Set<string>>(new Set());
  const [bufTick, setBufTick] = useState(0); // bump to re-render when buffer grows
  const MAX_BUF = 5000;

  useEffect(() => {
    let added = false;
    // frames prop is newest-first; walk oldest-first so buffer stays chronological
    for (let i = frames.length - 1; i >= 0; i--) {
      const f = frames[i];
      const c = (f.cmd === null || f.cmd === undefined) ? -1 : f.cmd;
      if (!RETAIN.has(c)) continue;
      const key = f.ts + '|' + (f.portPath || '?') + '|' + f.address + '|' + (f.fullHex || f.dataHex || '');
      if (seenRef.current.has(key)) continue;
      seenRef.current.add(key);
      bufRef.current.push(f);
      added = true;
    }
    if (bufRef.current.length > MAX_BUF) {
      bufRef.current.splice(0, bufRef.current.length - MAX_BUF);
    }
    if (added) setBufTick(t => t + 1);
  }, [frames]);

  const resetBuffer = () => {
    bufRef.current = [];
    seenRef.current = new Set();
    setBufTick(t => t + 1);
  };

  const filtered = frames.filter(f => {
    if (filterToReader && selectedReaderAddress !== undefined && f.address !== selectedReaderAddress) return false;
    if (hideAcks && (f.cmdName === 'ACK' || f.cmdName === 'POLL')) return false;
    return true;
  });

  // per-reader buckets are built from the RETAINED buffer, not the volatile prop
  const buckets = useMemo(() => {
    const m = new Map<string, { port: string; addr: number | null; frames: WireFrame[] }>();
    for (const f of bufRef.current) {
      const k = (f.portPath || '?') + '|' + (f.address);
      if (!m.has(k)) m.set(k, { port: f.portPath || '?', addr: f.address, frames: [] });
      m.get(k)!.frames.push(f);
    }
    return m;
  }, [bufTick]);
  const bucketKeys = useMemo(() => [...buckets.keys()].sort(), [buckets]);

  const colorOf = (name: string) => COLORS[name] || '#94a3b8';
  const dirIcon = (dd?: string) => dd === 'tx' ? '↗' : dd === 'rx' ? '↙' : '·';
  const dirColor = (dd?: string) => dd === 'tx' ? '#cbd5e1' : dd === 'rx' ? '#a78bfa' : '#475569';
  const stampFile = () => new Date().toISOString().split('.')[0].replace(/[:T]/g, '-');

  // build the keynotes header (spec + per-reader verdict + window + counts)
  const buildKeynotes = (): string[] => {
    const buf = bufRef.current;
    const lines = [...KEYNOTES_SPEC, ''];
    if (buf.length === 0) { lines.push('Capture: (empty)'); return lines; }
    const t0 = buf[0].ts, t1 = buf[buf.length - 1].ts;
    lines.push('Capture window: ' + t0 + '  ->  ' + t1);
    lines.push('Retained evidentiary frames: ' + buf.length);
    lines.push('');
    lines.push('Per-reader summary:');
    for (const k of [...buckets.keys()].sort()) {
      const b = buckets.get(k)!;
      const p = profileOf(b.frames);
      const [v] = idleVerdict(p.idleSig, p.idle);
      lines.push('  ' + b.port + ' addr 0x' + (b.addr ?? 0).toString(16).padStart(2, '0') +
        '  (' + b.frames.length + ' frames)');
      lines.push('     idle:  ' + p.idle + '   => ' + v);
      lines.push('     grant: ' + p.grant);
      lines.push('     buz:   ' + p.buz + '   card: ' + p.card);
    }
    lines.push('');
    lines.push('-'.repeat(72));
    return lines;
  };

  const copyTrace = () => {
    const buf = bufRef.current;
    const head = buildKeynotes().join('\n') + '\n';
    const lines = buf.map(f => {
      const dec = decodeFrame(f);
      const t = new Date(f.ts).toLocaleTimeString();
      const dir = f.direction === 'tx' ? 'TX' : f.direction === 'rx' ? 'RX' : '--';
      const addr = '0x' + (f.address ?? 0).toString(16).padStart(2, '0');
      return '[' + t + '] ' + dir + ' ' + (f.portPath || '?') + ' ' + addr + '  ' +
        dec.text + '  |  ' + (f.fullHex || f.dataHex || '');
    }).join('\n');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(head + lines).catch(() => {});
    }
  };

  const downloadCsv = () => {
    const buf = bufRef.current;
    const notes = buildKeynotes().map(l => '# ' + l).join('\n');
    const header = 'Timestamp,Direction,Port,Address,Sequence,Command,CommandName,Decode,Length,DataHex';
    const rows = buf.map(f => {
      const dec = decodeFrame(f);
      return [
        new Date(f.ts).toISOString(),
        f.direction || '',
        f.portPath || '',
        '0x' + (f.address ?? 0).toString(16).padStart(2, '0'),
        f.sequence ?? '',
        (f.cmd !== null && f.cmd !== undefined) ? '0x' + f.cmd.toString(16).padStart(2, '0').toUpperCase() : '',
        f.cmdName || '',
        dec.text,
        f.length ?? '',
        f.fullHex || f.dataHex || '',
      ].map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',');
    });
    const csv = notes + '\n' + [header].concat(rows).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'aether-evidence-' + stampFile() + '.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const downloadJson = () => {
    const buf = bufRef.current;
    const data = {
      keynotes: buildKeynotes(),
      exported: new Date().toISOString(),
      frameCount: buf.length,
      frames: buf.map(f => ({
        timestamp: f.ts, direction: f.direction, portPath: f.portPath,
        address: f.address, isReply: f.isReply, sequence: f.sequence,
        cmd: f.cmd, cmdName: f.cmdName, length: f.length,
        dataHex: f.dataHex, fullHex: f.fullHex,
        decode: decodeFrame(f).text,
      })),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'aether-evidence-' + stampFile() + '.json';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  function profileOf(fr: WireFrame[]) {
    const decs = fr.map(decodeFrame);
    const idle = decs.find(x => x.kind === 'led' && !/green/.test(x.text));
    const grant = decs.find(x => x.kind === 'led' && /green/.test(x.text));
    const buz = decs.find(x => x.kind === 'buz');
    const card = decs.find(x => x.kind === 'card');
    return {
      idle: idle ? idle.text : '(none seen)',
      idleSig: idle ? idle.sig : '',
      grant: grant ? grant.text : '(none seen)',
      buz: buz ? buz.text : '(none seen)',
      card: card ? card.text : '(none seen)',
    };
  }

  const renderComparison = () => {
    const a = buckets.get(cmpA), b = buckets.get(cmpB);
    if (!a || !b || cmpA === cmpB) {
      return <div style={{ color: '#475569', padding: 12 }}>Pick two different reader sections above.</div>;
    }
    const pa = profileOf(a.frames), pb = profileOf(b.frames);
    const [va, ca] = idleVerdict(pa.idleSig, pa.idle);
    const [vb, cb] = idleVerdict(pb.idleSig, pb.idle);
    const diff = (x: string, y: string) =>
      x === y ? <span style={{ color: '#22c55e' }}>same</span> : <span style={{ color: '#ef4444', fontWeight: 'bold' }}>DIFFERS</span>;
    const td: React.CSSProperties = { border: '1px solid #1d2a4a', padding: '6px 8px', verticalAlign: 'top' };
    const th: React.CSSProperties = { ...td, background: 'rgba(0,0,0,0.4)', color: '#94a3b8' };
    const nameA = a.port + ' addr 0x' + (a.addr ?? 0).toString(16).padStart(2, '0');
    const nameB = b.port + ' addr 0x' + (b.addr ?? 0).toString(16).padStart(2, '0');
    return (
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 11, marginTop: 8 }}>
        <tbody>
          <tr><th style={th}>Aspect</th><th style={th}>{nameA}</th><th style={th}>{nameB}</th><th style={th}></th></tr>
          <tr><td style={td}>Idle / non-grant LED</td><td style={td}>{pa.idle}</td><td style={td}>{pb.idle}</td><td style={td}>{diff(pa.idle, pb.idle)}</td></tr>
          <tr><td style={td}><b>Idle verdict vs spec</b></td><td style={{ ...td, color: ca, fontWeight: 'bold' }}>{va}</td><td style={{ ...td, color: cb, fontWeight: 'bold' }}>{vb}</td><td style={td}></td></tr>
          <tr><td style={td}>Grant LED</td><td style={td}>{pa.grant}</td><td style={td}>{pb.grant}</td><td style={td}>{diff(pa.grant, pb.grant)}</td></tr>
          <tr><td style={td}>Buzzer (latest)</td><td style={td}>{pa.buz}</td><td style={td}>{pb.buz}</td><td style={td}>{diff(pa.buz, pb.buz)}</td></tr>
          <tr><td style={td}>Card (latest)</td><td style={td}>{pa.card}</td><td style={td}>{pb.card}</td><td style={td}>{diff(pa.card, pb.card)}</td></tr>
        </tbody>
      </table>
    );
  };

  return (
    <div style={{ border: '1px solid #3a3a5a', borderRadius: 8, backgroundColor: 'rgba(0,0,0,0.4)', marginTop: 16, overflow: 'hidden' }}>
      <div
        onClick={() => setCollapsed(!collapsed)}
        style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer',
          backgroundColor: 'rgba(0,0,0,0.4)', borderBottom: collapsed ? 'none' : '1px solid #3a3a5a', userSelect: 'none' }}
      >
        <span style={{ color: '#cbd5e1', fontFamily: 'monospace' }}>{collapsed ? '▶' : '▼'}</span>
        <span style={{ color: '#cbd5e1', fontWeight: 'bold' }}>Trace</span>
        <span style={{ padding: '2px 8px', borderRadius: 12, fontSize: 11, backgroundColor: '#1a5a1a', color: '#4ade80' }}>● Passive · always live</span>
        <span style={{ color: '#888', fontSize: 12, marginLeft: 'auto' }}>
          {filtered.length} live · {bufRef.current.length} retained
        </span>
      </div>

      {!collapsed && (
        <div style={{ padding: 12 }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', border: '1px solid #3a3a5a', borderRadius: 4, overflow: 'hidden' }}>
              <button onClick={(e) => { e.stopPropagation(); setView('flat'); }}
                style={{ ...btn(view === 'flat' ? '#1d4ed8' : 'rgba(0,0,0,0.35)'), borderRadius: 0 }}>Flat list</button>
              <button onClick={(e) => { e.stopPropagation(); setView('sections'); }}
                style={{ ...btn(view === 'sections' ? '#1d4ed8' : 'rgba(0,0,0,0.35)'), borderRadius: 0 }}>Per-reader + compare</button>
            </div>
            <button onClick={(e) => { e.stopPropagation(); copyTrace(); }} style={btn('rgba(0,0,0,0.35)')} title="Copy retained buffer + keynotes"> Copy</button>
            <button onClick={(e) => { e.stopPropagation(); downloadCsv(); }} style={btn('rgba(0,0,0,0.35)')} title="Export retained buffer (keynotes header) as CSV">CSV</button>
            <button onClick={(e) => { e.stopPropagation(); downloadJson(); }} style={btn('rgba(0,0,0,0.35)')} title="Export retained buffer (keynotes) as JSON">JSON</button>
            <button onClick={(e) => { e.stopPropagation(); onClear(); }} style={btn('rgba(0,0,0,0.4)')} title="Clear live frame list">🗑️ live</button>
            <button onClick={(e) => { e.stopPropagation(); resetBuffer(); }} style={btn('rgba(80,0,0,0.5)')} title="Reset retained evidence buffer">⟲ buffer</button>
            <label style={lbl}>
              <input type="checkbox" checked={hideAcks} onChange={e => setHideAcks(e.target.checked)} />
              Hide ACK/POLL
            </label>
            {selectedReaderAddress !== undefined && (
              <label style={lbl}>
                <input type="checkbox" checked={filterToReader} onChange={e => setFilterToReader(e.target.checked)} />
                Only addr 0x{selectedReaderAddress.toString(16).padStart(2, '0')}
              </label>
            )}
            <span style={{ marginLeft: 'auto', fontSize: 10, color: '#475569' }}>
              <span style={{ color: '#cbd5e1' }}>↗ TX</span> = we send to ACS &nbsp;
              <span style={{ color: '#a78bfa' }}>↙ RX</span> = ACS sends to us
            </span>
          </div>

          {view === 'flat' && (
            <div style={{ maxHeight: 240, overflowY: 'auto', backgroundColor: 'rgba(0,0,0,0.45)',
              border: '1px solid #1d2a4a', borderRadius: 4, padding: 8, fontFamily: '"Courier New", monospace', fontSize: 11 }}>
              {filtered.length === 0 ? (
                <div style={{ color: '#475569', textAlign: 'center', padding: 20 }}>Waiting for OSDP traffic…</div>
              ) : (
                filtered.slice(0, 100).map((f, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, padding: '2px 0', borderBottom: '1px solid rgba(0,0,0,0.4)', whiteSpace: 'nowrap' }}>
                    <span style={{ color: '#64748b', minWidth: 70 }}>{new Date(f.ts).toLocaleTimeString()}</span>
                    <span style={{ color: dirColor(f.direction), minWidth: 18, textAlign: 'center', fontWeight: 'bold' }}>{dirIcon(f.direction)}</span>
                    <span style={{ color: colorOf(f.cmdName), minWidth: 64, fontWeight: 'bold' }}>{f.cmdName}</span>
                    <span style={{ color: '#94a3b8', minWidth: 50 }}>
                      {f.address !== null && f.address !== undefined ? '0x' + f.address.toString(16).padStart(2, '0') : '----'}
                    </span>
                    <span style={{ color: '#cbd5e1', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.dataHex || '—'}</span>
                  </div>
                ))
              )}
            </div>
          )}

          {view === 'sections' && (
            <div>
              {bucketKeys.length === 0 ? (
                <div style={{ color: '#475569', textAlign: 'center', padding: 20 }}>
                  No evidentiary frames retained yet — exercise a reader (LED/BUZ/card). POLL/ACK/vendor are not retained.
                </div>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                  {bucketKeys.map(k => {
                    const b = buckets.get(k)!;
                    const recent = [...b.frames].slice(-80).reverse();
                    return (
                      <div key={k} style={{ flex: '1 1 420px', minWidth: 340, border: '1px solid #1d2a4a', borderRadius: 6, overflow: 'hidden' }}>
                        <div style={{ padding: '8px 12px', background: 'rgba(0,0,0,0.4)', borderBottom: '1px solid #1d2a4a', fontSize: 12, color: '#cbd5e1' }}>
                          <b>{b.port}</b> · addr 0x{(b.addr ?? 0).toString(16).padStart(2, '0')}
                          <span style={{ color: '#475569', float: 'right' }}>{b.frames.length} frames</span>
                        </div>
                        <div style={{ maxHeight: 220, overflowY: 'auto', padding: 6, fontFamily: '"Courier New", monospace', fontSize: 11 }}>
                          {recent.map((f, i) => {
                            const dec = decodeFrame(f);
                            return (
                              <div key={i} style={{ padding: '2px 4px', borderBottom: '1px solid rgba(0,0,0,0.35)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                <span style={{ color: '#64748b' }}>{new Date(f.ts).toLocaleTimeString()}</span>{' '}
                                <span style={{ color: dirColor(f.direction), fontWeight: 'bold' }}>{f.direction === 'tx' ? 'TX' : 'RX'}</span>{' '}
                                <span style={{ color: dec.klass }}>{dec.text}</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <div style={{ marginTop: 14, border: '1px solid #1d2a4a', borderRadius: 6, padding: 12 }}>
                <div style={{ fontSize: 12, color: '#cbd5e1', fontWeight: 'bold', marginBottom: 8 }}>
                  Comparison — idle-state defect &amp; command differences
                </div>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                  <label style={lbl}>A&nbsp;
                    <select value={cmpA} onChange={e => setCmpA(e.target.value)} style={sel}>
                      <option value="">—</option>
                      {bucketKeys.map(k => { const b = buckets.get(k)!; return <option key={k} value={k}>{b.port} 0x{(b.addr ?? 0).toString(16).padStart(2, '0')}</option>; })}
                    </select>
                  </label>
                  <label style={lbl}>B&nbsp;
                    <select value={cmpB} onChange={e => setCmpB(e.target.value)} style={sel}>
                      <option value="">—</option>
                      {bucketKeys.map(k => { const b = buckets.get(k)!; return <option key={k} value={k}>{b.port} 0x{(b.addr ?? 0).toString(16).padStart(2, '0')}</option>; })}
                    </select>
                  </label>
                </div>
                {renderComparison()}
                <div style={{ fontSize: 10, color: '#475569', marginTop: 10, lineHeight: 1.5 }}>
                  Spec: idle = steady red; grant = green; held/forced = red/amber (alarm-only).
                  Flagged defect: red/amber blink at idle (LED bytes <code>… 01 0A 0A 01 03</code>) instead of
                  steady red (<code>… 01 01 01 01 01</code>) — makes idle indistinguishable from a forced/held alarm.
                  Standard OSDP only; Mercury 0x80 vendor frames not decoded.
                </div>
              </div>
            </div>
          )}

          <div style={{ fontSize: 10, color: '#475569', marginTop: 6 }}>
            Live tap on OSDPManager TX/RX. Retained buffer keeps LED/BUZ/CARD/NAK/secure-channel
            (clears on reload or ⟲ buffer); exports lead with a keynotes header.
          </div>
        </div>
      )}
    </div>
  );
}

const btn = (bg: string): React.CSSProperties => ({
  padding: '5px 12px', border: 'none', borderRadius: 4,
  backgroundColor: bg, color: '#fff', cursor: 'pointer', fontSize: 12,
});
const lbl: React.CSSProperties = {
  color: '#aaa', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer',
};
const sel: React.CSSProperties = {
  background: 'rgba(0,0,0,0.4)', color: '#cbd5e1', border: '1px solid #3a3a5a',
  borderRadius: 4, padding: '4px 8px', fontSize: 12,
};
