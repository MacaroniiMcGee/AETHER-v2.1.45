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
    <div className="relative h-32 bg-gradient-to-b from-[#241E19] to-[#15110B] rounded-lg border border-[#38302A] overflow-hidden">
      <svg className="w-full h-full" viewBox="0 0 200 150" preserveAspectRatio="xMidYMid meet">
        {/* Floor */}
        <rect x="0" y="120" width="200" height="30" fill="#241E19" />
        <line x1="0" y1="120" x2="200" y2="120" stroke="#4A3F36" strokeWidth="1" />
        
        {/* Wall */}
        <rect x="0" y="0" width="200" height="120" fill="#15110B" />
        
        {/* Door Frame */}
        <rect x="50" y="20" width="100" height="100" fill="#38302A" stroke="#4A3F36" strokeWidth="2" />
        
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
                  fill="#4A3F36" 
                  stroke="#786D60" 
                  strokeWidth="2"
                  opacity="0.3"
                  rx="2"
                />
                
                {/* Person walking through */}
                <g className={rexActive ? "animate-pulse" : ""}>
                  <ellipse cx="100" cy="110" rx="10" ry="5" fill="#4E9E98" opacity="0.3" />
                  <circle cx="100" cy="70" r="12" fill="#5FB7B0" />
                  <rect x="93" y="82" width="14" height="28" fill="#5FB7B0" rx="3" />
                  <circle cx="100" cy="60" r="8" fill="#8FD3CD" />
                  
                  {rexActive && (
                    <>
                      <rect x="75" y="48" width="50" height="10" fill="#6FBF7E" opacity="0.95" rx="2" className="animate-pulse" />
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
                  fill="#786D60" 
                  stroke="#ADA294" 
                  strokeWidth="2"
                  rx="2"
                />
                
                {/* Door panels */}
                <rect x="60" y="35" width="37" height="35" fill="#4A3F36" stroke="#786D60" strokeWidth="1" />
                <rect x="102" y="35" width="37" height="35" fill="#4A3F36" stroke="#786D60" strokeWidth="1" />
                <rect x="60" y="75" width="37" height="35" fill="#4A3F36" stroke="#786D60" strokeWidth="1" />
                <rect x="102" y="75" width="37" height="35" fill="#4A3F36" stroke="#786D60" strokeWidth="1" />
                
                {/* Door Handle */}
                <circle 
                  cx="132" 
                  cy="70" 
                  r="5" 
                  fill={isLocked ? "#C6604F" : "#6FBF7E"} 
                  stroke={isLocked ? "#A84E3F" : "#4F8B5C"} 
                  strokeWidth="1"
                  className={!isLocked ? "animate-pulse" : ""}
                />
                <rect 
                  x="120" 
                  y="68.5" 
                  width="12" 
                  height="3" 
                  fill={isLocked ? "#C6604F" : "#6FBF7E"} 
                  rx="1"
                />
                
                {/* REX Indicator */}
                {rexActive && (
                  <>
                    <rect x="65" y="48" width="70" height="14" fill="#6FBF7E" opacity="0.9" rx="3" className="animate-pulse" />
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
              fill="#38302A" 
              stroke="#4A3F36" 
              strokeWidth="2"
              opacity="0.5"
              rx="2"
            />
            <text x="100" y="75" textAnchor="middle" fill="#786D60" fontSize="12" fontWeight="bold">DISABLED</text>
          </>
        )}
      </svg>
      
      {/* Door Name Label */}
      <div className="absolute top-1 left-1 bg-[#15110B]/90 px-2 py-1 rounded border border-[#38302A]">
        <div className="text-[10px] font-bold text-white">{doorName}</div>
      </div>

      {/* Status Badge */}
      <div className="absolute bottom-1 right-1">
        {enabled && (
          <>
            {isOpen && (
              <div className="bg-[#173B38]/80 px-2 py-0.5 rounded-full text-[9px] font-bold text-[#8FD3CD] border border-[#4E9E98]">
                OPEN
              </div>
            )}
            {!isOpen && isLocked && (
              <div className="bg-[#3A1E1A]/80 px-2 py-0.5 rounded-full text-[9px] font-bold text-[#F5D4CD] border border-[#A84E3F]">
                LOCKED
              </div>
            )}
            {!isOpen && !isLocked && (
              <div className="bg-[#1E3A24]/80 px-2 py-0.5 rounded-full text-[9px] font-bold text-[#CDEBD3] border border-[#3E6E48] animate-pulse">
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
    <div className="relative h-32 bg-gradient-to-b from-[#241E19] to-[#15110B] rounded-lg border border-[#38302A] overflow-hidden">
      <svg className="w-full h-full" viewBox="0 0 200 150" preserveAspectRatio="xMidYMid meet">
        {/* Elevator Shaft */}
        <rect x="70" y="10" width="60" height="130" fill="#241E19" stroke="#4A3F36" strokeWidth="2" />
        
        {/* Floor Markers */}
        {[8, 7, 6, 5, 4, 3, 2, 1].map((floor, idx) => (
          <g key={floor}>
            <line x1="50" y1={25 + idx * 15} x2="65" y2={25 + idx * 15} stroke="#4A3F36" strokeWidth="1" />
            <text x="40" y={29 + idx * 15} fill="#786D60" fontSize="10" fontWeight="bold">{floor}</text>
            {floor === currentFloor && (
              <circle cx="58" cy={25 + idx * 15} r="3" fill="#6FBF7E" className="animate-pulse" />
            )}
          </g>
        ))}
        
        {/* Elevator Car */}
        <g transform={`translate(0, ${15 + (8 - currentFloor) * 15})`} className={moving ? "transition-transform duration-1000" : ""}>
          <rect x="75" y="0" width="50" height="12" fill="#4E9E98" stroke="#5FB7B0" strokeWidth="2" rx="2" />
          <rect x="77" y="2" width="46" height="8" fill="#173B38" />
          <circle cx="100" cy="6" r="2" fill="#E6C766" className={moving ? "animate-pulse" : ""} />
        </g>
        
        {/* Direction Arrow */}
        {moving && targetFloor !== currentFloor && (
          <g transform="translate(145, 70)">
            {targetFloor > currentFloor ? (
              <polygon points="0,10 10,0 20,10 15,10 15,25 5,25 5,10" fill="#6FBF7E" className="animate-bounce" />
            ) : (
              <polygon points="0,0 10,10 20,0 15,0 15,-15 5,-15 5,0" fill="#C6604F" className="animate-bounce" />
            )}
          </g>
        )}
      </svg>
      
      {/* Floor Display */}
      <div className="absolute top-1 right-1 bg-[#15110B]/90 px-3 py-1 rounded border-2 border-[#5C8256]">
        <div className="text-xs text-[#A9C4A4]">Floor</div>
        <div className="text-xl font-bold text-white text-center">{currentFloor}</div>
      </div>
      
      {/* Status */}
      {moving && targetFloor !== currentFloor && (
        <div className="absolute bottom-1 left-1/2 -translate-x-1/2 bg-[#173B38]/90 px-3 py-1 rounded-full text-[10px] font-bold text-[#8FD3CD] border border-[#4E9E98] animate-pulse">
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
      <div className="min-h-screen bg-[#15110B] flex items-center justify-center">
        <div className="text-white text-2xl">Loading VMS Configuration...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#15110B] text-white overflow-hidden">
      {/* Running Activity Taskbar */}
      {config.sections.liveActivity && (
        <div className="bg-gradient-to-r from-[#173B38]/50 to-[#26301F]/50 border-b border-[#4E9E98]/50 px-2 py-1">
          <div className="flex items-center gap-2 text-xs">
            <Activity className="w-3 h-3 text-[#5FB7B0] animate-pulse" />
            <div className="overflow-hidden flex-1">
              <div 
                className="whitespace-nowrap"
                style={{
                  animation: activity.length > 0 ? 'marquee 30s linear infinite' : 'none'
                }}
              >
                {activity.length === 0 ? (
                  <span className="text-[#ADA294]">Waiting for activity...</span>
                ) : (
                  activity.slice(0, 10).map((act, idx) => (
                    <span key={idx} className="mx-4">
                      <span className="text-[#786D60]">{act.time}</span>
                      {' • '}
                      <span className={
                        act.type === 'success' ? 'text-[#7BD497]' :
                        act.type === 'error' ? 'text-[#E0705F]' :
                        act.type === 'warn' ? 'text-[#E6C766]' :
                        'text-[#5FB7B0]'
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
              <div className="bg-[#241E19]/50 backdrop-blur rounded-lg border border-[#38302A] p-2">
                <h2 className="text-sm font-bold mb-2 flex items-center gap-1">
                  <DoorOpen className="w-4 h-4 text-[#5FB7B0]" />
                  Door Visual Status
                </h2>
                <div className="grid grid-cols-2 gap-2">
                  {doors.length === 0 ? (
                    <div className="col-span-2 text-center text-[#ADA294] text-xs py-4">No doors configured</div>
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
              <div className="bg-[#241E19]/50 backdrop-blur rounded-lg border border-[#38302A] p-2">
                <h2 className="text-sm font-bold mb-2 flex items-center gap-1">
                  <Radio className="w-4 h-4 text-[#7BD497]" />
                  Reader Status
                </h2>
                <div className="space-y-1">
                  {readers.length === 0 ? (
                    <div className="text-center text-[#ADA294] text-xs py-4">No readers configured</div>
                  ) : (
                    readers.map((reader: any) => (
                      <div key={reader.id} className="bg-[#15110B]/50 rounded p-2 border border-[#4A3F36] text-xs">
                        <div className="flex justify-between items-center">
                          <div>
                            <div className="font-medium">{reader.name}</div>
                            <div className="text-[10px] text-[#ADA294]">
                              {reader.type?.toUpperCase() || 'WIEGAND'}
                            </div>
                          </div>
                          <div className={`px-1.5 py-0.5 rounded text-[10px] ${
                            reader.enabled ? 'bg-[#6FBF7E]/20 text-[#7BD497]' : 'bg-[#4A3F36]/20 text-[#ADA294]'
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
            <div className="bg-[#241E19]/50 backdrop-blur rounded-lg border border-[#38302A] p-2">
              <h2 className="text-sm font-bold mb-2 flex items-center gap-1">
                <DoorOpen className="w-4 h-4 text-[#5FB7B0]" />
                Door Controls
              </h2>
              <div className="space-y-1">
                {doors.length === 0 ? (
                  <div className="text-center text-[#ADA294] text-xs py-4">No doors available</div>
                ) : (
                  doors.map((door: any) => (
                    <div key={door.id} className="bg-[#15110B]/50 rounded p-2 border border-[#4A3F36]">
                      <div className="text-xs font-bold mb-1">{door.name}</div>
                      <div className="grid grid-cols-3 gap-1">
                        <button
                          onClick={() => toggleDoor(door.id, 'lock')}
                          className={`px-2 py-1 rounded text-[10px] font-bold transition-all ${
                            door.lock?.active 
                              ? 'bg-[#C6604F]/20 text-[#E0705F] border border-[#C6604F]/50 hover:bg-[#C6604F]/30' 
                              : 'bg-[#6FBF7E]/20 text-[#7BD497] border border-[#6FBF7E]/50 hover:bg-[#6FBF7E]/30'
                          }`}
                        >
                          {door.lock?.active ? 'UNLOCK' : 'LOCK'}
                        </button>
                        <button
                          onClick={() => toggleDoor(door.id, 'dps')}
                          className="px-2 py-1 rounded text-[10px] font-bold bg-[#5FB7B0]/20 text-[#5FB7B0] border border-[#5FB7B0]/50 hover:bg-[#5FB7B0]/30 transition-all"
                        >
                          DPS
                        </button>
                        <button
                          onClick={() => toggleDoor(door.id, 'rex')}
                          className="px-2 py-1 rounded text-[10px] font-bold bg-[#E6C766]/20 text-[#E6C766] border border-[#E6C766]/50 hover:bg-[#E6C766]/30 transition-all"
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
              <div className="bg-[#241E19]/50 backdrop-blur rounded-lg border border-[#38302A] p-2">
                <h2 className="text-sm font-bold mb-2 flex items-center gap-1">
                  <Building className="w-4 h-4 text-[#8FB488]" />
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
                          ? 'bg-[#8FB488]/30 border-[#8FB488] text-[#C7DAC3]'
                          : 'bg-[#15110B]/50 border-[#4A3F36] hover:bg-[#8FB488]/20 hover:border-[#8FB488] text-white'
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
            <div className="col-span-3 bg-[#241E19]/50 backdrop-blur rounded-lg border border-[#38302A] p-2">
              <h2 className="text-sm font-bold mb-2 flex items-center gap-1">
                <Zap className="w-4 h-4 text-[#E6C766]" />
                I/O Status
              </h2>
              <div className="space-y-1 max-h-[500px] overflow-y-auto">
                {pins.length === 0 ? (
                  <div className="text-center text-[#ADA294] text-xs py-4">No I/O pins configured</div>
                ) : (
                  pins.map((pin: any) => (
                    <div 
                      key={pin.id} 
                      className="flex items-center justify-between bg-[#15110B]/50 rounded px-2 py-1 border border-[#4A3F36] text-[10px]"
                    >
                      <span className="font-mono font-bold">{pin.name}</span>
                      <div className="flex items-center gap-1">
                        <span className="text-[#786D60]">{pin.gpio}</span>
                        <div className={`w-2 h-2 rounded-full ${
                          pin.active 
                            ? pin.mode === 'output' ? 'bg-[#7BD497] animate-pulse' : 'bg-[#5FB7B0] animate-pulse'
                            : 'bg-[#4A3F36]'
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
          <div className="mt-2 bg-[#241E19]/50 backdrop-blur rounded-lg border border-[#38302A] p-2">
            <div className="grid grid-cols-4 gap-2">
              <div className="bg-[#15110B]/50 rounded p-2 border border-[#4A3F36] text-center">
                <div className="text-xl font-bold text-[#5FB7B0]">{stats.totalTests}</div>
                <div className="text-[10px] text-[#ADA294]">Total Tests</div>
              </div>
              <div className="bg-[#15110B]/50 rounded p-2 border border-[#4A3F36] text-center">
                <div className="text-xl font-bold text-[#7BD497]">{stats.successRate}%</div>
                <div className="text-[10px] text-[#ADA294]">Success Rate</div>
              </div>
              <div className="bg-[#15110B]/50 rounded p-2 border border-[#4A3F36] text-center">
                <div className="text-xl font-bold text-[#8FB488]">{stats.activeReaders}</div>
                <div className="text-[10px] text-[#ADA294]">Active Readers</div>
              </div>
              <div className="bg-[#15110B]/50 rounded p-2 border border-[#4A3F36] text-center">
                <div className="text-xl font-bold text-[#F0A73C]">{stats.activeDoors}</div>
                <div className="text-[10px] text-[#ADA294]">Active Doors</div>
              </div>
            </div>
          </div>
        )}

        {/* Additional Reports Section (if enabled) */}
        {(config.sections.reportActivity || config.sections.reportDoorStatus || config.sections.reportAlerts) && (
          <div className="mt-2 grid grid-cols-3 gap-2">
            {config.sections.reportActivity && (
              <div className="bg-[#241E19]/50 backdrop-blur rounded-lg border border-[#38302A] p-2">
                <h3 className="text-xs font-bold mb-1 flex items-center gap-1">
                  <FileText className="w-3 h-3 text-[#8FD3CD]" />
                  Activity Feed
                </h3>
                <div className="text-[10px] text-[#ADA294]">Recent activity logged</div>
              </div>
            )}

            {config.sections.reportDoorStatus && (
              <div className="bg-[#241E19]/50 backdrop-blur rounded-lg border border-[#38302A] p-2">
                <h3 className="text-xs font-bold mb-1 flex items-center gap-1">
                  <TrendingUp className="w-3 h-3 text-[#7BD497]" />
                  Per-Door Stats
                </h3>
                <div className="text-[10px] text-[#ADA294]">Door performance metrics</div>
              </div>
            )}

            {config.sections.reportAlerts && (
              <div className="bg-[#241E19]/50 backdrop-blur rounded-lg border border-[#38302A] p-2">
                <h3 className="text-xs font-bold mb-1 flex items-center gap-1">
                  <Bell className="w-3 h-3 text-[#E0705F]" />
                  Alerts
                </h3>
                <div className="text-[10px] text-[#ADA294]">No active alerts</div>
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

