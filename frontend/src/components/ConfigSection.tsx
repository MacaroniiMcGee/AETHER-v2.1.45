import React, { useState, useEffect, useCallback } from 'react';
import { 
  Settings, Network, Cpu, Sliders, Save, RotateCcw, 
  AlertCircle, CheckCircle, Upload, Download, Server,
  HardDrive, Wifi, Shield, Zap, Info, Monitor,
  RefreshCw, Loader2, AlertTriangle, Globe, Router
} from 'lucide-react';
import GpioPinoutDiagram from './Gpiopinoutdiagram';
import VMSDisplayConfig from './VMSDisplayConfig';

/** ---------- Types ---------- */
type InputType =
  | 'None' | 'REX-Button' | 'Entry Sensor' | 'Lock Sensor'
  | 'Safety Beam' | 'DPS' | 'AUX' | 'General';

type OutputType =
  | 'None' | 'Strike Follower' | 'Lock'
  | 'Auto Door' | 'Sounder' | 'Strobe' | 'FAI' | 'General';

interface InputItem {
  id: number;
  name: string;
  type: InputType;
  channel: number;
  active: boolean;
}

interface OutputItem {
  id: number;
  name: string;
  type: OutputType;
  channel: number;
  active: boolean;
}

interface NetworkStatus {
  hostname: string;
  ips: string[];
  interfaces: string[];
  ifDetails: Record<string, { ip: string | null; mac: string | null; state: string }>;
}

interface NetworkConfig {
  iface: string;
  mode: 'dhcp' | 'static';
  ip: string;
  prefix: string;
  gateway: string;
  dns: string;
  hostname: string;
}

interface ConfigSectionProps {
  inputs: InputItem[];
  outputs: OutputItem[];
  controllerOutputs?: OutputItem[];
  onUpdateInput: (id: number, field: keyof InputItem, value: any) => void;
  onUpdateOutput: (id: number, field: keyof OutputItem, value: any) => void;
  onUpdateControllerOutput?: (id: number, field: keyof OutputItem, value: any) => void;
  onSaveConfig?: () => void;
  onLoadConfig?: () => void;
  onResetConfig?: () => void;
  onExportConfig?: () => void;
  onImportConfig?: (file: File) => void;
  ipAddress?: string;  // backend IP for API calls — defaults to current browser hostname
}

