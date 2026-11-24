// AETHER_TRACE (TRACE-5) — Setup › Suggested wiring: what Aether is wired to on the controller, proved (Discover),
// configured (Doors page) or seen (normal testing). The drawing is always Hydra's own (Integrations › Board Blueprints, 1.8.0+), framed
// here as a drawing-only view. The hand-drawn simple picture is never shown on its own: only when the user asks for it (Hydra too old).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Wand2, Radar, Square, Download, ExternalLink, Check, AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { Badge, Button, Empty, Toggle, cx } from '../sunapi/ui';
import { defaultBackend, type TraceApi, type Status, type Suggestion, type SuggestRow, type DiscoverStatus, type SuggestDoor } from './api';

// ── the drawing ─────────────────────────────────────────────────────────────
// Aether card blocks and colours as Hydra draws the "Aether (Pi 5 + Sequent IOplus)" board; controller doors as the NHP
// library boards name their blocks (READER / DPS / REX / OUT).
const AE_BLOCKS: { name: string; color: string; pins: string[] }[] = [
  { name: 'RS-485', color: '#2f6fd0', pins: ['RS485 A', 'RS485 B', 'GND'] },
  { name: 'Relays 1–4', color: '#f07a23', pins: ['REL1 NO', 'REL2 NO', 'REL3 NO', 'REL4 NO', 'COM 1-4'] },
  { name: 'Relays 5–8', color: '#f07a23', pins: ['REL5 NO', 'REL6 NO', 'REL7 NO', 'REL8 NO', 'COM 5-8'] },
  { name: 'Opto inputs 1–4', color: '#2f8f5b', pins: ['OPTO1', 'OPTO2', 'OPTO3', 'OPTO4', 'OPTO GND'] },
  { name: 'Opto inputs 5–8', color: '#2f8f5b', pins: ['OPTO5', 'OPTO6', 'OPTO7', 'OPTO8', 'OPTO GND '] },
  { name: 'Analog inputs 1–8', color: '#1f9e8f', pins: ['ADC1', 'ADC2', 'ADC3', 'ADC4', 'ADC5', 'ADC6', 'ADC7', 'ADC8', 'AGND'] },
  { name: 'Wiegand readers 1–4 (GPIO)', color: '#7b4fbf', pins: ['GND', 'R1 D0', 'R1 D1', 'R2 D0', 'R2 D1', 'R3 D0', 'R3 D1', 'R4 D0', 'R4 D1'] },
];
// wire colours by job (reader conductors in their usual colours)
const WIRE = { d0: '#2f9e44', d1: '#e9ecef', gnd: '#495057', dps: '#3b82f6', rex: '#eab308', lock: '#a855f7', input: '#14b8a6', output: '#f97316', bus: '#2f6fd0' };
const ROLE_WORD: Record<string, string> = { dps: 'DPS', rex: 'REX', lock: 'Lock watch', card: 'Reader', input: 'Input', output: 'Output' };
const SRC_WORD: Record<string, string> = { probe: 'proved', 'doors page': 'configured', seen: 'seen' };

/** Aether pin(s) a channel lands on. */
function aetherPins(ch: string): { sig: string; ret: string } | null {
  let m;
  if ((m = /^relay:(\d+)$/.exec(ch))) { const n = +m[1] + 1; return { sig: `REL${n} NO`, ret: n <= 4 ? 'COM 1-4' : 'COM 5-8' }; }
  if ((m = /^opto:(\d+)$/.exec(ch))) { const n = +m[1] + 1; return { sig: `OPTO${n}`, ret: n <= 4 ? 'OPTO GND' : 'OPTO GND ' }; }
  if ((m = /^adc:(\d+)$/.exec(ch))) return { sig: `ADC${+m[1] + 1}`, ret: 'AGND' };
  return null;
}
const wiegandIndex = (ch: string, readers: string[]) => { const id = ch.replace(/^wiegand:/, ''); const m = /(\d+)$/.exec(id); const i = readers.indexOf(id); return i >= 0 ? i + 1 : m ? Math.min(4, Math.max(1, +m[1])) : 1; };

