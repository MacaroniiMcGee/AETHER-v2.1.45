// Setup and Tools (AETHER-GNB-2DEPTH): two GNB sections; the page is picked in the GNB.
//   Setup: HAT Pinout · I/O Mapping · EOL Calibration · Network · System & Backup · Device Firmware
//   Tools: OnCAFE Console · VMS Stream · Switch Ports · Board Blueprints · Log Analytics
//   Reports is its own GNB item (rendered by the parent).
// Tool panels (and EOL) are rendered by the parent and passed in, so their
// sockets and loggers stay where they are. Settings are saved on the Pi (backend/data/app-config.json), not only in the
// browser, so every PC sees the same configuration.
import React, { useState } from 'react';
import { Save, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
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
  mode: Mode;
  page: string;
}

export const SETUP_TABS = [
  { id: 'pinout', label: 'HAT Pinout', description: 'GPIO HAT pin assignments' },
  { id: 'io', label: 'I/O Mapping', description: 'Inputs, outputs and controller channels' },
  { id: 'eol', label: 'EOL Calibration', description: 'End-of-line supervision calibration' },
  { id: 'network', label: 'Network', description: 'Addresses and interfaces of this Pi' },
  { id: 'system', label: 'System & Backup', description: 'Services, backup and restore' },
  { id: 'firmware', label: 'Device Firmware', description: 'Install Aether updates on this Pi' },
] as const;
export const TOOL_TABS = [
  { id: 'oncafe', label: 'OnCAFE Console', description: 'Build OnCAFE console layouts' },
  { id: 'stream', label: 'VMS Stream', description: 'Camera and VMS stream view' },
  { id: 'switch', label: 'Switch Ports', description: 'PoE switch port control' },
  { id: 'blueprint', label: 'Board Blueprints', description: 'Powered by Hydra' },
  { id: 'analytics', label: 'Log Analytics', description: 'Scan controller log bundles and grade test runs' },
] as const;
export type SetupId = typeof SETUP_TABS[number]['id'];
export type ToolId = typeof TOOL_TABS[number]['id'];
type Mode = 'setup' | 'tools';

const ConfigSection: React.FC<ConfigSectionProps> = ({
  inputs, outputs, controllerOutputs = [],
  onUpdateInput, onUpdateOutput, onUpdateControllerOutput,
  onSaveConfig, onResetConfig, ipAddress, eolPanel, toolPanels = {}, mode, page,
}) => {
  const host = ipAddress || (typeof window !== 'undefined' ? window.location.hostname : 'localhost');
  const api = `http://${host}:3001`;
  const tab = page as SetupId;
  const tool = page as ToolId;
  const [save, setSave] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  const doSave = async () => {
    setSave('saving');
    try { await onSaveConfig?.(); setSave('saved'); } catch { setSave('error'); }
    setTimeout(() => setSave('idle'), 2500);
  };

  return (
    <div className="space-y-4" style={{ color: T.text }}>
      {/* The section tab bar moved into the GNB; only the I/O Mapping save button stays here. */}
      {mode === 'setup' && tab === 'io' && (
      <div className="flex justify-end">
          <button onClick={doSave} disabled={save === 'saving'}
            className="px-3.5 py-2 rounded-md text-sm font-semibold border inline-flex items-center gap-2 disabled:opacity-50"
            style={save === 'error' ? { borderColor: 'rgb(var(--hv-error-hover))', color: 'rgb(var(--hv-error-text))' } : { background: 'rgb(var(--hv-success-tint-strong))', borderColor: T.green, color: 'rgb(var(--hv-success-text))' }}>
            {save === 'saving' ? <Loader2 size={15} className="animate-spin" /> : save === 'saved' ? <CheckCircle size={15} /> : save === 'error' ? <AlertCircle size={15} /> : <Save size={15} />}
            {save === 'saving' ? 'Saving…' : save === 'saved' ? 'Saved to the Pi' : save === 'error' ? 'Not saved' : 'Save'}
          </button>
      </div>
      )}

      {mode === 'setup' && (<>
        {tab === 'io' && (
          <IOMappingPage api={api} inputs={inputs} outputs={outputs} controllerOutputs={controllerOutputs}
            onUpdateInput={onUpdateInput} onUpdateOutput={onUpdateOutput} onUpdateControllerOutput={onUpdateControllerOutput} />
        )}
        {tab === 'network' && <NetworkPage api={api} />}
        {tab === 'system' && <SystemPage api={api} onResetIO={onResetConfig} />}
        {tab === 'pinout' && <PinoutPages api={api} />}
        {tab === 'eol' && eolPanel}
        {tab === 'firmware' && <DeviceFirmwareTool backendUrl={api} />}
      </>)}
      {mode === 'tools' && tool === 'analytics' && <AnalyticsTool backendUrl={api} />}
      {mode === 'tools' && tool !== 'analytics' && toolPanels[tool as keyof typeof toolPanels]}
    </div>
  );
};

export default ConfigSection;
