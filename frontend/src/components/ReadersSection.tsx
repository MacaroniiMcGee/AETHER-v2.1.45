// ReadersSection.tsx - Unified Reader Management with NFC Integration
// Combines OSDP, NFC (currently disabled), and Wiegand readers in one interface.
//
// NFC is currently HIDDEN from the UI via the FEATURES flag below.
// All NFC code (NFCSection.tsx, server routes, PN532Manager, NFCOSDPBridge)
// is left intact on disk — re-enable by flipping FEATURES.NFC to true.

import React, { useState, useEffect } from 'react';
import WiegandEmulator from './readers/WiegandEmulator';
import ReaderTools from './readers/ReaderTools';
import OsdpTrace from './readers/OsdpTrace';
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
export const FEATURES = {
  NFC: false,
} as const;


// AETHER-GNB-2DEPTH: the page is chosen in the GNB (Readers › OSDP · OSDP Trace · Wiegand · Card Formats · NFC).
export type ReadersPage = 'osdp' | 'trace' | 'wiegand' | 'formats' | 'nfc';

interface ReadersSectionProps {
  ipAddress: string;
  connected: boolean;
  onLog: (message: string) => void;
  page: ReadersPage;
  /** Live counts for the GNB badges and the page description. */
  onStats?: (s: ReaderStats) => void;
  [k: string]: any;   // the parent still passes the legacy reader-pool props
}

export interface ReaderStats {
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

export default function ReadersSection({ ipAddress, connected, onLog, page, onStats }: ReadersSectionProps) {
  const [stats, setStats] = useState<ReaderStats>({
    osdp: { connected: 0, total: 0, serialOpen: false },
    nfc: { enabled: false, connected: false, reading: false },
    wiegand: { readers: 0, active: 0 }
  });
  useEffect(() => { onStats?.(stats); }, [stats]);   // eslint-disable-line react-hooks/exhaustive-deps

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

  // NFC hidden by the feature flag → show OSDP instead of a blank page.
  const shown: ReadersPage = !FEATURES.NFC && page === 'nfc' ? 'osdp' : page;

  return (
    <div className="space-y-5">
      {lib.error && (shown === 'wiegand' || shown === 'formats') && (
        <div className="px-3 py-2 rounded-lg text-xs" style={{ color: 'rgb(var(--hv-warning-fg))', background: 'rgb(var(--hv-warning-tint))' }}>Formats not loaded: {lib.error}</div>
      )}

      {shown === 'osdp' && (
        <OSDPSection
          ipAddress={ipAddress}
          connected={connected}
          onLog={onLog}
        />
      )}

      {shown === 'trace' && <OsdpTrace api={backendUrl} />}

      {FEATURES.NFC && shown === 'nfc' && (
        <NFCSection
          ipAddress={ipAddress}
          connected={connected}
          onLog={onLog}
        />
      )}

      {shown === 'wiegand' && (
        <WiegandEmulator api={backendUrl} formats={lib.formats} reload={lib.reload} connected={connected} onLog={onLog} />
      )}

      {shown === 'formats' && (
        <ReaderTools api={backendUrl} formats={lib.formats} reload={lib.reload} connected={connected} onLog={onLog} />
      )}
    </div>
  );
}