export const HydraDrawing: React.FC<{ s: Suggestion; wiegandIds: string[]; svgRef?: React.Ref<SVGSVGElement> }> = ({ s, wiegandIds, svgRef }) => {
  const PIN = 15, BW = 210, AX = 40, CX = 760, CW = 230;
  // Aether pins
  const aPos = new Map<string, { x: number; y: number }>();
  let y = 60;
  const aBlocks = AE_BLOCKS.map(b => { const top = y; b.pins.forEach((p, i) => aPos.set(p, { x: AX + BW, y: top + 22 + i * PIN })); y = top + 22 + b.pins.length * PIN + 14; return { ...b, top }; });
  const aH = y;
  // controller doors
  const cPos = new Map<string, { x: number; y: number }>();
  const cBlocks: { title: string; ctrl: string; top: number; blocks: { name: string; pins: string[]; top: number }[] }[] = [];
  let cy = 60;
  for (const c of s.controllers) for (const d of c.doors) {
    const top = cy; const blocks: { name: string; pins: string[]; top: number }[] = []; let by = top + 26;
    const add = (name: string, pins: string[]) => { blocks.push({ name, pins, top: by }); pins.forEach((p, i) => cPos.set(`${d.door}|${name}|${p}`, { x: CX, y: by + 18 + i * PIN })); by += 18 + pins.length * PIN + 8; };
    add('READER', ['RD 12V+', 'RD GND', 'D0 (A/+)', 'D1 (B/-)', 'BUZ (F1)', 'LED (F2)']);
    add('DPS', ['DPS +', 'DPS -']);
    add('REX', ['REX +', 'REX -']);
    add('OUT', ['NO', 'COM', 'NC']);
    if (d.inputs.length) add('AUX IN', ['AUX +', 'AUX -']);
    cBlocks.push({ title: d.name, ctrl: `${c.name}${c.model ? ` · ${c.model}` : ''}`, top, blocks }); cy = by + 16;
  }
  const H = Math.max(aH, cy) + 30;
  type W = { from: { x: number; y: number }; to: { x: number; y: number }; color: string; dash?: string; title: string; label?: string };
  const wires: W[] = [];
  const dash = (src: string) => (src === 'seen' ? '6 4' : src === 'doors page' ? undefined : undefined);
  const link = (aPin: string, door: SuggestDoor, block: string, cPin: string, color: string, src: string, title: string, label?: string) => {
    const a = aPos.get(aPin), c = cPos.get(`${door.door}|${block}|${cPin}`);
    if (a && c) wires.push({ from: a, to: c, color, dash: dash(src), title: `${title} — ${SRC_WORD[src] || src}`, label });
  };
  for (const c of s.controllers) for (const d of c.doors) {
    if (d.reader && /^wiegand:/.test(d.reader.ch)) {
      const n = wiegandIndex(d.reader.ch, wiegandIds);
      link(`R${n} D0`, d, 'READER', 'D0 (A/+)', WIRE.d0, d.reader.source, `Aether Wiegand R${n} D0 → ${d.name} reader D0`);
      link(`R${n} D1`, d, 'READER', 'D1 (B/-)', WIRE.d1, d.reader.source, `Aether Wiegand R${n} D1 → ${d.name} reader D1`);
      link('GND', d, 'READER', 'RD GND', WIRE.gnd, d.reader.source, `Aether GND → ${d.name} reader GND`);
    } else if (d.reader && /^(emu|osdp):/.test(d.reader.ch)) {
      link('RS485 A', d, 'READER', 'D0 (A/+)', WIRE.bus, d.reader.source, `Aether RS-485 A → ${d.name} reader port A (${d.reader.terminal.label})`);
      link('RS485 B', d, 'READER', 'D1 (B/-)', WIRE.bus, d.reader.source, `Aether RS-485 B → ${d.name} reader port B`);
    }
    for (const [slot, block, sig, ret, color] of [['dps', 'DPS', 'DPS +', 'DPS -', WIRE.dps], ['rex', 'REX', 'REX +', 'REX -', WIRE.rex]] as const) {
      const v = d[slot]; const p = v && aetherPins(v.ch); if (!v || !p) continue;
      link(p.sig, d, block, sig, color, v.source, `${p.sig} → ${d.name} ${block} +${v.active === 'closed' ? ' (normally closed)' : ''}`, slot === 'dps' && v.active === 'closed' ? 'NC' : undefined);
      link(p.ret, d, block, ret, color, v.source, `${p.ret} → ${d.name} ${block} −`);
    }
    if (d.lock) { const p = aetherPins(d.lock.ch); if (p) { link(p.sig, d, 'OUT', 'NO', WIRE.lock, d.lock.source, `${d.name} lock relay NO → ${p.sig} (Aether watches the strike)`); link(p.ret, d, 'OUT', 'COM', WIRE.lock, d.lock.source, `${d.name} lock relay COM → ${p.ret}`); } }
    for (const v of d.inputs) { const p = aetherPins(v.ch); if (p) { link(p.sig, d, 'AUX IN', 'AUX +', WIRE.input, v.source, `${p.sig} → ${d.name} input +`); link(p.ret, d, 'AUX IN', 'AUX -', WIRE.input, v.source, `${p.ret} → ${d.name} input −`); } }
  }
  // spread wire bends so parallel wires do not overlap
  const midBase = (AX + BW + CX) / 2;
  return (
    <svg ref={svgRef} viewBox={`0 0 ${CX + CW + 40} ${H}`} className="w-full" role="img" aria-label="Suggested wiring between Aether and the controller" style={{ background: 'rgb(var(--hv-widget-panel))', fontFamily: 'Noto Sans, system-ui, sans-serif' }}>
      <text x={AX} y={30} fontSize={14} fontWeight={700} fill="rgb(var(--hv-text))">Aether (Pi 5 + Sequent IOplus)</text>
      <rect x={AX - 10} y={44} width={BW + 20} height={aH - 44} rx={6} fill="#1d4a37" stroke="#2c6b51" />
      {aBlocks.map(b => (
        <g key={b.name}>
          <text x={AX + 4} y={b.top + 14} fontSize={10} fontWeight={600} fill="#cfe8dc">{b.name}</text>
          {b.pins.map((p, i) => (
            <g key={p}>
              <rect x={AX + BW - 70} y={b.top + 22 + i * PIN - 6} width={70} height={12} rx={2} fill={b.color} opacity={0.9} />
              <text x={AX + BW - 66} y={b.top + 22 + i * PIN + 3.5} fontSize={9} fill="#fff">{p.trim()}</text>
              <circle cx={AX + BW} cy={b.top + 22 + i * PIN} r={3} fill="#e8f0ec" stroke="#1d4a37" />
            </g>
          ))}
        </g>
      ))}
      {cBlocks.map(cb => (
        <g key={cb.title + cb.top}>
          <rect x={CX - 10} y={cb.top} width={CW + 20} height={cb.blocks[cb.blocks.length - 1].top + 18 + cb.blocks[cb.blocks.length - 1].pins.length * PIN - cb.top + 4} rx={6} fill="#1b2a44" stroke="#2c4470" />
          <text x={CX} y={cb.top + 16} fontSize={11} fontWeight={700} fill="#dbe6ff">{cb.title}</text>
          <text x={CX + CW} y={cb.top + 16} fontSize={9} textAnchor="end" fill="#9fb3d9">{cb.ctrl}</text>
          {cb.blocks.map(b => (
            <g key={b.name}>
              <text x={CX + CW} y={b.top + 10} fontSize={9} fontWeight={600} textAnchor="end" fill="#9fb3d9">{b.name}</text>
              {b.pins.map((p, i) => (
                <g key={p}>
                  <circle cx={CX} cy={b.top + 18 + i * PIN} r={3} fill="#e6ecf8" stroke="#1b2a44" />
                  <rect x={CX + 8} y={b.top + 18 + i * PIN - 6} width={70} height={12} rx={2} fill="#2c4470" />
                  <text x={CX + 12} y={b.top + 18 + i * PIN + 3.5} fontSize={9} fill="#fff">{p}</text>
                </g>
              ))}
            </g>
          ))}
        </g>
      ))}
      {wires.map((w, i) => {
        const mx = midBase + ((i % 9) - 4) * 14;
        const d = `M${w.from.x},${w.from.y} C${mx},${w.from.y} ${mx},${w.to.y} ${w.to.x},${w.to.y}`;
        return (
          <g key={i}>
            <title>{w.title}</title>
            <path d={d} fill="none" stroke="rgb(var(--hv-widget-panel))" strokeWidth={5} />
            <path d={d} fill="none" stroke={w.color} strokeWidth={2.2} strokeDasharray={w.dash} strokeLinecap="round" />
            {w.label && <text x={mx + 4} y={(w.from.y + w.to.y) / 2 - 3} fontSize={9} fontWeight={700} fill={w.color}>{w.label}</text>}
          </g>
        );
      })}
      {!s.controllers.length && <text x={CX} y={80} fontSize={12} fill="rgb(var(--hv-text-3))">No controller door known yet: pair doors on the Doors page, or run Discover.</text>}
      <g transform={`translate(${AX},${H - 14})`} fontSize={10} fill="rgb(var(--hv-text-2))">
        {([['Reader D0', WIRE.d0], ['D1', WIRE.d1], ['GND', WIRE.gnd], ['DPS', WIRE.dps], ['REX', WIRE.rex], ['Lock watch', WIRE.lock], ['Input', WIRE.input], ['RS-485', WIRE.bus]] as [string, string][]).map(([t, c], i) => (
          <g key={t} transform={`translate(${i * 95},0)`}><line x1={0} x2={18} y1={-3} y2={-3} stroke={c} strokeWidth={3} /><text x={22} y={0}>{t}</text></g>
        ))}
        <g transform="translate(770,0)"><line x1={0} x2={18} y1={-3} y2={-3} stroke="rgb(var(--hv-text-2))" strokeWidth={2} strokeDasharray="6 4" /><text x={22} y={0}>seen only (not proved)</text></g>
      </g>
    </svg>
  );
};

