//OSDPTransferTool
import React, { useState, useEffect } from 'react';
import { ArrowRightLeft, Download, Upload, Copy, Trash2, RefreshCw, CheckCircle, AlertCircle, FileUp, Cpu } from 'lucide-react';

interface Reader {
  id: string;
  name: string;
  address: number;
  enabled: boolean;
  status?: string;
}

interface TransferItem {
  id: string;
  type: 'card' | 'keypad' | 'config' | 'credentials' | 'firmware';
  name: string;
  data: any;
  timestamp: number;
  fileSize?: number;
}

interface FirmwareInfo {
  name: string;
  size: number;
  type: string;
}

interface OSDPTransferToolProps {
  ipAddress: string;
  connected: boolean;
  readers: Reader[];
  onLog: (message: string) => void;
}

export default function OSDPTransferTool({ ipAddress, connected, readers, onLog }: OSDPTransferToolProps) {
  const [sourceReader, setSourceReader] = useState<string>('');
  const [targetReader, setTargetReader] = useState<string>('');
  const [transferType, setTransferType] = useState<'card' | 'keypad' | 'config' | 'credentials' | 'firmware'>('card');
  const [transferQueue, setTransferQueue] = useState<TransferItem[]>([]);
  const [isTransferring, setIsTransferring] = useState(false);
  const [transferStatus, setTransferStatus] = useState<{ success: number; failed: number }>({ success: 0, failed: 0 });
  const [transferProgress, setTransferProgress] = useState<number>(0);
  
  // Firmware upload state
  const [firmwareFile, setFirmwareFile] = useState<File | null>(null);
  const [firmwareInfo, setFirmwareInfo] = useState<FirmwareInfo | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [isUploading, setIsUploading] = useState(false);
  
  const apiUrl = `http://${ipAddress}:3001`;

  // Auto-select first two readers if available
  useEffect(() => {
    if (readers.length >= 2 && !sourceReader && !targetReader) {
      setSourceReader(readers[0].id);
      setTargetReader(readers[1].id);
    }
  }, [readers]);

  const captureFromSource = async () => {
    if (!sourceReader) {
      alert('Please select a source reader');
      return;
    }

    try {
      const res = await fetch(`${apiUrl}/api/osdp/capture/${sourceReader}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: transferType })
      });

      const data = await res.json();
      if (data.success) {
        const newItem: TransferItem = {
          id: `${Date.now()}-${Math.random()}`,
          type: transferType,
          name: `${transferType} from ${readers.find(r => r.id === sourceReader)?.name}`,
          data: data.capturedData,
          timestamp: Date.now()
        };
        
        setTransferQueue(prev => [...prev, newItem]);
        onLog(`✓ Captured ${transferType} from source reader`);
      } else {
        onLog(`✗ Capture failed: ${data.error}`);
        alert(`Error: ${data.error}`);
      }
    } catch (err: any) {
      onLog(`✗ Capture error: ${err.message}`);
      alert(`Failed to capture: ${err.message}`);
    }
  };

  const transferToTarget = async (item: TransferItem) => {
    if (!targetReader) {
      alert('Please select a target reader');
      return;
    }

    setIsTransferring(true);
    setTransferProgress(0);
    
    try {
      const res = await fetch(`${apiUrl}/api/osdp/transfer/${targetReader}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: item.type,
          data: item.data
        })
      });

      const data = await res.json();
      if (data.success) {
        setTransferStatus(prev => ({ ...prev, success: prev.success + 1 }));
        onLog(`✓ Transferred ${item.type} to target reader`);
        
        // Remove from queue after successful transfer
        setTransferQueue(prev => prev.filter(i => i.id !== item.id));
      } else {
        setTransferStatus(prev => ({ ...prev, failed: prev.failed + 1 }));
        onLog(`✗ Transfer failed: ${data.error}`);
        alert(`Error: ${data.error}`);
      }
    } catch (err: any) {
      setTransferStatus(prev => ({ ...prev, failed: prev.failed + 1 }));
      onLog(`✗ Transfer error: ${err.message}`);
      alert(`Failed to transfer: ${err.message}`);
    } finally {
      setIsTransferring(false);
      setTransferProgress(0);
    }
  };

  const transferAllToTarget = async () => {
    if (!targetReader || transferQueue.length === 0) {
      alert('No items in transfer queue');
      return;
    }

    setIsTransferring(true);
    setTransferStatus({ success: 0, failed: 0 });

    for (const item of transferQueue) {
      await transferToTarget(item);
      // Small delay between transfers
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    setIsTransferring(false);
    alert(`Transfer complete: ${transferStatus.success} succeeded, ${transferStatus.failed} failed`);
  };

  const handleFirmwareFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // Check if it's a .bin file
    if (!file.name.endsWith('.bin')) {
      alert('Please select a .bin firmware file');
      return;
    }

    setFirmwareFile(file);
    setFirmwareInfo({
      name: file.name,
      size: file.size,
      type: file.type || 'application/octet-stream'
    });
    
    onLog(`✓ Firmware file selected: ${file.name} (${(file.size / 1024).toFixed(2)} KB)`);
  };

  const uploadFirmware = async () => {
    if (!firmwareFile || !targetReader) {
      alert('Please select a firmware file and target reader');
      return;
    }

    setIsUploading(true);
    setUploadProgress(0);
    onLog(`Starting firmware upload to ${readers.find(r => r.id === targetReader)?.name}...`);

    try {
      const formData = new FormData();
      formData.append('firmware', firmwareFile);
      formData.append('readerId', targetReader);

      const xhr = new XMLHttpRequest();

      // Track upload progress
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          const percentComplete = Math.round((e.loaded / e.total) * 100);
          setUploadProgress(percentComplete);
          onLog(`Upload progress: ${percentComplete}%`);
        }
      });

      xhr.addEventListener('load', () => {
        if (xhr.status === 200) {
          const response = JSON.parse(xhr.responseText);
          if (response.success) {
            onLog(`✓ Firmware upload successful!`);
            alert('Firmware uploaded successfully! Reader may reboot.');
            setFirmwareFile(null);
            setFirmwareInfo(null);
            setUploadProgress(0);
          } else {
            onLog(`✗ Firmware upload failed: ${response.error}`);
            alert(`Upload failed: ${response.error}`);
          }
        } else {
          onLog(`✗ Upload error: HTTP ${xhr.status}`);
          alert(`Upload error: HTTP ${xhr.status}`);
        }
        setIsUploading(false);
      });

      xhr.addEventListener('error', () => {
        onLog(`✗ Upload error: Network error`);
        alert('Upload failed: Network error');
        setIsUploading(false);
      });

      xhr.open('POST', `${apiUrl}/api/osdp/firmware-upload`);
      xhr.send(formData);

    } catch (err: any) {
      onLog(`✗ Upload error: ${err.message}`);
      alert(`Failed to upload: ${err.message}`);
      setIsUploading(false);
    }
  };

  const swapReaders = () => {
    const temp = sourceReader;
    setSourceReader(targetReader);
    setTargetReader(temp);
  };

  const clearQueue = () => {
    if (confirm('Clear all items from transfer queue?')) {
      setTransferQueue([]);
      setTransferStatus({ success: 0, failed: 0 });
      onLog('Transfer queue cleared');
    }
  };

  const removeFromQueue = (id: string) => {
    setTransferQueue(prev => prev.filter(item => item.id !== id));
  };

  const exportQueue = () => {
    const dataStr = JSON.stringify(transferQueue, null, 2);
    const dataBlob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `osdp-transfer-queue-${Date.now()}.json`;
    link.click();
    onLog('✓ Transfer queue exported');
  };

  const importQueue = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const imported = JSON.parse(e.target?.result as string);
        setTransferQueue(prev => [...prev, ...imported]);
        onLog(`✓ Imported ${imported.length} items`);
      } catch (err: any) {
        alert('Failed to import file: Invalid format');
        onLog(`✗ Import failed: ${err.message}`);
      }
    };
    reader.readAsText(file);
  };

  const getReaderName = (id: string) => {
    return readers.find(r => r.id === id)?.name || 'Unknown';
  };

  return (
    <div className="space-y-6">
      {/* Transfer Status Card */}
      <div className="bg-gradient-to-r from-purple-900/30 to-blue-900/30 backdrop-blur rounded-xl p-6 border border-purple-700/50">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center space-x-2">
            <ArrowRightLeft className="w-6 h-6 text-purple-400" />
            <h2 className="text-2xl font-bold text-white">OSDP Transfer Tool</h2>
          </div>
          <div className="flex items-center space-x-4 text-sm">
            <div className="flex items-center space-x-2">
              <CheckCircle className="w-4 h-4 text-green-400" />
              <span className="text-green-400">{transferStatus.success} Success</span>
            </div>
            <div className="flex items-center space-x-2">
              <AlertCircle className="w-4 h-4 text-red-400" />
              <span className="text-red-400">{transferStatus.failed} Failed</span>
            </div>
          </div>
        </div>
        <p className="text-slate-300">
          Capture and transfer data between OSDP readers, or upload firmware updates.
        </p>
      </div>

      {/* Firmware Upload Section */}
      <div className="bg-slate-800/50 backdrop-blur rounded-xl p-6 border border-slate-700">
        <div className="flex items-center space-x-2 mb-4">
          <Cpu className="w-5 h-5 text-orange-400" />
          <h3 className="text-lg font-semibold text-white">Firmware Upload</h3>
          <span className="px-2 py-1 bg-orange-600/20 text-orange-400 text-xs rounded-full">
            Hanwha/WaveLynx Compatible
          </span>
        </div>

        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">Target Reader</label>
            <select
              value={targetReader}
              onChange={(e) => setTargetReader(e.target.value)}
              className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded text-white"
            >
              <option value="">Select target...</option>
              {readers.map(reader => (
                <option key={reader.id} value={reader.id} disabled={!reader.enabled}>
                  {reader.name} {!reader.enabled && '(disabled)'}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">Firmware File (.bin)</label>
            <label className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded text-white hover:bg-slate-700 cursor-pointer flex items-center justify-center">
              <FileUp className="w-4 h-4 mr-2" />
              {firmwareFile ? firmwareFile.name : 'Choose File'}
              <input
                type="file"
                accept=".bin"
                onChange={handleFirmwareFileSelect}
                className="hidden"
              />
            </label>
          </div>
        </div>

        {firmwareInfo && (
          <div className="mb-4 p-3 bg-slate-900/50 rounded border border-slate-700">
            <div className="flex items-center justify-between text-sm">
              <div>
                <div className="text-white font-medium">{firmwareInfo.name}</div>
                <div className="text-slate-400">Size: {(firmwareInfo.size / 1024).toFixed(2)} KB</div>
              </div>
              <button
                onClick={() => {
                  setFirmwareFile(null);
                  setFirmwareInfo(null);
                }}
                className="p-2 bg-red-600/20 hover:bg-red-600/30 text-red-400 rounded"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {isUploading && (
          <div className="mb-4">
            <div className="flex items-center justify-between text-sm text-slate-300 mb-2">
              <span>Uploading firmware...</span>
              <span>{uploadProgress}%</span>
            </div>
            <div className="w-full bg-slate-700 rounded-full h-2">
              <div
                className="bg-orange-500 h-2 rounded-full transition-all duration-300"
                style={{ width: `${uploadProgress}%` }}
              />
            </div>
          </div>
        )}

        <button
          onClick={uploadFirmware}
          disabled={!firmwareFile || !targetReader || isUploading || !connected}
          className="w-full py-3 bg-orange-600 hover:bg-orange-700 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-lg font-semibold transition-colors"
        >
          {isUploading ? 'Uploading...' : 'Upload Firmware to Reader'}
        </button>

        <div className="mt-3 text-xs text-slate-500">
          ⚠️ Reader will reboot after firmware upload. Ensure stable power supply.
        </div>
      </div>

      {/* Reader Selection */}
      <div className="grid grid-cols-3 gap-4">
        {/* Source Reader */}
        <div className="bg-slate-800/50 backdrop-blur rounded-xl p-6 border border-slate-700">
          <div className="flex items-center space-x-2 mb-3">
            <Upload className="w-5 h-5 text-blue-400" />
            <h3 className="text-lg font-semibold text-white">Source Reader</h3>
          </div>
          <select
            value={sourceReader}
            onChange={(e) => setSourceReader(e.target.value)}
            className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded text-white mb-3"
          >
            <option value="">Select source...</option>
            {readers.map(reader => (
              <option key={reader.id} value={reader.id} disabled={!reader.enabled}>
                {reader.name} {!reader.enabled && '(disabled)'}
              </option>
            ))}
          </select>
          
          {sourceReader && (
            <div className="text-sm text-slate-400">
              Address: 0x{readers.find(r => r.id === sourceReader)?.address.toString(16).toUpperCase()}
            </div>
          )}
        </div>

        {/* Swap Button */}
        <div className="flex items-center justify-center">
          <button
            onClick={swapReaders}
            className="p-4 bg-purple-600/20 hover:bg-purple-600/30 text-purple-400 rounded-full border border-purple-500/50 transition-all"
            title="Swap source and target"
          >
            <RefreshCw className="w-6 h-6" />
          </button>
        </div>

        {/* Target Reader */}
        <div className="bg-slate-800/50 backdrop-blur rounded-xl p-6 border border-slate-700">
          <div className="flex items-center space-x-2 mb-3">
            <Download className="w-5 h-5 text-green-400" />
            <h3 className="text-lg font-semibold text-white">Target Reader</h3>
          </div>
          <select
            value={targetReader}
            onChange={(e) => setTargetReader(e.target.value)}
            className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded text-white mb-3"
          >
            <option value="">Select target...</option>
            {readers.map(reader => (
              <option key={reader.id} value={reader.id} disabled={!reader.enabled}>
                {reader.name} {!reader.enabled && '(disabled)'}
              </option>
            ))}
          </select>
          
          {targetReader && (
            <div className="text-sm text-slate-400">
              Address: 0x{readers.find(r => r.id === targetReader)?.address.toString(16).toUpperCase()}
            </div>
          )}
        </div>
      </div>

      {/* Capture Controls */}
      <div className="bg-slate-800/50 backdrop-blur rounded-xl p-6 border border-slate-700">
        <h3 className="text-lg font-semibold text-white mb-4">Capture Data</h3>
        
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">Transfer Type</label>
            <select
              value={transferType}
              onChange={(e) => setTransferType(e.target.value as any)}
              className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded text-white"
            >
              <option value="card">Card Data</option>
              <option value="keypad">Keypad Data</option>
              <option value="config">Reader Config</option>
              <option value="credentials">Credentials</option>
            </select>
          </div>
        </div>

        <button
          onClick={captureFromSource}
          disabled={!sourceReader || !connected}
          className="w-full py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-lg font-semibold transition-colors"
        >
          Capture from Source
        </button>
      </div>

      {/* Transfer Queue */}
      <div className="bg-slate-800/50 backdrop-blur rounded-xl p-6 border border-slate-700">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-white">
            Transfer Queue ({transferQueue.length} items)
          </h3>
          
          <div className="flex items-center space-x-2">
            <label className="px-3 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded cursor-pointer text-sm">
              Import
              <input
                type="file"
                accept=".json"
                onChange={importQueue}
                className="hidden"
              />
            </label>
            
            <button
              onClick={exportQueue}
              disabled={transferQueue.length === 0}
              className="px-3 py-2 bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:text-slate-600 text-white rounded text-sm"
            >
              Export
            </button>
            
            <button
              onClick={clearQueue}
              disabled={transferQueue.length === 0}
              className="px-3 py-2 bg-red-600/20 hover:bg-red-600/30 disabled:bg-slate-800 disabled:text-slate-600 text-red-400 rounded text-sm"
            >
              Clear All
            </button>
          </div>
        </div>

        {transferQueue.length === 0 ? (
          <div className="text-center py-8 text-slate-500">
            No items in queue. Capture data from source reader to begin.
          </div>
        ) : (
          <>
            <div className="space-y-2 mb-4">
              {transferQueue.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between p-4 bg-slate-900/50 rounded-lg border border-slate-700"
                >
                  <div className="flex-1">
                    <div className="flex items-center space-x-3">
                      <span className="px-2 py-1 bg-purple-600/20 text-purple-400 text-xs rounded">
                        {item.type.toUpperCase()}
                      </span>
                      <span className="text-white font-medium">{item.name}</span>
                    </div>
                    <div className="text-xs text-slate-500 mt-1">
                      {new Date(item.timestamp).toLocaleString()}
                    </div>
                  </div>
                  
                  <div className="flex items-center space-x-2">
                    <button
                      onClick={() => transferToTarget(item)}
                      disabled={!targetReader || isTransferring}
                      className="px-3 py-2 bg-green-600 hover:bg-green-700 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded text-sm"
                    >
                      Transfer
                    </button>
                    
                    <button
                      onClick={() => removeFromQueue(item.id)}
                      className="p-2 bg-red-600/20 hover:bg-red-600/30 text-red-400 rounded"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <button
              onClick={transferAllToTarget}
              disabled={!targetReader || isTransferring || transferQueue.length === 0}
              className="w-full py-3 bg-purple-600 hover:bg-purple-700 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-lg font-semibold transition-colors"
            >
              {isTransferring ? 'Transferring...' : `Transfer All to Target (${transferQueue.length})`}
            </button>
          </>
        )}
      </div>

      {/* Info Box */}
      <div className="bg-blue-900/20 backdrop-blur rounded-xl p-4 border border-blue-700/50">
        <div className="flex items-start space-x-3">
          <AlertCircle className="w-5 h-5 text-blue-400 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-blue-200">
            <strong>Features:</strong> Upload Hanwha/WaveLynx firmware (.bin files), 
            transfer configuration between readers, or queue multiple data transfers. 
            Compatible with the WaveLynx Python OSDP Console protocol.
          </div>
        </div>
      </div>
    </div>
  );
}
