// HAT Pinout: two pages.
//  1. Raspberry Pi 40-pin header: what each pin does in Aether (power, ground,
//     Wiegand readers 1-4 D0/D1 read live from the reader config, the I2C pair
//     that carries on to the Sequent board). The I2C pins open page 2.
//  2. Sequent IOplus board: every terminal group; channels Aether uses show
//     their name and live state, the rest are marked "not used by Aether".
// Colours: three validated hues (power orange, Wiegand blue, I2C aqua), ground
// neutral; every pin is also labelled, so colour never carries identity alone.
import React, { useEffect, useMemo, useState } from 'react';
import { ArrowRight, ArrowLeft, Cpu } from 'lucide-react';
import { T, Card } from './ui';

const C_POWER = 'rgb(var(--hv-brand))', C_WIEG = 'rgb(var(--hv-info-strong))', C_I2C = 'rgb(var(--hv-success))', C_GND = 'rgb(var(--hv-text-3))', C_OFF = 'rgb(var(--hv-line))';

// BCM GPIO -> physical pin
const GPIO_PIN: Record<number, number> = { 2: 3, 3: 5, 4: 7, 17: 11, 27: 13, 22: 15, 10: 19, 9: 21, 11: 23, 0: 27, 5: 29, 6: 31, 13: 33, 19: 35, 26: 37, 14: 8, 15: 10, 18: 12, 23: 16, 24: 18, 25: 22, 8: 24, 7: 26, 1: 28, 12: 32, 16: 36, 20: 38, 21: 40 };
const PIN_GPIO: Record<number, number> = Object.fromEntries(Object.entries(GPIO_PIN).map(([g, p]) => [p, Number(g)]));
const P5V = [2, 4], P3V3 = [1, 17], GND = [6, 9, 14, 20, 25, 30, 34, 39];

type Reader = { n: number; name: string; d0: number; d1: number };
type PinInfo = { kind: 'power' | 'gnd' | 'i2c' | 'seq' | 'wieg' | 'id' | 'free'; label: string; sub: string; color: string; group: string };

export default function PinoutPages({ api }: { api: string }) {
  const [page, setPage] = useState<'pi' | 'sequent'>('pi');
  return (
    <div className="space-y-4">
      <div className="inline-flex p-0.5 rounded-lg border" style={{ background: T.input, borderColor: T.line2 }}>
        {([['pi', 'Raspberry Pi header'], ['sequent', 'Sequent IOplus board']] as const).map(([k, l]) => (
          <button key={k} onClick={() => setPage(k)} className="px-4 py-1.5 rounded-md text-sm font-semibold"
            style={page === k ? { background: 'rgb(var(--hv-popup-panel))', color: T.text, boxShadow: `inset 0 -2px 0 ${T.amber}` } : { color: T.dim }}>{l}</button>
        ))}
      </div>
      {page === 'pi' ? <PiHeader api={api} onSequent={() => setPage('sequent')} /> : <SequentBoard api={api} onPi={() => setPage('pi')} />}
    </div>
  );
}