function downloadSvg(svg: SVGSVGElement | null, name: string, png: boolean) {
  if (!svg) return;
  const clone = svg.cloneNode(true) as SVGSVGElement;
  // resolve the theme colours so the file looks the same outside Aether
  const cs = getComputedStyle(document.documentElement);
  const fix = (v: string) => v.replace(/rgb\(var\((--[\w-]+)\)\)/g, (_m, n) => `rgb(${cs.getPropertyValue(n).trim().split(/\s+/).join(',')})`);
  clone.querySelectorAll('*').forEach(el => ['fill', 'stroke'].forEach(a => { const v = el.getAttribute(a); if (v && v.includes('var(')) el.setAttribute(a, fix(v)); }));
  clone.setAttribute('style', fix(clone.getAttribute('style') || ''));
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const text = new XMLSerializer().serializeToString(clone);
  const save = (blob: Blob, ext: string) => { const u = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = u; a.download = `${name}.${ext}`; a.click(); setTimeout(() => URL.revokeObjectURL(u), 1000); };
  if (!png) return save(new Blob([text], { type: 'image/svg+xml' }), 'svg');
  const img = new Image(); const vb = svg.viewBox.baseVal;
  img.onload = () => { const c = document.createElement('canvas'); c.width = vb.width * 2; c.height = vb.height * 2; const g = c.getContext('2d')!; g.scale(2, 2); g.drawImage(img, 0, 0); c.toBlob(b => b && save(b, 'png'), 'image/png'); };
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text);
}

