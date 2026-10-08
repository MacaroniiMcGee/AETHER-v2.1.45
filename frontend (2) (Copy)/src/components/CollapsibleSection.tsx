// CollapsibleSection.tsx
//
// Generic wrapper that makes any section collapsible with persistent state.
// The collapse trigger is an obvious chevron arrow — same pattern as the
// per-bus headers inside OSDPBusManager.
//
// Drop into:  frontend/src/components/CollapsibleSection.tsx

import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

interface Props {
  storageKey?: string;
  defaultCollapsed?: boolean;
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  borderClass?: string;       // e.g. 'border-orange-500/30'
  titleColorClass?: string;   // e.g. 'text-orange-400'
  bgClass?: string;           // collapsed bar bg, e.g. 'bg-orange-500/5'
  children: React.ReactNode;
}

export default function CollapsibleSection({
  storageKey,
  defaultCollapsed = false,
  title,
  subtitle,
  icon,
  borderClass = 'border-gray-700',
  titleColorClass = 'text-gray-100',
  bgClass = '',
  children,
}: Props) {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (!storageKey) return defaultCollapsed;
    try {
      const v = localStorage.getItem(storageKey);
      return v === null ? defaultCollapsed : v === 'true';
    } catch { return defaultCollapsed; }
  });

  useEffect(() => {
    if (!storageKey) return;
    try { localStorage.setItem(storageKey, String(collapsed)); } catch { /* swallow */ }
  }, [collapsed, storageKey]);

  // Always show a header bar; chevron rotates based on state. Click anywhere
  // on the bar to toggle. Body appears below the bar when expanded.
  return (
    <div>
      <button
        type="button"
        onClick={() => setCollapsed(c => !c)}
        className={`w-full border ${borderClass} ${collapsed ? 'rounded-lg' : 'rounded-t-lg border-b-0'} p-3 flex items-center gap-3 text-left transition-colors hover:bg-white/5 ${collapsed ? bgClass : ''}`}
        aria-expanded={!collapsed}
        aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${title}`}
      >
        {collapsed
          ? <ChevronRight size={18} className="text-gray-400 shrink-0" />
          : <ChevronDown  size={18} className="text-gray-400 shrink-0" />}
        {icon}
        <span className={`text-base font-medium ${titleColorClass}`}>{title}</span>
        {subtitle && (
          <span className="text-xs text-gray-500 hidden md:inline">— {subtitle}</span>
        )}
        {collapsed && (
          <span className="text-xs text-gray-500 ml-auto italic">click to expand</span>
        )}
      </button>

      {!collapsed && (
        <div className={`border ${borderClass} border-t-0 rounded-b-lg p-3 ${bgClass}`}>
          {children}
        </div>
      )}
    </div>
  );
}
