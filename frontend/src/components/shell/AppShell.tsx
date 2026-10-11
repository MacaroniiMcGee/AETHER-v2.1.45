/**
 * HV GUI Guidelines app shell — Top bar, Navigation bar (GNB) and page header.
 *
 * Layout (Foundation › Layout): A Top bar · B Navigation bar · C Content area.
 * Sizes follow the guideline: 56px top bar, 240px GNB (64px collapsed),
 * 44px 1-depth items with icon, 36px 2-depth items with optional badge (4px gap),
 * 16px text with 20px line height for menu titles.
 */
import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Menu, Check } from 'lucide-react';
import ThemeToggle from '../../theme/ThemeToggle';

/* ── Top bar ─────────────────────────────────────────────────────────────── */

export interface ClusterNav {
  nodes: { id: string; name: string; ip: string }[];
  activeId: string;
  online: Record<string, boolean>;
  onSelect: (id: string) => void;   // node id or 'overview'
}

export const TopBar: React.FC<{
  onToggleNav?: () => void;
  navCollapsed?: boolean;
  title?: string;
  version?: string;
  subtitle?: string;
  cluster?: ClusterNav;
  children?: React.ReactNode;        // right-side controls (connection, etc.)
}> = ({ onToggleNav, navCollapsed, title = 'Aether', version, subtitle, cluster, children }) => (
  <header className="sticky top-0 z-30 h-14 flex-shrink-0 flex items-center gap-3 px-3 bg-hv-widget border-b border-hv-line">
    {onToggleNav && (
      <button type="button" onClick={onToggleNav} aria-label={navCollapsed ? 'Expand navigation' : 'Collapse navigation'}
        title={navCollapsed ? 'Expand navigation' : 'Collapse navigation'}
        className="w-9 h-9 inline-flex items-center justify-center rounded-hv-xs text-hv-text-2 hover:bg-hv-contrast/5 active:bg-hv-contrast/10">
        <Menu size={20} />
      </button>
    )}
    <div className="flex items-center gap-2.5 min-w-0" title={subtitle}>
      <span aria-hidden className="w-7 h-7 rounded-hv-xs bg-hv-brand inline-flex items-center justify-center flex-shrink-0">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M4 20 12 4l8 16" /><path d="M7.5 13h9" /></svg>
      </span>
      <span className="text-base leading-5 font-bold text-hv-text whitespace-nowrap">{title}</span>
      {version && <span className="text-xs text-hv-text-3 whitespace-nowrap">{version}</span>}
    </div>
    {cluster && <NodeSwitcher {...cluster} />}
    <div className="flex-1" />
    <div className="flex items-center gap-2 flex-wrap justify-end">{children}</div>
    <span className="w-px h-6 bg-hv-line mx-1" aria-hidden />
    <ThemeToggle />
  </header>
);