// ── Hydra's drawing, framed ─────────────────────────────────────────────────
type HydraBoard = { controller: string; name: string; model: string; drawnAs: string; wired: number; unmapped: number; guessed: boolean };
type HydraNews = { ok: boolean; error?: string; boards?: HydraBoard[]; active?: string | null; skipped?: string[]; switched?: boolean };
const HYDRA_OPEN_KEY = 'bb-aether-open';   // read once by Hydra when it next opens (Integrations › Board Blueprints)
export function openInHydra(from: HTMLElement | null, controller: string | null) {
  try { localStorage.setItem(HYDRA_OPEN_KEY, JSON.stringify({ at: Date.now(), controller })); } catch { /* storage blocked */ }
  // Aether's page switches to Integrations › Board Blueprints when it knows this event (AETHER_TRACE nav); otherwise a new tab
  const ev = new CustomEvent('aether-open-tool', { bubbles: true, cancelable: true, detail: { page: 'blueprint' } });
  const handled = from ? !from.dispatchEvent(ev) : false;
  if (!handled) window.open(`${defaultBackend()}/api/blueprints/page?aetherWiring=1${controller ? `&controller=${encodeURIComponent(controller)}` : ''}`, '_blank', 'noopener');
}
const HydraFrame: React.FC<{ rev: number; onNews: (n: HydraNews | 'old') => void; frameRef: React.RefObject<HTMLIFrameElement> }> = ({ rev, onNews, frameRef }) => {
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    setLoading(true);
    let heard = false;
    const on = (e: MessageEvent) => {
      if (!frameRef.current || e.source !== frameRef.current.contentWindow || !e.data || e.data.kind !== 'hydra-aether-wiring') return;
      heard = true; setLoading(false); onNews(e.data as HydraNews);
    };
    window.addEventListener('message', on);
    const t = setTimeout(() => { if (!heard) onNews('old'); }, 15000);   // no answer yet: maybe a Hydra older than 1.8.0 (the frame stays; it may still answer)
    return () => { window.removeEventListener('message', on); clearTimeout(t); };
  }, [rev, onNews, frameRef]);
  return (
    <div className="relative" style={{ height: 560 }}>
      <iframe key={rev} ref={frameRef} title="Suggested wiring in Hydra" src={`${defaultBackend()}/api/blueprints/page?aetherWiring=view&r=${rev}`}
        className="w-full h-full block border-0 rounded-hv-xs" style={{ background: '#fff' }} />
      {loading && <div className="absolute inset-0 flex items-center justify-center gap-2 text-xs text-hv-text-3 bg-hv-widget-panel/80"><Loader2 size={14} className="animate-spin" />Hydra is drawing it…</div>}
    </div>
  );
};

