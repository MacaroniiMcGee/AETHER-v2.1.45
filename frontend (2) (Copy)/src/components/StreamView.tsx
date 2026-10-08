import React, { useEffect, useState, useRef } from 'react';
import { Activity, AlertCircle, DoorOpen, Radio, TrendingUp, BarChart3, Clock, Zap, Building, Settings, Bell, FileText } from 'lucide-react';

// Auto-detect backend URL based on current host
const getBackendUrl = () => {
  const hostname = window.location.hostname;
  return hostname === 'localhost' ? 'http://localhost:3001' : `http://${hostname}:3001`;
};

// Mini Door Animation Component (FIXED)
const MiniDoorAnimation: React.FC<{
  doorName: string;
  isLocked: boolean;
  isOpen: boolean;
  rexActive: boolean;
  enabled: boolean;
}> = ({ doorName, isLocked, isOpen, rexActive, enabled }) => {
  return (
    <div className="relative h-32 bg-gradient-to-b from-slate-800 to-slate-900 rounded-lg border border-slate-700 overflow-hidden">
      <svg className="w-full h-full" viewBox="0 0 200 150" preserveAspectRatio="xMidYMid meet">
        {/* Floor */}
        <rect x="0" y="120" width="200" height="30" fill="#1e293b" />
        <line x1="0" y1="120" x2="200" y2="120" stroke="#475569" strokeWidth="1" />
        
        {/* Wall */}
        <rect x="0" y="0" width="200" height="120" fill="#0f172a" />
        
        {/* Door Frame */}
        <rect x="50" y="20" width="100" height="100" fill="#334155" stroke="#475569" strokeWidth="2" />
        
        {enabled ? (
          <>
            {isOpen ? (
              <>
                {/* Open Door */}
                <rect 
                  x="52" 
                  y="22" 
                  width="95" 
                  height="95" 
                  fill="#475569" 
                  stroke="#64748b" 
                  strokeWidth="2"
                  opacity="0.3"
                  rx="2"
                />
                
                {/* Person walking through */}
                <g className={rexActive ? "animate-pulse" : ""}>
                  <ellipse cx="100" cy="110" rx="10" ry="5" fill="#3b82f6" opacity="0.3" />
                  <circle cx="100" cy="70" r="12" fill="#60a5fa" />
                  <rect x="93" y="82" width="14" height="28" fill="#60a5fa" rx="3" />
                  <circle cx="100" cy="60" r="8" fill="#93c5fd" />
                  
                  {rexActive && (
                    <>
                      <rect x="75" y="48" width="50" height="10" fill="#10b981" opacity="0.95" rx="2" className="animate-pulse" />
                      <text x="100" y="56" textAnchor="middle" fill="white" fontSize="8" fontWeight="bold">REX</text>
                    </>
                  )}
                </g>
              </>
            ) : (
              <>
                {/* Closed Door */}
                <rect 
                  x="52" 
                  y="24" 
                  width="95" 
                  height="92" 
                  fill="#64748b" 
                  stroke="#94a3b8" 
                  strokeWidth="2"
                  rx="2"
                />
                
                {/* Door panels */}
                <rect x="60" y="35" width="37" height="35" fill="#475569" stroke="#64748b" strokeWidth="1" />
                <rect x="102" y="35" width="37" height="35" fill="#475569" stroke="#64748b" strokeWidth="1" />
                <rect x="60" y="75" width="37" height="35" fill="#475569" stroke="#64748b" strokeWidth="1" />
                <rect x="102" y="75" width="37" height="35" fill="#475569" stroke="#64748b" strokeWidth="1" />
                
                {/* Door Handle */}
                <circle 
                  cx="132" 
                  cy="70" 
                  r="5" 
                  fill={isLocked ? "#ef4444" : "#10b981"} 
                  stroke={isLocked ? "#dc2626" : "#059669"} 
                  strokeWidth="1"
                  className={!isLocked ? "animate-pulse" : ""}
                />
                <rect 
                  x="120" 
                  y="68.5" 
                  width="12" 
                  height="3" 
                  fill={isLocked ? "#ef4444" : "#10b981"} 
                  rx="1"
                />
                
                {/* REX Indicator */}
                {rexActive && (
                  <>
                    <rect x="65" y="48" width="70" height="14" fill="#10b981" opacity="0.9" rx="3" className="animate-pulse" />
                    <text x="100" y="58" textAnchor="middle" fill="white" fontSize="9" fontWeight="bold">REX ACTIVE</text>
                  </>
                )}
              </>
            )}
          </>
        ) : (
          <>
            {/* Disabled Door */}
            <rect 
              x="52" 
              y="24" 
              width="95" 
              height="92" 
              fill="#334155" 
              stroke="#475569" 
              strokeWidth="2"
              opacity="0.5"
              rx="2"
            />
            <text x="100" y="75" textAnchor="middle" fill="#64748b" fontSize="12" fontWeight="bold">DISABLED</text>
          </>
        )}
      </svg>
      
      {/* Door Name Label */}
      <div className="absolute top-1 left-1 bg-slate-900/90 px-2 py-1 rounded border border-slate-700">
        <div className="text-[10px] font-bold text-white">{doorName}</div>
      </div>

      {/* Status Badge */}
      <div className="absolute bottom-1 right-1">
        {enabled && (
          <>
            {isOpen && (
              <div className="bg-blue-900/80 px-2 py-0.5 rounded-full text-[9px] font-bold text-blue-200 border border-blue-700">
                OPEN
              </div>
            )}
            {!isOpen && isLocked && (
              <div className="bg-red-900/80 px-2 py-0.5 rounded-full text-[9px] font-bold text-red-200 border border-red-700">
                LOCKED
              </div>
            )}
            {!isOpen && !isLocked && (
              <div className="bg-green-900/80 px-2 py-0.5 rounded-full text-[9px] font-bold text-green-200 border border-green-700 animate-pulse">
                READY
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

// Mini Elevator Display Component
const MiniElevatorDisplay: React.FC<{
  currentFloor: number;
  targetFloor: number;
  moving: boolean;
}> = ({ currentFloor, targetFloor, moving }) => {
  return (
    <div className="relative h-32 bg-gradient-to-b from-slate-800 to-slate-900 rounded-lg border border-slate-700 overflow-hidden">
      <svg className="w-full h-full" viewBox="0 0 200 150" preserveAspectRatio="xMidYMid meet">
        {/* Elevator Shaft */}
        <rect x="70" y="10" width="60" height="130" fill="#1e293b" stroke="#475569" strokeWidth="2" />
        
        {/* Floor Markers */}
        {[8, 7, 6, 5, 4, 3, 2, 1].map((floor, idx) => (
          <g key={floor}>
            <line x1="50" y1={25 + idx * 15} x2="65" y2={25 + idx * 15} stroke="#475569" strokeWidth="1" />
            <text x="40" y={29 + idx * 15} fill="#64748b" fontSize="10" fontWeight="bold">{floor}</text>
            {floor === currentFloor && (
              <circle cx="58" cy={25 + idx * 15} r="3" fill="#10b981" className="animate-pulse" />
            )}
          </g>
        ))}
        
        {/* Elevator Car */}
        <g transform={`translate(0, ${15 + (8 - currentFloor) * 15})`} className={moving ? "transition-transform duration-1000" : ""}>
          <rect x="75" y="0" width="50" height="12" fill="#3b82f6" stroke="#60a5fa" strokeWidth="2" rx="2" />
          <rect x="77" y="2" width="46" height="8" fill="#1e3a8a" />
          <circle cx="100" cy="6" r="2" fill="#fbbf24" className={moving ? "animate-pulse" : ""} />
        </g>
        
        {/* Direction Arrow */}
        {moving && targetFloor !== currentFloor && (
          <g transform="translate(145, 70)">
            {targetFloor > currentFloor ? (
              <polygon points="0,10 10,0 20,10 15,10 15,25 5,25 5,10" fill="#10b981" className="animate-bounce" />
            ) : (
              <polygon points="0,0 10,10 20,0 15,0 15,-15 5,-15 5,0" fill="#ef4444" className="animate-bounce" />
            )}
          </g>
        )}
      </svg>
      
      {/* Floor Display */}
      <div className="absolute top-1 right-1 bg-slate-900/90 px-3 py-1 rounded border-2 border-purple-700">
        <div className="text-xs text-purple-300">Floor</div>
        <div className="text-xl font-bold text-white text-center">{currentFloor}</div>
      </div>
      
      {/* Status */}
      {moving && targetFloor !== currentFloor && (
        <div className="absolute bottom-1 left-1/2 -translate-x-1/2 bg-blue-900/90 px-3 py-1 rounded-full text-[10px] font-bold text-blue-200 border border-blue-700 animate-pulse">
          {targetFloor > currentFloor ? '↑ UP' : '↓ DOWN'}
        </div>
      )}
    </div>
  );
};

const StreamView: React.FC = () => {
  const [config, setConfig] = useState<any>(null);
  const [doors, setDoors] = useState<any[]>([]);
  const [readers, setReaders] = useState<any[]>([]);
  const [pins, setPins] = useState<any[]>([]);
  const [activity, setActivity] = useState<any[]>([]);
  const [elevatorFloor, setElevatorFloor] = useState(1);
  const [elevatorTarget, setElevatorTarget] = useState(1);
  const [elevatorMoving, setElevatorMoving] = useState(false);
  const [stats, setStats] = useState({
    totalTests: 147,
    successRate: 95,
    activeReaders: 0,
    activeDoors: 0
  });
  const wsRef = useRef<WebSocket | null>(null);

  const backendUrl = getBackendUrl();

  // Load VMS Config
  useEffect(() => {
    const loadConfig = async () => {
      try {
        const response = await fetch(`${backendUrl}/api/vms/display-config`);
        const data = await response.json();
        setConfig(data.config);
      } catch (error) {
        console.error('Failed to load VMS config:', error);
        setConfig({
          sections: {
            doorStatus: true,
            readerStatus: true,
            liveActivity: true,
            inputOutput: true,
            elevatorControl: true,
            automationRules: true,
            reportOverview: true,
            reportActivity: true,
            reportDoorStatus: true,
            reportAlerts: true,
            reportCharts: false,
            reportInterface: true,
            quickActions: false,
            credentialSender: false
          },
          layoutMode: 'compact',
          refreshInterval: 5,
          showTimestamps: true,
          highlightChanges: true
        });
      }
    };
    loadConfig();
  }, [backendUrl]);

  // Load main data
  useEffect(() => {
    if (!config) return;

    const loadData = async () => {
      try {
        const responses = await Promise.allSettled([
          fetch(`${backendUrl}/api/doors`),
          fetch(`${backendUrl}/api/readers`),
          fetch(`${backendUrl}/api/pins`)
        ]);

        if (responses[0].status === 'fulfilled') {
          const doorsData = await responses[0].value.json();
          setDoors(doorsData.slice(0, 4));
          setStats(prev => ({ ...prev, activeDoors: doorsData.filter((d: any) => d.enabled).length }));
        }

        if (responses[1].status === 'fulfilled') {
          const readersData = await responses[1].value.json();
          setReaders(readersData.slice(0, 4));
          setStats(prev => ({ ...prev, activeReaders: readersData.filter((r: any) => r.enabled).length }));
        }

        if (responses[2].status === 'fulfilled') {
          const pinsData = await responses[2].value.json();
          setPins(pinsData);
        }
      } catch (error) {
        console.error('Failed to load data:', error);
      }
    };

    loadData();
    const interval = setInterval(loadData, (config.refreshInterval || 5) * 1000);
    return () => clearInterval(interval);
  }, [config, backendUrl]);

  // WebSocket for live activity
  useEffect(() => {
    try {
      const ws = new WebSocket(`ws://${window.location.hostname}:3001`);
      wsRef.current = ws;

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'activity' || data.type === 'log') {
            setActivity(prev => [{
              time: new Date().toLocaleTimeString(),
              message: data.message || data.data || 'Activity',
              type: data.level || 'info'
            }, ...prev.slice(0, 49)]);
          }
        } catch (error) {
          console.error('WebSocket message error:', error);
        }
      };

      return () => ws.close();
    } catch (error) {
      console.error('WebSocket connection error:', error);
    }
  }, []);

  // Door control
  const toggleDoor = async (doorId: number, control: string) => {
    try {
      await fetch(`${backendUrl}/api/doors/${doorId}/${control}`, { method: 'POST' });
    } catch (error) {
      console.error('Failed to toggle door:', error);
    }
  };

  // Elevator control
  const callElevator = async (floor: number) => {
    try {
      setElevatorTarget(floor);
      setElevatorMoving(true);
      
      await fetch(`${backendUrl}/api/elevator/call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ floor })
      });

      setTimeout(() => {
        setElevatorFloor(floor);
        setElevatorMoving(false);
      }, 2000);
    } catch (error) {
      console.error('Failed to call elevator:', error);
      setElevatorMoving(false);
    }
  };

  if (!config) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <div className="text-white text-2xl">Loading VMS Configuration...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-900 text-white overflow-hidden">
      {/* Running Activity Taskbar */}
      {config.sections.liveActivity && (
        <div className="bg-gradient-to-r from-blue-900/50 to-purple-900/50 border-b border-blue-700/50 px-2 py-1">
          <div className="flex items-center gap-2 text-xs">
            <Activity className="w-3 h-3 text-blue-400 animate-pulse" />
            <div className="overflow-hidden flex-1">
              <div 
                className="whitespace-nowrap"
                style={{
                  animation: activity.length > 0 ? 'marquee 30s linear infinite' : 'none'
                }}
              >
                {activity.length === 0 ? (
                  <span className="text-slate-400">Waiting for activity...</span>
                ) : (
                  activity.slice(0, 10).map((act, idx) => (
                    <span key={idx} className="mx-4">
                      <span className="text-slate-500">{act.time}</span>
                      {' • '}
                      <span className={
                        act.type === 'success' ? 'text-green-400' :
                        act.type === 'error' ? 'text-red-400' :
                        act.type === 'warn' ? 'text-yellow-400' :
                        'text-blue-400'
                      }>{act.message}</span>
                    </span>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="p-2">
        {/* Main Grid Layout */}
        <div className="grid grid-cols-12 gap-2">
          {/* Left Column: Door Animations & Reader Status */}
          <div className="col-span-5 space-y-2">
            {/* Door Status Cards with Animations */}
            {config.sections.doorStatus && (
              <div className="bg-slate-800/50 backdrop-blur rounded-lg border border-slate-700 p-2">
                <h2 className="text-sm font-bold mb-2 flex items-center gap-1">
                  <DoorOpen className="w-4 h-4 text-blue-400" />
                  Door Visual Status
                </h2>
                <div className="grid grid-cols-2 gap-2">
                  {doors.length === 0 ? (
                    <div className="col-span-2 text-center text-slate-400 text-xs py-4">No doors configured</div>
                  ) : (
                    doors.map((door: any) => (
                      <MiniDoorAnimation
                        key={door.id}
                        doorName={door.name}
                        isLocked={door.lock?.active || false}
                        isOpen={door.dps?.active || false}
                        rexActive={door.rexIn?.active || false}
                        enabled={door.enabled !== false}
                      />
                    ))
                  )}
                </div>
              </div>
            )}

            {/* Reader Status */}
            {config.sections.readerStatus && (
              <div className="bg-slate-800/50 backdrop-blur rounded-lg border border-slate-700 p-2">
                <h2 className="text-sm font-bold mb-2 flex items-center gap-1">
                  <Radio className="w-4 h-4 text-green-400" />
                  Reader Status
                </h2>
                <div className="space-y-1">
                  {readers.length === 0 ? (
                    <div className="text-center text-slate-400 text-xs py-4">No readers configured</div>
                  ) : (
                    readers.map((reader: any) => (
                      <div key={reader.id} className="bg-slate-900/50 rounded p-2 border border-slate-600 text-xs">
                        <div className="flex justify-between items-center">
                          <div>
                            <div className="font-medium">{reader.name}</div>
                            <div className="text-[10px] text-slate-400">
                              {reader.type?.toUpperCase() || 'WIEGAND'}
                            </div>
                          </div>
                          <div className={`px-1.5 py-0.5 rounded text-[10px] ${
                            reader.enabled ? 'bg-green-500/20 text-green-400' : 'bg-slate-600/20 text-slate-400'
                          }`}>
                            {reader.enabled ? 'ON' : 'OFF'}
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Middle Column: Controls */}
          <div className="col-span-4 space-y-2">
            {/* Door Control Panel */}
            <div className="bg-slate-800/50 backdrop-blur rounded-lg border border-slate-700 p-2">
              <h2 className="text-sm font-bold mb-2 flex items-center gap-1">
                <DoorOpen className="w-4 h-4 text-blue-400" />
                Door Controls
              </h2>
              <div className="space-y-1">
                {doors.length === 0 ? (
                  <div className="text-center text-slate-400 text-xs py-4">No doors available</div>
                ) : (
                  doors.map((door: any) => (
                    <div key={door.id} className="bg-slate-900/50 rounded p-2 border border-slate-600">
                      <div className="text-xs font-bold mb-1">{door.name}</div>
                      <div className="grid grid-cols-3 gap-1">
                        <button
                          onClick={() => toggleDoor(door.id, 'lock')}
                          className={`px-2 py-1 rounded text-[10px] font-bold transition-all ${
                            door.lock?.active 
                              ? 'bg-red-500/20 text-red-400 border border-red-500/50 hover:bg-red-500/30' 
                              : 'bg-green-500/20 text-green-400 border border-green-500/50 hover:bg-green-500/30'
                          }`}
                        >
                          {door.lock?.active ? 'UNLOCK' : 'LOCK'}
                        </button>
                        <button
                          onClick={() => toggleDoor(door.id, 'dps')}
                          className="px-2 py-1 rounded text-[10px] font-bold bg-blue-500/20 text-blue-400 border border-blue-500/50 hover:bg-blue-500/30 transition-all"
                        >
                          DPS
                        </button>
                        <button
                          onClick={() => toggleDoor(door.id, 'rex')}
                          className="px-2 py-1 rounded text-[10px] font-bold bg-yellow-500/20 text-yellow-400 border border-yellow-500/50 hover:bg-yellow-500/30 transition-all"
                        >
                          REX
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Elevator Visual + Controls */}
            {config.sections.elevatorControl && (
              <div className="bg-slate-800/50 backdrop-blur rounded-lg border border-slate-700 p-2">
                <h2 className="text-sm font-bold mb-2 flex items-center gap-1">
                  <Building className="w-4 h-4 text-purple-400" />
                  Elevator
                </h2>
                
                {/* Elevator Animation */}
                <MiniElevatorDisplay 
                  currentFloor={elevatorFloor}
                  targetFloor={elevatorTarget}
                  moving={elevatorMoving}
                />
                
                {/* Floor Buttons */}
                <div className="grid grid-cols-4 gap-1 mt-2">
                  {[8, 7, 6, 5, 4, 3, 2, 1].map(floor => (
                    <button
                      key={floor}
                      onClick={() => callElevator(floor)}
                      disabled={elevatorMoving}
                      className={`aspect-square rounded border text-sm font-bold transition-all ${
                        floor === elevatorFloor
                          ? 'bg-purple-500/30 border-purple-500 text-purple-200'
                          : 'bg-slate-900/50 border-slate-600 hover:bg-purple-500/20 hover:border-purple-500 text-white'
                      } ${elevatorMoving ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                      {floor}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Right Column: I/O Status */}
          {config.sections.inputOutput && (
            <div className="col-span-3 bg-slate-800/50 backdrop-blur rounded-lg border border-slate-700 p-2">
              <h2 className="text-sm font-bold mb-2 flex items-center gap-1">
                <Zap className="w-4 h-4 text-yellow-400" />
                I/O Status
              </h2>
              <div className="space-y-1 max-h-[500px] overflow-y-auto">
                {pins.length === 0 ? (
                  <div className="text-center text-slate-400 text-xs py-4">No I/O pins configured</div>
                ) : (
                  pins.map((pin: any) => (
                    <div 
                      key={pin.id} 
                      className="flex items-center justify-between bg-slate-900/50 rounded px-2 py-1 border border-slate-600 text-[10px]"
                    >
                      <span className="font-mono font-bold">{pin.name}</span>
                      <div className="flex items-center gap-1">
                        <span className="text-slate-500">{pin.gpio}</span>
                        <div className={`w-2 h-2 rounded-full ${
                          pin.active 
                            ? pin.mode === 'output' ? 'bg-green-400 animate-pulse' : 'bg-blue-400 animate-pulse'
                            : 'bg-slate-600'
                        }`} />
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        {/* Bottom Stats Bar */}
        {config.sections.reportOverview && (
          <div className="mt-2 bg-slate-800/50 backdrop-blur rounded-lg border border-slate-700 p-2">
            <div className="grid grid-cols-4 gap-2">
              <div className="bg-slate-900/50 rounded p-2 border border-slate-600 text-center">
                <div className="text-xl font-bold text-blue-400">{stats.totalTests}</div>
                <div className="text-[10px] text-slate-400">Total Tests</div>
              </div>
              <div className="bg-slate-900/50 rounded p-2 border border-slate-600 text-center">
                <div className="text-xl font-bold text-green-400">{stats.successRate}%</div>
                <div className="text-[10px] text-slate-400">Success Rate</div>
              </div>
              <div className="bg-slate-900/50 rounded p-2 border border-slate-600 text-center">
                <div className="text-xl font-bold text-purple-400">{stats.activeReaders}</div>
                <div className="text-[10px] text-slate-400">Active Readers</div>
              </div>
              <div className="bg-slate-900/50 rounded p-2 border border-slate-600 text-center">
                <div className="text-xl font-bold text-amber-400">{stats.activeDoors}</div>
                <div className="text-[10px] text-slate-400">Active Doors</div>
              </div>
            </div>
          </div>
        )}

        {/* Additional Reports Section (if enabled) */}
        {(config.sections.reportActivity || config.sections.reportDoorStatus || config.sections.reportAlerts) && (
          <div className="mt-2 grid grid-cols-3 gap-2">
            {config.sections.reportActivity && (
              <div className="bg-slate-800/50 backdrop-blur rounded-lg border border-slate-700 p-2">
                <h3 className="text-xs font-bold mb-1 flex items-center gap-1">
                  <FileText className="w-3 h-3 text-cyan-400" />
                  Activity Feed
                </h3>
                <div className="text-[10px] text-slate-400">Recent activity logged</div>
              </div>
            )}

            {config.sections.reportDoorStatus && (
              <div className="bg-slate-800/50 backdrop-blur rounded-lg border border-slate-700 p-2">
                <h3 className="text-xs font-bold mb-1 flex items-center gap-1">
                  <TrendingUp className="w-3 h-3 text-emerald-400" />
                  Per-Door Stats
                </h3>
                <div className="text-[10px] text-slate-400">Door performance metrics</div>
              </div>
            )}

            {config.sections.reportAlerts && (
              <div className="bg-slate-800/50 backdrop-blur rounded-lg border border-slate-700 p-2">
                <h3 className="text-xs font-bold mb-1 flex items-center gap-1">
                  <Bell className="w-3 h-3 text-red-400" />
                  Alerts
                </h3>
                <div className="text-[10px] text-slate-400">No active alerts</div>
              </div>
            )}
          </div>
        )}
      </div>

      <style>{`
        @keyframes marquee {
          0% { transform: translateX(100%); }
          100% { transform: translateX(-100%); }
        }
      `}</style>
    </div>
  );
};

export default StreamView;