const NodeSwitcher: React.FC<ClusterNav> = ({ nodes, activeId, online, onSelect }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  const current = nodes.find(n => n.id === activeId);
  const pick = (id: string) => { setOpen(false); onSelect(id); };
  return (
    <div ref={ref} className="relative ml-2">
      <button type="button" onClick={() => setOpen(v => !v)} aria-haspopup="listbox" aria-expanded={open}
        className="h-8 inline-flex items-center gap-2 pl-2.5 pr-2 rounded-hv-xs border border-hv-line hover:border-hv-line-strong text-sm text-hv-text">
        <StatusDot on={!!(current && online[current.id])} />
        <span className="max-w-[180px] truncate">{current ? current.name : 'Cluster overview'}</span>
        <ChevronDown size={16} className="text-hv-text-3" />
      </button>
      {open && (
        <div role="listbox" className="absolute left-0 top-10 z-40 min-w-[260px] py-1 rounded-hv-sm bg-hv-popup-panel border border-hv-line shadow-hv-2">
          <button type="button" role="option" aria-selected={activeId === 'overview'} onClick={() => pick('overview')}
            className="w-full h-9 px-3 flex items-center gap-2 text-sm text-hv-text hover:bg-hv-contrast/5">
            <span className="flex-1 text-left font-semibold">Cluster overview</span>
            {activeId === 'overview' && <Check size={16} className="text-hv-brand-fg" />}
          </button>
          <div className="my-1 h-px bg-hv-line" />
          {nodes.map(n => (
            <button key={n.id} type="button" role="option" aria-selected={n.id === activeId} onClick={() => pick(n.id)}
              className="w-full h-10 px-3 flex items-center gap-2.5 text-sm text-hv-text hover:bg-hv-contrast/5">
              <StatusDot on={!!online[n.id]} />
              <span className="flex-1 min-w-0 text-left">
                <span className="block truncate">{n.name}</span>
                <span className="block text-xs text-hv-text-3 font-mono">{n.ip}</span>
              </span>
              {n.id === activeId && <Check size={16} className="text-hv-brand-fg" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export const StatusDot: React.FC<{ on: boolean }> = ({ on }) => (
  <span aria-hidden className={`w-2 h-2 rounded-full flex-shrink-0 ${on ? 'bg-hv-success' : 'bg-hv-line-strong'}`} />
);

/* ── Navigation bar (GNB) ────────────────────────────────────────────────── */

export interface NavItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  badge?: React.ReactNode;
  children?: { id: string; label: string; badge?: React.ReactNode }[];
}

export const SideNav: React.FC<{
  items: NavItem[];
  active: string;
  activeChild?: string;
  collapsed: boolean;
  onSelect: (id: string, childId?: string) => void;
}> = ({ items, active, activeChild, collapsed, onSelect }) => (
  <nav aria-label="Main"
    className={`flex-shrink-0 sticky top-14 self-start h-[calc(100vh-56px)] overflow-y-auto bg-hv-widget-panel border-r border-hv-line transition-[width] duration-200 ${collapsed ? 'w-16' : 'w-60'}`}>
    <ul className="p-2 flex flex-col gap-0.5">
      {items.map(item => {
        const on = item.id === active;
        return (
          <li key={item.id}>
            {/* AETHER-GNB-2DEPTH: a parent click opens the section on its last-used child (the page decides) */}
            <button type="button" onClick={() => onSelect(item.id)}
              title={collapsed ? item.label : undefined} aria-current={on && !item.children ? 'page' : undefined}
              className={`relative w-full h-11 flex items-center gap-3 rounded-hv-xs text-left text-base leading-5 ${collapsed ? 'justify-center px-0' : 'px-3'} ${
                on ? 'bg-hv-brand/15 text-hv-text font-semibold' : 'text-hv-text-2 hover:bg-hv-contrast/5 hover:text-hv-text'}`}>
              <span className={`flex-shrink-0 ${on ? 'text-hv-brand-fg' : ''}`}>{item.icon}</span>
              {!collapsed && <span className="truncate">{item.label}</span>}
              {!collapsed && item.badge}
              {collapsed && item.badge && <span aria-hidden className="absolute ml-6 -mt-5 w-2 h-2 rounded-full bg-hv-success" />}
            </button>
            {on && !collapsed && item.children && (
              <ul className="pl-11 pr-1 py-0.5 flex flex-col gap-0.5">
                {item.children.map(c => {
                  const cOn = c.id === activeChild;
                  return (
                    <li key={c.id}>
                      <button type="button" onClick={() => onSelect(item.id, c.id)} aria-current={cOn ? 'page' : undefined}
                        className={`w-full h-9 flex items-center gap-1 pr-2 rounded-hv-xs text-sm text-left ${
                          cOn ? 'text-hv-brand-fg font-semibold' : 'text-hv-text-2 hover:text-hv-text'}`}>
                        <span className="flex-1 truncate">{c.label}</span>
                        {c.badge}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  </nav>
);

/* ── Page header: breadcrumbs + title ───────────────────────────────────── */

export const PageHeader: React.FC<{ crumbs: string[]; title?: string; description?: string; actions?: React.ReactNode }> =
  ({ crumbs, title, description, actions }) => (
    <div className="flex items-end justify-between gap-4 flex-wrap mb-5">
      <div className="min-w-0">
        <nav aria-label="Breadcrumb" className="text-xs leading-[18px] text-hv-text-3">
          {crumbs.map((c, i) => (
            <span key={i}>{i > 0 && <span className="mx-1.5">/</span>}<span className={i === crumbs.length - 1 && !title ? 'text-hv-text-2' : ''}>{c}</span></span>
          ))}
        </nav>
        {title && <h1 className="mt-1 text-2xl leading-8 font-bold text-hv-text">{title}</h1>}
        {description && <p className="mt-1 text-sm leading-5 text-hv-text-2">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
    </div>
  );

/** Collapsed state of the GNB, remembered per browser. Starts collapsed on narrow screens. */
export function useNavCollapsed(): [boolean, () => void] {
  const KEY = 'hv-gnb-collapsed';
  const [c, setC] = useState<boolean>(() => {
    try { const v = localStorage.getItem(KEY); if (v !== null) return v === '1'; } catch { /* storage unavailable */ }
    return typeof window !== 'undefined' && window.innerWidth < 1024;
  });
  const toggle = () => setC(v => { const n = !v; try { localStorage.setItem(KEY, n ? '1' : '0'); } catch { /* ignore */ } return n; });
  return [c, toggle];
}
