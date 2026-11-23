// AETHER_CAMERAS: a node's own tile showing its Stream View, drawn live in this page
// (same picture the VMS stream records, but no capture or video service needed).
// Data comes from http://<node>:3001; for enrolled nodes the cluster gateway sends it through this Pi.
import React, { useEffect, useRef, useState } from 'react';
import { Repeat } from 'lucide-react';
import StreamView from '../components/StreamView';

interface Props {
  host: string;
  nodeName: string;
  dotClass: string;
  nodeOnline: boolean;
  onOpen: () => void;
  onSwap?: () => void;
}

const StreamViewTile: React.FC<Props> = ({ host, nodeName, dotClass, nodeOnline, onOpen, onSwap }) => {
  const wrap = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  // Only connected while on screen (the overview is hidden while a node is open).
  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting && e.intersectionRatio > 0), { threshold: [0, 0.01] });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={wrap}
      role="button" tabIndex={0}
      onClick={onOpen}
      onKeyDown={e => { if (e.key === 'Enter') onOpen(); }}
      className="group relative rounded-xl overflow-hidden text-left cursor-pointer transition-all hover:ring-2 hover:ring-hv-brand/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-hv-brand"
      style={{ aspectRatio: '16 / 9', background: 'rgb(var(--hv-widget))' }}
      title={`${nodeName} · Stream View. Click to open ${nodeName}`}
    >
      <div className="absolute inset-0" style={{ pointerEvents: 'none' }}>
        {visible && <StreamView embedded backendUrl={`http://${host}:3001`} />}
      </div>

      <div className="absolute left-2 bottom-2 flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-md bg-black/70 text-slate-200">
        <span className={`w-2 h-2 rounded-full ${dotClass}`} />
        <span className="font-semibold">{nodeName}</span>
        <span className="text-slate-400">· Stream View</span>
        {!nodeOnline && <span className="text-slate-400">· offline</span>}
      </div>

      {onSwap && (
        <button type="button" onClick={e => { e.stopPropagation(); onSwap(); }}
          className="absolute bottom-2 right-2 hidden group-hover:flex group-focus-within:flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-black/70 text-slate-200 hover:text-white"
          title="Stream View or an RTSP camera">
          <Repeat size={12} /> Change source
        </button>
      )}
    </div>
  );
};

export default StreamViewTile;
