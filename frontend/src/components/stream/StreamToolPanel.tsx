import React, { useEffect, useState } from 'react';
import { Copy, Check, Radio, CircleDot, PauseCircle, AlertTriangle, ExternalLink } from 'lucide-react';
import StreamView from '../StreamView';

/**
 * Setup & Tools → Tools → VMS Stream. Shows the RTSP URL to enrol in the VMS, whether the
 * stream is currently running, and a live, scaled copy of what the VMS sees.
 */

type StreamStatus = {
  installed: boolean;
  rtspUrl: string;
  ready: boolean;
  viewers: number;
  error?: string;
};

const StreamToolPanel: React.FC<{ ipAddress: string }> = ({ ipAddress }) => {
  const backend = `http://${ipAddress}:3001`;
  const [status, setStatus] = useState<StreamStatus | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const r = await fetch(`${backend}/api/vms/stream-status`);
        const d = await r.json();
        if (!stop) setStatus(d);
      } catch {
        if (!stop) setStatus(null);
      }
    };
    load();
    const t = setInterval(load, 3000);
    return () => { stop = true; clearInterval(t); };
  }, [backend]);

  // localhost is meaningless to a VMS; fall back to the address typed in the header
  const rtspUrl = status?.rtspUrl
    ? status.rtspUrl.replace('127.0.0.1', ipAddress === 'localhost' ? '127.0.0.1' : ipAddress)
    : `rtsp://${ipAddress}:8554/aether`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(rtspUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked on http; the URL is selectable */ }
  };

  const badge = !status
    ? { Icon: AlertTriangle, text: 'Backend unreachable', cls: 'text-hv-error-text border-hv-error/40 bg-hv-error/10' }
    : !status.installed
      ? { Icon: AlertTriangle, text: 'RTSP service not running on this unit', cls: 'text-hv-brand-text border-hv-brand/40 bg-hv-brand/10' }
      : status.ready
        ? { Icon: CircleDot, text: `Streaming · ${status.viewers} viewer${status.viewers === 1 ? '' : 's'}`, cls: 'text-hv-success-text border-hv-success-text/40 bg-hv-success-text/10' }
        : { Icon: PauseCircle, text: 'Idle · starts when a VMS connects', cls: 'text-hv-text-2 border-hv-line bg-hv-widget' };

  return (
    <div className="space-y-4">
      <div className="rounded-xl p-5 border" style={{ background: 'linear-gradient(160deg, rgb(var(--hv-widget)), rgb(var(--hv-widget-panel)))', borderColor: 'rgb(var(--hv-line))' }}>
        <div className="flex items-start justify-between flex-wrap gap-4">
          <div className="min-w-0">
            <h2 className="text-xl font-bold text-hv-text flex items-center gap-2"><Radio className="w-6 h-6 text-hv-success-text" /> VMS Stream</h2>
            <p className="text-sm text-hv-text-2 mt-1">Add this unit to Wave, Genetec or Milestone as a generic RTSP camera. H.264, 1920×1080, low frame rate.</p>
            <div className="mt-3 flex items-center gap-2 flex-wrap">
              <code className="px-3 py-2 rounded-lg bg-hv-surface border border-hv-line text-hv-text text-sm select-all break-all">{rtspUrl}</code>
              <button onClick={copy} className="inline-flex items-center gap-1 px-3 py-2 rounded-lg border border-hv-line text-sm text-hv-text-2 hover:text-hv-text">
                {copied ? <Check className="w-4 h-4 text-hv-success-text" /> : <Copy className="w-4 h-4" />} {copied ? 'Copied' : 'Copy'}
              </button>
              <a href={`/stream?backend=${encodeURIComponent(ipAddress)}`} target="_blank" rel="noreferrer"
                className="inline-flex items-center gap-1 px-3 py-2 rounded-lg border border-hv-line text-sm text-hv-text-2 hover:text-hv-text">
                <ExternalLink className="w-4 h-4" /> Full screen
              </a>
            </div>
          </div>
          <span className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full border text-sm ${badge.cls}`}>
            <badge.Icon className="w-4 h-4" /> {badge.text}
          </span>
        </div>
        <div className="grid md:grid-cols-3 gap-3 mt-4 text-xs text-hv-text-2">
          <div className="p-3 rounded-lg bg-hv-surface/60 border border-hv-line"><span className="text-hv-text font-semibold">Wave:</span> Add Device → enter the RTSP URL → no credentials.</div>
          <div className="p-3 rounded-lg bg-hv-surface/60 border border-hv-line"><span className="text-hv-text font-semibold">Genetec:</span> Add video unit → manufacturer <em>RTSP</em> (generic) → IP, port 8554, path <code>/aether</code>.</div>
          <div className="p-3 rounded-lg bg-hv-surface/60 border border-hv-line"><span className="text-hv-text font-semibold">Milestone:</span> Add hardware → Manual → driver <em>Universal 1 channel</em> → IP, RTSP port 8554, path <code>aether</code>.</div>
        </div>
      </div>
      <StreamView embedded backendUrl={backend} />
    </div>
  );
};

export default StreamToolPanel;
