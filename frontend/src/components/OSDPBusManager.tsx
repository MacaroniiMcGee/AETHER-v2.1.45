// OSDPBusManager.tsx
//
// Self-contained consolidated layout for managing RS485 buses, readers, and
// per-reader settings (SCBK included). Replaces the standalone sections:
//   - RS485 Interfaces
//   - Change Baud Rate
//   - Add Reader
//   - Reader Tables (per-bus)
//   - Custom SCBK
//
// Drop into:  frontend/src/components/OSDPBusManager.tsx
// Import as:  import OSDPBusManager from './OSDPBusManager';
// Render as:  <OSDPBusManager apiUrl={apiUrl} onLog={addHistory} />
//
// Backend endpoints used (all pre-existing in routes-osdp.js):
//   GET    /api/osdp/interfaces       - list buses
//   GET    /api/osdp/detect           - rescan for buses
//   GET    /api/osdp/readers          - list readers
//   POST   /api/osdp/reader           - add reader  { name, address, serialPort, secureChannel, capabilities[] }
//   PATCH  /api/osdp/reader/:id       - update reader { enabled?, secureChannel?, name?, address?, capabilities?[] }
//   DELETE /api/osdp/reader/:id       - delete reader
//   POST   /api/osdp/baudrate         - change baud  { port, baudRate }
//   POST   /api/osdp/security/keyset  - set SCBK     { address, key }

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown, ChevronRight, Plus, Edit2, Trash2, Cpu, Usb, Save, X,
  Download, Upload, RefreshCw, Lock, Unlock, AlertCircle, Check,
  Dices, Eye, EyeOff,
} from 'lucide-react';

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

type OSDPReader = {
  id: string;
  name: string;
  address: number;
  enabled: boolean;
  status: string;
  capabilities: string[];
  secureChannel: boolean;
  secureChannelEstablished?: boolean;
  serialPort?: string;
  baudRate?: number;
  scbkConfigured?: boolean;
};

type DetectedInterface = {
  id: string;
  name: string;
  port: string;
  type: 'usb' | 'onboard' | 'spi';
  online: boolean;
  baudRate: number;
  readerRange?: string;
};

type EditDraft = {
  name: string;
  address: number;
  enabled: boolean;
  capabilities: { LED: boolean; BUZZER: boolean; CARD: boolean; KEYPAD: boolean };
  secureChannel: boolean;
  scbkHex: string;        // optional new SCBK to set on save
};

type AddDraft = {
  name: string;
  address: number;
  capabilities: { LED: boolean; BUZZER: boolean; CARD: boolean; KEYPAD: boolean };
  secureChannel: boolean;
};

type ImportPreview = {
  toAdd: Array<{ port: string; address: number; name: string }>;
  toUpdate: Array<{ id: string; port: string; address: number; name: string; changes: string[] }>;
  toDelete: Array<{ id: string; port: string; address: number; name: string }>;
};

interface Props {
  apiUrl: string;
  onLog?: (msg: string) => void;
}

const BAUD_OPTIONS = [9600, 19200, 38400, 57600, 115200];
const COLLAPSE_STORAGE_KEY = 'osdp-bus-collapse-state';

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

const fmtAddr = (a: number) => `0x${a.toString(16).padStart(2, '0').toUpperCase()}`;

const hasCap = (caps: string[] | undefined, name: string) =>
  Array.isArray(caps) && caps.includes(name);

const capsToObject = (caps: string[]) => ({
  LED:    hasCap(caps, 'LED'),
  BUZZER: hasCap(caps, 'BUZZER'),
  CARD:   hasCap(caps, 'CARD'),
  KEYPAD: hasCap(caps, 'KEYPAD'),
});

const capsObjectToArray = (o: EditDraft['capabilities']) =>
  Object.entries(o).filter(([_, v]) => v).map(([k]) => k);

const randomScbk = () => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
};

const isValidScbk = (s: string) => /^[0-9a-fA-F]{32}$/.test(s.trim());

// ───────────────────────────────────────────────────────────────────────────
// Main component
// ───────────────────────────────────────────────────────────────────────────

