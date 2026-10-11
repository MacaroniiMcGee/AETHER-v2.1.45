// ElevatorSection.tsx - Professional Elevator Access Control System
// ✅ FIXED: Uses /api/gpio/set for toggle state control (not pulse)
// ✅ FIXED: readyToMove gate ensures doors fully close before next floor

import React, { useState, useEffect, useRef } from 'react';
import { 
  Building2, CreditCard, Lock, Unlock, AlertCircle, 
  Check, Clock, Shield, Bell, Settings, TrendingUp,
  Zap, AlertTriangle, Activity, ChevronUp, ChevronDown,
  PauseCircle, PlayCircle, RotateCcw, Save, Download, Sliders
} from 'lucide-react';

interface Floor {
  id: number;
  name: string;
  shortName: string;
  trackingGpio: number;        // OUTPUT: Relay 1-8 - Floor tracking to ACU  [legacy: kept working]
  analogInput: number;         // INPUT: IOPlus Analog Input (1-8) - ACU grants access  [legacy: kept working]
  inputChannel?: number;       // Stage1: ACU trigger input (independent). Defaults to analogInput.
  outputChannel?: number;      // Stage1: floor tracking/position output (independent). Defaults to trackingGpio.
  group?: string;              // Stage1: floor-group id (reader association at group level)
  stackId: number;             // IOPlus stack ID (0-3) for multiple HATs
  isTracking: boolean;         // True when tracking relay is ON (elevator is here)
  accessGrantedByACU: boolean; // True when ACU has granted access (analog input active)
  accessLevel: 'public' | 'restricted' | 'private' | 'executive';
  callButtonPressed: boolean;  // User pressed call - only works if accessGrantedByACU
  callButtonLit: boolean;      // Call button illuminated - ONLY when accessGrantedByACU is true
  accessGranted: boolean;
  accessAttempts: number;
  doorOpen: boolean;
  occupancy: number;
  lastAccess: Date | null;
}

interface GPIOConfig {
  emergencyStopInput: number;
  maintenanceModeInput: number;
}

interface CardFormat {
  id: string;
  name: string;
  bits: number;
  facilityBits: number;
  cardBits: number;
  maxFacility: number;
  maxCard: number;
  description: string;
}

interface ElevatorReader {
  type: 'none' | 'osdp' | 'wiegand';
  readerId: string;
  readerName: string;
  enabled: boolean;
}

interface LogEntry {
  id: string;
  timestamp: Date;
  floor: number;
  type: 'info' | 'success' | 'warning' | 'error' | 'security';
  message: string;
  icon: string;
}

interface ElevatorStats {
  totalTrips: number;
  floorsVisited: { [key: number]: number };
  averageWaitTime: number;
  accessAttempts: { granted: number; denied: number };
  peakHour: string;
}

interface ElevatorSectionProps {
  socket?: any;
  backendUrl?: string;
  onFloorAccess?: (floor: number, reader: string, granted: boolean) => void;
  // IOPlus hardware inputs - passed from parent component
  ioPlusAnalogInputs?: number[];   // Analog input values (0-10V or 0-4095 raw)
  ioPlusOptoInputs?: boolean[];    // Opto-isolated input states (true = active)
  inputType?: 'analog' | 'opto';   // Which input type to use for ACU access
  analogThreshold?: number;        // Voltage threshold for analog inputs (default 2.5V)
}

