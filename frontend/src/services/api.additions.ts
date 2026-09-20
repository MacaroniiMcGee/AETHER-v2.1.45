/**
 * API Service - GPIO and Supervision Endpoints
 * 
 * Add these functions to your existing api.ts or create a new gpioApi.ts
 */

import type {
  GPIOStatus,
  GPIOHealth,
  GPIOSetResponse,
  GPIOPulseResponse,
  GPIOInputResponse,
  RelayControlRequest
} from './gpio.types';

import type {
  SupervisionStatus,
  SupervisionHealthResponse,
  SupervisionZoneResponse,
  SupervisionAlarmsResponse,
  SupervisionTampersResponse,
  SupervisionTroublesResponse
} from './supervision.types';

// ==========================================
// Configuration
// ==========================================

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

// ==========================================
// GPIO API Endpoints
// ==========================================

/**
 * Get complete GPIO system status
 * Includes all relays and inputs
 */
export async function getGPIOStatus(): Promise<GPIOStatus> {
  const response = await fetch(`${API_BASE_URL}/api/gpio/status`);
  if (!response.ok) {
    throw new Error(`GPIO status failed: ${response.statusText}`);
  }
  return response.json();
}

/**
 * Get GPIO system health check
 */
export async function getGPIOHealth(): Promise<GPIOHealth> {
  const response = await fetch(`${API_BASE_URL}/api/gpio/health`);
  if (!response.ok) {
    throw new Error(`GPIO health check failed: ${response.statusText}`);
  }
  return response.json();
}

/**
 * Set relay state (on/off)
 */
export async function setRelay(pin: number, state: 0 | 1): Promise<GPIOSetResponse> {
  const response = await fetch(`${API_BASE_URL}/api/gpio/set`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin, state })
  });
  
  if (!response.ok) {
    throw new Error(`Set relay failed: ${response.statusText}`);
  }
  return response.json();
}

/**
 * Pulse relay (temporary activation)
 */
export async function pulseRelay(pin: number, duration: number = 3000): Promise<GPIOPulseResponse> {
  const response = await fetch(`${API_BASE_URL}/api/gpio/pulse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin, duration })
  });
  
  if (!response.ok) {
    throw new Error(`Pulse relay failed: ${response.statusText}`);
  }
  return response.json();
}

/**
 * Get relay state
 */
export async function getRelayState(pin: number): Promise<{ pin: number; state: 0 | 1 }> {
  const response = await fetch(`${API_BASE_URL}/api/gpio/get/${pin}`);
  if (!response.ok) {
    throw new Error(`Get relay state failed: ${response.statusText}`);
  }
  return response.json();
}

/**
 * Read digital input state
 */
export async function readInput(pin: number): Promise<GPIOInputResponse> {
  const response = await fetch(`${API_BASE_URL}/api/gpio/input/${pin}`);
  if (!response.ok) {
    throw new Error(`Read input failed: ${response.statusText}`);
  }
  return response.json();
}

/**
 * Emergency shutdown - turn off all relays
 */
export async function emergencyShutdown(): Promise<{ success: boolean; message: string }> {
  const response = await fetch(`${API_BASE_URL}/api/gpio/emergency-shutdown`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  });
  
  if (!response.ok) {
    throw new Error(`Emergency shutdown failed: ${response.statusText}`);
  }
  return response.json();
}

// ==========================================
// Supervision API Endpoints
// ==========================================

/**
 * Get complete supervision system status
 * Includes all zones with 4-state monitoring
 */
export async function getSupervisionStatus(): Promise<SupervisionStatus> {
  const response = await fetch(`${API_BASE_URL}/api/supervision/status`);
  if (!response.ok) {
    throw new Error(`Supervision status failed: ${response.statusText}`);
  }
  return response.json();
}

/**
 * Get supervision system health check
 */
export async function getSupervisionHealth(): Promise<SupervisionHealthResponse> {
  const response = await fetch(`${API_BASE_URL}/api/supervision/health`);
  if (!response.ok) {
    throw new Error(`Supervision health check failed: ${response.statusText}`);
  }
  return response.json();
}

/**
 * Read specific supervision zone
 */
export async function readSupervisionZone(board: number, channel: number): Promise<SupervisionZoneResponse> {
  const response = await fetch(`${API_BASE_URL}/api/supervision/zone/${board}/${channel}`);
  if (!response.ok) {
    throw new Error(`Read zone failed: ${response.statusText}`);
  }
  return response.json();
}

/**
 * Get all active alarms
 */
export async function getSupervisionAlarms(): Promise<SupervisionAlarmsResponse> {
  const response = await fetch(`${API_BASE_URL}/api/supervision/alarms`);
  if (!response.ok) {
    throw new Error(`Get alarms failed: ${response.statusText}`);
  }
  return response.json();
}

/**
 * Get all active tampers
 */
export async function getSupervisionTampers(): Promise<SupervisionTampersResponse> {
  const response = await fetch(`${API_BASE_URL}/api/supervision/tampers`);
  if (!response.ok) {
    throw new Error(`Get tampers failed: ${response.statusText}`);
  }
  return response.json();
}

/**
 * Get all active troubles
 */
export async function getSupervisionTroubles(): Promise<SupervisionTroublesResponse> {
  const response = await fetch(`${API_BASE_URL}/api/supervision/troubles`);
  if (!response.ok) {
    throw new Error(`Get troubles failed: ${response.statusText}`);
  }
  return response.json();
}

/**
 * Detect available boards
 */
export async function detectSupervisionBoards(): Promise<{ detectedBoards: number[] }> {
  const response = await fetch(`${API_BASE_URL}/api/supervision/detect-boards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  });
  
  if (!response.ok) {
    throw new Error(`Detect boards failed: ${response.statusText}`);
  }
  return response.json();
}

