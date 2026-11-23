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
  GripVertical, Video, Loader2, ExternalLink
} from 'lucide-react';
import IOAccessEmulator, { defaultHost, isLoopbackHost } from '../components/IOAccessEmulator';
import { TopBar } from '../components/shell/AppShell';
// AETHER_CLUSTER / AETHER_CAMERAS: cluster list kept on the main Pi; live RTSP tiles
import { ClusterInfo, CameraList, getCluster, removeNode as apiRemoveNode, renameNode, listCameras, deleteCamera, NodeKey } from './clusterApi';
import CameraTile from './CameraTile';
import StreamViewTile from './StreamViewTile';
import { EnrollDialog, AddStreamDialog, SourceDialog } from './ClusterDialogs';

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
  key?: NodeKey;      // AETHER_CLUSTER: 'self' or "host:port" when the list comes from the main Pi
}

const norm = (ip: string) => String(ip || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
const asColor = (c: string, i: number): NodeColor => (NODE_COLORS as readonly string[]).includes(c) ? c as NodeColor : NODE_COLORS[i % NODE_COLORS.length];

/** Build the node list from the main Pi, keeping this browser's old node ids so each node's saved screen settings stay. */
function nodesFromServer(info: ClusterInfo): { nodes: ClusterNode[]; pending: ClusterNode[] } {
  let old: ClusterNode[] = [];
  try { const raw = JSON.parse(localStorage.getItem(STORAGE_KEY_CLUSTER) || '[]'); if (Array.isArray(raw)) old = raw.filter(n => n && typeof n.ip === 'string'); } catch { /* */ }
  const used = new Set<string>();
  const take = (match: (n: ClusterNode) => boolean, fallback: string) => {
    const m = old.find(n => !used.has(n.id) && match(n));
    if (m) { used.add(m.id); return m.id; }
    return fallback;
  };
  const selfHosts = new Set([...(info.self.hosts || []), defaultHost(), 'localhost'].map(norm));
  const self: ClusterNode = {
    id: take(n => selfHosts.has(norm(n.ip)) || isLoopbackHost(n.ip), 'srv-self'),
    name: info.self.name || 'Pi Unit 1', ip: defaultHost(), color: asColor(info.self.color, 0), key: 'self',
  };
  const remote: ClusterNode[] = info.nodes.map((n, i) => {
    const host = n.key.replace(/:\d+$/, '');
    return { id: take(o => norm(o.ip) === norm(host), `srv-${n.key}`), name: n.name, ip: host, color: asColor(n.color, i + 1), key: n.key };
  });
  const pending = old.filter(n => !used.has(n.id) && !selfHosts.has(norm(n.ip)) && !isLoopbackHost(n.ip) && /\d+\.\d+\.\d+\.\d+|[a-z]/i.test(n.ip));
  return { nodes: [self, ...remote], pending };
}

const STORAGE_KEY_CLUSTER = 'aether_cluster_nodes';
const STORAGE_KEY_ACTIVE  = 'aether_cluster_active';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeId() {
  return `node-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

// AETHER_NODE_HOST (Update 69)
// The default node used to be stored as 'localhost'. Opened from any other
// PC, http://localhost:3001 points at THAT PC, gets blocked and the node shows
// Offline. The default is now the host the page was served from (the Pi);
// only a page that is itself on localhost keeps 'localhost'. Stored loopback
// entries are rewritten to the page host when the page is not on loopback;
// real IPs are left alone. defaultHost()/isLoopbackHost() live in
// IOAccessEmulator because its own fallback uses them as well.
export function migrateLoopbackNodes<T extends { ip: string }>(nodes: T[]): { nodes: T[]; changed: boolean } {
  const host = defaultHost();
  if (host === 'localhost') return { nodes, changed: false };
  const norm = (ip: string) => String(ip || '').trim().toLowerCase();
  // A node already pointing at the page host makes the loopback one a duplicate: drop it.
  let hostTaken = nodes.some(n => n && typeof n.ip === 'string' && norm(n.ip) === norm(host));
  let changed = false;
  const out: T[] = [];
  for (const n of nodes) {
    if (n && typeof n.ip === 'string' && isLoopbackHost(n.ip)) {
      changed = true;
      if (hostTaken) continue;
      hostTaken = true;   // a second loopback entry would also be a duplicate
      out.push({ ...n, ip: host });
    } else {
      out.push(n);
    }
  }
  return { nodes: out, changed };
}

function loadNodes(): ClusterNode[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_CLUSTER);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const { nodes, changed } = migrateLoopbackNodes<ClusterNode>(parsed);
        if (changed && nodes.length) { try { saveNodes(nodes); } catch { /* ignore */ } }
        if (nodes.length) return nodes;
      }
    }
  } catch { /* ignore */ }
  // Default: one node pointing at the Pi that served this page
  return [{ id: makeId(), name: 'Pi Unit 1', ip: defaultHost(), color: 'blue' }];
}

function saveNodes(nodes: ClusterNode[]) {
  localStorage.setItem(STORAGE_KEY_CLUSTER, JSON.stringify(nodes));
}

// ─── Sub-components ───────────────────────────────────────────────────────────

interface OverviewCardProps {
  node: ClusterNode;
  connected: boolean;
  onSelect: () => void;
  onAddStream?: () => void;
  note?: string;
}

const OverviewCard: React.FC<OverviewCardProps> = ({ node, connected, onSelect, onAddStream, note }) => {
  const c = COLOR_MAP[node.color];
  return (
    <div
      role="button" tabIndex={0}
      onClick={onSelect}
      onKeyDown={e => { if (e.key === 'Enter') onSelect(); }}
      className={`rounded-xl p-5 border text-left transition-all hover:scale-[1.02] active:scale-[0.98] ring-2 ring-transparent hover:${c.ring}`}
      style={{ background: 'linear-gradient(to bottom right, rgb(var(--hv-widget)), rgb(var(--hv-widget)))', borderColor: 'rgb(var(--hv-line-strong))' }}
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
      {onAddStream && (
        <div className="mt-2 flex items-center gap-3">
          <button type="button" onClick={e => { e.stopPropagation(); onAddStream(); }}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-hv-brand hover:underline">
            <Video size={13} /> Add stream
          </button>
          {note && <span className="text-[11px] text-hv-text-3 truncate">{note}</span>}
        </div>
      )}
    </div>
  );
};

// ─── Main component ───────────────────────────────────────────────────────────

const ClusterManager: React.FC = () => {
  // AETHER_CLUSTER: 'server' = the list lives on the main Pi (shared by every browser);
  // 'local' = older backend, keep the per-browser list.
  const [mode, setMode]             = useState<'loading' | 'server' | 'local'>('loading');
  const [info, setInfo]             = useState<ClusterInfo | null>(null);
  const [nodes, setNodes]           = useState<ClusterNode[]>([]);
  const [pending, setPending]       = useState<ClusterNode[]>([]);
  const [cameras, setCameras]       = useState<Record<string, CameraList | { error: string }>>({});
  const [enroll, setEnroll]         = useState<null | { name?: string; host?: string }>(null);
  const [addStream, setAddStream]   = useState<null | { key?: NodeKey }>(null);
  const [swap, setSwap]             = useState<null | { key: NodeKey; name: string }>(null);
  const [loadError, setLoadError]   = useState('');
  // AETHER_CLUSTER_HOME: every load starts on the cluster overview (the last open node is no longer restored).
  const [activeId, setActiveId]     = useState<string | 'overview'>(() => {
    try { localStorage.removeItem(STORAGE_KEY_ACTIVE); } catch { /* */ }
    return 'overview';
  }
  );
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [connectionMap, setConnectionMap] = useState<Record<string, boolean>>({});

  // ── Inline-edit state for sidebar rows ───────────────────────────────────
  const [editingId, setEditingId]     = useState<string | null>(null);
  const [editName, setEditName]       = useState('');
  const [editIp, setEditIp]           = useState('');
  const editNameRef = useRef<HTMLInputElement>(null);

  const loadCluster = useCallback(async () => {
    try {
      const i = await getCluster();
      if (!i) { setMode('local'); setNodes(loadNodes()); return; }
      const { nodes: n, pending: p } = nodesFromServer(i);
      setInfo(i); setNodes(n); setPending(p); setMode('server'); setLoadError('');
    } catch (e: any) {
      setLoadError(e?.message || 'Could not load the cluster');
      setMode(m => { if (m === 'loading') { setNodes(loadNodes()); return 'local'; } return m; });
    }
  }, []);
  useEffect(() => { loadCluster(); }, [loadCluster]);

  const loadCameras = useCallback(async (only?: NodeKey) => {
    const keys = nodes.map(n => n.key).filter((k): k is NodeKey => !!k && (!only || k === only));
    const results = await Promise.all(keys.map(k => listCameras(k).then(r => [k, r] as const, (e: any) => [k, { error: e?.message || 'unavailable' }] as const)));
    setCameras(prev => { const next = { ...prev }; for (const [k, r] of results) next[k] = r; return next; });
  }, [nodes]);
  useEffect(() => {
    if (mode !== 'server') return;
    loadCameras();
    const t = setInterval(() => { if (!document.hidden) loadCameras(); }, 30000);
    return () => clearInterval(t);
  }, [mode, loadCameras]);

  // Persist nodes + active selection (the per-browser list only in 'local' mode)
  useEffect(() => { if (mode === 'local') saveNodes(nodes); }, [nodes, mode]);
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
    if (mode === 'server') { setEnroll({}); return; }
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

  const removeNode = async (id: string) => {
    const node = nodes.find(n => n.id === id);
    if (mode === 'server' && node?.key) {
      if (node.key === 'self') { alert('This is the Pi you are signed in to. It is always part of its own cluster.'); return; }
      if (!confirm(`Remove ${node.name} from the cluster for everyone? It stops trusting this Pi; enroll it again with its password to add it back.`)) return;
      try { await apiRemoveNode(node.key); } catch (e: any) { alert(e?.message || 'Could not remove the node'); return; }
      await loadCluster();
      return;
    }
    if (!confirm('Remove this node from the cluster? Its saved config will remain in local storage.')) return;
    setNodes(prev => prev.filter(n => n.id !== id));
  };
  const forgetPending = (id: string) => {
    setPending(p => p.filter(n => n.id !== id));
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY_CLUSTER) || '[]');
      if (Array.isArray(raw)) localStorage.setItem(STORAGE_KEY_CLUSTER, JSON.stringify(raw.filter((n: any) => n && n.id !== id)));
    } catch { /* */ }
  };
  const removeStream = async (key: NodeKey, camId: string, camName: string) => {
    if (!confirm(`Remove the stream "${camName}"?`)) return;
    try { await deleteCamera(key, camId); } catch (e: any) { alert(e?.message || 'Could not remove the stream'); }
    loadCameras(key);
  };
  // A new node needs the page's gateway list refreshed (it is loaded with the page).
  const enrolled = () => { setEnroll(null); window.location.reload(); };

  const startEdit = (node: ClusterNode) => {
    setEditingId(node.id);
    setEditName(node.name);
    setEditIp(node.ip);
  };

  const commitEdit = () => {
    if (!editingId) return;
    const editing = nodes.find(n => n.id === editingId);
    if (mode === 'server' && editing?.key) {
      const name = editName.trim();
      if (name && name !== editing.name) {
        renameNode(editing.key, name).then(() => loadCluster(), (e: any) => alert(e?.message || 'Could not rename'));
        setNodes(prev => prev.map(n => n.id === editingId ? { ...n, name } : n));
      }
      setEditingId(null);
      return;
    }
    setNodes(prev => prev.map(n => n.id === editingId
      ? { ...n, name: editName.trim() || n.name, ip: editIp.trim() || n.ip }
      : n
    ));
    setEditingId(null);
  };

  const cancelEdit = () => setEditingId(null);

  const connectedCount = nodes.filter(n => connectionMap[n.id]).length;

  const hostOf = (u: string) => { try { return new URL(u).hostname; } catch { return ''; } };
  const streamTargets = nodes.filter(n => n.key).map(n => {
    const cl = cameras[n.key as string];
    const list = cl && 'cameras' in cl ? [...cl.cameras, ...(cl.primary && cl.primary.type === 'camera' && cl.primary.url ? [{ url: cl.primary.url, source: null }] : [])] : [];
    return { key: n.key as NodeKey, name: n.name, online: !!connectionMap[n.id], cameraHosts: list.map((c: any) => (c.source && c.source.host) || hostOf(c.url)).filter(Boolean) };
  });

  // ── Render ────────────────────────────────────────────────────────────────
  if (mode === 'loading') {
    return (
      <div className="flex h-screen items-center justify-center bg-hv-surface text-hv-text-3 text-sm gap-2">
        <Loader2 size={16} className="animate-spin" /> Loading cluster...
      </div>
    );
  }
  return (
    <div className="flex flex-col h-screen overflow-hidden bg-hv-surface">
      {/* HV top bar for the cluster overview. Each node page brings its own top bar
          with a node switcher, so the node list below is only shown on the overview. */}
      {activeId === 'overview' && (
        <TopBar onToggleNav={() => setSidebarOpen(v => !v)} navCollapsed={!sidebarOpen} title="Aether" version="Cluster"
          subtitle="Access Emulation Testing Hardware Evaluation Resource">
          <span className="text-xs text-hv-text-3">{connectedCount}/{nodes.length} nodes online</span>
        </TopBar>
      )}
      <div className="flex flex-1 min-h-0">

      {/* ── LEFT SIDEBAR (cluster node list) ─────────────────────────────── */}
      <aside
        className="flex-shrink-0 flex flex-col border-r transition-all duration-300"
        style={{
          display: activeId === 'overview' ? 'flex' : 'none',
          width: sidebarOpen ? '260px' : '56px',
          borderColor: 'rgb(var(--hv-line))',
          background: 'rgb(var(--hv-widget-panel))'
        }}
      >
        {/* Sidebar header */}
        <div className="flex items-center justify-between px-3 py-4 border-b" style={{ borderColor: 'rgb(var(--hv-line-strong))' }}>
          {sidebarOpen && (
            <div>
              <div className="text-sm font-bold text-hv-text">Aether Cluster</div>
              <div className="text-xs text-slate-400">{connectedCount}/{nodes.length} online</div>
            </div>
          )}
          <button
            onClick={() => setSidebarOpen(v => !v)}
            className="p-1.5 rounded-lg text-slate-400 hover:text-hv-text hover:bg-hv-contrast/10 transition-colors ml-auto"
          >
            {sidebarOpen ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
          </button>
        </div>

        {/* Overview link */}
        <button
          onClick={() => setActiveId('overview')}
          className={`flex items-center gap-3 px-3 py-3 text-sm font-semibold transition-colors border-b ${
            activeId === 'overview'
              ? 'text-hv-text bg-hv-contrast/10'
              : 'text-slate-400 hover:text-hv-text hover:bg-hv-contrast/5'
          }`}
          style={{ borderColor: 'rgb(var(--hv-line-strong))' }}
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
                  isActive ? 'bg-hv-contrast/10 ring-1 ring-white/20' : 'hover:bg-hv-contrast/5'
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
                      className="w-full text-xs rounded px-2 py-1 text-hv-text border"
                      style={{ background: 'rgb(var(--hv-widget))', borderColor: 'rgb(var(--hv-line-strong))' }}
                    />
                    <input
                      value={editIp}
                      disabled={mode === 'server'}
                      title={mode === 'server' ? 'To change the address, remove the node and enroll it again' : undefined}
                      onChange={e => setEditIp(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') cancelEdit(); }}
                      placeholder="IP address"
                      className="w-full text-xs rounded px-2 py-1 text-hv-text border font-mono"
                      style={{ background: 'rgb(var(--hv-widget))', borderColor: 'rgb(var(--hv-line-strong))' }}
                    />
                    <div className="flex gap-1">
                      <button onClick={commitEdit} className="flex-1 text-xs py-1 rounded bg-hv-success-tint text-hv-success-fg ring-1 ring-inset ring-hv-success/40 hover:bg-hv-success-tint-strong flex items-center justify-center gap-1">
                        <Check size={11} /> Save
                      </button>
                      <button onClick={cancelEdit} className="flex-1 text-xs py-1 rounded bg-slate-700 hover:bg-slate-600 text-hv-text flex items-center justify-center gap-1">
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
                        <div className="text-sm font-semibold text-hv-text truncate">{node.name}</div>
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
                      className="p-1 rounded text-slate-400 hover:text-hv-text hover:bg-hv-contrast/10"
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
        <div className="p-2 border-t" style={{ borderColor: 'rgb(var(--hv-line-strong))' }}>
          <button
            onClick={addNode}
            className="w-full flex items-center justify-center gap-2 py-2 rounded-lg text-sm font-semibold text-slate-300 hover:text-hv-text border border-dashed hover:border-blue-500/60 hover:bg-blue-900/10 transition-colors"
            style={{ borderColor: 'rgb(var(--hv-line-strong))' }}
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
              <div className="text-xs leading-[18px] text-hv-text-3">Aether / Cluster</div>
              <h1 className="mt-1 text-2xl leading-8 font-bold text-hv-text">
                Aurora Aether Cluster
              </h1>
              <div className="mt-1 flex items-center gap-4">
                <p className="text-sm text-hv-text-2">
                  {nodes.length} node{nodes.length !== 1 ? 's' : ''} registered · {connectedCount} online
                </p>
                {mode === 'server' && (
                  <button type="button" onClick={() => setAddStream({})}
                    className="ml-auto h-8 px-3 rounded-hv-xs text-sm font-semibold inline-flex items-center gap-2 bg-hv-brand hover:bg-hv-brand-hover text-white">
                    <Video size={15} /> Add stream
                  </button>
                )}
              </div>
              {info && info.managedBy.length > 0 && (
                <div className="mt-4 flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm border" style={{ borderColor: 'rgb(var(--hv-line-strong))', background: 'rgb(var(--hv-widget))' }}>
                  <span className="text-hv-text-2">This Pi is enrolled in <b className="text-hv-text">{info.managedBy.map(m => m.name).join(', ')}</b>. Manage the cluster there.</span>
                  {info.managedBy[0].url && <a href={info.managedBy[0].url} className="ml-auto inline-flex items-center gap-1 text-hv-brand font-semibold">Open <ExternalLink size={13} /></a>}
                </div>
              )}
              {loadError && <div className="mt-4 text-xs text-amber-300">Cluster list: {loadError}. Showing this browser's saved list.</div>}
            </div>

            {/* Status bar */}
            <div className="flex gap-4 mb-8">
              <div className="flex-1 rounded-xl p-4 border" style={{ background: 'rgb(var(--hv-widget))', borderColor: 'rgb(var(--hv-line-strong))' }}>
                <div className="text-xs text-slate-400 mb-1">Total Nodes</div>
                <div className="text-2xl font-bold text-hv-text">{nodes.length}</div>
              </div>
              <div className="flex-1 rounded-xl p-4 border" style={{ background: 'rgb(var(--hv-widget))', borderColor: 'rgb(var(--hv-line-strong))' }}>
                <div className="text-xs text-slate-400 mb-1">Online</div>
                <div className="text-2xl font-bold text-green-400">{connectedCount}</div>
              </div>
              <div className="flex-1 rounded-xl p-4 border" style={{ background: 'rgb(var(--hv-widget))', borderColor: 'rgb(var(--hv-line-strong))' }}>
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
                {nodes.map(node => {
                  const cl = node.key ? cameras[node.key] : undefined;
                  const cams = cl && 'cameras' in cl ? cl.cameras : [];
                  const primary = cl && 'cameras' in cl ? cl.primary : undefined;
                  // The node's own tile: its Stream View drawn in the page (default, needs nothing on the Pi),
                  // or an RTSP camera when switched (needs the Pi's streaming service).
                  if (mode === 'server' && node.key) {
                    const swapIt = () => setSwap({ key: node.key as NodeKey, name: node.name });
                    const own = !(primary && primary.type === 'camera') ? [(
                      <StreamViewTile
                        key={`${node.id}:streamview`}
                        host={node.ip}
                        nodeName={node.name}
                        dotClass={COLOR_MAP[node.color].dot}
                        nodeOnline={!!connectionMap[node.id]}
                        onOpen={() => setActiveId(node.id)}
                        onSwap={cl && 'cameras' in cl ? swapIt : undefined}
                      />
                    )] : [(
                      <CameraTile
                        key={`${node.id}:main:${primary.type}:${primary.url || ''}`}
                        nodeKey={node.key as NodeKey}
                        cameraId="main"
                        name={primary.name}
                        nodeName={node.name}
                        source="IP camera"
                        dotClass={COLOR_MAP[node.color].dot}
                        nodeOnline={!!connectionMap[node.id]}
                        onOpen={() => setActiveId(node.id)}
                        onSwap={swapIt}
                      />
                    )];
                    return own.concat(cams.map(cam => (
                      <CameraTile
                        key={`${node.id}:${cam.id}`}
                        nodeKey={node.key as NodeKey}
                        cameraId={cam.id}
                        name={cam.name}
                        nodeName={node.name}
                        dotClass={COLOR_MAP[node.color].dot}
                        nodeOnline={!!connectionMap[node.id]}
                        onOpen={() => setActiveId(node.id)}
                        onRemove={() => removeStream(node.key as NodeKey, cam.id, cam.name)}
                      />
                    )));
                  }
                  const note = cl && 'cameras' in cl && !cl.streaming ? 'Streaming service not installed' : undefined;
                  return (
                    <OverviewCard
                      key={node.id}
                      node={node}
                      connected={!!connectionMap[node.id]}
                      onSelect={() => setActiveId(node.id)}
                      onAddStream={mode === 'server' && node.key ? () => setAddStream({ key: node.key }) : undefined}
                      note={note}
                    />
                  );
                })}
                {mode === 'server' && pending.map(p => (
                  <div key={p.id} className="rounded-xl p-5 border border-dashed flex flex-col justify-between min-h-[140px]" style={{ borderColor: 'rgb(var(--hv-line-strong))' }}>
                    <div>
                      <div className="text-xs font-semibold text-amber-300 mb-2">Not enrolled</div>
                      <h3 className="text-lg font-bold text-hv-text">{p.name}</h3>
                      <p className="text-slate-400 text-sm font-mono">{p.ip}:3001</p>
                      <p className="text-[11px] text-hv-text-3 mt-1">Saved in this browser only. Enroll it so it works through this Pi for everyone.</p>
                    </div>
                    <div className="mt-3 flex gap-3 text-xs font-semibold">
                      <button type="button" onClick={() => setEnroll({ name: p.name, host: p.ip })} className="text-hv-brand hover:underline">Enroll</button>
                      <button type="button" onClick={() => forgetPending(p.id)} className="text-hv-text-3 hover:text-hv-text">Forget</button>
                    </div>
                  </div>
                ))}
                {/* Add node card */}
                <button
                  onClick={addNode}
                  className="rounded-xl p-5 border border-dashed text-slate-500 hover:text-slate-300 hover:border-blue-500/50 hover:bg-blue-900/5 transition-all flex flex-col items-center justify-center gap-2 min-h-[140px]"
                  style={{ borderColor: 'rgb(var(--hv-line-strong))' }}
                >
                  <Plus size={24} />
                  <span className="text-sm font-semibold">{mode === 'server' ? 'Enroll Node' : 'Add Node'}</span>
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
              cluster={{ nodes, activeId, online: connectionMap, onSelect: setActiveId }}
            />
          </div>
        ))}
      </main>
      </div>
      {enroll && <EnrollDialog initial={enroll} onClose={() => setEnroll(null)} onDone={enrolled} />}
      {addStream && (
        <AddStreamDialog targets={streamTargets} initialKey={addStream.key} onClose={() => setAddStream(null)}
          onDone={(k) => { setAddStream(null); loadCameras(k); }} />
      )}
      {swap && (() => {
        const cl = cameras[swap.key];
        return (
          <SourceDialog nodeKey={swap.key} nodeName={swap.name} current={cl && 'cameras' in cl ? cl.primary : undefined}
            onClose={() => setSwap(null)} onDone={() => { const k = swap.key; setSwap(null); loadCameras(k); }} />
        );
      })()}
    </div>
  );
};

export default ClusterManager;
