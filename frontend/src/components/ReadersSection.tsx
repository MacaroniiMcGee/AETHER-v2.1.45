// ReadersSection.tsx - Unified Reader Management with NFC Integration
// Combines OSDP, NFC (currently disabled), and Wiegand readers in one interface.
//
// NFC is currently HIDDEN from the UI via the FEATURES flag below.
// All NFC code (NFCSection.tsx, server routes, PN532Manager, NFCOSDPBridge)
// is left intact on disk — re-enable by flipping FEATURES.NFC to true.

import React, { useState, useEffect } from 'react';
import { Radio, CreditCard, Smartphone, Wrench } from 'lucide-react';
import WiegandEmulator from './readers/WiegandEmulator';
import ReaderTools from './readers/ReaderTools';
import { useFormatLibrary } from './readers/formatLib';

// Import existing sections
import OSDPSection from './OSDPSection';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import NFCSection from './NFCSection';      // kept imported behind feature flag
// WiegandSection.tsx (old Wiegand page) is kept on disk but no longer shown;
// readers/WiegandEmulator.tsx replaces it.

// ============================================================
// FEATURE FLAGS — flip NFC to true to bring it back into the UI
// ============================================================
const FEATURES = {
  NFC: false,
} as const;


interface ReadersSectionProps {
  ipAddress: string;
  connected: boolean;
  onLog: (message: string) => void;
}

interface ReaderStats {
  osdp: {
    connected: number;
    total: number;
    serialOpen: boolean;
  };
  nfc: {
    enabled: boolean;
    connected: boolean;
    reading: boolean;
  };
  wiegand: {
    readers: number;
    active: number;
  };
}

