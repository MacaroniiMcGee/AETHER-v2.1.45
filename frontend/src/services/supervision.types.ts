/**
 * Supervision Types for 4-State Zone Monitoring
 * 
 * Provides TypeScript types for alarm supervision monitoring
 * using Sequent IOplus analog inputs (ground-referenced, no reference resistor)
 */

// ==========================================
// Zone State Types
// ==========================================

export type ZoneState = 'NORMAL' | 'ALARM' | 'TAMPER' | 'TROUBLE' | 'UNKNOWN' | 'ERROR';

export type ZoneSeverity = 'none' | 'medium' | 'high' | 'critical';

// ==========================================
// Supervision Zone
// ==========================================

export interface SupervisionZone {
  board: number;
  channel: number;
  zoneId: string;  // e.g., "0-1"
  volts: number;
  millivolts: number;
  state: ZoneState;
  severity: ZoneSeverity;
  description: string;
  expectedVolts?: string;
  method?: string;
  timestamp: number;
  error?: string;
}

// ==========================================
// Supervision Status
// ==========================================

export interface SupervisionBoardStatus {
  board: number;
  present: boolean;
  zones?: SupervisionZone[];
  summary?: {
    alarms: number;
    tampers: number;
    troubles: number;
    normal: number;
  };
  error?: string;
}

export interface SupervisionStatus {
  controller: string;
  method: string;
  healthy: boolean;
  detectedBoards: number;
  totalZones: number;
  configuration: {
    eolResistor: number;
    alarmResistor: number;
    vcc: number;
    thresholds: SupervisionThresholds;
    wiringNotes?: string;
  };
  summary: {
    totalAlarms: number;
    totalTampers: number;
    totalTroubles: number;
    totalNormal: number;
  };
  boards: SupervisionBoardStatus[];
  timestamp?: number;
}

// ==========================================
// Threshold Configuration
// ==========================================

export interface SupervisionThresholds {
  tamper: {
    min_volts: number;
    max_volts: number;
    description: string;
  };
  normal: {
    min_volts: number;
    max_volts: number;
    description: string;
  };
  alarm: {
    min_volts: number;
    max_volts: number;
    description: string;
  };
  trouble: {
    min_volts: number;
    max_volts: number;
    description: string;
  };
}

// ==========================================
// Alarm/Event Types
// ==========================================

export interface SupervisionAlarm {
  zoneId: string;
  board: number;
  channel: number;
  state: 'ALARM';
  volts: number;
  timestamp: number;
  acknowledged?: boolean;
  doorId?: number;
}

export interface SupervisionTamper {
  zoneId: string;
  board: number;
  channel: number;
  state: 'TAMPER';
  volts: number;
  timestamp: number;
  acknowledged?: boolean;
  doorId?: number;
}

export interface SupervisionTrouble {
  zoneId: string;
  board: number;
  channel: number;
  state: 'TROUBLE';
  volts: number;
  timestamp: number;
  acknowledged?: boolean;
  doorId?: number;
}

// ==========================================
// API Response Types
// ==========================================

export interface SupervisionHealthResponse {
  healthy: boolean;
  controller: string;
  method: string;
  detectedBoards: number[];
  totalBoards: number;
  message: string;
  timestamp?: number;
}

export interface SupervisionZoneResponse {
  zone: SupervisionZone;
  timestamp: number;
}

export interface SupervisionAlarmsResponse {
  alarms: SupervisionAlarm[];
  count: number;
  timestamp: number;
}

export interface SupervisionTampersResponse {
  tampers: SupervisionTamper[];
  count: number;
  timestamp: number;
}

export interface SupervisionTroublesResponse {
  troubles: SupervisionTrouble[];
  count: number;
  timestamp: number;
}

// ==========================================
// Zone Configuration
// ==========================================

export interface ZoneConfig {
  id: number;
  board: number;
  channel: number;
  name: string;
  type: '4-state_supervision';
  enabled: boolean;
  assignedTo?: string;  // e.g., "Door 1"
  doorId?: number;
}

// ==========================================
// Calibration Types
// ==========================================

export interface SupervisionCalibration {
  measuredVoltages: {
    open: number;
    closed: number;
    trouble: number;
    shorted: number;
  };
  calculatedThresholds: SupervisionThresholds;
  calibrationDate: string;
  board: number;
  testChannel: number;
}

// ==========================================
// WebSocket Event Types
// ==========================================

export interface SupervisionEvent {
  type: 'zone_alarm' | 'zone_tamper' | 'zone_trouble' | 'zone_normal';
  zone: SupervisionZone;
  previousState?: ZoneState;
  timestamp: number;
}

export interface SupervisionWebSocketMessage {
  event: 'supervision_update' | 'zone_changed' | 'alarm_triggered';
  data: SupervisionEvent;
}

// ==========================================
// Display/UI Types
// ==========================================

export interface ZoneDisplayInfo {
  zone: SupervisionZone;
  color: string;  // '#hex color for UI'
  icon: string;   // Icon name
  priority: number;  // For sorting
  actionRequired: boolean;
}

// State color mapping
export const ZONE_STATE_COLORS: Record<ZoneState, string> = {
  NORMAL: '#10b981',   // green-500
  ALARM: '#f59e0b',    // amber-500
  TAMPER: '#ef4444',   // red-500
  TROUBLE: '#a855f7',  // purple-500
  UNKNOWN: '#6b7280',  // gray-500
  ERROR: '#dc2626'     // red-600
};

// State priority (higher = more urgent)
export const ZONE_STATE_PRIORITY: Record<ZoneState, number> = {
  ERROR: 100,
  TAMPER: 90,
  ALARM: 80,
  TROUBLE: 70,
  UNKNOWN: 50,
  NORMAL: 10
};
