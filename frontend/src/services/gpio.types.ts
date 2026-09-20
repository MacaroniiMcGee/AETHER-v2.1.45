/**
 * GPIO Types for Sequent IOplus Integration
 * 
 * Provides TypeScript types for GPIO control and monitoring
 * via the Sequent IOplus Home Automation card (I2C 0x28)
 */

// ==========================================
// Relay/Output Types
// ==========================================

export interface RelayState {
  pin: number;
  state: 0 | 1;  // 0 = off, 1 = on
  type?: 'relay';
}

export interface RelayStatus {
  pin: number;
  state: 0 | 1;
  label?: string;
  assignedTo?: string;  // e.g., "Door 1 Strike"
}

export interface RelayControlRequest {
  pin: number;
  state: 0 | 1;
  duration?: number;  // For pulse mode (milliseconds)
}

// ==========================================
// Input Types
// ==========================================

export interface DigitalInputState {
  pin: number;
  state: 0 | 1;  // 0 = inactive, 1 = active
  type: 'digital_opto';
}

export interface AnalogInputState {
  pin: number;
  volts: number;
  millivolts: number;
  type: 'analog';
}

export interface InputStatus {
  pin: number;
  state: 0 | 1;
  type: 'digital_opto' | 'analog';
  label?: string;
  assignedTo?: string;  // e.g., "Door 1 REX"
}

// ==========================================
// GPIO System Status
// ==========================================

export interface GPIOStatus {
  controller: string;
  healthy: boolean;
  detectedBoards: number;
  totalBoards: number;
  relays: RelayStatus[];
  inputs: InputStatus[];
  timestamp?: number;
}

export interface GPIOHealth {
  healthy: boolean;
  controller: string;
  detectedBoards: number[];
  totalBoards: number;
  message: string;
  timestamp?: number;
}

// ==========================================
// Door I/O Mapping
// ==========================================

export interface DoorIOMapping {
  doorId: number;
  doorName: string;
  strike: {
    relay: number;
    duration: number;  // milliseconds
  };
  supervision: {
    adc: number;
    enabled: boolean;
  };
  rex: {
    input: number;
    enabled: boolean;
  };
  outputs?: {
    ledGreen?: number;
    ledRed?: number;
    buzzer?: number;
  };
}

// ==========================================
// API Response Types
// ==========================================

export interface GPIOSetResponse {
  success: boolean;
  pin: number;
  state: 0 | 1;
  message?: string;
  error?: string;
}

export interface GPIOPulseResponse {
  success: boolean;
  pin: number;
  duration: number;
  message?: string;
  error?: string;
}

export interface GPIOInputResponse {
  pin: number;
  state: 0 | 1;
  type: 'digital_opto' | 'analog';
  volts?: number;
  timestamp?: number;
}

// ==========================================
// Configuration Types
// ==========================================

export interface GPIOConfig {
  i2c: {
    bus: number;
    address: string;  // e.g., "0x28"
  };
  relays: {
    count: number;
    mapping: Record<number, string>;  // pin -> label
  };
  inputs: {
    digital: {
      count: number;
      mapping: Record<number, string>;
    };
    analog: {
      count: number;
      mapping: Record<number, string>;
    };
  };
}

// ==========================================
// Event Types
// ==========================================

export interface GPIOEvent {
  type: 'relay_change' | 'input_change' | 'supervision_change';
  pin: number;
  previousState: number;
  newState: number;
  timestamp: number;
  doorId?: number;
}

// ==========================================
// WebSocket Message Types
// ==========================================

export interface GPIOWebSocketMessage {
  event: 'gpio_update' | 'relay_changed' | 'input_changed';
  data: {
    pin: number;
    state: number;
    timestamp: number;
  };
}