// ── the card ────────────────────────────────────────────────────────────────
export const SuggestCard: React.FC<{ api: TraceApi; status: Status; onApplied: () => void }> = ({ api, status, onApplied }) => {
  const [s, setS] = useState<Suggestion | null>(null);
  const [disc, setDisc] = useState<DiscoverStatus | null>(null);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [onlyDiff, setOnlyDiff] = useState(true);
  const [msg, setMsg] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [opt, setOpt] = useState({ relays: true, readers: true, locks: false });
  const svgRef = useRef<SVGSVGElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const openRef = useRef<HTMLButtonElement | null>(null);
  const [rev, setRev] = useState(1);   // a new rev redraws Hydra's picture (after Discover or applying)
  const [hy, setHy] = useState<HydraNews | 'old' | null>(null);
  const [simple, setSimple] = useState(false);   // the hand-drawn simple picture: only on request, never by default
  const onNews = useCallback((n: HydraNews | 'old') => setHy(h => (n !== 'old' && n.switched && h && h !== 'old' ? { ...h, active: n.active } : n)), []);
  const showCtl = (id: string) => frameRef.current?.contentWindow?.postMessage({ kind: 'hydra-aether-show', controller: id }, '*');
  const admin = status.me?.admin !== false;
  const load = useCallback(() => Promise.all([api.suggest().then(setS), api.discoverStatus().then(r => setDisc(r.current))]).catch(e => setMsg({ tone: 'error', text: (e as Error).message })), [api]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!disc || disc.state !== 'running') return;
    const t = setInterval(() => api.discoverStatus().then(r => { setDisc(r.current); if (r.current && r.current.state === 'done') { api.suggest().then(setS); setRev(x => x + 1); } }).catch(() => {}), 1500);
    return () => clearInterval(t);
  }, [disc, api]);
  const rows = useMemo(() => (s ? s.rows.filter(r => !onlyDiff || r.differs) : []), [s, onlyDiff]);
  const doorName = (id: string | null) => (id && (status.inventory?.doors.find(d => d.id === id)?.name || id.slice(0, 8))) || '—';
  const start = async () => {
    setConfirm(false); setBusy('disc'); setMsg(null);
    try { const r = await api.discover({ relays: opt.relays ? [0, 1, 2, 3, 4, 5, 6, 7] : [], readers: opt.readers, locks: opt.locks }); setDisc(r.current); }
    catch (e) { setMsg({ tone: 'error', text: (e as Error).message }); } finally { setBusy(null); }
  };
  const apply = async () => {
    setBusy('apply'); setMsg(null);
    try { const r = await api.applySuggestion([...pick]); setPick(new Set()); await load(); setRev(x => x + 1); onApplied(); setMsg({ tone: 'success', text: `Applied ${r.applied.length}${r.skipped.length ? ` · ${r.skipped.length} owned by a door (change those on the Doors page)` : ''}` }); }
    catch (e) { setMsg({ tone: 'error', text: (e as Error).message }); } finally { setBusy(null); }
  };
  const activeCtl = hy && hy !== 'old' ? hy.active || null : null;
  const openHydra = () => openInHydra(openRef.current, activeCtl);
  const old = hy === 'old';
  const news = hy && hy !== 'old' ? hy : null;
  useEffect(() => { setSimple(false); }, [rev]);
  const running = disc && disc.state === 'running';
  return (
    <section id="trace-setup-suggest" className="rounded-hv-sm bg-hv-widget-panel ring-1 ring-hv-line p-4 space-y-3 scroll-mt-4">
      <div className="flex items-start gap-2">
        <Wand2 size={16} className="text-hv-brand mt-0.5" />
        <div className="flex-1">
          <div className="text-sm font-semibold text-hv-text">Suggested wiring</div>
          <div className="text-xs text-hv-text-3">What each Aether channel is wired to on the controller: <b>proved</b> by Discover, <b>configured</b> on the Doors page, or <b>seen</b> in normal testing — drawn by Hydra in its own project, "Aether wiring (Event Trace)".</div>
        </div>
        {simple && <>
          <Button size="sm" icon={<Download size={13} />} disabled={!s} onClick={() => downloadSvg(svgRef.current, 'aether-wiring', false)}>SVG</Button>
          <Button size="sm" icon={<Download size={13} />} disabled={!s} onClick={() => downloadSvg(svgRef.current, 'aether-wiring', true)}>PNG</Button>
        </>}
        {!old && <Button size="sm" tone="ghost" icon={<RefreshCw size={13} />} disabled={!s || !s.controllers.length} onClick={() => setRev(x => x + 1)} title="Draw it again from the latest suggestion">Redraw</Button>}
        <span ref={el => { openRef.current = el as unknown as HTMLButtonElement; }}>
          <Button size="sm" tone="primary" icon={<ExternalLink size={13} />} disabled={!s || !s.controllers.length} onClick={openHydra} title="Open this drawing in Integrations › Board Blueprints (Hydra) to edit, print or export it">Open in Hydra</Button>
        </span>
      </div>

      {/* Discover */}
      <div className="rounded-hv-xs ring-1 ring-inset ring-hv-line p-2 text-[12px] space-y-1.5">
        <div className="flex flex-wrap items-center gap-3">
          <Radar size={14} className="text-hv-text-3" /><span className="font-semibold text-hv-text">Discover</span>
          <span className="text-hv-text-3">prove it by moving it, one thing at a time</span>
          <Toggle on={opt.relays} onChange={v => setOpt({ ...opt, relays: v })} label="Pulse relays 1–8" />
          <Toggle on={opt.readers} onChange={v => setOpt({ ...opt, readers: v })} label="Card on each reader" />
          <Toggle on={opt.locks} onChange={v => setOpt({ ...opt, locks: v })} disabled={!status.settings.commands.enabled} label="Unlock each door (OnCAFE)" />
          <span className="ml-auto" />
          {running
            ? <Button size="sm" tone="danger-soft" icon={<Square size={12} />} onClick={() => api.stopDiscover().then(r => setDisc(r.current))}>Stop</Button>
            : <Button size="sm" tone="primary" icon={<Radar size={13} />} busy={busy === 'disc'} disabled={!admin || (!opt.relays && !opt.readers && !opt.locks)} onClick={() => setConfirm(true)}>Discover…</Button>}
        </div>
        {confirm && (
          <div className="rounded-hv-xs bg-hv-warning-tint text-hv-warning-fg px-2 py-1.5 flex flex-wrap items-center gap-2">
            <AlertTriangle size={13} />
            <span className="flex-1">This moves real hardware: {opt.relays ? 'each relay is switched for 2 s and back (doors may report open / forced / REX)' : ''}{opt.relays && (opt.readers || opt.locks) ? '; ' : ''}{opt.readers ? 'the first sync card is presented on every reader' : ''}{opt.locks ? '; each door under test is unlocked for 8 s through OnCAFE' : ''}. Alarms may be raised on the controller.</span>
            <Button size="sm" tone="primary" onClick={start}>Run Discover</Button><Button size="sm" tone="ghost" onClick={() => setConfirm(false)}>Cancel</Button>
          </div>
        )}
        {disc && (
          <div className="text-hv-text-2">
            {running ? <span className="inline-flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" />{disc.step} · {disc.done} of {disc.total}</span>
              : <>Last Discover {new Date(disc.at).toLocaleString()}{disc.aborted ? ' (stopped)' : ''}{disc.error ? <span className="text-hv-error-fg"> · {disc.error}</span> : ''}: </>}
            {disc.relays.filter(r => r.role).map(r => <Badge key={r.ch} tone="success" className="ml-1">{r.ch.replace('relay:', 'REL').replace(/\d+$/, n => String(+n + 1))} = {doorNameOf(r)} {ROLE_WORD[r.role!]}{r.active === 'closed' ? ' NC' : ''}</Badge>)}
            {disc.readers.map(r => <Badge key={r.ch} tone={r.door ? 'success' : 'neutral'} className="ml-1">{r.name} = {r.doorName || 'no decision'}</Badge>)}
            {disc.locks.map(l => <Badge key={l.door} tone={l.ch ? 'success' : 'neutral'} className="ml-1">{l.doorName} lock = {l.ch || (l.error || 'nothing turned on')}</Badge>)}
          </div>
        )}
      </div>

      {msg && <div className={cx('text-xs rounded-hv-xs px-2 py-1', msg.tone === 'error' ? 'bg-hv-error-tint text-hv-error-fg' : 'bg-hv-success-tint text-hv-success-fg')}>{msg.text}</div>}
      {!s ? <div className="text-xs text-hv-text-3 flex items-center gap-2"><Loader2 size={12} className="animate-spin" />Working it out…</div> : (
        <>
          {!s.controllers.length ? <Empty title="Nothing to draw yet">Run Discover, or set up doors on the Doors page, and the drawing appears here.</Empty> : simple ? (
            <>
              <div className="text-xs rounded-hv-xs px-2 py-1 bg-hv-warning-tint text-hv-warning-fg flex items-center gap-2"><span className="flex-1">Simple drawing (not Hydra's), shown because you asked for it.</span>
                <Button size="sm" tone="ghost" onClick={() => { setSimple(false); setHy(null); setRev(x => x + 1); }}>Back to Hydra's drawing</Button></div>
              <div className="rounded-hv-xs ring-1 ring-inset ring-hv-line overflow-hidden"><HydraDrawing s={s} wiegandIds={status.channels.wiegand.map(w => w.id)} svgRef={svgRef} /></div>
            </>
          ) : (
            <div className="space-y-1.5">
              {news && news.ok && (news.boards || []).length > 1 && (
                <div className="flex flex-wrap gap-1">{news.boards!.map(b => (
                  <Button key={b.controller} size="sm" tone={news.active === b.controller ? 'primary' : 'ghost'} onClick={() => showCtl(b.controller)}>{b.name.replace(/^C\d+ /, '')}</Button>))}</div>
              )}
              <div className="rounded-hv-xs ring-1 ring-inset ring-hv-line overflow-hidden"><HydraFrame rev={rev} onNews={onNews} frameRef={frameRef} /></div>
              {old && (
                <div className="text-xs rounded-hv-xs px-2 py-1.5 bg-hv-warning-tint text-hv-warning-fg flex flex-wrap items-center gap-2">
                  <AlertTriangle size={13} /><span className="flex-1">Hydra has not drawn it yet. This needs Hydra 1.8.0 or newer: open Integrations › Board Blueprints, Check for updates, then Redraw.</span>
                  <Button size="sm" tone="ghost" icon={<RefreshCw size={13} />} onClick={() => { setHy(null); setRev(x => x + 1); }}>Redraw</Button>
                  <Button size="sm" tone="ghost" onClick={() => setSimple(true)}>Show a simple drawing instead</Button>
                </div>
              )}
              {hy && hy !== 'old' && !hy.ok && <div className="text-xs rounded-hv-xs px-2 py-1 bg-hv-error-tint text-hv-error-fg">Hydra: {hy.error}</div>}
              {news && news.ok && (() => { const b = (news.boards || []).find(x => x.controller === news.active) || (news.boards || [])[0]; if (!b) return null; return (
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-hv-text-3">
                  <span>{b.wired} connection{b.wired === 1 ? '' : 's'} drawn</span>
                  {b.drawnAs && (!b.model || !/P\d00|IC2/i.test(b.model)) && <span className="text-hv-warning-fg">model {b.model || 'not known'}: drawn as an {b.drawnAs.toUpperCase().replace(/^P/, 'NHP-P')}{b.model ? '' : ' (connect Setup › OnCAFE so Aether knows the controller)'}</span>}
                  {b.guessed && <span className="text-hv-warning-fg">door numbers not known: doors are on ports 1, 2, … in name order</span>}
                  {b.unmapped > 0 && <span>{b.unmapped} not drawn (ADC, OSDP…): listed in the Aether device's note in Hydra</span>}
                </div>); })()}
            </div>
          )}
          <div className="flex items-center gap-3 text-[12px]">
            <span className="font-semibold text-hv-text-2">{s.rows.length} channels</span>
            {s.differs > 0 ? <Badge tone="warning">{s.differs} differ from Setup › Wiring</Badge> : <Badge tone="success">Setup › Wiring agrees</Badge>}
            <Toggle on={onlyDiff} onChange={setOnlyDiff} label="Only differences" />
            <span className="ml-auto" />
            <Button size="sm" icon={<Check size={13} />} busy={busy === 'apply'} disabled={!admin || !pick.size} onClick={apply}>Use the {pick.size || ''} picked</Button>
          </div>
          {!rows.length ? <Empty title={onlyDiff ? 'Nothing differs' : 'Nothing to suggest yet'}>{onlyDiff ? 'Every suggestion matches the wiring map.' : 'Run a test or Discover, or set up doors on the Doors page.'}</Empty> : (
            <table className="w-full text-[12px]"><thead><tr className="text-left text-hv-text-3"><th className="py-1 pr-2 w-6" /><th className="pr-2">Aether</th><th className="pr-2">Suggested</th><th className="pr-2">Now</th><th className="pr-2">How sure</th><th className="pr-2">Why</th></tr></thead><tbody>
              {rows.map((r: SuggestRow) => (
                <tr key={r.ch} className="border-t border-hv-line">
                  <td className="py-1 pr-2"><input type="checkbox" disabled={!r.differs || !admin} checked={pick.has(r.ch)} onChange={e => setPick(p => { const n = new Set(p); if (e.target.checked) n.add(r.ch); else n.delete(r.ch); return n; })} /></td>
                  <td className="pr-2 font-mono text-hv-text">{r.terminal.label}</td>
                  <td className="pr-2 text-hv-text">{ROLE_WORD[r.role] || r.role} · {doorName(r.door)}{r.active === 'closed' ? ' · NC' : ''}</td>
                  <td className="pr-2 text-hv-text-3">{r.current ? `${ROLE_WORD[r.current.role] || r.current.role}${r.current.door ? ' · ' + doorName(r.current.door) : ''}${r.current.active === 'closed' ? ' · NC' : ''}` : 'not mapped'}</td>
                  <td className="pr-2"><Badge tone={r.source === 'probe' ? 'success' : r.source === 'doors page' ? 'info' : 'neutral'}>{SRC_WORD[r.source]}</Badge></td>
                  <td className="pr-2 text-hv-text-3">{r.why[0]}</td>
                </tr>
              ))}
            </tbody></table>
          )}
        </>
      )}
    </section>
  );
};
const doorNameOf = (r: { doorName: string | null; door: string | null }) => r.doorName || (r.door ? r.door.slice(0, 8) : '?');
