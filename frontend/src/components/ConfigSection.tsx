// Setup & Tools. Two modes share one tab bar:
//   Setup: EOL Calibration · HAT Pinout · I/O Mapping · Network · System & Backup
//   Tools:                 OnCAFE Console · Reports · Switch Ports · VMS Stream
// Tool panels (and EOL) are rendered by the parent and passed in, so their
// sockets and loggers stay where they are. Settings are saved on the Pi (backend/data/app-config.json), not only in the
// browser, so every PC sees the same configuration.
import React, { useState } from 'react';
import { Save, CheckCircle, AlertCircle, Loader2, Settings, Wrench } from 'lucide-react';
import IOMappingPage from './config/IOMappingPage';
import NetworkPage from './config/NetworkPage';
import SystemPage from './config/SystemPage';
import PinoutPages from './config/PinoutPages';
import DeviceFirmwareTool from './DeviceFirmwareTool';
import AnalyticsTool from './analytics/AnalyticsTool';   // AETHER-ANALYTICS
import { T } from './config/ui';

type Item = { id: number; name: string; type: string; channel: number; active: boolean; [k: string]: any };

interface ConfigSectionProps {
  inputs: Item[];
  outputs: Item[];
  controllerOutputs?: Item[];
  onUpdateInput: (id: number, field: any, value: any) => void;
  onUpdateOutput: (id: number, field: any, value: any) => void;
  onUpdateControllerOutput?: (id: number, field: any, value: any) => void;
  onSaveConfig?: () => void | Promise<void>;
  onLoadConfig?: () => void;
  onResetConfig?: () => void;
  onExportConfig?: () => void;
  onImportConfig?: (file: File) => void;
  ipAddress?: string;
  eolPanel?: React.ReactNode;
  toolPanels?: { switch?: React.ReactNode; oncafe?: React.ReactNode; stream?: React.ReactNode; reports?: React.ReactNode; blueprint?: React.ReactNode };
}

const SETUP_TABS = [
  { id: 'eol', label: 'EOL Calibration' },
  { id: 'pinout', label: 'HAT Pinout' },
  { id: 'io', label: 'I/O Mapping' },
  { id: 'network', label: 'Network' },
  { id: 'system', label: 'System & Backup' },
] as const;
const TOOL_TABS = [
  { id: 'oncafe', label: 'OnCAFE Console' },
  { id: 'reports', label: 'Reports' },
  { id: 'switch', label: 'Switch Ports' },
  { id: 'stream', label: 'VMS Stream' },
  { id: 'blueprint', label: 'Board Blueprints' },
  { id: 'firmware', label: 'Device Firmware' },
  { id: 'analytics', label: 'Log Analytics' },
] as const;
type SetupId = typeof SETUP_TABS[number]['id'];
type ToolId = typeof TOOL_TABS[number]['id'];
type Mode = 'setup' | 'tools';

const recall = <X extends string>(key: string, ok: readonly { id: string }[], dflt: X): X => {
  try { const v = sessionStorage.getItem(key); if (ok.some(x => x.id === v)) return v as X; } catch { /* */ }
  return dflt;
};
const remember = (key: string, v: string) => { try { sessionStorage.setItem(key, v); } catch { /* */ } };