export default function OSDPBusManager({ apiUrl, onLog }: Props) {
  const log = useCallback((msg: string) => onLog?.(msg), [onLog]);

  const [interfaces, setInterfaces] = useState<DetectedInterface[]>([]);
  const [readers, setReaders] = useState<OSDPReader[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState<string | null>(null);

  // Persistent collapse state per port
  const [collapsedBuses, setCollapsedBuses] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(COLLAPSE_STORAGE_KEY);
      return new Set(raw ? JSON.parse(raw) : []);
    } catch { return new Set(); }
  });
  useEffect(() => {
    try { localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(Array.from(collapsedBuses))); }
    catch { /* swallow */ }
  }, [collapsedBuses]);

  // Inline edit / add state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding,    setAdding]    = useState<string | null>(null);   // port path of the bus showing the add form

  // Top-right import/export UI
  const [importPreview, setImportPreview] = useState<{ data: any; preview: ImportPreview } | null>(null);
  const [importReplaceAll, setImportReplaceAll] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Data loading ────────────────────────────────────────────────────────
  const refreshAll = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [ifRes, rRes] = await Promise.all([
        fetch(`${apiUrl}/api/osdp/interfaces`),
        fetch(`${apiUrl}/api/osdp/readers`),
      ]);
      const ifJson = await ifRes.json();
      const rJson  = await rRes.json();
      if (ifJson.interfaces) setInterfaces(ifJson.interfaces);
      if (rJson.readers)     setReaders(rJson.readers);
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [apiUrl]);

  useEffect(() => {
    refreshAll();
    const t = window.setInterval(refreshAll, 5000);
    return () => window.clearInterval(t);
  }, [refreshAll]);

  // ── Group readers by bus ────────────────────────────────────────────────
  const readersByPort = useMemo(() => {
    const map: Record<string, OSDPReader[]> = {};
    for (const iface of interfaces) map[iface.port] = [];
    for (const r of readers) {
      const port = r.serialPort || 'unknown';
      if (!map[port]) map[port] = [];
      map[port].push(r);
    }
    Object.values(map).forEach(list => list.sort((a, b) => a.address - b.address));
    return map;
  }, [readers, interfaces]);

  // ── Bus actions ─────────────────────────────────────────────────────────
  const toggleCollapse = (port: string) => {
    setCollapsedBuses(prev => {
      const next = new Set(prev);
      next.has(port) ? next.delete(port) : next.add(port);
      return next;
    });
  };

  const changeBaud = async (port: string, baud: number) => {
    try {
      const r = await fetch(`${apiUrl}/api/osdp/baudrate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port, baudRate: baud }),
      });
      const j = await r.json();
      if (j.success) { log(`✓ ${port} → ${baud} baud`); await refreshAll(); }
      else log(`✗ ${j.error || 'baud change failed'}`);
    } catch (e: any) { log(`✗ ${e.message}`); }
  };

  const rescan = async () => {
    setLoading(true);
    try {
      await fetch(`${apiUrl}/api/osdp/detect`);
      await refreshAll();
      log('✓ Re-scanned interfaces');
    } catch (e: any) { log(`✗ ${e.message}`); }
    finally { setLoading(false); }
  };

  // ── Reader actions ──────────────────────────────────────────────────────
  const deleteReader = async (id: string, name: string) => {
    if (!window.confirm(`Delete reader "${name}"? This cannot be undone.`)) return;
    try {
      const r = await fetch(`${apiUrl}/api/osdp/reader/${id}`, { method: 'DELETE' });
      const j = await r.json();
      if (j.success) { log(`✓ Deleted ${name}`); await refreshAll(); }
      else log(`✗ ${j.error}`);
    } catch (e: any) { log(`✗ ${e.message}`); }
  };

  const saveReader = async (id: string, draft: EditDraft, original: OSDPReader) => {
    const updates: Record<string, any> = {};
    if (draft.name    !== original.name)    updates.name    = draft.name;
    if (draft.address !== original.address) updates.address = draft.address;
    if (draft.enabled !== original.enabled) updates.enabled = draft.enabled;
    if (draft.secureChannel !== original.secureChannel) updates.secureChannel = draft.secureChannel;
    const newCaps = capsObjectToArray(draft.capabilities);
    const sameCaps = newCaps.length === original.capabilities.length
      && newCaps.every(c => original.capabilities.includes(c));
    if (!sameCaps) updates.capabilities = newCaps;

    try {
      if (Object.keys(updates).length > 0) {
        const r = await fetch(`${apiUrl}/api/osdp/reader/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updates),
        });
        const j = await r.json();
        if (!j.success) { log(`✗ ${j.error || 'update failed'}`); return; }
      }

      // SCBK is a separate endpoint
      if (draft.scbkHex.trim() && isValidScbk(draft.scbkHex)) {
        const r2 = await fetch(`${apiUrl}/api/osdp/security/keyset`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: draft.address, key: draft.scbkHex.trim() }),
        });
        const j2 = await r2.json();
        if (!j2.success) { log(`✗ SCBK: ${j2.error}`); return; }
      }

      log(`✓ Saved ${draft.name}`);
      setEditingId(null);
      await refreshAll();
    } catch (e: any) {
      log(`✗ ${e.message}`);
    }
  };

  const addReader = async (port: string, draft: AddDraft) => {
    if (!draft.name.trim()) { log('✗ Name required'); return; }
    try {
      const r = await fetch(`${apiUrl}/api/osdp/reader`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: draft.name.trim(),
          address: draft.address,
          serialPort: port,
          secureChannel: draft.secureChannel,
          capabilities: capsObjectToArray(draft.capabilities),
        }),
      });
      const j = await r.json();
      if (j.success) {
        log(`✓ Added ${draft.name} at ${fmtAddr(draft.address)}`);
        setAdding(null);
        await refreshAll();
      } else log(`✗ ${j.error}`);
    } catch (e: any) { log(`✗ ${e.message}`); }
  };

  // ── Import / Export ─────────────────────────────────────────────────────
  const handleExport = () => {
    const data = {
      version: 1,
      exportedAt: new Date().toISOString(),
      buses: interfaces.map(iface => ({
        port:    iface.port,
        name:    iface.name,
        baud:    iface.baudRate,
        readers: (readersByPort[iface.port] || []).map(r => ({
          name:          r.name,
          address:       r.address,
          enabled:       r.enabled,
          capabilities:  r.capabilities,
          secureChannel: r.secureChannel,
        })),
      })),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `osdp-readers-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    log(`✓ Exported ${readers.length} readers across ${interfaces.length} buses`);
  };

  const handleImportFile = async (file: File) => {
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data.buses || !Array.isArray(data.buses)) throw new Error('Invalid export file: missing buses[]');

      const preview: ImportPreview = { toAdd: [], toUpdate: [], toDelete: [] };
      const importedKeys = new Set<string>();

      for (const bus of data.buses) {
        for (const r of (bus.readers || [])) {
          const key = `${bus.port}:${r.address}`;
          importedKeys.add(key);
          const existing = readers.find(x => x.serialPort === bus.port && x.address === r.address);
          if (!existing) {
            preview.toAdd.push({ port: bus.port, address: r.address, name: r.name });
          } else {
            const changes: string[] = [];
            if (r.name !== existing.name) changes.push(`name "${existing.name}"→"${r.name}"`);
            if (!!r.enabled !== !!existing.enabled) changes.push(`enabled ${existing.enabled}→${r.enabled}`);
            if (!!r.secureChannel !== !!existing.secureChannel) changes.push(`secureChannel ${existing.secureChannel}→${r.secureChannel}`);
            if (changes.length > 0) {
              preview.toUpdate.push({ id: existing.id, port: bus.port, address: r.address, name: r.name, changes });
            }
          }
        }
      }

      if (importReplaceAll) {
        for (const r of readers) {
          const key = `${r.serialPort}:${r.address}`;
          if (!importedKeys.has(key)) {
            preview.toDelete.push({ id: r.id, port: r.serialPort || '?', address: r.address, name: r.name });
          }
        }
      }

      setImportPreview({ data, preview });
    } catch (e: any) {
      log(`✗ Import parse failed: ${e.message}`);
    }
  };

  const applyImport = async () => {
    if (!importPreview) return;
    const { preview } = importPreview;
    let ok = 0, fail = 0;

    for (const d of preview.toDelete) {
      try {
        const r = await fetch(`${apiUrl}/api/osdp/reader/${d.id}`, { method: 'DELETE' });
        const j = await r.json();
        j.success ? ok++ : fail++;
      } catch { fail++; }
    }

    for (const bus of importPreview.data.buses) {
      for (const r of (bus.readers || [])) {
        const existing = readers.find(x => x.serialPort === bus.port && x.address === r.address);
        try {
          if (!existing) {
            const res = await fetch(`${apiUrl}/api/osdp/reader`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                name: r.name, address: r.address, serialPort: bus.port,
                secureChannel: !!r.secureChannel,
                capabilities: r.capabilities || ['LED','BUZZER','CARD','KEYPAD'],
              }),
            });
            const j = await res.json();
            j.success ? ok++ : fail++;
          } else {
            const res = await fetch(`${apiUrl}/api/osdp/reader/${existing.id}`, {
              method: 'PATCH', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                name: r.name, enabled: !!r.enabled,
                secureChannel: !!r.secureChannel,
                capabilities: r.capabilities || existing.capabilities,
              }),
            });
            const j = await res.json();
            j.success ? ok++ : fail++;
          }
        } catch { fail++; }
      }
    }

    log(`✓ Import complete — ${ok} ok, ${fail} failed`);
    setImportPreview(null);
    setImportReplaceAll(false);
    await refreshAll();
  };

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {/* Top bar with title + import/export */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Cpu className="text-purple-400" size={18} />
          <h3 className="text-base font-medium text-gray-100">Bus &amp; Reader Manager</h3>
          <span className="text-xs text-gray-500">
            {interfaces.length} bus{interfaces.length === 1 ? '' : 'es'} · {readers.length} reader{readers.length === 1 ? '' : 's'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={rescan} disabled={loading}
            className="px-3 py-1.5 text-xs text-gray-300 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded flex items-center gap-1.5 disabled:opacity-50">
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Rescan
          </button>
          <button onClick={handleExport}
            className="px-3 py-1.5 text-xs text-blue-300 bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/40 rounded flex items-center gap-1.5">
            <Download size={12} /> Export
          </button>
          <button onClick={() => fileInputRef.current?.click()}
            className="px-3 py-1.5 text-xs text-blue-300 bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/40 rounded flex items-center gap-1.5">
            <Upload size={12} /> Import
          </button>
          <input
            ref={fileInputRef} type="file" accept=".json,application/json" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImportFile(f); e.target.value = ''; }}
          />
        </div>
      </div>

      {error && (
        <div className="px-3 py-2 rounded bg-red-500/10 border border-red-500/30 text-red-300 text-xs flex items-center gap-2">
          <AlertCircle size={14} /> {error}
        </div>
      )}

      {/* Bus cards */}
      {interfaces.map(iface => (
        <BusCard
          key={iface.id}
          iface={iface}
          readers={readersByPort[iface.port] || []}
          collapsed={collapsedBuses.has(iface.port)}
          onToggleCollapse={() => toggleCollapse(iface.port)}
          onChangeBaud={(b) => changeBaud(iface.port, b)}
          editingId={editingId}
          onStartEdit={(id) => setEditingId(id)}
          onCancelEdit={() => setEditingId(null)}
          onSaveEdit={saveReader}
          onDelete={deleteReader}
          adding={adding === iface.port}
          onStartAdd={() => setAdding(iface.port)}
          onCancelAdd={() => setAdding(null)}
          onAddReader={(draft) => addReader(iface.port, draft)}
        />
      ))}

      {interfaces.length === 0 && !loading && (
        <div className="px-4 py-8 text-center text-sm text-gray-400 border border-gray-800 rounded-lg">
          No interfaces detected. Plug in a USB-RS485 module or hit Rescan.
        </div>
      )}

      {/* Import preview modal */}
      {importPreview && (
        <ImportPreviewModal
          preview={importPreview.preview}
          replaceAll={importReplaceAll}
          onToggleReplaceAll={(v) => {
            setImportReplaceAll(v);
            // Recompute preview with new flag against the same data
            const data = importPreview.data;
            const newPreview: ImportPreview = { toAdd: [], toUpdate: [], toDelete: [] };
            const keys = new Set<string>();
            for (const bus of data.buses) {
              for (const r of (bus.readers || [])) {
                const k = `${bus.port}:${r.address}`;
                keys.add(k);
                const existing = readers.find(x => x.serialPort === bus.port && x.address === r.address);
                if (!existing) newPreview.toAdd.push({ port: bus.port, address: r.address, name: r.name });
                else {
                  const changes: string[] = [];
                  if (r.name !== existing.name) changes.push('name');
                  if (!!r.enabled !== !!existing.enabled) changes.push('enabled');
                  if (!!r.secureChannel !== !!existing.secureChannel) changes.push('secureChannel');
                  if (changes.length) newPreview.toUpdate.push({ id: existing.id, port: bus.port, address: r.address, name: r.name, changes });
                }
              }
            }
            if (v) {
              for (const r of readers) {
                const k = `${r.serialPort}:${r.address}`;
                if (!keys.has(k)) newPreview.toDelete.push({ id: r.id, port: r.serialPort || '?', address: r.address, name: r.name });
              }
            }
            setImportPreview({ data, preview: newPreview });
          }}
          onCancel={() => { setImportPreview(null); setImportReplaceAll(false); }}
          onApply={applyImport}
        />
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Bus card — header + collapsible body
// ───────────────────────────────────────────────────────────────────────────

function BusCard(props: {
  iface: DetectedInterface;
  readers: OSDPReader[];
  collapsed: boolean;
  onToggleCollapse: () => void;
  onChangeBaud: (b: number) => void;
  editingId: string | null;
  onStartEdit: (id: string) => void;
  onCancelEdit: () => void;
  onSaveEdit: (id: string, draft: EditDraft, original: OSDPReader) => void;
  onDelete: (id: string, name: string) => void;
  adding: boolean;
  onStartAdd: () => void;
  onCancelAdd: () => void;
  onAddReader: (draft: AddDraft) => void;
}) {
  const { iface, readers, collapsed } = props;
  const Icon = iface.type === 'onboard' ? Cpu : Usb;
  const onlineCls = iface.online
    ? 'border-emerald-500/40 bg-emerald-500/5'
    : 'border-gray-700 bg-gray-900/40';

  const [draftBaud, setDraftBaud] = useState(iface.baudRate || 9600);
  useEffect(() => { setDraftBaud(iface.baudRate || 9600); }, [iface.baudRate]);

  return (
    <div className={`border rounded-lg ${onlineCls} overflow-hidden`}>
      {/* Header */}
      <button
        onClick={props.onToggleCollapse}
        className="w-full px-4 py-3 flex items-center gap-3 hover:bg-white/5 text-left"
      >
        {collapsed ? <ChevronRight size={16} className="text-gray-500"/> : <ChevronDown size={16} className="text-gray-500"/>}
        <Icon size={18} className={iface.online ? 'text-emerald-400' : 'text-gray-500'} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-100">{iface.name}</span>
            <span className="text-xs text-gray-500 font-mono">{iface.port}</span>
          </div>
          <div className="text-xs text-gray-500">
            {iface.baudRate} baud · {readers.length} reader{readers.length === 1 ? '' : 's'}
          </div>
        </div>
        <span className={`px-2 py-0.5 text-[10px] rounded-full ${iface.online
          ? 'bg-emerald-500/15 text-emerald-300'
          : 'bg-gray-700/40 text-gray-400'}`}>
          ● {iface.online ? 'online' : 'offline'}
        </span>
      </button>

      {/* Body */}
      {!collapsed && (
        <div className="border-t border-gray-800">
          {/* Baud control strip */}
          <div className="px-4 py-2.5 bg-black/20 border-b border-gray-800 flex items-center gap-3 text-xs">
            <span className="text-gray-400">Baud</span>
            <select
              value={draftBaud}
              onChange={(e) => setDraftBaud(Number(e.target.value))}
              className="px-2 py-1 bg-gray-800 border border-gray-700 rounded text-gray-200"
            >
              {BAUD_OPTIONS.map(b => <option key={b} value={b}>{b}</option>)}
            </select>
            <button
              onClick={() => props.onChangeBaud(draftBaud)}
              disabled={draftBaud === iface.baudRate}
              className="px-3 py-1 text-xs bg-purple-500/20 hover:bg-purple-500/30 text-purple-200 border border-purple-500/40 rounded disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Apply to bus
            </button>
            <span className="text-gray-500 ml-auto italic">applies to all readers on this bus</span>
          </div>

          {/* Reader rows */}
          {readers.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-gray-500">No readers on this bus.</div>
          ) : (
            <div>
              {readers.map(r => (
                <ReaderRow
                  key={r.id}
                  reader={r}
                  editing={props.editingId === r.id}
                  onStartEdit={() => props.onStartEdit(r.id)}
                  onCancelEdit={props.onCancelEdit}
                  onSave={(d) => props.onSaveEdit(r.id, d, r)}
                  onDelete={() => props.onDelete(r.id, r.name)}
                  otherAddresses={readers.filter(x => x.id !== r.id).map(x => x.address)}
                />
              ))}
            </div>
          )}

          {/* Add reader form / link */}
          {props.adding ? (
            <AddReaderForm
              port={iface.port}
              usedAddresses={readers.map(r => r.address)}
              onCancel={props.onCancelAdd}
              onAdd={props.onAddReader}
            />
          ) : (
            <button
              onClick={props.onStartAdd}
              className="w-full px-4 py-2.5 text-sm text-blue-300 hover:bg-blue-500/5 border-t border-gray-800 flex items-center gap-2"
            >
              <Plus size={14}/> Add a reader to this bus
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Reader row (compact view + inline edit form)
// ───────────────────────────────────────────────────────────────────────────

function ReaderRow({ reader, editing, otherAddresses, onStartEdit, onCancelEdit, onSave, onDelete }: {
  reader: OSDPReader;
  editing: boolean;
  otherAddresses: number[];
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSave: (draft: EditDraft) => void;
  onDelete: () => void;
}) {
  if (editing) {
    return <EditReaderForm reader={reader} otherAddresses={otherAddresses} onCancel={onCancelEdit} onSave={onSave} />;
  }

  return (
    <div className="px-4 py-2.5 border-t border-gray-800 first:border-t-0 grid items-center"
      style={{ gridTemplateColumns: '14px 1fr 70px 50px 80px auto', gap: 10 }}
    >
      <span className={`w-2.5 h-2.5 rounded-full ${reader.enabled ? 'bg-emerald-400' : 'bg-gray-600'}`} />
      <div className="min-w-0">
        <div className="text-sm text-gray-100 truncate">{reader.name}</div>
        <div className="text-[11px] text-gray-500">
          {(reader.capabilities || []).join(', ') || 'no capabilities'}
        </div>
      </div>
      <span className="text-xs font-mono text-gray-400">{fmtAddr(reader.address)}</span>
      <span className={`text-[10px] px-2 py-0.5 rounded-full text-center ${
        reader.enabled ? 'bg-emerald-500/15 text-emerald-300' : 'bg-gray-700/40 text-gray-400'
      }`}>{reader.enabled ? 'on' : 'off'}</span>
      <span className={`text-[10px] px-2 py-0.5 rounded-full flex items-center justify-center gap-1 ${
        reader.secureChannel
          ? 'bg-blue-500/15 text-blue-300'
          : 'bg-gray-700/40 text-gray-400'
      }`}>
        {reader.secureChannel ? <><Lock size={10}/>secure</> : <><Unlock size={10}/>open</>}
      </span>
      <div className="flex gap-1">
        <button onClick={onStartEdit}
          className="px-2 py-1 text-[11px] text-gray-300 border border-gray-700 rounded hover:bg-gray-800 flex items-center gap-1">
          <Edit2 size={11}/> Edit
        </button>
        <button onClick={onDelete}
          className="p-1 text-gray-500 hover:text-red-400 border border-transparent hover:border-red-500/40 rounded">
          <Trash2 size={12}/>
        </button>
      </div>
    </div>
  );
}

function EditReaderForm({ reader, otherAddresses, onCancel, onSave }: {
  reader: OSDPReader;
  otherAddresses: number[];
  onCancel: () => void;
  onSave: (draft: EditDraft) => void;
}) {
  const [draft, setDraft] = useState<EditDraft>({
    name:    reader.name,
    address: reader.address,
    enabled: reader.enabled,
    capabilities: capsToObject(reader.capabilities),
    secureChannel: reader.secureChannel,
    scbkHex: '',
  });
  const [showScbk, setShowScbk] = useState(false);

  const addrConflict = draft.address !== reader.address && otherAddresses.includes(draft.address);
  const scbkProvided = draft.scbkHex.trim().length > 0;
  const scbkInvalid  = scbkProvided && !isValidScbk(draft.scbkHex);
  const canSave = draft.name.trim().length > 0 && !addrConflict && !scbkInvalid;

  return (
    <div className="bg-gray-900/60 border-t border-gray-800 p-4 space-y-3">
      <div className="grid gap-3" style={{ gridTemplateColumns: '1fr 90px 110px' }}>
        <Field label="Name">
          <input value={draft.name} onChange={(e) => setDraft(d => ({ ...d, name: e.target.value }))}
            className={INPUT_CLS} placeholder="Reader name" />
        </Field>
        <Field label="Address">
          <input type="number" min={0} max={126} value={draft.address}
            onChange={(e) => setDraft(d => ({ ...d, address: Number(e.target.value) }))}
            className={`${INPUT_CLS} ${addrConflict ? 'border-red-500/60' : ''}`} />
          {addrConflict && <div className="text-[10px] text-red-300 mt-1">already in use</div>}
        </Field>
        <Field label="Status">
          <select value={draft.enabled ? 'on' : 'off'}
            onChange={(e) => setDraft(d => ({ ...d, enabled: e.target.value === 'on' }))}
            className={INPUT_CLS}>
            <option value="on">Enabled</option>
            <option value="off">Disabled</option>
          </select>
        </Field>
      </div>

      <div>
        <div className="text-[10px] uppercase text-gray-500 tracking-wide mb-1.5">Capabilities</div>
        <div className="flex gap-4 text-sm">
          {(['LED','BUZZER','CARD','KEYPAD'] as const).map(cap => (
            <label key={cap} className="flex items-center gap-1.5 text-gray-300 cursor-pointer">
              <input type="checkbox" checked={draft.capabilities[cap]}
                onChange={(e) => setDraft(d => ({ ...d, capabilities: { ...d.capabilities, [cap]: e.target.checked } }))} />
              {cap}
            </label>
          ))}
        </div>
      </div>

      <div className="rounded border border-gray-800 bg-black/20 p-3">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2 text-sm text-gray-200">
            <Lock size={13}/> Secure channel key (SCBK)
          </div>
          <label className="text-xs text-gray-400 flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={draft.secureChannel}
              onChange={(e) => setDraft(d => ({ ...d, secureChannel: e.target.checked }))} />
            Enable secure channel
          </label>
        </div>
        <div className="flex gap-2 items-center">
          <input
            type={showScbk ? 'text' : 'password'}
            value={draft.scbkHex}
            onChange={(e) => setDraft(d => ({ ...d, scbkHex: e.target.value }))}
            placeholder={reader.scbkConfigured ? 'leave blank to keep current key' : '32 hex characters (16 bytes)'}
            className={`${INPUT_CLS} font-mono text-xs flex-1 ${scbkInvalid ? 'border-red-500/60' : ''}`}
          />
          <button onClick={() => setShowScbk(s => !s)}
            className="p-2 text-gray-400 hover:text-gray-200 border border-gray-700 rounded">
            {showScbk ? <EyeOff size={13}/> : <Eye size={13}/>}
          </button>
          <button onClick={() => setDraft(d => ({ ...d, scbkHex: randomScbk() }))}
            className="px-3 py-1.5 text-xs text-purple-200 bg-purple-500/15 hover:bg-purple-500/25 border border-purple-500/40 rounded flex items-center gap-1.5">
            <Dices size={11}/> Random
          </button>
        </div>
        {scbkInvalid && <div className="text-[10px] text-red-300 mt-1">Must be exactly 32 hex characters</div>}
        {reader.scbkConfigured && !scbkProvided && (
          <div className="text-[10px] text-gray-500 mt-1">An SCBK is already configured. Leave blank to keep it.</div>
        )}
      </div>

      <div className="flex justify-end gap-2 pt-2 border-t border-gray-800">
        <button onClick={onCancel}
          className="px-3 py-1.5 text-xs text-gray-300 hover:text-gray-100 flex items-center gap-1">
          <X size={12}/> Cancel
        </button>
        <button onClick={() => onSave(draft)} disabled={!canSave}
          className="px-4 py-1.5 text-xs bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-200 border border-emerald-500/40 rounded disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5">
          <Save size={12}/> Save changes
        </button>
      </div>
    </div>
  );
}

function AddReaderForm({ port, usedAddresses, onCancel, onAdd }: {
  port: string;
  usedAddresses: number[];
  onCancel: () => void;
  onAdd: (draft: AddDraft) => void;
}) {
  const nextFree = useMemo(() => {
    for (let a = 0; a < 127; a++) if (!usedAddresses.includes(a)) return a;
    return 0;
  }, [usedAddresses]);

  const [draft, setDraft] = useState<AddDraft>({
    name: '', address: nextFree,
    capabilities: { LED: true, BUZZER: true, CARD: true, KEYPAD: true },
    secureChannel: false,
  });

  const addrConflict = usedAddresses.includes(draft.address);
  const canAdd = draft.name.trim().length > 0 && !addrConflict;

  return (
    <div className="bg-gray-900/60 border-t border-gray-800 p-4 space-y-3">
      <div className="text-xs text-gray-400">
        Adding to <span className="font-mono text-gray-200">{port}</span>
      </div>
      <div className="grid gap-3" style={{ gridTemplateColumns: '1fr 90px 110px' }}>
        <Field label="Name">
          <input value={draft.name} autoFocus
            onChange={(e) => setDraft(d => ({ ...d, name: e.target.value }))}
            className={INPUT_CLS} placeholder="e.g. Front door" />
        </Field>
        <Field label="Address">
          <input type="number" min={0} max={126} value={draft.address}
            onChange={(e) => setDraft(d => ({ ...d, address: Number(e.target.value) }))}
            className={`${INPUT_CLS} ${addrConflict ? 'border-red-500/60' : ''}`} />
          {addrConflict && <div className="text-[10px] text-red-300 mt-1">in use</div>}
        </Field>
        <Field label="Secure">
          <select value={draft.secureChannel ? 'yes' : 'no'}
            onChange={(e) => setDraft(d => ({ ...d, secureChannel: e.target.value === 'yes' }))}
            className={INPUT_CLS}>
            <option value="no">Off</option>
            <option value="yes">On</option>
          </select>
        </Field>
      </div>
      <div>
        <div className="text-[10px] uppercase text-gray-500 tracking-wide mb-1.5">Capabilities</div>
        <div className="flex gap-4 text-sm">
          {(['LED','BUZZER','CARD','KEYPAD'] as const).map(cap => (
            <label key={cap} className="flex items-center gap-1.5 text-gray-300 cursor-pointer">
              <input type="checkbox" checked={draft.capabilities[cap]}
                onChange={(e) => setDraft(d => ({ ...d, capabilities: { ...d.capabilities, [cap]: e.target.checked } }))} />
              {cap}
            </label>
          ))}
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-2 border-t border-gray-800">
        <button onClick={onCancel}
          className="px-3 py-1.5 text-xs text-gray-300 hover:text-gray-100 flex items-center gap-1">
          <X size={12}/> Cancel
        </button>
        <button onClick={() => onAdd(draft)} disabled={!canAdd}
          className="px-4 py-1.5 text-xs bg-blue-500/20 hover:bg-blue-500/30 text-blue-200 border border-blue-500/40 rounded disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5">
          <Plus size={12}/> Add reader
        </button>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Import preview modal
// ───────────────────────────────────────────────────────────────────────────

function ImportPreviewModal({ preview, replaceAll, onToggleReplaceAll, onCancel, onApply }: {
  preview: ImportPreview;
  replaceAll: boolean;
  onToggleReplaceAll: (v: boolean) => void;
  onCancel: () => void;
  onApply: () => void;
}) {
  const totalChanges = preview.toAdd.length + preview.toUpdate.length + preview.toDelete.length;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-lg max-w-2xl w-full max-h-[80vh] flex flex-col">
        <div className="px-5 py-3 border-b border-gray-800 flex items-center justify-between">
          <h3 className="text-base font-medium text-gray-100 flex items-center gap-2">
            <Upload size={16} className="text-blue-400"/> Import reader configuration
          </h3>
          <button onClick={onCancel} className="text-gray-400 hover:text-gray-200"><X size={16}/></button>
        </div>

        <div className="px-5 py-4 overflow-y-auto flex-1 space-y-4">
          <label className="flex items-center gap-2 text-sm text-gray-200 cursor-pointer">
            <input type="checkbox" checked={replaceAll}
              onChange={(e) => onToggleReplaceAll(e.target.checked)} />
            Replace all — delete current readers not present in this file
          </label>

          {totalChanges === 0 ? (
            <div className="text-sm text-gray-400 py-6 text-center">
              No changes — the imported config matches your current setup.
            </div>
          ) : (
            <>
              {preview.toAdd.length > 0 && (
                <Section title={`Add (${preview.toAdd.length})`} color="emerald">
                  {preview.toAdd.map((x, i) => (
                    <div key={i} className="text-xs text-gray-300 font-mono">
                      + {x.name} on {x.port} addr {fmtAddr(x.address)}
                    </div>
                  ))}
                </Section>
              )}
              {preview.toUpdate.length > 0 && (
                <Section title={`Update (${preview.toUpdate.length})`} color="blue">
                  {preview.toUpdate.map((x, i) => (
                    <div key={i} className="text-xs text-gray-300">
                      <span className="font-mono">~ {x.name} on {x.port} addr {fmtAddr(x.address)}</span>
                      <div className="text-[10px] text-gray-500 ml-3">{x.changes.join(', ')}</div>
                    </div>
                  ))}
                </Section>
              )}
              {preview.toDelete.length > 0 && (
                <Section title={`Delete (${preview.toDelete.length})`} color="red">
                  {preview.toDelete.map((x, i) => (
                    <div key={i} className="text-xs text-gray-300 font-mono">
                      − {x.name} on {x.port} addr {fmtAddr(x.address)}
                    </div>
                  ))}
                </Section>
              )}
            </>
          )}
        </div>

        <div className="px-5 py-3 border-t border-gray-800 flex justify-end gap-2">
          <button onClick={onCancel}
            className="px-4 py-1.5 text-xs text-gray-300 hover:text-gray-100">Cancel</button>
          <button onClick={onApply} disabled={totalChanges === 0}
            className="px-4 py-1.5 text-xs bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-200 border border-emerald-500/40 rounded disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5">
            <Check size={12}/> Apply {totalChanges} change{totalChanges === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({ title, color, children }: { title: string; color: string; children: React.ReactNode }) {
  const map: Record<string, string> = {
    emerald: 'text-emerald-300 border-emerald-500/30',
    blue:    'text-blue-300 border-blue-500/30',
    red:     'text-red-300 border-red-500/30',
  };
  return (
    <div className={`border-l-2 pl-3 ${map[color]}`}>
      <div className={`text-xs font-medium mb-1 ${map[color]}`}>{title}</div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Shared bits
// ───────────────────────────────────────────────────────────────────────────

const INPUT_CLS = 'w-full px-2.5 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm text-gray-100 placeholder-gray-500 focus:border-blue-500/50 focus:outline-none';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">{label}</div>
      {children}
    </div>
  );
}