// ─────────────────────────────── Raspberry Pi ───────────────────────────────
function PiHeader({ api, onSequent }: { api: string; onSequent: () => void }) {
  const [readers, setReaders] = useState<Reader[]>([]);
  const [hover, setHover] = useState<string | null>(null);
  useEffect(() => {
    // /api/wiegand/readers is what the Wiegand manager actually drives (wiegand-config.json).
    // /api/wiegand/config is an older fixed 2-door list, used only as a fallback.
    (async () => {
      try {
        const j = await (await fetch(`${api}/api/wiegand/readers`)).json();
        const list = (j?.readers || []).filter((r: any) => r.enabled !== false)
          .map((r: any) => ({ name: r.name, door: r.door, d0: (r.txPins || r.pins || r.gpio || {}).d0, d1: (r.txPins || r.pins || r.gpio || {}).d1 }))
          .filter((r: any) => Number.isInteger(r.d0) && Number.isInteger(r.d1))
          .sort((a: any, b: any) => (a.door ?? 0) - (b.door ?? 0)).slice(0, 4);
        if (list.length) { setReaders(list.map((r: any, i: number) => ({ n: i + 1, name: r.name || `Reader ${i + 1}`, d0: r.d0, d1: r.d1 }))); return; }
      } catch { /* fall back */ }
      try {
        const j = await (await fetch(`${api}/api/wiegand/config`)).json();
        const list = (j?.doors || []).filter((d: any) => Number.isInteger(d.d0) && Number.isInteger(d.d1)).slice(0, 4);
        setReaders(list.map((d: any, i: number) => ({ n: i + 1, name: d.name || `Reader ${i + 1}`, d0: d.d0, d1: d.d1 })));
      } catch { setReaders([]); }
    })();
  }, [api]);

  const pins = useMemo(() => {
    const m: Record<number, PinInfo> = {};
    P5V.forEach(p => m[p] = { kind: 'power', label: '5V', sub: 'power', color: C_POWER, group: 'power' });
    P3V3.forEach(p => m[p] = { kind: 'power', label: '3.3V', sub: 'power', color: C_POWER, group: 'power' });
    GND.forEach(p => m[p] = { kind: 'gnd', label: 'GND', sub: 'ground', color: C_GND, group: 'gnd' });
    m[3] = { kind: 'i2c', label: 'SDA', sub: 'GPIO 2 · I2C data → Sequent', color: C_I2C, group: 'i2c' };
    m[5] = { kind: 'i2c', label: 'SCL', sub: 'GPIO 3 · I2C clock → Sequent', color: C_I2C, group: 'i2c' };
    m[37] = { kind: 'seq', label: 'GPB', sub: 'GPIO 26 · Sequent pushbutton', color: C_I2C, group: 'i2c' };
    m[8] = { kind: 'seq', label: 'TXD', sub: 'GPIO 14 · RS-485 TX → Sequent (/dev/ttyAMA0)', color: C_I2C, group: 'i2c' };
    m[10] = { kind: 'seq', label: 'RXD', sub: 'GPIO 15 · RS-485 RX ← Sequent (/dev/ttyAMA0)', color: C_I2C, group: 'i2c' };
    m[27] = { kind: 'id', label: 'ID_SD', sub: 'GPIO 0 · HAT ID (reserved)', color: C_OFF, group: 'id' };
    m[28] = { kind: 'id', label: 'ID_SC', sub: 'GPIO 1 · HAT ID (reserved)', color: C_OFF, group: 'id' };
    for (const r of readers) {
      const p0 = GPIO_PIN[r.d0], p1 = GPIO_PIN[r.d1];
      if (p0) m[p0] = { kind: 'wieg', label: `R${r.n} D0`, sub: `GPIO ${r.d0} · ${r.name}`, color: C_WIEG, group: `r${r.n}` };
      if (p1) m[p1] = { kind: 'wieg', label: `R${r.n} D1`, sub: `GPIO ${r.d1} · ${r.name}`, color: C_WIEG, group: `r${r.n}` };
    }
    for (let p = 1; p <= 40; p++) if (!m[p]) m[p] = { kind: 'free', label: `GPIO ${PIN_GPIO[p]}`, sub: 'not used', color: C_OFF, group: 'free' };
    return m;
  }, [readers]);

  const lit = (i: PinInfo) => !hover || hover === i.group || (hover === 'wieg' && i.kind === 'wieg');
  const Label = ({ p, side }: { p: number; side: 'l' | 'r' }) => {
    const i = pins[p];
    const off = i.kind === 'free' || i.kind === 'id';
    const click = i.kind === 'i2c' || i.kind === 'seq' ? onSequent : undefined;
    return (
      <button type="button" onClick={click} onMouseEnter={() => setHover(i.group)} onMouseLeave={() => setHover(null)} disabled={!click}
        className={`w-full flex items-center gap-2 min-w-0 h-full ${side === 'l' ? 'justify-end text-right' : 'justify-start text-left'} ${click ? 'cursor-pointer' : 'cursor-default'}`}
        style={{ opacity: lit(i) ? 1 : 0.25, transition: 'opacity 120ms' }} title={click ? `${i.sub} · open the Sequent board` : i.sub}>
        {side === 'r' && <span className="w-5 h-px shrink-0" style={{ background: off ? 'transparent' : i.color }} />}
        <span className={`min-w-0 ${side === 'l' ? 'order-first' : ''}`}>
          <span className="block text-[12px] font-bold leading-tight truncate" style={{ color: off ? T.faint : T.text }}>
            {i.label}{(i.kind === 'i2c' || i.kind === 'seq') && <ArrowRight size={11} className="inline ml-1" style={{ color: C_I2C }} />}
          </span>
          <span className="block text-[10px] leading-tight truncate" style={{ color: off ? 'rgb(var(--hv-modal))' : T.dim }}>{i.sub}</span>
        </span>
        {side === 'l' && <span className="w-5 h-px shrink-0" style={{ background: off ? 'transparent' : i.color }} />}
      </button>
    );
  };
  const Pin = ({ p }: { p: number }) => {
    const i = pins[p]; const off = i.kind === 'free' || i.kind === 'id';
    return (
      <span onMouseEnter={() => setHover(i.group)} onMouseLeave={() => setHover(null)} onClick={i.kind === 'i2c' || i.kind === 'seq' ? onSequent : undefined}
        className={`w-[22px] h-[22px] ${p === 1 ? 'rounded-[4px]' : 'rounded-full'} flex items-center justify-center text-[9px] font-bold font-mono ${i.kind === 'i2c' || i.kind === 'seq' ? 'cursor-pointer' : ''}`}
        title={`Pin ${p}: ${i.label} · ${i.sub}`}
        style={{ background: off ? 'rgb(var(--hv-widget))' : i.color, color: off ? 'rgb(var(--hv-text-3))' : 'rgb(var(--hv-text))', border: `2px solid ${off ? 'rgb(var(--hv-line))' : 'rgb(var(--hv-surface))'}`, opacity: lit(i) ? 1 : 0.25, boxShadow: hover === i.group && !off ? `0 0 10px ${i.color}` : 'none' }}>
        {p}
      </span>
    );
  };

  const groups = [
    { id: 'power', color: C_POWER, title: 'Power', body: <>5V on pins 2 and 4, 3.3V on pins 1 and 17. The stacking header carries them up to the Sequent board.</> },
    { id: 'gnd', color: C_GND, title: 'Ground', body: <>Pins {GND.join(', ')}. Common ground for the readers and the Sequent board.</> },
    { id: 'i2c', color: C_I2C, title: 'Sequent board', body: <>Pin 3 SDA (GPIO 2) and pin 5 SCL (GPIO 3) continue through the header to the Home Automation card at I2C address 0x28; every relay, input and analog channel goes over these two wires. The Pi's UART on pin 8 (TXD, GPIO 14) and pin 10 (RXD, GPIO 15) drives the card's RS-485 port (TX/RX-EN on), which Aether uses as <span className="font-mono">/dev/ttyAMA0</span> for the OSDP bus. The card's pushbutton is on GPIO 26 (pin 37).</>, action: <button onClick={onSequent} className="mt-2 inline-flex items-center gap-1 text-xs font-semibold underline" style={{ color: 'rgb(var(--hv-success-text))' }}>Open the Sequent board <ArrowRight size={12} /></button> },
    ...readers.map(r => ({ id: `r${r.n}`, color: C_WIEG, title: `Wiegand reader ${r.n}`, body: <>D0 on GPIO {r.d0} (pin {GPIO_PIN[r.d0] ?? '?'}), D1 on GPIO {r.d1} (pin {GPIO_PIN[r.d1] ?? '?'}). <span style={{ color: T.dim }}>{r.name}</span></> })),
  ];

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
      <Card title="Raspberry Pi 5 · 40-pin header" right={<span className="text-xs" style={{ color: T.dim }}>pin 1 is the square pad, next to the SD card end</span>}>
        <div className="mx-auto max-w-[720px] grid grid-cols-[minmax(0,1fr)_64px_minmax(0,1fr)] gap-x-2">
          {Array.from({ length: 20 }, (_, r) => {
            const odd = 2 * r + 1, even = 2 * r + 2;
            return (
              <React.Fragment key={r}>
                <div className="h-[34px]"><Label p={odd} side="l" /></div>
                <div className="h-[34px] flex items-center justify-center gap-[6px] px-1.5" style={{ background: 'rgb(var(--hv-surface))', borderLeft: '1px solid rgb(var(--hv-popup-panel))', borderRight: '1px solid rgb(var(--hv-popup-panel))', borderTop: r === 0 ? '1px solid rgb(var(--hv-popup-panel))' : undefined, borderBottom: r === 19 ? '1px solid rgb(var(--hv-popup-panel))' : undefined, borderRadius: r === 0 ? '6px 6px 0 0' : r === 19 ? '0 0 6px 6px' : undefined }}>
                  <Pin p={odd} /><Pin p={even} />
                </div>
                <div className="h-[34px]"><Label p={even} side="r" /></div>
              </React.Fragment>
            );
          })}
        </div>
      </Card>

      <div className="space-y-3">
        {groups.map(g => (
          <div key={g.id} onMouseEnter={() => setHover(g.id)} onMouseLeave={() => setHover(null)}
            className="rounded-xl border px-4 py-3 transition-colors" style={{ background: hover === g.id ? 'rgb(var(--hv-contrast) / 0.04)' : T.panel, borderColor: hover === g.id ? g.color : T.line2 }}>
            <div className="flex items-center gap-2 text-sm font-bold" style={{ color: T.text }}><span className="w-3 h-3 rounded-full" style={{ background: g.color }} />{g.title}</div>
            <p className="text-xs mt-1 leading-relaxed" style={{ color: T.text2 }}>{g.body}</p>
            {'action' in g && g.action}
          </div>
        ))}
        <p className="text-[11px] px-1" style={{ color: T.dim }}>Wiegand pins come from the reader configuration on the Readers page, so this drawing always matches it. Every other GPIO is free.</p>
      </div>
    </div>
  );
}