const ConfigSection: React.FC<ConfigSectionProps> = ({
  inputs, outputs, controllerOutputs = [],
  onUpdateInput, onUpdateOutput, onUpdateControllerOutput,
  onSaveConfig, onResetConfig, ipAddress, eolPanel, toolPanels = {},
}) => {
  const host = ipAddress || (typeof window !== 'undefined' ? window.location.hostname : 'localhost');
  const api = `http://${host}:3001`;
  const [mode, setMode] = useState<Mode>(() => { try { return sessionStorage.getItem('aether.setup.mode') === 'tools' ? 'tools' : 'setup'; } catch { return 'setup'; } });
  const [tab, setTab] = useState<SetupId>(() => recall<SetupId>('aether.config.tab', SETUP_TABS, 'io'));
  const [tool, setTool] = useState<ToolId>(() => recall<ToolId>('aether.tools.tab', TOOL_TABS, 'switch'));
  const [save, setSave] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  const pickMode = (m: Mode) => { setMode(m); remember('aether.setup.mode', m); };
  const pick = (t: SetupId) => { setTab(t); remember('aether.config.tab', t); };
  const pickTool = (t: ToolId) => { setTool(t); remember('aether.tools.tab', t); };
  const tabs = mode === 'setup' ? SETUP_TABS : TOOL_TABS;
  const current: string = mode === 'setup' ? tab : tool;
  const choose = (id: string) => mode === 'setup' ? pick(id as SetupId) : pickTool(id as ToolId);

  const doSave = async () => {
    setSave('saving');
    try { await onSaveConfig?.(); setSave('saved'); } catch { setSave('error'); }
    setTimeout(() => setSave('idle'), 2500);
  };

  return (
    <div className="space-y-4" style={{ color: T.text }}>
      <div className="flex flex-wrap items-center gap-3 rounded-xl border px-4 py-2" style={{ background: T.panel, borderColor: T.line2 }}>
        {/* Mode: Configuration / Setup  or  Tools */}
        <div className="inline-flex p-0.5 rounded-lg mr-1" style={{ background: T.input }} role="radiogroup" aria-label="Section">
          {([['setup', 'Setup', Settings], ['tools', 'Tools', Wrench]] as const).map(([m, label, Icon]) => (
            <button key={m} role="radio" aria-checked={mode === m} onClick={() => pickMode(m)}
              className="px-3.5 py-2 rounded-md text-sm font-bold inline-flex items-center gap-2 transition-colors"
              style={mode === m ? { background: 'rgb(var(--hv-brand-tint))', color: 'rgb(var(--hv-brand-text))', boxShadow: `inset 0 0 0 1px ${T.amber}` } : { color: T.dim }}>
              <Icon size={15} />{label}
            </button>
          ))}
        </div>
        <span className="hidden md:block w-px h-7" style={{ background: T.line2 }} />
        <nav className="flex flex-wrap gap-1 flex-1" role="tablist">
          {tabs.map(t => (
            <button key={t.id} role="tab" aria-selected={current === t.id} onClick={() => choose(t.id)}
              className="px-3.5 py-2 rounded-md text-sm font-semibold transition-colors"
              style={current === t.id ? { background: 'rgb(var(--hv-popup-panel))', color: T.text, boxShadow: `inset 0 -2px 0 ${T.amber}` } : { color: T.dim }}>
              {t.label}
            </button>
          ))}
        </nav>
        {mode === 'setup' && tab === 'io' && (
          <button onClick={doSave} disabled={save === 'saving'}
            className="px-3.5 py-2 rounded-md text-sm font-semibold border inline-flex items-center gap-2 disabled:opacity-50"
            style={save === 'error' ? { borderColor: 'rgb(var(--hv-error-hover))', color: 'rgb(var(--hv-error-text))' } : { background: 'rgb(var(--hv-success-tint-strong))', borderColor: T.green, color: 'rgb(var(--hv-success-text))' }}>
            {save === 'saving' ? <Loader2 size={15} className="animate-spin" /> : save === 'saved' ? <CheckCircle size={15} /> : save === 'error' ? <AlertCircle size={15} /> : <Save size={15} />}
            {save === 'saving' ? 'Saving…' : save === 'saved' ? 'Saved to the Pi' : save === 'error' ? 'Not saved' : 'Save'}
          </button>
        )}
      </div>

      {mode === 'setup' && (<>
        {tab === 'io' && (
          <IOMappingPage api={api} inputs={inputs} outputs={outputs} controllerOutputs={controllerOutputs}
            onUpdateInput={onUpdateInput} onUpdateOutput={onUpdateOutput} onUpdateControllerOutput={onUpdateControllerOutput} />
        )}
        {tab === 'network' && <NetworkPage api={api} />}
        {tab === 'system' && <SystemPage api={api} onResetIO={onResetConfig} />}
        {tab === 'pinout' && <PinoutPages api={api} />}
        {tab === 'eol' && eolPanel}
      </>)}
      {mode === 'tools' && tool === 'firmware' && <DeviceFirmwareTool backendUrl={api} />}
      {mode === 'tools' && tool === 'analytics' && <AnalyticsTool backendUrl={api} />}
      {mode === 'tools' && tool !== 'firmware' && tool !== 'analytics' && toolPanels[tool as keyof typeof toolPanels]}
    </div>
  );
};

export default ConfigSection;
