// ReadersSection.tsx - Unified Reader Management with NFC Integration
// Combines OSDP, NFC (currently disabled), and Wiegand readers in one interface.
//
// NFC is currently HIDDEN from the UI via the FEATURES flag below.
// All NFC code (NFCSection.tsx, server routes, PN532Manager, NFCOSDPBridge)
// is left intact on disk — re-enable by flipping FEATURES.NFC to true.

import React, { useState, useEffect } from 'react';
import { Radio, Wifi, CreditCard, Smartphone } from 'lucide-react';

// Import existing sections
import OSDPSection from './OSDPSection';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import NFCSection from './NFCSection';      // kept imported behind feature flag
import WiegandSection from './WiegandSection';

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
  const [activeTab, setActiveTab] = useState<'osdp' | 'nfc' | 'wiegand'>('osdp');
  const [stats, setStats] = useState<ReaderStats>({
    osdp: { connected: 0, total: 0, serialOpen: false },
    nfc: { enabled: false, connected: false, reading: false },
    wiegand: { readers: 0, active: 0 }
  });

  const backendUrl = `http://${ipAddress}:3001`;

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
        const wiegandRes = await fetch(`${backendUrl}/api/wiegand/status`);
        if (wiegandRes.ok) {
          const wiegandData = await wiegandRes.json();
          if (wiegandData.success) {
            setStats(prev => ({
              ...prev,
              wiegand: {
                readers: wiegandData.readers?.length || 0,
                active: wiegandData.readers?.filter((r: any) => r.enabled).length || 0
              }
            }));
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

  // Grid columns adapt to how many cards are visible
  const gridColsClass = FEATURES.NFC
    ? 'grid-cols-1 md:grid-cols-3'
    : 'grid-cols-1 md:grid-cols-2';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="rounded-xl p-6 border border-[#38302A]">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-3xl font-bold text-white flex items-center gap-2">
               Reader Management
            </h1>
            <p className="text-[#ADA294] mt-1">
              {FEATURES.NFC
                ? 'Control, Configure and Simulate OSDP, NFC, and Wiegand readers'
                : 'Control, Configure and Simulate OSDP and Wiegand readers'}
            </p>
          </div>
          {!connected && (
            <div className="px-4 py-2 bg-[#C6604F]/20 border border-[#C6604F] rounded-lg">
              <span className="text-[#E0705F] font-semibold">Disconnected</span>
            </div>
          )}
        </div>

        {/* Reader Type Cards — these ARE the tab selector. A second row of
            buttons beneath duplicated the same three actions, so it was
            removed; the cards carry the live counts as well. */}
        <div className={`grid ${gridColsClass} gap-4`}>
          {/* OSDP Card */}
          <button
            onClick={() => setActiveTab('osdp')}
            className={`p-6 rounded-lg border-2 transition-all text-left bg-transparent ${
              activeTab === 'osdp'
                ? 'border-[#5FB7B0] shadow-lg shadow-[#5FB7B0]/20'
                : 'border-[#4A3F36] hover:border-[#786D60]'
            }`}
          >
            <div className="flex items-center justify-between mb-3">
              <Radio className={`w-8 h-8 ${
                activeTab === 'osdp' ? 'text-[#5FB7B0]' : 'text-[#ADA294]'
              }`} />
              {stats.osdp.serialOpen && (
                <span className="px-2 py-1 bg-[#6FBF7E]/20 text-[#7BD497] text-xs rounded-full border border-[#6FBF7E]">
                  ● RS485 Active
                </span>
              )}
            </div>
            <h3 className="text-lg font-semibold text-white mb-2">OSDP Readers</h3>
            <p className="text-sm text-[#ADA294]">
              {stats.osdp.connected} of {stats.osdp.total} active
            </p>
            <div className="mt-3 text-xs text-[#786D60]">
              RS485 Protocol • ACS Panels
            </div>
          </button>

          {/* NFC Card — feature-flagged */}
          {FEATURES.NFC && (
            <button
              onClick={() => setActiveTab('nfc')}
              className={`p-6 rounded-lg border-2 transition-all text-left bg-transparent ${
                activeTab === 'nfc'
                  ? 'border-[#8FB488] shadow-lg shadow-[#8FB488]/20'
                  : 'border-[#4A3F36] hover:border-[#786D60]'
              }`}
            >
              <div className="flex items-center justify-between mb-3">
                <Smartphone className={`w-8 h-8 ${
                  activeTab === 'nfc' ? 'text-[#8FB488]' : 'text-[#ADA294]'
                }`} />
                {stats.nfc.reading && (
                  <span className="px-2 py-1 bg-[#5FB7B0]/20 text-[#5FB7B0] text-xs rounded-full border border-[#5FB7B0] animate-pulse">
                    📡 Reading
                  </span>
                )}
              </div>
              <h3 className="text-lg font-semibold text-white mb-2">NFC Reader</h3>
              <p className="text-sm text-[#ADA294]">
                {stats.nfc.connected ? '✓ PN532 Connected' : stats.nfc.enabled ? 'Enabled' : 'Disabled'}
              </p>
              <div className="mt-3 text-xs text-[#786D60]">
                I2C Protocol • MIFARE/NFC Cards
              </div>
            </button>
          )}

          {/* Wiegand Card */}
          <button
            onClick={() => setActiveTab('wiegand')}
            className={`p-6 rounded-lg border-2 transition-all text-left bg-transparent ${
              activeTab === 'wiegand'
                ? 'border-[#6FBF7E] shadow-lg shadow-[#6FBF7E]/20'
                : 'border-[#4A3F36] hover:border-[#786D60]'
            }`}
          >
            <div className="flex items-center justify-between mb-3">
              <CreditCard className={`w-8 h-8 ${
                activeTab === 'wiegand' ? 'text-[#7BD497]' : 'text-[#ADA294]'
              }`} />
              {stats.wiegand.active > 0 && (
                <span className="px-2 py-1 bg-[#5FB7B0]/20 text-[#5FB7B0] text-xs rounded-full border border-[#5FB7B0]">
                  {stats.wiegand.active} Active
                </span>
              )}
            </div>
            <h3 className="text-lg font-semibold text-white mb-2">Wiegand Readers</h3>
            <p className="text-sm text-[#ADA294]">
              {stats.wiegand.readers} reader{stats.wiegand.readers !== 1 ? 's' : ''} configured
            </p>
            <div className="mt-3 text-xs text-[#786D60]">
              GPIO Protocol • Legacy Support
            </div>
          </button>
        </div>
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
          // FIX: WiegandSection's actual signature is { apiUrl?: string }.
          // Previously this was passing ipAddress/connected/onLog which were
          // silently ignored, causing apiUrl to fall back to localhost:3001.
          // That broke any client not running on the same host as the backend.
          <WiegandSection apiUrl={backendUrl} />
        )}
      </div>
    </div>
  );
}