// ─────────────────────────────── Sequent board ───────────────────────────────
// Drawn to scale from Sequent's 2D drawing (HomeAutomationCard-2D.DXF, mm, y up).
// Terminal order from the board layout in the Home Automation user's guide V5.
type Term = { id: string; label: string; x: number; y: number; edge: 'l' | 'r' | 'b'; kind: 'relay' | 'com' | 'opto' | 'adc' | 'dac' | 'od' | 'gnd' | 'pwr' | 'aux' | 'rs485'; ch?: number };
const L_Y = [53.6, 50.1, 46.6, 43.1, 39.6, 35.0, 31.5, 28.0, 24.5, 21.0, 16.3, 12.8, 9.3, 5.8, 2.3];
const L_T: [string, Term['kind'], number?][] = [['+5V', 'pwr'], ['1-WIRE', 'aux'], ['GND', 'gnd'], ['485-B', 'rs485'], ['485-A', 'rs485'],
  ['REL1-NO', 'relay', 1], ['REL2-NO', 'relay', 2], ['REL3-NO', 'relay', 3], ['REL4-NO', 'relay', 4], ['1-4 COM', 'com'],
  ['OPTO-1', 'opto', 1], ['OPTO-2', 'opto', 2], ['OPTO-3', 'opto', 3], ['OPTO-4', 'opto', 4], ['GND', 'gnd']];
const R_Y = [53.6, 50.1, 46.6, 43.1, 39.6, 34.9, 31.4, 27.9, 24.5, 20.9, 16.3, 12.8, 9.3, 5.8, 2.3];
const R_T: [string, Term['kind'], number?][] = [['GND', 'gnd'], ['O.D.-1', 'od', 1], ['O.D.-2', 'od', 2], ['O.D.-3', 'od', 3], ['O.D.-4', 'od', 4],
  ['5-8 COM', 'com'], ['REL8-NO', 'relay', 8], ['REL7-NO', 'relay', 7], ['REL6-NO', 'relay', 6], ['REL5-NO', 'relay', 5],
  ['GND', 'gnd'], ['OPTO-8', 'opto', 8], ['OPTO-7', 'opto', 7], ['OPTO-6', 'opto', 6], ['OPTO-5', 'opto', 5]];
