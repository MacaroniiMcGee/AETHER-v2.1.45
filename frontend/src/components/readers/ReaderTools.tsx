// Readers → Tools: everything that isn't "send a credential" in one place:
// format builder, format analyzer, and the OSDP maintenance tools (firmware
// upload, bus & reader manager, sniffer) that used to sit under OSDP → Maintain.
import React, { useEffect, useState } from 'react';
import FormatBuilder from './FormatBuilder';
import FormatAnalyzer from './FormatAnalyzer';
import OsdpTrace from './OsdpTrace';
import OsdpEnroll from './OsdpEnroll';
import OSDPFirmwareWizard from '../OSDPFirmwareWizard';
import OSDPBusManager from '../OSDPBusManager';
import { Fmt } from './formatLib';
import { T } from '../config/ui';

const TOOLS = [
  { id: 'trace', label: 'OSDP Trace', group: 'OSDP' },
  { id: 'enroll', label: 'Credential enrollment', group: 'OSDP' },
  { id: 'firmware', label: 'Firmware upload', group: 'OSDP' },
  { id: 'bus', label: 'Bus & readers', group: 'OSDP' },
  { id: 'builder', label: 'Format builder', group: 'Formats' },
  { id: 'analyzer', label: 'Format analyzer', group: 'Formats' },
] as const;
type ToolId = typeof TOOLS[number]['id'];

interface Props { api: string; formats: Fmt[]; reload: () => Promise<any>; connected: boolean; onLog?: (m: string) => void }

export default function ReaderTools({ api, formats, reload, connected, onLog }: Props) {
  const [tool, setTool] = useState<ToolId>(() => {
    try { const t = sessionStorage.getItem('aether.readers.tool'); if (TOOLS.some(x => x.id === t)) return t as ToolId; } catch { /* */ }
    return 'trace';
  });
  const pick = (t: ToolId) => { setTool(t); try { sessionStorage.setItem('aether.readers.tool', t); } catch { /* */ } };
  const [osdpReaders, setOsdpReaders] = useState<any[]>([]);
  useEffect(() => {
    if (tool !== 'firmware') return;
    fetch(`${api}/api/osdp/readers`).then(r => r.json()).then(j => setOsdpReaders(j.readers || [])).catch(() => setOsdpReaders([]));
  }, [api, tool]);
  const log = (m: any) => onLog?.(typeof m === 'string' ? m : String(m));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1 rounded-xl border px-3 py-2" style={{ background: 'rgb(var(--hv-widget) / 0.5)', borderColor: T.line2 }}>
        {(['OSDP', 'Formats'] as const).map((g, gi) => (
          <React.Fragment key={g}>
            {gi > 0 && <span className="w-px h-6 mx-2" style={{ background: T.line2 }} />}
            <span className="text-[10px] font-bold tracking-wider mr-1" style={{ color: T.faint }}>{g.toUpperCase()}</span>
            {TOOLS.filter(t => t.group === g).map(t => (
              <button key={t.id} type="button" onClick={() => pick(t.id)} className="px-3 py-1.5 rounded-md text-sm font-semibold"
                style={tool === t.id ? { background: 'rgb(var(--hv-popup-panel))', color: T.text, boxShadow: `inset 0 -2px 0 ${T.amber}` } : { color: T.dim }}>{t.label}</button>
            ))}
          </React.Fragment>
        ))}
      </div>

      {tool === 'builder' && <FormatBuilder api={api} formats={formats} reload={reload} connected={connected} />}
      {tool === 'analyzer' && <FormatAnalyzer formats={formats} />}
      {tool === 'firmware' && <OSDPFirmwareWizard readers={osdpReaders} />}
      {tool === 'bus' && <OSDPBusManager apiUrl={api} onLog={log} />}
      {tool === 'trace' && <OsdpTrace api={api} />}
      {tool === 'enroll' && <OsdpEnroll api={api} formats={formats} reload={reload} />}
    </div>
  );
}
