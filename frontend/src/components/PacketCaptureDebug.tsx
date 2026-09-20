import React, { useState, useEffect } from 'react';
import { Radio, Download, Trash2, Eye, EyeOff, RefreshCw } from 'lucide-react';

interface CapturedPacket {
  timestamp: string;
  direction: 'RX' | 'TX';
  rawHex: string;
  rawLength: number;
  parsed: {
    address: string;
    command: string;
    commandName: string;
    sequence: number;
    isReply: boolean;
    useCRC: boolean;
    hasSecurityBlock: boolean;
    securityBlock?: {
      type: string;
      typeName: string;
      dataHex: string | null;
      dataLength: number;
    };
    dataHex: string | null;
    dataLength: number;
    dataDecoded: any;
  } | null;
}

interface PacketCaptureDebugProps {
  baseUrl?: string;
}

export default function PacketCaptureDebug({ baseUrl = 'http://localhost:3000' }: PacketCaptureDebugProps) {
  const [captureMode, setCaptureMode] = useState(false);
  const [packets, setPackets] = useState<CapturedPacket[]>([]);
  const [packetCount, setPacketCount] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [selectedPacket, setSelectedPacket] = useState<CapturedPacket | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchPackets = async () => {
    try {
      const res = await fetch(`${baseUrl}/api/osdp/capture/packets`);
      const data = await res.json();
      if (data.success) {
        setCaptureMode(data.captureMode);
        setPackets(data.packets || []);
        setPacketCount(data.packetCount || 0);
      }
    } catch (err) {
      console.error('Failed to fetch packets:', err);
    }
  };

  const enableCapture = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${baseUrl}/api/osdp/capture/enable`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setCaptureMode(true);
        await fetchPackets();
      }
    } catch (err) {
      console.error('Failed to enable capture:', err);
    } finally {
      setLoading(false);
    }
  };

  const disableCapture = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${baseUrl}/api/osdp/capture/disable`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setCaptureMode(false);
      }
    } catch (err) {
      console.error('Failed to disable capture:', err);
    } finally {
      setLoading(false);
    }
  };

  const clearPackets = async () => {
    try {
      const res = await fetch(`${baseUrl}/api/osdp/capture/clear`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        await fetchPackets();
      }
    } catch (err) {
      console.error('Failed to clear packets:', err);
    }
  };

  const downloadPackets = () => {
    const dataStr = JSON.stringify(packets, null, 2);
    const dataUri = 'data:application/json;charset=utf-8,' + encodeURIComponent(dataStr);
    const exportFileDefaultName = `osdp-capture-${new Date().toISOString()}.json`;
    
    const linkElement = document.createElement('a');
    linkElement.setAttribute('href', dataUri);
    linkElement.setAttribute('download', exportFileDefaultName);
    linkElement.click();
  };

  useEffect(() => {
    fetchPackets();
    if (autoRefresh) {
      const interval = setInterval(fetchPackets, 1000);
      return () => clearInterval(interval);
    }
  }, [autoRefresh]);

  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString() + '.' + date.getMilliseconds().toString().padStart(3, '0');
  };

  const getCommandColor = (commandName: string) => {
    if (commandName.includes('KEYSET')) return 'text-purple-400';
    if (commandName.includes('CHLNG')) return 'text-cyan-400';
    if (commandName.includes('SCRYPT') || commandName.includes('CCRYPT')) return 'text-blue-400';
    if (commandName.includes('RMAC')) return 'text-green-400';
    if (commandName.includes('NAK')) return 'text-red-400';
    if (commandName.includes('ACK')) return 'text-green-400';
    return 'text-slate-300';
  };

  return (
    <div className="bg-slate-800/50 backdrop-blur rounded-xl p-6 border border-slate-700">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold flex items-center gap-2">
          <Radio className="w-6 h-6 text-cyan-500" />
          Packet Capture Debug
        </h2>
        <div className="flex items-center gap-3">
          <button
            onClick={autoRefresh ? () => setAutoRefresh(false) : () => setAutoRefresh(true)}
            className={`px-3 py-2 rounded-lg font-semibold transition-all flex items-center gap-2 ${
              autoRefresh ? 'bg-cyan-600 hover:bg-cyan-700' : 'bg-slate-700 hover:bg-slate-600'
            }`}
          >
            <RefreshCw className={`w-4 h-4 ${autoRefresh ? 'animate-spin' : ''}`} />
            {autoRefresh ? 'Auto' : 'Manual'}
          </button>
          {!autoRefresh && (
            <button
              onClick={fetchPackets}
              className="px-3 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg font-semibold transition-all"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      <div className="flex gap-3 mb-4">
        {!captureMode ? (
          <button
            onClick={enableCapture}
            disabled={loading}
            className="flex-1 px-4 py-3 bg-green-600 hover:bg-green-700 disabled:opacity-50 rounded-lg font-semibold transition-all flex items-center justify-center gap-2"
          >
            <Eye className="w-5 h-5" />
            Enable Capture Mode
          </button>
        ) : (
          <button
            onClick={disableCapture}
            disabled={loading}
            className="flex-1 px-4 py-3 bg-red-600 hover:bg-red-700 disabled:opacity-50 rounded-lg font-semibold transition-all flex items-center justify-center gap-2"
          >
            <EyeOff className="w-5 h-5" />
            Disable Capture Mode
          </button>
        )}
        <button
          onClick={clearPackets}
          disabled={packets.length === 0}
          className="px-4 py-3 bg-orange-600 hover:bg-orange-700 disabled:opacity-30 rounded-lg font-semibold transition-all flex items-center gap-2"
        >
          <Trash2 className="w-5 h-5" />
          Clear
        </button>
        <button
          onClick={downloadPackets}
          disabled={packets.length === 0}
          className="px-4 py-3 bg-blue-600 hover:bg-blue-700 disabled:opacity-30 rounded-lg font-semibold transition-all flex items-center gap-2"
        >
          <Download className="w-5 h-5" />
          Export
        </button>
      </div>

      <div className="mb-4 p-3 bg-slate-900/70 rounded-lg border border-slate-600">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <div className={`w-3 h-3 rounded-full ${captureMode ? 'bg-green-500 animate-pulse' : 'bg-slate-600'}`} />
              <span className="text-sm font-semibold">
                {captureMode ? 'Capturing' : 'Stopped'}
              </span>
            </div>
            <div className="text-sm text-slate-400">
              {packetCount} packet{packetCount !== 1 ? 's' : ''} captured
            </div>
          </div>
        </div>
      </div>

      {captureMode && (
        <div className="mb-4 p-3 bg-yellow-900/30 border border-yellow-600/50 rounded-lg text-yellow-200 text-sm">
          <strong>📡 Capture Mode Active:</strong> Change your controller to OSDP Secured Mode and select "Change Keyset" to capture KEYSET commands.
        </div>
      )}

      <div className="space-y-2 max-h-96 overflow-y-auto">
        {packets.length === 0 ? (
          <div className="text-center text-slate-400 py-8">
            No packets captured yet. Enable capture mode and trigger OSDP communication.
          </div>
        ) : (
          packets.slice().reverse().map((packet, idx) => (
            <div
              key={packets.length - idx}
              onClick={() => setSelectedPacket(packet)}
              className={`p-3 rounded-lg border transition-all cursor-pointer ${
                selectedPacket === packet
                  ? 'bg-cyan-900/50 border-cyan-500'
                  : 'bg-slate-900/50 border-slate-600 hover:border-slate-500'
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-3">
                  <span className={`font-mono font-bold text-sm ${
                    packet.direction === 'RX' ? 'text-green-400' : 'text-blue-400'
                  }`}>
                    {packet.direction === 'RX' ? '← RX' : '→ TX'}
                  </span>
                  <span className="text-xs text-slate-400">{formatTimestamp(packet.timestamp)}</span>
                  {packet.parsed && (
                    <span className={`font-mono font-bold ${getCommandColor(packet.parsed.commandName)}`}>
                      {packet.parsed.commandName}
                    </span>
                  )}
                </div>
                <span className="text-xs text-slate-400">{packet.rawLength} bytes</span>
              </div>
              <div className="font-mono text-xs text-slate-300 break-all">
                {packet.rawHex.match(/.{1,32}/g)?.join(' ')}
              </div>
              {selectedPacket === packet && packet.parsed && (
                <div className="mt-3 pt-3 border-t border-slate-600 space-y-2">
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div><span className="text-slate-400">Address:</span> <span className="font-mono">{packet.parsed.address}</span></div>
                    <div><span className="text-slate-400">Sequence:</span> <span className="font-mono">{packet.parsed.sequence}</span></div>
                    <div><span className="text-slate-400">CRC:</span> <span className="font-mono">{packet.parsed.useCRC ? 'Yes' : 'No'}</span></div>
                    <div><span className="text-slate-400">Reply:</span> <span className="font-mono">{packet.parsed.isReply ? 'Yes' : 'No'}</span></div>
                  </div>
                  {packet.parsed.securityBlock && (
                    <div className="p-2 bg-cyan-900/30 rounded border border-cyan-600/50">
                      <div className="text-xs font-semibold text-cyan-300 mb-1">Security Block</div>
                      <div className="text-xs"><span className="text-slate-400">Type:</span> <span className="font-mono text-cyan-200">{packet.parsed.securityBlock.typeName}</span></div>
                      {packet.parsed.securityBlock.dataHex && (
                        <div className="text-xs mt-1"><span className="text-slate-400">Data:</span> <span className="font-mono text-cyan-200 break-all">{packet.parsed.securityBlock.dataHex}</span></div>
                      )}
                    </div>
                  )}
                  {packet.parsed.dataDecoded && (
                    <div className="p-2 bg-purple-900/30 rounded border border-purple-600/50">
                      <div className="text-xs font-semibold text-purple-300 mb-1">Decoded Data</div>
                      <pre className="text-xs text-purple-200 overflow-x-auto">
                        {JSON.stringify(packet.parsed.dataDecoded, null, 2)}
                      </pre>
                    </div>
                  )}
                  {packet.parsed.dataHex && !packet.parsed.dataDecoded && (
                    <div className="text-xs">
                      <span className="text-slate-400">Raw Data:</span>
                      <div className="font-mono text-slate-300 break-all mt-1">{packet.parsed.dataHex}</div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