const B_X = [8.5, 12.0, 15.5, 19.0, 22.5, 27.2, 30.7, 34.2, 37.7, 41.2, 52.9, 56.4, 66.3, 69.8, 73.3, 76.8, 80.3];
const B_T: [string, Term['kind'], number?][] = [['GND', 'gnd'], ['ADC-8', 'adc', 8], ['ADC-7', 'adc', 7], ['ADC-6', 'adc', 6], ['ADC-5', 'adc', 5],
  ['GND', 'gnd'], ['ADC-4', 'adc', 4], ['ADC-3', 'adc', 3], ['ADC-2', 'adc', 2], ['ADC-1', 'adc', 1],
  ['+5V', 'pwr'], ['GND', 'gnd'], ['GND', 'gnd'], ['DAC-4', 'dac', 4], ['DAC-3', 'dac', 3], ['DAC-2', 'dac', 2], ['DAC-1', 'dac', 1]];
const TERMS: Term[] = [
  ...L_T.map(([label, kind, ch], i) => ({ id: `l${i}`, label, kind, ch, x: -3.2, y: L_Y[i], edge: 'l' as const })),
  ...R_T.map(([label, kind, ch], i) => ({ id: `r${i}`, label, kind, ch, x: 86.8, y: R_Y[i], edge: 'r' as const })),
  ...B_T.map(([label, kind, ch], i) => ({ id: `b${i}`, label, kind, ch, x: B_X[i], y: 3.2, edge: 'b' as const })),
];
const HEADER_X = [8.29, 10.83, 13.37, 15.91, 18.45, 20.99, 23.53, 26.07, 28.61, 31.15, 33.69, 36.23, 38.77, 41.31, 43.85, 46.39, 48.93, 51.47, 54.01, 56.55];
const RELAYS = [[0.8, 16.3, 20, 32.3], [0.8, 32.6, 20, 48.5], [20.2, 10, 36.2, 29.2], [20.2, 29.4, 36.2, 48.6], [44.6, 10, 60.5, 29.2], [44.6, 29.4, 60.5, 48.6], [60.7, 16.3, 79.9, 32.3], [60.7, 32.6, 79.9, 48.5]];
const LED_L = [34.05, 30.1, 26.2, 22.3];   // REL1..4, next to their terminals
const LED_R = [33.9, 29.95, 26.05, 22.1];  // REL8..5

// SVG layout
const S = 8, OX = 452, OY = 96, BH = 56;
const px = (x: number) => OX + x * S, py = (y: number) => OY + (BH - y) * S;
const W = 1600, H = 990;
const SIDE_W = 262;
const isPower = (t: Term) => t.kind === 'gnd' || t.kind === 'pwr';