const ConfigSection: React.FC<ConfigSectionProps> = ({
  inputs, outputs, controllerOutputs,
  onUpdateInput, onUpdateOutput, onUpdateControllerOutput,
  onSaveConfig, onLoadConfig, onResetConfig, onExportConfig, onImportConfig,
  ipAddress,
}) => {
  // If ipAddress not passed, use the hostname the browser is already connected to.
  // This means if you open the app at http://192.168.1.68:3000, the backend
  // calls will go to http://192.168.1.68:3001 automatically.
  const resolvedIp = ipAddress || (typeof window !== 'undefined' ? window.location.hostname : 'localhost');
  const [activeConfigTab, setActiveConfigTab] = useState<'io' | 'network' | 'system' | 'gpio' | 'vms'>('io');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  // ── Network state ────────────────────────────────────────────────────────
  const [netStatus, setNetStatus]       = useState<NetworkStatus | null>(null);
  const [netConfig, setNetConfig]       = useState<NetworkConfig>({
    iface: 'eth0', mode: 'dhcp', ip: '', prefix: '24', gateway: '', dns: '8.8.8.8 8.8.4.4', hostname: '',
  });
  const [availableIfaces, setAvailableIfaces] = useState<string[]>(['eth0', 'wlan0']);
  const [netLoading, setNetLoading]     = useState(false);
  const [netSaving, setNetSaving]       = useState(false);
  const [netMessage, setNetMessage]     = useState<{ type: 'success' | 'error' | 'warning'; text: string } | null>(null);
  const [showRestartWarning, setShowRestartWarning] = useState(false);

  const API = `http://${resolvedIp}:3001`;

  // Load network status + config when tab opens
  const loadNetworkData = useCallback(async () => {
    setNetLoading(true);
    setNetMessage(null);
    try {
      const [statusRes, ifacesRes] = await Promise.all([
        fetch(`${API}/api/network/status`),
        fetch(`${API}/api/network/interfaces`),
      ]);

      if (statusRes.ok) {
        const s = await statusRes.json();
        if (s.success) setNetStatus(s);
      }

      if (ifacesRes.ok) {
        const i = await ifacesRes.json();
        if (i.success && i.interfaces?.length) setAvailableIfaces(i.interfaces);
      }

      // Load config for current interface
      const cfgRes = await fetch(`${API}/api/network/config?iface=${netConfig.iface}`);
      if (cfgRes.ok) {
        const c = await cfgRes.json();
        if (c.success) {
          setNetConfig(prev => ({
            ...prev,
            mode:     c.mode     || 'dhcp',
            ip:       c.ip       || '',
            prefix:   c.prefix   || '24',
            gateway:  c.gateway  || '',
            dns:      c.dns      || '8.8.8.8 8.8.4.4',
            hostname: c.hostname || '',
          }));
        }
      }
    } catch (e) {
      setNetMessage({ type: 'error', text: 'Could not reach backend. Is the server running?' });
    }
    setNetLoading(false);
  }, [API, netConfig.iface]);

  useEffect(() => {
    if (activeConfigTab === 'network') loadNetworkData();
  }, [activeConfigTab]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reload config when interface changes
  const handleIfaceChange = async (iface: string) => {
    setNetConfig(prev => ({ ...prev, iface }));
    try {
      const cfgRes = await fetch(`${API}/api/network/config?iface=${iface}`);
      if (cfgRes.ok) {
        const c = await cfgRes.json();
        if (c.success) setNetConfig(prev => ({
          ...prev, iface,
          mode: c.mode || 'dhcp', ip: c.ip || '', prefix: c.prefix || '24',
          gateway: c.gateway || '', dns: c.dns || '',
        }));
      }
    } catch (e) {}
  };

  const handleApplyNetwork = async () => {
    if (netConfig.mode === 'static') {
      if (!netConfig.ip) { setNetMessage({ type: 'error', text: 'IP address is required for static mode.' }); return; }
      if (!netConfig.ip.match(/^\d{1,3}(\.\d{1,3}){3}$/)) { setNetMessage({ type: 'error', text: 'Invalid IP address format.' }); return; }
    }
    setShowRestartWarning(true);
  };

  const confirmApplyNetwork = async () => {
    setShowRestartWarning(false);
    setNetSaving(true);
    setNetMessage(null);
    try {
      const res = await fetch(`${API}/api/network/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(netConfig),
      });
      const data = await res.json();
      if (data.success) {
        setNetMessage({ type: 'success', text: data.message });
        // Reload status after a brief delay to allow network restart
        setTimeout(loadNetworkData, 3000);
      } else {
        setNetMessage({ type: 'error', text: data.error || 'Failed to apply settings.' });
      }
    } catch (e) {
      setNetMessage({ type: 'warning', text: 'Settings sent. Network may be restarting — page may need refresh.' });
    }
    setNetSaving(false);
  };

  // ── IO Config helpers ────────────────────────────────────────────────────
  const inputTypes: InputType[] = [
    'None', 'REX-Button', 'Entry Sensor', 'Lock Sensor',
    'Safety Beam', 'DPS', 'AUX', 'General'
  ];
  const outputTypes: OutputType[] = [
    'None', 'Strike Follower', 'Lock', 'Auto Door',
    'Sounder', 'Strobe', 'FAI', 'General'
  ];

  const handleSaveConfig = async () => {
    setSaveStatus('saving');
    try {
      if (onSaveConfig) await onSaveConfig();
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 3000);
    } catch (error) {
      setSaveStatus('error');
      setTimeout(() => setSaveStatus('idle'), 3000);
    }
  };

  const handleImportConfig = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file && onImportConfig) onImportConfig(file);
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-gradient-to-br from-[#1B1613] to-[#241E19] rounded-xl p-6 border border-[#4A3F36]">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-white flex items-center gap-3">
              <Settings className="w-8 h-8 text-[#F0A73C]" />
              System Configuration
            </h1>
            <p className="text-[#C4B9AB] mt-2">
              Configure I/O mappings, network settings, and system parameters
            </p>
          </div>
          <button
            onClick={handleSaveConfig}
            disabled={saveStatus === 'saving'}
            className={`px-4 py-2 rounded-lg font-semibold flex items-center gap-2 transition-all ${
              saveStatus === 'saved' ? 'bg-[#4F8B5C] hover:bg-[#3E6E48]'
              : saveStatus === 'error' ? 'bg-[#C6604F] hover:bg-[#A84E3F]'
              : 'bg-[#4E9E98] hover:bg-[#3E827D]'
            } disabled:opacity-50`}
          >
            {saveStatus === 'saving' ? <><RotateCcw className="w-5 h-5 animate-spin" />Saving...</>
             : saveStatus === 'saved' ? <><CheckCircle className="w-5 h-5" />Saved!</>
             : saveStatus === 'error' ? <><AlertCircle className="w-5 h-5" />Error</>
             : <><Save className="w-5 h-5" />Save Configuration</>}
          </button>
        </div>
      </div>

      {/* Section cards — these ARE the selector, replacing the old button row.
          Same pattern as Access Control, Readers and Tools, with a short line
          of what lives inside each so you can pick without opening it first. */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        {([
          { id: 'io',      icon: <Sliders size={32} />,  title: 'I/O Configuration',  desc: 'Channel mapping',      meta: 'Relays | Inputs | Supervision', accent: '#F0A73C' },
          { id: 'network', icon: <Network size={32} />,  title: 'Network Settings',   desc: 'Address and hostname', meta: 'DHCP | Static | DNS',           accent: '#5FB7B0' },
          { id: 'system',  icon: <Cpu size={32} />,      title: 'System Parameters',  desc: 'Timing and backups',   meta: 'Pulse | Import | Export',       accent: '#8FB488' },
          { id: 'gpio',    icon: <Zap size={32} />,      title: 'Sequent Channelout', desc: 'Pinout reference',     meta: 'GPIO | Board layout',           accent: '#E6C766' },
          { id: 'vms',     icon: <Monitor size={32} />,  title: 'VMS Display',        desc: 'Video wall output',    meta: 'Layouts | Monitors',            accent: '#C6604F' },
        ] as const).map(card => {
          const active = activeConfigTab === card.id;
          return (
            <button
              key={card.id}
              onClick={() => setActiveConfigTab(card.id)}
              className="p-6 rounded-lg border-2 transition-all text-left"
              style={active
                ? { borderColor: card.accent, background: `linear-gradient(135deg, ${card.accent}26, ${card.accent}0D)`, boxShadow: `0 10px 15px -3px ${card.accent}33` }
                : { borderColor: '#38302A', background: 'rgba(36,30,25,0.5)' }}
            >
              <div className="mb-2" style={{ color: active ? card.accent : '#786D60' }}>
                {card.icon}
              </div>
              <h3 className="text-lg font-semibold text-white mb-1">{card.title}</h3>
              <p className="text-sm text-[#ADA294]">{card.desc}</p>
              <div className="mt-3 text-xs text-[#786D60]">{card.meta}</div>
            </button>
          );
        })}
      </div>

      <div className="bg-[#241E19]/50 backdrop-blur rounded-xl border border-[#4A3F36]">
        <div className="p-6">

          {/* ── I/O CONFIG ────────────────────────────────────────────── */}
          {activeConfigTab === 'io' && (
            <div className="space-y-6">
              <div className="bg-[#173B38]/20 rounded-lg p-4 border border-[#3E827D]/50">
                <div className="flex items-start gap-3">
                  <Info className="text-[#5FB7B0] flex-shrink-0 mt-1" size={20} />
                  <div className="text-sm text-[#8FD3CD]">
                    <strong>Sequent IOplus Channel Configuration:</strong><br/>
                    <strong>Input Group (Relay Outputs):</strong> Configure relay channels 0-7 and resting state.<br/>
                    <strong>Output Group (Monitoring Inputs):</strong> Configure opto/analog input channels 0-7 with supervision.
                  </div>
                </div>
              </div>

              {/* Inputs = Relay Outputs */}
              <div>
                <h3 className="text-xl font-bold text-white mb-4 flex items-center gap-2">
                  <Sliders className="w-6 h-6 text-[#E6C766]" />
                  Input Configuration (Relay Outputs)
                </h3>
                <div className="space-y-3">
                  {inputs.map(input => (
                    <div key={input.id} className="bg-[#1F1912]/50 rounded-lg p-4 border border-[#38302A]">
                      <div className="grid grid-cols-5 gap-4 items-center">
                        <div>
                          <label className="block text-sm font-semibold text-[#ADA294] mb-2">Name</label>
                          <input type="text" value={input.name}
                            onChange={(e) => onUpdateInput(input.id, 'name', e.target.value)}
                            className="w-full bg-[#241E19] border border-[#38302A] rounded px-3 py-2 text-white" />
                        </div>
                        <div>
                          <label className="block text-sm font-semibold text-[#ADA294] mb-2">Type</label>
                          <select value={input.type}
                            onChange={(e) => onUpdateInput(input.id, 'type', e.target.value)}
                            className="w-full bg-[#241E19] border border-[#38302A] rounded px-3 py-2 text-white">
                            {inputTypes.map(t => <option key={t} value={t}>{t}</option>)}
                          </select>
                        </div>
                        <div>
                          <label className="block text-sm font-semibold text-[#ADA294] mb-2">Relay Channel</label>
                          <select value={input.channel}
                            onChange={(e) => onUpdateInput(input.id, 'channel', parseInt(e.target.value))}
                            className="w-full bg-[#241E19] border border-[#38302A] rounded px-3 py-2 text-white">
                            {[0,1,2,3,4,5,6,7].map(ch => <option key={ch} value={ch}>Relay {ch}</option>)}
                          </select>
                        </div>
                        <div>
                          <label className="block text-sm font-semibold text-[#ADA294] mb-2">Resting State</label>
                          <select value={(input as any).restingState || 'NO'}
                            onChange={(e) => onUpdateInput(input.id, 'restingState' as any, e.target.value)}
                            className="w-full bg-[#241E19] border border-[#38302A] rounded px-3 py-2 text-white">
                            <option value="NO">NO (Normally Open)</option>
                            <option value="NC">NC (Normally Closed)</option>
                          </select>
                        </div>
                        <div className="flex items-center justify-center">
                          <div className={`w-4 h-4 rounded-full ${input.active ? 'bg-[#6FBF7E]' : 'bg-[#4A3F36]'}`} />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Outputs = Monitoring Inputs */}
              <div>
                <h3 className="text-xl font-bold text-white mb-4 flex items-center gap-2">
                  <Sliders className="w-6 h-6 text-[#5FB7B0]" />
                  Output Configuration (Monitoring Inputs)
                </h3>
                <div className="space-y-3">
                  {outputs.map(output => (
                    <div key={output.id} className="bg-[#1F1912]/50 rounded-lg p-4 border border-[#38302A]">
                      <div className="grid grid-cols-6 gap-3 items-center">
                        <div>
                          <label className="block text-sm font-semibold text-[#ADA294] mb-2">Name</label>
                          <input type="text" value={output.name}
                            onChange={(e) => onUpdateOutput(output.id, 'name', e.target.value)}
                            className="w-full bg-[#241E19] border border-[#38302A] rounded px-3 py-2 text-white" />
                        </div>
                        <div>
                          <label className="block text-sm font-semibold text-[#ADA294] mb-2">Type</label>
                          <select value={output.type}
                            onChange={(e) => onUpdateOutput(output.id, 'type', e.target.value)}
                            className="w-full bg-[#241E19] border border-[#38302A] rounded px-3 py-2 text-white">
                            {outputTypes.map(t => <option key={t} value={t}>{t}</option>)}
                          </select>
                        </div>
                        <div>
                          <label className="block text-sm font-semibold text-[#ADA294] mb-2">Input Channel</label>
                          <select value={output.channel}
                            onChange={(e) => onUpdateOutput(output.id, 'channel', parseInt(e.target.value))}
                            className="w-full bg-[#241E19] border border-[#38302A] rounded px-3 py-2 text-white">
                            {[0,1,2,3,4,5,6,7].map(ch => <option key={ch} value={ch}>Input {ch}</option>)}
                          </select>
                        </div>
                        <div>
                          <label className="block text-sm font-semibold text-[#ADA294] mb-2">Input Type</label>
                          <select value={(output as any).inputType || 'opto'}
                            onChange={(e) => onUpdateOutput(output.id, 'inputType' as any, e.target.value)}
                            className="w-full bg-[#241E19] border border-[#38302A] rounded px-3 py-2 text-white">
                            <option value="opto">Opto-Isolated</option>
                            <option value="analog">Analog (0-10V)</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-sm font-semibold text-[#ADA294] mb-2">Supervision</label>
                          <select value={(output as any).supervisionType || 'NO'}
                            onChange={(e) => onUpdateOutput(output.id, 'supervisionType' as any, e.target.value)}
                            className="w-full bg-[#241E19] border border-[#38302A] rounded px-3 py-2 text-white">
                            <option value="NO">NO (Normally Open)</option>
                            <option value="NC">NC (Normally Closed)</option>
                            <option value="Supervised-NO">Supervised NO</option>
                            <option value="Supervised-NC">Supervised NC</option>
                          </select>
                        </div>
                        <div className="flex items-center justify-center">
                          <div className={`w-4 h-4 rounded-full ${output.active ? 'bg-[#5FB7B0]' : 'bg-[#4A3F36]'}`} />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Controller Outputs */}
              {controllerOutputs && controllerOutputs.length > 0 && (
                <div>
                  <h3 className="text-xl font-bold text-white mb-4 flex items-center gap-2">
                    <Sliders className="w-6 h-6 text-[#F0A73C]" />
                    Controller Output Configuration
                  </h3>
                  <div className="space-y-3">
                    {controllerOutputs.map(output => (
                      <div key={output.id} className="bg-[#1F1912]/50 rounded-lg p-4 border border-[#38302A]">
                        <div className="grid grid-cols-4 gap-4 items-center">
                          <div>
                            <label className="block text-sm font-semibold text-[#ADA294] mb-2">Name</label>
                            <input type="text" value={output.name}
                              onChange={(e) => onUpdateControllerOutput?.(output.id, 'name', e.target.value)}
                              className="w-full bg-[#241E19] border border-[#38302A] rounded px-3 py-2 text-white" />
                          </div>
                          <div>
                            <label className="block text-sm font-semibold text-[#ADA294] mb-2">Type</label>
                            <select value={output.type}
                              onChange={(e) => onUpdateControllerOutput?.(output.id, 'type', e.target.value)}
                              className="w-full bg-[#241E19] border border-[#38302A] rounded px-3 py-2 text-white">
                              {outputTypes.map(t => <option key={t} value={t}>{t}</option>)}
                            </select>
                          </div>
                          <div>
                            <label className="block text-sm font-semibold text-[#ADA294] mb-2">Relay Channel</label>
                            <select value={output.channel}
                              onChange={(e) => onUpdateControllerOutput?.(output.id, 'channel', parseInt(e.target.value))}
                              className="w-full bg-[#241E19] border border-[#38302A] rounded px-3 py-2 text-white">
                              {[0,1,2,3,4,5,6,7].map(ch => <option key={ch} value={ch}>Relay {ch}</option>)}
                            </select>
                          </div>
                          <div className="flex items-center justify-center">
                            <div className={`w-4 h-4 rounded-full ${output.active ? 'bg-[#F0A73C]' : 'bg-[#4A3F36]'}`} />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── NETWORK SETTINGS ──────────────────────────────────────── */}
          {activeConfigTab === 'network' && (
            <div className="space-y-6">

              {/* Restart confirmation modal */}
              {showRestartWarning && (
                <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
                  <div className="bg-[#241E19] border border-[#C9862E] rounded-xl p-6 w-[480px] shadow-2xl">
                    <div className="flex items-center gap-3 mb-4">
                      <AlertTriangle className="w-7 h-7 text-[#E6C766] flex-shrink-0" />
                      <h3 className="text-lg font-bold text-white">Apply Network Changes?</h3>
                    </div>
                    <div className="text-[#C4B9AB] text-sm space-y-2 mb-6">
                      <p>This will restart the network service on the Raspberry Pi.</p>
                      {netConfig.mode === 'static' && (
                        <p className="text-[#F0C674]">
                          You are setting a <strong>static IP of {netConfig.ip}</strong>. 
                          If this is different from the current IP, you will need to reconnect to the new address.
                        </p>
                      )}
                      {netConfig.mode === 'dhcp' && (
                        <p>Switching to DHCP — the Pi's IP address may change after restart.</p>
                      )}
                    </div>
                    <div className="flex gap-3">
                      <button onClick={() => setShowRestartWarning(false)}
                        className="flex-1 px-4 py-2 bg-[#38302A] hover:bg-[#4A3F36] rounded-lg">
                        Cancel
                      </button>
                      <button onClick={confirmApplyNetwork}
                        className="flex-1 px-4 py-2 bg-[#C9862E] hover:bg-[#A96F22] rounded-lg font-semibold text-white">
                        Apply &amp; Restart Network
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Live Status Card */}
              <div className="bg-[#15110B]/80 border border-[#4A3F36] rounded-xl p-5">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-lg font-bold text-white flex items-center gap-2">
                    <Router className="w-5 h-5 text-[#7BD497]" />
                    Live Network Status
                  </h3>
                  <button onClick={loadNetworkData} disabled={netLoading}
                    className="flex items-center gap-2 px-3 py-1.5 bg-[#38302A] hover:bg-[#4A3F36] rounded text-sm">
                    {netLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                    Refresh
                  </button>
                </div>

                {netLoading && !netStatus ? (
                  <div className="flex items-center gap-3 text-[#ADA294] py-4">
                    <Loader2 className="w-5 h-5 animate-spin" />
                    Loading network status...
                  </div>
                ) : netStatus ? (
                  <div className="grid grid-cols-2 gap-4">
                    <div className="bg-[#1F1912]/60 rounded-lg p-4">
                      <div className="text-xs text-[#786D60] uppercase tracking-wider mb-1">Hostname</div>
                      <div className="text-white font-mono text-lg">{netStatus.hostname || '—'}</div>
                    </div>
                    <div className="bg-[#1F1912]/60 rounded-lg p-4">
                      <div className="text-xs text-[#786D60] uppercase tracking-wider mb-1">IP Addresses</div>
                      <div className="font-mono text-sm space-y-0.5">
                        {netStatus.ips.length
                          ? netStatus.ips.map(ip => <div key={ip} className="text-[#7BD497]">{ip}</div>)
                          : <div className="text-[#786D60]">No addresses</div>}
                      </div>
                    </div>
                    {Object.entries(netStatus.ifDetails || {}).map(([iface, detail]) => (
                      <div key={iface} className="bg-[#1F1912]/60 rounded-lg p-4">
                        <div className="text-xs text-[#786D60] uppercase tracking-wider mb-2 flex items-center gap-2">
                          <div className={`w-2 h-2 rounded-full ${detail.state === 'UP' ? 'bg-[#6FBF7E]' : 'bg-[#786D60]'}`} />
                          {iface} — {detail.state}
                        </div>
                        <div className="font-mono text-sm">
                          <div className="text-[#8FD3CD]">{detail.ip || 'No IP'}</div>
                          <div className="text-[#786D60] text-xs">{detail.mac || ''}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-[#786D60] py-4 text-center">Could not load network status</div>
                )}
              </div>

              {/* Config Form */}
              <div className="bg-[#1F1912]/50 border border-[#4A3F36] rounded-xl p-6 space-y-5">
                <h3 className="text-lg font-bold text-white flex items-center gap-2">
                  <Globe className="w-5 h-5 text-[#5FB7B0]" />
                  Configure Network
                </h3>

                {/* Message banner */}
                {netMessage && (
                  <div className={`flex items-start gap-3 p-4 rounded-lg border ${
                    netMessage.type === 'success' ? 'bg-[#1E3A24]/30 border-[#4F8B5C] text-[#9BD9AB]'
                    : netMessage.type === 'error'  ? 'bg-[#3A1E1A]/30 border-[#C6604F] text-[#F0A79A]'
                    : 'bg-[#2E2410]/30 border-[#C9862E] text-[#F0C674]'
                  }`}>
                    {netMessage.type === 'success' ? <CheckCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
                     : netMessage.type === 'error' ? <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
                     : <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5" />}
                    <span className="text-sm">{netMessage.text}</span>
                  </div>
                )}

                {/* Hostname */}
                <div>
                  <label className="block text-sm font-semibold text-[#C4B9AB] mb-2">
                    <Server className="inline w-4 h-4 mr-2" />
                    Hostname
                  </label>
                  <input type="text" value={netConfig.hostname}
                    onChange={e => setNetConfig(p => ({ ...p, hostname: e.target.value }))}
                    placeholder="raspberrypi"
                    className="w-full bg-[#15110B] border border-[#38302A] focus:border-[#5FB7B0] rounded-lg px-4 py-3 text-white font-mono outline-none transition-colors" />
                  <p className="text-xs text-[#786D60] mt-1">Changes /etc/hostname and /etc/hosts</p>
                </div>

                {/* Interface selector */}
                <div>
                  <label className="block text-sm font-semibold text-[#C4B9AB] mb-2">
                    <HardDrive className="inline w-4 h-4 mr-2" />
                    Network Interface
                  </label>
                  <select value={netConfig.iface} onChange={e => handleIfaceChange(e.target.value)}
                    className="w-full bg-[#15110B] border border-[#38302A] focus:border-[#5FB7B0] rounded-lg px-4 py-3 text-white outline-none transition-colors">
                    {availableIfaces.map(i => <option key={i} value={i}>{i}</option>)}
                  </select>
                </div>

                {/* DHCP / Static toggle */}
                <div>
                  <label className="block text-sm font-semibold text-[#C4B9AB] mb-2">
                    <Wifi className="inline w-4 h-4 mr-2" />
                    Address Mode
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    {(['dhcp', 'static'] as const).map(mode => (
                      <button key={mode} onClick={() => setNetConfig(p => ({ ...p, mode }))}
                        className={`py-3 rounded-lg font-semibold capitalize transition-all ${
                          netConfig.mode === mode
                            ? mode === 'dhcp' ? 'bg-[#4E9E98] text-white' : 'bg-[#C9862E] text-white'
                            : 'bg-[#38302A] text-[#C4B9AB] hover:bg-[#4A3F36]'
                        }`}>
                        {mode === 'dhcp' ? '🔄 DHCP (Automatic)' : '📌 Static IP'}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Static fields */}
                {netConfig.mode === 'static' && (
                  <div className="bg-[#2E2410]/10 border border-[#2E2410]/40 rounded-lg p-4 space-y-4">
                    <div className="text-xs text-[#E6C766] flex items-center gap-2">
                      <AlertTriangle className="w-4 h-4" />
                      Setting a static IP — ensure it doesn't conflict with other devices on your network
                    </div>

                    {/* IP + Prefix */}
                    <div className="grid grid-cols-3 gap-3">
                      <div className="col-span-2">
                        <label className="block text-xs font-semibold text-[#ADA294] mb-1.5">IP Address</label>
                        <input type="text" value={netConfig.ip}
                          onChange={e => setNetConfig(p => ({ ...p, ip: e.target.value }))}
                          placeholder="192.168.1.100"
                          className="w-full bg-[#15110B] border border-[#38302A] focus:border-[#E6C766] rounded px-3 py-2 text-white font-mono text-sm outline-none" />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-[#ADA294] mb-1.5">Prefix / Mask</label>
                        <select value={netConfig.prefix} onChange={e => setNetConfig(p => ({ ...p, prefix: e.target.value }))}
                          className="w-full bg-[#15110B] border border-[#38302A] focus:border-[#E6C766] rounded px-3 py-2 text-white text-sm outline-none">
                          <option value="8">/8  (255.0.0.0)</option>
                          <option value="16">/16 (255.255.0.0)</option>
                          <option value="24">/24 (255.255.255.0)</option>
                          <option value="25">/25 (255.255.255.128)</option>
                          <option value="26">/26 (255.255.255.192)</option>
                          <option value="28">/28 (255.255.255.240)</option>
                          <option value="30">/30 (255.255.255.252)</option>
                        </select>
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-[#ADA294] mb-1.5">Default Gateway</label>
                      <input type="text" value={netConfig.gateway}
                        onChange={e => setNetConfig(p => ({ ...p, gateway: e.target.value }))}
                        placeholder="192.168.1.1"
                        className="w-full bg-[#15110B] border border-[#38302A] focus:border-[#E6C766] rounded px-3 py-2 text-white font-mono text-sm outline-none" />
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-[#ADA294] mb-1.5">DNS Servers (space-separated)</label>
                      <input type="text" value={netConfig.dns}
                        onChange={e => setNetConfig(p => ({ ...p, dns: e.target.value }))}
                        placeholder="8.8.8.8 8.8.4.4"
                        className="w-full bg-[#15110B] border border-[#38302A] focus:border-[#E6C766] rounded px-3 py-2 text-white font-mono text-sm outline-none" />
                      <div className="flex gap-2 mt-1.5">
                        {[['8.8.8.8 8.8.4.4', 'Google'], ['1.1.1.1 1.0.0.1', 'Cloudflare'], ['208.67.222.222', 'OpenDNS']].map(([val, label]) => (
                          <button key={label} onClick={() => setNetConfig(p => ({ ...p, dns: val }))}
                            className="text-[10px] px-2 py-0.5 bg-[#38302A] hover:bg-[#4A3F36] rounded text-[#ADA294]">
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {/* Apply button */}
                <button onClick={handleApplyNetwork} disabled={netSaving}
                  className="w-full py-3 bg-[#4E9E98] hover:bg-[#3E827D] disabled:opacity-50 rounded-lg font-bold text-white flex items-center justify-center gap-2 transition-all">
                  {netSaving
                    ? <><Loader2 className="w-5 h-5 animate-spin" />Applying...</>
                    : <><CheckCircle className="w-5 h-5" />Apply Network Settings</>}
                </button>

                <div className="bg-[#15110B]/60 rounded-lg p-3 flex items-start gap-2">
                  <Info className="w-4 h-4 text-[#786D60] mt-0.5 flex-shrink-0" />
                  <p className="text-xs text-[#786D60]">
                    Changes are written to <code className="text-[#ADA294]">/etc/dhcpcd.conf</code> and
                    <code className="text-[#ADA294]"> /etc/hostname</code> on the Pi, then the network service
                    is restarted. If you change the IP address, reconnect to the new address.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* ── SYSTEM PARAMETERS ─────────────────────────────────────── */}
          {activeConfigTab === 'system' && (
            <div className="space-y-6">
              <div className="bg-[#2E2410]/20 border border-[#C9862E]/50 rounded-lg p-6">
                <h3 className="text-xl font-bold text-white mb-4 flex items-center gap-2">
                  <Cpu className="w-6 h-6 text-[#F0A73C]" />
                  System Parameters
                </h3>
                <div className="grid grid-cols-2 gap-6">
                  <div>
                    <label className="block text-sm font-semibold text-[#C4B9AB] mb-2">Default Pulse Width (μs)</label>
                    <input type="number" defaultValue="50"
                      className="w-full bg-[#241E19] border border-[#38302A] rounded-lg px-4 py-3 text-white" />
                    <p className="text-xs text-[#786D60] mt-2">Wiegand pulse duration in microseconds</p>
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-[#C4B9AB] mb-2">Inter-Pulse Delay (ms)</label>
                    <input type="number" defaultValue="2"
                      className="w-full bg-[#241E19] border border-[#38302A] rounded-lg px-4 py-3 text-white" />
                    <p className="text-xs text-[#786D60] mt-2">Delay between Wiegand pulses</p>
                  </div>
                </div>
                <div className="border-t border-[#4A3F36] pt-4 mt-4">
                  <h4 className="text-lg font-semibold text-white mb-3">Configuration Management</h4>
                  <div className="grid grid-cols-3 gap-4">
                    <button onClick={onExportConfig}
                      className="px-4 py-3 bg-[#4E9E98] hover:bg-[#3E827D] rounded-lg font-semibold flex items-center justify-center gap-2">
                      <Download size={20} />Export Config
                    </button>
                    <label className="px-4 py-3 bg-[#4F8B5C] hover:bg-[#3E6E48] rounded-lg font-semibold flex items-center justify-center gap-2 cursor-pointer">
                      <Upload size={20} />Import Config
                      <input type="file" accept=".json" onChange={handleImportConfig} className="hidden" />
                    </label>
                    <button onClick={onResetConfig}
                      className="px-4 py-3 bg-[#C6604F] hover:bg-[#A84E3F] rounded-lg font-semibold flex items-center justify-center gap-2">
                      <RotateCcw size={20} />Reset to Defaults
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── SEQUENT CHANNELOUT ────────────────────────────────────── */}
          {activeConfigTab === 'gpio' && (
            <div className="space-y-6">
              <div className="bg-[#1F1912]/50 border border-[#4A3F36] rounded-lg p-6">
                <h3 className="text-xl font-bold text-white mb-4 flex items-center gap-2">
                  <Zap className="w-6 h-6 text-[#E6C766]" />
                  Raspberry Pi Sequent Channelout Reference
                </h3>
                <GpioPinoutDiagram />
              </div>
            </div>
          )}

          {/* ── VMS DISPLAY ───────────────────────────────────────────── */}
          {activeConfigTab === 'vms' && (
            <div className="space-y-6">
              <VMSDisplayConfig />
            </div>
          )}

        </div>
      </div>
    </div>
  );
};

export default ConfigSection;
