// Readers → Card Formats: format builder and format analyzer (used by OSDP and Wiegand).
// The OSDP tools that used to share this tab bar now live on the OSDP page
// (Enrollment · Firmware · Bus & readers) and OSDP Trace has its own GNB item.
import React, { useState } from 'react';
import FormatBuilder from './FormatBuilder';
import FormatAnalyzer from './FormatAnalyzer';
import { Fmt } from './formatLib';
import { T } from '../config/ui';

const TOOLS = [
  { id: 'builder', label: 'Builder' },
  { id: 'analyzer', label: 'Analyzer' },
] as const;
type ToolId = typeof TOOLS[number]['id'];

interface Props { api: string; formats: Fmt[]; reload: () => Promise<any>; connected: boolean; onLog?: (m: string) => void }

export default function ReaderTools({ api, formats, reload, connected }: Props) {
  const [tool, setTool] = useState<ToolId>(() => {
    try { const t = sessionStorage.getItem('aether.readers.tool'); if (TOOLS.some(x => x.id === t)) return t as ToolId; } catch { /* */ }
    return 'builder';
  });
  const pick = (t: ToolId) => { setTool(t); try { sessionStorage.setItem('aether.readers.tool', t); } catch { /* */ } };

  return (
    <div className="space-y-4">
      <div role="tablist" className="flex flex-wrap items-center gap-1 rounded-xl border px-3 py-2" style={{ background: 'rgb(var(--hv-widget) / 0.5)', borderColor: T.line2 }}>
        {TOOLS.map(t => (
          <button key={t.id} type="button" role="tab" aria-selected={tool === t.id} onClick={() => pick(t.id)} className="px-3 py-1.5 rounded-md text-sm font-semibold"
            style={tool === t.id ? { background: 'rgb(var(--hv-popup-panel))', color: T.text, boxShadow: `inset 0 -2px 0 ${T.amber}` } : { color: T.dim }}>{t.label}</button>
        ))}
      </div>

      {tool === 'builder' && <FormatBuilder api={api} formats={formats} reload={reload} connected={connected} />}
      {tool === 'analyzer' && <FormatAnalyzer formats={formats} />}
    </div>
  );
}
