// Bit-by-bit picture of a credential frame: each cell is one bit on the wire
// (bit 1 first), coloured and labelled by what it carries. Used read-only in
// the composer and interactively (select ranges, show parity coverage) in the
// format builder.
import React, { useMemo } from 'react';
import { BitMap, FIELD_STYLE } from './formatLib';
import { T } from '../config/ui';

export function ownersOf(map: BitMap): string[] {
  const o = new Array(map.bits + 1).fill('pad');
  for (const f of map.fields || []) for (let i = 0; i < f.len; i++) o[f.start + i] = f.key;
  if (map.scramble) for (const [k, list] of Object.entries(map.scramble)) list.forEach(p => { o[p] = k; });
  for (const p of map.parity || []) {
    const w = p.type === 'xor' ? (p.len || 8) : 1;
    for (let i = 0; i < w; i++) o[p.bit + i] = p.type === 'even' ? 'parity-even' : p.type === 'odd' ? 'parity-odd' : 'parity';
  }
  return o;
}

interface Props {
  map: BitMap;
  binary?: string;                 // actual bits, if encoded
  perRow?: number;
  cell?: number;                   // px
  selection?: [number, number] | null;
  coverage?: number[] | null;      // highlight these positions (parity coverage)
  coverageOf?: number | null;      // the parity bit whose coverage is shown
  onCellDown?: (pos: number) => void;
  onCellEnter?: (pos: number) => void;
  onCellHover?: (pos: number | null) => void;
  legend?: boolean;
}

export default function BitStrip({ map, binary, perRow, cell, selection, coverage, coverageOf, onCellDown, onCellEnter, onCellHover, legend = true }: Props) {
  const N = map.bits;
  const owners = useMemo(() => ownersOf(map), [map]);
  const size = cell || (N > 64 ? 20 : N > 40 ? 22 : 26);
  const cov = useMemo(() => new Set(coverage || []), [coverage]);
  const used = Array.from(new Set(owners.slice(1)));
  const selLo = selection ? Math.min(...selection) : 0, selHi = selection ? Math.max(...selection) : -1;
  const interactive = !!onCellDown;

  return (
    <div className="select-none">
      <div className="flex flex-wrap" style={{ columnGap: 2, rowGap: 6 }} onMouseLeave={() => onCellHover?.(null)}>
        {Array.from({ length: N }, (_, i) => i + 1).map(pos => {
              const k = owners[pos];
              const st = FIELD_STYLE[k] || FIELD_STYLE.extra;
              const isPar = k.startsWith('parity');
              const selected = pos >= selLo && pos <= selHi;
              const covered = cov.has(pos);
              const v = binary ? binary[pos - 1] : '';
              return (
                <div key={pos}
                  onMouseDown={interactive ? (e) => { e.preventDefault(); onCellDown!(pos); } : undefined}
                  onMouseEnter={() => { onCellEnter?.(pos); onCellHover?.(pos); }}
                  title={`Bit ${pos} · ${st.label}${binary ? ` = ${v}` : ''}`}
                  className="flex flex-col items-center shrink-0"
                  style={{ width: size, cursor: interactive ? 'pointer' : 'default', marginRight: pos % 8 === 0 && pos !== N ? 4 : 0 }}>
                  <div className="w-full flex items-center justify-center rounded-[3px] font-mono font-bold"
                    style={{
                      height: size, fontSize: size > 22 ? 12 : 11,
                      background: selected ? `color-mix(in srgb, ${T.amber} 33%, transparent)` : k === 'pad' ? 'rgba(0,0,0,0.35)' : `${st.color}${v === '1' ? '40' : '1f'}`,
                      color: v === '1' ? 'rgb(var(--hv-brand-text))' : v === '0' ? st.color : T.faint,
                      boxShadow: selected ? `inset 0 0 0 2px ${T.amber}` : coverageOf === pos ? `inset 0 0 0 2px ${st.color}` : covered ? `inset 0 0 0 1px ${T.text2}` : `inset 0 -2px 0 ${st.color}`,
                      outline: covered ? `1px dashed ${T.text2}` : 'none', outlineOffset: -3,
                    }}>
                    {binary ? v : isPar ? st.short : ''}
                  </div>
                  <div className="font-mono leading-none mt-0.5" style={{ fontSize: 9, color: pos % 8 === 1 || pos === N ? T.dim : 'transparent' }}>{pos}</div>
                </div>
              );
        })}
      </div>
      {legend && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1 text-[11px]" style={{ color: T.text2 }}>
          {used.map(k => {
            const st = FIELD_STYLE[k] || FIELD_STYLE.extra;
            const n = owners.slice(1).filter(x => x === k).length;
            return (
              <span key={k} className="flex items-center gap-1.5">
                <span className="inline-block w-3 h-3 rounded-[2px]" style={{ background: `color-mix(in srgb, ${st.color} 25%, transparent)`, boxShadow: `inset 0 -2px 0 ${st.color}` }} />
                {st.label} <span style={{ color: T.dim }}>· {n} bit{n === 1 ? '' : 's'}</span>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
