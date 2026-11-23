// AETHER_CAMERAS: one live RTSP stream (HLS from the Pi that pulls it).
import React, { useEffect, useRef, useState } from 'react';
import { Trash2, VideoOff, Loader2, Repeat } from 'lucide-react';
import { apiBase, hlsUrl, NodeKey } from './clusterApi';

declare global { interface Window { Hls?: any } }

let hlsLoading: Promise<any> | null = null;
/** hls.js is vendored in /vendor (no npm install needed on the Pi) and loaded on first use. */
function loadHls(): Promise<any> {
  if (window.Hls) return Promise.resolve(window.Hls);
  if (!hlsLoading) {
    hlsLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = `${apiBase()}/vendor/hls.light.min.js`;
      s.async = true;
      s.onload = () => (window.Hls ? resolve(window.Hls) : reject(new Error('hls.js did not load')));
      s.onerror = () => { hlsLoading = null; reject(new Error('hls.js did not load')); };
      document.head.appendChild(s);
    });
  }
  return hlsLoading;
}

type Phase = 'idle' | 'connecting' | 'live' | 'retrying';

interface Props {
  nodeKey: NodeKey;
  cameraId: string;
  name: string;
  nodeName: string;
  dotClass: string;
  nodeOnline: boolean;
  source?: string;          // e.g. "Built-in stream" / "IP camera" on a node's own tile
  onOpen: () => void;
  onRemove?: () => void;    // extra streams
  onSwap?: () => void;      // the node's own tile: built-in stream <-> IP camera
}

const CameraTile: React.FC<Props> = ({ nodeKey, cameraId, name, nodeName, dotClass, nodeOnline, source, onOpen, onRemove, onSwap }) => {
  const wrap = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [visible, setVisible] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [detail, setDetail] = useState('');

  // Only play while the tile is on screen (the overview is hidden while a node is open).
  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting && e.intersectionRatio > 0), { threshold: [0, 0.01] });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const v = video.current;
    if (!visible || !v) { setPhase('idle'); return; }
    let hls: any = null, retry: any = null, stopped = false;
    const src = hlsUrl(nodeKey, cameraId);

    const again = (why: string) => {
      if (stopped) return;
      setPhase('retrying'); setDetail(why);
      if (hls) { try { hls.destroy(); } catch { /* */ } hls = null; }
      clearTimeout(retry); retry = setTimeout(start, 5000);
    };
    const start = async () => {
      if (stopped) return;
      setPhase(p => (p === 'live' ? p : 'connecting'));
      try {
        const Hls = await loadHls();
        if (stopped) return;
        if (Hls.isSupported()) {
          hls = new Hls({ lowLatencyMode: true, xhrSetup: (x: XMLHttpRequest) => { x.withCredentials = true; }, manifestLoadingMaxRetry: 2, backBufferLength: 10 });
          hls.on(Hls.Events.ERROR, (_e: any, d: any) => {
            if (!d.fatal) return;
            const code = d.response && d.response.code;
            again(code === 401 ? 'Signed out' : code === 404 ? 'Stream not found on the Pi' : code === 502 ? 'Pi or camera not answering' : d.details || 'Stream error');
          });
          hls.on(Hls.Events.MANIFEST_PARSED, () => { v.play().catch(() => { /* muted autoplay may still be refused */ }); });
          hls.loadSource(src);
          hls.attachMedia(v);
        } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
          v.src = src; v.play().catch(() => { /* */ });
        } else {
          setPhase('retrying'); setDetail('This browser can\'t play the stream');
        }
      } catch (e: any) { again(e?.message || 'Player failed to load'); }
    };
    const onPlaying = () => { setPhase('live'); setDetail(''); };
    const onStall = () => { if (!stopped) setPhase(p => (p === 'live' ? 'connecting' : p)); };
    v.addEventListener('playing', onPlaying); v.addEventListener('waiting', onStall);
    start();
    return () => {
      stopped = true; clearTimeout(retry);
      v.removeEventListener('playing', onPlaying); v.removeEventListener('waiting', onStall);
      if (hls) { try { hls.destroy(); } catch { /* */ } }
      v.removeAttribute('src'); try { v.load(); } catch { /* */ }
    };
  }, [visible, nodeKey, cameraId]);

  return (
    <div
      ref={wrap}
      role="button" tabIndex={0}
      onClick={onOpen}
      onKeyDown={e => { if (e.key === 'Enter') onOpen(); }}
      className="group relative rounded-xl overflow-hidden border text-left cursor-pointer transition-all hover:ring-2 hover:ring-hv-brand/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-hv-brand"
      style={{ background: '#000', borderColor: 'rgb(var(--hv-line-strong))', aspectRatio: '16 / 9' }}
      title={`${name} · ${nodeName}. Click to open ${nodeName}`}
    >
      <video ref={video} muted playsInline autoPlay className="absolute inset-0 w-full h-full object-contain" />

      {phase !== 'live' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-xs text-slate-400">
          {phase === 'retrying'
            ? <><VideoOff size={22} className="opacity-70" /><span className="px-4 text-center">{detail || 'No signal'}. Retrying...</span></>
            : <><Loader2 size={20} className="animate-spin opacity-70" /><span>Connecting...</span></>}
        </div>
      )}

      <div className="absolute inset-x-0 top-0 flex items-start justify-between p-2.5 bg-gradient-to-b from-black/70 to-transparent">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-white truncate">{name}</div>
          <div className="flex items-center gap-1.5 text-[11px] text-slate-300">
            <span className={`w-2 h-2 rounded-full ${dotClass}`} />
            <span className="truncate">{nodeName}</span>
            {source && <span className="text-slate-400">· {source}</span>}
            {!nodeOnline && <span className="text-slate-400">· offline</span>}
          </div>
        </div>
        {phase === 'live' && (
          <span className="flex-shrink-0 text-[10px] font-bold tracking-wide px-1.5 py-0.5 rounded bg-red-600 text-white">LIVE</span>
        )}
      </div>

      <div className="absolute bottom-2 right-2 hidden group-hover:flex group-focus-within:flex gap-1.5">
        {onSwap && (
          <button type="button" onClick={e => { e.stopPropagation(); onSwap(); }}
            className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-black/70 text-slate-200 hover:text-white" title="Built-in Aether stream or an IP camera">
            <Repeat size={12} /> Change source
          </button>
        )}
        {onRemove && (
          <button type="button" onClick={e => { e.stopPropagation(); onRemove(); }}
            className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-black/70 text-slate-300 hover:text-red-400" title="Remove this stream">
            <Trash2 size={12} /> Remove
          </button>
        )}
      </div>
    </div>
  );
};

export default CameraTile;