function SequentBoard({ api, onPi }: { api: string; onPi: () => void }) {
  const [relays, setRelays] = useState<number[]>([]);
  const [optos, setOptos] = useState<number[]>([]);
  const [zones, setZones] = useState<Record<number, { v: number; state: string }>>({});
  const [dac, setDac] = useState<number[]>([]);
  const [names, setNames] = useState<{ relay: Record<number, string[]>; opto: Record<number, string[]>; analog: Record<number, string[]>; relayIO: Record<number, string> }>({ relay: {}, opto: {}, analog: {}, relayIO: {} });
  const [hat, setHat] = useState<any>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [bus, setBus] = useState<{ readers: string[]; emulator: boolean; port: string }>({ readers: [], emulator: false, port: '/dev/ttyAMA0' });

  useEffect(() => {
    (async () => {
      const relay: Record<number, string[]> = {}, opto: Record<number, string[]> = {}, analog: Record<number, string[]> = {}, relayIO: Record<number, string> = {};
      const add = (m: Record<number, string[]>, n: number, s: string) => { if (n >= 1 && n <= 8) (m[n] ||= []).push(s); };
      try {
        const d = (await (await fetch(`${api}/api/doors/config`)).json())?.config;
        for (const door of d?.doors || []) {
          if (door.enabled === false || (door.ioSource && door.ioSource !== 'physical')) continue;
          if (door.lock?.channel != null) add(relay, door.lock.channel + 1, `${door.name} strike`);
          for (const [io, lbl] of [[door.dps, 'DPS'], [door.rexIn, 'REX']] as const) {
            if (io?.channel == null) continue;
            (io.hardwareType === 'analog' ? add(analog, io.channel + 1, `${door.name} ${lbl}`) : add(opto, io.channel + 1, `${door.name} ${lbl}`));
          }
        }
        const so = d?.systemOutputs || {};
        for (const [k, l] of [['powerFault', 'Power fault'], ['batteryFault', 'Battery fault'], ['tamper', 'Tamper'], ['fai', 'Fire alarm']] as const)
          if (so[k]?.channel >= 0) add(relay, so[k].channel + 1, l);
      } catch { /* */ }
      try {
        const el = JSON.parse(localStorage.getItem('aether.elevator.v2') || 'null');
        for (const f of el?.floors || []) {
          if (f.relay > 0) add(relay, f.relay, `Elevator F${f.id} tracking`);
          if (f.input > 0) (el.inputType === 'analog' ? add(analog, f.input, `Elevator F${f.id} grant`) : add(opto, f.input, `Elevator F${f.id} grant`));
        }
      } catch { /* */ }
      try {
        const app = (await (await fetch(`${api}/api/config/app`)).json())?.config;
        for (const o of app?.outputs || []) (o.inputType === 'analog' ? add(analog, o.channel + 1, o.name) : add(opto, o.channel + 1, o.name));
        for (const i of app?.inputs || []) if (i.channel >= 0 && i.channel < 8) relayIO[i.channel + 1] = i.name;
      } catch { /* */ }
      setNames({ relay, opto, analog, relayIO });
    })();
  }, [api]);

  useEffect(() => {
    let stop = false;
    const fast = () => Promise.all([
      fetch(`${api}/api/gpio/status`).then(r => r.json()).then(g => {
        if (!stop && g?.relays) { setRelays(g.relays.map((r: any) => r.state)); setOptos(g.inputs.map((r: any) => r.state)); }
      }).catch(() => { /* */ }),
      fetch(`${api}/api/supervision/status`).then(r => r.json()).then(s => {
        const z: Record<number, { v: number; state: string }> = {};
        for (const zone of s?.boards?.[0]?.zones || []) z[zone.channel] = { v: zone.voltage, state: zone.state };
        if (!stop) setZones(z);
      }).catch(() => { /* */ }),
    ]);
    const slow = async () => {
      try { const j = await (await fetch(`${api}/api/gpio/dac`)).json(); if (!stop && j?.channels) setDac(j.channels.map((c: any) => c.voltage)); } catch { /* */ }
      try { const j = await (await fetch(`${api}/api/system/info`)).json(); if (!stop) setHat(j?.hat || null); } catch { /* */ }
      try {
        const port = '/dev/ttyAMA0';
        const [r, e] = await Promise.all([
          fetch(`${api}/api/osdp/readers`).then(x => x.json()).catch(() => null),
          fetch(`${api}/api/emulator/status`).then(x => x.json()).catch(() => null),
        ]);
        const readers = (r?.readers || []).filter((x: any) => (x.serialPort || port) === port && x.enabled !== false).map((x: any) => x.name || `Reader ${x.address}`);
        if (!stop) setBus({ readers, emulator: !!(e?.status?.running && e.status.port === port), port });
      } catch { /* */ }
    };
    fast(); slow();
    const a = setInterval(fast, 4000), b = setInterval(slow, 15000);
    return () => { stop = true; clearInterval(a); clearInterval(b); };
  }, [api]);

  const zoneColor = (s?: string) => s === 'ALARM' ? T.amber : s === 'TAMPER' || s === 'ERROR' ? T.crit : s === 'TROUBLE' ? T.warn : s === 'NORMAL' ? T.green : T.dim;

  // What each terminal shows
  const info = (t: Term): { title: string; name?: string; state?: string; on?: boolean; color: string; used: boolean; clash?: boolean; compact: boolean } => {
    switch (t.kind) {
      case 'relay': { const who = names.relay[t.ch!] || [], io = names.relayIO[t.ch!], on = !!relays[t.ch! - 1];
        return { title: `REL${t.ch} · NO`, name: who.length ? who.join(' · ') : io, state: on ? 'ON' : 'off', on, color: T.green, used: true, clash: who.length > 1, compact: false }; }
      case 'opto': { const who = names.opto[t.ch!] || [], on = !!optos[t.ch! - 1];
        return { title: `OPTO ${t.ch}`, name: who.join(' · ') || undefined, state: on ? 'active' : 'idle', on, color: T.teal, used: who.length > 0, compact: false }; }
      case 'adc': { const z = zones[t.ch!], who = names.analog[t.ch!] || [];
        return { title: `ADC ${t.ch} · 0–3.3 V`, name: who.join(' · ') || 'EOL zone', state: z ? `${(z.v / 1000).toFixed(2)} V · ${z.state.toLowerCase()}` : '—', on: !!z && z.state !== 'NORMAL', color: zoneColor(z?.state), used: true, compact: false }; }
      case 'dac': { const v = dac[t.ch! - 1];
        return { title: `DAC ${t.ch} · 0–10 V`, name: 'Analog output', state: v != null ? `${v.toFixed(2)} V` : '—', on: !!v, color: T.amber, used: true, compact: false }; }
      case 'rs485': {
        const active = bus.emulator || bus.readers.length > 0;
        return { title: `RS-485 ${t.label.endsWith('A') ? 'A (+)' : 'B (−)'}`, name: `OSDP bus · ${bus.port}`,
          state: bus.emulator ? 'Controller Emulator' : bus.readers.length ? `${bus.readers.length} reader${bus.readers.length > 1 ? 's' : ''}` : 'idle',
          on: active, color: T.blue, used: true, compact: false };
      }
      case 'od': return { title: `O.D. ${t.ch}`, name: 'not used by Aether', color: T.dim, used: false, compact: false };
      case 'com': return { title: t.label, name: 'common for 4 relays', color: T.dim, used: true, compact: true };
      case 'gnd': return { title: 'GND', color: T.dim, used: false, compact: true };
      case 'pwr': return { title: '+5V', color: 'rgb(var(--hv-brand-fg))', used: true, compact: true };
      default: return { title: t.label, name: t.label.startsWith('485') ? 'RS-485 (not used)' : 'not used', color: T.dim, used: false, compact: true };
    }
  };

  // Callout placement: side columns stack top→bottom; bottom row spreads left→right
  const cards = useMemo(() => {
    const out: { t: Term; x: number; y: number; w: number; h: number }[] = [];
    // GND / +5V get a small tag beside their terminal instead of a card
    const col = (edge: 'l' | 'r', x: number) => {
      const list = TERMS.filter(q => q.edge === edge && !isPower(q));
      const hs = list.map(t => (info(t).compact ? 24 : 46)), gap = 10;
      const total = hs.reduce((a, b) => a + b, 0) + gap * (list.length - 1);
      let y = Math.max(14, py(28) - total / 2);
      list.forEach((t, k) => { out.push({ t, x, y, w: SIDE_W, h: hs[k] }); y += hs[k] + gap; });
    };
    col('l', 16); col('r', W - 16 - SIDE_W);
    const bt = TERMS.filter(q => q.edge === 'b' && !isPower(q));
    const cw = 104, gap = 10;
    let x = (W - (cw * bt.length + gap * (bt.length - 1))) / 2;
    bt.forEach(t => { out.push({ t, x, y: 836, w: cw, h: 128 }); x += cw + gap; });
    return out;
  }, [names, relays, optos, zones, dac, bus]); // eslint-disable-line react-hooks/exhaustive-deps

  const lit = (id: string) => !hover || hover === id;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={onPi} className="inline-flex items-center gap-1.5 text-sm font-semibold px-3 py-1.5 rounded-md border" style={{ borderColor: T.line2, color: T.text2 }}><ArrowLeft size={14} />Raspberry Pi header</button>
        <span className="text-xs" style={{ color: T.dim }}>
          I2C 0x28{hat?.firmware ? ` · hardware ${hat.hardware} · firmware ${hat.firmware}` : ''}
        </span>
      </div>

      <div className="rounded-xl border overflow-x-auto" style={{ background: T.panel, borderColor: T.line2 }}>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[1000px]" role="img" aria-label="I/O board with its terminals">
          <defs>
            <linearGradient id="pcb" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="rgb(var(--hv-success-hover))" /><stop offset="1" stopColor="rgb(var(--hv-success-tint-strong))" /></linearGradient>
          </defs>

          {/* Leaders (under everything) */}
          {cards.map(({ t, x, y, w, h }) => {
            const i = info(t), tx = px(t.x), ty = py(t.y);
            let d: string;
            if (t.edge === 'l') { const cx = x + w, cy = y + h / 2; d = `M${cx},${cy} H${cx + 14} L${tx - 64},${ty} H${tx}`; }
            else if (t.edge === 'r') { const cx = x, cy = y + h / 2; d = `M${cx},${cy} H${cx - 14} L${tx + 64},${ty} H${tx}`; }
            else { const cx = x + w / 2, cy = y; d = `M${cx},${cy} V${cy - 30} L${tx},${ty + 70} V${ty}`; }
            const strong = hover === t.id || (i.on && i.used);
            return <path key={`l-${t.id}`} d={d} fill="none" stroke={hover === t.id ? T.text : strong ? i.color : i.used ? 'rgb(var(--hv-line-strong))' : 'rgb(var(--hv-line))'}
              strokeWidth={hover === t.id ? 2 : 1.25} opacity={lit(t.id) ? 1 : 0.2} strokeLinejoin="round" />;
          })}

          {/* Board */}
          <g>
            <rect x={px(0.7)} y={py(56)} width={(82.9 - 0.7) * S} height={56 * S} rx={10} fill="url(#pcb)" stroke="rgb(var(--hv-success-tint))" strokeWidth={2} />
            {[[3.45, 3.54], [61.45, 3.54], [3.45, 52.54], [61.45, 52.54]].map(([x, y], k) => (
              <g key={k}><circle cx={px(x)} cy={py(y)} r={2.5 * S} fill="rgb(var(--hv-warning))" /><circle cx={px(x)} cy={py(y)} r={1.5 * S} fill="rgb(var(--hv-widget-panel))" /></g>
            ))}
            {/* 40-pin header -> Raspberry Pi */}
            <g onClick={onPi} style={{ cursor: 'pointer' }}>
              <title>Header · click to open the Raspberry Pi pinout</title>
              <rect x={px(7.1)} y={py(55.1)} width={(57.9 - 7.1) * S} height={5.1 * S} rx={3} fill="rgb(var(--hv-surface))" stroke="rgb(var(--hv-line))" />
              {HEADER_X.flatMap(x => [51.23, 53.77].map(y => <rect key={`${x}-${y}`} x={px(x) - 4} y={py(y) - 4} width={8} height={8} rx={1.5} fill="rgb(var(--hv-warning))" />))}
            </g>
            {/* reserved header + button */}
            <rect x={px(65.2)} y={py(55.3)} width={9.8 * S} height={5.1 * S} rx={3} fill="rgb(var(--hv-surface))" stroke="rgb(var(--hv-line))" />
            {[66.36, 68.9, 71.44, 73.98].flatMap(x => [51.44, 53.98].map(y => <circle key={`${x}${y}`} cx={px(x)} cy={py(y)} r={3.5} fill="rgb(var(--hv-warning))" />))}
            <rect x={px(76.8)} y={py(55.4)} width={4.9 * S} height={4.3 * S} rx={3} fill="rgb(var(--hv-popup-panel))" stroke="rgb(var(--hv-modal))" />
            <circle cx={px(79.25)} cy={py(53.25)} r={9} fill="rgb(var(--hv-line-strong))" />
            {/* relays */}
            {RELAYS.map(([x1, y1, x2, y2], k) => (
              <g key={k}><rect x={px(x1)} y={py(y2)} width={(x2 - x1) * S} height={(y2 - y1) * S} rx={4} fill="rgb(var(--hv-widget-panel))" stroke="rgb(var(--hv-popup-panel))" />
                <text x={px((x1 + x2) / 2)} y={py((y1 + y2) / 2) + 4} textAnchor="middle" fontSize={11} fill="rgb(var(--hv-line-strong))" fontWeight={700}>RELAY</text></g>
            ))}
            {/* stack-ID jumpers */}
            <rect x={px(37.2)} y={py(42.3)} width={5.1 * S} height={7.3 * S} rx={2} fill="rgb(var(--hv-surface))" />
            {[38.49, 41.03].flatMap(x => [36.16, 38.7, 41.24].map(y => <circle key={`${x}${y}`} cx={px(x)} cy={py(y)} r={3.5} fill="rgb(var(--hv-warning))" />))}
            <text x={px(39.75)} y={py(34)} textAnchor="middle" fontSize={10} fill="rgb(var(--hv-success-text))">STACK ID</text>
            {/* board label + chip */}
            <text x={px(40.5)} y={py(8.6) + 5} textAnchor="middle" fontSize={15} fill="rgb(var(--hv-success-text))" fontWeight={800} letterSpacing={6}>AETHER</text>
            {/* terminal blocks */}
            {[[-6.5, 37.4, 0.7, 55.9], [-6.5, 18.7, 0.7, 37.3], [-6.5, 0.1, 0.7, 18.6], [82.9, 37.3, 90, 55.8], [82.9, 18.7, 90, 37.3], [82.9, 0, 90, 18.6],
              [6.2, 0, 24.8, 7.2], [24.9, 0, 43.5, 7.2], [50.6, 0, 58.8, 7.2], [64.1, 0, 82.6, 7.2]].map(([x1, y1, x2, y2], k) => (
              <rect key={k} x={px(x1)} y={py(y2)} width={(x2 - x1) * S} height={(y2 - y1) * S} rx={3} fill="rgb(var(--hv-success))" stroke="rgb(var(--hv-success-strong))" />
            ))}
            {TERMS.map(t => {
              const i = info(t);
              return (
                <g key={t.id} onMouseEnter={() => setHover(t.id)} onMouseLeave={() => setHover(null)} opacity={lit(t.id) ? 1 : 0.35}>
                  <title>{`${t.label}${i.name ? ` · ${i.name}` : ''}${i.state ? ` · ${i.state}` : ''}`}</title>
                  <circle cx={px(t.x)} cy={py(t.y)} r={9.5} fill="rgb(var(--hv-success-strong))" stroke={hover === t.id ? 'rgb(var(--hv-text))' : i.on && i.used ? i.color : 'rgb(var(--hv-success-hover))'} strokeWidth={hover === t.id || (i.on && i.used) ? 2.5 : 1.5} />
                  <line x1={px(t.x) - 5} y1={py(t.y) - 5} x2={px(t.x) + 5} y2={py(t.y) + 5} stroke="rgb(var(--hv-success-tint-strong))" strokeWidth={2} />
                </g>
              );
            })}
            {/* relay LEDs light with their relay */}
            {LED_L.map((y, k) => { const on = !!relays[k]; return <rect key={`ll${k}`} x={px(-5.5)} y={py(y) - 6} width={7} height={12} rx={2} fill={on ? 'rgb(var(--hv-error))' : 'rgb(var(--hv-error-tint))'} style={on ? { filter: 'drop-shadow(0 0 5px rgb(var(--hv-error)))' } : undefined}><title>REL{k + 1} LED</title></rect>; })}
            {LED_R.map((y, k) => { const on = !!relays[7 - k]; return <rect key={`lr${k}`} x={px(88.2)} y={py(y) - 6} width={7} height={12} rx={2} fill={on ? 'rgb(var(--hv-error))' : 'rgb(var(--hv-error-tint))'} style={on ? { filter: 'drop-shadow(0 0 5px rgb(var(--hv-error)))' } : undefined}><title>REL{8 - k} LED</title></rect>; })}
            {/* GND / +5V tags right beside their terminals */}
            {TERMS.filter(isPower).map(t => {
              const tx = px(t.x), ty = py(t.y), five = t.kind === 'pwr';
              const w = t.edge === 'b' ? 25 : 36, h = 18;
              const x = t.edge === 'l' ? px(-6.5) - 4 - w : t.edge === 'r' ? px(90) + 4 : tx - w / 2;
              const y = t.edge === 'b' ? py(0) + 4 : ty - h / 2;
              return (
                <g key={`p-${t.id}`} onMouseEnter={() => setHover(t.id)} onMouseLeave={() => setHover(null)} opacity={lit(t.id) ? 1 : 0.35}>
                  <title>{five ? '+5 V supply' : 'Ground'}</title>
                  <rect x={x} y={y} width={w} height={h} rx={4} fill="rgb(var(--hv-widget-panel))" stroke={hover === t.id ? T.text : five ? 'rgb(var(--hv-brand-hover))' : 'rgb(var(--hv-line))'} />
                  <text x={x + w / 2} y={y + 13} textAnchor="middle" fontSize={t.edge === 'b' ? 8.5 : 10} fontWeight={700} fill={five ? 'rgb(var(--hv-brand-text))' : 'rgb(var(--hv-text-3))'}>{five ? '+5V' : 'GND'}</text>
                </g>
              );
            })}
          </g>

          {/* Callout cards */}
          {cards.map(({ t, x, y, w, h }) => {
            const i = info(t);
            const border = hover === t.id ? T.text : i.clash ? T.crit : i.on && i.used ? i.color : i.used ? 'rgb(var(--hv-modal))' : 'rgb(var(--hv-popup-panel))';
            const txtMain = i.used ? T.text : 'rgb(var(--hv-text-3))';
            return (
              <g key={`c-${t.id}`} onMouseEnter={() => setHover(t.id)} onMouseLeave={() => setHover(null)} opacity={lit(t.id) ? 1 : 0.3} style={{ cursor: 'default' }}>
                <title>{`${t.label}${i.name ? ` · ${i.name}` : ''}${i.state ? ` · ${i.state}` : ''}`}</title>
                <rect x={x} y={y} width={w} height={h} rx={7} fill={i.used ? 'rgb(var(--hv-widget-panel))' : 'rgb(var(--hv-surface))'} stroke={border} strokeWidth={hover === t.id || i.clash ? 2 : 1.25} />
                {t.edge !== 'b' ? (
                  i.compact ? (
                    <text x={x + 12} y={y + h / 2 + 4} fontSize={12} fontWeight={700} fill={txtMain}>{i.title}{i.name && <tspan fontWeight={400} fill={T.dim}>{`  ${i.name}`}</tspan>}</text>
                  ) : (<>
                    <circle cx={x + 16} cy={y + h / 2} r={5.5} fill={i.on && i.used ? i.color : 'rgb(var(--hv-line))'} />
                    <text x={x + 30} y={y + 19} fontSize={13} fontWeight={700} fill={txtMain}>{i.title}</text>
                    {i.state && <text x={x + w - 12} y={y + 19} fontSize={12} textAnchor="end" fontFamily="ui-monospace,monospace" fill={i.on ? T.text : T.dim}>{i.state}</text>}
                    <text x={x + 30} y={y + 36} fontSize={12} fill={i.clash ? 'rgb(var(--hv-error-text))' : i.used ? T.text2 : 'rgb(var(--hv-text-3))'}>{trunc(i.name || (i.used ? '—' : 'not used'), 33)}</text>
                  </>)
                ) : (
                  i.compact ? (
                    <text x={x + w / 2} y={y + h / 2 + 4} fontSize={11} fontWeight={700} textAnchor="middle" fill={txtMain}>{i.title}</text>
                  ) : (<>
                    <circle cx={x + w / 2} cy={y + 16} r={5.5} fill={i.on && i.used ? i.color : 'rgb(var(--hv-line))'} />
                    <text x={x + w / 2} y={y + 42} fontSize={13} fontWeight={700} textAnchor="middle" fill={txtMain}>{t.label}</text>
                    <text x={x + w / 2} y={y + 60} fontSize={10} textAnchor="middle" fill={T.dim}>{t.kind === 'adc' ? '0–3.3 V in' : '0–10 V out'}</text>
                    {wrap(i.name || '', 13, 1).map((ln, k) => <text key={k} x={x + w / 2} y={y + 80 + k * 14} fontSize={11} textAnchor="middle" fill={T.text2}>{ln}</text>)}
                    {(i.state || '').split(' · ').slice(0, 2).map((part, k) => (
                      <text key={k} x={x + w / 2} y={y + h - 26 + k * 15} fontSize={k ? 11 : 12} fontWeight={k ? 600 : 400} textAnchor="middle"
                        fontFamily={k ? undefined : 'ui-monospace,monospace'} fill={k ? i.color : i.on ? T.text : T.dim}>{trunc(part, 13)}</text>
                    ))}
                  </>)
                )}
              </g>
            );
          })}
        </svg>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4 text-[11px]" style={{ color: T.dim }}>
        <p><b style={{ color: T.text2 }}>Relays</b> are normally open; each group of four shares one COM. Each 4-relay connector is rated for 24 V AC/DC, 4 A total.</p>
        <p><b style={{ color: T.text2 }}>Opto inputs</b> have a 1 kΩ pull-up to 5 V; close to GND to activate.</p>
        <p><b style={{ color: T.text2 }}>Analog inputs</b> read 0–3.3 V (Aether's EOL supervision uses them). <b style={{ color: T.text2 }}>DAC outputs</b> give 0–10 V at up to 10 mA.</p>
        <p><b style={{ color: T.text2 }}>RS-485</b> (485-A/B) is the OSDP bus, driven by the Pi's UART as /dev/ttyAMA0 (pins 8 and 10). <b style={{ color: T.text2 }}>Open-drain outputs</b> and 1-Wire aren't used by Aether. The red LEDs beside the relay terminals light when a relay is on.</p>
      </div>
    </div>
  );
}

const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
function wrap(s: string, n: number, lines: number) {
  const words = s.split(/\s+/); const out: string[] = []; let cur = '';
  for (const w of words) { if ((cur + ' ' + w).trim().length > n) { if (cur) out.push(cur); cur = w; } else cur = (cur + ' ' + w).trim(); }
  if (cur) out.push(cur);
  if (out.length > lines) { out.length = lines; out[lines - 1] = trunc(out[lines - 1] + '…', n); }
  return out;
}
