/**
 * ClusterManager — multi-node Raspberry Pi control panel
 *
 * Architecture:
 *  • Maintains a list of ClusterNode objects (persisted to localStorage).
 *  • Renders one <IOAccessEmulator> per node, all mounted permanently
 *    (just hidden via CSS) so WebSocket connections survive tab switches.
 *  • A collapsible left sidebar shows all nodes with live connection status.
 *  • Each node gets a namespaced localStorage key so configs are independent.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronLeft, ChevronRight, Plus, Trash2, Edit2, Check, X,
  Wifi, WifiOff, Server, LayoutGrid, Circle, Cpu, AlertTriangle,
  GripVertical
} from 'lucide-react';
import IOAccessEmulator from '../components/IOAccessEmulator';

// ─── Types ──────────────────────────────────────────────────────────────────

const NODE_COLORS = [
  'blue', 'cyan', 'emerald', 'violet', 'orange', 'pink', 'amber', 'teal'
] as const;
type NodeColor = typeof NODE_COLORS[number];

const COLOR_MAP: Record<NodeColor, { ring: string; dot: string; badge: string; text: string }> = {
  blue:    { ring: 'ring-blue-500',    dot: 'bg-blue-400',    badge: 'bg-blue-900/40 text-blue-300',    text: 'text-blue-400'    },
  cyan:    { ring: 'ring-cyan-500',    dot: 'bg-cyan-400',    badge: 'bg-cyan-900/40 text-cyan-300',    text: 'text-cyan-400'    },
  emerald: { ring: 'ring-emerald-500', dot: 'bg-emerald-400', badge: 'bg-emerald-900/40 text-emerald-300', text: 'text-emerald-400' },
  violet:  { ring: 'ring-violet-500',  dot: 'bg-violet-400',  badge: 'bg-violet-900/40 text-violet-300',  text: 'text-violet-400'  },
  orange:  { ring: 'ring-orange-500',  dot: 'bg-orange-400',  badge: 'bg-orange-900/40 text-orange-300',  text: 'text-orange-400'  },
  pink:    { ring: 'ring-pink-500',    dot: 'bg-pink-400',    badge: 'bg-pink-900/40 text-pink-300',    text: 'text-pink-400'    },
  amber:   { ring: 'ring-amber-500',   dot: 'bg-amber-400',   badge: 'bg-amber-900/40 text-amber-300',   text: 'text-amber-400'   },
  teal:    { ring: 'ring-teal-500',    dot: 'bg-teal-400',    badge: 'bg-teal-900/40 text-teal-300',    text: 'text-teal-400'    },
};

interface ClusterNode {
  id: string;
  name: string;
  ip: string;
  color: NodeColor;
}

const STORAGE_KEY_CLUSTER = 'aether_cluster_nodes';
const STORAGE_KEY_ACTIVE  = 'aether_cluster_active';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeId() {
  return `node-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function loadNodes(): ClusterNode[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_CLUSTER);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  // Default: one node pointing at localhost
  return [{ id: makeId(), name: 'Pi Unit 1', ip: 'localhost', color: 'blue' }];
}

function saveNodes(nodes: ClusterNode[]) {
  localStorage.setItem(STORAGE_KEY_CLUSTER, JSON.stringify(nodes));
}

// ─── Sub-components ───────────────────────────────────────────────────────────

interface OverviewCardProps {
  node: ClusterNode;
  connected: boolean;
  onSelect: () => void;
}

const OverviewCard: React.FC<OverviewCardProps> = ({ node, connected, onSelect }) => {
  const c = COLOR_MAP[node.color];
  return (
    <button
      onClick={onSelect}
      className={`rounded-xl p-5 border text-left transition-all hover:scale-[1.02] active:scale-[0.98] ring-2 ring-transparent hover:${c.ring}`}
      style={{ background: 'linear-gradient(to bottom right, #2A1F22, #231A1D)', borderColor: '#4A3538' }}
    >
      <div className="flex items-start justify-between mb-3">
        <div className={`p-2 rounded-lg ${c.badge}`}>
          <Cpu size={22} />
        </div>
        <div className={`flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full ${
          connected ? 'bg-green-900/40 text-green-300' : 'bg-slate-800 text-slate-400'
        }`}>
          <Circle size={7} fill="currentColor" />
          {connected ? 'Online' : 'Offline'}
        </div>
      </div>
      <h3 className={`text-lg font-bold mb-1 ${c.text}`}>{node.name}</h3>
      <p className="text-slate-400 text-sm font-mono">{node.ip}:3001</p>
      <p className="text-slate-500 text-xs mt-2">Click to open →</p>
    </button>
  );
};

// ─── Main component ───────────────────────────────────────────────────────────

const ClusterManager: React.FC = () => {
  const [nodes, setNodes]           = useState<ClusterNode[]>(loadNodes);
  const [activeId, setActiveId]     = useState<string | 'overview'>(() =>
    localStorage.getItem(STORAGE_KEY_ACTIVE) || 'overview'
  );
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [connectionMap, setConnectionMap] = useState<Record<string, boolean>>({});

  // ── Inline-edit state for sidebar rows ───────────────────────────────────
  const [editingId, setEditingId]     = useState<string | null>(null);
  const [editName, setEditName]       = useState('');
  const [editIp, setEditIp]           = useState('');
  const editNameRef = useRef<HTMLInputElement>(null);

  // Persist nodes + active selection
  useEffect(() => { saveNodes(nodes); }, [nodes]);
  useEffect(() => { localStorage.setItem(STORAGE_KEY_ACTIVE, activeId); }, [activeId]);
  useEffect(() => {
    if (editingId && editNameRef.current) editNameRef.current.focus();
  }, [editingId]);

  // If the active node was deleted, fall back to overview
  useEffect(() => {
    if (activeId !== 'overview' && !nodes.find(n => n.id === activeId)) {
      setActiveId('overview');
    }
  }, [nodes, activeId]);

  // ── Callbacks ─────────────────────────────────────────────────────────────
  const handleConnectionChange = useCallback((nodeId: string, connected: boolean) => {
    setConnectionMap(prev => {
      if (prev[nodeId] === connected) return prev;
      return { ...prev, [nodeId]: connected };
    });
  }, []);

  const addNode = () => {
    const id    = makeId();
    const color = NODE_COLORS[nodes.length % NODE_COLORS.length];
    const node: ClusterNode = { id, name: `Pi Unit ${nodes.length + 1}`, ip: '192.168.1.', color };
    setNodes(prev => [...prev, node]);
    setActiveId(id);
    // Immediately open edit for the new node
    setEditingId(id);
    setEditName(node.name);
    setEditIp(node.ip);
  };

  const removeNode = (id: string) => {
    if (!confirm('Remove this node from the cluster? Its saved config will remain in local storage.')) return;
    setNodes(prev => prev.filter(n => n.id !== id));
  };

  const startEdit = (node: ClusterNode) => {
    setEditingId(node.id);
    setEditName(node.name);
    setEditIp(node.ip);
  };

  const commitEdit = () => {
    if (!editingId) return;
    setNodes(prev => prev.map(n => n.id === editingId
      ? { ...n, name: editName.trim() || n.name, ip: editIp.trim() || n.ip }
      : n
    ));
    setEditingId(null);
  };

  const cancelEdit = () => setEditingId(null);

  const connectedCount = nodes.filter(n => connectionMap[n.id]).length;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-screen overflow-hidden" style={{ background: '#1F1A1B' }}>

      {/* ── LEFT SIDEBAR ──────────────────────────────────────────────────── */}
      <aside
        className="flex-shrink-0 flex flex-col border-r transition-all duration-300"
        style={{
          width: sidebarOpen ? '260px' : '56px',
          borderColor: '#4A3538',
          background: 'linear-gradient(to bottom, #231A1D, #1A1316)'
        }}
      >
        {/* Sidebar header */}
        <div className="flex items-center justify-between px-3 py-4 border-b" style={{ borderColor: '#4A3538' }}>
          {sidebarOpen && (
            <div>
              <div className="text-sm font-bold text-white">Aether Cluster</div>
              <div className="text-xs text-slate-400">{connectedCount}/{nodes.length} online</div>
            </div>
          )}
          <button
            onClick={() => setSidebarOpen(v => !v)}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors ml-auto"
          >
            {sidebarOpen ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
          </button>
        </div>

        {/* Overview link */}
        <button
          onClick={() => setActiveId('overview')}
          className={`flex items-center gap-3 px-3 py-3 text-sm font-semibold transition-colors border-b ${
            activeId === 'overview'
              ? 'text-white bg-white/10'
              : 'text-slate-400 hover:text-white hover:bg-white/5'
          }`}
          style={{ borderColor: '#4A3538' }}
          title={!sidebarOpen ? 'Overview' : undefined}
        >
          <LayoutGrid size={18} className="flex-shrink-0" />
          {sidebarOpen && <span>Overview</span>}
        </button>

        {/* Node list */}
        <div className="flex-1 overflow-y-auto py-2">
          {nodes.map(node => {
            const c         = COLOR_MAP[node.color];
            const isActive  = activeId === node.id;
            const connected = !!connectionMap[node.id];
            const isEditing = editingId === node.id;

            return (
              <div
                key={node.id}
                className={`group relative mx-2 mb-1 rounded-lg transition-colors ${
                  isActive ? 'bg-white/10 ring-1 ring-white/20' : 'hover:bg-white/5'
                }`}
              >
                {isEditing && sidebarOpen ? (
                  /* ── Inline edit form ── */
                  <div className="p-2 space-y-1.5">
                    <input
                      ref={editNameRef}
                      value={editName}
                      onChange={e => setEditName(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') cancelEdit(); }}
                      placeholder="Node name"
                      className="w-full text-xs rounded px-2 py-1 text-white border"
                      style={{ background: '#2A1F22', borderColor: '#5A3538' }}
                    />
                    <input
                      value={editIp}
                      onChange={e => setEditIp(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') cancelEdit(); }}
                      placeholder="IP address"
                      className="w-full text-xs rounded px-2 py-1 text-white border font-mono"
                      style={{ background: '#2A1F22', borderColor: '#5A3538' }}
                    />
                    <div className="flex gap-1">
                      <button onClick={commitEdit} className="flex-1 text-xs py-1 rounded bg-green-700 hover:bg-green-600 text-white flex items-center justify-center gap-1">
                        <Check size={11} /> Save
                      </button>
                      <button onClick={cancelEdit} className="flex-1 text-xs py-1 rounded bg-slate-700 hover:bg-slate-600 text-white flex items-center justify-center gap-1">
                        <X size={11} /> Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  /* ── Normal row ── */
                  <button
                    onClick={() => setActiveId(node.id)}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left"
                    title={!sidebarOpen ? `${node.name} (${node.ip})` : undefined}
                  >
                    {/* Color dot + connection indicator */}
                    <div className="relative flex-shrink-0">
                      <div className={`w-2.5 h-2.5 rounded-full ${c.dot}`} />
                      {connected && (
                        <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-green-400 border border-slate-900" />
                      )}
                    </div>

                    {sidebarOpen && (
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-semibold text-white truncate">{node.name}</div>
                        <div className="text-xs text-slate-400 font-mono truncate">{node.ip}</div>
                      </div>
                    )}

                    {sidebarOpen && (
                      <div className={`text-xs px-1.5 py-0.5 rounded-full flex-shrink-0 ${
                        connected ? 'bg-green-900/50 text-green-400' : 'bg-slate-800 text-slate-500'
                      }`}>
                        {connected ? <Wifi size={10} /> : <WifiOff size={10} />}
                      </div>
                    )}
                  </button>
                )}

                {/* Edit / delete buttons — shown on hover when not editing */}
                {sidebarOpen && !isEditing && (
                  <div className="absolute right-1 top-1/2 -translate-y-1/2 hidden group-hover:flex gap-0.5 bg-slate-800/90 rounded-md p-0.5">
                    <button
                      onClick={e => { e.stopPropagation(); startEdit(node); }}
                      className="p-1 rounded text-slate-400 hover:text-white hover:bg-white/10"
                      title="Edit"
                    >
                      <Edit2 size={11} />
                    </button>
                    <button
                      onClick={e => { e.stopPropagation(); removeNode(node.id); }}
                      className="p-1 rounded text-slate-400 hover:text-red-400 hover:bg-red-900/20"
                      title="Remove node"
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Add node button */}
        <div className="p-2 border-t" style={{ borderColor: '#4A3538' }}>
          <button
            onClick={addNode}
            className="w-full flex items-center justify-center gap-2 py-2 rounded-lg text-sm font-semibold text-slate-300 hover:text-white border border-dashed hover:border-blue-500/60 hover:bg-blue-900/10 transition-colors"
            style={{ borderColor: '#4A3538' }}
            title={!sidebarOpen ? 'Add node' : undefined}
          >
            <Plus size={16} />
            {sidebarOpen && 'Add Node'}
          </button>
        </div>
      </aside>

      {/* ── MAIN CONTENT AREA ─────────────────────────────────────────────── */}
      <main className="flex-1 overflow-y-auto">

        {/* ── OVERVIEW PANEL (shown when activeId === 'overview') ──────────── */}
        <div style={{ display: activeId === 'overview' ? 'block' : 'none' }}>
          <div className="p-8">
            {/* Overview header */}
            <div className="mb-8">
              <h1 className="text-3xl font-bold bg-gradient-to-r from-blue-400 to-cyan-400 bg-clip-text text-transparent mb-1">
                Aurora Aether Cluster
              </h1>
              <p className="text-slate-400">
                {nodes.length} node{nodes.length !== 1 ? 's' : ''} registered · {connectedCount} online
              </p>
            </div>

            {/* Status bar */}
            <div className="flex gap-4 mb-8">
              <div className="flex-1 rounded-xl p-4 border" style={{ background: '#231A1D', borderColor: '#4A3538' }}>
                <div className="text-xs text-slate-400 mb-1">Total Nodes</div>
                <div className="text-2xl font-bold text-white">{nodes.length}</div>
              </div>
              <div className="flex-1 rounded-xl p-4 border" style={{ background: '#231A1D', borderColor: '#4A3538' }}>
                <div className="text-xs text-slate-400 mb-1">Online</div>
                <div className="text-2xl font-bold text-green-400">{connectedCount}</div>
              </div>
              <div className="flex-1 rounded-xl p-4 border" style={{ background: '#231A1D', borderColor: '#4A3538' }}>
                <div className="text-xs text-slate-400 mb-1">Offline</div>
                <div className="text-2xl font-bold text-slate-400">{nodes.length - connectedCount}</div>
              </div>
            </div>

            {/* Node cards grid */}
            {nodes.length === 0 ? (
              <div className="text-center py-16 text-slate-500">
                <Server size={40} className="mx-auto mb-3 opacity-40" />
                <p className="text-lg font-semibold">No nodes yet</p>
                <p className="text-sm mt-1">Click "Add Node" in the sidebar to register a Raspberry Pi</p>
              </div>
            ) : (
              <div className="grid grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4">
                {nodes.map(node => (
                  <OverviewCard
                    key={node.id}
                    node={node}
                    connected={!!connectionMap[node.id]}
                    onSelect={() => setActiveId(node.id)}
                  />
                ))}
                {/* Add node card */}
                <button
                  onClick={addNode}
                  className="rounded-xl p-5 border border-dashed text-slate-500 hover:text-slate-300 hover:border-blue-500/50 hover:bg-blue-900/5 transition-all flex flex-col items-center justify-center gap-2 min-h-[140px]"
                  style={{ borderColor: '#4A3538' }}
                >
                  <Plus size={24} />
                  <span className="text-sm font-semibold">Add Node</span>
                </button>
              </div>
            )}

            {/* Warnings */}
            {nodes.length - connectedCount > 0 && connectedCount < nodes.length && (
              <div className="mt-6 flex items-center gap-3 rounded-lg px-4 py-3 bg-amber-900/20 border border-amber-700/40 text-amber-300 text-sm">
                <AlertTriangle size={16} className="flex-shrink-0" />
                {nodes.length - connectedCount} node{nodes.length - connectedCount !== 1 ? 's are' : ' is'} offline. Click a card to open and connect.
              </div>
            )}
          </div>
        </div>

        {/* ── PER-NODE EMULATOR PANELS ─────────────────────────────────────── */}
        {/*
          All emulators are always MOUNTED but only the active one is VISIBLE.
          This keeps WebSocket connections alive during tab switches.
        */}
        {nodes.map(node => (
          <div
            key={node.id}
            style={{ display: activeId === node.id ? 'block' : 'none' }}
          >
            <IOAccessEmulator
              nodeId={node.id}
              nodeLabel={node.name}
              externalIp={node.ip}
              onConnectionChange={handleConnectionChange}
            />
          </div>
        ))}
      </main>
    </div>
  );
};

export default ClusterManager;