// ==========================================
// Door Control Helpers (combining GPIO + Supervision)
// ==========================================

/**
 * Unlock door (pulse strike relay)
 */
export async function unlockDoor(doorId: number, duration: number = 3000): Promise<GPIOPulseResponse> {
  // Door 1-4 map to relay pins 0-3
  const relayPin = doorId - 1;
  return pulseRelay(relayPin, duration);
}

/**
 * Get door status (REX button + supervision)
 */
export async function getDoorStatus(doorId: number): Promise<{
  rex: GPIOInputResponse;
  supervision: SupervisionZoneResponse;
}> {
  // Door 1-4 map to input 0-3 and ADC 0-3
  const inputPin = doorId - 1;
  const adcChannel = doorId;
  
  const [rex, supervision] = await Promise.all([
    readInput(inputPin),
    readSupervisionZone(0, adcChannel)
  ]);
  
  return { rex, supervision };
}

/**
 * Poll door states (for real-time updates)
 */
export async function pollDoorStates(doorIds: number[]): Promise<Map<number, {
  rex: GPIOInputResponse;
  supervision: SupervisionZoneResponse;
}>> {
  const results = new Map();
  
  await Promise.all(
    doorIds.map(async (doorId) => {
      try {
        const status = await getDoorStatus(doorId);
        results.set(doorId, status);
      } catch (error) {
        console.error(`Failed to poll door ${doorId}:`, error);
      }
    })
  );
  
  return results;
}

// ==========================================
// Utility Functions
// ==========================================

/**
 * Format voltage for display
 */
export function formatVoltage(volts: number, decimals: number = 3): string {
  return `${volts.toFixed(decimals)}V`;
}

/**
 * Get state color for UI
 */
export function getStateColor(state: string): string {
  const colors: Record<string, string> = {
    NORMAL: 'green',
    ALARM: 'amber',
    TAMPER: 'red',
    TROUBLE: 'purple',
    UNKNOWN: 'gray',
    ERROR: 'red'
  };
  return colors[state] || 'gray';
}

/**
 * Check if zone needs attention
 */
export function zoneNeedsAttention(state: string): boolean {
  return ['ALARM', 'TAMPER', 'TROUBLE', 'ERROR'].includes(state);
}