export function ElevatorSection({ 
  socket, 
  backendUrl, 
  onFloorAccess,
  ioPlusAnalogInputs = [],
  ioPlusOptoInputs = [],
  inputType = 'analog',
  analogThreshold = 2.5
}: ElevatorSectionProps) {
  // Elevator state
  const [currentFloor, setCurrentFloor] = useState(1);
  const [targetFloor, setTargetFloor] = useState<number | null>(null);
  const [isMoving, setIsMoving] = useState(false);
  const [direction, setDirection] = useState<'up' | 'down' | 'idle'>('idle');
  const [doorStatus, setDoorStatus] = useState<'open' | 'closed' | 'opening' | 'closing'>('closed');
  const [elevatorMode, setElevatorMode] = useState<'normal' | 'emergency' | 'maintenance'>('normal');
  const [callQueue, setCallQueue] = useState<number[]>([]);
  const [speed, setSpeed] = useState(1);
  const [autoReturnEnabled, setAutoReturnEnabled] = useState(true);
  const [isReturningToGround, setIsReturningToGround] = useState(false);
  const [doorOpenDuration, setDoorOpenDuration] = useState(10);
  // Stage1: grant path mode. "direct" = current behavior (bench, no Azure). "loopback" = Stage 3.
  const [grantMode, setGrantMode] = useState<"direct" | "loopback">("direct");
  // Stage1: floor groups (a reader is associated per group). UI wired at Stage 2.
  const [floorGroups, setFloorGroups] = useState<{ id: string; name: string; readerId: string | null }[]>([
    { id: "all", name: "All Floors", readerId: null },
  ]);
  
  // ✅ NEW: Ready to move gate - prevents movement until door cycle is complete
  const [readyToMove, setReadyToMove] = useState(true);
  
  const [gpioConfig, setGpioConfig] = useState<GPIOConfig>({
    emergencyStopInput: 30,
    maintenanceModeInput: 31
  });
  
  // IOPlus input configuration
  const [acuInputType, setAcuInputType] = useState<'analog' | 'opto'>(inputType);
  const [acuAnalogThreshold, setAcuAnalogThreshold] = useState(analogThreshold);
  
  const [elevatorReader, setElevatorReader] = useState<ElevatorReader>({
    type: 'osdp',
    readerId: 'osdp-reader-1',
    readerName: 'OSDP Reader 1 (Main Elevator)',
    enabled: true
  });
  
  const [selectedFormat, setSelectedFormat] = useState<string>('wiegand26');
  const [facilityCode, setFacilityCode] = useState('123');
  const [cardNumber, setCardNumber] = useState('12345');
  const [cardTargetFloor, setCardTargetFloor] = useState<number>(1);
  
  const [cardFormats] = useState<CardFormat[]>([
    { id: 'wiegand26', name: '26-bit Wiegand (H10301)', bits: 26, facilityBits: 8, cardBits: 16, maxFacility: 255, maxCard: 65535, description: 'Most common access control format' },
    { id: 'wiegand34', name: '34-bit Wiegand (H10302)', bits: 34, facilityBits: 16, cardBits: 16, maxFacility: 65535, maxCard: 65535, description: 'Extended 16-bit facility format' },
    { id: 'wiegand37', name: '37-bit Wiegand (H10302)', bits: 37, facilityBits: 16, cardBits: 19, maxFacility: 65535, maxCard: 524287, description: 'HID H10302 standard' },
    { id: 'wiegand48', name: '48-bit Wiegand (HID)', bits: 48, facilityBits: 16, cardBits: 32, maxFacility: 65535, maxCard: 999999999, description: 'Extended HID format' },
    { id: 'wiegand64', name: '64-bit Wiegand (SEOS)', bits: 64, facilityBits: 32, cardBits: 32, maxFacility: 999999999, maxCard: 999999999, description: 'HID SEOS format' },
    { id: 'h10301_26', name: 'HID H10301 (26-bit)', bits: 26, facilityBits: 8, cardBits: 16, maxFacility: 255, maxCard: 65535, description: 'HID standard 26-bit' },
    { id: 'h10304_37', name: 'HID H10304 (37-bit)', bits: 37, facilityBits: 15, cardBits: 20, maxFacility: 32767, maxCard: 1048575, description: 'HID 37-bit with 20-bit card' },
    { id: 'c1000_35', name: 'Corporate 1000 (35-bit)', bits: 35, facilityBits: 12, cardBits: 20, maxFacility: 4095, maxCard: 1048575, description: 'HID Corporate 1000' },
    { id: 'awid26', name: 'AWID 26-bit', bits: 26, facilityBits: 8, cardBits: 16, maxFacility: 255, maxCard: 65535, description: 'AWID standard 26-bit' },
    { id: 'indala26', name: 'Indala 26-bit', bits: 26, facilityBits: 8, cardBits: 16, maxFacility: 255, maxCard: 65535, description: 'Motorola Indala 26-bit' },
    { id: 'em4100', name: 'EM4100 (40-bit)', bits: 40, facilityBits: 8, cardBits: 32, maxFacility: 255, maxCard: 999999999, description: 'EM Proximity standard' },
    { id: 'mifare_32', name: 'MIFARE UID (32-bit)', bits: 32, facilityBits: 0, cardBits: 32, maxFacility: 0, maxCard: 999999999, description: 'MIFARE Classic UID' },
  ]);
  
  // IOPlus: Relay outputs 1-8 for tracking, Analog Inputs 1-8 for ACU access grant
  // Each floor's relay and analog input use the same channel number
  const [floors, setFloors] = useState<Floor[]>(([
    { id: 8, name: 'Penthouse', shortName: '8th Floor', trackingGpio: 8, analogInput: 8, stackId: 0, isTracking: false, accessGrantedByACU: false, accessLevel: 'executive', callButtonPressed: false, callButtonLit: false, accessGranted: false, accessAttempts: 0, doorOpen: false, occupancy: 0, lastAccess: null },
    { id: 7, name: 'Executive Offices', shortName: '7th Floor', trackingGpio: 7, analogInput: 7, stackId: 0, isTracking: false, accessGrantedByACU: false, accessLevel: 'executive', callButtonPressed: false, callButtonLit: false, accessGranted: false, accessAttempts: 0, doorOpen: false, occupancy: 2, lastAccess: null },
    { id: 6, name: 'Conference Center', shortName: '6th Floor', trackingGpio: 6, analogInput: 6, stackId: 0, isTracking: false, accessGrantedByACU: false, accessLevel: 'private', callButtonPressed: false, callButtonLit: false, accessGranted: false, accessAttempts: 0, doorOpen: false, occupancy: 5, lastAccess: null },
    { id: 5, name: 'IT & Operations', shortName: '5th Floor', trackingGpio: 5, analogInput: 5, stackId: 0, isTracking: false, accessGrantedByACU: false, accessLevel: 'restricted', callButtonPressed: false, callButtonLit: false, accessGranted: false, accessAttempts: 0, doorOpen: false, occupancy: 8, lastAccess: null },
    { id: 4, name: 'Office Suites', shortName: '4th Floor', trackingGpio: 4, analogInput: 4, stackId: 0, isTracking: false, accessGrantedByACU: false, accessLevel: 'restricted', callButtonPressed: false, callButtonLit: false, accessGranted: false, accessAttempts: 0, doorOpen: false, occupancy: 12, lastAccess: null },
    { id: 3, name: 'Co-Working Space', shortName: '3rd Floor', trackingGpio: 3, analogInput: 3, stackId: 0, isTracking: false, accessGrantedByACU: false, accessLevel: 'public', callButtonPressed: false, callButtonLit: false, accessGranted: false, accessAttempts: 0, doorOpen: false, occupancy: 15, lastAccess: null },
    { id: 2, name: 'Meeting Rooms', shortName: '2nd Floor', trackingGpio: 2, analogInput: 2, stackId: 0, isTracking: false, accessGrantedByACU: false, accessLevel: 'public', callButtonPressed: false, callButtonLit: false, accessGranted: false, accessAttempts: 0, doorOpen: false, occupancy: 7, lastAccess: null },
    { id: 1, name: 'Main Lobby', shortName: 'Lobby', trackingGpio: 1, analogInput: 1, stackId: 0, isTracking: true, accessGrantedByACU: true, accessLevel: 'public', callButtonPressed: false, callButtonLit: false, accessGranted: false, accessAttempts: 0, doorOpen: false, occupancy: 20, lastAccess: null },
  ] as Floor[]).map(f => ({ ...f, inputChannel: f.analogInput, outputChannel: f.trackingGpio, group: "all" })));

  const [availableOSDPReaders, setAvailableOSDPReaders] = useState([
    { id: 'osdp-reader-1', name: 'OSDP Reader 1 (Main Elevator)', address: 0, status: 'online' },
    { id: 'osdp-reader-2', name: 'OSDP Reader 2 (Service Elevator)', address: 1, status: 'online' },
  ]);

  const [availableWiegandReaders, setAvailableWiegandReaders] = useState([
    { id: '1', name: 'Wiegand Door 1 (Main)', door: 1, status: 'online' },
    { id: '2', name: 'Wiegand Door 2 (Service)', door: 2, status: 'online' },
  ]);

  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [stats, setStats] = useState<ElevatorStats>({
    totalTrips: 0,
    floorsVisited: {},
    averageWaitTime: 0,
    accessAttempts: { granted: 0, denied: 0 },
    peakHour: '9:00 AM'
  });

  const [showSettings, setShowSettings] = useState(false);
  const [showGPIOConfig, setShowGPIOConfig] = useState(false);
  const [gpioBackendAvailable, setGpioBackendAvailable] = useState<boolean | null>(null);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const doorCloseTimerRef = useRef<NodeJS.Timeout | null>(null);
  
  // Refs to avoid stale closures
  const doorStatusRef = useRef<'open' | 'closed' | 'opening' | 'closing'>('closed');
  const currentFloorRef = useRef<number>(1);
  const isReturningToGroundRef = useRef<boolean>(false);
  const autoReturnEnabledRef = useRef<boolean>(true);
  const callQueueRef = useRef<number[]>([]);
  const isMovingRef = useRef<boolean>(false);
  const elevatorModeRef = useRef<'normal' | 'emergency' | 'maintenance'>('normal');
  const floorsRef = useRef<Floor[]>(floors);
  const readyToMoveRef = useRef<boolean>(true);

  const addLog = (floor: number, type: LogEntry['type'], message: string, icon: string) => {
    const entry: LogEntry = {
      id: Date.now().toString() + Math.random(),
      timestamp: new Date(),
      floor,
      type,
      message,
      icon
    };
    setLogs(prev => [entry, ...prev.slice(0, 99)]);
    console.log(`[LOG F${floor}] ${type}: ${message}`);
  };

  // GPIO Backend API
  const setGPIO = async (pin: number, value: 0 | 1, floor: number) => {
    const baseUrl = backendUrl || `http://${window.location.hostname}:3001`;
    const state = value === 1 ? 'HIGH' : 'LOW';
    
    console.log(`[GPIO] Setting Relay ${pin} to ${state} for Floor ${floor}`);
    
    try {
      const response = await fetch(`${baseUrl}/api/gpio/set`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin, value })
      });
      
      if (!response.ok) {
        console.error(`[GPIO] HTTP ${response.status}`);
        return false;
      }
      
      const result = await response.json();
      
      if (result.success) {
        console.log(`[GPIO] ✅ Relay ${pin} → ${state}`);
        if (gpioBackendAvailable !== true) setGpioBackendAvailable(true);
        return true;
      }
      return false;
    } catch (error) {
      console.log(`[GPIO] Simulated: Relay ${pin} → ${state}`);
      return false;
    }
  };

  const getAccessLevelColor = (level: Floor['accessLevel']) => {
    switch (level) {
      case 'public': return 'text-green-400 bg-green-500/20 border-green-500/30';
      case 'restricted': return 'text-yellow-400 bg-yellow-500/20 border-yellow-500/30';
      case 'private': return 'text-orange-400 bg-orange-500/20 border-orange-500/30';
      case 'executive': return 'text-purple-400 bg-purple-500/20 border-purple-500/30';
    }
  };

  const getAccessLevelIcon = (level: Floor['accessLevel']) => {
    switch (level) {
      case 'public': return '🌍';
      case 'restricted': return '🔒';
      case 'private': return '🛡️';
      case 'executive': return '👑';
    }
  };

  const handleCallButton = (floorId: number, opts?: { system?: boolean }) => {
    if (elevatorModeRef.current !== 'normal') {
      addLog(floorId, 'warning', `Call rejected - ${elevatorModeRef.current} mode`, '⚠️');
      return;
    }

    const floor = floorsRef.current.find(f => f.id === floorId);
    if (!floor) return;

    if (!opts?.system && !floor.accessGrantedByACU) {
      addLog(floorId, 'warning', `🔒 Call BLOCKED - ACU access not granted for Floor ${floorId}`, '🔒');
      return;
    }

    // ACU has granted access - light up the call button
    setFloors(prev => prev.map(f => f.id === floorId ? { ...f, callButtonLit: true, callButtonPressed: true } : f));
    addLog(floorId, 'success', `💡 Call button LIT - ACU granted Floor ${floorId}`, '💡');

    setCallQueue(prevQueue => {
      if (prevQueue.includes(floorId)) return prevQueue;
      
      // If already at this floor with doors closed, just open doors
      if (floorId === currentFloorRef.current && doorStatusRef.current === 'closed' && readyToMoveRef.current) {
        addLog(floorId, 'info', 'Already here - Opening doors', '🚪');
        setTimeout(() => handleDoorOperation('open', floorId), 100);
        return prevQueue;
      }
      
      return [...prevQueue, floorId];
    });
  };

  const handleReaderSwipe = (requestedFloor: number, cardInfo?: string) => {
    if (elevatorReader.type === 'none' || !elevatorReader.enabled) {
      addLog(requestedFloor, 'error', 'Reader not configured', '❌');
      return;
    }

    // ✅ ACU grants access - set accessGrantedByACU to true (simulates ACU input signal)
    setFloors(prev => prev.map(f => 
      f.id === requestedFloor 
        ? { ...f, accessGrantedByACU: true, accessGranted: true, accessAttempts: f.accessAttempts + 1, lastAccess: new Date() } 
        : f
    ));

    setStats(prev => ({
      ...prev,
      accessAttempts: { granted: prev.accessAttempts.granted + 1, denied: prev.accessAttempts.denied }
    }));

    const floor = floors.find(f => f.id === requestedFloor);
    addLog(requestedFloor, 'success', `✅ ACU GRANTED Floor ${requestedFloor} (Analog ${floor?.analogInput})`, '✅');
    
    // Now call button will work because accessGrantedByACU is true
    setTimeout(() => handleCallButton(requestedFloor), 100);
    
    // ACU access grant times out after arrival + door cycle (or 30 seconds max)
    setTimeout(() => {
      setFloors(prev => prev.map(f => f.id === requestedFloor ? { ...f, accessGrantedByACU: false, accessGranted: false, callButtonLit: false } : f));
      addLog(requestedFloor, 'info', `🔒 ACU access expired for Floor ${requestedFloor}`, '🔒');
    }, 30000);

    if (onFloorAccess) onFloorAccess(requestedFloor, elevatorReader.readerId, true);
  };

  // ✅ FIXED: Door operation with readyToMove gate
  const handleDoorOperation = (operation: 'open' | 'close', floorOverride?: number) => {
    const activeFloor = floorOverride ?? currentFloorRef.current;
    
    if (operation === 'open' && doorStatusRef.current === 'closed') {
      // ✅ Block movement while door cycle is active
      setReadyToMove(false);
      readyToMoveRef.current = false;
      
      setDoorStatus('opening');
      addLog(activeFloor, 'info', `🚪 Doors opening at Floor ${activeFloor}`, '🚪');
      
      setTimeout(() => {
        setDoorStatus('open');
        setFloors(prev => prev.map(f => f.id === activeFloor ? { ...f, doorOpen: true, callButtonPressed: false } : f));
        addLog(activeFloor, 'success', `✓ Doors open at Floor ${activeFloor}`, '✓');
        
        if (doorCloseTimerRef.current) clearTimeout(doorCloseTimerRef.current);
        
        doorCloseTimerRef.current = setTimeout(() => {
          if (doorStatusRef.current === 'open' && elevatorModeRef.current === 'normal') {
            handleDoorOperation('close', activeFloor);
          }
        }, doorOpenDuration * 1000);
      }, 1500);
      
    } else if (operation === 'close' && doorStatusRef.current === 'open') {
      if (doorCloseTimerRef.current) {
        clearTimeout(doorCloseTimerRef.current);
        doorCloseTimerRef.current = null;
      }
      
      setDoorStatus('closing');
      addLog(activeFloor, 'info', `🚪 Doors closing at Floor ${activeFloor}`, '🚪');
      
      setTimeout(() => {
        setDoorStatus('closed');
        setFloors(prev => prev.map(f => f.id === activeFloor ? { ...f, doorOpen: false } : f));
        addLog(activeFloor, 'success', `✓ Doors closed at Floor ${activeFloor}`, '✓');
        
        // ✅ CRITICAL: Wait 500ms after doors close before allowing next movement
        setTimeout(() => {
          console.log(`[GATE] Doors fully closed, enabling movement`);
          setReadyToMove(true);
          readyToMoveRef.current = true;
          
          // Auto-return check
          if (autoReturnEnabledRef.current && activeFloor !== 1 && 
              callQueueRef.current.length === 0 && !isReturningToGroundRef.current && 
              !isMovingRef.current && elevatorModeRef.current === 'normal') {
            setIsReturningToGround(true);
            isReturningToGroundRef.current = true;
            addLog(1, 'info', '🏠 Auto-returning to Ground Level', '🏠');
            handleCallButton(1, { system: true });
          }
        }, 500);
      }, 1500);
    }
  };

  // Keep refs in sync
  useEffect(() => { doorStatusRef.current = doorStatus; }, [doorStatus]);
  useEffect(() => { currentFloorRef.current = currentFloor; }, [currentFloor]);
  useEffect(() => { isReturningToGroundRef.current = isReturningToGround; }, [isReturningToGround]);
  useEffect(() => { autoReturnEnabledRef.current = autoReturnEnabled; }, [autoReturnEnabled]);
  useEffect(() => { callQueueRef.current = callQueue; }, [callQueue]);
  useEffect(() => { isMovingRef.current = isMoving; }, [isMoving]);
  useEffect(() => { elevatorModeRef.current = elevatorMode; }, [elevatorMode]);
  useEffect(() => { floorsRef.current = floors; }, [floors]);
  useEffect(() => { readyToMoveRef.current = readyToMove; }, [readyToMove]);

  // ✅ Sync IOPlus hardware inputs to floor accessGrantedByACU state
  useEffect(() => {
    if (acuInputType === 'analog' && ioPlusAnalogInputs.length > 0) {
      // Analog inputs: check if voltage exceeds threshold
      setFloors(prev => prev.map(floor => {
        const inputIndex = floor.analogInput - 1; // Analog inputs are 1-indexed
        const inputValue = ioPlusAnalogInputs[inputIndex] ?? 0;
        const isActive = inputValue >= acuAnalogThreshold;
        
        // Only update if changed to avoid re-renders
        if (floor.accessGrantedByACU !== isActive) {
          if (isActive) {
            console.log(`[IOPlus] Analog ${floor.analogInput} ACTIVE (${inputValue.toFixed(2)}V >= ${acuAnalogThreshold}V) → Floor ${floor.id} ACU GRANTED`);
          } else {
            console.log(`[IOPlus] Analog ${floor.analogInput} INACTIVE (${inputValue.toFixed(2)}V < ${acuAnalogThreshold}V) → Floor ${floor.id} ACU REVOKED`);
          }
          return { ...floor, accessGrantedByACU: isActive, callButtonLit: isActive ? floor.callButtonLit : false };
        }
        return floor;
      }));
    } else if (acuInputType === 'opto' && ioPlusOptoInputs.length > 0) {
      // Opto inputs: direct boolean state
      setFloors(prev => prev.map(floor => {
        const inputIndex = floor.analogInput - 1; // Using same index mapping
        const isActive = ioPlusOptoInputs[inputIndex] ?? false;
        
        if (floor.accessGrantedByACU !== isActive) {
          if (isActive) {
            console.log(`[IOPlus] Opto ${floor.analogInput} ACTIVE → Floor ${floor.id} ACU GRANTED`);
          } else {
            console.log(`[IOPlus] Opto ${floor.analogInput} INACTIVE → Floor ${floor.id} ACU REVOKED`);
          }
          return { ...floor, accessGrantedByACU: isActive, callButtonLit: isActive ? floor.callButtonLit : false };
        }
        return floor;
      }));
    }
  }, [ioPlusAnalogInputs, ioPlusOptoInputs, acuInputType, acuAnalogThreshold]);

  // ✅ Listen for IOPlus input changes via WebSocket
  // Backend emits 'input_state_change' with type: 'opto' | 'analog'
  useEffect(() => {
    if (!socket) {
      console.log('[ElevatorSection] No socket provided - input events will not be received');
      return;
    }

    console.log('[ElevatorSection] Socket connected, listening for input_state_change events');

    const handleInputStateChange = (data: { 
      type: 'opto' | 'analog'; 
      pin: number; 
      state: number; 
      voltage?: number;
      threshold?: number;
      supervisionState?: 'normal' | 'active' | 'trouble' | 'short';
      timestamp: number 
    }) => {
      const channel = data.pin + 1; // Convert 0-indexed pin to 1-indexed channel for floor matching
      
      console.log(`[Socket] Input state change:`, data);
      
      // Check if input type matches our configuration
      if (acuInputType === 'analog' && data.type !== 'analog') return;
      if (acuInputType === 'opto' && data.type !== 'opto') return;
      
      // Determine if active based on input type and supervision state
      let isActive: boolean;
      let stateReason: string;
      
      // Handle supervision states first (if present)
      if (data.supervisionState) {
        switch (data.supervisionState) {
          case 'active':
            isActive = true;
            stateReason = 'SUPERVISED ACTIVE';
            break;
          case 'normal':
            isActive = false;
            stateReason = 'SUPERVISED NORMAL';
            break;
          case 'trouble':
            isActive = false;
            stateReason = 'TROUBLE';
            break;
          case 'short':
            isActive = false;
            stateReason = 'SHORT';
            break;
          default:
            isActive = false;
            stateReason = 'UNKNOWN';
        }
        console.log(`[IOPlus] Channel ${channel} supervision: ${data.supervisionState} → ${stateReason}`);
      } else if (data.type === 'analog') {
        // Backend sends voltage in millivolts, threshold is in volts
        const voltageMv = data.voltage ?? 0;
        const thresholdMv = acuAnalogThreshold * 1000; // Convert V to mV
        isActive = voltageMv >= thresholdMv;
        stateReason = `${voltageMv}mV ${isActive ? '>=' : '<'} ${thresholdMv}mV`;
        console.log(`[IOPlus] Analog ${channel}: ${stateReason}`);
      } else {
        // For opto, use direct state
        isActive = data.state === 1;
        stateReason = isActive ? 'HIGH' : 'LOW';
        console.log(`[IOPlus] Opto ${channel}: ${stateReason}`);
      }
      
      setFloors(prev => prev.map(floor => {
        if (floor.analogInput === channel) {
          if (floor.accessGrantedByACU !== isActive) {
            if (isActive) {
              console.log(`[IOPlus] Channel ${channel} → Floor ${floor.id} ACU GRANTED`);
              addLog(floor.id, 'success', `🔓 ACU GRANTED (${stateReason})`, '🔓');
            } else {
              console.log(`[IOPlus] Channel ${channel} → Floor ${floor.id} ACU REVOKED`);
              addLog(floor.id, 'info', `🔒 ACU REVOKED (${stateReason})`, '🔒');
            }
            return { ...floor, accessGrantedByACU: isActive, callButtonLit: isActive ? floor.callButtonLit : false };
          }
        }
        return floor;
      }));
    };

    // Listen for the actual event the backend emits
    socket.on('input_state_change', handleInputStateChange);
    
    // Log when connection status changes
    socket.on('connect', () => {
      console.log('[ElevatorSection] Socket connected');
      addLog(1, 'success', 'Socket connected - listening for ACU inputs', '🔌');
    });
    
    socket.on('disconnect', () => {
      console.log('[ElevatorSection] Socket disconnected');
      addLog(1, 'warning', 'Socket disconnected', '⚠️');
    });

    return () => {
      socket.off('input_state_change', handleInputStateChange);
      socket.off('connect');
      socket.off('disconnect');
    };
  }, [socket, acuInputType, acuAnalogThreshold]);

  useEffect(() => {
    if (elevatorMode !== 'normal' && doorCloseTimerRef.current) {
      clearTimeout(doorCloseTimerRef.current);
      doorCloseTimerRef.current = null;
    }
  }, [elevatorMode]);

  useEffect(() => {
    return () => { if (doorCloseTimerRef.current) clearTimeout(doorCloseTimerRef.current); };
  }, []);

  // ✅ FIXED: Process queue - now checks readyToMove
  useEffect(() => {
    // Must be: normal mode, not moving, doors closed, AND ready to move
    if (callQueue.length === 0 || isMoving || doorStatus !== 'closed' || elevatorMode !== 'normal' || !readyToMove) {
      return;
    }

    console.log(`[QUEUE] Processing: [${callQueue.join(',')}], current=${currentFloor}, ready=${readyToMove}`);

    let nextFloor: number | null = null;
    
    if (direction === 'idle' || direction === 'up') {
      const floorsAbove = callQueue.filter(f => f > currentFloor).sort((a, b) => a - b);
      if (floorsAbove.length > 0) nextFloor = floorsAbove[0];
    }
    
    if (nextFloor === null && (direction === 'idle' || direction === 'down')) {
      const floorsBelow = callQueue.filter(f => f < currentFloor).sort((a, b) => b - a);
      if (floorsBelow.length > 0) nextFloor = floorsBelow[0];
    }
    
    if (nextFloor === null) nextFloor = callQueue[0];

    if (nextFloor !== null) {
      // ✅ Block movement until arrival completes
      setReadyToMove(false);
      readyToMoveRef.current = false;
      
      // ✅ Turn OFF departure floor tracking relay when leaving
      const departureFloor = floorsRef.current.find(f => f.id === currentFloor);
      if (departureFloor) {
        console.log(`[TRACK] Departure: Turning OFF tracking relay ${departureFloor.trackingGpio} for Floor ${currentFloor}`);
        setGPIO(departureFloor.trackingGpio, 0, currentFloor);
        // Clear tracking AND input for departure floor only
        // This will also disable call button lighting for that floor
        setFloors(prev => prev.map(f => f.id === currentFloor ? { 
          ...f,
          isTracking: false,        // Tracking relay OFF - elevator leaving this floor
          callButtonLit: false      // Call button goes dark when elevator departs
        } : f));
        addLog(currentFloor, 'info', `📍 Track ${departureFloor.trackingGpio} OFF (departing F${currentFloor})`, '⬇️');
      }
      
      setTargetFloor(nextFloor);
      setIsMoving(true);
      const dir = nextFloor > currentFloor ? 'up' : 'down';
      setDirection(dir);
      addLog(currentFloor, 'info', `🚀 Departing Floor ${currentFloor} → Floor ${nextFloor}`, dir === 'up' ? '⬆️' : '⬇️');
      setStats(prev => ({
        ...prev,
        totalTrips: prev.totalTrips + 1,
        floorsVisited: { ...prev.floorsVisited, [nextFloor!]: (prev.floorsVisited[nextFloor!] || 0) + 1 }
      }));
    }
  }, [callQueue, isMoving, doorStatus, elevatorMode, currentFloor, direction, readyToMove]);

  // Movement animation
  useEffect(() => {
    if (!isMoving || targetFloor === null) return;

    const interval = setInterval(() => {
      setCurrentFloor(prev => {
        if (prev === targetFloor) {
          setIsMoving(false);
          setDirection('idle');
          setCallQueue(q => q.filter(f => f !== targetFloor));
          
          // ✅ Turn ON arrival floor tracking relay
          const arrivalFloor = floorsRef.current.find(f => f.id === targetFloor);
          if (arrivalFloor) {
            console.log(`[TRACK] Arrival: Turning ON tracking relay ${arrivalFloor.trackingGpio} for Floor ${targetFloor}`);
            setGPIO(arrivalFloor.trackingGpio, 1, targetFloor);
            addLog(targetFloor, 'success', `📍 Track ${arrivalFloor.trackingGpio} ON (arrived F${targetFloor})`, '⬆️');
          }
          
          // Update floor states on arrival:
          // - Set tracking for arrival floor (tells ACU elevator is here)
          // - Clear callButtonPressed/Lit since we serviced this floor
          // - Clear accessGrantedByACU since the call was fulfilled
          setFloors(f => f.map(floor => ({
            ...floor,
            isTracking: floor.id === targetFloor,
            // Clear the call and ACU access for the arrival floor (call fulfilled)
            callButtonPressed: floor.id === targetFloor ? false : floor.callButtonPressed,
            callButtonLit: floor.id === targetFloor ? false : floor.callButtonLit,
            accessGrantedByACU: floor.id === targetFloor ? false : floor.accessGrantedByACU, // ACU access cleared after arrival
          })));
          
          if (targetFloor === 1 && isReturningToGroundRef.current) {
            setIsReturningToGround(false);
            addLog(1, 'success', '✅ Returned to Ground', '🏠');
          } else {
            addLog(targetFloor, 'success', `✅ Arrived Floor ${targetFloor}`, '🎯');
          }
          
          // Open doors after arrival
          setTimeout(() => handleDoorOperation('open', targetFloor), 500);
          return prev;
        }
        return prev + (targetFloor > prev ? 1 : -1);
      });
    }, 1000 / speed);

    return () => clearInterval(interval);
  }, [isMoving, targetFloor, speed]);

  // Backend check
  useEffect(() => {
    const checkBackend = async () => {
      try {
        const baseUrl = backendUrl || `http://${window.location.hostname}:3001`;
        const response = await fetch(`${baseUrl}/api/gpio/health`);
        if (response.ok) {
          setGpioBackendAvailable(true);
          addLog(1, 'success', 'GPIO Backend Connected', '✅');
        }
      } catch (error) {
        setGpioBackendAvailable(false);
        addLog(1, 'info', 'GPIO offline - sim mode', '🔧');
      }
    };
    checkBackend();
  }, [backendUrl]);

  // Fetch readers
  useEffect(() => {
    const fetchReaders = async () => {
      try {
        const baseUrl = backendUrl || `http://${window.location.hostname}:3001`;
        
        const osdpRes = await fetch(`${baseUrl}/api/osdp/readers`);
        if (osdpRes.ok) {
          const data = await osdpRes.json();
          if (data.success && data.readers) {
            setAvailableOSDPReaders(data.readers.map((r: any) => ({
              id: r.id, name: r.name || `Reader ${r.address}`, address: r.address, status: r.enabled ? 'online' : 'offline'
            })));
          }
        }

        const wiegandRes = await fetch(`${baseUrl}/api/wiegand/config`);
        if (wiegandRes.ok) {
          const data = await wiegandRes.json();
          if (data.ok && data.doors) {
            setAvailableWiegandReaders(data.doors.map((d: any) => ({
              id: String(d.door), name: d.name || `Wiegand Door ${d.door}`, door: d.door, status: 'online'
            })));
          }
        }
      } catch (error) {}
    };
    fetchReaders();
  }, [backendUrl]);

  const updateReaderConfig = (type: ElevatorReader['type'], readerId: string, readerName: string) => {
    setElevatorReader({ type, readerId, readerName, enabled: type !== 'none' });
    if (type !== 'none') addLog(currentFloor, 'info', `Reader: ${readerName}`, '🔧');
  };

  const mapFormatToBackend = (formatId: string): string => {
    const mapping: { [key: string]: string } = {
      'wiegand26': 'wiegand26', 'wiegand34': 'wiegand34', 'wiegand37': 'wiegand37',
      'wiegand48': 'wiegand48', 'wiegand64': 'wiegand64'
    };
    return mapping[formatId] || 'wiegand26';
  };

  const generateRandomCardForFormat = () => {
    const format = cardFormats.find(f => f.id === selectedFormat) || cardFormats[0];
    const randomFC = format.facilityBits > 0 ? Math.floor(Math.random() * format.maxFacility) + 1 : 0;
    const randomCard = Math.floor(Math.random() * (format.maxCard > 1000000 ? 1000000 : format.maxCard)) + 1;
    setFacilityCode(String(randomFC));
    setCardNumber(String(randomCard));
    addLog(cardTargetFloor, 'info', `🎲 Random: FC:${randomFC}, Card:${randomCard}`, '🎲');
  };

  const sendConfiguredCard = async () => {
    if (!elevatorReader.enabled) {
      addLog(cardTargetFloor, 'error', 'Reader not configured', '❌');
      return;
    }

    const format = cardFormats.find(f => f.id === selectedFormat) || cardFormats[0];
    const fc = parseInt(facilityCode) || 0;
    const card = parseInt(cardNumber) || 0;
    
    if (format.facilityBits > 0 && (fc < 0 || fc > format.maxFacility)) {
      addLog(cardTargetFloor, 'error', `Invalid FC. Max: ${format.maxFacility}`, '❌');
      return;
    }
    if (card < 1 || card > format.maxCard) {
      addLog(cardTargetFloor, 'error', `Invalid Card. Max: ${format.maxCard}`, '❌');
      return;
    }

    addLog(cardTargetFloor, 'info', `💳 ${format.name} FC:${fc} Card:${card}`, '💳');

    try {
      const baseUrl = backendUrl || `http://${window.location.hostname}:3001`;
      
      if (elevatorReader.type === 'osdp') {
        const response = await fetch(`${baseUrl}/api/osdp/card-read`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ readerId: elevatorReader.readerId, facility: fc, card: card, format: mapFormatToBackend(format.id) })
        });
        const result = await response.json();
        if (result.success) {
          addLog(cardTargetFloor, 'success', `✅ OSDP sent`, '✅');
          handleReaderSwipe(cardTargetFloor, `${fc}:${card}`);
        } else {
          addLog(cardTargetFloor, 'error', `❌ OSDP: ${result.error}`, '❌');
        }
      } else if (elevatorReader.type === 'wiegand') {
        const doorNumber = parseInt(elevatorReader.readerId);
        const response = await fetch(`${baseUrl}/api/wiegand/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ door: doorNumber, facility: fc, card: card, format: format.bits, parity: 'std', pulseUs: 50, spaceUs: 1000 })
        });
        const result = await response.json();
        if (result.ok) {
          addLog(cardTargetFloor, 'success', `✅ Wiegand sent`, '✅');
          handleReaderSwipe(cardTargetFloor, `${fc}:${card}`);
        } else {
          addLog(cardTargetFloor, 'error', `❌ Wiegand: ${result.error}`, '❌');
        }
      }
    } catch (error: any) {
      addLog(cardTargetFloor, 'error', `❌ ${error.message}`, '❌');
    }
  };

  const handleRandomCardSwipe = async (requestedFloor: number) => {
    if (!elevatorReader.enabled) {
      addLog(requestedFloor, 'error', 'Reader not configured', '❌');
      return;
    }

    const randomFormat = cardFormats[Math.floor(Math.random() * cardFormats.length)];
    const randomFC = randomFormat.facilityBits > 0 ? Math.floor(Math.random() * randomFormat.maxFacility) + 1 : 0;
    const randomCard = Math.floor(Math.random() * (randomFormat.maxCard > 1000000 ? 1000000 : randomFormat.maxCard)) + 1;
    
    addLog(requestedFloor, 'info', `🎲 ${randomFormat.name}: FC:${randomFC}`, '🎲');

    try {
      const baseUrl = backendUrl || `http://${window.location.hostname}:3001`;
      
      if (elevatorReader.type === 'osdp') {
        await fetch(`${baseUrl}/api/osdp/card-read`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ readerId: elevatorReader.readerId, facility: randomFC, card: randomCard, format: mapFormatToBackend(randomFormat.id) })
        });
        handleReaderSwipe(requestedFloor, `${randomFC}:${randomCard}`);
      } else if (elevatorReader.type === 'wiegand') {
        const doorNumber = parseInt(elevatorReader.readerId);
        await fetch(`${baseUrl}/api/wiegand/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ door: doorNumber, facility: randomFC, card: randomCard, format: randomFormat.bits, parity: 'std', pulseUs: 50, spaceUs: 1000 })
        });
        handleReaderSwipe(requestedFloor, `${randomFC}:${randomCard}`);
      }
    } catch (error: any) {
      addLog(requestedFloor, 'error', `❌ ${error.message}`, '❌');
    }
  };

  const toggleFloorTracking = async (floorId: number) => {
    const floor = floors.find(f => f.id === floorId);
    if (!floor) return;
    
    const newState = !floor.isTracking;
    setFloors(prev => prev.map(f => f.id === floorId ? { ...f, isTracking: newState } : f));
    await setGPIO(floor.trackingGpio, newState ? 1 : 0, floorId);
    addLog(floorId, 'info', `📍 Track ${floor.trackingGpio} → ${newState ? 'ON' : 'OFF'}`, '📍');
  };

  const handleEmergencyStop = () => {
    setElevatorMode('emergency');
    setCallQueue([]);
    setIsMoving(false);
    setDirection('idle');
    setIsReturningToGround(false);
    setReadyToMove(true);
    readyToMoveRef.current = true;
    setFloors(prev => prev.map(f => ({ ...f, callButtonPressed: false })));
    floors.forEach(f => setGPIO(f.trackingGpio, 0, f.id));
    addLog(currentFloor, 'error', `🚨 EMERGENCY STOP`, '🚨');
  };

  const resumeNormal = () => {
    setElevatorMode('normal');
    setReadyToMove(true);
    readyToMoveRef.current = true;
    addLog(currentFloor, 'success', '✅ Resumed', '✅');
  };

  const exportLogs = () => {
    const logText = logs.map(log => `[${log.timestamp.toLocaleString()}] F${log.floor} ${log.type}: ${log.message}`).join('\n');
    const blob = new Blob([logText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `elevator-logs-${new Date().toISOString()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      {/* Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-gradient-to-br from-slate-800 to-slate-900 rounded-2xl p-8 max-w-2xl w-full border-2 border-cyan-500/50 shadow-2xl">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-3xl font-bold text-white flex items-center gap-3"><Settings className="w-8 h-8 text-cyan-400" />Settings</h2>
              <button onClick={() => setShowSettings(false)} className="text-slate-400 hover:text-white text-3xl">✕</button>
            </div>
            <div className="space-y-6">
              <div className="p-5 bg-slate-900/50 rounded-xl border border-slate-700/50">
                <label className="text-sm font-semibold text-slate-300 block mb-3">Speed (floors/sec)</label>
                <input type="range" min="0.5" max="3" step="0.5" value={speed} onChange={(e) => setSpeed(parseFloat(e.target.value))} className="w-full" />
                <div className="text-center text-xl text-cyan-400 font-bold mt-3">{speed}x</div>
              </div>
              <div className="p-5 bg-slate-900/50 rounded-xl border border-slate-700/50 flex items-center justify-between">
                <div><label className="text-sm font-semibold text-slate-300">Auto-Return</label><p className="text-xs text-slate-400">Return to lobby when idle</p></div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input type="checkbox" checked={autoReturnEnabled} onChange={(e) => setAutoReturnEnabled(e.target.checked)} className="sr-only peer" />
                  <div className="w-14 h-7 bg-slate-700 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-6 after:w-6 after:transition-all peer-checked:bg-cyan-600"></div>
                </label>
              </div>
              <div className="p-5 bg-slate-900/50 rounded-xl border border-slate-700/50">
                <label className="text-sm font-semibold text-slate-300 block mb-3">Door Hold (sec)</label>
                <input type="range" min="5" max="60" step="5" value={doorOpenDuration} onChange={(e) => setDoorOpenDuration(parseInt(e.target.value))} className="w-full" />
                <div className="text-center text-xl text-cyan-400 font-bold mt-3">{doorOpenDuration}s</div>
              </div>
            </div>
            <button onClick={() => { setShowSettings(false); addLog(currentFloor, 'success', 'Settings saved', '💾'); }} className="mt-6 w-full px-6 py-3 bg-green-600 hover:bg-green-700 rounded-lg font-semibold flex items-center justify-center gap-2"><Save className="w-5 h-5" />Save</button>
          </div>
        </div>
      )}

      {/* GPIO Modal */}
      {showGPIOConfig && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-gradient-to-br from-slate-800 to-slate-900 rounded-2xl p-8 max-w-4xl w-full border-2 border-cyan-500/50 shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-3xl font-bold text-white flex items-center gap-3"><Sliders className="w-8 h-8 text-cyan-400" />GPIO Config</h2>
              <button onClick={() => setShowGPIOConfig(false)} className="text-slate-400 hover:text-white text-3xl">✕</button>
            </div>
            
            {/* ACU Input Type Configuration */}
            <div className="mb-4 p-4 bg-slate-900/50 rounded-lg border border-blue-500/30">
              <h3 className="text-sm font-bold text-blue-400 mb-3">ACU Access Input Configuration</h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Input Type</label>
                  <select 
                    value={acuInputType} 
                    onChange={(e) => setAcuInputType(e.target.value as 'analog' | 'opto')}
                    className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-2 text-white text-sm"
                  >
                    <option value="analog">Analog Inputs (1-8)</option>
                    <option value="opto">Opto-Isolated Inputs (1-8)</option>
                  </select>
                </div>
                {acuInputType === 'analog' && (
                  <div>
                    <label className="text-xs text-slate-400 block mb-1">Voltage Threshold</label>
                    <div className="flex items-center gap-2">
                      <input 
                        type="number" 
                        min="0" 
                        max="10" 
                        step="0.1" 
                        value={acuAnalogThreshold} 
                        onChange={(e) => setAcuAnalogThreshold(parseFloat(e.target.value) || 2.5)}
                        className="w-20 bg-slate-800 border border-slate-600 rounded px-3 py-2 text-white font-mono text-sm"
                      />
                      <span className="text-slate-400 text-sm">V (ACU active when ≥ this value)</span>
                    </div>
                  </div>
                )}
              </div>
              <p className="text-xs text-slate-500 mt-2">
                {acuInputType === 'analog' 
                  ? `When Analog Input voltage ≥ ${acuAnalogThreshold}V, ACU access is GRANTED for that floor`
                  : 'When Opto Input is HIGH, ACU access is GRANTED for that floor'
                }
              </p>
              <div className="mt-2 flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${socket ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
                <span className="text-xs text-slate-500">
                  {socket ? 'Socket connected - listening for input_state_change events' : 'Socket not connected - ensure parent passes socket prop'}
                </span>
              </div>
            </div>
            
            {/* Legend */}
            <div className="mb-4 p-3 bg-slate-900/50 rounded-lg border border-slate-700/50 flex flex-wrap gap-4 text-xs">
              <div className="flex items-center gap-2"><div className="w-3 h-3 rounded bg-green-500" /><span className="text-slate-300">TRK = Relay Output (Floor Tracking to ACU)</span></div>
              <div className="flex items-center gap-2"><div className="w-3 h-3 rounded bg-blue-500" /><span className="text-slate-300">ACU = {acuInputType === 'analog' ? 'Analog' : 'Opto'} Input (ACU Access Grant)</span></div>
              <div className="flex items-center gap-2"><div className="w-3 h-3 rounded bg-cyan-500" /><span className="text-slate-300">🔓 = Call Button Ready</span></div>
              <div className="flex items-center gap-2"><div className="w-3 h-3 rounded bg-yellow-500" /><span className="text-slate-300">💡 = Call Button Lit</span></div>
            </div>
            
            <div className="space-y-3">
              {floors.map(floor => (
                <div key={floor.id} className="bg-slate-900/50 rounded-lg p-4 border border-slate-700/50 grid grid-cols-7 gap-3 items-center">
                  <div><div className="font-bold text-white">F{floor.id}</div><div className="text-sm text-slate-400">{floor.name}</div></div>
                  <div><label className="text-xs text-green-400">Relay (Out)</label><input type="number" min="1" max="8" value={floor.trackingGpio} onChange={(e) => setFloors(prev => prev.map(f => f.id === floor.id ? { ...f, trackingGpio: parseInt(e.target.value) || 1 } : f))} className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-2 text-white font-mono text-sm" /></div>
                  <div><label className="text-xs text-blue-400">{acuInputType === 'analog' ? 'Analog' : 'Opto'} In</label><input type="number" min="1" max="8" value={floor.analogInput} onChange={(e) => setFloors(prev => prev.map(f => f.id === floor.id ? { ...f, analogInput: parseInt(e.target.value) || 1 } : f))} className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-2 text-white font-mono text-sm" /></div>
                  <div className="flex flex-col items-center gap-1">
                    <div className={`w-4 h-4 rounded ${floor.isTracking ? 'bg-green-500 animate-pulse' : 'bg-slate-700'}`} title="Floor Tracking Output" />
                    <span className="text-[9px] text-slate-500">TRK</span>
                  </div>
                  <div className="flex flex-col items-center gap-1">
                    <div className={`w-4 h-4 rounded ${floor.accessGrantedByACU ? 'bg-blue-500 animate-pulse' : 'bg-slate-700'}`} title="ACU Access Grant" />
                    <span className="text-[9px] text-slate-500">ACU</span>
                  </div>
                  <div className="flex flex-col items-center gap-1">
                    <div className={`w-4 h-4 rounded ${floor.callButtonLit ? 'bg-yellow-500 animate-pulse' : floor.accessGrantedByACU ? 'bg-cyan-500' : 'bg-slate-700'}`} title="Call Button" />
                    <span className="text-[9px] text-slate-500">{floor.callButtonLit ? '💡' : floor.accessGrantedByACU ? '🔓' : '🔒'}</span>
                  </div>
                  <button onClick={() => toggleFloorTracking(floor.id)} className={`px-3 py-2 rounded text-sm font-semibold ${floor.isTracking ? 'bg-green-600' : 'bg-slate-700'}`}>{floor.isTracking ? 'TRK ON' : 'TRK OFF'}</button>
                </div>
              ))}
            </div>
            <button onClick={() => { setShowGPIOConfig(false); addLog(currentFloor, 'success', 'GPIO saved', '💾'); }} className="mt-6 w-full px-6 py-3 bg-green-600 hover:bg-green-700 rounded-lg font-semibold"><Save className="w-5 h-5 inline mr-2" />Save</button>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="bg-gradient-to-br from-slate-800/90 to-slate-900/90 backdrop-blur-xl rounded-2xl p-6 border border-slate-700/50 shadow-2xl">
        <div className="flex items-start justify-between mb-6">
          <div>
            <h1 className="text-4xl font-bold text-white flex items-center gap-3 mb-2"><Building2 className="w-10 h-10 text-cyan-400" />Elevator Simulator</h1>
            <p className="text-slate-400">8 Floor w/ Door Gate Check</p>
          </div>
          <div className="flex gap-2">
            <button onClick={() => setShowGPIOConfig(true)} className="p-2 bg-cyan-600 hover:bg-cyan-700 rounded-lg"><Sliders className="w-5 h-5 text-white" /></button>
            <button onClick={() => setShowSettings(true)} className="p-2 bg-slate-700 hover:bg-slate-600 rounded-lg"><Settings className="w-5 h-5 text-slate-300" /></button>
          </div>
        </div>

        {/* Status Cards */}
        <div className="grid grid-cols-7 gap-3">
          <div className="bg-slate-900/50 rounded-xl p-4 border border-slate-700/50">
            <div className="text-xs text-slate-400 mb-1">Floor</div>
            <div className="text-3xl font-bold text-cyan-400">{currentFloor}</div>
          </div>
          <div className="bg-slate-900/50 rounded-xl p-4 border border-slate-700/50">
            <div className="text-xs text-slate-400 mb-1">Queue</div>
            <div className="text-xl font-bold text-violet-400">{callQueue.length}</div>
            <div className="text-xs text-slate-500 truncate">{callQueue.slice(0,3).join(',') || '-'}</div>
          </div>
          <div className="bg-slate-900/50 rounded-xl p-4 border border-slate-700/50">
            <div className="text-xs text-slate-400 mb-1">Status</div>
            <div className={`text-xl font-bold ${elevatorMode === 'emergency' ? 'text-red-400' : isMoving ? 'text-yellow-400' : doorStatus === 'open' ? 'text-green-400' : 'text-slate-400'}`}>
              {elevatorMode === 'emergency' ? 'STOP' : isMoving ? direction.toUpperCase() : doorStatus.toUpperCase()}
            </div>
          </div>
          <div className="bg-slate-900/50 rounded-xl p-4 border border-slate-700/50">
            <div className="text-xs text-slate-400 mb-1">Ready</div>
            <div className={`text-xl font-bold ${readyToMove ? 'text-green-400' : 'text-yellow-400'}`}>
              {readyToMove ? 'YES' : 'WAIT'}
            </div>
          </div>
          <div className="bg-slate-900/50 rounded-xl p-4 border border-slate-700/50">
            <div className="text-xs text-slate-400 mb-1">Trips</div>
            <div className="text-3xl font-bold text-green-400">{stats.totalTrips}</div>
          </div>
          <div className="bg-slate-900/50 rounded-xl p-4 border border-slate-700/50">
            <div className="text-xs text-slate-400 mb-1">Access</div>
            <div className="text-xl font-bold text-blue-400">{stats.accessAttempts.granted}</div>
          </div>
          <div className="bg-slate-900/50 rounded-xl p-4 border border-slate-700/50">
            <div className="text-xs text-slate-400 mb-1">GPIO</div>
            <div className={`text-base font-bold ${gpioBackendAvailable ? 'text-green-400' : 'text-yellow-400'}`}>{gpioBackendAvailable ? 'LIVE' : 'SIM'}</div>
          </div>
        </div>

        {gpioBackendAvailable && (
          <div className="mt-4 p-4 bg-green-500/10 border border-green-500/30 rounded-lg flex items-center gap-3">
            <Check className="w-5 h-5 text-green-400" /><span className="text-green-400 font-semibold">GPIO Backend Connected</span>
          </div>
        )}

        {elevatorMode !== 'normal' && (
          <div className="mt-4 p-4 bg-red-500/10 border border-red-500/30 rounded-lg flex items-center justify-between">
            <div className="flex items-center gap-3"><AlertTriangle className="w-5 h-5 text-red-400" /><span className="text-red-400 font-semibold">{elevatorMode === 'emergency' ? 'Emergency' : 'Maintenance'}</span></div>
            <button onClick={resumeNormal} className="px-4 py-2 bg-green-600 hover:bg-green-700 rounded-lg font-semibold flex items-center gap-2"><PlayCircle className="w-4 h-4" />Resume</button>
          </div>
        )}

        {isReturningToGround && (
          <div className="mt-4 p-4 bg-blue-500/10 border border-blue-500/30 rounded-lg flex items-center gap-3">
            <Activity className="w-5 h-5 text-blue-400 animate-pulse" /><span className="text-blue-400 font-semibold">🏠 Auto-Returning</span>
          </div>
        )}
      </div>

      {/* Main Layout */}
      <div className="grid grid-cols-12 gap-6">
        {/* Shaft */}
        <div className="col-span-5">
          <div className="bg-gradient-to-br from-slate-800/90 to-slate-900/90 backdrop-blur-xl rounded-2xl p-6 border border-slate-700/50 shadow-2xl">
            <h2 className="text-2xl font-bold text-white mb-4 flex items-center gap-2"><Building2 className="w-6 h-6 text-cyan-400" />Shaft</h2>
            
            <div className="relative bg-slate-900 rounded-2xl border-4 border-slate-600/50 p-4 h-[700px] overflow-hidden">
              <div className="absolute top-0 left-4 w-1.5 h-full bg-slate-600" />
              <div className="absolute top-0 right-4 w-1.5 h-full bg-slate-600" />
              
              <div className="relative h-full flex flex-col-reverse gap-1">
                {[...floors].reverse().map((floor) => {
                  const isCurrent = floor.id === currentFloor;
                  const inQueue = callQueue.includes(floor.id);
                  
                  return (
                    <div key={floor.id} className="relative h-[80px]">
                      <div onClick={() => handleCallButton(floor.id)} className={`relative h-full rounded-lg cursor-pointer overflow-hidden transition-all ${isCurrent ? 'border-3 border-cyan-400 shadow-xl shadow-cyan-500/50 scale-105 z-10' : inQueue ? 'border-2 border-yellow-400 animate-pulse' : 'border-2 border-slate-700/50 hover:border-slate-600'}`} style={{ background: isCurrent ? 'linear-gradient(135deg, rgba(6,182,212,0.3), rgba(59,130,246,0.3))' : inQueue ? 'linear-gradient(135deg, rgba(251,191,36,0.2), rgba(245,158,11,0.2))' : 'linear-gradient(135deg, rgba(30,41,59,0.8), rgba(15,23,42,0.8))' }}>
                        <div className="absolute left-3 top-2 flex items-center gap-2">
                          <div className={`text-xl font-black ${isCurrent ? 'text-cyan-300' : 'text-slate-300'}`}>{floor.id}</div>
                          <span className={`px-2 py-0.5 rounded-full text-xs font-bold border ${getAccessLevelColor(floor.accessLevel)}`}>{getAccessLevelIcon(floor.accessLevel)}</span>
                        </div>
                        
                        {/* Status indicators: Track (OUTPUT to ACU), ACU (INPUT from ACU), Call Button */}
                        <div className="absolute right-2 top-1 flex flex-col gap-0.5">
                          {/* Tracking Output - tells ACU elevator is at this floor */}
                          <div className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[8px] font-bold ${floor.isTracking ? 'bg-green-500/40 text-green-300' : 'bg-slate-700/50 text-slate-500'}`} title="Floor Tracking (Output to ACU)">
                            <div className={`w-2 h-2 rounded-full ${floor.isTracking ? 'bg-green-400 animate-pulse' : 'bg-slate-600'}`} />
                            TRK
                          </div>
                          {/* ACU Access - input from ACU granting access */}
                          <div className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[8px] font-bold ${floor.accessGrantedByACU ? 'bg-blue-500/40 text-blue-300' : 'bg-slate-700/50 text-slate-500'}`} title="ACU Access Grant (Input from ACU)">
                            <div className={`w-2 h-2 rounded-full ${floor.accessGrantedByACU ? 'bg-blue-400 animate-pulse' : 'bg-slate-600'}`} />
                            ACU
                          </div>
                          {/* Call Button - only usable/lit when ACU grants access */}
                          <div className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[8px] font-bold ${floor.callButtonLit ? 'bg-yellow-500/40 text-yellow-300' : floor.accessGrantedByACU ? 'bg-cyan-500/30 text-cyan-400' : 'bg-slate-700/50 text-slate-500'}`} title={floor.accessGrantedByACU ? 'Call Button Ready' : 'Call Button Locked (No ACU Access)'}>
                            <div className={`w-2 h-2 rounded-full ${floor.callButtonLit ? 'bg-yellow-400 animate-pulse' : floor.accessGrantedByACU ? 'bg-cyan-400' : 'bg-slate-600'}`} />
                            {floor.callButtonLit ? '💡' : floor.accessGrantedByACU ? '🔓' : '🔒'}
                          </div>
                        </div>
                        
                        {isCurrent && (
                          <div className={`absolute inset-1.5 rounded-md flex items-center justify-center transition-all ${doorStatus === 'open' ? 'scale-95 opacity-70' : ''}`} style={{ background: 'linear-gradient(135deg, rgba(251,146,60,0.9), rgba(234,88,12,0.9))', boxShadow: '0 8px 30px rgba(251,146,60,0.6)' }}>
                            <div className="flex items-center justify-center">
                              {doorStatus === 'closed' && <div className="flex gap-0.5"><div className="w-8 h-12 bg-blue-600 rounded-l" /><div className="w-8 h-12 bg-blue-600 rounded-r" /></div>}
                              {doorStatus === 'open' && <div className="flex gap-8"><div className="w-6 h-12 bg-blue-600 rounded" /><div className="w-6 h-12 bg-blue-600 rounded" /></div>}
                              {(doorStatus === 'opening' || doorStatus === 'closing') && <div className="flex gap-4"><div className="w-7 h-12 bg-blue-600 rounded animate-pulse" /><div className="w-7 h-12 bg-blue-600 rounded animate-pulse" /></div>}
                            </div>
                          </div>
                        )}
                        
                        <div className="absolute bottom-1 left-3 text-xs text-slate-400">{floor.shortName}</div>
                        <div className="absolute bottom-1 right-2">
                          <div className="flex items-center gap-1">
                            <span className={`text-[9px] font-mono ${floor.isTracking ? 'text-green-300' : 'text-slate-500'}`} title="Relay Output">R:{floor.trackingGpio}</span>
                            <span className={`text-[9px] font-mono ${floor.accessGrantedByACU ? 'text-blue-300' : 'text-slate-500'}`} title={`${acuInputType === 'analog' ? 'Analog' : 'Opto'} Input (from ACU)`}>{acuInputType === 'analog' ? 'A' : 'O'}:{floor.analogInput}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              
              {isMoving && <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 pointer-events-none z-20">{direction === 'up' ? <ChevronUp className="w-16 h-16 text-yellow-300 animate-bounce" /> : <ChevronDown className="w-16 h-16 text-yellow-300 animate-bounce" />}</div>}
            </div>
            
            {/* Controls */}
            <div className="grid grid-cols-2 gap-3 mt-4">
              <button onClick={() => handleDoorOperation('open')} disabled={doorStatus !== 'closed' || isMoving || elevatorMode !== 'normal' || !readyToMove} className={`px-4 py-3 rounded-xl font-bold flex items-center justify-center gap-2 ${doorStatus !== 'closed' || isMoving || elevatorMode !== 'normal' || !readyToMove ? 'bg-slate-800/50 text-slate-600 cursor-not-allowed' : 'bg-green-600 hover:bg-green-700 text-white'}`}><Unlock className="w-5 h-5" />OPEN</button>
              <button onClick={() => handleDoorOperation('close')} disabled={doorStatus !== 'open'} className={`px-4 py-3 rounded-xl font-bold flex items-center justify-center gap-2 ${doorStatus !== 'open' ? 'bg-slate-800/50 text-slate-600 cursor-not-allowed' : 'bg-red-600 hover:bg-red-700 text-white'}`}><Lock className="w-5 h-5" />CLOSE</button>
            </div>
            <div className="grid grid-cols-2 gap-3 mt-3">
              <button onClick={handleEmergencyStop} disabled={elevatorMode === 'emergency'} className="px-4 py-3 bg-red-600 hover:bg-red-700 disabled:bg-slate-700 rounded-xl font-bold flex items-center justify-center gap-2"><PauseCircle className="w-5 h-5" />E-STOP</button>
              <button onClick={resumeNormal} disabled={elevatorMode === 'normal'} className="px-4 py-3 bg-green-600 hover:bg-green-700 disabled:bg-slate-700 rounded-xl font-bold flex items-center justify-center gap-2"><PlayCircle className="w-5 h-5" />Resume</button>
            </div>
          </div>
        </div>

        {/* Right */}
        <div className="col-span-7 space-y-4">
          {/* Credentials */}
          <div className="bg-gradient-to-br from-slate-800/90 to-slate-900/90 backdrop-blur-xl rounded-2xl p-5 border border-slate-700/50 shadow-2xl">
            <h3 className="text-lg font-bold text-violet-400 mb-4 flex items-center gap-2"><CreditCard className="w-5 h-5" />Credentials</h3>
            <div className="grid grid-cols-2 gap-3 mb-4">
              <div><label className="text-xs text-slate-400 block mb-2">Reader</label><select value={elevatorReader.type} onChange={(e) => updateReaderConfig(e.target.value as ElevatorReader['type'], '', '')} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"><option value="none">None</option><option value="osdp">🔷 OSDP</option><option value="wiegand">🟢 Wiegand</option></select></div>
              <div><label className="text-xs text-slate-400 block mb-2">Device</label><select value={elevatorReader.readerId} onChange={(e) => { const r = (elevatorReader.type === 'osdp' ? availableOSDPReaders : availableWiegandReaders).find(x => x.id === e.target.value); updateReaderConfig(elevatorReader.type, e.target.value, r?.name || ''); }} disabled={elevatorReader.type === 'none'} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white disabled:opacity-50"><option value="">Select...</option>{elevatorReader.type === 'osdp' && availableOSDPReaders.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}{elevatorReader.type === 'wiegand' && availableWiegandReaders.map(r => <option key={r.id} value={r.id}>Door {r.id}</option>)}</select></div>
            </div>
            <div className="p-4 bg-slate-900/50 rounded-lg border border-slate-700/50 mb-4">
              <div className="grid grid-cols-4 gap-3 mb-3">
                <div><label className="text-xs text-slate-400 block mb-1">Format</label><select value={selectedFormat} onChange={(e) => setSelectedFormat(e.target.value)} className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-xs text-white">{cardFormats.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select></div>
                <div><label className="text-xs text-slate-400 block mb-1">FC</label><input type="number" value={facilityCode} onChange={(e) => setFacilityCode(e.target.value)} className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-xs text-white" /></div>
                <div><label className="text-xs text-slate-400 block mb-1">Card</label><input type="number" value={cardNumber} onChange={(e) => setCardNumber(e.target.value)} className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-xs text-white" /></div>
                <div><label className="text-xs text-slate-400 block mb-1">Floor</label><select value={cardTargetFloor} onChange={(e) => setCardTargetFloor(parseInt(e.target.value))} className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-xs text-white">{floors.map(f => <option key={f.id} value={f.id}>F{f.id}</option>)}</select></div>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <button onClick={generateRandomCardForFormat} className="px-3 py-2 bg-purple-600 hover:bg-purple-700 rounded text-xs font-semibold">🎲 Random</button>
                <button onClick={sendConfiguredCard} disabled={!elevatorReader.enabled} className="px-3 py-2 bg-cyan-600 hover:bg-cyan-700 disabled:bg-slate-700 rounded text-xs font-semibold">💳 Send</button>
                <button onClick={() => handleRandomCardSwipe(cardTargetFloor)} disabled={!elevatorReader.enabled} className="px-3 py-2 bg-orange-600 hover:bg-orange-700 disabled:bg-slate-700 rounded text-xs font-semibold">🎰 Swipe</button>
              </div>
            </div>
            {elevatorReader.enabled && <div className="p-2 bg-green-500/10 border border-green-500/30 rounded-lg text-xs text-green-400 flex items-center gap-2"><Check className="w-3 h-3" />{elevatorReader.readerName}</div>}
          </div>

          {/* Tests */}
          <div className="bg-gradient-to-br from-slate-800/90 to-slate-900/90 backdrop-blur-xl rounded-2xl p-5 border border-slate-700/50 shadow-2xl">
            <h3 className="text-lg font-bold text-amber-400 mb-4 flex items-center gap-2"><Zap className="w-5 h-5" />Tests</h3>
            <div className="grid grid-cols-4 gap-3">
              <button onClick={() => { addLog(8, 'info', '🔝 Top Floor', '🔝'); handleCallButton(8); setTimeout(() => handleCallButton(1), 500); }} disabled={elevatorMode !== 'normal'} className="px-3 py-3 bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-700 rounded-lg font-semibold text-sm flex flex-col items-center gap-1"><span>🔝</span><span>Top</span></button>
              <button onClick={() => { addLog(currentFloor, 'info', '🏢 All Floors', '🏢'); floors.forEach((f, i) => { if (f.id !== currentFloor) setTimeout(() => handleCallButton(f.id), i * 150); }); }} disabled={elevatorMode !== 'normal'} className="px-3 py-3 bg-orange-600 hover:bg-orange-700 disabled:bg-slate-700 rounded-lg font-semibold text-sm flex flex-col items-center gap-1"><span>🏢</span><span>All</span></button>
              <button onClick={() => { addLog(currentFloor, 'info', '🔄 Round Trip', '🔄'); handleCallButton(1); setTimeout(() => handleCallButton(8), 300); setTimeout(() => handleCallButton(1), 600); }} disabled={elevatorMode !== 'normal'} className="px-3 py-3 bg-purple-600 hover:bg-purple-700 disabled:bg-slate-700 rounded-lg font-semibold text-sm flex flex-col items-center gap-1"><span>🔄</span><span>Round</span></button>
              <button onClick={() => { addLog(currentFloor, 'info', '⬆️ Ascending', '⬆️'); [1,2,3,4,5,6,7,8].forEach((f, i) => setTimeout(() => handleCallButton(f), i * 200)); }} disabled={elevatorMode !== 'normal'} className="px-3 py-3 bg-cyan-600 hover:bg-cyan-700 disabled:bg-slate-700 rounded-lg font-semibold text-sm flex flex-col items-center gap-1"><span>⬆️</span><span>Up</span></button>
              <button onClick={() => { addLog(currentFloor, 'info', '⬇️ Descending', '⬇️'); [8,7,6,5,4,3,2,1].forEach((f, i) => setTimeout(() => handleCallButton(f), i * 200)); }} disabled={elevatorMode !== 'normal'} className="px-3 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-700 rounded-lg font-semibold text-sm flex flex-col items-center gap-1"><span>⬇️</span><span>Down</span></button>
              <button onClick={() => { const r = Math.floor(Math.random() * 8) + 1; addLog(r, 'info', '🔀 Random', '🔀'); handleCallButton(r); }} disabled={elevatorMode !== 'normal'} className="px-3 py-3 bg-pink-600 hover:bg-pink-700 disabled:bg-slate-700 rounded-lg font-semibold text-sm flex flex-col items-center gap-1"><span>🔀</span><span>Rand</span></button>
              <button onClick={() => { setCallQueue([]); setFloors(p => p.map(f => ({ ...f, callButtonPressed: false, callButtonLit: false }))); setReadyToMove(true); readyToMoveRef.current = true; addLog(currentFloor, 'warning', '🧹 Cleared', '🧹'); }} className="px-3 py-3 bg-red-600 hover:bg-red-700 rounded-lg font-semibold text-sm flex flex-col items-center gap-1"><span>🧹</span><span>Clear</span></button>
              <button onClick={() => { setReadyToMove(true); readyToMoveRef.current = true; addLog(currentFloor, 'info', '🔓 Gate Reset', '🔓'); }} className="px-3 py-3 bg-slate-600 hover:bg-slate-700 rounded-lg font-semibold text-sm flex flex-col items-center gap-1"><span>🔓</span><span>Reset</span></button>
            </div>
          </div>

          {/* Floors */}
          <div className="bg-gradient-to-br from-slate-800/90 to-slate-900/90 backdrop-blur-xl rounded-2xl p-5 border border-slate-700/50 shadow-2xl">
            <h3 className="text-lg font-bold text-white mb-4 flex items-center gap-2"><Building2 className="w-5 h-5 text-cyan-400" />Floors</h3>
            <div className="grid grid-cols-2 gap-3">
              {floors.map((floor) => (
                <div key={floor.id} className={`bg-slate-950/30 rounded-lg p-3 border-2 transition-all ${floor.id === currentFloor ? 'border-cyan-400' : floor.accessGrantedByACU ? 'border-blue-400' : 'border-slate-700/50'}`}>
                  <div className="flex items-center justify-between mb-2">
                    <div><div className="text-lg font-bold text-white">F{floor.id}</div><div className="text-xs text-slate-400">{floor.name}</div></div>
                    <div className="flex items-center gap-1">
                      {/* Status indicators */}
                      <div className={`w-2 h-2 rounded-full ${floor.isTracking ? 'bg-green-400' : 'bg-slate-600'}`} title="Floor Tracking (Output)" />
                      <div className={`w-2 h-2 rounded-full ${floor.accessGrantedByACU ? 'bg-blue-400' : 'bg-slate-600'}`} title="ACU Access (Input)" />
                      <div className={`w-2 h-2 rounded-full ${floor.callButtonLit ? 'bg-yellow-400' : 'bg-slate-600'}`} title="Call Button Lit" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {/* Call button - only usable when ACU grants access */}
                    <button onClick={() => handleCallButton(floor.id)} disabled={elevatorMode !== 'normal'} className={`px-2 py-1.5 rounded text-xs font-semibold flex items-center justify-center gap-1 ${floor.callButtonLit ? 'bg-yellow-500 text-black' : floor.accessGrantedByACU ? 'bg-cyan-600 hover:bg-cyan-700' : 'bg-slate-700 text-slate-500 cursor-not-allowed'}`}>
                      <Bell className="w-3 h-3" />{floor.callButtonLit ? '💡 Lit' : floor.accessGrantedByACU ? '🔓 Ready' : '🔒 Locked'}
                    </button>
                    <button onClick={() => handleReaderSwipe(floor.id)} disabled={!elevatorReader.enabled} className="px-2 py-1.5 bg-violet-600 hover:bg-violet-700 disabled:bg-slate-700 disabled:text-slate-500 rounded text-xs font-semibold flex items-center justify-center gap-1"><CreditCard className="w-3 h-3" />ACU Grant</button>
                    {/* Tracking GPIO control */}
                    <button onClick={() => toggleFloorTracking(floor.id)} className={`px-2 py-1.5 rounded text-xs font-semibold flex items-center justify-center gap-1 col-span-2 ${floor.isTracking ? 'bg-green-600' : 'bg-slate-600'}`}>
                      <Zap className="w-3 h-3" />Track {floor.trackingGpio}: {floor.isTracking ? 'ON' : 'OFF'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Log */}
      <div className="bg-gradient-to-br from-slate-800/90 to-slate-900/90 backdrop-blur-xl rounded-2xl p-6 border border-slate-700/50 shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-white flex items-center gap-2"><Activity className="w-5 h-5 text-blue-400" />Log</h2>
          <div className="flex gap-2"><button onClick={exportLogs} className="p-2 bg-blue-600 hover:bg-blue-700 rounded-lg"><Download className="w-4 h-4" /></button><button onClick={() => setLogs([])} className="p-2 bg-red-600 hover:bg-red-700 rounded-lg"><RotateCcw className="w-4 h-4" /></button></div>
        </div>
        <div ref={logContainerRef} className="bg-slate-950/50 rounded-xl border border-slate-700/50 p-4 h-[200px] overflow-y-auto font-mono text-xs">
          {logs.length === 0 ? <div className="flex flex-col items-center justify-center h-full text-slate-500"><AlertCircle className="w-8 h-8 mb-2 opacity-50" /><div>No activity</div></div> : (
            <div className="grid grid-cols-2 gap-2">
              {logs.map((log) => (
                <div key={log.id} className={`p-2 rounded-lg border-l-2 ${log.type === 'success' ? 'bg-green-500/10 border-green-500' : log.type === 'error' ? 'bg-red-500/10 border-red-500' : log.type === 'warning' ? 'bg-yellow-500/10 border-yellow-500' : 'bg-blue-500/10 border-blue-500'}`}>
                  <div className="flex items-start gap-2">
                    <span className="text-sm">{log.icon}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-[9px] text-slate-500">{log.timestamp.toLocaleTimeString()}</span>
                        <span className={`px-1 py-0.5 rounded text-[8px] font-bold ${log.type === 'success' ? 'bg-green-500/20 text-green-400' : log.type === 'error' ? 'bg-red-500/20 text-red-400' : log.type === 'warning' ? 'bg-yellow-500/20 text-yellow-400' : 'bg-blue-500/20 text-blue-400'}`}>F{log.floor}</span>
                      </div>
                      <div className="text-slate-300 text-[10px] leading-snug">{log.message}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default ElevatorSection;