export default function ReadersSection({ ipAddress, connected, onLog }: ReadersSectionProps) {
  const [activeTab, setActiveTabRaw] = useState<'osdp' | 'nfc' | 'wiegand' | 'builder'>(() => {
    try { const t = sessionStorage.getItem('aether.readers.tab'); if (t === 'wiegand' || t === 'builder' || t === 'osdp') return t; } catch { /* */ }
    return 'osdp';
  });
  const setActiveTab = (t: 'osdp' | 'nfc' | 'wiegand' | 'builder') => { setActiveTabRaw(t); try { sessionStorage.setItem('aether.readers.tab', t); } catch { /* */ } };
  const [stats, setStats] = useState<ReaderStats>({
    osdp: { connected: 0, total: 0, serialOpen: false },
    nfc: { enabled: false, connected: false, reading: false },
    wiegand: { readers: 0, active: 0 }
  });

  const backendUrl = `http://${ipAddress}:3001`;
  const lib = useFormatLibrary(backendUrl);

  // Fetch statistics for all reader types
  useEffect(() => {
    if (!connected) return;

    const fetchStats = async () => {
      try {
        // OSDP stats — readers array lives on /api/osdp/readers, init flag on /api/osdp/status
        const [readersRes, statusRes] = await Promise.all([
          fetch(`${backendUrl}/api/osdp/readers`),
          fetch(`${backendUrl}/api/osdp/status`),
        ]);
        if (readersRes.ok && statusRes.ok) {
          const readersData = await readersRes.json();
          const statusData = await statusRes.json();
          const list: any[] = readersData.readers || [];
          setStats(prev => ({
            ...prev,
            osdp: {
              connected: list.filter((r: any) => r.enabled).length,
              total: list.length,
              serialOpen: !!statusData.status?.initialized,
            },
          }));
        }

        // NFC stats — only poll when feature is enabled (saves a request)
        if (FEATURES.NFC) {
          const nfcRes = await fetch(`${backendUrl}/api/nfc/status`);
          if (nfcRes.ok) {
            const nfcData = await nfcRes.json();
            if (nfcData.success) {
              setStats(prev => ({
                ...prev,
                nfc: {
                  enabled: nfcData.enabled || false,
                  connected: nfcData.status?.connected || false,
                  reading: nfcData.status?.reading || false
                }
              }));
            }
          }
        }

        // Wiegand stats
        const wiegandRes = await fetch(`${backendUrl}/api/wiegand/readers`);
        if (wiegandRes.ok) {
          const wiegandData = await wiegandRes.json();
          if (wiegandData.success) {
            const rs: any[] = wiegandData.readers || [];
            setStats(prev => ({ ...prev, wiegand: { readers: rs.length, active: rs.filter((r: any) => r.enabled).length } }));
          }
        }
      } catch (err) {
        console.error('[Readers] Failed to fetch stats:', err);
      }
    };

    fetchStats();
    const interval = setInterval(fetchStats, 3000);
    return () => clearInterval(interval);
  }, [backendUrl, connected]);

  // If NFC gets disabled while the user happens to be on the NFC tab
  // (e.g. stale state in dev hot-reload), fall back to OSDP rather than
  // showing a blank content area.
  useEffect(() => {
    if (!FEATURES.NFC && activeTab === 'nfc') {
      setActiveTab('osdp');
    }
  }, [activeTab]);

  const tabs: { id: 'osdp' | 'nfc' | 'wiegand' | 'builder'; label: string; sub: string; icon: React.ReactNode; show: boolean }[] = [
    { id: 'osdp', label: 'OSDP', sub: `${stats.osdp.connected}/${stats.osdp.total} active${stats.osdp.serialOpen ? ' · RS-485 open' : ''}`, icon: <Radio size={18} />, show: true },
    { id: 'wiegand', label: 'Wiegand', sub: `${stats.wiegand.active} of ${stats.wiegand.readers} readers`, icon: <CreditCard size={18} />, show: true },
    { id: 'nfc', label: 'NFC', sub: stats.nfc.connected ? 'PN532 connected' : 'Off', icon: <Smartphone size={18} />, show: FEATURES.NFC },
    { id: 'builder', label: 'Tools', sub: 'Trace · formats · firmware · bus', icon: <Wrench size={18} />, show: true },
  ];

  return (
    <div className="space-y-5">
      {/* Header: the protocol tabs */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3" style={{ background: 'rgb(var(--hv-widget) / 0.5)', borderColor: 'rgb(var(--hv-line))' }}>
        <h2 className="text-lg font-bold mr-2" style={{ color: 'rgb(var(--hv-text))' }}>Readers</h2>
        <nav className="flex flex-wrap gap-2 flex-1" role="tablist">
          {tabs.filter(t => t.show).map(t => {
            const on = activeTab === t.id;
            return (
              <button key={t.id} role="tab" aria-selected={on} onClick={() => setActiveTab(t.id)}
                className="flex items-center gap-2.5 px-3.5 py-2 rounded-lg text-left transition-colors"
                style={on ? { background: 'rgb(var(--hv-popup-panel))', boxShadow: 'inset 0 -2px 0 rgb(var(--hv-brand))', color: 'rgb(var(--hv-text))' } : { color: 'rgb(var(--hv-text-3))' }}>
                <span style={{ color: on ? 'rgb(var(--hv-brand))' : 'rgb(var(--hv-text-3))' }}>{t.icon}</span>
                <span>
                  <span className="block text-sm font-bold leading-tight">{t.label}</span>
                  <span className="block text-[11px] leading-tight" style={{ color: on ? 'rgb(var(--hv-text-2))' : 'rgb(var(--hv-text-3))' }}>{t.sub}</span>
                </span>
              </button>
            );
          })}
        </nav>
        {!connected && <span className="px-3 py-1.5 rounded-lg text-sm font-semibold" style={{ background: 'rgb(var(--hv-error-strong) / 0.15)', color: 'rgb(var(--hv-error-fg))', border: '1px solid rgb(var(--hv-error-strong))' }}>Disconnected</span>}
        {lib.error && <span className="text-xs" style={{ color: 'rgb(var(--hv-warning-fg))' }}>Formats not loaded: {lib.error}</span>}
      </div>

      {/* Content Area */}
      <div>
        {activeTab === 'osdp' && (
          <OSDPSection 
            ipAddress={ipAddress} 
            connected={connected} 
            onLog={onLog} 
          />
        )}

        {FEATURES.NFC && activeTab === 'nfc' && (
          <NFCSection 
            ipAddress={ipAddress}
            connected={connected}
            onLog={onLog}
          />
        )}

        {activeTab === 'wiegand' && (
          <WiegandEmulator api={backendUrl} formats={lib.formats} reload={lib.reload} connected={connected} onLog={onLog} />
        )}

        {activeTab === 'builder' && (
          <ReaderTools api={backendUrl} formats={lib.formats} reload={lib.reload} connected={connected} onLog={onLog} />
        )}
      </div>
    </div>
  );
}
